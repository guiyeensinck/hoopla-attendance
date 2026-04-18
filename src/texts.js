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

  status: {
    entry_time:   { emoji: '🟢', label: 'Entrada' },
    lunch_start:  { emoji: '🍽️', label: 'Inicio almuerzo' },
    lunch_end:    { emoji: '⏱️', label: 'Fin almuerzo' },
    exit_time:    { emoji: '🔴', label: 'Salida' },
  },
// ═══════════════════════════════════════════════════════════════════
  // 1. LABELS Y EMOJIS DE ESTADO
  // ═══════════════════════════════════════════════════════════════════
  overrides: {
    holiday:    '🏖️ Feriado',
    vacation:   '✈️ Vacaciones',
    medical:    '🏥 Turno médico',
    field:      '🎬 Trabajo de campo',
    absent:     '❌ Ausente',
    early_exit: '🕐 Salida temprana',
    day_off:    '📍 Día libre',
    meeting:    '📅 Reunión',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 2. /marcar — Lo que ve el usuario en Slack
  // ═══════════════════════════════════════════════════════════════════

  asistencia: {
    title: '🕒 *¡Hora de marcar!*',
    linkInstructions: 'Abrí este link desde tu computadora:',
    linkLabel: 'Marcá tu jornada',
    pinLabel: (pin) => `🔑 Tu PIN personal: *\`${pin}\`*`,
    expireNote: '⏱️ El link y el PIN expiran en 2 minutos. Solo funciona desde computadora.',
    alreadyComplete: '✅ Ya tenés el día completo',
    fieldRegistered: (emoji, label, time) => `🎬 *Trabajo de campo* — ${emoji} *${label}* registrada a las *${time}*`,
    fieldAlreadyComplete: '✅ Ya tenés el día completo registrado (campo).',
  },
// ═══════════════════════════════════════════════════════════════════
  // 3. /campo
  // ═══════════════════════════════════════════════════════════════════
  campo: {
    alreadyDeclared: '🎬 Ya tenés el día marcado como trabajo de campo.',
    confirmed: (reason) => `🎬 *Trabajo de campo registrado*\nMotivo: ${reason}\n\nPodés usar \`/marcar\` desde el celular hoy.`,
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
      `Para compensar, hoy podrías trabajar hasta las *${suggestedExit}*.`,
    behindGeneral: (missing) =>
      `🟡 Te faltan *${missing}hs* esta semana. Tenés hasta el viernes para compensarlas.`,
    ahead: (extra) => `🟢 Tenés *${extra}hs* de más esta semana. Bien ahí.`,
    late: (minutes) => `⚠️ Llegaste *${minutes} minutos tarde* hoy.`,
    noEntry: 'Todavía no marcaste tu entrada hoy.\nPodés hacerlo con `/marcar`.',
  },
// ═══════════════════════════════════════════════════════════════════
// 5. RECORDATORIOS AUTOMÁTICOS (DM)
// // ═══════════════════════════════════════════════════════════════════

  reminders: {
    entryMissing: () => {
      const HOOPLA_ASCII =
        '██╗░░██╗░█████╗░░█████╗░██████╗░██╗░░░░░░█████╗░\n' +
        '██║░░██║██╔══██╗██╔══██╗██╔══██╗██║░░░░░██╔══██╗\n' +
        '███████║██║░░██║██║░░██║██████╔╝██║░░░░░███████║\n' +
        '██╔══██║██║░░██║██║░░██║██╔═══╝░██║░░░░░██╔══██║\n' +
        '██║░░██║╚█████╔╝╚█████╔╝██║░░░░░███████╗██║░░██║\n' +
        '╚═╝░░╚═╝░╚════╝░░╚════╝░╚═╝░░░░░╚══════╝╚═╝░░╚═╝';
      const phrases = [
        'La creatividad es inteligencia divirtiéndose. — Einstein',
        'La imaginación es más importante que el conocimiento. — Einstein',
        'No esperes inspiración. La inspiración existe, pero tiene que encontrarte trabajando. — Picasso',
        'Cada acto de creación es, primero, un acto de destrucción. — Picasso',
        'La creatividad es conectar cosas que nadie había conectado antes. — Steve Jobs',
        'La creatividad requiere el coraje de soltar las certezas. — Erich Fromm',
        'El secreto de la creatividad es saber cómo esconder tus fuentes. — Einstein',
        'La creatividad es ver lo que todos ven y pensar lo que nadie ha pensado. — A. Szent-Györgyi',
        'La creatividad es el residuo del tiempo bien aprovechado. — Einstein',
        'Crear es resistir. Resistir es crear. — Stéphane Hessel',
      ];
      const phrase = phrases[Math.floor(Math.random() * phrases.length)];
      return '```\n' + HOOPLA_ASCII + '\n```\n\n_' + phrase + '_\n\n🔔 Son las 9:35 👀\n¿Te olvidaste de marcar tu entrada?\nPodés hacerlo con `/marcar`.';
    },
    lunchMissing: '🍽️ Son las 14:00\n¿Te olvidaste de marcar tu almuerzo?\nPodés hacerlo con `/marcar`.',
    exitMissing: '🔔 Son las 18:30\nTodavía no marcaste tu salida.\nPodés hacerlo con `/marcar`.\n\nSi no se registra, la jornada se cerrará automáticamente.',
    exitAutoClosedField: '🔒 Tu jornada de hoy fue cerrada automáticamente a las 18:30.',
    exitAutoClosedUser: (exitTime) => `🔒 Tu jornada de hoy fue cerrada automáticamente.\nSalida registrada: *${exitTime}*\nSi esto no es correcto, podés pedir que lo corrijan.`,
    meetingOver: (time) => `📍 Tu reunión terminó a las ${time}. ¿Ya volviste? Si necesitás registrar algo, usá \`/marcar\`.`,
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
      message: 'El PIN no coincide. Probá generando uno nuevo con `/marcar`.',
    },
    dayComplete: {
      title: '✅ Día completo',
      message: (name) => `${name}, ya tenés todas las marcaciones registradas para hoy.`,
    },
    registering: 'Registrando',
    pinFieldLabel: 'Ingresá el PIN que te apareció en Slack',
    submitButton: (label) => `✅ Marcar ${label}`,
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
