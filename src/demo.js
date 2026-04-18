const t = require('./time');
const db = require('./database');
const texts = require('./texts');
const { buildWeeklyReport } = require('./blocks');
const { buildPingMessage, PING_TIMEOUT_MIN } = require('./activity');

const DEMO_HELP = `
🧪 *Modo demo — comandos disponibles:*

\`/demo reset\` — Borra el registro de hoy para volver a testear \`/marcar\`
\`/demo recordatorio\` — Te manda el DM de las 9:35 (con el ASCII art)
\`/demo almuerzo\` — Te manda el recordatorio de almuerzo (14:00)
\`/demo salida\` — Te manda el recordatorio de salida (18:30)
\`/demo ping\` — Te manda un ping de actividad ahora
\`/demo cierre\` — Ejecuta el cierre automático de tu jornada
\`/demo reporte\` — Te manda el reporte semanal
\`/demo estado\` — Muestra tu estado del día
`.trim();

const setupDemo = (app) => {
  const SUPER_ADMIN = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)[0]
    || process.env.SOLO_USER_ID || '';

  const isDemoUser = (userId) => userId === SUPER_ADMIN;

  app.command('/demo', async ({ command, ack, client }) => {
    await ack();

    if (!isDemoUser(command.user_id)) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: '🔒 Solo el super admin puede usar `/demo`.',
      });
      return;
    }

    const sub = (command.text || '').trim().toLowerCase();
    const userId = command.user_id;
    const today = t.today();
    const now = t.currentTime();

    try {
      // ─── /demo (sin sub) o /demo ayuda ────────────────────────────
      if (!sub || sub === 'ayuda') {
        await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text: DEMO_HELP });
        return;
      }

      // ─── /demo reset ───────────────────────────────────────────────
      if (sub === 'reset') {
        db.db.prepare('DELETE FROM records WHERE slack_id = ? AND date = ?').run(userId, today);
        db.db.prepare('DELETE FROM activity_pings WHERE slack_id = ? AND date = ?').run(userId, today);
        db.db.prepare('DELETE FROM day_overrides WHERE slack_id = ? AND date = ?').run(userId, today);
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: userId,
          text: `🗑️ *Reset completo.* Registro de hoy borrado.\nPodés volver a testear \`/marcar\` desde cero.`,
        });
        return;
      }

      // ─── /demo recordatorio ────────────────────────────────────────
      if (sub === 'recordatorio') {
        await client.chat.postMessage({
          channel: userId,
          text: texts.reminders.entryMissing(),
        });
        await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text: '✅ DM de recordatorio enviado.' });
        return;
      }

      // ─── /demo almuerzo ────────────────────────────────────────────
      if (sub === 'almuerzo') {
        await client.chat.postMessage({
          channel: userId,
          text: texts.reminders.lunchMissing,
        });
        await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text: '✅ DM de almuerzo enviado.' });
        return;
      }

      // ─── /demo salida ──────────────────────────────────────────────
      if (sub === 'salida') {
        await client.chat.postMessage({
          channel: userId,
          text: texts.reminders.exitMissing,
        });
        await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text: '✅ DM de salida enviado.' });
        return;
      }

      // ─── /demo ping ────────────────────────────────────────────────
      if (sub === 'ping') {
        const pingId = db.createPing(userId, today, now);
        const pingBlocks = buildPingMessage(pingId);
        await client.chat.postMessage({
          channel: userId,
          text: '🏓 Check de actividad — ¿seguís ahí?',
          blocks: pingBlocks,
        });
        await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text: `✅ Ping enviado. Tenés ${PING_TIMEOUT_MIN} minutos para responder.` });
        return;
      }

      // ─── /demo cierre ──────────────────────────────────────────────
      if (sub === 'cierre') {
        const record = db.getRecord(userId, today);
        if (!record?.entry_time) {
          await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text: '⚠️ No tenés entrada registrada hoy. Hacé \`/marcar\` primero.' });
          return;
        }
        db.fillMissingLunch(userId, today, record);
        db.updateField(userId, today, 'exit_time', now);
        await client.chat.postMessage({
          channel: userId,
          text: texts.reminders.exitAutoClosedUser(now),
        });
        await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text: `✅ Cierre automático simulado. Salida registrada a las *${now}*.` });
        return;
      }

      // ─── /demo reporte ─────────────────────────────────────────────
      if (sub === 'reporte') {
        const s = t.weekStart(), e = t.today();
        const blocks = buildWeeklyReport(db.getWeeklySummary(s, e), s, e);
        await client.chat.postMessage({ channel: userId, text: '📊 Reporte semanal (demo)', blocks });
        await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text: '✅ Reporte enviado por DM.' });
        return;
      }

      // ─── /demo estado ──────────────────────────────────────────────
      if (sub === 'estado') {
        const record = db.getRecord(userId, today);
        const EXPECTED = parseFloat(process.env.EXPECTED_HOURS_PER_DAY || '8');
        const weekStart = t.weekStart();
        const weekRecords = db.getUserWeeklyRecords(userId, weekStart, today);
        const totalWorked = Math.round(weekRecords.reduce((s, r) => s + (r.total_hours || 0), 0) * 10) / 10;
        const daysElapsed = db.countWorkdaysInRange(weekStart, today);
        const expected = Math.round(daysElapsed * EXPECTED * 10) / 10;
        const diff = Math.round((totalWorked - expected) * 10) / 10;

        const fields = ['entry_time', 'lunch_start', 'lunch_end', 'exit_time'];
        const labels = { entry_time: '🟢 Entrada', lunch_start: '🍽️ Inicio almuerzo', lunch_end: '⏱️ Fin almuerzo', exit_time: '🔴 Salida' };
        const statusLines = fields.map(f => `${labels[f]}: ${record?.[f] || '_pendiente_'}`).join('\n');

        const balanceIcon = diff >= 0 ? '🟢' : (Math.abs(diff) > 2 ? '🔴' : '🟡');
        const text = `📊 *Tu estado hoy — ${today}*\n${statusLines}\n\n📅 *Balance semanal:*\nTrabajadas: *${totalWorked}hs* / Esperadas: *${expected}hs*\n${balanceIcon} Diferencia: *${diff > 0 ? '+' : ''}${diff}hs*`;
        await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text });
        return;
      }

      await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text: `❓ Sub-comando desconocido: \`${sub}\`\n\nUsá \`/demo\` para ver las opciones.` });

    } catch (err) {
      console.error('[demo] Error:', err);
      await client.chat.postEphemeral({ channel: command.channel_id, user: userId, text: `❌ Error: ${err.message}` });
    }
  });

  console.log('[demo] Comando /demo configurado (solo super admin)');
};

module.exports = { setupDemo };
