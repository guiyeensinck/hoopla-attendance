const t = require('./time');
const db = require('./database');

// ─── Config ────────────────────────────────────────────────────────
const PINGS_PER_DAY = parseInt(process.env.PINGS_PER_DAY || '3', 10);
const PING_TIMEOUT_MIN = parseInt(process.env.PING_TIMEOUT_MIN || '10', 10);
const WORK_START_HOUR = parseInt(process.env.WORK_START_HOUR || '9', 10);
const WORK_END_HOUR = parseInt(process.env.WORK_END_HOUR || '18', 10);

// ─── Track scheduled pings per user per day ────────────────────────
// Map<`${slackId}-${date}`, Set<scheduledMinute>>
const scheduledPings = new Map();

/**
 * Schedule random ping times for a user for today.
 * Returns array of minute-of-day values when pings should fire.
 */
const schedulePingsForUser = (slackId, date) => {
  const key = `${slackId}-${date}`;
  if (scheduledPings.has(key)) return [...scheduledPings.get(key)];

  const startMin = WORK_START_HOUR * 60 + 30;  // 30 min after start
  const endMin = WORK_END_HOUR * 60 - 30;      // 30 min before end
  const range = endMin - startMin;

  const times = new Set();
  let attempts = 0;
  while (times.size < PINGS_PER_DAY && attempts < 50) {
    const minute = startMin + Math.floor(Math.random() * range);
    // Ensure at least 45 min between pings
    const tooClose = [...times].some(t => Math.abs(t - minute) < 45);
    if (!tooClose) times.add(minute);
    attempts++;
  }

  scheduledPings.set(key, times);
  return [...times].sort((a, b) => a - b);
};

/**
 * Check if current minute matches any scheduled ping for the user.
 */
const shouldPingNow = (slackId, date, currentMinute) => {
  const key = `${slackId}-${date}`;
  const times = scheduledPings.get(key);
  if (!times) return false;
  // Allow ±1 minute tolerance
  for (const t of times) {
    if (Math.abs(currentMinute - t) <= 1) {
      times.delete(t); // Don't fire same time twice
      return true;
    }
  }
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
        text: `🏓 *Check de actividad*\n¿Seguís ahí? Tocá el botón para confirmar.`,
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
          text: `⏱️ Tenés ${PING_TIMEOUT_MIN} minutos para responder`,
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

    // Check if it's time
    if (!shouldPingNow(user.slack_id, date, currentMinute)) continue;

    // Check daily limit
    const todayCount = db.getTodayPingCount(user.slack_id, date);
    if (todayCount >= PINGS_PER_DAY) continue;

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
