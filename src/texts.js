/**
 * TODOS LOS TEXTOS QUE VEN LOS USUARIOS
 * Editá lo que quieras y después importá este archivo desde los demás módulos.
 * Las variables entre ${} se reemplazan dinámicamente.
 *
 * Secciones:
 * 1. Labels y emojis de estado
 * 2. Mensajes de /marcar (Slack)
 * 3. Mensajes de /campo
 * 4. Mensajes de /horarios
 * 5. Recordatorios automáticos (DM al usuario)
 * 6. Alertas al canal (las ve el admin)
 * 7. Pings de actividad
 * 8. Página web de verificación
 * 9. Labels de novedades (overrides)
 * 10. Errores
 */

module.exports = {

  // ═══════════════════════════════════════════════════════════════════
  // 1. LABELS Y EMOJIS DE ESTADO
  // ═══════════════════════════════════════════════════════════════════

  status: {
    entry_time:   { emoji: '🟢', label: 'Entrada' },
    lunch_start:  { emoji: '🍽️', label: 'Inicio almuerzo' },
    lunch_end:    { emoji: '🔄', label: 'Fin almuerzo' },
    exit_time:    { emoji: '🔴', label: 'Salida' },
  },

  overrides: {
    holiday:    '🏖️ Feriado',
    vacation:   '✈️ Vacaciones',
    medical:    '🏥 Turno médico',
    field:      '🎬 Trabajo de campo',
    absent:     '❌ Ausente',
    early_exit: '🕐 Salida temprana',
    day_off:    '📅 Día libre',
    meeting:    '📍 Reunión',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 2. /marcar — Lo que ve el usuario en Slack
  // ═══════════════════════════════════════════════════════════════════

  asistencia: {
    title: '📋 *Registro de asistencia*',
    linkInstructions: 'Abrí este link *desde tu computadora*:',
    linkLabel: 'Registrar asistencia',
    pinLabel: (pin) => `🔑 Tu PIN personal: *\`${pin}\`*`,
    expireNote: '⏱️ Link y PIN expiran en 2 minutos. Solo funciona desde desktop.',
    alreadyComplete: '✅ Ya tenés el día completo registrado.',
    fieldRegistered: (emoji, label, time) => `🎬 *Campo* — ${emoji} *${label}* registrada a las *${time}*`,
    fieldAlreadyComplete: '✅ Ya tenés el día completo registrado (campo).',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 3. /campo
  // ═══════════════════════════════════════════════════════════════════

  campo: {
    alreadyDeclared: '🎬 Ya tenés el día marcado como trabajo de campo.',
    confirmed: (reason) => `🎬 *Trabajo de campo registrado*\nMotivo: ${reason}\n\nPodés usar \`/marcar\` directo desde el celular hoy.`,
  },

  // ═══════════════════════════════════════════════════════════════════
  // 4. /horarios — Balance y estado del día
  // ═══════════════════════════════════════════════════════════════════

  estado: {
    title: (date) => `📊 *Tu estado — ${date}*`,
    pending: '_pendiente_',
    dayComplete: '✅ Jornada completa',
    dayInProgress: '⏳ Jornada en curso',
    weeklyBalance: (worked, expected, diff) =>
      `📅 *Balance semanal:*\n` +
      `  Horas trabajadas: *${worked}hs*\n` +
      `  Horas esperadas: *${expected}hs*\n` +
      `  Diferencia: *${diff > 0 ? '+' : ''}${diff}hs*`,
    onTrack: '🟢 Vas bien esta semana.',
    behind: (missing, suggestedExit) =>
      `🟡 Te faltan *${missing}hs* esta semana. ` +
      `Para compensar, hoy deberías quedarte hasta las *${suggestedExit}*.`,
    behindGeneral: (missing) =>
      `🟡 Te faltan *${missing}hs* esta semana. Tenés hasta el viernes para compensarlas.`,
    ahead: (extra) => `🟢 Tenés *${extra}hs* de más esta semana. Bien ahí.`,
    late: (minutes) => `⚠️ Llegaste *${minutes} minutos tarde* hoy.`,
    noEntry: 'Todavía no registraste tu entrada hoy. Escribí `/marcar`.',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 5. RECORDATORIOS AUTOMÁTICOS (DM)
  // ═══════════════════════════════════════════════════════════════════

  reminders: {
    entryMissing: '🔔 Son las 9:35 y todavía no registraste tu entrada. Escribí `/marcar` para fichar.',
    lunchMissing: '🍽️ Son las 14:00 y todavía no registraste tu almuerzo. Escribí `/marcar` para registrarlo.',
    exitMissing: '🔔 Todavía no registraste tu salida. Escribí `/marcar` para completar.',
    meetingOver: (time) => `📍 Tu reunión terminó a las ${time}. ¿Ya volviste a tu puesto? Escribí \`/marcar\` si necesitás registrar algo.`,
  },

  // ═══════════════════════════════════════════════════════════════════
  // 6. ALERTAS AL CANAL (admin)
  // ═══════════════════════════════════════════════════════════════════

  alerts: {
    missingEntry: (names) => `⚠️ *Sin entrada hoy:*\n${names}`,
    overtime: (lines) => `⚠️ *Horas extra detectadas:*\n${lines}`,
    dailySummaryTitle: (date) => `📋 Resumen del día — ${date}`,
    weeklyReportTitle: (range) => `📊 Reporte: ${range}`,
    monthlyReportTitle: (month) => `📊 Reporte mensual: ${month}`,
  },

  // ═══════════════════════════════════════════════════════════════════
  // 7. PINGS DE ACTIVIDAD
  // ═══════════════════════════════════════════════════════════════════

  pings: {
    message: '🏓 *Check de actividad*\n¿Seguís ahí? Tocá el botón para confirmar.',
    buttonLabel: '✅ Acá estoy',
    timeout: (minutes) => `⏱️ Tenés ${minutes} minutos para responder`,
    fallbackText: '🏓 Check de actividad — ¿seguís ahí?',
    responded: (seconds) => `✅ Respuesta en ${seconds}s. ¡Bien ahí!`,
    expired: '⏱️ Ping expirado o ya respondido.',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 8. PÁGINA WEB DE VERIFICACIÓN
  // ═══════════════════════════════════════════════════════════════════

  verify: {
    mobileBlocked: {
      title: 'Dispositivo no permitido',
      message: 'Este registro solo funciona desde un navegador de escritorio. Abrí el link desde tu computadora.',
    },
    linkExpired: {
      title: 'Link expirado',
      message: 'Este link ya fue usado o expiró. Generá uno nuevo con /marcar en Slack.',
    },
    wrongPin: {
      title: 'PIN incorrecto',
      message: 'El PIN no coincide con el que te apareció en Slack. Volvé a intentar con /marcar.',
    },
    dayComplete: {
      title: '✅ Día completo',
      message: (name) => `${name}, ya tenés todas las marcaciones registradas para hoy.`,
    },
    registering: 'Registrando',
    pinFieldLabel: 'Ingresá el PIN que te apareció en Slack',
    submitButton: (label) => `✅ Registrar ${label}`,
    successTitle: '✅ Registrado',
    successDetail: (label, time) => `*${label}* a las *${time}*`,
  },

  // ═══════════════════════════════════════════════════════════════════
  // 9. REUNIONES
  // ═══════════════════════════════════════════════════════════════════

  meetings: {
    started: (reason, time) => `📍 *Reunión registrada*\nMotivo: ${reason}\nInicio: ${time}\n\nCuando termines, escribí \`/reunion fin\`.`,
    ended: (time, duration) => `📍 *Reunión finalizada*\nHora: ${time}\nDuración: ${duration} minutos`,
    noActive: 'No tenés ninguna reunión activa.',
    alreadyInMeeting: 'Ya tenés una reunión activa. Cerrala con `/reunion fin` antes de empezar otra.',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 10. ERRORES Y PERMISOS
  // ═══════════════════════════════════════════════════════════════════

  errors: {
    noPermission: '🔒 No tenés permisos de admin.',
    superOnly: '🔒 Solo el super admin puede otorgar permisos.',
    unknownCommand: '❓ Comando no reconocido. `/admin lista` para ver opciones.',
    dataIncomplete: 'Faltó la acción a registrar.',
  },
};
