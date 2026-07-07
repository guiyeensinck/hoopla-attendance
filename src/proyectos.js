const t = require('./time');
const db = require('./database');
const { normalize } = require('./dmrouter');

/**
 * Time tracking interno por proyectos.
 *
 * La imputación se engancha al hábito que ya existe: al registrar la
 * salida, el bot pregunta "¿en qué trabajaste hoy?" y la persona
 * responde en el mismo DM con texto libre: "Nike 4, Quilmes 2.5".
 * Mandar una nueva imputación el mismo día reemplaza la anterior.
 */

/**
 * Intenta interpretar un mensaje como imputación: pares "nombre horas"
 * separados por coma. Devuelve [{nombre, horas}] o null si no matchea.
 */
const parsearImputacion = (raw) => {
  const partes = (raw || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!partes.length) return null;
  const pares = [];
  for (const p of partes) {
    const m = p.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:hs?|horas?)?$/i);
    if (!m) return null;
    const horas = parseFloat(m[2].replace(',', '.'));
    if (!(horas > 0 && horas <= 16)) return null;
    pares.push({ nombre: m[1].trim(), horas });
  }
  return pares;
};

/** Busca un proyecto activo por nombre (sin distinguir mayúsculas/acentos) */
const buscarProyecto = (nombre) => {
  const n = normalize(nombre);
  const activos = db.getProyectos(true);
  const exacto = activos.find(p => normalize(p.nombre) === n);
  if (exacto) return exacto;
  const parciales = activos.filter(p => normalize(p.nombre).startsWith(n));
  return parciales.length === 1 ? parciales[0] : null;
};

/**
 * A qué fecha aplica una imputación: hoy si ya hay salida (o todavía
 * no hay nada mejor); si no hay salida hoy pero el último día hábil
 * tiene salida y quedó sin imputar, aplica a ese día (contestó el
 * prompt a la mañana siguiente).
 */
const fechaDestino = (userId) => {
  const hoy = t.today();
  if (db.getDia(userId, hoy).salida) return hoy;
  const anterior = t.haceDiasHabiles(1);
  if (db.getDia(userId, anterior).salida && !db.hayImputaciones(userId, anterior)) return anterior;
  return hoy;
};

/**
 * Procesa un mensaje de imputación. Devuelve el texto de respuesta,
 * o null si el mensaje no era una imputación (sigue el flujo normal).
 */
const procesarImputacion = (user, texto) => {
  if (!db.getProyectos(true).length) return null;
  const pares = parsearImputacion(texto);
  if (!pares) return null;

  const resueltos = [];
  for (const p of pares) {
    const proyecto = buscarProyecto(p.nombre);
    if (!proyecto) {
      const activos = db.getProyectos(true).map(x => x.nombre).join(', ');
      return `⚠️ No encontré el proyecto *${p.nombre}*.\nProyectos activos: ${activos}.\nFormato: \`Nike 4, Interno 1.5\``;
    }
    resueltos.push({ proyecto_id: proyecto.id, nombre: proyecto.nombre, horas: p.horas });
  }

  // Duplicados en el mismo mensaje → se suman
  const porId = {};
  for (const r of resueltos) {
    porId[r.proyecto_id] = porId[r.proyecto_id] || { ...r, horas: 0 };
    porId[r.proyecto_id].horas += r.horas;
  }
  const finales = Object.values(porId);

  const fecha = fechaDestino(user.slack_id);
  const habia = db.setImputaciones(user.slack_id, fecha, finales);

  const total = Math.round(finales.reduce((s, p) => s + p.horas, 0) * 10) / 10;
  const trabajadas = db.horasDia(db.getDia(user.slack_id, fecha));
  const detalle = finales.map(p => `${p.nombre} ${p.horas}hs`).join(' · ');
  const comparacion = trabajadas != null ? ` de ${trabajadas}hs trabajadas` : '';
  const aviso = trabajadas != null && Math.abs(total - trabajadas) > 0.5
    ? `\n⚠️ Ojo: imputaste ${total}hs y trabajaste ${trabajadas}hs — si fue sin querer, mandame la corrección.` : '';

  return `🗂️ Imputado para el ${t.fmtDate(fecha)}: ${detalle}\nTotal: *${total}hs*${comparacion}.${habia ? ' _(reemplacé lo que habías cargado)_' : ''}${aviso}`;
};

/** Resumen de proyectos para una persona ("proyectos" por DM) */
const vistaProyectos = (user) => {
  const activos = db.getProyectos(true);
  if (!activos.length) return '🗂️ Todavía no hay proyectos cargados. (Los crea el admin con `admin proyecto agregar Nombre`.)';

  const fecha = fechaDestino(user.slack_id);
  const hoy = db.getImputacionesDia(user.slack_id, fecha);
  const semana = db.horasUsuarioPorProyecto(user.slack_id, t.weekStart(), t.today());

  const lineas = [`🗂️ *Proyectos activos:* ${activos.map(p => p.nombre).join(', ')}`];
  lineas.push('', `Para imputar tu día respondeme: \`${activos[0].nombre} 4, ${activos[1]?.nombre || 'Interno'} 2\``);
  if (hoy.length) {
    lineas.push('', `*Tu ${t.fmtDate(fecha)}:* ${hoy.map(i => `${i.nombre} ${i.horas}hs`).join(' · ')}`);
  }
  if (semana.length) {
    lineas.push(`*Tu semana:* ${semana.map(i => `${i.nombre} ${i.horas}hs`).join(' · ')}`);
  }
  return lineas.join('\n');
};

/**
 * Prompt post-salida: se manda una sola vez por día (dedupe en avisos),
 * solo si hay proyectos activos y la persona aún no imputó.
 */
const promptImputacion = async (client, user, fecha) => {
  try {
    const activos = db.getProyectos(true);
    if (!activos.length) return;
    if (db.hayImputaciones(user.slack_id, fecha)) return;
    if (db.avisoEnviado(user.slack_id, fecha, 'prompt_imputacion')) return;
    db.marcarAviso(user.slack_id, fecha, 'prompt_imputacion');

    const horas = db.horasDia(db.getDia(user.slack_id, fecha));
    await client.chat.postMessage({
      channel: user.slack_id,
      text: `🗂️ *¿En qué trabajaste hoy${horas != null ? ` (${horas}hs)` : ''}?*\nRespondeme con proyecto y horas, por ejemplo: \`${activos[0].nombre} 4${activos[1] ? `, ${activos[1].nombre} 2` : ''}\`\n_Proyectos: ${activos.map(p => p.nombre).join(', ')}_`,
    });
  } catch (e) {
    console.error('[proyectos] No pude mandar el prompt de imputación:', e.message);
  }
};

module.exports = { parsearImputacion, buscarProyecto, fechaDestino, procesarImputacion, vistaProyectos, promptImputacion };
