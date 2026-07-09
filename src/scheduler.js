const cron = require('node-cron');
const fs = require('fs');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { resumenDiario, reportePersonas, resumenEjecutivo } = require('./reports');
const { detectarPatrones } = require('./patrones');
const { promptImputacion } = require('./proyectos');
const { runPresenceCheck, runPingCycle } = require('./activity');
const { generarExcel } = require('./excel');

// Configuración de recordatorios — ajustable acá.
// Los recordatorios se repiten cada INTERVALO minutos hasta que la persona
// marca o se llega al tope. La dedupe por "slot" vive en la tabla avisos
// (sobrevive reinicios y no rafaguea si la app estuvo caída).
const CFG = {
  INTERVALO: 10,                    // min entre recordatorios
  TOPE_ENTRADA: 90,                 // insiste con la entrada hasta 90' después del horario
  ALMUERZO_DESDE: 13 * 60 + 30,     // 13:30 — empieza a recordar el inicio de almuerzo
  ALMUERZO_HASTA: 15 * 60,          // 15:00 — deja de insistir
  TOPE_FIN_ALMUERZO: 60,            // tras inicio+60', insiste 1 hora con el fin de almuerzo
  TIMEOUT_CIERRE: 30,               // min desde el DM de cierre hasta el auto-cierre (recordatorios a +10 y +20)
};

const VENTANA_ALERTA = 30;          // min de ventana para la alerta admin de faltantes
const VENTANA_CIERRE = 180;         // min de ventana para mandar el DM de cierre

/**
 * Motor de recordatorios y cierre: TODOS los horarios son relativos al
 * horario personal de cada persona (no hay horarios globales de equipo).
 */
const setupScheduler = (app) => {
  const SOLO_MODE = process.env.SOLO_MODE === 'true';
  const SOLO_USER_IDS = (process.env.SOLO_USER_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  const soloUsers = SOLO_MODE ? SOLO_USER_IDS : null;
  const REPORT_CHANNEL = process.env.REPORT_CHANNEL || '#asistencia';
  // En beta, lo que iría al canal admin va al DM del primer ID de la lista
  const target = () => (SOLO_MODE ? SOLO_USER_IDS[0] : REPORT_CHANNEL);

  const dm = (channel, text, blocks) => app.client.chat.postMessage({ channel, text, ...(blocks ? { blocks } : {}) });

  const trackedActivos = (fecha) => db.getTracked()
    .filter(u => !soloUsers || soloUsers.includes(u.slack_id))
    .filter(u => !db.isExento(u.slack_id, fecha));

  // ─── Auto-cierre con flag ──────────────────────────────────────────
  // La salida se estampa en la ÚLTIMA ACTIVIDAD detectada (presencia
  // "active" de Slack o última marcación), con tope en el horario
  // personal. Sin datos de presencia ese día, cae al horario personal.
  const autoCerrar = async (user, fecha) => {
    const ultima = db.ultimaActividad(user.slack_id, fecha);
    const usaActividad = ultima && ultima < user.hora_salida;
    const hora = usaActividad ? ultima : user.hora_salida;

    // El almuerzo solo se imputa si la salida quedó después de las 14:00
    if (t.toMin(hora) >= 14 * 60) db.imputarAlmuerzo(user, fecha);
    db.registrar(user, fecha, 'salida', hora, 'auto', {
      auto_closed: true,
      nota: usaActividad ? 'auto_closed_ultima_actividad' : 'auto_closed_sin_respuesta',
    });
    db.setCierre(user.slack_id, fecha, { estado: 'cerrado' });
    await dm(user.slack_id, usaActividad ? txt.cierre.autoCerradoActividad(hora) : txt.cierre.autoCerrado(hora));
    await promptImputacion(app.client, user, fecha);
    console.log(`[cierre] Auto-cierre de ${user.nombre} → ${hora}${usaActividad ? ' (última actividad)' : ' (horario)'}`);
  };

  // Manda un recordatorio como máximo una vez por "slot" de 10 minutos
  // (dedupe persistente en la tabla avisos, con log para diagnóstico)
  const recordar = async (uid, fecha, tipoBase, slot, mensaje, blocks) => {
    const tipo = `${tipoBase}_${slot}`;
    if (db.avisoEnviado(uid, fecha, tipo)) return;
    db.marcarAviso(uid, fecha, tipo);
    await dm(uid, mensaje, blocks);
    console.log(`[recordatorio] ${tipoBase} #${slot} → ${uid}`);
  };

  const botonSalida = (texto) => [
    { type: 'section', text: { type: 'mrkdwn', text: texto } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: txt.cierre.btnSalida }, style: 'primary', action_id: 'cierre_salida' },
    ] },
  ];

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
        // Modo solo_proyectos: sin asistencia — solo el prompt de imputación
        // a su horario de salida (si aún no cargó horas)
        if (db.esSoloProyectos(user)) {
          if (nowM >= salidaM && nowM <= salidaM + 60) {
            await promptImputacion(app.client, user, fecha);
          }
          continue;
        }

        // 1. Entrada: cada 10 min desde su horario hasta que marque (tope 90')
        if (!dia.entrada && nowM >= entradaM + CFG.INTERVALO && nowM <= entradaM + CFG.TOPE_ENTRADA) {
          const slot = Math.floor((nowM - entradaM) / CFG.INTERVALO);
          await recordar(uid, fecha, 'rec_entrada', slot, txt.recordatorios.entrada(user.hora_entrada));
        }

        // 2. Entrada +60 min: alerta al canal admin (una sola vez)
        if (!dia.entrada && nowM >= entradaM + 60 && nowM <= entradaM + 60 + VENTANA_ALERTA && !db.avisoEnviado(uid, fecha, 'alerta_admin')) {
          db.marcarAviso(uid, fecha, 'alerta_admin');
          faltantesBatch.push(user);
        }

        // 3. Inicio de almuerzo: cada 10 min entre 13:30 y 15:00 si no lo marcó
        if (dia.entrada && !dia.salida && !dia.almuerzo_inicio && nowM >= CFG.ALMUERZO_DESDE && nowM <= CFG.ALMUERZO_HASTA) {
          const slot = Math.floor((nowM - CFG.ALMUERZO_DESDE) / CFG.INTERVALO);
          await recordar(uid, fecha, 'rec_alm_ini', slot, txt.recordatorios.almuerzoInicio);
        }

        // 4. Fin de almuerzo: cada 10 min desde inicio+60' (tope 1 hora)
        if (dia.almuerzo_inicio && !dia.almuerzo_fin && !dia.salida) {
          const inicioM = t.toMin(dia.almuerzo_inicio.hora);
          if (nowM >= inicioM + 60 + CFG.INTERVALO && nowM <= inicioM + 60 + CFG.TOPE_FIN_ALMUERZO) {
            const slot = Math.floor((nowM - inicioM - 60) / CFG.INTERVALO);
            await recordar(uid, fecha, 'rec_alm_fin', slot, txt.recordatorios.almuerzoFin(dia.almuerzo_inicio.hora));
          }
        }

        // 5. Horario de salida: DM de cierre con botón
        if (dia.entrada && !dia.salida && nowM >= salidaM && nowM <= salidaM + VENTANA_CIERRE && !db.getCierre(uid, fecha)) {
          db.setCierre(uid, fecha, { estado: 'esperando', dm_hora: t.currentTime() });
          await dm(uid, txt.cierre.dm(user.hora_salida), botonSalida(txt.cierre.dm(user.hora_salida)));
          console.log(`[cierre] DM de cierre → ${user.nombre}`);
        }

        // 6. Estados del cierre
        const cierre = db.getCierre(uid, fecha);
        if (!cierre || cierre.estado === 'cerrado') continue;

        // La persona marcó salida por otra vía → cerrar el flujo
        if (dia.salida) { db.setCierre(uid, fecha, { estado: 'cerrado' }); continue; }

        if (cierre.estado === 'esperando') {
          const dmM = t.toMin(cierre.dm_hora);
          if (nowM >= dmM + CFG.TIMEOUT_CIERRE) {
            // Sin respuesta → auto-cierre por última actividad
            await autoCerrar(user, fecha);
          } else if (nowM >= dmM + CFG.INTERVALO) {
            // Recordatorios intermedios (a +10' y +20') con el botón
            const slot = Math.floor((nowM - dmM) / CFG.INTERVALO);
            await recordar(uid, fecha, 'rec_cierre', slot, txt.cierre.recordatorio, botonSalida(txt.cierre.recordatorio));
          }
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
  setupScheduler._tick = tick; // expuesto para tests

  // ─── Presencia cada 15 min ─────────────────────────────────────────
  cron.schedule('*/15 * * * 1-5', () => runPresenceCheck(app, soloUsers).catch(e => console.error('[presencia]', e)), { timezone: t.TZ });

  // ─── Pings dirigidos (tick por minuto, solo con modo activo) ──────
  cron.schedule('* * * * 1-5', () => runPingCycle(app, soloUsers).catch(e => console.error('[pings]', e)), { timezone: t.TZ });

  // ─── 19:00 — Resumen diario por excepción + patrones ───────────────
  cron.schedule('0 19 * * 1-5', async () => {
    try {
      const fecha = t.today();
      if (db.isFeriado(fecha)) return;
      await dm(target(), resumenDiario(fecha));

      // Patrones multi-día (cada patrón por persona se avisa 1 vez por semana)
      const alertas = detectarPatrones(soloUsers);
      if (alertas.length) {
        await dm(target(), `🔍 *Patrones detectados* _(últimos 10 días hábiles)_\n\n${alertas.join('\n')}`);
        console.log(`[patrones] ${alertas.length} alertas enviadas`);
      }
      console.log('[scheduler] Resumen diario enviado');
    } catch (err) { console.error('[scheduler] Resumen 19:00:', err); }
  }, { timezone: t.TZ });

  // ─── Lunes 09:00 — Resumen ejecutivo ────────────────────────────────
  cron.schedule('0 9 * * 1', async () => {
    try {
      const texto = resumenEjecutivo();
      if (texto) await dm(target(), texto);
      console.log('[scheduler] Resumen ejecutivo enviado');
    } catch (err) { console.error('[scheduler] Ejecutivo lunes:', err); }
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
  console.log(`  → Recordatorios cada ${CFG.INTERVALO}': entrada (tope ${CFG.TOPE_ENTRADA}'), almuerzo (13:30-15:00), fin almuerzo, cierre (auto a los ${CFG.TIMEOUT_CIERRE}')`);
  console.log('  → Presencia Slack: cada 15 min en horario laboral de cada persona');
  console.log('  → Pings dirigidos: solo con modo activado por admin');
  console.log('  → Resumen diario (solo anomalías) + patrones: L-V 19:00');
  console.log('  → Resumen ejecutivo: lunes 09:00');
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

module.exports = { setupScheduler, CFG };
