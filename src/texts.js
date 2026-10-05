/**
 * TODOS LOS TEXTOS VISIBLES DE LA APP
 * Editá acá y los cambios impactan en Slack, DMs y la página web.
 */

const TIPOS = {
  entrada:         { emoji: '🟢', label: 'Entrada' },
  almuerzo_inicio: { emoji: '🍽️', label: 'Inicio almuerzo' },
  almuerzo_fin:    { emoji: '⏱️', label: 'Fin almuerzo' },
  salida:          { emoji: '🔴', label: 'Salida' },
};

const minutos = (n) => `${n} minuto${n === 1 ? '' : 's'}`;

const NOVEDADES = {
  feriado:    '🏖️ Feriado',
  vacaciones: '✈️ Vacaciones',
  medico:     '🏥 Turno médico',
  ausente:    '❌ Ausente',
  libre:      '📅 Día libre',
  salida:     '🕐 Salida autorizada',
  remoto:     '📱 Fichaje remoto',
  licencia:   '📋 Licencia',
};

module.exports = {
  TIPOS,
  NOVEDADES,

  // ─── Chat por DM (el bot se usa como un compañero) ────────────────
  chat: {
    menuSaludo: (nombre) => `👋 ¡Hola, ${nombre}! ¿En qué te ayudo?`,
    btnMarcar: (label) => `🕒 Marcar ${label}`,
    btnSemana: '📊 Mi semana',
    menuHint: '_Escribime como a un compañero: "llegué", "me voy a almorzar", "terminé", "hoy estuve en Jumbo"... Si tenés dudas de cómo funciona, preguntame._',
    sinHorarios: 'Los horarios y las horas los lleva administración, no los tengo para mostrarte. Si necesitás revisar algo puntual, hablalo con tu admin. 🙌',
    semana: ({ dias, ok }) => `${ok === null ? '⏳ *Tu semana:* todavía no hay días cerrados.'
      : ok ? '✅ *Tu semana viene bien.* ¡Seguí así!'
      : '❌ *Tu semana tiene días que no llegaron a lo esperado.* Si tenés dudas, hablalo con tu admin.'}\n${dias.map(d => `${d.label} ${d.icono}`).join('  ·  ')}`,
    btnReclamo: '🙋 Reclamar cierre',
    adminHint: '_Sos admin: escribí *admin* para ver los comandos de gestión._',
    modoSoloProyectos: (hora) => `ℹ️ *Te configuraron en modo "solo proyectos".*\nNo tenés que marcar entrada/salida ni te van a llegar recordatorios de asistencia. Lo único: cada día alrededor de las ${hora} te voy a preguntar en qué marcas trabajaste. También me lo podés contar cuando quieras.`,
  },

  // ─── Marcación ────────────────────────────────────────────────────
  marcar: {
    linkTitle: '🕒 *¡Hora de marcar!*',
    linkInstructions: (label) => `Vas a registrar: *${label}*. Abrí este link desde tu computadora:`,
    linkLabel: (emoji, label) => `${emoji} Marcar ${label.toLowerCase()}`,
    expireNote: '⏱️ El link es de un solo uso y expira en 5 minutos.',
    diaCompleto: '✅ Ya tenés la jornada completa registrada por hoy.',
    noTrackeado: '⚠️ Todavía no estás en el seguimiento de asistencia. Pedile a un admin que te agregue.',
    confirmacionDM: (emoji, label) => `${emoji} *${label}* registrada. 👌`,
    noTrackeadoAdmin: '⚠️ Todavía no estás en el seguimiento de asistencia. Como sos admin, agregate vos: escribime `admin agregarme`.',
  },

  // ─── Página web ───────────────────────────────────────────────────
  web: {
    mobileBloqueado: 'El registro solo puede hacerse desde una computadora.',
    mobileBloqueadoDetalle: 'Abrí el link desde tu compu. Si tenés autorización para fichar desde el celular, pedile al admin que cargue `remoto` para hoy.',
    linkInvalido: 'Link inválido o expirado',
    linkInvalidoDetalle: 'Este link ya fue usado o venció (dura 5 minutos). Escribile "marcar" al bot en Slack y te manda uno nuevo.',
    registrado: '✅ Registrado',
    listoDetalle: 'Ya podés cerrar esta pestaña. Te dejé la confirmación en Slack.',
    diaCompleto: '✅ Día completo',
    tarde: (min) => `⚠️ Llegaste ${min} min tarde según tu horario.`,
    anticipado: (min) => `⚠️ Saliste ${min} min antes de tu horario.`,
    balanceOk: 'Justo en horario. 💪',
    balanceAFavor: (hs) => `Tenés ${hs}hs a favor esta semana. Excelente.`,
    balanceDebe: (hs, hora) => `Te faltan ${hs}hs esta semana. Para compensar hoy, quedate hasta las ${hora}.`,
    balanceDebeGeneral: (hs) => `Te faltan ${hs}hs esta semana. Tenés hasta el viernes para compensar.`,
  },

  // ─── Imputación de proyectos ──────────────────────────────────────
  imputar: {
    btnWeb: '🖱️ Cargar con clicks',
    linkWeb: (url) => `Acá tenés tu formulario para cargar horas con clicks (dura 30 min):\n👉 <${url}|Cargar mis horas>\n_Podés usarlo en cualquier momento del día — lo que ya cargaste aparece precargado y le sumás filas._`,
    preguntaIntro: '🤔 *Casi — necesito que me aclares algo antes de guardar:*',
    noEncontrado: (nombre) => `• No encontré ningún proyecto que se llame *${nombre}*.`,
    ambiguo: (nombre, opciones) => `• Con *${nombre}* no sé a cuál te referís: ${opciones.map(o => `\`${o}\``).join(' / ')}.`,
    noEntendi: (frase) => `• No entendí esta parte: _"${frase}"_.`,
    reintento: 'Mandame la imputación de nuevo completa (corrigiendo eso), o cargala con clicks desde la web:',
    reintentoSimple: 'Contámelo de nuevo corrigiendo eso, o escribí *cargar* para elegir las marcas con clicks.',
    restoNegativo: () => '⚠️ Pediste imputar "el resto", pero con lo que detallaste ya no queda resto del día. Mandámela de nuevo.',
    guardadoSimple: (dia, nombres) => `🗂️ Listo, anoté para ${dia}: ${nombres.join(', ')}. ✅`,
    webTitulo: '🗂️ ¿En qué trabajaste?',
    webGuardado: '✅ Horas guardadas',
    webLinkInvalido: 'Este link ya fue usado o venció (dura 30 minutos). Escribile *proyectos* al bot en Slack y pedile otro con el botón.',
    confirmacionWeb: (detalle) => `🗂️ Cargaste tus horas desde la web: ${detalle}`,
    btnSemanaWeb: '📊 Mi semana en proyectos',
    linkSemana: (url) => `Acá tenés tu resumen de proyectos de la semana (el link dura 30 min):\n👉 <${url}|Ver mi semana>`,
    semanaTitulo: '📊 Tu semana en proyectos',
    semanaLinkInvalido: 'Este link venció (dura 30 minutos). Escribile *mi semana* al bot en Slack y te manda uno nuevo.',
  },

  // ─── "horarios" ───────────────────────────────────────────────────
  horarios: {
    sinRegistro: 'Todavía no marcaste entrada hoy. Escribime *marcar* cuando arranques.',
    enCurso: '⏳ Jornada en curso.',
    completa: (hs) => `✅ Jornada completa (${hs}hs).`,
  },

  // ─── Onboarding (DM al ser agregado al tracking) ──────────────────
  onboarding: (user) => `👋 *¡Hola! Te sumaron al registro de asistencia de Hoopla.*

*¿Cómo funciona?*
Hablame acá como a un compañero. Cuando llegues, escribime "llegué" y te mando un link para marcar la entrada (se abre desde la computadora). Lo mismo cuando salís y volvés de almorzar.

*Tu horario asignado*
🕐 ${user.hora_entrada} a ${user.hora_salida}. Los viernes la salida es a las 17:30. Si está mal, avisale a tu admin.

*¿Y al final del día?*
A tu horario de salida te pregunto si terminaste:
• *Terminé* → cierro tu día.
• *Sigo trabajando* → te vuelvo a preguntar cada 20 minutos.
• Si no contestás en 3 minutos, cierro tu día automáticamente. Si seguías trabajando, avisame y lo revisa un admin.

Después te pregunto en qué marcas trabajaste: elegís las marcas y el % de cada una.

*¿Ausencias, médico, vacaciones?*
Avisale a tu admin, que las carga en el sistema.

¿Dudas? Preguntame lo que quieras. 💬`,

  // ─── "ayuda" ──────────────────────────────────────────────────────
  ayuda: `📖 *Cómo funciona*

Hablame como a un compañero, no hace falta ningún comando:
• *"llegué"* → te mando el link para marcar la entrada (desde la compu).
• *"me voy a almorzar"* / *"volví"* → link para marcar el almuerzo.
• A tu horario de salida (viernes 17:30) te pregunto *¿terminaste?*
   ✅ *Terminé* → cierro tu día.
   💪 *Sigo trabajando* → te repregunto cada 20'.
   Sin respuesta en 3' → cierro tu día automáticamente. ¿Seguías trabajando? Avisame y lo revisa un admin.
• *"hoy estuve en Jumbo y Coral"* o *"cargar"* → anotamos en qué marcas trabajaste (con el % de cada una).

Para vacaciones, médico o ausencias, hablalo con tu admin.`,

  // ─── Recordatorios ────────────────────────────────────────────────
  recordatorios: {
    entrada: (hora) => `⏰ *¿Arrancaste?* Tu horario de entrada era ${hora} y todavía no marcaste. Avisame ("llegué") y te mando el link.`,
    almuerzoInicio: '🍽️ *¿Saliste a almorzar?* Avisame cuando arranques y te paso el link para marcarlo.',
    almuerzoFin: () => '⏱️ Ya pasó más de una hora desde que saliste a almorzar. Si volviste, avisame y te paso el link para marcar la vuelta.',
    faltantesAdmin: (lista) => `⚠️ *Sin fichar pasada 1 hora de su horario de entrada:*\n${lista}`,
  },

  // ─── Cierre del día ───────────────────────────────────────────────
  cierre: {
    pregunta: (hora, min) => `🌆 *Son las ${hora}, tu horario de salida.* ¿Terminaste por hoy?\n_Si no contestás en ${minutos(min)}, cierro tu día automáticamente._`,
    preguntaSigo: (min) => `💪 *¿Seguís trabajando?*\n_Si no contestás en ${minutos(min)}, cierro tu día automáticamente._`,
    btnTermine: '✅ Terminé',
    btnSigo: '💪 Sigo trabajando',
    sigoOk: (proxima) => `💪 Dale, anotado. Te vuelvo a preguntar a las *${proxima}*. Cuando termines, tocá *Terminé* o escribime *marcar*.`,
    salidaRegistrada: '✅ Listo, cerré tu día. ¡Buen descanso!',
    yaCerrado: '✅ Tu día ya está cerrado.',
    autoCerrado: '🔒 No contestaste a tiempo, así que cerré tu día automáticamente.\n_Si seguías trabajando (ej. en una reunión), avisame con el botón y lo revisa un admin._',
    btnReclamo: '🙋 Estaba trabajando',
  },

  // ─── Reclamos de auto-cierre ──────────────────────────────────────
  reclamo: {
    titulo: 'Reclamar cierre',
    intro: 'Tu día se cerró automáticamente. Si seguías trabajando, contanos hasta qué hora y por qué. Lo revisa un admin.',
    labelHora: '¿Hasta qué hora trabajaste?',
    labelMotivo: '¿Qué estabas haciendo?',
    placeholderMotivo: 'Ej: reunión con el cliente hasta las 19',
    enviado: (hora) => `📨 Mandé tu reclamo (salida a las *${hora}*). Te aviso cuando un admin lo revise.`,
    yaPendiente: '⏳ Ya tenés un reclamo pendiente para ese día — esperá a que lo revise un admin.',
    noAplica: 'ℹ️ Solo se puede reclamar un cierre automático que no haya sido corregido.',
    horaInvalida: 'Esa hora todavía no pasó.',
    admin: (nombre, fecha, original, pedida, motivo) => `🙋 *Reclamo de cierre — ${nombre}* (${fecha})\nCierre automático: *${original}* → pide: *${pedida}*\n> ${motivo}`,
    btnAprobar: '✅ Aprobar',
    btnRechazar: '❌ Rechazar',
    aprobadoAdmin: (nombre, pedida, admin) => `✅ Reclamo de *${nombre}* aprobado por <@${admin}> — salida corregida a *${pedida}*.`,
    rechazadoAdmin: (nombre, admin) => `❌ Reclamo de *${nombre}* rechazado por <@${admin}>.`,
    aprobadoUser: (fecha, hora) => `✅ Aprobaron tu reclamo: tu salida del ${fecha} quedó a las *${hora}*.`,
    rechazadoUser: (fecha) => `❌ No aprobaron tu reclamo del ${fecha}. Si tenés dudas, hablalo con tu admin.`,
    yaResuelto: 'Este reclamo ya fue resuelto.',
  },

  // ─── Imputación por marcas (modal) ────────────────────────────────
  marcas: {
    btn: '🗂️ Cargar mi día',
    prompt: '🗂️ *¿En qué marcas trabajaste hoy?* Elegí una o varias y ajustá el % que le dedicaste a cada una.',
    promptHint: '_Son 2 clicks: marcás las marcas y listo (arranca repartido en partes iguales). También me lo podés contar escribiendo._',
    sinCatalogo: '🗂️ Todavía no hay marcas cargadas. (Las crea el admin con `admin proyecto agregar Cliente / Proyecto`.)',
    btnDM: '🗂️ Abrir',
    abrir: 'Tocá el botón para cargar en qué marcas trabajaste:',
    guardado: (dia, pares) => `🗂️ Listo, cargué tu ${dia}: ${pares.map(p => `${p.nombre} ${p.pct}%`).join(' · ')}`,
  },

  // ─── Pings dirigidos ──────────────────────────────────────────────
  pings: {
    aviso: (desde, hasta) => `ℹ️ *Aviso:* un admin activó chequeos de actividad para vos ${desde === hasta ? `el día ${desde}` : `del ${desde} al ${hasta}`}. Vas a recibir algunos mensajes con un botón "Acá estoy" durante tu horario laboral — respondelos cuando puedas.`,
    ping: '👋 *Chequeo de actividad* — tocá el botón cuando puedas.',
    btnAca: '✅ Acá estoy',
    respondido: (seg) => `✅ Registrado — respondiste en ${seg}s.`,
    expirado: 'Este chequeo ya venció (había 10 minutos para responder).',
  },

  // ─── Resúmenes ────────────────────────────────────────────────────
  resumen: {
    sinNovedades: (n) => `✅ *Sin novedades* — ${n} presentes.`,
  },

  // ─── Errores ──────────────────────────────────────────────────────
  errores: {
    sinPermiso: '🔒 Este comando es solo para admins.',
    soloSuperAdmin: '🔒 Solo el super admin (definido en el servidor) puede nombrar admins.',
    comandoDesconocido: '❓ No entendí. Escribime `admin` solo y te muestro todas las opciones de gestión.',
    faltaMencion: '⚠️ Tenés que @mencionar al usuario (no escribas el nombre a mano).',
    fechaInvalida: '⚠️ La fecha tiene que ser YYYY-MM-DD (ej: 2026-07-15).',
  },
};
