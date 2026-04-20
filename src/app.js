require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const t = require('./time');
const db = require('./database');
const blocks = require('./blocks');
const txt = require('./texts');
const { setupScheduler } = require('./scheduler');
const { setupDashboard } = require('./dashboard');
const { setupDemo } = require('./demo');
const { setupLeaves, LEAVE_TYPES } = require('./leaves');
const { createToken } = require('./verification');

const EXPECTED_HOURS = parseFloat(process.env.EXPECTED_HOURS_PER_DAY || '8');
const ENTRY_HOUR = parseInt(process.env.WORK_START_HOUR || '9', 10);

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver });

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

app.command('/marcar', async ({ command, ack }) => {
  const { user_id, user_name } = command;
  db.upsertUser({ slack_id: user_id, name: user_name, real_name: user_name });
  const today = t.today();

  // Field day — direct registration from mobile
  if (db.isFieldDay(user_id, today)) {
    const record = db.getOrCreateRecord(user_id, today);
    const next = blocks.getNextAction(record);
    if (!next) { await ack({ response_type: 'ephemeral', text: txt.asistencia.fieldAlreadyComplete }); return; }
    const time = t.currentTime();
    db.updateField(user_id, today, next, time);
    await ack({ response_type: 'ephemeral', text: txt.asistencia.fieldRegistered(txt.status[next].emoji, txt.status[next].label, time) });
    return;
  }

  // Normal — link + unique PIN
  const { token, pin } = createToken(user_id);
  const url = `${getBaseUrl()}/verify/${token}`;

  await ack({
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

app.command('/campo', async ({ command, ack }) => {
  const { user_id, user_name } = command;
  const reason = command.text.trim() || 'Trabajo de campo';
  const today = t.today();
  db.upsertUser({ slack_id: user_id, name: user_name, real_name: user_name });
  if (db.isFieldDay(user_id, today)) { await ack({ response_type: 'ephemeral', text: txt.campo.alreadyDeclared }); return; }
  db.addOverride(user_id, today, 'field', reason, user_id);
  db.setWorkMode(user_id, today, 'field');
  await ack({ response_type: 'ephemeral', text: txt.campo.confirmed(reason) });
});

// ═══════════════════════════════════════════════════════════════════
// /horarios — Daily status + weekly balance
// ═══════════════════════════════════════════════════════════════════

app.command('/horarios', async ({ command, ack }) => {
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

  await ack({
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

app.command('/reunion', async ({ command, ack }) => {
  const userId = command.user_id;
  const today = t.today();
  const now = t.currentTime();
  const args = command.text.trim();

  db.upsertUser({ slack_id: userId, name: command.user_name, real_name: command.user_name });

  if (args.toLowerCase() === 'fin' || args.toLowerCase() === 'end') {
    // End active meeting
    const active = db.getActiveMeeting(userId, today);
    if (!active) { await ack({ response_type: 'ephemeral', text: txt.meetings.noActive }); return; }
    const ended = db.endMeeting(active.id, now);
    await ack({ response_type: 'ephemeral', text: txt.meetings.ended(now, ended.duration_min) });
  } else {
    // Start new meeting
    const active = db.getActiveMeeting(userId, today);
    if (active) { await ack({ response_type: 'ephemeral', text: txt.meetings.alreadyInMeeting }); return; }
    const reason = args || 'Reunión';
    db.startMeeting(userId, today, now, reason);
    await ack({ response_type: 'ephemeral', text: txt.meetings.started(reason, now) });
  }
});

// ═══════════════════════════════════════════════════════════════════
// /reporte
// ═══════════════════════════════════════════════════════════════════

app.command('/reporte', async ({ command, ack }) => {
  const args = command.text.trim().toLowerCase();
  const s = args === 'mensual' || args === 'mes' ? t.monthStart() : t.weekStart();
  await ack({ response_type: 'ephemeral', blocks: blocks.buildWeeklyReport(db.getWeeklySummary(s, t.today()), s, t.today()) });
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
  const result = db.respondToPing(parseInt(action.value, 10));
  await ack();
  const ch = body.channel?.id || body.user.id;
  const text = result ? txt.pings.responded(Math.round(result.response_ms / 1000)) : txt.pings.expired;
  await client.chat.postEphemeral({ channel: ch, user: body.user.id, text });
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

app.command('/ayuda', async ({ ack, respond }) => {
  await ack();
  await respond({
    response_type: 'ephemeral',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '⚡ Hoopla Asistencia — Comandos' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*🙋 Ausencias y licencias*' } },
      { type: 'section', text: { type: 'mrkdwn', text: '`/pedir` — Solicitá vacaciones, día libre, examen, medio día, médico u otra ausencia. La solicitud queda pendiente hasta que un admin la apruebe o rechace.\n`/mi-balance` — Consultá cuántos días de cada tipo te quedan en el año.' } },
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
      { type: 'section', text: { type: 'mrkdwn', text: '`/admin lista` — Ver todos los usuarios.\n`/admin agregar @usuario` — Sumá a alguien al seguimiento.\n`/admin sacar @usuario` — Quitá a alguien del seguimiento.\n`/admin ausencias` — Ver solicitudes de ausencia pendientes.\n`/admin feriados [año]` — Ver los feriados cargados.\n`/admin estudiante @usuario on|off` — Activar/desactivar días de examen (requiere carrera universitaria).' } },
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Solo vos ves este mensaje_ · ⚡ Hoopla Asistencia' }] },
    ],
  });
});

// ═══════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════

app.event('app_home_opened', async ({ event, client }) => {
  const record = db.getRecord(event.user, t.today());
  await client.views.publish({
    user_id: event.user,
    view: { type: 'home', blocks: [
      { type: 'header', text: { type: 'plain_text', text: '⚡ Hoopla Asistencia' } },
      { type: 'section', text: { type: 'mrkdwn', text: '`/marcar` fichar · `/campo` trabajo de campo · `/horarios` tu balance · `/reunion` reuniones · `/admin lista` admin' } },
      { type: 'divider' },
      ...blocks.buildAttendanceMenu(record),
    ] },
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
  setupLeaves(app);
  setupDemo(app);
  await app.start(PORT);
  console.log(`\n  ⚡ Hoopla Asistencia running — port ${PORT}\n  → Dashboard: http://localhost:${PORT}/dashboard`);
  if (SOLO_MODE) console.log(`  → Solo mode: ON (${SOLO_USER_ID})`);
  console.log('');
})();
