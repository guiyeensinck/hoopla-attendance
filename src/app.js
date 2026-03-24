require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const dayjs = require('dayjs');
const db = require('./database');
const blocks = require('./blocks');
const { setupScheduler } = require('./scheduler');
const { setupDashboard } = require('./dashboard');

// ─── Express receiver ──────────────────────────────────────────────
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ─── Solo mode ─────────────────────────────────────────────────────
const SOLO_MODE = process.env.SOLO_MODE === 'true';
const SOLO_USER_ID = process.env.SOLO_USER_ID || '';

if (SOLO_MODE) {
  console.log(`[solo] Modo solo activado — solo responde a ${SOLO_USER_ID}`);
  app.use(async ({ next, body }) => {
    const userId = body?.user_id || body?.user?.id || body?.event?.user;
    if (userId && userId !== SOLO_USER_ID) return;
    await next();
  });
}

// ─── Pending selections state ──────────────────────────────────────
const pendingSelections = new Map();

// ═══════════════════════════════════════════════════════════════════
// /asistencia
// ═══════════════════════════════════════════════════════════════════

app.command('/asistencia', async ({ command, ack, respond }) => {
  await ack();
  const { user_id, user_name } = command;
  const today = dayjs().format('YYYY-MM-DD');

  db.upsertUser({ slack_id: user_id, name: user_name, real_name: user_name });
  const record = db.getOrCreateRecord(user_id, today);

  await respond({
    response_type: 'ephemeral',
    blocks: blocks.buildAttendanceMenu(record),
  });
});

// ═══════════════════════════════════════════════════════════════════
// ATTENDANCE ACTIONS
// ═══════════════════════════════════════════════════════════════════

app.action('select_action_type', async ({ action, body, ack }) => {
  await ack();
  const current = pendingSelections.get(body.user.id) || {};
  pendingSelections.set(body.user.id, { ...current, actionType: action.selected_option.value });
});

app.action('select_time', async ({ action, body, ack }) => {
  await ack();
  const current = pendingSelections.get(body.user.id) || {};
  pendingSelections.set(body.user.id, { ...current, time: action.selected_option.value });
});

app.action('confirm_attendance', async ({ action, body, ack, respond }) => {
  await ack();
  const userId = body.user.id;
  const today = action.value;
  const pending = pendingSelections.get(userId);

  if (!pending || !pending.actionType || !pending.time) {
    await respond({ response_type: 'ephemeral', text: '⚠️ Seleccioná qué registrar y la hora antes de confirmar.', replace_original: false });
    return;
  }

  db.upsertUser({ slack_id: userId, name: body.user.username || body.user.name, real_name: body.user.username || body.user.name });
  const record = db.updateField(userId, today, pending.actionType, pending.time);
  const confirmation = blocks.buildConfirmation(pending.actionType, pending.time);
  pendingSelections.delete(userId);

  await respond({
    response_type: 'ephemeral',
    blocks: [...confirmation, { type: 'divider' }, ...blocks.buildAttendanceMenu(record)],
    replace_original: true,
  });
});

app.action('register_now', async ({ action, body, ack, respond }) => {
  await ack();
  const userId = body.user.id;
  const today = action.value;
  const now = dayjs().format('HH:mm');

  db.upsertUser({ slack_id: userId, name: body.user.username || body.user.name, real_name: body.user.username || body.user.name });
  const currentRecord = db.getOrCreateRecord(userId, today);
  const pending = pendingSelections.get(userId);
  const actionType = pending?.actionType || blocks.getNextAction(currentRecord);

  if (!actionType) {
    await respond({ response_type: 'ephemeral', text: '✅ Ya tenés el día completo registrado.', replace_original: false });
    return;
  }

  const record = db.updateField(userId, today, actionType, now);
  const confirmation = blocks.buildConfirmation(actionType, now);
  pendingSelections.delete(userId);

  await respond({
    response_type: 'ephemeral',
    blocks: [...confirmation, { type: 'divider' }, ...blocks.buildAttendanceMenu(record)],
    replace_original: true,
  });
});

// ═══════════════════════════════════════════════════════════════════
// /reporte
// ═══════════════════════════════════════════════════════════════════

app.command('/reporte', async ({ command, ack, respond }) => {
  await ack();
  const args = command.text.trim().toLowerCase();
  let startDate, endDate;

  if (args === 'mensual' || args === 'mes') {
    startDate = dayjs().startOf('month').format('YYYY-MM-DD');
    endDate = dayjs().format('YYYY-MM-DD');
  } else {
    startDate = dayjs().startOf('week').format('YYYY-MM-DD');
    endDate = dayjs().format('YYYY-MM-DD');
  }

  const summary = db.getWeeklySummary(startDate, endDate);
  await respond({ response_type: 'ephemeral', blocks: blocks.buildWeeklyReport(summary, startDate, endDate) });
});

// ═══════════════════════════════════════════════════════════════════
// /admin — User roster management
// ═══════════════════════════════════════════════════════════════════

app.command('/admin', async ({ command, ack, respond, client }) => {
  await ack();
  const userId = command.user_id;

  // Auth check
  if (!db.isAdmin(userId)) {
    await respond({ response_type: 'ephemeral', text: '🔒 No tenés permisos de administrador.' });
    return;
  }

  const text = command.text.trim();
  const [action, ...rest] = text.split(/\s+/);
  const mention = rest.join(' ');

  // Extract Slack user ID from mention format <@U12345|name> or raw ID
  const extractUserId = (str) => {
    const match = str.match(/<@([A-Z0-9]+)\|?[^>]*>/);
    if (match) return match[1];
    if (/^U[A-Z0-9]+$/.test(str)) return str;
    return null;
  };

  switch (action?.toLowerCase()) {

    // ─── List tracked users ────────────────────────────────────────
    case 'lista':
    case 'list':
    case '': {
      const allUsers = db.getAllUsers();
      const tracked = db.getTrackedUsers();
      const trackedIds = tracked.map(u => u.slack_id);
      await respond({
        response_type: 'ephemeral',
        blocks: blocks.buildAdminMenu(allUsers, trackedIds),
      });
      break;
    }

    // ─── Add user to tracking ──────────────────────────────────────
    case 'agregar':
    case 'add': {
      const targetId = extractUserId(mention);
      if (!targetId) {
        await respond({ response_type: 'ephemeral', text: '⚠️ Usá: `/admin agregar @usuario`' });
        return;
      }

      // Fetch user info from Slack to save their real name
      try {
        const info = await client.users.info({ user: targetId });
        db.upsertUser({
          slack_id: targetId,
          name: info.user.name,
          real_name: info.user.real_name || info.user.name,
        });
      } catch (e) {
        db.upsertUser({ slack_id: targetId, name: mention, real_name: mention });
      }

      db.setTracked(1, targetId);
      const user = db.getUser(targetId);
      await respond({
        response_type: 'ephemeral',
        text: `✅ *${user.real_name || user.name}* agregado al tracking. Va a recibir pings de actividad y debe fichar asistencia.`,
      });
      break;
    }

    // ─── Remove user from tracking ─────────────────────────────────
    case 'sacar':
    case 'quitar':
    case 'remove': {
      const targetId = extractUserId(mention);
      if (!targetId) {
        await respond({ response_type: 'ephemeral', text: '⚠️ Usá: `/admin sacar @usuario`' });
        return;
      }
      db.setTracked(0, targetId);
      const user = db.getUser(targetId);
      await respond({
        response_type: 'ephemeral',
        text: `✅ *${user?.real_name || targetId}* sacado del tracking.`,
      });
      break;
    }

    // ─── Grant admin ───────────────────────────────────────────────
    case 'admin': {
      const targetId = extractUserId(mention);
      if (!targetId) {
        await respond({ response_type: 'ephemeral', text: '⚠️ Usá: `/admin admin @usuario`' });
        return;
      }
      try {
        const info = await client.users.info({ user: targetId });
        db.upsertUser({
          slack_id: targetId,
          name: info.user.name,
          real_name: info.user.real_name || info.user.name,
        });
      } catch (e) {}

      db.setAdmin(1, targetId);
      const user = db.getUser(targetId);
      await respond({
        response_type: 'ephemeral',
        text: `✅ *${user?.real_name || targetId}* ahora es admin.`,
      });
      break;
    }

    // ─── Activity ping report ──────────────────────────────────────
    case 'actividad':
    case 'pings': {
      const startDate = dayjs().startOf('week').format('YYYY-MM-DD');
      const endDate = dayjs().format('YYYY-MM-DD');
      const summary = db.getPingSummary(startDate, endDate);
      await respond({
        response_type: 'ephemeral',
        blocks: blocks.buildPingSummaryReport(summary, startDate, endDate),
      });
      break;
    }

    // ─── Presence report ───────────────────────────────────────────
    case 'presencia':
    case 'presence': {
      const startDate = dayjs().startOf('week').format('YYYY-MM-DD');
      const endDate = dayjs().format('YYYY-MM-DD');
      const tracked = db.getTrackedUsers();
      const presenceData = [];
      for (const u of tracked) {
        const ps = db.getPresenceSummary(u.slack_id, startDate, endDate);
        if (ps && ps.total_checks > 0) {
          presenceData.push({ ...ps, name: u.name, real_name: u.real_name });
        }
      }
      await respond({
        response_type: 'ephemeral',
        blocks: blocks.buildPresenceSummaryReport(presenceData, startDate, endDate),
      });
      break;
    }

    default:
      await respond({
        response_type: 'ephemeral',
        text: '❓ Comando no reconocido. Usá `/admin lista` para ver opciones.',
      });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ACTIVITY PING RESPONSE
// ═══════════════════════════════════════════════════════════════════

app.action('ping_respond', async ({ action, body, ack, respond }) => {
  await ack();
  const pingId = parseInt(action.value, 10);
  const result = db.respondToPing(pingId);

  if (result) {
    const seconds = Math.round(result.response_ms / 1000);
    await respond({
      response_type: 'ephemeral',
      text: `✅ Respuesta registrada en ${seconds}s. ¡Bien ahí!`,
      replace_original: true,
    });
  } else {
    await respond({
      response_type: 'ephemeral',
      text: '⏱️ Este ping ya expiró o ya fue respondido.',
      replace_original: true,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// APP HOME & EVENTS
// ═══════════════════════════════════════════════════════════════════

app.event('app_home_opened', async ({ event, client }) => {
  const today = dayjs().format('YYYY-MM-DD');
  const record = db.getRecord(event.user, today);

  await client.views.publish({
    user_id: event.user,
    view: {
      type: 'home',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '⚡ Hoopla Asistencia' } },
        { type: 'section', text: { type: 'mrkdwn', text: 'Usá `/asistencia` para registrar tu horario.\nUsá `/admin lista` si sos admin.' } },
        { type: 'divider' },
        ...blocks.buildAttendanceMenu(record),
      ],
    },
  });
});

app.event('team_join', async ({ event }) => {
  db.upsertUser({
    slack_id: event.user.id,
    name: event.user.name,
    real_name: event.user.real_name || event.user.name,
  });
});

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════

(async () => {
  const PORT = process.env.PORT || 3000;

  setupDashboard(app);
  setupScheduler(app);

  await app.start(PORT);

  console.log('');
  console.log('  ⚡ Hoopla Asistencia running');
  console.log(`  → Slack app:   port ${PORT}`);
  console.log(`  → Dashboard:   http://localhost:${PORT}/dashboard`);
  console.log(`  → API:         http://localhost:${PORT}/dashboard/api/records`);
  if (SOLO_MODE) console.log(`  → Solo mode:   ON (${SOLO_USER_ID})`);
  console.log('');
})();
