const t = require('./time');
const db = require('./database');
const { semanaUsuario, saldoMes, semanaChecks } = require('./balance');
const { handleAdmin, USO } = require('./admin');
const { normalize } = require('./dmrouter');
const txt = require('./texts');
const { contextoSolicitudes } = require('./solicitudes');

/**
 * Modo conversacional (opcional): cuando un DM no matchea ningún comando
 * ni es una imputación clara, el bot responde con IA usando el contexto
 * real de la persona (marcaciones, horas, saldo, imputaciones) y puede
 * ACTUAR: tiene herramientas que ejecutan lo mismo que los comandos
 * (marcar, imputar, ver estado...; y para admins, todo "admin ..."). Lo
 * que muestra cada acción le llega a la persona tal cual (con botones y
 * links); la IA solo agrega lo que haga falta.
 *
 * Se activa seteando ANTHROPIC_API_KEY (Claude) u OPENAI_API_KEY
 * (ChatGPT) — si están las dos, gana Claude. Sin variable (o si la API
 * falla), se cae al menú de siempre — nunca rompe el flujo.
 */

const MODEL_ANTHROPIC = () => process.env.IA_MODEL || 'claude-haiku-4-5-20251001';
const MODEL_OPENAI = () => process.env.IA_MODEL || 'gpt-4o-mini';

const resumenDia = (user, fecha) => {
  const dia = db.getDia(user.slack_id, fecha);
  if (db.isExento(user.slack_id, fecha)) {
    const nov = db.getNovedadesFecha(fecha).find(n => n.user_id === user.slack_id || (!n.user_id && n.tipo === 'feriado'));
    return `${fecha}: no se trabaja (${nov?.tipo || 'novedad'})`;
  }
  if (!dia.entrada && !dia.salida) return `${fecha}: sin marcaciones`;
  const partes = [];
  for (const tipo of ['entrada', 'almuerzo_inicio', 'almuerzo_fin', 'salida']) {
    const r = dia[tipo];
    if (!r) { partes.push(`${tipo}: —`); continue; }
    let s = `${tipo}: ${r.hora}`;
    if (r.tarde_min > 0) s += ` (+${r.tarde_min}' tarde)`;
    if (r.anticipado_min > 0) s += ` (−${r.anticipado_min}' anticipado)`;
    if (r.auto_closed) s += r.corregido ? ` (auto-cierre corregido, era ${r.valor_original})` : ` (AUTO-CIERRE ${{ auto_closed_ultima_actividad: 'a su última actividad en Slack', auto_closed_ultima_respuesta: 'a su último "sigo trabajando"' }[r.nota] || 'a su horario'})`;
    partes.push(s);
  }
  const horas = db.horasDia(dia);
  if (horas != null) partes.push(`horas netas trabajadas: ${horas}hs`);
  const imp = db.getImputacionesDia(user.slack_id, fecha);
  if (imp.length) partes.push(`imputado a proyectos: ${imp.map(i => `${i.nombre} ${i.horas}hs${i.categoria ? ` (${i.categoria})` : ''}`).join(', ')} = ${Math.round(imp.reduce((s, i) => s + i.horas, 0) * 10) / 10}hs`);
  return `${fecha}: ${partes.join(' · ')}`;
};

const construirContexto = (user) => {
  const hoy = t.today();
  const ayer = t.haceDiasHabiles(1);
  const sem = semanaUsuario(user);
  const mes = saldoMes(user);
  // Días de esta semana (y el último hábil si es lunes) para poder explicar cada uno
  const diasSemana = [...new Set([...(ayer < t.weekStart() ? [ayer] : []), ...sem.dias.map(d => d.fecha)])];
  const proyectos = db.getProyectos(true).map(p => p.nombre).join(', ');
  return [
    `Ahora: ${t.now().format('dddd YYYY-MM-DD HH:mm')} (Buenos Aires)`,
    `Persona: ${user.nombre} (<@${user.slack_id}>) — horario ${user.hora_entrada} a ${user.hora_salida}, ${user.carga_horaria}hs/día (viernes hasta ${db.SALIDA_VIERNES})${db.esSoloProyectos(user) ? ' (modo solo proyectos: no marca asistencia)' : ''}${db.isAdmin(user.slack_id) ? ' — ES ADMIN' : ''}`,
    ...diasSemana.map(f => `${f === hoy ? 'Hoy' : t.dayjs(f).format('dddd')} — ${resumenDia(user, f)}`),
    `Semana: ${sem.trabajadas}hs trabajadas de ${sem.esperadas}hs esperadas (${sem.diff >= 0 ? '+' : ''}${sem.diff}hs). Saldo del mes: ${mes.diff >= 0 ? '+' : ''}${mes.diff}hs.`,
    `Proyectos activos: ${proyectos || '(ninguno)'}`,
    contextoSolicitudes(user),
    ...(db.veHorarios(user.slack_id) ? [] : [`Lo único que SÍ le podés decir de su semana (día a día, sin horas): ${semanaChecks(user).dias.map(d => `${d.label} ${d.icono}`).join(' · ')} → semana ${semanaChecks(user).icono}`]),
  ].join('\n');
};

const SYSTEM = (contexto, esAdmin) => `Sos el bot de asistencia y time tracking de Hoopla (agencia de publicidad argentina), hablando por DM de Slack. Tono: compañero de trabajo, argentino, cálido y directo. Respondé CORTO (1 a 4 líneas) en mrkdwn de Slack (*negrita*, _cursiva_); no envuelvas toda la respuesta en cursiva ni negrita.

Cómo funciona el sistema:
- Marcaciones: entrada, inicio/fin de almuerzo, salida — vía link web de un solo uso que se abre desde la compu.
- Horas netas del día = salida − entrada − almuerzo. Tolerancia de 10' para llegadas tarde y salidas anticipadas. Almuerzo esperado: 1 hora.
- Cierre del día: a su horario de salida (viernes 17:30 para todos) el bot pregunta "¿terminaste?". "Terminé" cierra el día; "Sigo trabajando" se repregunta cada 25'. Sin respuesta en 10', el día se cierra automáticamente. Si seguía trabajando (ej. reunión) puede mandar un reclamo que aprueba un admin.${esAdmin ? ' [Solo para admins: el auto-cierre se estampa en la última actividad en Slack, con piso en el último "sigo".]' : ''}
- Marcas: después de la salida se cargan las marcas (clientes) en las que trabajó y el % de cada una (herramienta cargar_marcas). No hay comandos "/": todo es charla.

Pedidos de días (vacaciones, día personal u otra ausencia):
- Se piden ACÁ charlando. Andá preguntando de a una cosa lo que falte: tipo (Vacaciones, Día personal u Otro), desde y hasta (pasalas a YYYY-MM-DD; hoy es ${t.today()}), y un comentario si quiere (para "Otro" es obligatorio el motivo). Si en el contexto dice que le faltan DNI, email o área, preguntáselos (una sola vez, quedan guardados).
- Con todo eso, usá la herramienta pedir_dias: le muestra un resumen con botones para enviarlo. Pedirlo NO es aprobarlo: lo aprueba un admin y la persona recibe el aviso.
- Médico o enfermedad: no es un pedido, que le avise a su admin.

Cómo actuar:
- Tenés HERRAMIENTAS que hacen las cosas de verdad. Si la persona pide algo que una herramienta resuelve, USALA en vez de explicarle el comando. Lo que muestra la herramienta ya le llega a la persona (con botones y links): no lo repitas.
- Si falta un dato para actuar (ej. "agregá a dos personas" sin decir quiénes), preguntalo en una línea.
- Cuando la acción ya mostró todo, respondé exactamente: LISTO (no se envía nada más).
- Nunca inventes datos. Usá el contexto de abajo para responder con números concretos.
${esAdmin ? `
Esta persona ES ADMIN: con la herramienta "admin" podés ejecutar cualquier comando de gestión (lista abajo).
- Las personas SIEMPRE van como mención <@ID>: primero buscá el ID con "buscar_personas" (nunca inventes IDs). Si hay varias coincidencias o ninguna, preguntá.
- Fechas en formato YYYY-MM-DD (hoy es ${t.today()}).
- Antes de acciones masivas o difíciles de deshacer (sacar a alguien, agregartodos, feriado para todos, probar reset) confirmá en una línea qué vas a hacer y esperá el "sí". Agregar personas, cargar novedades puntuales o ver reportes: hacelo directo.

Comandos de admin disponibles (el campo "comando" va SIN la palabra "admin"):
${USO}` : `
Esta persona NO es admin:
- No puede cambiar horarios, novedades ni datos de otros. Para eso, que hable con un admin. Nunca des información de otras personas.
- CONFIDENCIAL: tenés sus horarios registrados y sus horas para entender su situación y ayudarlo (ej. saber si le falta marcar algo), pero son un control interno de la empresa. NUNCA le digas a qué hora marcó, a qué hora se cerró su día, cuántas horas trabajó o le faltan, ni ningún número de su balance, ni lo estimes o insinúes. Lo único que podés decirle de su semana es el ✅/❌ de cada día y de la semana (está en el contexto). Si pide detalles, decile con buena onda que eso lo lleva administración. No digas cómo se calcula el cierre automático.
- Sí podés mencionar su horario ASIGNADO (entrada/salida) y las reglas generales (10 minutos para contestar, repregunta cada 25 minutos).`}

Contexto real de esta persona:
${contexto}`;

// ─── Herramientas ───────────────────────────────────────────────────
const TOOLS_USUARIO = [
  { name: 'ver_estado', description: 'Muestra cómo viene su semana (a quien no es admin: solo ✅/❌; al admin: detalle con horas).', params: {} },
  { name: 'marcar', description: 'Manda el link para registrar la próxima marcación del día (entrada, almuerzo o salida).', params: {} },

  { name: 'cargar_marcas', description: 'Manda el botón para cargar en qué marcas trabajó (elige marcas y %).', params: {} },
  { name: 'imputar_horas', description: 'Anota en qué marcas/proyectos trabajó a partir de texto con horas, ej: "Jumbo 2, Coral 1.5, el resto en Interno". Prefijo "ayer:" para el día anterior. Si no da horas, usá cargar_marcas.', params: { texto: { type: 'string', description: 'Pares proyecto + horas' } }, required: ['texto'] },
  { name: 'ver_proyectos', description: 'Muestra el catálogo de proyectos y lo imputado hoy y en la semana.', params: {} },

  { name: 'reclamar_cierre', description: 'Si su salida de hoy fue auto-cerrada, manda el botón para reclamar (estaba trabajando).', params: {} },
  { name: 'ayuda', description: 'Explicación completa de cómo funciona la asistencia y los comandos.', params: {} },
  { name: 'pedir_dias', description: 'Arma el pedido de vacaciones / día personal / otra ausencia y le muestra un resumen con botones para enviarlo. Llamala recién cuando tengas tipo y fechas; si la persona no cargó DNI, email o área (ver contexto), preguntáselos antes y pasalos acá.', params: {
    tipo: { type: 'string', enum: ['Vacaciones', 'Dia personal', 'Otro'] },
    desde: { type: 'string', description: 'YYYY-MM-DD' },
    hasta: { type: 'string', description: 'YYYY-MM-DD (igual a desde si es un solo día)' },
    comentarios: { type: 'string', description: 'Opcional; obligatorio para Otro (motivo)' },
    dni: { type: 'string', description: 'Solo si falta en su perfil' },
    email: { type: 'string', description: 'Email de Hoopla, solo si falta en su perfil' },
    area: { type: 'string', description: 'Área o equipo, solo si falta en su perfil' },
  }, required: ['tipo', 'desde'] },
];
const TOOLS_ADMIN = [
  { name: 'mi_semana_web', description: 'Manda el link a su resumen web de horas por proyecto.', params: {} },
  { name: 'buscar_personas', description: 'Busca personas del workspace de Slack por nombre (o parte) para obtener su ID. Devuelve id, nombre, si está en el seguimiento y si es admin.', params: { nombre: { type: 'string' } }, required: ['nombre'] },
  { name: 'admin', description: 'Ejecuta un comando de gestión de admin (sin la palabra "admin"), ej: "agregar <@U123>", "vacaciones <@U123> 2026-10-05 2026-10-16", "reporte hoy", "persona <@U123>".', params: { comando: { type: 'string' } }, required: ['comando'] },
];

const toolsPara = (esAdmin) => [...TOOLS_USUARIO, ...(esAdmin ? TOOLS_ADMIN : [])];

// Directorio del workspace (cache 10 min) para resolver nombres → IDs
let directorio = { at: 0, miembros: [] };
const miembrosWorkspace = async (client) => {
  if (Date.now() - directorio.at < 10 * 60 * 1000 && directorio.miembros.length) return directorio.miembros;
  const miembros = [];
  let cursor;
  do {
    const r = await client.users.list({ limit: 200, cursor });
    miembros.push(...r.members.filter(m => !m.deleted && !m.is_bot && m.id !== 'USLACKBOT'));
    cursor = r.response_metadata?.next_cursor;
  } while (cursor);
  directorio = { at: Date.now(), miembros };
  return miembros;
};

const buscarPersonas = async (client, nombre) => {
  const q = normalize(nombre);
  const miembros = await miembrosWorkspace(client);
  const hits = miembros.filter(m => [m.real_name, m.profile?.real_name, m.profile?.display_name, m.name]
    .filter(Boolean).some(n => normalize(n).includes(q) || q.split(/\s+/).every(w => normalize(n).includes(w))));
  if (!hits.length) return `Nadie coincide con "${nombre}".`;
  return hits.slice(0, 8).map(m => {
    const u = db.getUser(m.id);
    return `<@${m.id}> — ${m.profile?.real_name || m.real_name || m.name}${m.profile?.display_name ? ` (@${m.profile.display_name})` : ''} · ${u?.trackeado ? 'en seguimiento' : 'NO está en seguimiento'}${db.isAdmin(m.id) ? ' · admin' : ''}${m.is_restricted ? ' · invitado' : ''}`;
  }).join('\n');
};

/**
 * Ejecuta una herramienta. Lo que la acción muestra va directo al DM
 * (say), y se devuelve un eco en texto para que la IA sepa qué pasó.
 */
const ejecutarTool = async (nombre, input, { user, client, say, acciones }) => {
  const mostrado = [];
  const sayEco = async (msg) => {
    mostrado.push(typeof msg === 'string' ? msg : msg.text || '');
    await say(msg);
  };
  const esAdmin = db.isAdmin(user.slack_id);
  switch (nombre) {
    case 'marcar': await acciones.marcar(sayEco); break;
    case 'ver_estado': await acciones.estado(sayEco); break;
    case 'cargar_marcas': await acciones.cargar(sayEco); break;
    case 'imputar_horas': {
      const r = acciones.imputar(input.texto || '');
      if (!r) return 'No lo pude interpretar como imputación (formato: "Proyecto horas, ...").';
      await sayEco(r);
      break;
    }
    case 'ver_proyectos': await acciones.proyectos(sayEco); break;
    case 'mi_semana_web': if (!esAdmin) return 'No disponible.'; await acciones.semanaWeb(sayEco); break;
    case 'reclamar_cierre': await acciones.reclamo(sayEco); break;
    case 'ayuda': await sayEco(acciones.ayuda()); break;
    case 'pedir_dias': return await acciones.pedirDias(input, sayEco);
    case 'buscar_personas':
      if (!esAdmin) return 'Solo admins.';
      return await buscarPersonas(client, input.nombre || '');
    case 'admin':
      if (!esAdmin) return 'Solo admins.';
      await handleAdmin({ texto: String(input.comando || '').replace(/^admin\s+/i, ''), adminId: user.slack_id, say: sayEco, client });
      break;
    default: return `Herramienta desconocida: ${nombre}`;
  }
  const eco = mostrado.join('\n').slice(0, 1500);
  return eco ? `Ya se le mostró a la persona:\n${eco}` : 'Hecho.';
};

/** Historial reciente del DM (para que la charla tenga hilo) */
// Borra horas (18:12) y duraciones (7.5hs, 30 min) de mensajes viejos
const sinHoras = (s) => s.replace(/\b\d{1,2}:\d{2}\b/g, '[hora]').replace(/\b\d+(?:[.,]\d+)?\s*(?:hs|h|horas?|min(?:utos)?)\b/gi, '[horas]');

const historial = async (client, channel, limite = 8, redactar = false) => {
  try {
    const r = await client.conversations.history({ channel, limit: limite + 1 });
    return (r.messages || [])
      .filter(m => !m.subtype && (m.text || '').trim())
      .slice(1) // el mensaje actual ya va aparte
      .reverse()
      .map(m => ({ role: m.bot_id ? 'assistant' : 'user', content: (redactar ? sinHoras(m.text) : m.text).slice(0, 800) }));
  } catch (_) { return []; }
};

const MAX_PASOS = 6;

// Loop de tool use con Claude
const conAnthropic = async (key, system, messages, tools, ejecutar, signal) => {
  const toolsDef = tools.map(x => ({ name: x.name, description: x.description, input_schema: { type: 'object', properties: x.params, required: x.required || [] } }));
  const msgs = [...messages];
  for (let paso = 0; paso < MAX_PASOS; paso++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_ANTHROPIC(), max_tokens: 800, system, messages: msgs, ...(toolsDef.length ? { tools: toolsDef } : {}) }),
    });
    if (!r.ok) { console.error('[ia] Anthropic', r.status, (await r.text()).slice(0, 200)); return null; }
    const j = await r.json();
    const usos = (j.content || []).filter(c => c.type === 'tool_use');
    if (j.stop_reason !== 'tool_use' || !usos.length) {
      return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim() || null;
    }
    msgs.push({ role: 'assistant', content: j.content });
    const resultados = [];
    for (const u of usos) resultados.push({ type: 'tool_result', tool_use_id: u.id, content: await ejecutar(u.name, u.input || {}) });
    msgs.push({ role: 'user', content: resultados });
  }
  return null;
};

// Loop de function calling con OpenAI
const conOpenAI = async (key, system, messages, tools, ejecutar, signal) => {
  const toolsDef = tools.map(x => ({ type: 'function', function: { name: x.name, description: x.description, parameters: { type: 'object', properties: x.params, required: x.required || [] } } }));
  const msgs = [{ role: 'system', content: system }, ...messages];
  for (let paso = 0; paso < MAX_PASOS; paso++) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_OPENAI(), max_completion_tokens: 800, messages: msgs, ...(toolsDef.length ? { tools: toolsDef } : {}) }),
    });
    if (!r.ok) { console.error('[ia] OpenAI', r.status, (await r.text()).slice(0, 200)); return null; }
    const msg = (await r.json()).choices?.[0]?.message;
    if (!msg) return null;
    if (!msg.tool_calls?.length) return (msg.content || '').trim() || null;
    msgs.push(msg);
    for (const c of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch (_) { /* args vacíos */ }
      msgs.push({ role: 'tool', tool_call_id: c.id, content: await ejecutar(c.function.name, args) });
    }
  }
  return null;
};

// ─── Control de la respuesta (quien no es admin) ─────────────────────
// La IA recibe los horarios para entender, pero no puede decirlos. Si la
// respuesta menciona una hora que no sea su horario asignado, o cualquier
// cantidad de horas/minutos que no sea una regla general, se la hace
// reescribir; si insiste, va un mensaje genérico.
const valoresSensibles = (user) => {
  const desde = t.dayjs(t.today()).subtract(14, 'day').format('YYYY-MM-DD');
  const regs = db.db.prepare('SELECT hora FROM registros WHERE user_id = ? AND fecha >= ?').all(user.slack_id, desde);
  return { horas: new Set(regs.map(r => r.hora)) };
};

const filtraHorarios = (respuesta, user) => {
  // Horas que sí se pueden decir: su horario asignado y el viernes corto
  const permitidas = new Set([user.hora_entrada, user.hora_salida, db.SALIDA_VIERNES]);
  for (const m of respuesta.matchAll(/\b(\d{1,2})[:.](\d{2})\s*(?:hs|h)?\b/g)) {
    const hhmm = `${m[1].padStart(2, '0')}:${m[2]}`;
    if (!permitidas.has(hhmm) && Number(m[1]) < 24) return true;
  }
  const { horas } = valoresSensibles(user);
  for (const h of horas) if (!permitidas.has(h) && respuesta.includes(h)) return true;
  // Cualquier cantidad de horas/minutos, salvo las reglas generales:
  // 10' para contestar / de tolerancia, 25' de repregunta, 1 hora de almuerzo, su carga diaria
  const reglas = { min: new Set([10, 25]), hs: new Set([1, user.carga_horaria]) };
  for (const m of respuesta.matchAll(/(\d+(?:[.,]\d+)?)\s*(hs|h|horas?|min(?:utos)?|')(?![a-záéíóú])/gi)) {
    const n = Number(m[1].replace(',', '.'));
    const esMin = /^(min|')/i.test(m[2]);
    if (!(esMin ? reglas.min : reglas.hs).has(n)) return true;
  }
  return false;
};

// Reescritura sin herramientas (no re-ejecuta acciones)
const reescribir = async (respuesta) => {
  const system = 'Reescribí el mensaje para un empleado SIN mencionar ninguna hora, horario registrado, cantidad de horas o minutos trabajados, ni números de balance. Mantené el tono y el resto del contenido. Devolvé solo el mensaje.';
  const messages = [{ role: 'user', content: respuesta }];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    if (process.env.ANTHROPIC_API_KEY) return await conAnthropic(process.env.ANTHROPIC_API_KEY, system, messages, [], async () => '', ctrl.signal);
    return await conOpenAI(process.env.OPENAI_API_KEY, system, messages, [], async () => '', ctrl.signal);
  } finally { clearTimeout(timer); }
};

const iaActiva = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

/**
 * Charla con la persona y ejecuta acciones. Devuelve el texto final a
 * enviar ('' si no hay nada que agregar), o null si el modo está apagado
 * o la API falló (el caller cae al menú).
 */
const responderIA = async (user, texto, { client, channel, say, acciones } = {}) => {
  const keyAnthropic = process.env.ANTHROPIC_API_KEY;
  const keyOpenAI = process.env.OPENAI_API_KEY;
  if (!keyAnthropic && !keyOpenAI) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const esAdmin = db.isAdmin(user.slack_id);
    const previos = client && channel ? await historial(client, channel, 8, !db.veHorarios(user.slack_id)) : [];
    // Anthropic exige alternancia — colapsamos roles repetidos (a OpenAI no le molesta)
    const messages = [];
    for (const m of [...previos, { role: 'user', content: texto.slice(0, 1500) }]) {
      const ult = messages[messages.length - 1];
      if (ult && ult.role === m.role) ult.content += `\n${m.content}`;
      else messages.push({ ...m });
    }
    if (messages[0]?.role !== 'user') messages.shift();

    const system = SYSTEM(construirContexto(user), esAdmin);
    const tools = toolsPara(esAdmin);
    let acciones_ejecutadas = 0;
    const ejecutar = async (nombre, input) => {
      acciones_ejecutadas++;
      console.log(`[ia] ${user.nombre} → ${nombre} ${JSON.stringify(input)}`);
      try { return await ejecutarTool(nombre, input, { user, client, say, acciones }); }
      catch (e) { console.error(`[ia] tool ${nombre}:`, e.message); return `Error: ${e.message}`; }
    };
    const respuesta = keyAnthropic
      ? await conAnthropic(keyAnthropic, system, messages, tools, ejecutar, ctrl.signal)
      : await conOpenAI(keyOpenAI, system, messages, tools, ejecutar, ctrl.signal);
    if (respuesta == null) return acciones_ejecutadas ? '' : null;
    let final = /^LISTO\.?$/i.test(respuesta.trim()) ? '' : respuesta.replace(/\n?LISTO\.?\s*$/i, '').trim();
    if (final && !db.veHorarios(user.slack_id) && filtraHorarios(final, user)) {
      console.warn(`[ia] La respuesta a ${user.nombre} mencionaba horarios/horas — reescribiendo`);
      const otra = await reescribir(final).catch(() => null);
      final = otra && !filtraHorarios(otra, user) ? otra : txt.chat.sinHorarios;
    }
    return final;
  } catch (e) {
    console.error('[ia] Error:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

module.exports = { responderIA, construirContexto, iaActiva, buscarPersonas, ejecutarTool, filtraHorarios };
