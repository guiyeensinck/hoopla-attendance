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

const NOVEDADES = {
  feriado:    '🏖️ Feriado',
  vacaciones: '✈️ Vacaciones',
  medico:     '🏥 Turno médico',
  ausente:    '❌ Ausente',
  libre:      '📅 Día libre',
  salida:     '🕐 Salida autorizada',
  remoto:     '📱 Fichaje remoto',
};

module.exports = {
  TIPOS,
  NOVEDADES,

  // ─── Chat por DM (el bot se usa como un compañero) ────────────────
  chat: {
    menuSaludo: (nombre) => `👋 ¡Hola, ${nombre}! ¿Qué necesitás?`,
    btnMarcar: (label) => `🕒 Marcar ${label}`,
    btnSemana: '📊 Mi semana',
    menuHint: '_También podés escribirme directo: *marcar* (te mando el link) u *horarios* (tu semana)._',
    adminHint: '_Sos admin: escribí *admin* para ver los comandos de gestión._',
  },

  // ─── Marcación ────────────────────────────────────────────────────
  marcar: {
    linkTitle: '🕒 *¡Hora de marcar!*',
    linkInstructions: (label) => `Vas a registrar: *${label}*. Abrí este link desde tu computadora:`,
    linkLabel: 'Marcar mi jornada',
    linkCorreccion: 'Tu salida fue cerrada automáticamente. Con este link podés corregirla (una sola vez):',
    expireNote: '⏱️ El link es de un solo uso y expira en 5 minutos.',
    diaCompleto: '✅ Ya tenés la jornada completa registrada por hoy.',
    noTrackeado: '⚠️ Todavía no estás en el seguimiento de asistencia. Pedile a un admin que te agregue.',
    noTrackeadoAdmin: '⚠️ Todavía no estás en el seguimiento de asistencia. Como sos admin, agregate vos: escribime `admin agregarme`.',
  },

  // ─── Página web ───────────────────────────────────────────────────
  web: {
    mobileBloqueado: 'El registro solo puede hacerse desde una computadora.',
    mobileBloqueadoDetalle: 'Abrí el link desde tu compu. Si tenés autorización para fichar desde el celular, pedile al admin que cargue `remoto` para hoy.',
    linkInvalido: 'Link inválido o expirado',
    linkInvalidoDetalle: 'Este link ya fue usado o venció (dura 5 minutos). Escribile "marcar" al bot en Slack y te manda uno nuevo.',
    registrado: '✅ Registrado',
    corregido: '✅ Salida corregida',
    diaCompleto: '✅ Día completo',
    tarde: (min) => `⚠️ Llegaste ${min} min tarde según tu horario.`,
    anticipado: (min) => `⚠️ Saliste ${min} min antes de tu horario.`,
    balanceOk: 'Justo en horario. 💪',
    balanceAFavor: (hs) => `Tenés ${hs}hs a favor esta semana. Excelente.`,
    balanceDebe: (hs, hora) => `Te faltan ${hs}hs esta semana. Para compensar hoy, quedate hasta las ${hora}.`,
    balanceDebeGeneral: (hs) => `Te faltan ${hs}hs esta semana. Tenés hasta el viernes para compensar.`,
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
• Tu presencia en Slack (activo/ausente) únicamente dentro de tu horario laboral.

*¿Qué ve el admin?*
Tus horarios marcados, llegadas tarde y cierres automáticos. Nadie más del equipo ve tus datos.

*¿Cómo marco?*
Escribime *marcar* acá en este chat (como le escribirías a cualquier compañero). Te mando un link de un solo uso (dura 5 min) que se abre *desde la computadora*. La hora la pone el servidor.

*Tu horario asignado*
🕐 ${user.hora_entrada} a ${user.hora_salida} — ${user.carga_horaria}hs por día. Si está mal, avisale a tu admin.

*¿Y al final del día?*
Cuando llegue tu horario de salida, si todavía no marcaste te escribo con un botón para cerrar el día. Si no respondés en 20 minutos, registro tu salida a tu horario automáticamente (podés corregirla una vez si seguías trabajando).

*¿Ausencias, médico, vacaciones?*
Avisale a tu admin, que las carga en el sistema para que no te cuenten como falta.

Escribime *horarios* cuando quieras ver tu estado del día y tu balance semanal. 📊`,

  // ─── Recordatorios ────────────────────────────────────────────────
  recordatorios: {
    entrada: (hora) => `⏰ *¿Arrancaste?* Tu horario de entrada era ${hora} y todavía no marcaste. Escribime *marcar* y te mando el link.`,
    faltantesAdmin: (lista) => `⚠️ *Sin fichar pasada 1 hora de su horario de entrada:*\n${lista}`,
  },

  // ─── Cierre del día ───────────────────────────────────────────────
  cierre: {
    dm: (hora) => `🌆 *Llegó tu horario de salida (${hora}).* ¿Cerramos el día?\n_Si no respondés en 20 minutos, registro tu salida a las ${hora} automáticamente (después podés corregirla una vez si seguías trabajando)._`,
    btnSalida: '🔴 Marcar salida',
    salidaRegistrada: (hora) => `✅ Salida registrada a las *${hora}*. ¡Buen descanso!`,
    yaCerrado: '✅ Tu salida ya estaba registrada.',
    autoCerrado: (hora) => `🔒 No respondiste, así que registré tu salida automáticamente a las *${hora}* (tu horario). Si seguías trabajando, podés corregirla una sola vez: escribime *marcar*.`,
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
