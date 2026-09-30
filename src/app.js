require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { semanaUsuario, saldoMes } = require('./balance');
const { handleAdmin } = require('./admin');
const { route } = require('./dmrouter');
const { procesarImputacion, vistaProyectos, promptImputacion, btnMarcas } = require('./proyectos');
const marcas = require('./marcas');
const { registrarActividad } = require('./activity');
const pruebas = require('./pruebas');
const { responderIA, iaActiva } = require('./ia');
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
// Canal admin (en beta: DM del primer ID de SOLO_USER_ID)
const adminTarget = () => (SOLO_MODE ? SOLO_USER_IDS[0] : (process.env.REPORT_CHANNEL || '#asistencia'));

// ═══════════════════════════════════════════════════════════════════
// INTERACCIÓN — el bot es un "compañero": se le escribe directo por DM,
// o con los comandos /ayuda, /marcar, /cargar, /horarios... (respuesta
// efímera: solo la ve quien lo escribió).
// ═══════════════════════════════════════════════════════════════════

/** "marcar" → link de un solo uso, expira en 5 minutos */
const enviarLink = async (user, say) => {
  const dia = db.getDia(user.slack_id, t.today());
  const next = db.nextTipo(dia);
  if (!next) { await say(txt.marcar.diaCompleto); return; }

  const token = db.createToken(user.slack_id);
  const url = `${getBaseUrl()}/verify/${token}`;
  const instrucciones = txt.marcar.linkInstructions(txt.TIPOS[next].label);
  const label = txt.marcar.linkLabel(txt.TIPOS[next].emoji, txt.TIPOS[next].label);

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
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Tu horario: ${user.hora_entrada}–${user.hora_salida} · ${user.carga_horaria}hs/día${db.horarioDia(user, t.today()) !== user ? ` · *hoy viernes: hasta ${db.SALIDA_VIERNES}*` : ''}` }] },
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
  const hoy = t.today();
  const dia = db.getDia(user.slack_id, hoy);
  const next = db.nextTipo(dia);
  const reclamable = dia.salida?.auto_closed === 1 && !dia.salida.corregido && !db.reclamoPendiente(user.slack_id, hoy);

  const botones = [];
  if (next) {
    botones.push({
      type: 'button', style: 'primary', action_id: 'menu_marcar',
      text: { type: 'plain_text', text: txt.chat.btnMarcar(txt.TIPOS[next].label) },
    });
  }
  if (reclamable) botones.push({ type: 'button', action_id: 'reclamo_abrir', value: hoy, text: { type: 'plain_text', text: txt.chat.btnReclamo } });
  if (db.getProyectos(true).length) botones.push(...btnMarcas().elements.map(b => ({ ...b, style: undefined })));
  botones.push({ type: 'button', action_id: 'menu_semana', text: { type: 'plain_text', text: txt.chat.btnSemana } });

  const hints = [txt.chat.menuHint];
  if (db.isAdmin(user.slack_id)) hints.push(txt.chat.adminHint);

  await say({
    text: txt.chat.menuSaludo(user.nombre),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${txt.chat.menuSaludo(user.nombre)}${next ? '' : `\n${txt.marcar.diaCompleto}`}` } },
      { type: 'actions', elements: botones },
      { type: 'context', elements: hints.map(h => ({ type: 'mrkdwn', text: h })) },
    ],
  });
};

// Router de DMs: marcar / horarios / admin ... / cualquier cosa → menú
const SUBTYPES_ACTIVIDAD = [undefined, 'thread_broadcast', 'file_share', 'me_message'];

app.message(async ({ message, say, client }) => {
  if (message.channel_type !== 'im') {
    // Mensaje en un canal donde está el bot: se guarda SOLO la hora, como
    // señal de actividad en Slack para el cierre (nunca el contenido)
    if (!message.bot_id && SUBTYPES_ACTIVIDAD.includes(message.subtype)) {
      try { registrarActividad(message.user, message.ts, 'mensaje'); } catch (e) { console.error('[actividad]', e.message); }
    }
    return;
  }
  if (message.subtype || message.bot_id) return;          // solo mensajes humanos
  const uid = message.user;
  const conIA = iaActiva();
  // Con IA, las palabras clave solo aplican a mensajes cortos ("marcar",
  // "mis horas"): una frase como "salida anticipada para Juan" va a la charla.
  // "admin ..." explícito siempre va directo.
  const corto = (message.text || '').trim().split(/\s+/).length <= 3;
  let r = route(message.text);
  if (conIA && !corto && r.tipo !== 'admin') r = { tipo: 'menu' };

  try {
    if (r.tipo === 'admin') {
      await handleAdmin({ texto: r.resto, adminId: uid, say, client });
      return;
    }

    const user = db.getUser(uid);
    // Un admin que no está en el seguimiento igual puede gestionar charlando
    if (!user?.trackeado && conIA && db.isAdmin(uid) && r.tipo === 'menu') {
      const perfil = user || { slack_id: uid, nombre: 'admin', hora_entrada: '09:30', hora_salida: '18:30', carga_horaria: 8 };
      const ia = await responderIA(perfil, message.text, { client, channel: message.channel, say, acciones: accionesIA(perfil, say, client) });
      if (ia) await say(ia);
      else if (ia === null) await say(txt.marcar.noTrackeadoAdmin);
      return;
    }
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
    if (r.tipo === 'imputarweb') { await enviarBotonCargar(user, say); return; }

    // ¿Es una imputación de horas a proyectos? ("Nike 4, Interno 2")
    const imputacion = procesarImputacion(user, message.text, { soloSiClaro: conIA });
    if (imputacion) { await say(imputacion); return; }

    // Modo conversacional (ANTHROPIC_API_KEY u OPENAI_API_KEY): entiende
    // lo que le piden y actúa con herramientas; si no, el menú de siempre.
    // '' = ya actuó y no hay nada que agregar.
    const ia = await responderIA(user, message.text, { client, channel: message.channel, say, acciones: accionesIA(user, say, client) });
    if (ia) { await say(ia); return; }
    if (ia === '') return;

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

// "cargar" por DM: los modales solo se abren desde un click → botón
const enviarBotonCargar = async (user, say) => {
  const url = `${getBaseUrl()}/imputar/${db.createToken(user.slack_id, 'imputar')}`;
  await say({
    text: txt.marcas.abrir,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: txt.marcas.abrir } },
      btnMarcas(),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_¿Querés cargar el detalle por proyecto? <${url}|Formulario web>_` }] },
    ],
  });
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

// Acciones que la IA puede ejecutar (las mismas que los comandos)
const accionesIA = (user, say, client) => ({
  marcar: (s) => (db.esSoloProyectos(user) ? s('ℹ️ Estás en modo *solo proyectos*: no marcás asistencia.') : enviarLink(user, s)),
  estado: (s) => s({ text: 'Tu estado', blocks: resumenBlocks(user) }),
  cargar: (s) => enviarBotonCargar(user, s),
  imputar: (texto) => procesarImputacion(user, texto),
  proyectos: (s) => s(vistaProyectos(user)),
  semanaWeb: (s) => enviarSemanaWeb(user, s),
  reclamo: async (s) => {
    const hoy = t.today();
    const salida = db.getDia(user.slack_id, hoy).salida;
    if (!salida?.auto_closed || salida.corregido) { await s(txt.reclamo.noAplica); return; }
    if (db.reclamoPendiente(user.slack_id, hoy)) { await s(txt.reclamo.yaPendiente); return; }
    await s({ text: txt.reclamo.intro(salida.hora), blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: txt.reclamo.intro(salida.hora) } },
      { type: 'actions', elements: [{ type: 'button', action_id: 'reclamo_abrir', value: hoy, text: { type: 'plain_text', text: txt.chat.btnReclamo } }] },
    ] });
  },
  ayuda: () => txt.ayuda,
});

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

// "Terminé" — desde la pregunta de cierre. Registra la salida con hora del servidor.
app.action('cierre_salida', async ({ body, ack, client }) => {
  await ack();
  const uid = body.user.id;
  const fecha = t.today();
  const user = db.getUser(uid);
  if (!user) return;

  const dia = db.getDia(uid, fecha);
  if (dia.salida) { await updateMsg(client, body, txt.cierre.yaCerrado(dia.salida.hora)); return; }

  const hora = t.currentTime();
  db.imputarAlmuerzo(user, fecha);
  db.registrar(user, fecha, 'salida', hora, 'slack');
  db.setCierre(uid, fecha, { estado: 'cerrado' });
  await updateMsg(client, body, txt.cierre.salidaRegistrada(hora));
  await promptImputacion(client, user, fecha);
  console.log(`[cierre] ${user.nombre} marcó salida ${hora} (botón)`);
});

// "Sigo trabajando" — extiende la jornada; se le vuelve a preguntar a los 20'
app.action('cierre_sigo', async ({ body, ack, client }) => {
  await ack();
  const uid = body.user.id;
  const fecha = t.today();
  const dia = db.getDia(uid, fecha);
  if (dia.salida) { await updateMsg(client, body, txt.cierre.yaCerrado(dia.salida.hora)); return; }
  const cierre = db.getCierre(uid, fecha);
  if (!cierre || cierre.estado === 'cerrado') { await updateMsg(client, body, txt.cierre.yaCerrado()); return; }

  const hora = t.currentTime();
  db.setCierre(uid, fecha, { estado: 'extendido', ultima_respuesta: hora });
  await updateMsg(client, body, txt.cierre.sigoOk(t.toHHMM(t.toMin(hora) + pruebas.tiempos(uid).sigo)));
  console.log(`[cierre] ${db.getUser(uid)?.nombre || uid} sigue trabajando (${hora})`);
});

// ═══════════════════════════════════════════════════════════════════
// RECLAMOS DE AUTO-CIERRE — la persona pide una hora, un admin aprueba
// ═══════════════════════════════════════════════════════════════════
app.action('reclamo_abrir', async ({ body, action, ack, client }) => {
  await ack();
  const uid = body.user.id;
  const fecha = action.value || t.today();
  const salida = db.getDia(uid, fecha).salida;
  const avisar = (text) => client.chat.postMessage({ channel: uid, text });
  if (!salida?.auto_closed || salida.corregido) { await avisar(txt.reclamo.noAplica); return; }
  if (db.reclamoPendiente(uid, fecha)) { await avisar(txt.reclamo.yaPendiente); return; }

  const sugerida = fecha === t.today() ? t.currentTime() : salida.hora;
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal', callback_id: 'reclamo_submit',
      private_metadata: JSON.stringify({ fecha }),
      title: { type: 'plain_text', text: txt.reclamo.titulo },
      submit: { type: 'plain_text', text: 'Enviar' },
      close: { type: 'plain_text', text: 'Cancelar' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: txt.reclamo.intro(salida.hora) } },
        { type: 'input', block_id: 'hora', label: { type: 'plain_text', text: txt.reclamo.labelHora },
          element: { type: 'timepicker', action_id: 'hora', initial_time: sugerida } },
        { type: 'input', block_id: 'motivo', label: { type: 'plain_text', text: txt.reclamo.labelMotivo },
          element: { type: 'plain_text_input', action_id: 'motivo', multiline: true, max_length: 500,
            placeholder: { type: 'plain_text', text: txt.reclamo.placeholderMotivo } } },
      ],
    },
  });
});

app.view('reclamo_submit', async ({ ack, body, view, client }) => {
  const uid = body.user.id;
  const { fecha } = JSON.parse(view.private_metadata || '{}');
  const hora = view.state.values.hora?.hora?.selected_time;
  const motivo = (view.state.values.motivo?.motivo?.value || '').trim();
  const salida = db.getDia(uid, fecha).salida;
  if (!salida?.auto_closed || salida.corregido || db.reclamoPendiente(uid, fecha)) {
    await ack({ response_action: 'errors', errors: { hora: txt.reclamo.noAplica } });
    return;
  }
  const enFuturo = fecha === t.today() && hora > t.currentTime();
  if (!hora || hora <= salida.hora || enFuturo) {
    await ack({ response_action: 'errors', errors: { hora: txt.reclamo.horaInvalida(salida.hora) } });
    return;
  }
  await ack();

  const id = db.crearReclamo(uid, fecha, hora, motivo);
  const user = db.getUser(uid);
  const texto = txt.reclamo.admin(user?.nombre || uid, t.fmtDate(fecha), salida.hora, hora, motivo || '(sin motivo)');
  await client.chat.postMessage({
    channel: adminTarget(),
    text: texto,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: texto } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'reclamo_aprobar', value: String(id), text: { type: 'plain_text', text: txt.reclamo.btnAprobar } },
        { type: 'button', style: 'danger', action_id: 'reclamo_rechazar', value: String(id), text: { type: 'plain_text', text: txt.reclamo.btnRechazar } },
      ] },
    ],
  });
  await client.chat.postMessage({ channel: uid, text: txt.reclamo.enviado(hora) });
  console.log(`[reclamo] ${user?.nombre || uid} ${fecha}: ${salida.hora} → ${hora}`);
});

app.action(/^reclamo_(aprobar|rechazar)$/, async ({ body, action, ack, client }) => {
  await ack();
  const adminId = body.user.id;
  if (!db.isAdmin(adminId)) {
    await client.chat.postEphemeral({ channel: body.channel.id, user: adminId, text: txt.errores.sinPermiso }).catch(() => {});
    return;
  }
  const r = db.getReclamo(Number(action.value));
  const aprobar = action.action_id === 'reclamo_aprobar';
  if (!r || !db.resolverReclamo(r.id, aprobar ? 'aprobado' : 'rechazado', adminId)) {
    await updateMsg(client, body, txt.reclamo.yaResuelto);
    return;
  }
  const user = db.getUser(r.user_id);
  const nombre = user?.nombre || r.user_id;
  if (aprobar) {
    db.aplicarReclamo(user, r.fecha, r.hora_pedida);
    await updateMsg(client, body, txt.reclamo.aprobadoAdmin(nombre, r.hora_pedida, adminId));
    await client.chat.postMessage({ channel: r.user_id, text: txt.reclamo.aprobadoUser(t.fmtDate(r.fecha), r.hora_pedida) });
  } else {
    const salida = db.getDia(r.user_id, r.fecha).salida;
    await updateMsg(client, body, txt.reclamo.rechazadoAdmin(nombre, adminId));
    await client.chat.postMessage({ channel: r.user_id, text: txt.reclamo.rechazadoUser(t.fmtDate(r.fecha), salida?.hora || '—') });
  }
  console.log(`[reclamo] #${r.id} ${aprobar ? 'aprobado' : 'rechazado'} por ${adminId}`);
});

// ═══════════════════════════════════════════════════════════════════
// IMPUTACIÓN POR MARCAS (modal)
// ═══════════════════════════════════════════════════════════════════
app.action('imputar_modal', async ({ body, ack, client }) => {
  await ack();
  const user = db.getUser(body.user.id);
  if (user?.trackeado) await marcas.abrirModal(client, body.trigger_id, user);
});

app.action('marcas_sel', async ({ body, ack, client }) => {
  await ack();
  try { await marcas.onSeleccion({ body, client }); } catch (e) { console.error('[marcas] update:', e.data?.error || e.message); }
});

app.view(marcas.CALLBACK, async ({ ack, body, view, client }) => {
  const r = marcas.guardar(body.user.id, view);
  if (r.errors) { await ack({ response_action: 'errors', errors: r.errors }); return; }
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: r.texto });
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
// COMANDOS "/" — respuesta efímera (solo la ve quien escribió el comando)
// ═══════════════════════════════════════════════════════════════════
const comando = (nombre, fn, { requiereTracking = true } = {}) =>
  app.command(nombre, async ({ command, ack, respond, client }) => {
    await ack();
    const say = (msg) => respond({ response_type: 'ephemeral', ...(typeof msg === 'string' ? { text: msg } : msg) });
    try {
      const user = db.getUser(command.user_id);
      if (requiereTracking && !user?.trackeado) {
        await say(db.isAdmin(command.user_id) ? txt.marcar.noTrackeadoAdmin : txt.marcar.noTrackeado);
        return;
      }
      await fn({ command, user, say, client });
    } catch (e) {
      console.error(`[cmd] ${nombre}:`, e);
    }
  });

const soloProyectosAviso = 'ℹ️ Estás en modo *solo proyectos* — no hace falta que marques asistencia. Usá `/cargar` para cargar tus horas.';

comando('/ayuda', async ({ command, say }) => {
  await say(txt.ayuda + (db.isAdmin(command.user_id) ? `\n\n${txt.chat.adminHint} _(o \`/admin\`)_` : ''));
}, { requiereTracking: false });
comando('/marcar', async ({ user, say }) => {
  if (db.esSoloProyectos(user)) { await say(soloProyectosAviso); return; }
  await enviarLink(user, say);
});
comando('/horarios', async ({ user, say }) => {
  if (db.esSoloProyectos(user)) { await say(soloProyectosAviso); return; }
  await say({ text: 'Tu estado', blocks: resumenBlocks(user) });
});
comando('/cargar', async ({ command, user, client }) => {
  await marcas.abrirModal(client, command.trigger_id, user);
});
comando('/proyectos', async ({ user, say }) => { await say(vistaProyectos(user)); });
comando('/misemana', async ({ user, say }) => { await enviarSemanaWeb(user, say); });
comando('/admin', async ({ command, say, client }) => {
  await handleAdmin({ texto: command.text, adminId: command.user_id, say, client });
}, { requiereTracking: false });

// Reacciones en canales donde está el bot: también son actividad en Slack
app.event('reaction_added', async ({ event }) => {
  try { registrarActividad(event.user, event.event_ts, 'reaccion'); } catch (e) { console.error('[actividad]', e.message); }
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
  console.log(`  → Eventos Slack:  POST /slack/events (DMs, comandos /, botones, modales)`);
  console.log(`  → Dashboard:      /dashboard`);
  console.log(`  → Marcación:      /verify/:token`);
  if (SOLO_MODE) console.log(`  → 🧪 SOLO_MODE: ${SOLO_USER_IDS.join(', ')}`);
  console.log('');
})();
