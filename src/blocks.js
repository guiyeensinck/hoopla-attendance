const dayjs = require('dayjs');

// ─── Status mapping ────────────────────────────────────────────────
const STATUS = {
  entry_time:   { emoji: '🟢', label: 'Entrada' },
  lunch_start:  { emoji: '🍽️', label: 'Inicio almuerzo' },
  lunch_end:    { emoji: '🔄', label: 'Fin almuerzo' },
  exit_time:    { emoji: '🔴', label: 'Salida' },
};

// ─── Time options (every 15 min) ───────────────────────────────────
const generateTimeOptions = (startHour = 7, endHour = 22) => {
  const options = [];
  for (let h = startHour; h <= endHour; h++) {
    for (const m of ['00', '15', '30', '45']) {
      const time = `${String(h).padStart(2, '0')}:${m}`;
      options.push({ text: { type: 'plain_text', text: time }, value: time });
    }
  }
  return options;
};

// ═══════════════════════════════════════════════════════════════════
// ATTENDANCE MENU
// ═══════════════════════════════════════════════════════════════════

const getNextAction = (record) => {
  if (!record || !record.entry_time) return 'entry_time';
  if (!record.lunch_start) return 'lunch_start';
  if (!record.lunch_end) return 'lunch_end';
  if (!record.exit_time) return 'exit_time';
  return null;
};

const buildAttendanceMenu = (record = null) => {
  const today = dayjs().format('YYYY-MM-DD');
  const blocks = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `📋 Registro de asistencia — ${dayjs().format('DD/MM/YYYY')}` },
  });

  if (record) {
    const parts = [];
    for (const [field, info] of Object.entries(STATUS)) {
      parts.push(`${info.emoji} ${info.label}: ${record[field] || '_pendiente_'}`);
    }
    if (record.total_hours) parts.push(`\n⏱️ *Total: ${record.total_hours}hs*`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: parts.join('\n') } });
    blocks.push({ type: 'divider' });
  }

  const nextAction = getNextAction(record);

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: nextAction
        ? `*Siguiente paso:* ${STATUS[nextAction]?.label || 'Registrar'}`
        : '✅ *Día completo registrado*',
    },
  });

  if (nextAction) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'static_select',
          placeholder: { type: 'plain_text', text: '¿Qué registrás?' },
          action_id: 'select_action_type',
          initial_option: {
            text: { type: 'plain_text', text: STATUS[nextAction].label },
            value: nextAction,
          },
          options: Object.entries(STATUS)
            .filter(([field]) => !record || !record[field])
            .map(([field, info]) => ({
              text: { type: 'plain_text', text: `${info.emoji} ${info.label}` },
              value: field,
            })),
        },
        {
          type: 'static_select',
          placeholder: { type: 'plain_text', text: 'Hora' },
          action_id: 'select_time',
          options: generateTimeOptions(),
        },
      ],
    });

    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Registrar' },
          style: 'primary',
          action_id: 'confirm_attendance',
          value: today,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '⏱️ Registrar ahora' },
          action_id: 'register_now',
          value: today,
        },
      ],
    });
  }

  return blocks;
};

const buildConfirmation = (actionField, time) => {
  const info = STATUS[actionField];
  return [{
    type: 'section',
    text: { type: 'mrkdwn', text: `${info.emoji} *${info.label}* registrada a las *${time}*` },
  }];
};

// ═══════════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════════

const buildWeeklyReport = (summary, startDate, endDate) => {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 Reporte: ${dayjs(startDate).format('DD/MM')} – ${dayjs(endDate).format('DD/MM/YYYY')}` },
    },
    { type: 'divider' },
  ];

  if (summary.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No hay registros para este período.' } });
    return blocks;
  }

  for (const row of summary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${row.real_name || row.name}*`,
          `  📅 Días: ${row.days_worked}`,
          `  ⏱️ Horas: ${row.total_hours}hs`,
          `  📊 Promedio: ${row.avg_hours}hs/día`,
        ].join('\n'),
      },
    });
  }

  return blocks;
};

const buildMissingAlert = (missingUsers) => {
  if (missingUsers.length === 0) return null;
  const names = missingUsers.map(u => u.real_name || u.name).join(', ');
  return [{
    type: 'section',
    text: { type: 'mrkdwn', text: `⚠️ *Sin registro de entrada hoy:*\n${names}` },
  }];
};

// ═══════════════════════════════════════════════════════════════════
// ADMIN MENU
// ═══════════════════════════════════════════════════════════════════

const buildAdminMenu = (users, trackedIds) => {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '⚙️ Panel de administración' },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Usuarios trackeados* (deben fichar y reciben pings):',
      },
    },
  ];

  if (trackedIds.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_Ninguno configurado todavía_' },
    });
  } else {
    const trackedList = users
      .filter(u => trackedIds.includes(u.slack_id))
      .map(u => `• ${u.real_name || u.name} — \`${u.slack_id}\``)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: trackedList || '_Ninguno_' },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*Comandos disponibles:*',
        '`/admin agregar @usuario` — Agregar usuario al tracking',
        '`/admin sacar @usuario` — Quitar usuario del tracking',
        '`/admin lista` — Ver esta lista',
        '`/admin admin @usuario` — Dar permisos de admin',
        '`/admin actividad` — Ver resumen de pings de la semana',
        '`/admin presencia` — Ver resumen de presencia Slack',
      ].join('\n'),
    },
  });

  return blocks;
};

// ═══════════════════════════════════════════════════════════════════
// ACTIVITY REPORTS
// ═══════════════════════════════════════════════════════════════════

const buildPingSummaryReport = (pingSummary, startDate, endDate) => {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🏓 Actividad: ${dayjs(startDate).format('DD/MM')} – ${dayjs(endDate).format('DD/MM')}` },
    },
    { type: 'divider' },
  ];

  if (pingSummary.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No hay datos de pings para el período.' } });
    return blocks;
  }

  for (const row of pingSummary) {
    const avgSec = row.avg_response_ms ? Math.round(row.avg_response_ms / 1000) : null;
    const responseRate = row.total_pings > 0
      ? Math.round((row.responded / row.total_pings) * 100)
      : 0;

    let statusIcon = '🟢';
    if (responseRate < 70) statusIcon = '🟡';
    if (responseRate < 50) statusIcon = '🔴';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${statusIcon} *${row.real_name || row.name}*`,
          `  📨 Pings: ${row.total_pings} | ✅ ${row.responded} | ❌ ${row.missed}`,
          `  📊 Tasa de respuesta: ${responseRate}%`,
          avgSec ? `  ⚡ Respuesta promedio: ${avgSec}s` : '',
        ].filter(Boolean).join('\n'),
      },
    });
  }

  return blocks;
};

const buildPresenceSummaryReport = (presenceData, startDate, endDate) => {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `👁️ Presencia Slack: ${dayjs(startDate).format('DD/MM')} – ${dayjs(endDate).format('DD/MM')}` },
    },
    { type: 'divider' },
  ];

  if (presenceData.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No hay datos de presencia para el período.' } });
    return blocks;
  }

  for (const row of presenceData) {
    let statusIcon = '🟢';
    if (row.active_pct < 70) statusIcon = '🟡';
    if (row.active_pct < 50) statusIcon = '🔴';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${statusIcon} *${row.real_name || row.name}*`,
          `  Checks: ${row.total_checks} | 🟢 Active: ${row.active_count} | ⚪ Away: ${row.away_count}`,
          `  Presencia activa: ${row.active_pct}%`,
        ].join('\n'),
      },
    });
  }

  return blocks;
};

module.exports = {
  STATUS,
  generateTimeOptions,
  getNextAction,
  buildAttendanceMenu,
  buildConfirmation,
  buildWeeklyReport,
  buildMissingAlert,
  buildAdminMenu,
  buildPingSummaryReport,
  buildPresenceSummaryReport,
};
