require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { semanaUsuario } = require('./balance');
const { handleAdmin } = require('./admin');
const { route } = require('./dmrouter');
const { setupWeb } = require('./web');
const { setupDashboard } = require('./dashboard');
const { setupScheduler } = require('./scheduler');

// Nunca morir en loop por una promesa sin catch (p. ej. auth.test de Bolt
// con un token revocado): logueamos claro y el server sigue vivo.
process.on('unhandledRejection', (err) => {
  console.error('[proceso] ⚠️ Promesa sin catch:', err?.data?.error || err?.message || err);
  if (err?.data?.error === 'invalid_auth' || err?.data?.error === 'token_revoked') {
    console.error('[proceso] 👉 SLACK_BOT_TOKEN inválido o revocado. Si reinstalaste la app en api.slack.com, copiá el token nuevo (xoxb-...) a las variables de Railway.');
  }
});
process.on('uncaughtException', (err) => console.error('[proceso] ⚠️ Excepción sin catch:', err));

// ─── Validación de entorno (logs claros para Railway) ──────────────
const REQUIRED = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[env] ❌ Faltan variables obligatorias: ${missing.join(', ')}`);
  process.exit(1);
}
for (const k of ['APP_URL', 'REPORT_CHANNEL', 'ADMIN_USER_IDS', 'DB_PATH']) {
  if (!process.env[k]) console.warn(`[env] ⚠️ ${k} no está seteada — revisá el README.`);
}

// HTTP mode con ExpressReceiver: la app sirve páginas web además de Slack.
// Endpoint de eventos/comandos/interactividad: POST /slack/events
const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver });

app.error(async (error) => {
  console.error('[bolt] ❌', error.message);
  if (error.original) console.error('[bolt] original:', error.original.message);
});

// ─── SOLO_MODE: responde a un solo usuario (para pruebas) ──────────
// IMPORTANTE: hace ack() antes de descartar — si no, Slack muestra error.
const SOLO_MODE = process.env.SOLO_MODE === 'true';
const SOLO_USER_ID = process.env.SOLO_USER_ID || '';
if (SOLO_MODE) {
  console.log(`[solo] 🧪 SOLO_MODE activo — solo responde a ${SOLO_USER_ID}`);
  app.use(async ({ body, ack, next }) => {
    const uid = body?.user_id || body?.user?.id || body?.event?.user;
    if (uid && uid !== SOLO_USER_ID) {
      if (typeof ack === 'function') await ack();
      return;
    }
    await next();
  });
}

const getBaseUrl = () => process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

// ═══════════════════════════════════════════════════════════════════
// INTERACCIÓN POR DM — el bot es un "compañero": se le escribe directo.
// No hay slash commands: nada para tipear en canales ni en el DM propio.
// ═══════════════════════════════════════════════════════════════════

/** "marcar" → link de un solo uso, expira en 5 minutos */
const enviarLink = async (user, say) => {
  const dia = db.getDia(user.slack_id, t.today());
  const next = db.nextTipo(dia);
  const corregible = !next && dia.salida?.auto_closed === 1 && !dia.salida.corregido;
  if (!next && !corregible) { await say(txt.marcar.diaCompleto); return; }

  const token = db.createToken(user.slack_id);
  const url = `${getBaseUrl()}/verify/${token}`;
  const instrucciones = corregible ? txt.marcar.linkCorreccion : txt.marcar.linkInstructions(txt.TIPOS[next].label);

  await say({
    text: `${txt.marcar.linkTitle} ${url}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: txt.marcar.linkTitle } },
      { type: 'section', text: { type: 'mrkdwn', text: `${instrucciones}\n\n👉 <${url}|${txt.marcar.linkLabel}>` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: txt.marcar.expireNote }] },
    ],
  });
};

/** "horarios" → estado del día + balance semanal (solo datos propios) */
const resumenBlocks = (user) => {
  const dia = db.getDia(user.slack_id, t.today());
  const estadoLineas = Object.entries(txt.TIPOS).map(([tipo, info]) => {
    const r = dia[tipo];
    let val = r ? `*${r.hora}*` : '—';
    if (r?.tarde_min > 0) val += ` _(+${r.tarde_min}' tarde)_`;
    if (r?.anticipado_min > 0) val += ` _(−${r.anticipado_min}' anticipado)_`;
    if (r?.auto_closed) val += r.corregido ? ` _(corregida, era ${r.valor_original})_` : ' _(cierre automático)_';
    return `${info.emoji} ${info.label}: ${val}`;
  });

  const horas = db.horasDia(dia);
  const estadoDia = !dia.entrada ? txt.horarios.sinRegistro
    : dia.salida ? txt.horarios.completa(horas)
    : txt.horarios.enCurso;

  const s = semanaUsuario(user);
  const filas = s.dias.map(d => `${d.semaforo} *${d.label}* — ${d.horas != null ? d.horas + 'hs' : '—'} · ${d.detalle}${d.auto ? ' _(auto)_' : ''}`);

  let balanceMsg;
  if (s.diff >= 0) {
    balanceMsg = s.diff > 0 ? `🟢 ${txt.web.balanceAFavor(s.diff)}` : `🟢 ${txt.web.balanceOk}`;
  } else if (s.horaCompensa) {
    balanceMsg = `${Math.abs(s.diff) > 2 ? '🔴' : '🟡'} ${txt.web.balanceDebe(Math.abs(s.diff), s.horaCompensa)}`;
  } else {
    balanceMsg = `${Math.abs(s.diff) > 2 ? '🔴' : '🟡'} ${txt.web.balanceDebeGeneral(Math.abs(s.diff))}`;
  }

  return [
    { type: 'header', text: { type: 'plain_text', text: `📊 Tu estado — ${t.fmtDate(t.today())}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Tu horario: ${user.hora_entrada}–${user.hora_salida} · ${user.carga_horaria}hs/día` }] },
    { type: 'section', text: { type: 'mrkdwn', text: `${estadoLineas.join('\n')}\n\n${estadoDia}` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*📅 Tu semana* (desde el lunes)\n${filas.join('\n')}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `Total: *${s.trabajadas}hs / ${s.esperadas}hs*\n${balanceMsg}` } },
  ];
};

/** Cualquier otro mensaje → menú con botones (y hints de texto) */
const enviarMenu = async (user, say) => {
  const dia = db.getDia(user.slack_id, t.today());
  const next = db.nextTipo(dia);
  const corregible = !next && dia.salida?.auto_closed === 1 && !dia.salida.corregido;

  const botones = [];
  if (next || corregible) {
    botones.push({
      type: 'button', style: 'primary', action_id: 'menu_marcar',
      text: { type: 'plain_text', text: next ? txt.chat.btnMarcar(txt.TIPOS[next].label) : '✏️ Corregir salida' },
    });
  }
  botones.push({ type: 'button', action_id: 'menu_semana', text: { type: 'plain_text', text: txt.chat.btnSemana } });

  const hints = [txt.chat.menuHint];
  if (db.isAdmin(user.slack_id)) hints.push(txt.chat.adminHint);

  await say({
    text: txt.chat.menuSaludo(user.nombre),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${txt.chat.menuSaludo(user.nombre)}${next ? '' : corregible ? '' : `\n${txt.marcar.diaCompleto}`}` } },
      { type: 'actions', elements: botones },
      { type: 'context', elements: hints.map(h => ({ type: 'mrkdwn', text: h })) },
    ],
  });
};

// Router de DMs: marcar / horarios / admin ... / cualquier cosa → menú
app.message(async ({ message, say, client }) => {
  if (message.subtype || message.bot_id) return;          // solo mensajes humanos
  if (message.channel_type !== 'im') return;              // solo DM con el bot
  const uid = message.user;
  const r = route(message.text);

  try {
    if (r.tipo === 'admin') {
      await handleAdmin({ texto: r.resto, adminId: uid, say, client });
      return;
    }

    const user = db.getUser(uid);
    if (!user?.trackeado) {
      await say(db.isAdmin(uid) ? txt.marcar.noTrackeadoAdmin : txt.marcar.noTrackeado);
      return;
    }

    if (r.tipo === 'marcar') { await enviarLink(user, say); return; }
    if (r.tipo === 'horarios') { await say({ text: 'Tu estado', blocks: resumenBlocks(user) }); return; }
    await enviarMenu(user, say);
  } catch (err) {
    console.error('[dm] Error:', err);
  }
});

// Botones del menú
const sayEnDM = (client, uid) => (msg) =>
  client.chat.postMessage({ channel: uid, ...(typeof msg === 'string' ? { text: msg } : msg) });

app.action('menu_marcar', async ({ body, ack, client }) => {
  await ack();
  const user = db.getUser(body.user.id);
  if (user?.trackeado) await enviarLink(user, sayEnDM(client, user.slack_id));
});

app.action('menu_semana', async ({ body, ack, client }) => {
  await ack();
  const user = db.getUser(body.user.id);
  if (user?.trackeado) await sayEnDM(client, user.slack_id)({ text: 'Tu estado', blocks: resumenBlocks(user) });
});

// ═══════════════════════════════════════════════════════════════════
// CIERRE DEL DÍA Y HORAS EXTRA (botones)
// ═══════════════════════════════════════════════════════════════════

const updateMsg = async (client, body, text) => {
  try {
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text, blocks: [] });
  } catch (e) { console.error('[action] No pude actualizar el mensaje:', e.message); }
};

// "Marcar salida" — desde el DM de cierre, rechazo o pregunta de 30 min.
// La salida manual queda registrada con hora del servidor y NO se puede cambiar.
app.action('cierre_salida', async ({ body, ack, client }) => {
  await ack();
  const uid = body.user.id;
  const fecha = t.today();
  const user = db.getUser(uid);
  if (!user) return;

  const dia = db.getDia(uid, fecha);
  if (dia.salida) { await updateMsg(client, body, txt.cierre.yaCerrado); return; }

  const hora = t.currentTime();
  db.imputarAlmuerzo(user, fecha);
  db.registrar(user, fecha, 'salida', hora, 'slack');
  db.setCierre(uid, fecha, { estado: 'cerrado' });
  await updateMsg(client, body, txt.cierre.salidaRegistrada(hora));
  console.log(`[cierre] ${user.nombre} marcó salida ${hora} (botón)`);
});

// "Necesito 30 min más" → pedido al canal admin
app.action('cierre_extra', async ({ body, ack, client }) => {
  await ack();
  const uid = body.user.id;
  const fecha = t.today();
  const user = db.getUser(uid);
  if (!user) return;

  db.setCierre(uid, fecha, { estado: 'extra_pendiente' });
  await updateMsg(client, body, txt.cierre.extraPedida);

  const target = SOLO_MODE ? SOLO_USER_ID : (process.env.REPORT_CHANNEL || '#asistencia');
  await client.chat.postMessage({
    channel: target,
    text: txt.cierre.adminPedido(user.nombre, user.hora_salida),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: txt.cierre.adminPedido(user.nombre, user.hora_salida) } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: txt.cierre.btnAprobar }, style: 'primary', action_id: 'extra_aprobar', value: uid },
        { type: 'button', text: { type: 'plain_text', text: txt.cierre.btnRechazar }, style: 'danger', action_id: 'extra_rechazar', value: uid },
      ] },
    ],
  });
});

// Aprobación admin — con la primera alcanza para todo el día
app.action('extra_aprobar', async ({ body, action, ack, client }) => {
  await ack();
  const adminId = body.user.id;
  if (!db.isAdmin(adminId)) {
    await client.chat.postEphemeral({ channel: body.channel.id, user: adminId, text: txt.errores.sinPermiso });
    return;
  }
  const uid = action.value;
  const fecha = t.today();
  const user = db.getUser(uid);
  if (!user) return;

  // Si aprobó tarde y la persona ya cerró su jornada, no arrancar el ciclo
  if (db.getDia(uid, fecha).salida) {
    await updateMsg(client, body, `ℹ️ *${user.nombre}* ya cerró su jornada — no hay extra que aprobar.`);
    return;
  }

  db.setCierre(uid, fecha, { estado: 'extra_activa', extra_hasta: t.toHHMM(t.nowMin() + 30) });
  db.addBloqueExtra(uid, fecha, adminId);
  await updateMsg(client, body, txt.cierre.adminAprobado(user.nombre, `<@${adminId}>`));
  await client.chat.postMessage({ channel: uid, text: txt.cierre.extraAprobada(`<@${adminId}>`) });
  console.log(`[extras] ${user.nombre} — bloque 1 aprobado por ${adminId}`);
});

app.action('extra_rechazar', async ({ body, action, ack, client }) => {
  await ack();
  const adminId = body.user.id;
  if (!db.isAdmin(adminId)) {
    await client.chat.postEphemeral({ channel: body.channel.id, user: adminId, text: txt.errores.sinPermiso });
    return;
  }
  const uid = action.value;
  const fecha = t.today();
  const user = db.getUser(uid);
  if (!user) return;

  // Reinicia la ventana de 20 min: si no marca salida, auto-cierre a su horario
  db.setCierre(uid, fecha, { estado: 'esperando', dm_hora: t.currentTime() });
  await updateMsg(client, body, txt.cierre.adminRechazado(user.nombre, `<@${adminId}>`));
  await client.chat.postMessage({
    channel: uid,
    text: txt.cierre.extraRechazada,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: txt.cierre.extraRechazada } },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: txt.cierre.btnSalida }, style: 'primary', action_id: 'cierre_salida' }] },
    ],
  });
});

// "Sí, 30 más" — renueva el bloque sin nueva aprobación del admin
app.action('extra_seguir', async ({ body, ack, client }) => {
  await ack();
  const uid = body.user.id;
  const fecha = t.today();
  const user = db.getUser(uid);
  const cierre = db.getCierre(uid, fecha);
  if (!user || !cierre || cierre.estado === 'cerrado') { await updateMsg(client, body, txt.cierre.yaCerrado); return; }

  db.setCierre(uid, fecha, { estado: 'extra_activa', extra_hasta: t.toHHMM(t.nowMin() + 30) });
  db.addBloqueExtra(uid, fecha, null); // conserva el aprobado_por original
  await updateMsg(client, body, txt.cierre.extraRenovada);
  console.log(`[extras] ${user.nombre} — bloque renovado`);
});

// ═══════════════════════════════════════════════════════════════════
// PING "Acá estoy"
// ═══════════════════════════════════════════════════════════════════
app.action('ping_respond', async ({ body, action, ack, client }) => {
  await ack();
  const seg = db.respondPing(action.value);
  await updateMsg(client, body, seg !== null ? txt.pings.respondido(seg) : txt.pings.expirado);
});

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════
(async () => {
  const PORT = process.env.PORT || 3000;
  setupWeb(receiver);
  setupDashboard(receiver);
  setupScheduler(app);
  await app.start(PORT);

  // Chequeo del token con mensaje claro (no tumba el proceso)
  try {
    const auth = await app.client.auth.test();
    console.log(`[slack] ✅ Conectado como ${auth.user} en ${auth.team}`);
  } catch (e) {
    console.error(`[slack] ❌ El token de Slack no sirve (${e.data?.error || e.message}).`);
    console.error('[slack] 👉 Si reinstalaste la app en api.slack.com, actualizá SLACK_BOT_TOKEN en Railway con el token nuevo.');
  }

  console.log(`\n  ⚡ Hoopla Asistencia — puerto ${PORT}`);
  console.log(`  → Eventos Slack:  POST /slack/events`);
  console.log(`  → Dashboard:      /dashboard`);
  console.log(`  → Marcación:      /verify/:token`);
  if (SOLO_MODE) console.log(`  → 🧪 SOLO_MODE: ${SOLO_USER_ID}`);
  console.log('');
})();
