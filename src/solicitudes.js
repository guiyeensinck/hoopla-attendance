const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { agregarFila, planillaActiva } = require('./planilla');

/**
 * Pedidos de vacaciones / días personales / otros, hechos charlando con el
 * bot. La IA va preguntando lo que falta (tipo, fechas, comentarios y, la
 * primera vez, DNI / email / área) y arma un borrador; la persona lo
 * confirma con un botón. Al enviarlo se agrega la fila en la planilla de
 * solicitudes (mismas columnas que el Google Form) y le llega al admin
 * para aprobar. Pedirlo no es aprobarlo: al aprobar se carga la novedad.
 */

// Tipos tal como están en la planilla → novedad que se carga al aprobar
const TIPOS = { 'Vacaciones': 'vacaciones', 'Dia personal': 'libre', 'Otro': 'licencia' };
const AREAS = ['Diseño', 'Cuentas', 'Creatividad', 'Programacion', 'Administración'];
const MAX_DIAS = 45;

const diasEntre = (desde, hasta) => {
  let habiles = 0, corridos = 0;
  for (let d = t.dayjs(desde); !d.isAfter(t.dayjs(hasta), 'day'); d = d.add(1, 'day')) {
    corridos++;
    const ds = d.format('YYYY-MM-DD');
    if (t.isWeekday(ds) && !db.isFeriado(ds)) habiles++;
  }
  return { habiles, corridos };
};

const normalizarTipo = (tipo) => {
  const n = (tipo || '').toLowerCase();
  if (n.startsWith('vac')) return 'Vacaciones';
  if (n.includes('personal') || n.includes('libre')) return 'Dia personal';
  if (n) return 'Otro';
  return null;
};

/** Datos de perfil que faltan para la planilla (se preguntan una sola vez) */
const faltantesPerfil = (user) => [
  !user.dni && 'DNI',
  !user.email && 'email de Hoopla',
  !user.equipo && `área o equipo (${AREAS.join(', ')})`,
].filter(Boolean);

/** Email de Slack si el permiso lo permite (users:read.email); si no, se pregunta */
const completarEmailDesdeSlack = async (client, user) => {
  if (user.email) return;
  try {
    const email = (await client.users.info({ user: user.slack_id })).user?.profile?.email;
    if (email) db.setPerfil(user.slack_id, { email });
  } catch (_) { /* sin permiso: se le pregunta */ }
};

/**
 * Arma el borrador y le muestra el resumen con Enviar / Cancelar.
 * Devuelve un texto para la IA: qué falta o qué se mostró.
 */
const borrador = async ({ user, client, say, datos }) => {
  // Perfil: lo que venga en este pedido se guarda para la próxima
  const area = datos.area && (AREAS.find(a => a.toLowerCase() === datos.area.toLowerCase()) || datos.area);
  db.setPerfil(user.slack_id, { dni: (datos.dni || '').replace(/\D/g, '') || null, email: datos.email, equipo: area });
  await completarEmailDesdeSlack(client, user);
  const u = db.getUser(user.slack_id);

  const tipo = normalizarTipo(datos.tipo);
  const faltan = [...(tipo ? [] : ['tipo (Vacaciones, Día personal u Otro)']),
    ...(t.isValidDate(datos.desde) ? [] : ['fecha de inicio']),
    ...(t.isValidDate(datos.hasta || datos.desde) ? [] : ['fecha de fin']),
    ...faltantesPerfil(u)];
  if (faltan.length) return `Faltan datos, preguntáselos: ${faltan.join(', ')}.`;

  const desde = datos.desde;
  const hasta = datos.hasta || datos.desde;
  if (hasta < desde) return 'La fecha de fin es anterior a la de inicio: pedile que la corrija.';
  if (desde < t.dayjs(t.today()).subtract(30, 'day').format('YYYY-MM-DD')) return 'La fecha de inicio es de hace más de 30 días: confirmá con la persona la fecha correcta.';
  const { habiles, corridos } = diasEntre(desde, hasta);
  if (corridos > MAX_DIAS) return `Son ${corridos} días corridos: es demasiado para un solo pedido, confirmá las fechas.`;
  if (tipo === 'Otro' && !datos.comentarios) return 'Para "Otro" hace falta un comentario con el motivo: preguntáselo.';

  const id = db.crearSolicitud({ user_id: u.slack_id, tipo, desde, hasta, dias_habiles: habiles, dias_corridos: corridos, comentarios: datos.comentarios });
  const texto = txt.solicitud.resumen({ tipo, desde: t.fmtDate(desde), hasta: t.fmtDate(hasta), habiles, corridos, comentarios: datos.comentarios });
  await say({
    text: texto,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: texto } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'solicitud_enviar', value: String(id), text: { type: 'plain_text', text: txt.solicitud.btnEnviar } },
        { type: 'button', action_id: 'solicitud_cancelar', value: String(id), text: { type: 'plain_text', text: txt.solicitud.btnCancelar } },
      ] },
    ],
  });
  return 'Ya se le mostró el resumen con los botones Enviar / Cancelar. No digas que está aprobado ni enviado: lo envía la persona con el botón y después lo aprueba un admin.';
};

// Formato de la planilla (Google Forms): M/D/YYYY y M/D/YYYY H:mm:ss
const fechaPlanilla = (iso) => t.dayjs(iso).format('M/D/YYYY');

const filaPlanilla = (s, u) => [
  t.now().format('M/D/YYYY H:mm:ss'),
  u.nombre, u.dni || '', u.equipo || '', u.email || '', s.tipo,
  fechaPlanilla(s.desde), fechaPlanilla(s.hasta),
  s.tipo === 'Vacaciones' ? `${s.dias_corridos} días corridos (${s.dias_habiles} hábiles)` : `${s.dias_habiles} días hábiles`,
  s.comentarios || '', u.email || '',
];

/** "Enviar": pasa a pendiente, escribe la fila y avisa al admin */
const enviar = async ({ id, uid, client, adminTarget }) => {
  const s = db.getSolicitud(id);
  if (!s || s.user_id !== uid) return { texto: txt.solicitud.noEncontrada };
  if (!db.pasarSolicitud(id, 'borrador', 'pendiente')) return { texto: txt.solicitud.yaProcesada };
  const u = db.getUser(uid);

  let enPlanilla = false;
  if (planillaActiva()) {
    try { enPlanilla = await agregarFila(filaPlanilla(s, u)); if (enPlanilla) db.marcarSolicitudEnPlanilla(id); }
    catch (e) { console.error(`[solicitud] #${id} no pude escribir en la planilla: ${e.message}`); }
  }

  const vac = s.tipo === 'Vacaciones' ? db.vacacionesSaldo(uid, s.desde.slice(0, 4)) : null;
  const texto = txt.solicitud.admin({
    nombre: u.nombre, tipo: s.tipo, desde: t.fmtDate(s.desde), hasta: t.fmtDate(s.hasta),
    habiles: s.dias_habiles, corridos: s.dias_corridos, comentarios: s.comentarios,
    vacaciones: vac && { quedan: vac.quedan, anuales: vac.anuales, anio: vac.anio },
    planilla: planillaActiva() ? enPlanilla : null,
  });
  await client.chat.postMessage({
    channel: adminTarget(),
    text: texto,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: texto } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'solicitud_aprobar', value: String(id), text: { type: 'plain_text', text: txt.reclamo.btnAprobar } },
        { type: 'button', style: 'danger', action_id: 'solicitud_rechazar', value: String(id), text: { type: 'plain_text', text: txt.reclamo.btnRechazar } },
      ] },
    ],
  });
  console.log(`[solicitud] #${id} ${u.nombre}: ${s.tipo} ${s.desde}→${s.hasta} (planilla: ${enPlanilla})`);
  return { texto: txt.solicitud.enviada };
};

/** Aprobar: carga la novedad (vacaciones corridas; el resto, días hábiles) */
const aprobar = ({ id, adminId }) => {
  const s = db.getSolicitud(id);
  if (!s || !db.pasarSolicitud(id, 'pendiente', 'aprobada', adminId)) return null;
  const tipoNov = TIPOS[s.tipo] || 'licencia';
  const corridos = tipoNov === 'vacaciones' || tipoNov === 'licencia';
  db.cargarNovedadRango(s.user_id, tipoNov, s.desde, corridos ? s.dias_corridos : s.dias_habiles, {
    motivo: s.comentarios || `Solicitud #${s.id}`, creadoPor: adminId,
  });
  return s;
};

const rechazar = ({ id, adminId }) => {
  const s = db.getSolicitud(id);
  if (!s || !db.pasarSolicitud(id, 'pendiente', 'rechazada', adminId)) return null;
  return s;
};

const cancelar = ({ id, uid }) => {
  const s = db.getSolicitud(id);
  if (!s || s.user_id !== uid) return false;
  return db.pasarSolicitud(id, 'borrador', 'cancelada');
};

/** Para el contexto de la IA: qué datos de perfil faltan y pedidos recientes (sin el DNI) */
const contextoSolicitudes = (user) => {
  const faltan = faltantesPerfil(user);
  const recientes = db.solicitudesDe(user.slack_id).slice(0, 3)
    .map(s => `${s.tipo} ${s.desde}→${s.hasta} (${s.estado})`).join('; ');
  return `Pedidos de días: ${faltan.length ? `para pedir le falta darnos: ${faltan.join(', ')}` : 'perfil completo'}. Recientes: ${recientes || 'ninguno'}.`;
};

module.exports = { TIPOS, AREAS, borrador, enviar, aprobar, rechazar, cancelar, contextoSolicitudes, filaPlanilla, diasEntre };
