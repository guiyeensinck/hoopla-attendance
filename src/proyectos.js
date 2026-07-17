const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { normalize } = require('./dmrouter');

/**
 * Time tracking interno por proyectos.
 *
 * La imputación se engancha al hábito que ya existe: al registrar la
 * salida, el bot pregunta "¿en qué trabajaste hoy?" y la persona
 * responde en el mismo DM con texto libre. El parser entiende lenguaje
 * natural: "2 horas Jumbo, 30 minutos Coral, el resto en Interno".
 * Si algo no matchea, el bot pregunta mostrando las opciones.
 * También hay un formulario web con selects (botón "Cargar con clicks").
 * Mandar una nueva imputación el mismo día reemplaza la anterior.
 */

// Categorías de trabajo (opcionales al imputar): "Jumbo 3 redes"
// "ajustes" = retrabajo (idas y vueltas, correcciones) — mide el derroche
const CATEGORIAS = ['campaña', 'redes', 'website', 'branding', 'btl', 'ajustes', 'otro'];
const CATEGORIA_ALIAS = { campana: 'campaña', web: 'website', pagina: 'website', ajuste: 'ajustes', correcciones: 'ajustes', correccion: 'ajustes', rework: 'ajustes' };

const normalizarCategoria = (token) => {
  if (!token) return null;
  const n = normalize(token);
  const canonica = CATEGORIA_ALIAS[n] || CATEGORIAS.find(c => normalize(c) === n);
  return canonica || undefined; // undefined = token presente pero inválido
};

// ─── Parser de lenguaje natural ─────────────────────────────────────
// Cada persona escribe distinto: "2 horas jumbo", "jumbo 2", "0.5 en
// coral", "30 minutos narvaez", "1/2 hora en pitch", "el resto en interno".

// Frases hechas → número + unidad, para que el resto del parser sea uniforme
const preprocesar = (s) => s
  .replace(/\bhora\s+y\s+media\b/gi, '1.5 horas')
  .replace(/\bmedia\s+hora\b/gi, '0.5 horas')
  .replace(/\bun\s+cuarto\s+de\s+hora\b/gi, '0.25 horas')
  .replace(/\b(?:1\s*\/\s*2|½)\s*(?:hora|hs|h)\b/gi, '0.5 horas')
  .replace(/\buna\s+hora\b/gi, '1 hora')
  // muletillas de entrada que no aportan: "estuve 2 horas en...", "le dediqué..."
  .replace(/^(?:hoy\s+)?(?:estuve|trabaje|trabajé|hice|dedique|dediqué|le\s+meti|le\s+metí|puse|meti|metí)\s+/i, '');

// Cantidad: "2", "2.5", "2,5", "3/4" + unidad opcional (horas o minutos) + "y media/cuarto"
const CANT_SRC = String.raw`(\d+(?:[.,]\d+)?|\d+\s*\/\s*\d+)\s*(hs\b\.?|h\b|horas?\b|min\b\.?|mins?\b|minutos?\b)?(?:\s+y\s+(media|cuarto)\b)?`;
const RE_CANT_PRIMERO = new RegExp(`^${CANT_SRC}\\s+(.+)$`, 'i');
const RE_CANT_FINAL = new RegExp(`^(.+?)\\s+${CANT_SRC}(?:\\s+([a-záéíóúñü]+))?$`, 'i');
const RE_RESTO = /^(?:el\s+)?resto(?:\s+de(?:\s+las)?\s+horas)?(?:\s+(?:en|a|al|para|de))?\s+(.+)$/i;

const cantidadAHoras = (numStr, unidad, extra) => {
  let v;
  const frac = numStr.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) v = parseInt(frac[1], 10) / parseInt(frac[2], 10);
  else v = parseFloat(numStr.replace(',', '.'));
  if (unidad && /^min|^m\b/i.test(unidad.trim())) v = v / 60;
  if (extra === 'media') v += 0.5;
  if (extra === 'cuarto') v += 0.25;
  return Math.round(v * 100) / 100;
};

// Saca preposiciones/artículos al frente del nombre y puntuación al final
const limpiarNombre = (s) => {
  let n = (s || '').trim().replace(/[.!?…]+$/, '');
  let prev;
  do { prev = n; n = n.replace(/^(?:en|a|al|de|del|para|con|el|la|los|las|proyecto|cliente)\s+/i, ''); } while (n !== prev);
  return n.trim();
};

// Si la última palabra del nombre es una categoría válida, la separa
const extraerCategoria = (nombre) => {
  const palabras = nombre.split(/\s+/);
  if (palabras.length < 2) return { nombre, categoria: null };
  const cat = normalizarCategoria(palabras[palabras.length - 1]);
  if (cat) return { nombre: palabras.slice(0, -1).join(' '), categoria: cat };
  return { nombre, categoria: null };
};

const parsearSegmento = (seg) => {
  seg = preprocesar(seg.trim());
  if (!seg) return null;

  let m = seg.match(RE_RESTO);
  if (m) {
    const { nombre, categoria } = extraerCategoria(limpiarNombre(m[1]));
    return nombre ? { resto: true, nombre, categoria } : null;
  }

  // "2 horas gustavo santaolalla" / "0.5 en red bull" / "30 minutos narvaez"
  m = seg.match(RE_CANT_PRIMERO);
  if (m) {
    const horas = cantidadAHoras(m[1], m[2], m[3]);
    const { nombre, categoria } = extraerCategoria(limpiarNombre(m[4]));
    return nombre && horas > 0 && horas <= 16 ? { nombre, horas, categoria } : null;
  }

  // "jumbo 3" / "jumbo 3 redes" / "gustavo santaolalla 2.5 hs"
  m = seg.match(RE_CANT_FINAL);
  if (m) {
    const horas = cantidadAHoras(m[2], m[3], m[4]);
    const nombre = limpiarNombre(m[1]);
    const categoria = normalizarCategoria(m[5]);
    if (categoria === undefined) return null; // palabra final que no es categoría → no lo entiendo
    return nombre && horas > 0 && horas <= 16 ? { nombre, horas, categoria } : null;
  }

  return null;
};

/**
 * Interpreta un mensaje como imputación. Devuelve { pares, fallos }:
 * pares = [{nombre, horas, categoria} | {resto, nombre, categoria}],
 * fallos = segmentos que no se entendieron. Si pares queda vacío, el
 * mensaje no era una imputación.
 */
const parsearImputacion = (raw) => {
  const partes = (raw || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  const pares = [], fallos = [];
  // Un nombre con dígitos delata un parseo malo ("jumbo 2 y disco" horas 3)
  const esLimpio = (par) => par && !/\d/.test(par.nombre);

  for (let p of partes) {
    p = p.replace(/^y\s+/i, '').trim();
    if (!p) continue;
    let par = parsearSegmento(p);

    // "2 horas y media en jumbo y 1 hora en disco" → probar cada " y "
    // como punto de corte hasta que ambos lados parseen limpio
    if (!esLimpio(par) && /\s+y\s+/i.test(p)) {
      let corto = false;
      for (const m of p.matchAll(/\s+y\s+/gi)) {
        const a = parsearSegmento(p.slice(0, m.index));
        const b = parsearSegmento(p.slice(m.index + m[0].length));
        if (esLimpio(a) && esLimpio(b)) { pares.push(a, b); corto = true; break; }
      }
      if (corto) continue;
    }

    if (esLimpio(par)) pares.push(par);
    else fallos.push(p);
  }
  return { pares, fallos };
};

// ─── Matching difuso de proyectos ───────────────────────────────────
// No todos escriben igual: "autopistas", "ausol", "red bull", "hoopla".

// Apodos frecuentes → nombre del catálogo
const ALIAS_PROYECTOS = {
  'hoopla': 'interno',
  'nuevos negocios': 'pitch', 'nuevo negocio': 'pitch', 'new business': 'pitch', 'newbiz': 'pitch',
};

const levenshtein = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
};

const sinEspacios = (s) => s.replace(/\s+/g, '');

/**
 * Busca a qué proyecto activo se refiere un texto. Devuelve:
 * { proyecto } si hay match claro, { candidatos: [...] } si hay varios
 * posibles (o ninguno: candidatos vacío).
 */
const matchProyecto = (nombre) => {
  const activos = db.getProyectos(true);
  let n = normalize(nombre);
  if (ALIAS_PROYECTOS[n]) n = ALIAS_PROYECTOS[n];

  // 1. Exacto por nombre (con o sin espacios: "red bull" ↔ "Redbull")
  const exacto = activos.find(p => normalize(p.nombre) === n || sinEspacios(normalize(p.nombre)) === sinEspacios(n));
  if (exacto) return { proyecto: exacto };

  // 2. Por cliente ("autopistas" → todos los proyectos de ese cliente)
  const porCliente = activos.filter(p => {
    const c = normalize(p.cliente || '');
    return c && (c === n || c.startsWith(n) || n.startsWith(c));
  });
  if (porCliente.length === 1) return { proyecto: porCliente[0] };
  if (porCliente.length > 1) return { candidatos: porCliente };

  // 3. Prefijo / contiene, por nombre
  const pref = activos.filter(p => {
    const pn = normalize(p.nombre);
    return pn.startsWith(n) || n.startsWith(pn) || pn.includes(n);
  });
  if (pref.length === 1) return { proyecto: pref[0] };
  if (pref.length > 1) return { candidatos: pref };

  // 4. Typos: distancia de edición ≤ 2 (sin espacios, nombres de 4+ letras)
  const cerca = activos.filter(p => {
    const pn = sinEspacios(normalize(p.nombre));
    const nn = sinEspacios(n);
    return Math.min(pn.length, nn.length) >= 4 && levenshtein(pn, nn) <= 2;
  });
  if (cerca.length === 1) return { proyecto: cerca[0] };
  return { candidatos: cerca };
};

/** Compat: match claro o null (lo usa el admin para archivar) */
const buscarProyecto = (nombre) => matchProyecto(nombre).proyecto || null;

// ─── Imputación ─────────────────────────────────────────────────────

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

/** Horas de referencia del día: trabajadas si el día cerró, si no la carga horaria */
const horasBase = (user, fecha) =>
  db.horasDia(db.getDia(user.slack_id, fecha)) ?? user.carga_horaria;

const catalogoLineas = () => {
  const grupos = {};
  for (const p of db.getProyectos(true)) (grupos[p.cliente || 'Otros'] ||= []).push(p.nombre);
  return Object.keys(grupos).sort().map(cli => `*${cli}*: ${grupos[cli].join(', ')}`).join('\n');
};

/** Guarda pares resueltos y arma el resumen de confirmación */
const guardarYResumir = (user, fecha, finales, origen = 'chat') => {
  const habia = db.setImputaciones(user.slack_id, fecha, finales);
  const total = Math.round(finales.reduce((s, p) => s + p.horas, 0) * 10) / 10;
  const trabajadas = db.horasDia(db.getDia(user.slack_id, fecha));
  const detalle = finales.map(p => `${p.nombre} ${p.horas}hs${p.categoria ? ` _(${p.categoria})_` : ''}`).join(' · ');
  const comparacion = trabajadas != null ? ` de ${trabajadas}hs trabajadas` : '';
  const aviso = trabajadas != null && Math.abs(total - trabajadas) > 0.5
    ? `\n⚠️ Ojo: imputaste ${total}hs y trabajaste ${trabajadas}hs — si fue sin querer, mandame la corrección.` : '';
  const desde = origen === 'web' ? ' (desde la web)' : '';
  return `🗂️ Imputado${desde} para el ${t.fmtDate(fecha)}: ${detalle}\nTotal: *${total}hs*${comparacion}.${habia ? ' _(reemplacé lo que habías cargado)_' : ''}${aviso}`;
};

/**
 * Procesa un mensaje de imputación. Devuelve el texto de respuesta,
 * o null si el mensaje no era una imputación (sigue el flujo normal).
 * Si no puede matchear algo, pregunta mostrando las opciones y un
 * link al formulario web.
 */
const procesarImputacion = (user, texto) => {
  if (!db.getProyectos(true).length) return null;
  const { pares, fallos } = parsearImputacion(texto);
  if (!pares.length) return null;

  const resueltos = [], dudas = [];
  let resto = null;
  for (const p of pares) {
    const m = matchProyecto(p.nombre);
    if (!m.proyecto) { dudas.push({ nombre: p.nombre, candidatos: m.candidatos }); continue; }
    const r = { proyecto_id: m.proyecto.id, nombre: m.proyecto.nombre, horas: p.horas, categoria: p.categoria };
    if (p.resto) resto = r; else resueltos.push(r);
  }

  if (dudas.length || fallos.length) {
    const lineas = [txt.imputar.preguntaIntro];
    for (const d of dudas) {
      lineas.push(d.candidatos.length
        ? txt.imputar.ambiguo(d.nombre, d.candidatos.map(c => c.nombre))
        : txt.imputar.noEncontrado(d.nombre));
    }
    for (const f of fallos) lineas.push(txt.imputar.noEntendi(f));
    lineas.push('', `Proyectos disponibles:\n${catalogoLineas()}`);
    const url = `${process.env.APP_URL || ''}/imputar/${db.createToken(user.slack_id, 'imputar')}`;
    lineas.push('', `${txt.imputar.reintento}\n👉 <${url}|Cargar mis horas con clicks>`);
    return lineas.join('\n');
  }

  const fecha = fechaDestino(user.slack_id);

  if (resto) {
    const base = horasBase(user, fecha);
    const usadas = resueltos.reduce((s, p) => s + p.horas, 0);
    const sobra = Math.round((base - usadas) * 100) / 100;
    if (sobra <= 0) return txt.imputar.restoNegativo(base);
    resto.horas = sobra;
    resueltos.push(resto);
  }

  // Duplicados de proyecto+categoría en el mismo mensaje → se suman
  const porClave = {};
  for (const r of resueltos) {
    const clave = `${r.proyecto_id}|${r.categoria || ''}`;
    porClave[clave] = porClave[clave] || { ...r, horas: 0 };
    porClave[clave].horas += Math.round(r.horas * 100) / 100;
  }
  const finales = Object.values(porClave);

  return guardarYResumir(user, fecha, finales);
};

// ─── Vistas / prompts ───────────────────────────────────────────────

const btnImputarWeb = () => ({
  type: 'actions',
  elements: [
    { type: 'button', action_id: 'imputar_web', text: { type: 'plain_text', text: txt.imputar.btnWeb } },
    { type: 'button', action_id: 'semana_web', text: { type: 'plain_text', text: txt.imputar.btnSemanaWeb } },
  ],
});

/** Resumen de proyectos para una persona ("proyectos" por DM) */
const vistaProyectos = (user) => {
  const activos = db.getProyectos(true);
  if (!activos.length) return { text: '🗂️ Todavía no hay proyectos cargados. (Los crea el admin con `admin proyecto agregar Nombre`.)' };

  const fecha = fechaDestino(user.slack_id);
  const hoy = db.getImputacionesDia(user.slack_id, fecha);
  const semana = db.horasUsuarioPorProyecto(user.slack_id, t.weekStart(), t.today());

  const lineas = [`🗂️ *Proyectos activos:*\n${catalogoLineas()}`];
  lineas.push('', `Para imputar tu día contame en qué trabajaste, por ejemplo: \`2 horas ${activos[0].nombre}, media hora ${activos[1]?.nombre || 'Interno'}, el resto en ${activos[2]?.nombre || 'Interno'}\``);
  lineas.push(`_Podés agregar la categoría de trabajo: \`${activos[0].nombre} 4 redes\` (${CATEGORIAS.join(', ')})_`);
  if (hoy.length) {
    lineas.push('', `*Tu ${t.fmtDate(fecha)}:* ${hoy.map(i => `${i.nombre} ${i.horas}hs`).join(' · ')}`);
  }
  if (semana.length) {
    lineas.push(`*Tu semana:* ${semana.map(i => `${i.nombre} ${i.horas}hs`).join(' · ')}`);
  }
  const text = lineas.join('\n');
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      btnImputarWeb(),
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_El botón te da un formulario con selects para cargar el detalle del día._' }] },
    ],
  };
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
    const text = `🗂️ *¿En qué trabajaste hoy${horas != null ? ` (${horas}hs)` : ''}?*\nContame con tus palabras, por ejemplo: \`2 horas ${activos[0].nombre}${activos[1] ? `, media hora ${activos[1].nombre}` : ''}${activos[2] ? `, el resto en ${activos[2].nombre}` : ''}\`\nO cargá el detalle con clicks tocando el botón. 👇`;
    await client.chat.postMessage({
      channel: user.slack_id,
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        btnImputarWeb(),
        { type: 'context', elements: [{ type: 'mrkdwn', text: `_Escribí *proyectos* para ver el catálogo. Categorías: ${CATEGORIAS.join(', ')}_` }] },
      ],
    });
  } catch (e) {
    console.error('[proyectos] No pude mandar el prompt de imputación:', e.message);
  }
};

module.exports = {
  CATEGORIAS, normalizarCategoria, parsearImputacion, matchProyecto, buscarProyecto,
  fechaDestino, horasBase, guardarYResumir, procesarImputacion, vistaProyectos, promptImputacion,
};
