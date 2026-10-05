const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { fechaDestino } = require('./proyectos');

/**
 * Imputación simplificada: "¿en qué marcas trabajaste?" en un modal de
 * Slack. Paso 1: selección múltiple de marcas (clientes). Paso 2 (en el
 * mismo modal, se arma solo al elegir): un % por marca, precargado en
 * partes iguales, que tiene que sumar 100. Las horas salen del % × las
 * horas trabajadas del día. Guardar reemplaza lo imputado ese día.
 */

const CALLBACK = 'imputar_marcas';

/** Horas del día: trabajadas si cerró; si no, la carga del día (estimado) */
const horasDelDia = (user, fecha) => {
  const h = db.horasDia(db.getDia(user.slack_id, fecha));
  return h != null ? { horas: h, estimado: false } : { horas: db.horarioDia(user, fecha).carga_horaria, estimado: true };
};

/** Reparte 100 en n enteros (el resto va a los primeros) */
const partesIguales = (n) => {
  const base = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 100 - base * n ? 1 : 0));
};

/** Lo ya imputado ese día, agrupado por marca y pasado a % */
const seleccionPrevia = (userId, fecha) => {
  const imps = db.getImputacionesDia(userId, fecha);
  const proys = Object.fromEntries(db.getProyectos(false).map(p => [p.id, p]));
  const porMarca = {};
  for (const i of imps) {
    const p = proys[i.proyecto_id];
    const marca = p?.cliente || p?.nombre || i.nombre;
    porMarca[marca] = (porMarca[marca] || 0) + i.horas;
  }
  const total = Object.values(porMarca).reduce((s, h) => s + h, 0);
  if (!total) return { seleccion: [], pcts: {} };
  const seleccion = Object.keys(porMarca);
  const pcts = Object.fromEntries(seleccion.map(m => [m, Math.round((porMarca[m] / total) * 100)]));
  return { seleccion, pcts };
};

const opcion = (m) => ({ text: { type: 'plain_text', text: m.slice(0, 75) }, value: m.slice(0, 150) });

/**
 * Arma el modal. `version` cambia cada vez que cambia la selección: así
 * Slack toma los % recalculados (con el mismo block_id conservaría lo viejo).
 */
const vista = ({ user, fecha, seleccion, pcts, version }) => {
  const marcas = db.getMarcas().slice(0, 100); // límite de opciones de Slack
  const esHoy = fecha === t.today();

  const blocks = [
    // Sin horas: las horas del día son un control interno (ver db.veHorarios)
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${esHoy ? 'Hoy' : '⚠️ *Día anterior*'} ${t.fmtDate(fecha)}` }] },
    {
      type: 'input', block_id: 'marcas', dispatch_action: true,
      label: { type: 'plain_text', text: '¿En qué marcas trabajaste?' },
      element: {
        type: 'multi_static_select', action_id: 'marcas_sel',
        placeholder: { type: 'plain_text', text: 'Elegí una o varias' },
        options: marcas.map(m => opcion(m.nombre)),
        ...(seleccion.length ? { initial_options: seleccion.map(opcion) } : {}),
      },
    },
  ];

  if (seleccion.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*¿Cuánto le dedicaste a cada una?* Tiene que sumar *100%*.' } });
    for (const m of seleccion) {
      blocks.push({
        type: 'input', block_id: `pct|${version}|${m}`,
        label: { type: 'plain_text', text: m.slice(0, 2000) },
        element: {
          type: 'number_input', action_id: 'pct', is_decimal_allowed: false,
          min_value: '0', max_value: '100', initial_value: String(pcts[m] ?? 0),
        },
      });
    }
  }

  return {
    type: 'modal',
    callback_id: CALLBACK,
    private_metadata: JSON.stringify({ fecha, version }),
    title: { type: 'plain_text', text: 'Mi día' },
    submit: { type: 'plain_text', text: 'Guardar' },
    close: { type: 'plain_text', text: 'Cancelar' },
    blocks,
  };
};

/** Abre el modal (necesita el trigger_id de un botón o slash command) */
const abrirModal = async (client, triggerId, user, fecha = fechaDestino(user.slack_id)) => {
  if (!db.getMarcas().length) {
    await client.chat.postMessage({ channel: user.slack_id, text: txt.marcas.sinCatalogo });
    return;
  }
  const { seleccion, pcts } = seleccionPrevia(user.slack_id, fecha);
  await client.views.open({ trigger_id: triggerId, view: vista({ user, fecha, seleccion, pcts, version: 0 }) });
};

/** Lee la selección y los % cargados en el estado del modal */
const leerEstado = (view) => {
  const values = view.state?.values || {};
  const seleccion = (values.marcas?.marcas_sel?.selected_options || []).map(o => o.value);
  const pcts = {};
  for (const [blockId, v] of Object.entries(values)) {
    if (!blockId.startsWith('pct|')) continue;
    const marca = blockId.split('|').slice(2).join('|');
    const raw = v.pct?.value;
    pcts[marca] = raw == null || raw === '' ? null : Number(raw);
  }
  return { seleccion, pcts };
};

/** Cambió la selección → se rearma el modal con un % por marca en partes iguales */
const onSeleccion = async ({ body, client }) => {
  const user = db.getUser(body.user.id);
  if (!user) return;
  const meta = JSON.parse(body.view.private_metadata || '{}');
  const { seleccion } = leerEstado(body.view);
  const iguales = partesIguales(seleccion.length || 1);
  const pcts = Object.fromEntries(seleccion.map((m, i) => [m, iguales[i]]));
  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: vista({ user, fecha: meta.fecha, seleccion, pcts, version: (meta.version || 0) + 1 }),
  });
};

/**
 * Guardar: valida que sume 100 y reemplaza lo imputado ese día.
 * Devuelve { errors } para mostrar en el modal, o { ok, texto } con la confirmación.
 */
const guardar = (userId, view) => {
  const user = db.getUser(userId);
  const meta = JSON.parse(view.private_metadata || '{}');
  const { seleccion, pcts } = leerEstado(view);
  const pctBlock = (m) => `pct|${meta.version || 0}|${m}`;

  if (!seleccion.length) return { errors: { marcas: 'Elegí al menos una marca.' } };
  const faltan = seleccion.filter(m => pcts[m] == null);
  if (faltan.length) {
    // Sin campo de % (no debería pasar): pedir que vuelva a elegir
    return { errors: { marcas: 'Volvé a elegir las marcas para cargar los porcentajes.' } };
  }
  const suma = seleccion.reduce((s, m) => s + pcts[m], 0);
  if (suma !== 100) {
    return { errors: { [pctBlock(seleccion[seleccion.length - 1])]: `Suman ${suma}% — tiene que dar 100%.` } };
  }

  const { horas } = horasDelDia(user, meta.fecha);
  const conHoras = seleccion.filter(m => pcts[m] > 0);
  const pares = conHoras.map(m => {
    const p = db.proyectoDeMarca(m);
    return p && { proyecto_id: p.id, nombre: m, pct: pcts[m], horas: Math.round((horas * pcts[m]) / 100 * 100) / 100 };
  }).filter(Boolean);
  if (!pares.length) return { errors: { marcas: 'No encontré esas marcas en el catálogo — pedile al admin que las revise.' } };
  // El redondeo no puede comerse (ni inventar) minutos: el ajuste va a la marca más grande
  const diff = Math.round((horas - pares.reduce((s, p) => s + p.horas, 0)) * 100) / 100;
  if (diff) pares.sort((a, b) => b.horas - a.horas)[0].horas = Math.round((pares[0].horas + diff) * 100) / 100;

  db.setImputaciones(userId, meta.fecha, pares);
  const dia = meta.fecha === t.today() ? 'día' : `*${t.fmtDate(meta.fecha)}* (día anterior)`;
  return { ok: true, texto: txt.marcas.guardado(dia, pares) };
};

module.exports = { CALLBACK, abrirModal, onSeleccion, guardar, partesIguales, vista };
