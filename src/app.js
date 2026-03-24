require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const dayjs = require('dayjs');
const db = require('./database');
const blocks = require('./blocks');
const { setupScheduler } = require('./scheduler');
const { setupDashboard } = require('./dashboard');
const { createToken } = require('./verification');

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

// ─── Base URL for links ────────────────────────────────────────────
const getBaseUrl = () => {
  if (process.env.APP_URL) return process.env.APP_URL;
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
};

// ═══════════════════════════════════════════════════════════════════
// /asistencia — Returns a verification link
// ═══════════════════════════════════════════════════════════════════

app.command('/asistencia', async ({ command, ack }) => {
  const { user_id, user_name } = command;

  db.upsertUser({ slack_id: user_id, name: user_name, real_name: user_name });

  const token = createToken(user_id);
  const url = `${getBaseUrl()}/verify/${token}`;

  await ack({
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '📋 *Registro de asistencia*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Abrí este link *desde tu computadora* para registrar tu asistencia:\n\n👉 <${url}|Registrar asistencia>`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '⏱️ El link expira en 2 minutos. Solo funciona desde un navegador de escritorio.',
          },
        ],
      },
    ],
  });
});

// ═══════════════════════════════════════════════════════════════════
// /reporte
// ═══════════════════════════════════════════════════════════════════

app.command('/reporte', async ({ command, ack }) => {
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
  await ack({
    response_type: 'ephemeral',
    blocks: blocks.buildWeeklyReport(summary, startDate, endDate),
  });
});

// ═══════════════════════════════════════════════════════════════════
// /admin
// ═══════════════════════════════════════════════════════════════════

app.command('/admin', async ({ command, ack, client }) => {
  const userId = command.user_id;

  if (!db.isAdmin(userId)) {
    await ack({ response_type: 'ephemeral', text: '🔒 No tenés permisos de administrador.' });
    return;
  }

  const text = command.text.trim();
  const [action, ...rest] = text.split(/\s+/);
  const mention = rest.join(' ');

  const extractUserId = (str) => {
    const match = str.match(/<@([A-Z0-9]+)\|?[^>]*>/);
    if (match) return match[1];
    if (/^U[A-Z0-9]+$/.test(str)) return str;
    return null;
  };

  switch (action?.toLowerCase()) {
    case 'lista':
    case 'list':
    case undefined:
    case '': {
      const allUsers = db.getAllUsers();
      const tracked = db.getTrackedUsers();
      const trackedIds = tracked.map(u => u.slack_id);
      await ack({ response_type: 'ephemeral', blocks: blocks.buildAdminMenu(allUsers, trackedIds) });
      break;
    }

    case 'agregar':
    case 'add': {
      const targetId = extractUserId(mention);
      if (!targetId) { await ack({ response_type: 'ephemeral', text: '⚠️ Usá: `/admin agregar @usuario`' }); return; }
      try {
        const info = await client.users.info({ user: targetId });
        db.upsertUser({ slack_id: targetId, name: info.user.name, real_name: info.user.real_name || info.user.name });
      } catch (e) {
        db.upsertUser({ slack_id: targetId, name: mention, real_name: mention });
      }
      db.setTracked(1, targetId);
      const user = db.getUser(targetId);
      await ack({ response_type: 'ephemeral', text: `✅ *${user.real_name || user.name}* agregado al tracking.` });
      break;
    }

    case 'sacar':
    case 'quitar':
    case 'remove': {
      const targetId = extractUserId(mention);
      if (!targetId) { await ack({ response_type: 'ephemeral', text: '⚠️ Usá: `/admin sacar @usuario`' }); return; }
      db.setTracked(0, targetId);
      const user = db.getUser(targetId);
      await ack({ response_type: 'ephemeral', text: `✅ *${user?.real_name || targetId}* sacado del tracking.` });
      break;
    }

    case 'admin': {
      const targetId = extractUserId(mention);
      if (!targetId) { await ack({ response_type: 'ephemeral', text: '⚠️ Usá: `/admin admin @usuario`' }); return; }
      try {
        const info = await client.users.info({ user: targetId });
        db.upsertUser({ slack_id: targetId, name: info.user.name, real_name: info.user.real_name || info.user.name });
      } catch (e) {}
      db.setAdmin(1, targetId);
      const user = db.getUser(targetId);
      await ack({ response_type: 'ephemeral', text: `✅ *${user?.real_name || targetId}* ahora es admin.` });
      break;
    }

    case 'actividad':
    case 'pings': {
      const s = dayjs().startOf('week').format('YYYY-MM-DD');
      const e = dayjs().format('YYYY-MM-DD');
      await ack({ response_type: 'ephemeral', blocks: blocks.buildPingSummaryReport(db.getPingSummary(s, e), s, e) });
      break;
    }

    case 'presencia':
    case 'presence': {
      const s = dayjs().startOf('week').format('YYYY-MM-DD');
      const e = dayjs().format('YYYY-MM-DD');
      const tracked = db.getTrackedUsers();
      const data = tracked
        .map(u => ({ ...db.getPresenceSummary(u.slack_id, s, e), name: u.name, real_name: u.real_name }))
        .filter(p => p.total_checks > 0);
      await ack({ response_type: 'ephemeral', blocks: blocks.buildPresenceSummaryReport(data, s, e) });
      break;
    }

    default:
      await ack({ response_type: 'ephemeral', text: '❓ Comando no reconocido. Usá `/admin lista`.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ACTIVITY PING RESPONSE (stays in Slack — pings are server-sent)
// ═══════════════════════════════════════════════════════════════════

app.action('ping_respond', async ({ action, body, ack, client }) => {
  const pingId = parseInt(action.value, 10);
  const result = db.respondToPing(pingId);
  await ack();

  const channelId = body.channel?.id || body.user.id;
  if (result) {
    const seconds = Math.round(result.response_ms / 1000);
    await client.chat.postEphemeral({ channel: channelId, user: body.user.id, text: `✅ Respuesta registrada en ${seconds}s. ¡Bien ahí!` });
  } else {
    await client.chat.postEphemeral({ channel: channelId, user: body.user.id, text: '⏱️ Este ping ya expiró o ya fue respondido.' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// EVENTS
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
  db.upsertUser({ slack_id: event.user.id, name: event.user.name, real_name: event.user.real_name || event.user.name });
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
