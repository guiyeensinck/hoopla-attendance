const t = require('./time');
const db = require('./database');
const texts = require('./texts');
const { buildWeeklyReport } = require('./blocks');
const { buildPingMessage, PING_TIMEOUT_MIN } = require('./activity');

const DEMO_HELP = [
  '🧪 *Modo demo — comandos disponibles:*',
  '',
  '`/demo reset` — Borra el registro de hoy para volver a testear `/marcar`',
  '`/demo recordatorio` — Te manda el DM de las 9:35 (con el ASCII art)',
  '`/demo almuerzo` — Te manda el recordatorio de almuerzo (14:00)',
  '`/demo salida` — Te manda el recordatorio de salida (18:30)',
  '`/demo ping` — Te manda un ping de actividad ahora',
  '`/demo cierre` — Ejecuta el cierre automático de tu jornada',
  '`/demo reporte` — Te manda el reporte semanal por DM',
  '`/demo estado` — Muestra tu estado del día y balance semanal',
].join('\n');

const safeRespond = async (respond, text) => {
  try {
    await respond({ response_type: 'ephemeral', text });
  } catch (e) {
    console.error('[demo] respond() failed:', e.message);
  }
};

const setupDemo = (app) => {
  const SUPER_ADMIN = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)[0]
    || process.env.SOLO_USER_ID || '';

  app.command('/demo', async ({ command, ack, respond, client }) => {
    await ack();

    if (command.user_id !== SUPER_ADMIN) {
      await safeRespond(respond, '🔒 Solo el super admin puede usar `/demo`.');
      return;
    }

    const sub = (command.text || '').trim().toLowerCase();
    const userId = command.user_id;
    const today = t.today();
    const now = t.currentTime();

    try {
      // Garantizar que el usuario exista en la DB (necesario para FK constraints).
      // Usamos command.user_name para no necesitar el scope users:read.
      db.upsertUser({ slack_id: userId, name: command.user_name, real_name: command.user_name });

      // ─── /demo  o  /demo ayuda ─────────────────────────────────────
      if (!sub || sub === 'ayuda') {
        await safeRespond(respond, DEMO_HELP);
        return;
      }

      // ─── /demo reset ───────────────────────────────────────────────
      if (sub === 'reset') {
        db.db.prepare('DELETE FROM records WHERE slack_id = ? AND date = ?').run(userId, today);
        db.db.prepare('DELETE FROM activity_pings WHERE slack_id = ? AND date = ?').run(userId, today);
        db.db.prepare('DELETE FROM day_overrides WHERE slack_id = ? AND date = ?').run(userId, today);
        await safeRespond(respond, '🗑️ *Reset completo.* Registro de hoy borrado.\nPodés volver a testear `/marcar` desde cero.');
        return;
      }

      // ─── /demo recordatorio ────────────────────────────────────────
      if (sub === 'recordatorio') {
        await client.chat.postMessage({ channel: userId, text: texts.reminders.entryMissing() });
        await safeRespond(respond, '✅ DM de recordatorio enviado. Fijate en tus mensajes directos.');
        return;
      }

      // ─── /demo almuerzo ────────────────────────────────────────────
      if (sub === 'almuerzo') {
        await client.chat.postMessage({ channel: userId, text: texts.reminders.lunchMissing });
        await safeRespond(respond, '✅ DM de almuerzo enviado.');
        return;
      }

      // ─── /demo salida ──────────────────────────────────────────────
      if (sub === 'salida') {
        await client.chat.postMessage({ channel: userId, text: texts.reminders.exitMissing });
        await safeRespond(respond, '✅ DM de salida enviado.');
        return;
      }

      // ─── /demo ping ────────────────────────────────────────────────
      if (sub === 'ping') {
        const pingId = db.createPing(userId, today, now);
        const pingBlocks = buildPingMessage(pingId);
        await client.chat.postMessage({ channel: userId, text: '🏓 Check de actividad — ¿seguís ahí?', blocks: pingBlocks });
        await safeRespond(respond, `✅ Ping enviado. Tenés ${PING_TIMEOUT_MIN} minutos para responder.`);
        return;
      }

      // ─── /demo cierre ──────────────────────────────────────────────
      if (sub === 'cierre') {
        const record = db.getRecord(userId, today);
        if (!record?.entry_time) {
          await safeRespond(respond, '⚠️ No tenés entrada registrada hoy. Hacé `/marcar` primero.');
          return;
        }
        db.fillMissingLunch(userId, today, record);
        db.updateField(userId, today, 'exit_time', now);
        await client.chat.postMessage({ channel: userId, text: texts.reminders.exitAutoClosedUser(now) });
        await safeRespond(respond, `✅ Cierre automático simulado. Salida registrada a las *${now}*.`);
        return;
      }

      // ─── /demo reporte ─────────────────────────────────────────────
      if (sub === 'reporte') {
        const s = t.weekStart(), e = t.today();
        const reportBlocks = buildWeeklyReport(db.getWeeklySummary(s, e), s, e);
        await client.chat.postMessage({ channel: userId, text: '📊 Reporte semanal (demo)', blocks: reportBlocks });
        await safeRespond(respond, '✅ Reporte enviado por DM.');
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
        const labels = { entry_time: '🟢 Entrada', lunch_start: '🍽️ Inicio almuerzo', lunch_end: '⏱️ Fin almuerzo', exit_time: '🔴 Salida' };
        const statusLines = Object.entries(labels).map(([f, l]) => `${l}: ${record?.[f] || '_pendiente_'}`).join('\n');
        const balanceIcon = diff >= 0 ? '🟢' : (Math.abs(diff) > 2 ? '🔴' : '🟡');
        await safeRespond(respond, `📊 *Tu estado hoy — ${today}*\n${statusLines}\n\n📅 *Balance semanal:*\nTrabajadas: *${totalWorked}hs* / Esperadas: *${expected}hs*\n${balanceIcon} Diferencia: *${diff > 0 ? '+' : ''}${diff}hs*`);
        return;
      }

      await safeRespond(respond, `❓ Sub-comando desconocido: \`${sub}\`\n\nUsá \`/demo\` para ver las opciones.`);

    } catch (err) {
      console.error('[demo] Error en sub-comando:', sub, err.message);
      await safeRespond(respond, `❌ Error en \`/demo ${sub}\`: ${err.message}`);
    }
  });

  console.log('[demo] Comando /demo configurado (solo super admin)');
};

module.exports = { setupDemo };
