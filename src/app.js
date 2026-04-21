require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const t = require('./time');
const db = require('./database');
const blocks = require('./blocks');
const txt = require('./texts');
const { setupScheduler } = require('./scheduler');
const { setupDashboard } = require('./dashboard');
const { setupDemo } = require('./demo');
const { setupLeaves, LEAVE_TYPES, buildQuotaSummary, buildRequestModal } = require('./leaves');
const { createToken } = require('./verification');

const EXPECTED_HOURS = parseFloat(process.env.EXPECTED_HOURS_PER_DAY || '8');
const ENTRY_HOUR = parseInt(process.env.WORK_START_HOUR || '9', 10);

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver });

// Global Bolt error handler — surfaces errors that would otherwise be swallowed
app.error(async (error) => {
  console.error('[bolt] ❌ Global error:', error.message);
  if (error.original) console.error('[bolt] Original:', error.original.message);
  if (error.data) console.error('[bolt] Data:', JSON.stringify(error.data, null, 2));
  console.error('[bolt] Stack:', error.stack);
});

const SOLO_MODE = process.env.SOLO_MODE === 'true';
const SOLO_USER_ID = process.env.SOLO_USER_ID || '';
if (SOLO_MODE) {
  console.log(`[solo] Modo solo — ${SOLO_USER_ID}`);
  app.use(async ({ next, body }) => {
    const uid = body?.user_id || body?.user?.id || body?.event?.user;
    if (uid && uid !== SOLO_USER_ID) return;
    await next();
  });
}

const getBaseUrl = () => process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
const extractUserId = (str) => {
  const m = str.match(/<@([A-Z0-9]+)\|?[^>]*>/);
  return m ? m[1] : (/^U[A-Z0-9]+$/.test(str) ? str : null);
};

// Extract both ID and display name from a Slack mention.
// Handles: <@UXXXXX|nombre>, <@UXXXXX>, or a raw Slack ID (UXXXXX)
const extractUserMention = (str = '') => {
  const m = str.match(/<@([A-Z0-9]+)(?:\|([^>]*))?>/);
  if (m) return { id: m[1], name: m[2] || m[1] };
  if (/^U[A-Z0-9]+$/.test(str)) return { id: str, name: str };
  return null;
};

// ─── DM-only guard ────────────────────────────────────────────────
// Slash commands must be used from the DM with the bot, not from channels or group DMs.
const DM_ONLY_MSG = '🔒 Este comando solo funciona en el DM con *Hoopla-Attendance*.\n\nAbrí la app desde la barra lateral de Slack y usá el comando ahí.';
const isDM = (command) => (command.channel_id || '').startsWith('D');

// ─── Track last interaction for auto-close ─────────────────────────
app.use(async ({ next, body }) => {
  try {
    const uid = body?.user_id || body?.user?.id;
    if (uid) {
      db.updateLastSeen(uid, t.today(), t.currentTime());
    }
  } catch (e) { /* ignore tracking errors */ }
  await next();
});

// ═══════════════════════════════════════════════════════════════════
// /marcar
// ═══════════════════════════════════════════════════════════════════

app.command('/marcar', async ({ command, ack, respond }) => {
  await ack();
  if (!isDM(command)) { await respond({ response_type: 'ephemeral', text: DM_ONLY_MSG }); return; }
  const { user_id, user_name } = command;
  db.upsertUser({ slack_id: user_id, name: user_name, real_name: user_name });
  const today = t.today();

  // Field day — direct registration from mobile
  if (db.isFieldDay(user_id, today)) {
    const record = db.getOrCreateRecord(user_id, today);
    const next = blocks.getNextAction(record);
    if (!next) { await respond({ response_type: 'ephemeral', text: txt.asistencia.fieldAlreadyComplete }); return; }
    const time = t.currentTime();
    db.updateField(user_id, today, next, time);
    await respond({ response_type: 'ephemeral', text: txt.asistencia.fieldRegistered(txt.status[next].emoji, txt.status[next].label, time) });
    return;
  }

  // Normal — link + unique PIN
  const { token, pin } = createToken(user_id);
  const url = `${getBaseUrl()}/verify/${token}`;

  await respond({
    response_type: 'ephemeral',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: txt.asistencia.title } },
      { type: 'section', text: { type: 'mrkdwn', text: `${txt.asistencia.linkInstructions}\n\n👉 <${url}|${txt.asistencia.linkLabel}>` } },
      { type: 'section', text: { type: 'mrkdwn', text: txt.asistencia.pinLabel(pin) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: txt.asistencia.expireNote }] },
    ],
  });
});

// ═══════════════════════════════════════════════════════════════════
// /campo
// ═══════════════════════════════════════════════════════════════════

app.command('/campo', async ({ command, ack, respond }) => {
  await ack();
  if (!isDM(command)) { await respond({ response_type: 'ephemeral', text: DM_ONLY_MSG }); return; }
  const { user_id, user_name } = command;
  const reason = command.text.trim() || 'Trabajo de campo';
  const today = t.today();
  db.upsertUser({ slack_id: user_id, name: user_name, real_name: user_name });
  if (db.isFieldDay(user_id, today)) { await respond({ response_type: 'ephemeral', text: txt.campo.alreadyDeclared }); return; }
  db.addOverride(user_id, today, 'field', reason, user_id);
  db.setWorkMode(user_id, today, 'field');
  await respond({ response_type: 'ephemeral', text: txt.campo.confirmed(reason) });
});

// ═══════════════════════════════════════════════════════════════════
// /horarios — Daily status + weekly balance
// ═══════════════════════════════════════════════════════════════════

app.command('/horarios', async ({ command, ack, respond }) => {
  await ack();
  if (!isDM(command)) { await respond({ response_type: 'ephemeral', text: DM_ONLY_MSG }); return; }
  const userId = command.user_id;
  const today = t.today();
  const now = t.now();
  const record = db.getRecord(userId, today);

  // Today's status
  const statusLines = Object.entries(txt.status).map(([f, info]) =>
    `${info.emoji} ${info.label}: ${record?.[f] || txt.estado.pending}`
  );

  let todayStatus = '';
  if (!record || !record.entry_time) {
    todayStatus = txt.estado.noEntry;
  } else if (record.exit_time) {
    todayStatus = txt.estado.dayComplete;
    if (record.total_hours) todayStatus += ` (${record.total_hours}hs)`;
  } else {
    todayStatus = txt.estado.dayInProgress;
  }

  // Lateness check
  let lateMsg = '';
  if (record?.entry_time) {
    const entryMinutes = parseInt(record.entry_time.split(':')[0]) * 60 + parseInt(record.entry_time.split(':')[1]);
    const expectedMinutes = ENTRY_HOUR * 60;
    if (entryMinutes > expectedMinutes + 5) { // 5 min grace
      lateMsg = txt.estado.late(entryMinutes - expectedMinutes);
    }
  }

  // Weekly balance
  const weekStart = t.weekStart();
  const weekRecords = db.getUserWeeklyRecords(userId, weekStart, today);
  const workedHours = weekRecords.reduce((s, r) => s + (r.total_hours || 0), 0);
  const workedRounded = Math.round(workedHours * 100) / 100;

  // Count workdays elapsed (Mon through today, minus holidays/overrides)
  const daysElapsed = db.countWorkdaysInRange(weekStart, today);
  const expectedHours = Math.round(daysElapsed * EXPECTED_HOURS * 100) / 100;
  const diff = Math.round((workedRounded - expectedHours) * 100) / 100;

  let balanceMsg = txt.estado.weeklyBalance(workedRounded, expectedHours, diff);

  let adviceMsg = '';
  if (diff >= 0) {
    adviceMsg = diff > 0 ? txt.estado.ahead(diff) : txt.estado.onTrack;
  } else {
    const missing = Math.abs(diff);
    // If today is still in progress, suggest exit time
    if (record?.entry_time && !record?.exit_time) {
      const hoursLeftToday = missing;
      const suggestedExit = now.add(hoursLeftToday, 'hour');
      if (suggestedExit.hour() < 22) {
        adviceMsg = txt.estado.behind(missing, suggestedExit.format('HH:mm'));
      } else {
        adviceMsg = txt.estado.behindGeneral(missing);
      }
    } else {
      adviceMsg = txt.estado.behindGeneral(missing);
    }
  }

  // Active meeting?
  const meeting = db.getActiveMeeting(userId, today);
  let meetingMsg = '';
  if (meeting) {
    meetingMsg = `\n📍 En reunión desde las ${meeting.start_time}${meeting.reason ? ` (${meeting.reason})` : ''}`;
  }

  await respond({
    response_type: 'ephemeral',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `📊 Tu estado — ${t.now().format('DD/MM/YYYY')}` } },
      { type: 'section', text: { type: 'mrkdwn', text: statusLines.join('\n') + `\n\n${todayStatus}` + (lateMsg ? `\n${lateMsg}` : '') + meetingMsg } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: balanceMsg } },
      { type: 'section', text: { type: 'mrkdwn', text: adviceMsg } },
    ],
  });
});

// ═══════════════════════════════════════════════════════════════════
// /reunion — Start/end meetings
// ═══════════════════════════════════════════════════════════════════

app.command('/reunion', async ({ command, ack, respond }) => {
  await ack();
  if (!isDM(command)) { await respond({ response_type: 'ephemeral', text: DM_ONLY_MSG }); return; }
  const userId = command.user_id;
  const today = t.today();
  const now = t.currentTime();
  const args = command.text.trim();

  db.upsertUser({ slack_id: userId, name: command.user_name, real_name: command.user_name });

  if (args.toLowerCase() === 'fin' || args.toLowerCase() === 'end') {
    const active = db.getActiveMeeting(userId, today);
    if (!active) { await respond({ response_type: 'ephemeral', text: txt.meetings.noActive }); return; }
    const ended = db.endMeeting(active.id, now);
    await respond({ response_type: 'ephemeral', text: txt.meetings.ended(now, ended.duration_min) });
  } else {
    const active = db.getActiveMeeting(userId, today);
    if (active) { await respond({ response_type: 'ephemeral', text: txt.meetings.alreadyInMeeting }); return; }
    const reason = args || 'Reunión';
    db.startMeeting(userId, today, now, reason);
    await respond({ response_type: 'ephemeral', text: txt.meetings.started(reason, now) });
  }
});

// ═══════════════════════════════════════════════════════════════════
// /reporte
// ═══════════════════════════════════════════════════════════════════

app.command('/reporte', async ({ command, ack, respond }) => {
  await ack();
  if (!isDM(command)) { await respond({ response_type: 'ephemeral', text: DM_ONLY_MSG }); return; }
  const args = command.text.trim().toLowerCase();
  const s = args === 'mensual' || args === 'mes' ? t.monthStart() : t.weekStart();
  await respond({ response_type: 'ephemeral', blocks: blocks.buildWeeklyReport(db.getWeeklySummary(s, t.today()), s, t.today()) });
});

// ═══════════════════════════════════════════════════════════════════
// /admin
// ═══════════════════════════════════════════════════════════════════

app.command('/admin', async ({ command, ack, respond, client }) => {
  await ack();
  const userId = command.user_id;
  if (!db.isAdmin(userId)) { await respond({ response_type: 'ephemeral', text: txt.errors.noPermission }); return; }

  const parts = command.text.trim().split(/\s+/);
  const action = parts[0]?.toLowerCase();

  try {
    switch (action) {
      case 'lista': case 'list': case undefined: case '': {
        const all = db.getAllUsers(), tracked = db.getTrackedUsers();
        await respond({ response_type: 'ephemeral', blocks: blocks.buildAdminMenu(all, tracked.map(u => u.slack_id)) });
        break;
      }
      case 'agregar': case 'add': {
        await client.views.open({
          trigger_id: command.trigger_id,
          view: {
            type: 'modal',
            callback_id: 'modal_admin_agregar',
            title: { type: 'plain_text', text: 'Agregar usuario' },
            submit: { type: 'plain_text', text: 'Agregar' },
            close: { type: 'plain_text', text: 'Cancelar' },
            blocks: [
              {
                type: 'input',
                block_id: 'blk_user',
                label: { type: 'plain_text', text: '¿A quién agregás al seguimiento de asistencia?' },
                element: {
                  type: 'users_select',
                  action_id: 'sel_user',
                  placeholder: { type: 'plain_text', text: 'Elegí un usuario' },
                },
              },
            ],
          },
        });
        break;
      }
      case 'sacar': case 'quitar': case 'remove': {
        await client.views.open({
          trigger_id: command.trigger_id,
          view: {
            type: 'modal',
            callback_id: 'modal_admin_sacar',
            title: { type: 'plain_text', text: 'Quitar usuario' },
            submit: { type: 'plain_text', text: 'Quitar' },
            close: { type: 'plain_text', text: 'Cancelar' },
            blocks: [
              {
                type: 'input',
                block_id: 'blk_user',
                label: { type: 'plain_text', text: '¿A quién sacás del seguimiento de asistencia?' },
                element: {
                  type: 'users_select',
                  action_id: 'sel_user',
                  placeholder: { type: 'plain_text', text: 'Elegí un usuario' },
                },
              },
            ],
          },
        });
        break;
      }
      case 'admin': {
        const envAdmins = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!envAdmins.includes(userId)) { await respond({ response_type: 'ephemeral', text: txt.errors.superOnly }); return; }
        const mention2 = extractUserMention(parts[1] || '');
        if (!mention2) { await respond({ response_type: 'ephemeral', text: '⚠️ Uso: `/admin admin @usuario`' }); return; }
        db.upsertUser({ slack_id: mention2.id, name: mention2.name, real_name: mention2.name });
        db.setAdmin(1, mention2.id);
        await respond({ response_type: 'ephemeral', text: `✅ *${mention2.name}* ahora es admin.` });
        break;
      }
      case 'feriado': {
        const date = parts[1], reason = parts.slice(2).join(' ') || 'Feriado';
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { await respond({ response_type: 'ephemeral', text: '⚠️ Uso: `/admin feriado YYYY-MM-DD Motivo`' }); return; }
        db.addOverride(null, date, 'holiday', reason, userId);
        await respond({ response_type: 'ephemeral', text: `🏖️ Feriado: *${date}* — ${reason}` });
        break;
      }
      case 'vacaciones': {
        const tid = extractUserId(parts[1] || ''), from = parts[2], to = parts[3] || parts[2];
        if (!tid || !from) { await respond({ response_type: 'ephemeral', text: '⚠️ Uso: `/admin vacaciones @user YYYY-MM-DD YYYY-MM-DD`' }); return; }
        let d = t.dayjs(from); const end = t.dayjs(to); let count = 0;
        while (d.isBefore(end) || d.isSame(end, 'day')) { if (d.day() !== 0 && d.day() !== 6) { db.addOverride(tid, d.format('YYYY-MM-DD'), 'vacation', 'Vacaciones', userId); count++; } d = d.add(1, 'day'); }
        await respond({ response_type: 'ephemeral', text: `✈️ Vacaciones: *${db.getUser(tid)?.real_name || tid}* — ${count} días (${from} a ${to})` });
        break;
      }
      case 'medico': {
        const tid = extractUserId(parts[1] || ''), date = parts[2], reason = parts.slice(3).join(' ') || 'Turno médico';
        if (!tid || !date) { await respond({ response_type: 'ephemeral', text: '⚠️ Uso: `/admin medico @user YYYY-MM-DD Motivo`' }); return; }
        db.addOverride(tid, date, 'medical', reason, userId);
        await respond({ response_type: 'ephemeral', text: `🏥 Médico: *${db.getUser(tid)?.real_name || tid}* — ${date} — ${reason}` });
        break;
      }
      case 'ausente': {
        const tid = extractUserId(parts[1] || ''), date = parts[2] || t.today(), reason = parts.slice(3).join(' ') || 'Ausencia';
        if (!tid) { await respond({ response_type: 'ephemeral', text: '⚠️ Uso: `/admin ausente @user YYYY-MM-DD Motivo`' }); return; }
        db.addOverride(tid, date, 'absent', reason, userId);
        await respond({ response_type: 'ephemeral', text: `❌ Ausente: *${db.getUser(tid)?.real_name || tid}* — ${date}` });
        break;
      }
      case 'libre': {
        const tid = extractUserId(parts[1] || ''), date = parts[2] || t.today(), reason = parts.slice(3).join(' ') || 'Día libre';
        if (!tid) { await respond({ response_type: 'ephemeral', text: '⚠️ Uso: `/admin libre @user YYYY-MM-DD`' }); return; }
        db.addOverride(tid, date, 'day_off', reason, userId);
        await respond({ response_type: 'ephemeral', text: `📅 Libre: *${db.getUser(tid)?.real_name || tid}* — ${date}` });
        break;
      }
      case 'salida': {
        const tid = extractUserId(parts[1] || ''), date = parts[2] || t.today(), reason = parts.slice(3).join(' ') || 'Salida temprana';
        if (!tid) { await respond({ response_type: 'ephemeral', text: '⚠️ Uso: `/admin salida @user YYYY-MM-DD Motivo`' }); return; }
        db.addOverride(tid, date, 'early_exit', reason, userId);
        await respond({ response_type: 'ephemeral', text: `🕐 Salida temprana: *${db.getUser(tid)?.real_name || tid}* — ${date}` });
        break;
      }
      case 'novedades': {
        const date = parts[1] || t.today();
        const ov = db.getOverridesForDate(date);
        if (!ov.length) { await respond({ response_type: 'ephemeral', text: `Sin novedades para ${date}.` }); return; }
        const lines = ov.map(o => `• ${txt.overrides[o.type] || o.type}: ${o.real_name || o.name || 'Todos'}${o.reason ? ` — ${o.reason}` : ''}`).join('\n');
        await respond({ response_type: 'ephemeral', text: `📋 *Novedades ${date}:*\n${lines}` });
        break;
      }
      case 'ausencias': {
        const pending = db.getPendingLeaveRequests();
        if (!pending.length) {
          await respond({ response_type: 'ephemeral', text: '✅ No hay solicitudes de ausencia pendientes.' });
          return;
        }
        const lines = pending.map(r => {
          const ti = LEAVE_TYPES[r.type] || { emoji: '📋', label: r.type };
          const name = r.real_name || r.name || r.slack_id;
          const from = r.date_from === r.date_to ? r.date_from : `${r.date_from} → ${r.date_to}`;
          return `• *${name}* — ${ti.emoji} ${ti.label} | ${from}${r.notes ? ` | _${r.notes}_` : ''} | #${r.id}`;
        }).join('\n');
        await respond({ response_type: 'ephemeral', text: `📋 *Solicitudes pendientes (${pending.length}):*\n\n${lines}\n\nRevisalas desde el DM que te mandó la app o en /dashboard/ausencias` });
        break;
      }
      case 'feriados': {
        const year = parts[1] || String(new Date().getFullYear());
        const holidays = db.getHolidays(year);
        if (!holidays.length) {
          await respond({ response_type: 'ephemeral', text: `📅 No hay feriados cargados para ${year}.` });
          return;
        }
        const lines = holidays.map(h => `• \`${h.date}\` — ${h.reason || 'Feriado'}`).join('\n');
        await respond({ response_type: 'ephemeral', text: `🗓️ *Feriados ${year}* (${holidays.length} días):\n\n${lines}` });
        break;
      }
      case 'estudiante': {
        // /admin estudiante @usuario on|off
        // Grants or revokes exam-day eligibility
        const targetRaw = parts[1] || '';
        const flag      = (parts[2] || '').toLowerCase();
        if (!targetRaw || !['on','off'].includes(flag)) {
          await respond({ response_type: 'ephemeral', text: '⚠️ Uso: `/admin estudiante @usuario on` o `off`\n\nActiva o desactiva los días de examen para el usuario.' });
          return;
        }
        const mention = extractUserMention(targetRaw);
        if (!mention) {
          await respond({ response_type: 'ephemeral', text: '⚠️ No pude identificar el usuario. Asegurate de mencionarlo con @.' });
          return;
        }
        // Ensure user exists
        const targetUser = db.getUser(mention.id);
        if (!targetUser) {
          await respond({ response_type: 'ephemeral', text: `⚠️ Usuario \`${mention.id}\` no encontrado en la base de datos.` });
          return;
        }
        db.setStudentFlag(mention.id, flag === 'on');
        const name = targetUser.real_name || targetUser.name || mention.id;
        const statusEmoji = flag === 'on' ? '🎓' : '📵';
        await respond({ response_type: 'ephemeral', text: `${statusEmoji} *${name}* — días de examen: *${flag === 'on' ? 'activados' : 'desactivados'}*.` });
        break;
      }
      case 'dashboard': case 'hoy': {
        // Snapshot of today: present, missing, on leave
        const today = t.today();
        const now   = t.now();
        const dayName = now.format('dddd DD/MM/YYYY');

        const tracked    = db.getTrackedUsers();
        const records    = db.getRecordsByDateRange(today, today);
        const overrides  = db.getOverridesForDate(today);

        const presentIds = new Set(records.filter(r => r.entry_time).map(r => r.slack_id));
        const leaveIds   = new Set(overrides.filter(o => o.slack_id).map(o => o.slack_id));
        const isHoliday  = db.isHoliday(today);

        const present  = tracked.filter(u => presentIds.has(u.slack_id));
        const onLeave  = tracked.filter(u => !presentIds.has(u.slack_id) && leaveIds.has(u.slack_id));
        const missing  = tracked.filter(u => !presentIds.has(u.slack_id) && !leaveIds.has(u.slack_id));

        const displayName = (u) => u.real_name || u.name || u.slack_id;

        // Build present list with status
        const presentLines = present.map(u => {
          const r = records.find(r => r.slack_id === u.slack_id);
          const parts = [];
          if (r?.entry_time)  parts.push(`entrada ${r.entry_time}`);
          if (r?.lunch_start && !r?.lunch_end) parts.push('en almuerzo');
          if (r?.exit_time)   parts.push(`salida ${r.exit_time}`);
          const mode = r?.location === 'agencia' ? '🏢' : r?.location === 'home_office' ? '🏠' : r?.work_mode === 'field' ? '🚗' : '';
          return `  ${mode} *${displayName(u)}* — ${parts.join(' · ') || '—'}`;
        }).join('\n') || '  _Nadie por ahora_';

        // Build on-leave list
        const leaveLines = onLeave.map(u => {
          const ov = overrides.find(o => o.slack_id === u.slack_id);
          const typeLabels = { vacation: '🏖️ Vacaciones', medical: '🏥 Médico', day_off: '📅 Día libre', absent: '💙 Ausencia', early_exit: '🌇 Salida anticipada', field: '🚗 Campo' };
          return `  *${displayName(u)}* — ${typeLabels[ov?.type] || ov?.type || '?'}${ov?.reason ? ` _(${ov.reason})_` : ''}`;
        }).join('\n') || '  _Nadie_';

        const missingLines = missing.map(u => `  *${displayName(u)}*`).join('\n') || '  ✅ Todos ficharon';

        // Averages
        const completedToday = records.filter(r => r.total_hours > 0);
        const avgHours = completedToday.length
          ? (completedToday.reduce((s, r) => s + r.total_hours, 0) / completedToday.length).toFixed(1)
          : '—';

        const dashBlocks = [
          { type: 'header', text: { type: 'plain_text', text: `📋 Dashboard — ${dayName}` } },
          ...(isHoliday ? [{ type: 'section', text: { type: 'mrkdwn', text: '🏖️ *Hoy es feriado*' } }] : []),
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*✅ Presentes*\n${present.length}` },
              { type: 'mrkdwn', text: `*⚠️ Sin fichar*\n${missing.length}` },
              { type: 'mrkdwn', text: `*📅 Con novedad*\n${onLeave.length}` },
              { type: 'mrkdwn', text: `*⏱️ Prom. horas*\n${avgHours}hs` },
            ],
          },
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: `✅ *Presentes (${present.length})*\n${presentLines}` } },
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Sin fichar (${missing.length})*\n${missingLines}` } },
        ];

        if (onLeave.length > 0) {
          dashBlocks.push({ type: 'divider' });
          dashBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `📅 *Con novedad (${onLeave.length})*\n${leaveLines}` } });
        }

        dashBlocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_Actualizado: ${now.format('HH:mm')} · Solo vos ves esto_` }],
        });

        await respond({ response_type: 'ephemeral', blocks: dashBlocks });
        break;
      }
      case 'balance': {
        // /admin balance @usuario  — show quota summary for a user
        const targetRaw = parts[1] || '';
        if (!targetRaw) {
          await respond({ response_type: 'ephemeral', text: '⚠️ Uso: `/admin balance @usuario`' });
          return;
        }
        const mention = extractUserMention(targetRaw);
        if (!mention) {
          await respond({ response_type: 'ephemeral', text: '⚠️ No pude identificar el usuario.' });
          return;
        }
        const targetUser = db.getUser(mention.id);
        if (!targetUser) {
          await respond({ response_type: 'ephemeral', text: `⚠️ Usuario \`${mention.id}\` no encontrado.` });
          return;
        }
        await respond({ response_type: 'ephemeral', text: buildQuotaSummary(mention.id) });
        break;
      }
      case 'actividad': case 'pings': {
        const s = t.weekStart(), e = t.today();
        await respond({ response_type: 'ephemeral', blocks: blocks.buildPingSummaryReport(db.getPingSummary(s, e), s, e) });
        break;
      }
      case 'presencia': case 'presence': {
        const s = t.weekStart(), e = t.today();
        const data = db.getTrackedUsers().map(u => ({ ...db.getPresenceSummary(u.slack_id, s, e), name: u.name, real_name: u.real_name })).filter(p => p.total_checks > 0);
        await respond({ response_type: 'ephemeral', blocks: blocks.buildPresenceSummaryReport(data, s, e) });
        break;
      }
      default:
        await respond({ response_type: 'ephemeral', text: txt.errors.unknownCommand });
    }
  } catch (err) {
    console.error('[admin] Error:', err.message);
    try { await respond({ response_type: 'ephemeral', text: `❌ Error: ${err.message}` }); } catch(e) {}
  }
});

// ═══════════════════════════════════════════════════════════════════
// PING RESPONSE
// ═══════════════════════════════════════════════════════════════════

app.action('ping_respond', async ({ action, body, ack, client }) => {
  // Ack FIRST — must respond within 3s even if DB is slow
  try { await ack(); }
  catch(e) { console.error('[action] ping_respond — ack failed:', e.message); return; }
  try {
    const result = db.respondToPing(parseInt(action.value, 10));
    const ch = body.channel?.id || body.user.id;
    const text = result ? txt.pings.responded(Math.round(result.response_ms / 1000)) : txt.pings.expired;
    await client.chat.postEphemeral({ channel: ch, user: body.user.id, text });
  } catch (e) { console.error('[action] ping_respond — handler error:', e.message); }
});

// ═══════════════════════════════════════════════════════════════════
// QUICK-ACTION BUTTONS (entry / lunch / exit reminders)
// ═══════════════════════════════════════════════════════════════════

// Helper: send the verification link to the user's DM
const sendVerifyLink = async (client, userId) => {
  const { token, pin } = createToken(userId);
  const url = `${getBaseUrl()}/verify/${token}`;
  await client.chat.postMessage({
    channel: userId,
    text: `👉 Tu link para registrar: ${url}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `👉 *Abrí el link para registrar:*\n<${url}|Registrar asistencia>` } },
      { type: 'section', text: { type: 'mrkdwn', text: txt.asistencia.pinLabel(pin) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: txt.asistencia.expireNote }] },
    ],
  });
};

app.action('quick_entry', async ({ body, ack, client }) => {
  console.log(`[action] quick_entry — user=${body.user?.id}`);
  try {
    await ack();
    console.log('[action] quick_entry — ack sent');
  } catch (e) {
    console.error('[action] quick_entry — ack failed:', e.message);
    return;
  }
  try {
    const userId = body.user.id;
    const today = t.today();
    db.upsertUser({ slack_id: userId, name: body.user.name, real_name: body.user.name });

    if (db.isFieldDay(userId, today)) {
      const record = db.getOrCreateRecord(userId, today);
      const next = blocks.getNextAction(record);
      if (!next) {
        await client.chat.postMessage({ channel: userId, text: txt.asistencia.fieldAlreadyComplete });
      } else {
        const time = t.currentTime();
        db.updateField(userId, today, next, time);
        await client.chat.postMessage({ channel: userId, text: txt.asistencia.fieldRegistered(txt.status[next].emoji, txt.status[next].label, time) });
      }
    } else {
      await sendVerifyLink(client, userId);
    }
    await publishHome(client, userId);
  } catch (e) {
    console.error('[action] quick_entry — handler error:', e.message, e.stack);
  }
});

app.action('quick_lunch', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  db.upsertUser({ slack_id: userId, name: body.user.name, real_name: body.user.name });
  await sendVerifyLink(client, userId);
  await publishHome(client, userId);
});

app.action('quick_skip_lunch', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const today = t.today();
  const record = db.getRecord(userId, today);
  if (!record?.entry_time) {
    await client.chat.postMessage({ channel: userId, text: '⚠️ No tenés entrada registrada hoy.' });
  } else if (record.lunch_start) {
    await client.chat.postMessage({ channel: userId, text: '✅ El almuerzo ya está registrado.' });
  } else {
    db.fillMissingLunch(userId, today, record);
    await client.chat.postMessage({ channel: userId, text: '✅ Almuerzo omitido — registrado automáticamente como 13:00–14:00.' });
  }
  await publishHome(client, userId);
});

app.action('quick_exit', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const today = t.today();
  db.upsertUser({ slack_id: userId, name: body.user.name, real_name: body.user.name });

  if (db.isFieldDay(userId, today)) {
    const record = db.getRecord(userId, today);
    if (record?.exit_time) {
      await client.chat.postMessage({ channel: userId, text: '✅ Tu salida ya está registrada.' });
    } else {
      const time = t.currentTime();
      if (record) db.fillMissingLunch(userId, today, record);
      db.updateField(userId, today, 'exit_time', time);
      await client.chat.postMessage({ channel: userId, text: txt.asistencia.fieldRegistered('🔴', 'Salida', time) });
    }
  } else {
    await sendVerifyLink(client, userId);
  }
  await publishHome(client, userId);
});

// ═══════════════════════════════════════════════════════════════════
// MODAL: agregar usuario
// ═══════════════════════════════════════════════════════════════════

app.view('modal_admin_sacar', async ({ view, ack, body, client }) => {
  await ack();
  const adminId = body.user.id;
  if (!db.isAdmin(adminId)) return;
  const targetId = view.state.values.blk_user.sel_user.selected_user;
  if (!targetId) return;
  db.setTracked(0, targetId);
  const stored = db.getUser(targetId);
  const name = (stored?.real_name && stored.real_name !== targetId) ? stored.real_name : `<@${targetId}>`;
  await client.chat.postMessage({ channel: adminId, text: `✅ *${name}* sacado del seguimiento de asistencia.` });
});

app.view('modal_admin_agregar', async ({ view, ack, body, client }) => {
  await ack();
  const adminId = body.user.id;
  if (!db.isAdmin(adminId)) return;
  const targetId = view.state.values.blk_user.sel_user.selected_user;
  if (!targetId) return;

  // Try to resolve real name — ack() is already called so no 3s timeout risk
  let realName = targetId;
  let userName = targetId;
  try {
    const info = await client.users.info({ user: targetId });
    realName = info.user.real_name || info.user.profile?.real_name || info.user.name || targetId;
    userName = info.user.name || targetId;
  } catch(e) {
    // No users:read scope — name will update on first /marcar by that user
    console.log(`[admin] Sin scope users:read, guardando ${targetId} como nombre temporal`);
  }

  // Only overwrite if we have a real name (don't stomp an existing name with the ID)
  const existing = db.getUser(targetId);
  if (!existing || realName !== targetId) {
    db.upsertUser({ slack_id: targetId, name: userName, real_name: realName });
  }
  db.setTracked(1, targetId);

  const display = realName !== targetId ? realName : `<@${targetId}>`;
  await client.chat.postMessage({ channel: adminId, text: `✅ *${display}* agregado al seguimiento de asistencia.` });
});

// ═══════════════════════════════════════════════════════════════════
// AYUDA
// ═══════════════════════════════════════════════════════════════════

app.command('/ayuda', async ({ command, ack, respond }) => {
  await ack();
  if (!isDM(command)) { await respond({ response_type: 'ephemeral', text: DM_ONLY_MSG }); return; }
  await respond({
    response_type: 'ephemeral',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '⚡ Hoopla Asistencia — Comandos' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*🙋 Ausencias y licencias*' } },
      { type: 'section', text: { type: 'mrkdwn', text: '`/pedir` — Solicitá vacaciones, día libre, examen, medio día, médico u otra ausencia. La solicitud queda pendiente hasta que un admin la apruebe o rechace.' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*📋 Registro diario*' } },
      { type: 'section', text: { type: 'mrkdwn', text: '`/marcar` — Registrá tu entrada, almuerzo o salida del día. Te manda un link con PIN para confirmar desde la compu.' } },
      { type: 'section', text: { type: 'mrkdwn', text: '`/campo` — Declarar que hoy trabajás fuera de la oficina. Con esto podés usar `/marcar` directo desde el celu.' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*📊 Tu información*' } },
      { type: 'section', text: { type: 'mrkdwn', text: '`/horarios` — Mirá tu estado de hoy y tu balance de horas de la semana.' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*📅 Reuniones*' } },
      { type: 'section', text: { type: 'mrkdwn', text: '`/reunion inicio [motivo]` — Avisá que entraste a una reunión.\n`/reunion fin` — Cerrá la reunión cuando termines.' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*📈 Reportes (admin)*' } },
      { type: 'section', text: { type: 'mrkdwn', text: '`/reporte semanal` — Resumen de horas de la semana.\n`/reporte mensual` — Resumen del mes.' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*👥 Gestión de usuarios (admin)*' } },
      { type: 'section', text: { type: 'mrkdwn', text: '`/admin dashboard` — Estado del día en tiempo real (presentes, faltantes, novedades).\n`/admin balance @usuario` — Balance de ausencias de un empleado.\n`/admin lista` — Ver todos los usuarios.\n`/admin agregar @usuario` — Sumá a alguien al seguimiento.\n`/admin sacar @usuario` — Quitá a alguien del seguimiento.\n`/admin ausencias` — Ver solicitudes de ausencia pendientes.\n`/admin feriados [año]` — Ver los feriados cargados.\n`/admin estudiante @usuario on|off` — Activar días de examen.' } },
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Solo vos ves este mensaje_ · ⚡ Hoopla Asistencia' }] },
    ],
  });
});

// ═══════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════

// ─── Build the interactive Home tab view ──────────────────────────
const buildHomeBlocks = (userId) => {
  const today = t.today();
  const now   = t.now();
  const record = db.getRecord(userId, today);
  const nextAction = blocks.getNextAction(record);
  const isField = db.isFieldDay(userId, today);
  const isExempt = db.isUserExemptToday(userId, today);
  const isHol = db.isHoliday(today);

  const dayLabel = now.format('dddd DD [de] MMMM');

  // Status lines
  const STATUS_FIELDS = [
    { key: 'entry_time',  emoji: '🟢', label: 'Entrada'         },
    { key: 'lunch_start', emoji: '🍽️', label: 'Inicio almuerzo' },
    { key: 'lunch_end',   emoji: '🔄', label: 'Fin almuerzo'    },
    { key: 'exit_time',   emoji: '🔴', label: 'Salida'          },
  ];
  const statusText = STATUS_FIELDS
    .map(f => `${f.emoji} ${f.label}: *${record?.[f.key] || '—'}*`)
    .join('\n');

  // Action button label
  const ACTION_LABELS = {
    entry_time:  '🟢  Registrar entrada',
    lunch_start: '🍽️  Inicio de almuerzo',
    lunch_end:   '🔄  Fin de almuerzo',
    exit_time:   '🔴  Registrar salida',
  };

  // Weekly balance
  const weekStart = t.weekStart();
  const weekRecords = db.getUserWeeklyRecords(userId, weekStart, today);
  const workedHours = Math.round(weekRecords.reduce((s, r) => s + (r.total_hours || 0), 0) * 10) / 10;
  const daysElapsed = db.countWorkdaysInRange(weekStart, today);
  const expectedHours = Math.round(daysElapsed * EXPECTED_HOURS * 10) / 10;
  const diff = Math.round((workedHours - expectedHours) * 10) / 10;
  const balanceIcon = diff >= 0 ? '🟢' : Math.abs(diff) > 2 ? '🔴' : '🟡';

  // Upcoming approved leaves
  const allLeaves = db.getUserLeaveRequests(userId, 20);
  const upcoming = allLeaves.filter(r => r.status === 'approved' && r.date_to >= today);
  const pending  = allLeaves.filter(r => r.status === 'pending');

  const homeBlocks = [
    { type: 'header', text: { type: 'plain_text', text: `⚡ Hoopla Asistencia` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `📅 ${dayLabel}` }] },
    { type: 'divider' },
  ];

  // ── Today's status ─────────────────────────────────────────────
  if (isHol) {
    homeBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: '🏖️ *Hoy es feriado* — ¡disfrutalo!' } });
  } else if (isExempt) {
    homeBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: '📅 *Hoy tenés una novedad registrada* (ausencia, vacaciones, etc.)' } });
  } else {
    homeBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*📋 Tu estado hoy*\n${statusText}` } });
    if (isField) {
      homeBlocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '🚗 _Día de campo — podés registrar directo sin link_' }] });
    }

    if (nextAction) {
      homeBlocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: ACTION_LABELS[nextAction] },
          style: 'primary',
          action_id: 'home_mark_attendance',
          value: nextAction,
        }],
      });
    } else {
      homeBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: '✅ *Jornada completa registrada*' } });
    }
  }

  // ── Weekly balance ─────────────────────────────────────────────
  homeBlocks.push(
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*📊 Balance semanal*\nTrabajadas: *${workedHours}hs* · Esperadas: *${expectedHours}hs*\n${balanceIcon} Diferencia: *${diff > 0 ? '+' : ''}${diff}hs*` },
    },
  );

  // ── Leave requests ─────────────────────────────────────────────
  homeBlocks.push(
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '*📝 Ausencias*' } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '📝  Pedir ausencia o vacaciones' },
        action_id: 'home_request_leave',
      }],
    },
  );

  if (pending.length > 0) {
    const lines = pending.map(r => {
      const ti = LEAVE_TYPES[r.type] || { emoji: '📋', label: r.type };
      return `• ${ti.emoji} ${ti.label}: ${r.date_from === r.date_to ? r.date_from : `${r.date_from} → ${r.date_to}`} ⏳ _pendiente_`;
    }).join('\n');
    homeBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines } });
  }

  if (upcoming.length > 0) {
    const lines = upcoming.map(r => {
      const ti = LEAVE_TYPES[r.type] || { emoji: '📋', label: r.type };
      return `• ${ti.emoji} ${ti.label}: ${r.date_from === r.date_to ? r.date_from : `${r.date_from} → ${r.date_to}`} ✅`;
    }).join('\n');
    homeBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Próximas ausencias aprobadas:*\n${lines}` } });
  }

  if (pending.length === 0 && upcoming.length === 0) {
    homeBlocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Sin solicitudes pendientes ni ausencias próximas_' }] });
  }

  homeBlocks.push(
    { type: 'divider' },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `_Actualizado: ${now.format('HH:mm')} · Esta pantalla se refresca sola cada vez que la abrís_` }] },
  );

  return homeBlocks;
};

const publishHome = async (client, userId) => {
  try {
    const homeBlocks = buildHomeBlocks(userId);
    console.log(`[home] Building home for ${userId} — ${homeBlocks.length} blocks`);
    const result = await client.views.publish({
      user_id: userId,
      view: { type: 'home', blocks: homeBlocks },
    });
    console.log(`[home] ✅ Published for ${userId} — ok=${result.ok}`);
  } catch(e) {
    console.error(`[home] ❌ Error publishing for ${userId}:`, e.message);
    console.error('[home] Stack:', e.stack);
    if (e.data) console.error('[home] Slack response:', JSON.stringify(e.data, null, 2));
  }
};

app.event('app_home_opened', async ({ event, client }) => {
  console.log(`[home] app_home_opened — user=${event.user} tab=${event.tab}`);
  if (event.tab !== 'home') return;
  db.upsertUser({ slack_id: event.user, name: event.user, real_name: event.user });
  await publishHome(client, event.user);
});

// ── Action: mark attendance from Home ────────────────────────────
app.action('home_mark_attendance', async ({ body, ack, client }) => {
  console.log(`[action] home_mark_attendance — user=${body.user?.id}`);
  try { await ack(); console.log('[action] home_mark_attendance — ack sent'); }
  catch (e) { console.error('[action] home_mark_attendance — ack failed:', e.message); return; }

  try {
    const userId = body.user.id;
    const today  = t.today();
    db.upsertUser({ slack_id: userId, name: body.user.name, real_name: body.user.name });

    if (db.isFieldDay(userId, today)) {
      const record = db.getOrCreateRecord(userId, today);
      const next = blocks.getNextAction(record);
      if (next) {
        const time = t.currentTime();
        db.updateField(userId, today, next, time);
        await client.chat.postMessage({
          channel: userId,
          text: txt.asistencia.fieldRegistered(txt.status[next].emoji, txt.status[next].label, time),
        });
      }
    } else {
      await sendVerifyLink(client, userId);
    }

    // Refresh home
    await publishHome(client, userId);
  } catch (e) {
    console.error('[action] home_mark_attendance — handler error:', e.message, e.stack);
  }
});

// ── Action: request leave from Home ─────────────────────────────
app.action('home_request_leave', async ({ body, ack, client }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildRequestModal() });
  } catch(e) { console.error('[home] Error opening leave modal:', e.message); }
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
  setupLeaves(app);
  setupDemo(app);
  await app.start(PORT);
  console.log(`\n  ⚡ Hoopla Asistencia running — port ${PORT}\n  → Dashboard: http://localhost:${PORT}/dashboard`);
  if (SOLO_MODE) console.log(`  → Solo mode: ON (${SOLO_USER_ID})`);
  console.log('');
})();
