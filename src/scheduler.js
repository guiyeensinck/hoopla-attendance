const cron = require('node-cron');
const fs = require('fs');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { resumenDiario, reportePersonas, resumenEjecutivo } = require('./reports');
const { detectarPatrones } = require('./patrones');
const { promptImputacion } = require('./proyectos');
const pruebas = require('./pruebas');
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
  // Cierre: a su horario de salida se le pregunta "¿terminaste?"; tiene
  // pruebas.TIEMPOS.respuesta (3') para contestar. Si dice "sigo", se le
  // vuelve a preguntar cada pruebas.TIEMPOS.sigo (20').
  CIERRE_LIMITE: 23 * 60 + 50,      // 23:50 — ninguna jornada queda abierta de un día para el otro
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
  // La salida se estampa en la ÚLTIMA ACTIVIDAD EN SLACK (presencia activa o
  // mensajes/reacciones en canales — no la interacción con el bot). Detalle
  // del cálculo en db.horaAutoCierre.
  const autoCerrar = async (user, fecha, cierre) => {
    const uid = user.slack_id;
    const { hora, motivo } = db.horaAutoCierre(user, fecha, cierre);

    // El almuerzo solo se imputa si la salida quedó después de las 14:00
    if (t.toMin(hora) >= 14 * 60) db.imputarAlmuerzo(user, fecha);
    db.registrar(user, fecha, 'salida', hora, 'auto', {
      auto_closed: true,
      nota: { actividad: 'auto_closed_ultima_actividad', respuesta: 'auto_closed_ultima_respuesta', sin_datos: 'auto_closed_sin_respuesta' }[motivo],
    });
    db.setCierre(uid, fecha, { estado: 'cerrado' });
    const texto = txt.cierre.autoCerrado(hora, motivo);
    await dm(uid, texto, [
      { type: 'section', text: { type: 'mrkdwn', text: texto } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: txt.cierre.btnReclamo }, action_id: 'reclamo_abrir', value: fecha },
      ] },
    ]);
    await promptImputacion(app.client, user, fecha);
    console.log(`[cierre] Auto-cierre de ${user.nombre} → ${hora} (${motivo})`);
  };

  // "¿Terminaste?" con dos botones. primera = la pregunta de su horario de salida
  const preguntarCierre = async (user, fecha, primera) => {
    const uid = user.slack_id;
    const hora = t.currentTime();
    const { respuesta } = pruebas.tiempos(uid);
    db.setCierre(uid, fecha, { estado: 'preguntado', pregunta_hora: hora, ...(primera ? { dm_hora: hora } : {}) });
    const texto = primera ? txt.cierre.pregunta(user.hora_salida, respuesta) : txt.cierre.preguntaSigo(respuesta);
    await dm(uid, texto, [
      { type: 'section', text: { type: 'mrkdwn', text: texto } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: txt.cierre.btnTermine }, style: 'primary', action_id: 'cierre_salida' },
        { type: 'button', text: { type: 'plain_text', text: txt.cierre.btnSigo }, action_id: 'cierre_sigo' },
      ] },
    ]);
    console.log(`[cierre] ¿Terminaste? (${primera ? 'horario' : 'seguimiento'}) → ${user.nombre}`);
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

  // ─── Tick por minuto ───────────────────────────────────────────────
  const tick = async () => {
    const fecha = t.today();
    const habil = t.isWeekday(fecha) && !db.isFeriado(fecha);
    const nowM = t.nowMin();
    const faltantesBatch = [];

    // Personas en modo prueba: corren siempre (también finde/feriado)
    const usuarios = habil ? trackedActivos(fecha) : [];
    for (const uid of pruebas.uids()) {
      const u = db.getUser(uid);
      if (u?.trackeado && !usuarios.some(x => x.slack_id === uid)) usuarios.push(u);
    }

    for (const base of usuarios) {
      const uid = base.slack_id;
      const prueba = pruebas.get(uid);
      // Horario efectivo de hoy (viernes 17:30); en prueba, la salida es la que fijó el admin
      const user = prueba ? { ...db.horarioDia(base, fecha), hora_salida: prueba.salida } : db.horarioDia(base, fecha);
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

        // En prueba solo corre el flujo de cierre (sin recordatorios de entrada/almuerzo)
        if (!prueba) {
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
        }

        // 5. Horario de salida: "¿Terminaste?" (3' para contestar)
        if (dia.entrada && !dia.salida && nowM >= salidaM && nowM <= salidaM + VENTANA_CIERRE && !db.getCierre(uid, fecha)) {
          await preguntarCierre(user, fecha, true);
        }

        // 6. Estados del cierre
        const cierre = db.getCierre(uid, fecha);
        if (!cierre || cierre.estado === 'cerrado') continue;

        // La persona marcó salida por otra vía → cerrar el flujo
        if (dia.salida) { db.setCierre(uid, fecha, { estado: 'cerrado' }); continue; }

        const { respuesta, sigo } = pruebas.tiempos(uid);
        if (nowM >= CFG.CIERRE_LIMITE) {
          await autoCerrar(user, fecha, cierre);
        } else if (cierre.estado === 'preguntado' || cierre.estado === 'esperando') {
          // Sin respuesta a tiempo → auto-cierre por última actividad en Slack
          // ('esperando' = estado del flujo viejo, por si quedó uno abierto al deployar)
          if (nowM >= t.toMin(cierre.pregunta_hora || cierre.dm_hora) + respuesta) await autoCerrar(user, fecha, cierre);
        } else if (cierre.estado === 'extendido') {
          // Dijo "sigo trabajando" → volver a preguntar a los 20'
          if (nowM >= t.toMin(cierre.ultima_respuesta) + sigo) await preguntarCierre(user, fecha, false);
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

  // Todos los días: el tick se saltea finde/feriados salvo para quien está en modo prueba
  cron.schedule('* * * * *', () => tick().catch(e => console.error('[scheduler] tick:', e)), { timezone: t.TZ });
  setupScheduler._tick = tick; // expuesto para tests
  pruebas.setTick(tick);

  // ─── Actividad en Slack: presencia cada 2 min (≈32 personas → ~16 llamadas/min, tier 3 de Slack) ─
  cron.schedule('*/2 * * * *', () => runPresenceCheck(app, soloUsers).catch(e => console.error('[presencia]', e)), { timezone: t.TZ });

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
  console.log(`  → Recordatorios cada ${CFG.INTERVALO}': entrada (tope ${CFG.TOPE_ENTRADA}'), almuerzo (13:30-15:00), fin almuerzo`);
  console.log(`  → Cierre: "¿terminaste?" a su salida (viernes ${db.SALIDA_VIERNES}), ${pruebas.TIEMPOS.respuesta}' para contestar; "sigo" → repregunta cada ${pruebas.TIEMPOS.sigo}'`);
  console.log('  → Actividad Slack: presencia cada 2 min (L-V 07:00-23:00) + mensajes/reacciones en canales');
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
