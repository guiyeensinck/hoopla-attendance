const cron = require('node-cron');
const dayjs = require('dayjs');
const db = require('./database');
const { buildWeeklyReport, buildMissingAlert } = require('./blocks');
const { runPingCycle, runPresenceCheck } = require('./activity');

const setupScheduler = (app) => {
  const REPORT_CHANNEL = process.env.REPORT_CHANNEL || '#asistencia';
  const SOLO_MODE = process.env.SOLO_MODE === 'true';
  const SOLO_USER_ID = process.env.SOLO_USER_ID || '';

  const getTarget = () => SOLO_MODE ? SOLO_USER_ID : REPORT_CHANNEL;

  // ─── Missing check-in alert: L-V 10:30 ──────────────────────────
  cron.schedule('30 10 * * 1-5', async () => {
    try {
      const today = dayjs().format('YYYY-MM-DD');
      const missing = db.getMissingToday(today);
      const blocks = buildMissingAlert(missing);
      if (blocks) {
        await app.client.chat.postMessage({
          channel: getTarget(),
          text: '⚠️ Alerta de asistencia',
          blocks,
        });
        console.log(`[scheduler] Missing alert — ${missing.length} personas`);
      }
    } catch (err) {
      console.error('[scheduler] Error alerta faltantes:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // ─── Exit reminder: L-V 18:30 ───────────────────────────────────
  cron.schedule('30 18 * * 1-5', async () => {
    try {
      const today = dayjs().format('YYYY-MM-DD');
      const incomplete = db.getIncompleteToday(today);
      for (const record of incomplete) {
        await app.client.chat.postMessage({
          channel: record.slack_id,
          text: '🔔 Recordatorio: todavía no registraste tu salida. Escribí `/asistencia` para completar.',
        });
      }
      if (incomplete.length > 0) {
        console.log(`[scheduler] Exit reminders → ${incomplete.length} personas`);
      }
    } catch (err) {
      console.error('[scheduler] Error recordatorio salida:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // ─── Weekly report: Viernes 18:00 ───────────────────────────────
  cron.schedule('0 18 * * 5', async () => {
    try {
      const endDate = dayjs().format('YYYY-MM-DD');
      const startDate = dayjs().startOf('week').format('YYYY-MM-DD');
      const summary = db.getWeeklySummary(startDate, endDate);
      const blocks = buildWeeklyReport(summary, startDate, endDate);
      await app.client.chat.postMessage({
        channel: getTarget(),
        text: '📊 Reporte semanal de asistencia',
        blocks,
      });
      console.log('[scheduler] Weekly report sent');
    } catch (err) {
      console.error('[scheduler] Error reporte semanal:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // ─── Monthly report: 1ro de cada mes 09:00 ──────────────────────
  cron.schedule('0 9 1 * *', async () => {
    try {
      const lastMonth = dayjs().subtract(1, 'month');
      const startDate = lastMonth.startOf('month').format('YYYY-MM-DD');
      const endDate = lastMonth.endOf('month').format('YYYY-MM-DD');
      const summary = db.getWeeklySummary(startDate, endDate);
      const blocks = buildWeeklyReport(summary, startDate, endDate);
      blocks[0].text.text = `📊 Reporte mensual: ${lastMonth.format('MMMM YYYY')}`;
      await app.client.chat.postMessage({
        channel: getTarget(),
        text: '📊 Reporte mensual de asistencia',
        blocks,
      });
      console.log('[scheduler] Monthly report sent');
    } catch (err) {
      console.error('[scheduler] Error reporte mensual:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // ═══════════════════════════════════════════════════════════════════
  // ACTIVITY MONITORING
  // ═══════════════════════════════════════════════════════════════════

  // ─── Random pings: check every minute L-V ────────────────────────
  cron.schedule('* * * * 1-5', async () => {
    try {
      await runPingCycle(app);
    } catch (err) {
      console.error('[scheduler] Error ping cycle:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // ─── Presence check: every 30 min L-V ───────────────────────────
  cron.schedule('0,30 * * * 1-5', async () => {
    try {
      await runPresenceCheck(app);
    } catch (err) {
      console.error('[scheduler] Error presence check:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log('[scheduler] Cron jobs configurados:');
  console.log('  → Alerta faltantes: L-V 10:30');
  console.log('  → Recordatorio salida: L-V 18:30');
  console.log('  → Reporte semanal: Viernes 18:00');
  console.log('  → Reporte mensual: 1ro 09:00');
  console.log('  → Pings actividad: cada minuto L-V (hora laboral)');
  console.log('  → Presencia Slack: cada 30 min L-V');
};

module.exports = { setupScheduler };
