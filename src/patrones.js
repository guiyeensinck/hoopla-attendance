const t = require('./time');
const db = require('./database');
const { saldoMes } = require('./balance');

/**
 * Detección de patrones para el admin: cosas que no se ven en el día a
 * día pero sí mirando los últimos días hábiles. Cada patrón se alerta
 * como máximo UNA VEZ POR SEMANA por persona (dedupe en tabla avisos,
 * con fecha = lunes de la semana).
 */

// Umbrales — ajustables acá
const VENTANA_HABILES = 10;      // días hábiles hacia atrás que se analizan
const TARDE_MIN = 10;            // una llegada cuenta como "tarde" si superó estos minutos
const TARDES_ALERTA = 3;         // llegadas tarde en la ventana → alerta
const AUTO_CIERRES_ALERTA = 3;   // auto-cierres en la ventana → alerta
const SALDO_ALERTA_HS = -4;      // saldo mensual acumulado igual o peor → alerta
const PRESENCIA_BAJA_PCT = 30;   // un día cuenta como "fantasma" si estuvo activo menos de esto...
const PRESENCIA_MIN_CHECKS = 8;  // ...con al menos estos chequeos en el día (≈2hs de datos)
const PRESENCIA_DIAS_ALERTA = 3; // días fantasma en la ventana → alerta

/**
 * Analiza a todos los trackeados y devuelve las alertas NUEVAS de la
 * semana (las ya avisadas no se repiten).
 */
const detectarPatrones = (soloUsers = null) => {
  const hoy = t.today();
  const desde = t.haceDiasHabiles(VENTANA_HABILES);
  const semana = t.weekStart(); // dedupe semanal
  const alertas = [];

  for (const user of db.getTracked()) {
    if (soloUsers && !soloUsers.includes(user.slack_id)) continue;
    if (db.esSoloProyectos(user)) continue; // sin patrones de asistencia
    const uid = user.slack_id;
    const dias = db.getDias(desde, hoy, uid);

    const candidatos = [];

    // 1. Llegadas tarde recurrentes
    const tardes = dias.filter(d => d.tarde_min >= TARDE_MIN);
    if (tardes.length >= TARDES_ALERTA) {
      const prom = Math.round(tardes.reduce((s, d) => s + d.tarde_min, 0) / tardes.length);
      candidatos.push({ key: 'tardes', texto: `⏰ *${user.nombre}* — ${tardes.length} llegadas tarde (≥${TARDE_MIN} min, promedio +${prom}') en los últimos ${VENTANA_HABILES} días hábiles` });
    }

    // 2. Nunca marca salida (auto-cierres recurrentes)
    const autos = dias.filter(d => d.auto_closed);
    if (autos.length >= AUTO_CIERRES_ALERTA) {
      candidatos.push({ key: 'auto_cierres', texto: `🔒 *${user.nombre}* — ${autos.length} auto-cierres en los últimos ${VENTANA_HABILES} días hábiles (no marca su salida)` });
    }

    // 3. Deuda de horas acumulada en el mes
    const saldo = saldoMes(user);
    if (saldo.diff <= SALDO_ALERTA_HS) {
      candidatos.push({ key: 'saldo', texto: `📉 *${user.nombre}* — saldo del mes ${saldo.diff}hs (${saldo.trabajadas}/${saldo.esperadas}hs)` });
    }

    // 4. Fichó pero presencia muy baja (recurrente)
    const conEntrada = new Set(dias.filter(d => d.entrada).map(d => d.fecha));
    const fantasma = db.presenciaPorDia(uid, desde, hoy)
      .filter(p => conEntrada.has(p.fecha) && p.checks >= PRESENCIA_MIN_CHECKS && p.pct < PRESENCIA_BAJA_PCT);
    if (fantasma.length >= PRESENCIA_DIAS_ALERTA) {
      candidatos.push({ key: 'presencia', texto: `👻 *${user.nombre}* — fichó pero con presencia <${PRESENCIA_BAJA_PCT}% en Slack en ${fantasma.length} de los últimos ${VENTANA_HABILES} días hábiles` });
    }

    // Dedupe: cada patrón por persona se avisa una vez por semana
    for (const c of candidatos) {
      const tipo = `patron_${c.key}`;
      if (db.avisoEnviado(uid, semana, tipo)) continue;
      db.marcarAviso(uid, semana, tipo);
      alertas.push(c.texto);
    }
  }

  return alertas;
};

module.exports = { detectarPatrones };
