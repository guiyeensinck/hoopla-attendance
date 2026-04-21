const cron = require('node-cron');
const t = require('./time');
const fs = require('fs');
const db = require('./database');
const texts = require('./texts');
const { buildWeeklyReport, buildMissingAlert, buildDailySummary, buildOvertimeAlert, buildLunchReminder,
  buildEntryReminderBlocks, buildLunchReminderBlocks, buildExitReminderBlocks } = require('./blocks');
const { runPingCycle, runPresenceCheck } = require('./activity');
const { generateMonthlyExcel } = require('./excel');

const MAX_HOURS = parseFloat(process.env.MAX_HOURS_PER_DAY || '9');
const TZ = t.TZ;

const setupScheduler = (app) => {
  const REPORT_CHANNEL = process.env.REPORT_CHANNEL || '#asistencia';
  const SOLO_MODE = process.env.SOLO_MODE === 'true';
  const SOLO_USER_ID = process.env.SOLO_USER_ID || '';
  const target = () => SOLO_MODE ? SOLO_USER_ID : REPORT_CHANNEL;

  // ─── Recordatorios de entrada ──────────────────────────────────
  // - 09:35 inicial
  // - Cada 30 min entre 10:00 y 12:30 si todavía no marcó
  // - Después de 12:30 se corta (si no vino, no vino — el alert al admin
  //   de las 10:30 ya cubre ese caso)
  // NOTA: no hay reminder al arranque del server — eso generaba spam en
  // cada redeploy de Railway.
  const sendEntryReminders = async (timeLabel) => {
    const today = t.today();
    if (db.isHoliday(today)) return;
    const missing = db.getMissingToday(today);
    let count = 0;
    for (const user of missing) {
      if (db.isUserExemptToday(user.slack_id, today)) continue;
      const msg = buildEntryReminderBlocks(timeLabel);
      await app.client.chat.postMessage({ channel: user.slack_id, ...msg });
      count++;
    }
    if (count > 0) console.log(`[scheduler] ${timeLabel} entry reminder → ${count} personas`);
  };

  // 09:35 inicial
  cron.schedule('35 9 * * 1-5', async () => {
    try { await sendEntryReminders('09:35'); }
    catch (err) { console.error('[scheduler] Error 9:35 reminder:', err); }
  }, { timezone: TZ });

  // 10:00, 10:30, 11:00, 11:30, 12:00, 12:30 — seguimiento (6 tiros max)
  cron.schedule('0,30 10,11,12 * * 1-5', async () => {
    try { await sendEntryReminders(t.now().format('HH:mm')); }
    catch (err) { console.error('[scheduler] Error recurring reminder:', err); }
  }, { timezone: TZ });

  // ─── 10:30 — Alert to admin: who's still missing ────────────────
  cron.schedule('30 10 * * 1-5', async () => {
    try {
      const today = t.today();
      if (db.isHoliday(today)) return;
      const missing = db.getMissingToday(today);
      const blocks = buildMissingAlert(missing);
      if (blocks) {
        await app.client.chat.postMessage({ channel: target(), text: '⚠️ Alerta de asistencia', blocks });
        console.log(`[scheduler] 10:30 missing alert — ${missing.length}`);
      }
    } catch (err) { console.error('[scheduler] Error 10:30:', err); }
  }, { timezone: TZ });

  // ─── 13:00 — Lunch reminder to individuals ──────────────────────
  cron.schedule('0 13 * * 1-5', async () => {
    try {
      const today = t.today();
      if (db.isHoliday(today)) return;
      const noLunch = db.getNoLunchYet(today);
      for (const r of noLunch) {
        if (db.isUserExemptToday(r.slack_id, today)) continue;
        if (db.isFieldDay(r.slack_id, today)) continue;
        const msg = buildLunchReminderBlocks();
        await app.client.chat.postMessage({ channel: r.slack_id, ...msg });
      }
      if (noLunch.length > 0) console.log(`[scheduler] 13:00 lunch reminder → ${noLunch.length}`);
    } catch (err) { console.error('[scheduler] Error 13:00:', err); }
  }, { timezone: TZ });

  // ─── 16:00 — Auto-cierre del almuerzo si el usuario se olvidó ────
  // Si ya son las 16:00 y el usuario no cerró el almuerzo, lo rellenamos
  // con 1 hora (13:00-14:00) y le avisamos. Es solo un fallback; la idea
  // es que el usuario lo haga.
  cron.schedule('0 16 * * 1-5', async () => {
    try {
      const today = t.today();
      if (db.isHoliday(today)) return;
      const pending = db.getLunchNotClosed(today);
      let count = 0;
      for (const r of pending) {
        if (db.isUserExemptToday(r.slack_id, today)) continue;
        if (db.isFieldDay(r.slack_id, today)) continue;
        db.fillMissingLunch(r.slack_id, today, r);
        await app.client.chat.postMessage({
          channel: r.slack_id,
          text: texts.reminders.lunchAutoClosed,
        });
        count++;
      }
      if (count > 0) console.log(`[scheduler] 16:00 lunch auto-close → ${count} personas`);
    } catch (err) { console.error('[scheduler] Error 16:00:', err); }
  }, { timezone: TZ });

  // ─── 18:30 — Exit handling ──────────────────────────────────────
  // - Campo/reunión: cierre automático inmediato a las 18:30
  // - Oficina CON pings respondidos hoy: cierre automático usando el
  //   último ping como hora de salida (mensaje claro de que es fallback)
  // - Oficina SIN pings respondidos: recordatorio con botón (todavía
  //   tiene hasta 20:30 para cerrar manual)
  cron.schedule('30 18 * * 1-5', async () => {
    try {
      const today = t.today();
      if (db.isHoliday(today)) return;

      const incomplete = db.getIncompleteToday(today);
      for (const r of incomplete) {
        const isField = r.work_mode === 'field' || db.isFieldDay(r.slack_id, today);
        const hasMeeting = db.getActiveMeeting(r.slack_id, today);

        if (isField || hasMeeting) {
          // Auto-close field/meeting users at 18:30
          if (hasMeeting) db.endMeeting(hasMeeting.id, '18:30');
          db.fillMissingLunch(r.slack_id, today, r);
          db.updateField(r.slack_id, today, 'exit_time', '18:30');
          await app.client.chat.postMessage({
            channel: r.slack_id,
            text: texts.reminders.exitAutoClosedField,
          });
          console.log(`[scheduler] Auto-closed field/meeting: ${r.real_name || r.name}`);
          continue;
        }

        // Office worker — try to close with last responded ping time
        const lastPing = db.getLastRespondedPingTime(r.slack_id, today);
        if (lastPing) {
          const exitHM = lastPing.substring(0, 5); // HH:MM from HH:MM:SS
          const missed = db.getMissedPingCount(r.slack_id, today);
          db.fillMissingLunch(r.slack_id, today, r);
          db.updateField(r.slack_id, today, 'exit_time', exitHM);
          await app.client.chat.postMessage({
            channel: r.slack_id,
            text: texts.reminders.exitAutoClosedByPing(exitHM, missed),
          });
          console.log(`[scheduler] 18:30 auto-close by last ping: ${r.real_name || r.name} → ${exitHM}`);
        } else {
          // No ping answered — send reminder with button (still has until 20:30)
          const msg = buildExitReminderBlocks();
          await app.client.chat.postMessage({ channel: r.slack_id, ...msg });
        }
      }
    } catch (err) { console.error('[scheduler] Error 18:30:', err); }
  }, { timezone: TZ });

  // ─── 20:30 — Auto-close anyone still open ────────────────────
  // Último fallback: si a las 20:30 no cerraron ni hay ping que usar,
  // se cierra en 18:30 (horario estándar).
  cron.schedule('30 20 * * 1-5', async () => {
    try {
      const today = t.today();
      if (db.isHoliday(today)) return;

      const closed = db.autoCloseDay(today, '18:30');

      for (const c of closed) {
        const exitLabel = c.exit_time === '18:30' ? '18:30 (horario estándar)' : `${c.exit_time} (última actividad registrada)`;
        await app.client.chat.postMessage({
          channel: c.slack_id,
          text: texts.reminders.exitAutoClosedUser(exitLabel),
        });
      }

      if (closed.length > 0) {
        const names = closed.map(c => `• ${c.real_name || c.name} → ${c.exit_time}`).join('\n');
        await app.client.chat.postMessage({
          channel: target(),
          text: `🔒 *Cierre automático del día:*\n${names}`,
        });
        console.log(`[scheduler] 20:30 auto-close → ${closed.length} personas`);
      }
    } catch (err) { console.error('[scheduler] Error 20:30:', err); }
  }, { timezone: TZ });

  // ─── 19:00 — Daily summary to channel ───────────────────────────
  cron.schedule('0 19 * * 1-5', async () => {
    try {
      const today = t.today();
      const data = db.getDailySummary(today);
      const blocks = buildDailySummary(data, today);
      await app.client.chat.postMessage({ channel: target(), text: '📋 Resumen del día', blocks });

      // Overtime check
      const overtime = db.getOvertimeToday(today, MAX_HOURS);
      const overtimeBlocks = buildOvertimeAlert(overtime);
      if (overtimeBlocks) {
        await app.client.chat.postMessage({ channel: target(), text: '⚠️ Horas extra', blocks: overtimeBlocks });
      }

      console.log('[scheduler] 19:00 daily summary sent');
    } catch (err) { console.error('[scheduler] Error 19:00:', err); }
  }, { timezone: TZ });

  // ─── Friday 18:00 — Weekly report ───────────────────────────────
  cron.schedule('0 18 * * 5', async () => {
    try {
      const s = t.weekStart(), e = t.today();
      const blocks = buildWeeklyReport(db.getWeeklySummary(s, e), s, e);
      await app.client.chat.postMessage({ channel: target(), text: '📊 Reporte semanal', blocks });
      console.log('[scheduler] Weekly report sent');
    } catch (err) { console.error('[scheduler] Error weekly:', err); }
  }, { timezone: TZ });

  // ─── 1st of month 09:00 — Monthly report + Excel ────────────────
  cron.schedule('0 9 1 * *', async () => {
    try {
      const lastMonth = t.now().subtract(1, 'month');
      const s = lastMonth.startOf('month').format('YYYY-MM-DD');
      const e = lastMonth.endOf('month').format('YYYY-MM-DD');
      const label = lastMonth.format('YYYY-MM');

      // Summary in Slack
      const blocks = buildWeeklyReport(db.getWeeklySummary(s, e), s, e);
      blocks[0].text.text = `📊 Reporte mensual: ${lastMonth.format('MMMM YYYY')}`;
      await app.client.chat.postMessage({ channel: target(), text: '📊 Reporte mensual', blocks });

      // Excel
      const filepath = await generateMonthlyExcel(s, e, label);
      await app.client.files.uploadV2({
        channel_id: typeof target() === 'string' && target().startsWith('U') ? target() : undefined,
        channels: typeof target() === 'string' && !target().startsWith('U') ? target() : undefined,
        file: fs.readFileSync(filepath),
        filename: `asistencia_${label}.xlsx`,
        title: `Asistencia ${lastMonth.format('MMMM YYYY')}`,
      });

      console.log('[scheduler] Monthly report + Excel sent');
    } catch (err) { console.error('[scheduler] Error monthly:', err); }
  }, { timezone: TZ });

  // ─── Activity pings: every minute L-V ───────────────────────────
  cron.schedule('* * * * 1-5', async () => {
    try { await runPingCycle(app); } catch (err) { console.error('[scheduler] Ping error:', err); }
  }, { timezone: TZ });

  // ─── Presence check: every 30 min L-V ───────────────────────────
  cron.schedule('0,30 * * * 1-5', async () => {
    try { await runPresenceCheck(app); } catch (err) { console.error('[scheduler] Presence error:', err); }
  }, { timezone: TZ });

  console.log('[scheduler] Cron jobs configurados:');
  console.log('  → Recordatorio entrada: L-V 09:35 + 10:00/10:30/11:00/11:30/12:00/12:30 si falta');
  console.log('  → Alerta faltantes al admin: L-V 10:30');
  console.log('  → Recordatorio almuerzo: L-V 13:00');
  console.log('  → Auto-cierre almuerzo (1h fallback): L-V 16:00');
  console.log('  → Pings actividad: 4/día (2 AM ~10:30/12:00 + 2 PM ~15:30/18:00 ±5min) L-V');
  console.log('  → Cierre oficina (último ping / botón): L-V 18:30');
  console.log('  → Auto-cierre campo/reunión: L-V 18:30');
  console.log('  → Auto-cierre general final: L-V 20:30');
  console.log('  → Resumen diario: L-V 19:00');
  console.log('  → Reporte semanal: Viernes 18:00');
  console.log('  → Reporte mensual + Excel: 1ro 09:00');
  console.log('  → Presencia Slack: cada 30 min L-V');
};

module.exports = { setupScheduler };
