const t = require('./time');
const db = require('./database');
const txt = require('./texts');

const PING_TIMEOUT_MIN = 10;
const PINGS_POR_DIA = 3;

// ═══════════════════════════════════════════════════════════════════
// PRESENCIA — polling cada 15 min, solo dentro del horario personal
// ═══════════════════════════════════════════════════════════════════
const runPresenceCheck = async (app, soloUser = null) => {
  const fecha = t.today();
  if (!t.isWeekday(fecha) || db.isFeriado(fecha)) return;
  const nowM = t.nowMin();
  let checked = 0;

  for (const user of db.getTracked()) {
    if (soloUser && user.slack_id !== soloUser) continue;
    if (db.isExento(user.slack_id, fecha)) continue;
    // Solo dentro del horario laboral de cada persona
    if (nowM < t.toMin(user.hora_entrada) || nowM >= t.toMin(user.hora_salida)) continue;

    try {
      const r = await app.client.users.getPresence({ user: user.slack_id });
      db.logPresencia(user.slack_id, fecha, t.currentTime(), r.presence);
      checked++;
    } catch (err) {
      console.error(`[presencia] Error con ${user.slack_id}: ${err.message}`);
    }
  }
  if (checked) console.log(`[presencia] ${checked} checks a las ${t.currentTime()}`);
};

// ═══════════════════════════════════════════════════════════════════
// PINGS DIRIGIDOS — solo para personas con modo activo (comando admin)
// ═══════════════════════════════════════════════════════════════════

// Horarios aleatorios del día por persona (en memoria: si el server
// reinicia se regeneran, sigue siendo aleatorio e impredecible)
const agenda = new Map(); // `${uid}-${fecha}` → [{ minuto, disparado }]

const agendaDelDia = (user, fecha) => {
  const key = `${user.slack_id}-${fecha}`;
  if (agenda.has(key)) return agenda.get(key);
  const desde = t.toMin(user.hora_entrada) + 30;
  const hasta = t.toMin(user.hora_salida) - 30;
  const slots = [];
  if (hasta > desde) {
    const tramo = Math.floor((hasta - desde) / PINGS_POR_DIA);
    for (let i = 0; i < PINGS_POR_DIA; i++) {
      slots.push({ minuto: desde + i * tramo + Math.floor(Math.random() * Math.max(1, tramo)), disparado: false });
    }
  }
  agenda.set(key, slots);
  return slots;
};

const runPingCycle = async (app, soloUser = null) => {
  const fecha = t.today();
  if (!t.isWeekday(fecha) || db.isFeriado(fecha)) return;
  const nowM = t.nowMin();

  for (const user of db.getTracked()) {
    if (soloUser && user.slack_id !== soloUser) continue;
    if (!db.getPingModoActivo(user.slack_id, fecha)) continue;
    if (db.isExento(user.slack_id, fecha)) continue;

    // Solo en horario laboral y con jornada abierta
    const dia = db.getDia(user.slack_id, fecha);
    if (!dia.entrada || dia.salida) continue;
    if (dia.almuerzo_inicio && !dia.almuerzo_fin) continue; // en almuerzo
    if (nowM < t.toMin(user.hora_entrada) || nowM >= t.toMin(user.hora_salida)) continue;

    const slots = agendaDelDia(user, fecha);
    // Ventana de 3 min por si un tick se pierde; el flag evita duplicados
    const slot = slots.find(s => !s.disparado && nowM >= s.minuto && nowM <= s.minuto + 3);
    if (!slot) continue;
    if (db.pingsHoyCount(user.slack_id, fecha) >= PINGS_POR_DIA) continue;
    slot.disparado = true;

    try {
      const pingId = db.createPing(user.slack_id, fecha, t.now().format('HH:mm:ss'));
      await app.client.chat.postMessage({
        channel: user.slack_id,
        text: txt.pings.ping,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: txt.pings.ping } },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: txt.pings.btnAca }, style: 'primary', action_id: 'ping_respond', value: pingId }] },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `_Chequeo de actividad activado por un admin. Tenés ${PING_TIMEOUT_MIN} minutos para responder._` }] },
        ],
      });
      console.log(`[pings] Ping a ${user.nombre} (${pingId})`);
    } catch (err) {
      console.error(`[pings] Error con ${user.slack_id}: ${err.message}`);
    }
  }

  // Vencer pings sin respuesta (timeout 10 min)
  const cutoff = t.now().subtract(PING_TIMEOUT_MIN, 'minute').format('HH:mm:ss');
  const res = db.expirarPings(fecha, cutoff);
  if (res.changes > 0) console.log(`[pings] ${res.changes} pings vencidos`);
};

module.exports = { runPresenceCheck, runPingCycle, PING_TIMEOUT_MIN };
