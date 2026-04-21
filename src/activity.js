const t = require('./time');
const db = require('./database');

// ─── Config ────────────────────────────────────────────────────────
const PING_TIMEOUT_MIN = parseInt(process.env.PING_TIMEOUT_MIN || '10', 10);
const WORK_START_HOUR = parseInt(process.env.WORK_START_HOUR || '9', 10);
const WORK_END_HOUR = parseInt(process.env.WORK_END_HOUR || '18', 10);

// 4 pings por día: 2 a la mañana + 2 a la tarde. Los de la tarde marcan "última
// actividad" y se usan como hora de salida fallback si el usuario no cierra el día.
// Cada ping se dispara a la hora base ± PING_JITTER_MIN, random por usuario/día.
//
// Diseño: 98% del equipo trabaja hasta las 18:20 como máximo. El último ping a las
// ~18:00 captura la salida con error <= 20 min para la gran mayoría.
const PING_SLOTS = [
  { name: 'morning_1',   hour: 10, minute: 30, role: 'activity' },  // ~10:30 — ya arrancaron
  { name: 'morning_2',   hour: 12, minute: 0,  role: 'activity' },  // ~12:00 — pre-almuerzo
  { name: 'afternoon_1', hour: 15, minute: 30, role: 'exit'     },  // ~15:30 — post-almuerzo
  { name: 'afternoon_2', hour: 18, minute: 0,  role: 'exit'     },  // ~18:00 — captura salida
];
const PINGS_PER_DAY = PING_SLOTS.length;
const PING_JITTER_MIN = 5;

// ─── Track scheduled pings per user per day ────────────────────────
// Map<`${slackId}-${date}`, [{ name, minute, fired }]>
const scheduledPings = new Map();

/** Schedule the 4 daily pings with random jitter for a user. */
const schedulePingsForUser = (slackId, date) => {
  const key = `${slackId}-${date}`;
  if (scheduledPings.has(key)) return scheduledPings.get(key);

  const slots = PING_SLOTS.map(s => {
    const base = s.hour * 60 + s.minute;
    const jitter = Math.floor(Math.random() * (PING_JITTER_MIN * 2 + 1)) - PING_JITTER_MIN;
    return { name: s.name, role: s.role, minute: base + jitter, fired: false };
  });

  scheduledPings.set(key, slots);
  return slots;
};

/** Find the next slot that should fire now (gives 2-min window to catch late crons). */
const shouldPingNow = (slackId, date, currentMinute) => {
  const slots = scheduledPings.get(`${slackId}-${date}`);
  if (!slots) return false;
  const slot = slots.find(s => !s.fired && currentMinute >= s.minute && currentMinute <= s.minute + 2);
  if (slot) { slot.fired = true; return true; }
  return false;
};

/**
 * Build the ping DM blocks
 */
const buildPingMessage = (pingId) => {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `👋 *¡Hola! Solo chequeamos que estés por acá.*\n\nTocá el botón cuando puedas 😊`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Acá estoy' },
          style: 'primary',
          action_id: 'ping_respond',
          value: String(pingId),
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_Pings de actividad: 4 por día (2 a la mañana + 2 a la tarde) en horarios aleatorios. Los de la tarde marcan tu última actividad — si no cerrás la jornada, se usa ese horario como salida._`,
        },
      ],
    },
  ];
};

/**
 * Send pings to all tracked users who are currently working.
 * Called every minute from scheduler cron.
 */
const runPingCycle = async (app) => {
  const now = t.now();
  const date = now.format('YYYY-MM-DD');
  const currentMinute = now.hour() * 60 + now.minute();
  const currentTime = now.format('HH:mm:ss');

  // Skip weekends
  const dayOfWeek = now.day();
  if (dayOfWeek === 0 || dayOfWeek === 6) return;

  // Skip outside work hours
  if (now.hour() < WORK_START_HOUR || now.hour() >= WORK_END_HOUR) return;

  const tracked = db.getTrackedUsers();

  for (const user of tracked) {
    // Skip exempt users (vacation, holiday, medical, etc.)
    if (db.isUserExemptToday(user.slack_id, date)) continue;

    // Skip field workers (no desktop pings)
    if (db.isFieldDay(user.slack_id, date)) continue;

    // Only ping users who checked in today and haven't exited
    const record = db.getRecord(user.slack_id, date);
    if (!record || !record.entry_time || record.exit_time) continue;

    // Skip during lunch
    if (record.lunch_start && !record.lunch_end) continue;

    // Schedule pings for this user if not yet done
    schedulePingsForUser(user.slack_id, date);

    // Check if it's time (slot system prevents double-firing, so no extra count check needed)
    if (!shouldPingNow(user.slack_id, date, currentMinute)) continue;

    try {
      const pingId = db.createPing(user.slack_id, date, currentTime);
      const blocks = buildPingMessage(pingId);

      await app.client.chat.postMessage({
        channel: user.slack_id,
        text: '🏓 Check de actividad — ¿seguís ahí?',
        blocks,
      });

      console.log(`[activity] Ping sent to ${user.real_name || user.name} (id: ${pingId})`);
    } catch (err) {
      console.error(`[activity] Error sending ping to ${user.slack_id}:`, err.message);
    }
  }

  // Expire old pings (older than PING_TIMEOUT_MIN)
  const cutoff = now.subtract(PING_TIMEOUT_MIN, 'minute').format('HH:mm:ss');
  const expired = db.expirePings(cutoff, date);
  if (expired.changes > 0) {
    console.log(`[activity] ${expired.changes} pings expired`);
  }
};

/**
 * Check Slack presence for all tracked users.
 * Called every 30 min from scheduler.
 */
const runPresenceCheck = async (app) => {
  const now = t.now();
  const date = now.format('YYYY-MM-DD');
  const time = now.format('HH:mm');

  // Skip weekends and outside work hours
  if (now.day() === 0 || now.day() === 6) return;
  if (now.hour() < WORK_START_HOUR || now.hour() >= WORK_END_HOUR) return;

  const tracked = db.getTrackedUsers();

  for (const user of tracked) {
    // Only check users who are "at work" today
    const record = db.getRecord(user.slack_id, date);
    if (!record || !record.entry_time || record.exit_time) continue;

    try {
      const result = await app.client.users.getPresence({ user: user.slack_id });
      const presence = result.presence; // 'active' or 'away'

      db.logPresence(user.slack_id, date, time, presence);
    } catch (err) {
      console.error(`[presence] Error checking ${user.slack_id}:`, err.message);
    }
  }

  console.log(`[presence] Check completed for ${tracked.length} users at ${time}`);
};

module.exports = {
  runPingCycle,
  runPresenceCheck,
  buildPingMessage,
  PINGS_PER_DAY,
  PING_TIMEOUT_MIN,
};
