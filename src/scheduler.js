const cron = require('node-cron');
const t = require('./time');
const fs = require('fs');
const db = require('./database');
const { buildWeeklyReport, buildMissingAlert, buildDailySummary, buildOvertimeAlert, buildLunchReminder } = require('./blocks');
const { runPingCycle, runPresenceCheck } = require('./activity');
const { generateMonthlyExcel } = require('./excel');

const MAX_HOURS = parseFloat(process.env.MAX_HOURS_PER_DAY || '9');
const TZ = t.TZ;

const setupScheduler = (app) => {
  const REPORT_CHANNEL = process.env.REPORT_CHANNEL || '#asistencia';
  const SOLO_MODE = process.env.SOLO_MODE === 'true';
  const SOLO_USER_ID = process.env.SOLO_USER_ID || '';
  const target = () => SOLO_MODE ? SOLO_USER_ID : REPORT_CHANNEL;

  // ─── 9:35 — Auto-reminder for missing entry ─────────────────────
  cron.schedule('35 9 * * 1-5', async () => {
    try {
      const today = t.today();
      if (db.isHoliday(today)) return;
      const missing = db.getMissingToday(today);
      for (const user of missing) {
        if (db.isUserExemptToday(user.slack_id, today)) continue;
        await app.client.chat.postMessage({
          channel: user.slack_id,
          text: '🔔 Son las 9:35 y todavía no registraste tu entrada. Escribí `/marcar` para fichar.',
        });
      }
      if (missing.length > 0) console.log(`[scheduler] 9:35 entry reminder → ${missing.length} personas`);
    } catch (err) { console.error('[scheduler] Error 9:35 reminder:', err); }
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

  // ─── 14:00 — Lunch reminder to individuals ──────────────────────
  cron.schedule('0 14 * * 1-5', async () => {
    try {
      const today = t.today();
      if (db.isHoliday(today)) return;
      const noLunch = db.getNoLunchYet(today);
      for (const r of noLunch) {
        if (db.isUserExemptToday(r.slack_id, today)) continue;
        if (db.isFieldDay(r.slack_id, today)) continue;
        await app.client.chat.postMessage({
          channel: r.slack_id,
          text: '🍽️ Son las 14:00 y todavía no registraste tu almuerzo. Escribí `/marcar` para registrarlo.',
          blocks: buildLunchReminder(),
        });
      }
      if (noLunch.length > 0) console.log(`[scheduler] 14:00 lunch reminder → ${noLunch.length}`);
    } catch (err) { console.error('[scheduler] Error 14:00:', err); }
  }, { timezone: TZ });

  // ─── 18:30 — Exit reminder ──────────────────────────────────────
  cron.schedule('30 18 * * 1-5', async () => {
    try {
      const today = t.today();
      const incomplete = db.getIncompleteToday(today);
      for (const r of incomplete) {
        await app.client.chat.postMessage({
          channel: r.slack_id,
          text: '🔔 Todavía no registraste tu salida. Escribí `/marcar` para completar.',
        });
      }
      if (incomplete.length > 0) console.log(`[scheduler] 18:30 exit reminder → ${incomplete.length}`);
    } catch (err) { console.error('[scheduler] Error 18:30:', err); }
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
  console.log('  → Recordatorio entrada: L-V 09:35');
  console.log('  → Alerta faltantes: L-V 10:30');
  console.log('  → Recordatorio almuerzo: L-V 14:00');
  console.log('  → Recordatorio salida: L-V 18:30');
  console.log('  → Resumen diario: L-V 19:00');
  console.log('  → Reporte semanal: Viernes 18:00');
  console.log('  → Reporte mensual + Excel: 1ro 09:00');
  console.log('  → Pings actividad: cada minuto L-V');
  console.log('  → Presencia Slack: cada 30 min L-V');
};

module.exports = { setupScheduler };
