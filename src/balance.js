const t = require('./time');
const db = require('./database');

/**
 * Resumen semanal de UNA persona contra SU carga horaria.
 * El balance arranca cada lunes. Devuelve datos estructurados que
 * web.js renderiza en HTML y app.js en blocks de Slack.
 */
const semanaUsuario = (user) => {
  const desde = t.weekStart();
  const hoy = t.today();
  const carga = user.carga_horaria;

  const dias = [];
  let trabajadas = 0;

  let d = t.dayjs(desde);
  const end = t.dayjs(hoy);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    const fecha = d.format('YYYY-MM-DD');
    if (t.isWeekday(fecha)) {
      const dia = db.getDia(user.slack_id, fecha);
      const horas = db.horasDia(dia);
      const exento = db.isExento(user.slack_id, fecha);
      const esHoy = fecha === hoy;
      const enCurso = esHoy && dia.entrada && !dia.salida;

      let semaforo, detalle;
      if (exento) {
        semaforo = '🏖️'; detalle = 'Novedad';
      } else if (enCurso) {
        semaforo = '⏳'; detalle = 'En curso';
      } else if (horas === null) {
        semaforo = '⚪'; detalle = 'Sin registro';
      } else if (horas >= carga) {
        semaforo = '🟢'; detalle = 'Completo';
      } else if (horas >= carga - 1) {
        semaforo = '🟡'; detalle = `${Math.round((carga - horas) * 60)} min pendientes`;
      } else {
        semaforo = '🔴'; detalle = `${Math.round((carga - horas) * 10) / 10}hs pendientes`;
      }

      dias.push({
        fecha, dia, horas, exento, enCurso, semaforo, detalle,
        label: t.dayjs(fecha).format('ddd DD/MM'),
        auto: dia.salida?.auto_closed === 1,
      });
      if (horas) trabajadas += horas;
    }
    d = d.add(1, 'day');
  }

  // Horas parciales de hoy si la jornada está en curso
  const hoyDia = db.getDia(user.slack_id, hoy);
  let parcialHoy = 0;
  if (hoyDia.entrada && !hoyDia.salida) {
    let mins = t.nowMin() - t.toMin(hoyDia.entrada.hora);
    if (hoyDia.almuerzo_inicio && hoyDia.almuerzo_fin) {
      mins -= t.toMin(hoyDia.almuerzo_fin.hora) - t.toMin(hoyDia.almuerzo_inicio.hora);
    } else if (hoyDia.almuerzo_inicio) {
      mins = t.toMin(hoyDia.almuerzo_inicio.hora) - t.toMin(hoyDia.entrada.hora);
    }
    parcialHoy = Math.max(0, mins / 60);
  }

  trabajadas = Math.round(trabajadas * 100) / 100;
  const esperadas = Math.round(db.diasEsperados(user.slack_id, desde, hoy) * carga * 100) / 100;
  const diff = Math.round((trabajadas + parcialHoy - esperadas) * 100) / 100;

  // Si va atrás y la jornada sigue abierta, ¿hasta qué hora quedarse hoy?
  let horaCompensa = null;
  if (diff < 0 && hoyDia.entrada && !hoyDia.salida) {
    const minSugerido = t.nowMin() + Math.round(Math.abs(diff) * 60);
    if (minSugerido < 23 * 60) horaCompensa = t.toHHMM(minSugerido);
  }

  return { desde, hoy, dias, trabajadas: Math.round((trabajadas + parcialHoy) * 10) / 10, esperadas, diff: Math.round(diff * 10) / 10, horaCompensa };
};

module.exports = { semanaUsuario };
