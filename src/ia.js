const t = require('./time');
const db = require('./database');
const { semanaUsuario, saldoMes } = require('./balance');

/**
 * Modo conversacional (opcional): cuando un DM no matchea ningún comando
 * ni es una imputación, en vez del menú el bot responde con Claude,
 * usando el contexto real de la persona (marcaciones, horas, saldo,
 * imputaciones). Solo lectura: para modificar algo, guía al comando.
 *
 * Se activa seteando ANTHROPIC_API_KEY. Sin la variable (o si la API
 * falla), se cae al menú de siempre — nunca rompe el flujo.
 */

const MODEL = () => process.env.IA_MODEL || 'claude-haiku-4-5-20251001';

const resumenDia = (user, fecha) => {
  const dia = db.getDia(user.slack_id, fecha);
  if (!dia.entrada && !dia.salida) return `${fecha}: sin marcaciones`;
  const partes = [];
  for (const tipo of ['entrada', 'almuerzo_inicio', 'almuerzo_fin', 'salida']) {
    const r = dia[tipo];
    if (!r) { partes.push(`${tipo}: —`); continue; }
    let s = `${tipo}: ${r.hora}`;
    if (r.tarde_min > 0) s += ` (+${r.tarde_min}' tarde)`;
    if (r.anticipado_min > 0) s += ` (−${r.anticipado_min}' anticipado)`;
    if (r.auto_closed) s += r.corregido ? ` (auto-cierre corregido, era ${r.valor_original})` : ` (AUTO-CIERRE${r.nota === 'auto_closed_ultima_actividad' ? ' a última actividad detectada en Slack' : ' a horario'})`;
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
  const proyectos = db.getProyectos(true).map(p => p.nombre).join(', ');
  return [
    `Ahora: ${t.now().format('dddd YYYY-MM-DD HH:mm')} (Buenos Aires)`,
    `Persona: ${user.nombre} — horario ${user.hora_entrada} a ${user.hora_salida}, ${user.carga_horaria}hs/día${db.esSoloProyectos(user) ? ' (modo solo proyectos: no marca asistencia)' : ''}${db.isAdmin(user.slack_id) ? ' — ES ADMIN' : ''}`,
    `Hoy — ${resumenDia(user, hoy)}`,
    `Último día hábil — ${resumenDia(user, ayer)}`,
    `Semana: ${sem.trabajadas}hs trabajadas de ${sem.esperadas}hs esperadas (${sem.diff >= 0 ? '+' : ''}${sem.diff}hs). Saldo del mes: ${mes.diff >= 0 ? '+' : ''}${mes.diff}hs.`,
    `Proyectos activos: ${proyectos || '(ninguno)'}`,
  ].join('\n');
};

const SYSTEM = (contexto) => `Sos el bot de asistencia y time tracking de Hoopla (agencia de publicidad argentina), hablando por DM de Slack. Tono: compañero de trabajo, argentino, cálido y directo. Respondé CORTO (1 a 4 líneas), en mrkdwn de Slack (*negrita*, _cursiva_).

Cómo funciona el sistema (para explicar cálculos):
- Marcaciones: entrada, inicio/fin de almuerzo, salida — vía link web de un solo uso ("marcar").
- Horas netas del día = salida − entrada − almuerzo.
- Tolerancia de 10': tarde recién pasados 10' de la entrada; salida "en horario" desde 10' antes. Almuerzo esperado: 1 hora.
- Si la persona no responde el DM de cierre, la salida se AUTO-CIERRA a la última actividad detectada en Slack (tope: su horario). Se puede corregir UNA vez el mismo día escribiendo "marcar". Días anteriores: solo el admin.
- Time tracking: se cargan horas por proyecto por texto ("Jumbo 2, el resto en Interno" — se van sumando durante el día, repetir un proyecto corrige) o con el formulario web ("cargar"). "proyectos" muestra el catálogo, "mi semana" el resumen web personal.
- Comandos útiles: *marcar*, *cargar*, *horarios*, *proyectos*, *mi semana*.

Reglas:
- NO podés modificar registros ni datos: si piden un cambio, indicá el comando correspondiente o que se lo pidan al admin (Guiye).
- Usá el contexto de abajo para responder con números concretos. Si algo no está en el contexto, decí que no lo tenés a mano y sugerí el comando que lo muestra.
- Nunca inventes datos ni des información de otras personas.

Contexto real de esta persona:
${contexto}`;

/** Historial reciente del DM (para que la charla tenga hilo) */
const historial = async (client, channel, limite = 6) => {
  try {
    const r = await client.conversations.history({ channel, limit: limite + 1 });
    return (r.messages || [])
      .filter(m => !m.subtype && (m.text || '').trim())
      .slice(1) // el mensaje actual ya va aparte
      .reverse()
      .map(m => ({ role: m.bot_id ? 'assistant' : 'user', content: m.text.slice(0, 600) }));
  } catch (_) { return []; }
};

/**
 * Devuelve la respuesta conversacional, o null si el modo está apagado
 * o la API falló (el caller cae al menú).
 */
const responderIA = async (user, texto, { client, channel } = {}) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const previos = client && channel ? await historial(client, channel) : [];
    // Anthropic exige alternancia — colapsamos roles repetidos
    const messages = [];
    for (const m of [...previos, { role: 'user', content: texto.slice(0, 600) }]) {
      const ult = messages[messages.length - 1];
      if (ult && ult.role === m.role) ult.content += `\n${m.content}`;
      else messages.push({ ...m });
    }
    if (messages[0]?.role !== 'user') messages.shift();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 400, system: SYSTEM(construirContexto(user)), messages }),
    });
    clearTimeout(timer);
    if (!r.ok) { console.error('[ia] API', r.status, (await r.text()).slice(0, 200)); return null; }
    const j = await r.json();
    const respuesta = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    return respuesta || null;
  } catch (e) {
    console.error('[ia] Error:', e.message);
    return null;
  }
};

module.exports = { responderIA, construirContexto };
