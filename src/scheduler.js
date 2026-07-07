const cron = require('node-cron');
const fs = require('fs');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { resumenDiario, reportePersonas } = require('./reports');
const { runPresenceCheck, runPingCycle } = require('./activity');
const { generarExcel } = require('./excel');

// Ventanas de tolerancia: si la app estuvo caída (deploy de Railway) el aviso
// sale apenas vuelve, pero no horas más tarde. La dedupe la hace la tabla avisos.
const VENTANA_RECORDATORIO = 30;  // min para el recordatorio de entrada
const VENTANA_ALERTA = 30;        // min para la alerta admin de faltantes
const VENTANA_CIERRE = 180;       // min para mandar el DM de cierre
const TIMEOUT_CIERRE = 20;        // min sin respuesta al DM de cierre → auto-cierre

/**
 * Motor de recordatorios y cierre: TODOS los horarios son relativos al
 * horario personal de cada persona (no hay horarios globales de equipo).
 */
const setupScheduler = (app) => {
  const SOLO_MODE = process.env.SOLO_MODE === 'true';
  const SOLO_USER_ID = process.env.SOLO_USER_ID || '';
  const soloUser = SOLO_MODE ? SOLO_USER_ID : null;
  const REPORT_CHANNEL = process.env.REPORT_CHANNEL || '#asistencia';
  const target = () => (SOLO_MODE ? SOLO_USER_ID : REPORT_CHANNEL);

  const dm = (channel, text, blocks) => app.client.chat.postMessage({ channel, text, ...(blocks ? { blocks } : {}) });

  const trackedActivos = (fecha) => db.getTracked()
    .filter(u => !soloUser || u.slack_id === soloUser)
    .filter(u => !db.isExento(u.slack_id, fecha));

  // ─── Auto-cierre: salida AL horario personal, con flag ────────────
  const autoCerrar = async (user, fecha, hora, msg) => {
    db.imputarAlmuerzo(user, fecha); // si falta el almuerzo, se imputa 13:00–14:00
    db.registrar(user, fecha, 'salida', hora, 'auto', { auto_closed: true, nota: 'auto_closed_sin_respuesta' });
    db.setCierre(user.slack_id, fecha, { estado: 'cerrado' });
    await dm(user.slack_id, msg);
    console.log(`[cierre] Auto-cierre de ${user.nombre} → ${hora}`);
  };

  // ─── Tick por minuto ───────────────────────────────────────────────
  const tick = async () => {
    const fecha = t.today();
    if (!t.isWeekday(fecha) || db.isFeriado(fecha)) return;
    const nowM = t.nowMin();
    const faltantesBatch = [];

    for (const user of trackedActivos(fecha)) {
      const uid = user.slack_id;
      const entradaM = t.toMin(user.hora_entrada);
      const salidaM = t.toMin(user.hora_salida);
      const dia = db.getDia(uid, fecha);

      try {
        // 1. Entrada +5 min: recordatorio si no fichó
        if (!dia.entrada && nowM >= entradaM + 5 && nowM <= entradaM + 5 + VENTANA_RECORDATORIO && !db.avisoEnviado(uid, fecha, 'rec_entrada')) {
          db.marcarAviso(uid, fecha, 'rec_entrada');
          await dm(uid, txt.recordatorios.entrada(user.hora_entrada));
        }

        // 2. Entrada +60 min: alerta al canal admin
        if (!dia.entrada && nowM >= entradaM + 60 && nowM <= entradaM + 60 + VENTANA_ALERTA && !db.avisoEnviado(uid, fecha, 'alerta_admin')) {
          db.marcarAviso(uid, fecha, 'alerta_admin');
          faltantesBatch.push(user);
        }

        // 3. Horario de salida: DM de cierre con botón
        if (dia.entrada && !dia.salida && nowM >= salidaM && nowM <= salidaM + VENTANA_CIERRE && !db.getCierre(uid, fecha)) {
          db.setCierre(uid, fecha, { estado: 'esperando', dm_hora: t.currentTime() });
          await dm(uid, txt.cierre.dm(user.hora_salida), [
            { type: 'section', text: { type: 'mrkdwn', text: txt.cierre.dm(user.hora_salida) } },
            { type: 'actions', elements: [
              { type: 'button', text: { type: 'plain_text', text: txt.cierre.btnSalida }, style: 'primary', action_id: 'cierre_salida' },
            ] },
          ]);
        }

        // 4. Estados del cierre
        const cierre = db.getCierre(uid, fecha);
        if (!cierre || cierre.estado === 'cerrado') continue;

        // La persona marcó salida por otra vía → cerrar el flujo
        if (dia.salida) { db.setCierre(uid, fecha, { estado: 'cerrado' }); continue; }

        // Sin respuesta al DM de cierre en 20 min → salida AL horario personal
        if (cierre.estado === 'esperando' && nowM >= t.toMin(cierre.dm_hora) + TIMEOUT_CIERRE) {
          await autoCerrar(user, fecha, user.hora_salida, txt.cierre.autoCerrado(user.hora_salida));
        }
      } catch (err) {
        console.error(`[scheduler] Error con ${user.nombre}: ${err.message}`);
      }
    }

    if (faltantesBatch.length) {
      const lista = faltantesBatch.map(u => `• *${u.nombre}* (entrada ${u.hora_entrada})`).join('\n');
      await dm(target(), txt.recordatorios.faltantesAdmin(lista));
      console.log(`[scheduler] Alerta faltantes → ${faltantesBatch.length}`);
    }
  };

  cron.schedule('* * * * 1-5', () => tick().catch(e => console.error('[scheduler] tick:', e)), { timezone: t.TZ });

  // ─── Presencia cada 15 min ─────────────────────────────────────────
  cron.schedule('*/15 * * * 1-5', () => runPresenceCheck(app, soloUser).catch(e => console.error('[presencia]', e)), { timezone: t.TZ });

  // ─── Pings dirigidos (tick por minuto, solo con modo activo) ──────
  cron.schedule('* * * * 1-5', () => runPingCycle(app, soloUser).catch(e => console.error('[pings]', e)), { timezone: t.TZ });

  // ─── 19:00 — Resumen diario por excepción ──────────────────────────
  cron.schedule('0 19 * * 1-5', async () => {
    try {
      const fecha = t.today();
      if (db.isFeriado(fecha)) return;
      await dm(target(), resumenDiario(fecha));
      console.log('[scheduler] Resumen diario enviado');
    } catch (err) { console.error('[scheduler] Resumen 19:00:', err); }
  }, { timezone: t.TZ });

  // ─── Viernes 18:00 — Reporte semanal ───────────────────────────────
  cron.schedule('0 18 * * 5', async () => {
    try {
      await dm(target(), reportePersonas('📊 *Reporte semanal*', t.weekStart(), t.today()));
      console.log('[scheduler] Reporte semanal enviado');
    } catch (err) { console.error('[scheduler] Semanal:', err); }
  }, { timezone: t.TZ });

  // ─── 1ro de cada mes 09:00 — Reporte mensual + Excel ───────────────
  cron.schedule('0 9 1 * *', async () => {
    try {
      const mesPasado = t.now().subtract(1, 'month');
      const from = mesPasado.startOf('month').format('YYYY-MM-DD');
      const to = mesPasado.endOf('month').format('YYYY-MM-DD');
      await dm(target(), reportePersonas(`📊 *Reporte mensual — ${mesPasado.format('MMMM YYYY')}*`, from, to));

      const filepath = await generarExcel(from, to, mesPasado.format('YYYY-MM'));
      const channelId = await resolveChannelId(app.client, target());
      await app.client.files.uploadV2({
        channel_id: channelId,
        file: fs.readFileSync(filepath),
        filename: filepath.split('/').pop(),
        title: `Asistencia ${mesPasado.format('MMMM YYYY')}`,
      });
      console.log('[scheduler] Reporte mensual + Excel enviados');
    } catch (err) { console.error('[scheduler] Mensual:', err); }
  }, { timezone: t.TZ });

  console.log('[scheduler] Cron configurado (TZ America/Argentina/Buenos_Aires):');
  console.log('  → Tick por minuto: recordatorios y cierre según horario PERSONAL');
  console.log('  → Presencia Slack: cada 15 min en horario laboral de cada persona');
  console.log('  → Pings dirigidos: solo con modo activado por admin');
  console.log('  → Resumen diario (solo anomalías): L-V 19:00');
  console.log('  → Reporte semanal: viernes 18:00');
  console.log('  → Reporte mensual + Excel: 1ro de cada mes 09:00');
};

/** files.uploadV2 necesita un channel ID: resuelve #nombre, U... (DM) o ID directo */
const resolveChannelId = async (client, target) => {
  if (target.startsWith('U')) {
    return (await client.conversations.open({ users: target })).channel.id;
  }
  if (target.startsWith('#')) {
    const name = target.slice(1);
    let cursor;
    do {
      const res = await client.conversations.list({ limit: 200, cursor, types: 'public_channel,private_channel' });
      const found = res.channels.find(c => c.name === name);
      if (found) return found.id;
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
    throw new Error(`Canal ${target} no encontrado (¿el bot está invitado?)`);
  }
  return target; // ya es un ID (C...)
};

module.exports = { setupScheduler };
