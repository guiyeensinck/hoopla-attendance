require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { semanaUsuario, saldoMes } = require('./balance');
const { handleAdmin } = require('./admin');
const { route } = require('./dmrouter');
const { procesarImputacion, vistaProyectos, promptImputacion } = require('./proyectos');
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

// ─── SOLO_MODE: beta cerrada (para pruebas) ────────────────────────
// SOLO_USER_ID acepta varios IDs separados por coma — el bot solo les
// responde a ellos. IMPORTANTE: hace ack() antes de descartar — si no,
// Slack muestra error.
const SOLO_MODE = process.env.SOLO_MODE === 'true';
const SOLO_USER_IDS = (process.env.SOLO_USER_ID || '').split(',').map(s => s.trim()).filter(Boolean);
if (SOLO_MODE) {
  console.log(`[solo] 🧪 SOLO_MODE activo — solo responde a: ${SOLO_USER_IDS.join(', ') || '(nadie)'}`);
  app.use(async ({ body, ack, next }) => {
    const uid = body?.user_id || body?.user?.id || body?.event?.user;
    if (uid && !SOLO_USER_IDS.includes(uid)) {
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
  const label = corregible ? txt.marcar.linkLabelCorreccion : txt.marcar.linkLabel(txt.TIPOS[next].emoji, txt.TIPOS[next].label);

  await say({
    text: `${txt.marcar.linkTitle} ${url}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: txt.marcar.linkTitle } },
      { type: 'section', text: { type: 'mrkdwn', text: `${instrucciones}\n\n👉 <${url}|${label}>` } },
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

  const mes = saldoMes(user);
  const mesIcono = mes.diff >= 0 ? '🟢' : mes.diff >= -2 ? '🟡' : '🔴';

  return [
    { type: 'header', text: { type: 'plain_text', text: `📊 Tu estado — ${t.fmtDate(t.today())}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Tu horario: ${user.hora_entrada}–${user.hora_salida} · ${user.carga_horaria}hs/día` }] },
    { type: 'section', text: { type: 'mrkdwn', text: `${estadoLineas.join('\n')}\n\n${estadoDia}` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*📅 Tu semana* (desde el lunes)\n${filas.join('\n')}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `Total: *${s.trabajadas}hs / ${s.esperadas}hs*\n${balanceMsg}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${mesIcono} Saldo del mes: *${mes.diff >= 0 ? '+' : ''}${mes.diff}hs* (${mes.trabajadas}/${mes.esperadas}hs)` }] },
  ];
};

/** Cualquier otro mensaje → menú con botones (y hints de texto) */
const enviarMenu = async (user, say) => {
  if (db.esSoloProyectos(user)) {
    await say(`${txt.chat.menuSaludo(user.nombre)}\nEstás en modo *solo proyectos*: mandame tus horas del día (ej: \`Jumbo 4, Interno 2\`) o escribí *proyectos* para ver el catálogo y lo que llevás imputado.`);
    return;
  }
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

    // Modo solo proyectos: no marca asistencia, solo imputa horas
    if (db.esSoloProyectos(user) && (r.tipo === 'marcar' || r.tipo === 'horarios')) {
      await say(`ℹ️ Estás en modo *solo proyectos* — no hace falta que marques asistencia. Mandame tus horas cuando quieras (ej: \`Jumbo 4, Interno 2\`) o escribí *proyectos* para ver el catálogo.`);
      return;
    }

    if (r.tipo === 'marcar') { await enviarLink(user, say); return; }
    if (r.tipo === 'horarios') { await say({ text: 'Tu estado', blocks: resumenBlocks(user) }); return; }
    if (r.tipo === 'proyectos') { await say(vistaProyectos(user)); return; }
    if (r.tipo === 'misemana') { await enviarSemanaWeb(user, say); return; }
    if (r.tipo === 'imputarweb') { await enviarImputarWeb(user, say); return; }

    // ¿Es una imputación de horas a proyectos? ("Nike 4, Interno 2")
    const imputacion = procesarImputacion(user, message.text);
    if (imputacion) { await say(imputacion); return; }

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

// "Cargar con clicks" — link fresco al formulario web de imputación.
// Sirve en cualquier momento del día: cargás lo que terminaste y el
// formulario suma filas sobre lo que ya llevabas.
const enviarImputarWeb = async (user, say) => {
  const url = `${getBaseUrl()}/imputar/${db.createToken(user.slack_id, 'imputar')}`;
  await say(txt.imputar.linkWeb(url));
};

app.action('imputar_web', async ({ body, ack, client }) => {
  await ack();
  const user = db.getUser(body.user.id);
  if (user?.trackeado) await enviarImputarWeb(user, sayEnDM(client, user.slack_id));
});

// "Mi semana en proyectos" — link a la vista web personal
const enviarSemanaWeb = async (user, say) => {
  const url = `${getBaseUrl()}/misemana/${db.createToken(user.slack_id, 'semana')}`;
  await say(txt.imputar.linkSemana(url));
};

app.action('semana_web', async ({ body, ack, client }) => {
  await ack();
  const user = db.getUser(body.user.id);
  if (user?.trackeado) await enviarSemanaWeb(user, sayEnDM(client, user.slack_id));
});

// ═══════════════════════════════════════════════════════════════════
// CIERRE DEL DÍA (botón)
// ═══════════════════════════════════════════════════════════════════

const updateMsg = async (client, body, text) => {
  try {
    await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text, blocks: [] });
  } catch (e) { console.error('[action] No pude actualizar el mensaje:', e.message); }
};

// "Marcar salida" — desde el DM de cierre.
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
  await promptImputacion(client, user, fecha);
  console.log(`[cierre] ${user.nombre} marcó salida ${hora} (botón)`);
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
  setupWeb(receiver, app.client);
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
  if (SOLO_MODE) console.log(`  → 🧪 SOLO_MODE: ${SOLO_USER_IDS.join(', ')}`);
  console.log('');
})();
