const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { saldoMes } = require('./balance');

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

  const header = `📋 *Resumen del día — ${t.fmtDate(fecha)}*`;
  if (!secciones.length) return `${header}\n${txt.resumen.sinNovedades(presentes)}`;
  return `${header}\n${presentes} presentes.\n\n${secciones.join('\n\n')}`;
};

const lineaPersona = (p) => {
  const diff = Math.round((p.horas - p.esperadas) * 10) / 10;
  const icono = diff >= 0 ? '🟢' : diff >= -2 ? '🟡' : '🔴';
  const partes = [`${p.horas}/${p.esperadas}hs (${diff >= 0 ? '+' : ''}${diff})`];
  if (p.tardes) partes.push(`${p.tardes} tarde${p.tardes > 1 ? 's' : ''}`);
  if (p.autoCierres) partes.push(`${p.autoCierres} auto-cierre${p.autoCierres > 1 ? 's' : ''}`);
  return `${icono} *${p.nombre}* — ${partes.join(' · ')}`;
};

/** Reporte por persona (agrupado por equipo si hay equipos cargados) */
const reportePersonas = (titulo, from, to) => {
  const resumen = db.resumenPersonas(from, to);
  if (!resumen.length) return `${titulo}\n_No hay personas trackeadas._`;

  const hayEquipos = resumen.some(p => p.equipo);
  let cuerpo;
  if (hayEquipos) {
    const grupos = {};
    for (const p of resumen) (grupos[p.equipo || 'Sin equipo'] ||= []).push(p);
    cuerpo = Object.keys(grupos).sort().map(eq => {
      const ps = grupos[eq];
      const horas = Math.round(ps.reduce((s, p) => s + p.horas, 0) * 10) / 10;
      const esperadas = Math.round(ps.reduce((s, p) => s + p.esperadas, 0) * 10) / 10;
      return `*── ${eq}* (${horas}/${esperadas}hs)\n${ps.map(lineaPersona).join('\n')}`;
    }).join('\n\n');
  } else {
    cuerpo = resumen.map(lineaPersona).join('\n');
  }
  return `${titulo} _(${t.fmtRange(from, to)})_\n\n${cuerpo}`;
};

/**
 * Ficha de una persona para el admin (contexto para 1:1s):
 * últimos 10 días hábiles + saldo del mes.
 */
const fichaPersona = (user) => {
  const hoy = t.today();
  const desde = t.haceDiasHabiles(10);
  const dias = db.getDias(desde, hoy, user.slack_id);

  const horas = Math.round(dias.reduce((s, d) => s + (d.horas || 0), 0) * 10) / 10;
  const esperadas = Math.round(db.diasEsperados(user.slack_id, desde, hoy) * user.carga_horaria * 10) / 10;
  const tardes = dias.filter(d => d.tarde_min > 0);
  const autos = dias.filter(d => d.auto_closed);
  const saldo = saldoMes(user);

  const entradas = dias.filter(d => d.entrada).map(d => t.toMin(d.entrada));
  const entradaProm = entradas.length ? t.toHHMM(Math.round(entradas.reduce((s, x) => s + x, 0) / entradas.length)) : '—';

  const pres = db.presenciaSummary(desde, hoy).find(p => p.user_id === user.slack_id);
  const novedades = db.getNovedadesRange(desde, hoy).filter(n => n.user_id === user.slack_id);

  const lineas = [
    `👤 *${user.nombre}*${user.equipo ? ` · ${user.equipo}` : ''}${user.es_admin ? ' · admin' : ''}`,
    `🕐 Horario: ${user.hora_entrada}–${user.hora_salida} (${user.carga_horaria}hs/día)`,
    '',
    `*Últimos 10 días hábiles* _(desde ${t.fmtDate(desde)})_`,
    `• Horas: *${horas}/${esperadas}hs* (${horas - esperadas >= 0 ? '+' : ''}${Math.round((horas - esperadas) * 10) / 10})`,
    `• Días con registro: ${dias.filter(d => d.entrada).length} · Entrada promedio: ${entradaProm}`,
    `• Llegadas tarde: ${tardes.length}${tardes.length ? ` (promedio +${Math.round(tardes.reduce((s, d) => s + d.tarde_min, 0) / tardes.length)}')` : ''}`,
    `• Auto-cierres: ${autos.length}`,
    `• Presencia Slack: ${pres ? `${pres.pct}% activo (${pres.checks} checks)` : 'sin datos'}`,
    '',
    `*Saldo del mes*: ${saldo.diff >= 0 ? '🟢 +' : saldo.diff >= -2 ? '🟡 ' : '🔴 '}${saldo.diff}hs (${saldo.trabajadas}/${saldo.esperadas}hs)`,
  ];

  const proyectos = db.horasUsuarioPorProyecto(user.slack_id, desde, hoy);
  if (proyectos.length) {
    lineas.push('', `*Por proyecto*: ${proyectos.map(p => `${p.nombre} ${p.horas}hs`).join(' · ')}`);
  }

  if (novedades.length) {
    lineas.push('', '*Novedades en el período*');
    lineas.push(...novedades.map(n => `• ${n.fecha} — ${txt.NOVEDADES[n.tipo] || n.tipo}${n.motivo ? ` (${n.motivo})` : ''}`));
  }
  return lineas.join('\n');
};

/** Horas por cliente → proyecto, con desglose por persona */
const reporteProyectos = (titulo, from, to) => {
  const totales = db.horasPorProyecto(from, to);
  if (!totales.length) return `${titulo} _(${t.fmtRange(from, to)})_\n_Sin horas imputadas en el período._`;
  const detalle = db.horasProyectoPersona(from, to);
  const totalGeneral = Math.round(totales.reduce((s, p) => s + p.horas, 0) * 10) / 10;

  const lineaProyecto = (p) => {
    const personas = detalle.filter(d => d.proyecto === p.nombre).map(d => `${d.persona} ${d.horas}`).join(' · ');
    return `  • *${p.nombre}* — ${p.horas}hs\n     ${personas}`;
  };

  const grupos = {};
  for (const p of totales) (grupos[p.cliente || 'Sin cliente'] ||= []).push(p);
  const bloques = Object.entries(grupos)
    .map(([cli, ps]) => ({ cli, ps, horas: Math.round(ps.reduce((s, p) => s + p.horas, 0) * 10) / 10 }))
    .sort((a, b) => b.horas - a.horas)
    .map(g => {
      const pct = totalGeneral ? Math.round((g.horas / totalGeneral) * 100) : 0;
      return `*${g.cli}* — ${g.horas}hs (${pct}%)\n${g.ps.map(lineaProyecto).join('\n')}`;
    });

  return `${titulo} _(${t.fmtRange(from, to)})_\n\n${bloques.join('\n\n')}\n\nTotal imputado: *${totalGeneral}hs*`;
};

/**
 * Resumen ejecutivo de los lunes: cómo cerró la semana pasada y qué
 * hay cargado para esta.
 */
const resumenEjecutivo = () => {
  const lunesPasado = t.dayjs(t.weekStart()).subtract(7, 'day').format('YYYY-MM-DD');
  const viernesPasado = t.dayjs(lunesPasado).add(4, 'day').format('YYYY-MM-DD');
  const resumen = db.resumenPersonas(lunesPasado, viernesPasado);
  if (!resumen.length) return null;

  const totHoras = Math.round(resumen.reduce((s, p) => s + p.horas, 0) * 10) / 10;
  const totEsperadas = Math.round(resumen.reduce((s, p) => s + p.esperadas, 0) * 10) / 10;
  const diff = Math.round((totHoras - totEsperadas) * 10) / 10;
  const tardes = resumen.reduce((s, p) => s + p.tardes, 0);
  const autos = resumen.reduce((s, p) => s + p.autoCierres, 0);

  const desvios = resumen
    .map(p => ({ ...p, diff: Math.round((p.horas - p.esperadas) * 10) / 10 }))
    .filter(p => p.diff < -1)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 3);

  const lineas = [
    `☀️ *Arranque de semana — resumen ejecutivo*`,
    '',
    `*Semana pasada* _(${t.fmtRange(lunesPasado, viernesPasado)})_`,
    `• Horas del equipo: *${totHoras}/${totEsperadas}hs* (${diff >= 0 ? '+' : ''}${diff})`,
    `• Llegadas tarde: ${tardes} · Auto-cierres: ${autos}`,
  ];

  if (desvios.length) {
    lineas.push(`• Mayores desvíos: ${desvios.map(p => `${p.nombre} (${p.diff}hs)`).join(' · ')}`);
  }

  // Equipos: horas por equipo si hay
  if (resumen.some(p => p.equipo)) {
    const grupos = {};
    for (const p of resumen) (grupos[p.equipo || 'Sin equipo'] ||= []).push(p);
    const porEquipo = Object.keys(grupos).sort().map(eq => {
      const h = Math.round(grupos[eq].reduce((s, p) => s + p.horas, 0) * 10) / 10;
      const e = Math.round(grupos[eq].reduce((s, p) => s + p.esperadas, 0) * 10) / 10;
      return `${eq} ${h}/${e}hs`;
    });
    lineas.push(`• Por equipo: ${porEquipo.join(' · ')}`);
  }

  // Clientes: top 5 de la semana pasada (rollup de sus proyectos)
  const clientes = db.horasPorCliente(lunesPasado, viernesPasado).slice(0, 5);
  if (clientes.length) {
    lineas.push(`• Por cliente: ${clientes.map(c => `${c.cliente} ${c.horas}hs`).join(' · ')}`);
  }

  // Esta semana: novedades ya cargadas
  const finSemana = t.dayjs(t.weekStart()).add(4, 'day').format('YYYY-MM-DD');
  const novedades = db.getNovedadesRange(t.weekStart(), finSemana);
  lineas.push('', `*Esta semana* _(${t.fmtRange(t.weekStart(), finSemana)})_`);
  if (novedades.length) {
    lineas.push(...novedades.map(n => `• ${t.dayjs(n.fecha).format('ddd DD/MM')} — ${txt.NOVEDADES[n.tipo] || n.tipo}: ${n.nombre || 'Todos'}${n.motivo ? ` (${n.motivo})` : ''}`));
  } else {
    lineas.push('• Sin novedades cargadas: semana completa para todo el equipo.');
  }

  return lineas.join('\n');
};

module.exports = { resumenDiario, reportePersonas, fichaPersona, resumenEjecutivo, reporteProyectos };
