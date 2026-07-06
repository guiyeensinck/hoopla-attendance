const t = require('./time');
const db = require('./database');
const txt = require('./texts');

/**
 * Resumen diario POR EXCEPCIÓN: solo anomalías.
 * Si no hay ninguna → "Sin novedades, N presentes".
 */
const resumenDiario = (fecha) => {
  const dias = db.getDias(fecha, fecha);
  const presentes = dias.filter(d => d.entrada).length;

  const tardes = dias.filter(d => d.tarde_min > 0);
  const ausentes = db.faltantes(fecha);
  const autoCierres = dias.filter(d => d.auto_closed);
  const intentos = db.getIntentosMobile(fecha, fecha);
  const extras = db.getExtrasRange(fecha, fecha);

  const secciones = [];
  if (tardes.length) {
    secciones.push(`⏰ *Llegadas tarde (${tardes.length})*\n` +
      tardes.map(d => `• ${d.nombre} — entrada ${d.entrada} (+${d.tarde_min} min)`).join('\n'));
  }
  if (ausentes.length) {
    secciones.push(`❌ *Ausencias sin novedad (${ausentes.length})*\n` +
      ausentes.map(u => `• ${u.nombre}`).join('\n'));
  }
  if (autoCierres.length) {
    secciones.push(`🔒 *Auto-cierres sin respuesta (${autoCierres.length})*\n` +
      autoCierres.map(d => `• ${d.nombre} — salida ${d.salida}${d.corregido ? ` (corregida, era ${d.valor_original})` : ''}`).join('\n'));
  }
  if (intentos.length) {
    secciones.push(`📱 *Intentos de fichaje mobile bloqueados (${intentos.length})*\n` +
      intentos.map(i => `• ${i.nombre || i.user_id} — ${i.hora}`).join('\n'));
  }
  if (extras.length) {
    secciones.push(`⏳ *Horas extra del día*\n` +
      extras.map(e => `• ${e.nombre} — ${e.bloques * 0.5}hs (${e.bloques} bloque${e.bloques > 1 ? 's' : ''})`).join('\n'));
  }

  const header = `📋 *Resumen del día — ${t.fmtDate(fecha)}*`;
  if (!secciones.length) return `${header}\n${txt.resumen.sinNovedades(presentes)}`;
  return `${header}\n${presentes} presentes.\n\n${secciones.join('\n\n')}`;
};

/** Reporte por persona: horas vs esperadas, tardes, auto-cierres, extras */
const reportePersonas = (titulo, from, to) => {
  const resumen = db.resumenPersonas(from, to);
  if (!resumen.length) return `${titulo}\n_No hay personas trackeadas._`;
  const lineas = resumen.map(p => {
    const diff = Math.round((p.horas - p.esperadas) * 10) / 10;
    const icono = diff >= 0 ? '🟢' : diff >= -2 ? '🟡' : '🔴';
    const partes = [`${p.horas}/${p.esperadas}hs (${diff >= 0 ? '+' : ''}${diff})`];
    if (p.tardes) partes.push(`${p.tardes} tarde${p.tardes > 1 ? 's' : ''}`);
    if (p.autoCierres) partes.push(`${p.autoCierres} auto-cierre${p.autoCierres > 1 ? 's' : ''}`);
    if (p.extraHs) partes.push(`${p.extraHs}hs extra`);
    return `${icono} *${p.nombre}* — ${partes.join(' · ')}`;
  });
  return `${titulo} _(${t.fmtRange(from, to)})_\n\n${lineas.join('\n')}`;
};

module.exports = { resumenDiario, reportePersonas };
