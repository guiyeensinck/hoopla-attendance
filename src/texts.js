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
    menuSaludo: (nombre) => `👋 ¡Hola, ${nombre}! ¿Qué necesitás?`,
    btnMarcar: (label) => `🕒 Marcar ${label}`,
    btnSemana: '📊 Mi semana',
    menuHint: '_También podés escribirme *marcar*, *cargar*, *horarios* o *proyectos* — o usar los comandos `/marcar`, `/cargar`, `/horarios`, `/ayuda` desde cualquier lado._',
    btnReclamo: '🙋 Reclamar cierre',
    adminHint: '_Sos admin: escribí *admin* para ver los comandos de gestión._',
    modoSoloProyectos: (hora) => `ℹ️ *Te configuraron en modo "solo proyectos".*\nNo tenés que marcar entrada/salida ni te van a llegar recordatorios de asistencia. Lo único: cada día alrededor de las ${hora} te voy a preguntar en qué proyectos trabajaste — respondeme tipo \`Jumbo 4, Interno 2\`. También podés mandarme la imputación cuando quieras, sin esperar la pregunta.`,
  },

  // ─── Marcación ────────────────────────────────────────────────────
  marcar: {
    linkTitle: '🕒 *¡Hora de marcar!*',
    linkInstructions: (label) => `Vas a registrar: *${label}*. Abrí este link desde tu computadora:`,
    linkLabel: (emoji, label) => `${emoji} Marcar ${label.toLowerCase()}`,
    expireNote: '⏱️ El link es de un solo uso y expira en 5 minutos.',
    diaCompleto: '✅ Ya tenés la jornada completa registrada por hoy.',
    noTrackeado: '⚠️ Todavía no estás en el seguimiento de asistencia. Pedile a un admin que te agregue.',
    confirmacionDM: (emoji, label, hora) => `${emoji} *${label}* registrada a las *${hora}* desde la web. 👌`,
    confirmacionTarde: (min) => ` _(+${min} min tarde según tu horario)_`,
    noTrackeadoAdmin: '⚠️ Todavía no estás en el seguimiento de asistencia. Como sos admin, agregate vos: escribime `admin agregarme`.',
  },

  // ─── Página web ───────────────────────────────────────────────────
  web: {
    mobileBloqueado: 'El registro solo puede hacerse desde una computadora.',
    mobileBloqueadoDetalle: 'Abrí el link desde tu compu. Si tenés autorización para fichar desde el celular, pedile al admin que cargue `remoto` para hoy.',
    linkInvalido: 'Link inválido o expirado',
    linkInvalidoDetalle: 'Este link ya fue usado o venció (dura 5 minutos). Escribile "marcar" al bot en Slack y te manda uno nuevo.',
    registrado: '✅ Registrado',
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
    restoNegativo: (base) => `⚠️ Pediste imputar "el resto", pero con lo que detallaste ya llegás a las ${base}hs del día — no queda resto. Mandámela de nuevo.`,
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

*¿Qué registra el sistema?*
• Tus marcaciones del día: entrada, inicio y fin de almuerzo, y salida.
• Tu actividad en Slack: presencia (activo/ausente) cada 2 minutos entre las 7 y las 23 en días hábiles, y la *hora* (nunca el contenido) de tus mensajes y reacciones en canales donde está el bot.

*¿Qué ve el admin?*
Tus horarios marcados, llegadas tarde, cierres automáticos y tu actividad en Slack. Nadie más del equipo ve tus datos.

*¿Cómo marco?*
Escribime *marcar* acá (o usá \`/marcar\` desde cualquier lado). Te mando un link de un solo uso (dura 5 min) que se abre *desde la computadora*. La hora la pone el servidor.

*Tu horario asignado*
🕐 ${user.hora_entrada} a ${user.hora_salida} — ${user.carga_horaria}hs por día. Los viernes la salida es a las 17:30. Si está mal, avisale a tu admin.

*¿Y al final del día?*
A tu horario de salida te pregunto si terminaste:
• *Terminé* → registro tu salida.
• *Sigo trabajando* → te vuelvo a preguntar cada 20 minutos. Las horas extra suman a tu balance.
• *Si no contestás en 3 minutos*, cierro tu día en tu última actividad en Slack. Si estabas en una reunión sin tocar la compu, podés mandar un reclamo y lo revisa un admin.

Después te pregunto en qué marcas trabajaste: elegís las marcas y el % de cada una.

*¿Ausencias, médico, vacaciones?*
Avisale a tu admin, que las carga en el sistema para que no te cuenten como falta.

Escribí \`/ayuda\` cuando quieras ver cómo funciona todo. 📊`,

  // ─── /ayuda ───────────────────────────────────────────────────────
  ayuda: `📖 *Cómo funciona la asistencia*

*Tu día*
1. *Entrada* — \`/marcar\` (o escribime *marcar*) y abrí el link desde la compu.
2. *Almuerzo* — marcá inicio y fin igual que la entrada.
3. *Salida* — a tu horario (viernes 17:30) te pregunto *¿terminaste?*
   • ✅ *Terminé* → cierro tu día.
   • 💪 *Sigo trabajando* → te repregunto cada 20'. Las horas extra suman.
   • Sin respuesta en 3' → cierro en tu *última actividad en Slack*. ¿Estabas en una reunión? Tocá *🙋 Estaba trabajando* y un admin lo revisa.
4. *¿En qué trabajaste?* — elegís las marcas y el % de cada una.

*Comandos*
\`/marcar\` — link para tu próxima marcación
\`/cargar\` — cargar en qué marcas trabajaste (en cualquier momento)
\`/horarios\` — tu día, tu semana y tu saldo del mes
\`/proyectos\` — catálogo y lo que llevás imputado
\`/misemana\` — tu semana en proyectos (web)
\`/ayuda\` — esto

*Qué se registra*
Tus marcaciones y tu actividad en Slack (presencia y la hora de tus mensajes en canales, nunca el contenido). Solo vos y los admins ven tus datos.`,

  // ─── Recordatorios ────────────────────────────────────────────────
  recordatorios: {
    entrada: (hora) => `⏰ *¿Arrancaste?* Tu horario de entrada era ${hora} y todavía no marcaste. Escribime *marcar* y te mando el link.`,
    almuerzoInicio: '🍽️ *¿Saliste a almorzar?* No marcaste el inicio del almuerzo — escribime *marcar* cuando arranques.',
    almuerzoFin: (inicio) => `⏱️ Marcaste inicio de almuerzo a las ${inicio} y ya pasó más de una hora. Si volviste, escribime *marcar* para cerrar el almuerzo.`,
    faltantesAdmin: (lista) => `⚠️ *Sin fichar pasada 1 hora de su horario de entrada:*\n${lista}`,
  },

  // ─── Cierre del día ───────────────────────────────────────────────
  cierre: {
    pregunta: (hora, min) => `🌆 *Son las ${hora}, tu horario de salida.* ¿Terminaste por hoy?\n_Si no contestás en ${minutos(min)}, cierro tu día en tu última actividad en Slack._`,
    preguntaSigo: (min) => `💪 *¿Seguís trabajando?*\n_Si no contestás en ${minutos(min)}, cierro tu día en tu última actividad en Slack (como mínimo, la última vez que me contestaste)._`,
    btnTermine: '✅ Terminé',
    btnSigo: '💪 Sigo trabajando',
    sigoOk: (proxima) => `💪 Dale, anotado. Te vuelvo a preguntar a las *${proxima}*. Cuando termines, tocá *Terminé* o escribime *marcar*.`,
    salidaRegistrada: (hora) => `✅ Salida registrada a las *${hora}*. ¡Buen descanso!`,
    yaCerrado: (hora) => `✅ Tu día ya está cerrado${hora ? ` (salida ${hora})` : ''}.`,
    autoCerrado: (hora, motivo) => ({
      actividad: `🔒 No contestaste a tiempo, así que cerré tu día a las *${hora}*: tu última actividad en Slack.`,
      respuesta: `🔒 No contestaste a tiempo, así que cerré tu día a las *${hora}*: la última vez que me dijiste que seguías.`,
      sin_datos: `🔒 No contestaste a tiempo y no tengo actividad tuya en Slack, así que cerré tu día a las *${hora}* (tu horario).`,
    }[motivo]) + '\n_Si estabas trabajando sin usar Slack (ej. en una reunión), mandá un reclamo y lo revisa un admin._',
    btnReclamo: '🙋 Estaba trabajando',
  },

  // ─── Reclamos de auto-cierre ──────────────────────────────────────
  reclamo: {
    titulo: 'Reclamar cierre',
    intro: (hora) => `Tu día se cerró automáticamente a las *${hora}*. Si seguías trabajando, decinos hasta qué hora y por qué. Lo revisa un admin.`,
    labelHora: '¿Hasta qué hora trabajaste?',
    labelMotivo: '¿Qué estabas haciendo?',
    placeholderMotivo: 'Ej: reunión con el cliente hasta las 19',
    enviado: (hora) => `📨 Mandé tu reclamo (salida a las *${hora}*). Te aviso cuando un admin lo revise.`,
    yaPendiente: '⏳ Ya tenés un reclamo pendiente para ese día — esperá a que lo revise un admin.',
    noAplica: 'ℹ️ Solo se puede reclamar un cierre automático que no haya sido corregido.',
    horaInvalida: (salida) => `Tiene que ser después de ${salida} (el cierre automático) y no en el futuro.`,
    admin: (nombre, fecha, original, pedida, motivo) => `🙋 *Reclamo de cierre — ${nombre}* (${fecha})\nCierre automático: *${original}* → pide: *${pedida}*\n> ${motivo}`,
    btnAprobar: '✅ Aprobar',
    btnRechazar: '❌ Rechazar',
    aprobadoAdmin: (nombre, pedida, admin) => `✅ Reclamo de *${nombre}* aprobado por <@${admin}> — salida corregida a *${pedida}*.`,
    rechazadoAdmin: (nombre, admin) => `❌ Reclamo de *${nombre}* rechazado por <@${admin}>.`,
    aprobadoUser: (fecha, hora) => `✅ Aprobaron tu reclamo: tu salida del ${fecha} quedó a las *${hora}*.`,
    rechazadoUser: (fecha, hora) => `❌ Rechazaron tu reclamo del ${fecha}: la salida queda a las *${hora}*. Si tenés dudas, hablalo con tu admin.`,
    yaResuelto: 'Este reclamo ya fue resuelto.',
  },

  // ─── Imputación por marcas (modal) ────────────────────────────────
  marcas: {
    btn: '🗂️ Cargar mi día',
    prompt: (horas, imputadas) => imputadas > 0
      ? `🗂️ *Llevás cargadas ${imputadas}hs${horas != null ? ` de las ${horas}hs de hoy` : ''}.* ¿Completamos? Elegí las marcas y el % que le dedicaste a cada una.`
      : `🗂️ *¿En qué marcas trabajaste hoy${horas != null ? ` (${horas}hs)` : ''}?* Elegí una o varias y ajustá el % de cada una.`,
    promptHint: '_Son 2 clicks: marcás las marcas y listo (arranca repartido en partes iguales). También podés escribirme `Jumbo 4, Interno 2`._',
    sinCatalogo: '🗂️ Todavía no hay marcas cargadas. (Las crea el admin con `admin proyecto agregar Cliente / Proyecto`.)',
    btnDM: '🗂️ Abrir',
    abrir: 'Tocá el botón para cargar en qué marcas trabajaste:',
    guardado: (dia, pares, horas) => `🗂️ Listo, cargué tu ${dia} (${horas}hs): ${pares.map(p => `${p.nombre} ${p.pct}% (${p.horas}hs)`).join(' · ')}`,
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
