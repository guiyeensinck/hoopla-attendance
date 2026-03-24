const t = require('./time');
const dayjs = t.dayjs;

const STATUS = {
  entry_time:   { emoji: '🟢', label: 'Entrada' },
  lunch_start:  { emoji: '🍽️', label: 'Inicio almuerzo' },
  lunch_end:    { emoji: '🔄', label: 'Fin almuerzo' },
  exit_time:    { emoji: '🔴', label: 'Salida' },
};

const OVERRIDE_LABELS = {
  holiday: '🏖️ Feriado',
  vacation: '✈️ Vacaciones',
  medical: '🏥 Turno médico',
  field: '🎬 Trabajo de campo',
  absent: '❌ Ausente',
  early_exit: '🕐 Salida temprana',
  day_off: '📅 Día libre',
};

const getNextAction = (record) => {
  if (!record || !record.entry_time) return 'entry_time';
  if (!record.lunch_start) return 'lunch_start';
  if (!record.lunch_end) return 'lunch_end';
  if (!record.exit_time) return 'exit_time';
  // Auto-closed by bot → allow correcting exit time
  if (record.auto_closed === 1) return 'exit_time';
  return null;
};

const buildAttendanceMenu = (record = null) => {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: `📋 Registro — ${t.now().format('DD/MM/YYYY')}` } }];
  if (record) {
    const parts = Object.entries(STATUS).map(([f, i]) => `${i.emoji} ${i.label}: ${record[f] || '_pendiente_'}`);
    if (record.work_mode === 'field') parts.unshift('🎬 *Trabajo de campo*');
    if (record.total_hours) parts.push(`\n⏱️ *Total: ${record.total_hours}hs*`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: parts.join('\n') } }, { type: 'divider' });
  }
  const next = getNextAction(record);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: next ? `*Siguiente:* ${STATUS[next]?.label}` : '✅ *Día completo*' } });
  return blocks;
};

const buildConfirmation = (field, time) => {
  const info = STATUS[field];
  return [{ type: 'section', text: { type: 'mrkdwn', text: `${info.emoji} *${info.label}* registrada a las *${time}*` } }];
};

const buildWeeklyReport = (summary, s, e) => {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: `📊 Reporte: ${dayjs(s).format('DD/MM')} – ${dayjs(e).format('DD/MM/YYYY')}` } }, { type: 'divider' }];
  if (!summary.length) { blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'Sin registros.' } }); return blocks; }
  for (const r of summary) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${r.real_name || r.name}*\n  📅 Días: ${r.days_worked} | ⏱️ ${r.total_hours}hs | 📊 ${r.avg_hours}hs/día` } });
  }
  return blocks;
};

const buildMissingAlert = (users) => {
  if (!users.length) return null;
  return [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Sin entrada hoy:*\n${users.map(u => u.real_name || u.name).join(', ')}` } }];
};

const buildDailySummary = (data, date) => {
  const overrideLines = data.overrides
    .filter(o => o.type !== 'holiday')
    .map(o => `  ${OVERRIDE_LABELS[o.type] || o.type}: ${o.real_name || o.name || 'Todos'}${o.reason ? ` — ${o.reason}` : ''}`)
    .join('\n');

  return [
    { type: 'header', text: { type: 'plain_text', text: `📋 Resumen del día — ${dayjs(date).format('DD/MM/YYYY')}` } },
    { type: 'section', text: { type: 'mrkdwn', text: [
      `👥 Trackeados: *${data.tracked}*`,
      `🟢 Presentes: *${data.present}*`,
      `✅ Jornada completa: *${data.complete}*`,
      `🎬 En campo: *${data.field}*`,
      `❌ Faltantes: *${data.missing}*`,
      `⏱️ Horas promedio: *${data.avgHours}hs*`,
    ].join('\n') } },
    ...(overrideLines ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Novedades:*\n${overrideLines}` } }] : []),
  ];
};

const buildOvertimeAlert = (records) => {
  if (!records.length) return null;
  const lines = records.map(r => `• ${r.real_name || r.name}: ${r.total_hours}hs`).join('\n');
  return [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Horas extra detectadas:*\n${lines}` } }];
};

const buildLunchReminder = () => [
  { type: 'section', text: { type: 'mrkdwn', text: '🍽️ Son las 14:00 y todavía no registraste tu almuerzo. Escribí `/marcar` para registrarlo.' } },
];

const buildAdminMenu = (users, trackedIds) => {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '⚙️ Panel de administración' } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '*Trackeados:*' } },
  ];
  const list = users.filter(u => trackedIds.includes(u.slack_id)).map(u => `• ${u.real_name || u.name}`).join('\n');
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: list || '_Ninguno_' } });
  blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: [
    '*Comandos:*',
    '`/admin agregar @user` — Agregar al tracking',
    '`/admin sacar @user` — Quitar del tracking',
    '`/admin lista` — Esta lista',
    '`/admin admin @user` — Dar admin (solo super)',
    '`/admin feriado 2026-04-18 Viernes Santo` — Feriado',
    '`/admin vacaciones @user 2026-04-01 2026-04-15` — Vacaciones',
    '`/admin medico @user 2026-04-05 Turno dentista` — Turno médico',
    '`/admin ausente @user 2026-04-05 Motivo` — Ausencia',
    '`/admin libre @user 2026-04-05` — Día libre',
    '`/admin novedades` — Ver novedades de hoy',
    '`/admin actividad` — Pings de la semana',
    '`/admin presencia` — Presencia Slack',
  ].join('\n') } });
  return blocks;
};

const buildPingSummaryReport = (data, s, e) => {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: `🏓 Actividad: ${dayjs(s).format('DD/MM')} – ${dayjs(e).format('DD/MM')}` } }, { type: 'divider' }];
  if (!data.length) { blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'Sin datos.' } }); return blocks; }
  for (const r of data) {
    const rate = r.total_pings > 0 ? Math.round((r.responded / r.total_pings) * 100) : 0;
    const avg = r.avg_response_ms ? Math.round(r.avg_response_ms / 1000) + 's' : '—';
    const icon = rate >= 70 ? '🟢' : rate >= 50 ? '🟡' : '🔴';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${icon} *${r.real_name || r.name}*\n  📨 ${r.total_pings} | ✅ ${r.responded} | ❌ ${r.missed} | ${rate}% | ⚡ ${avg}` } });
  }
  return blocks;
};

const buildPresenceSummaryReport = (data, s, e) => {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: `👁️ Presencia: ${dayjs(s).format('DD/MM')} – ${dayjs(e).format('DD/MM')}` } }, { type: 'divider' }];
  if (!data.length) { blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'Sin datos.' } }); return blocks; }
  for (const r of data) {
    const p = r.active_pct || 0;
    const icon = p >= 70 ? '🟢' : p >= 50 ? '🟡' : '🔴';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${icon} *${r.real_name || r.name}* — ${p}% activo (${r.active_count}/${r.total_checks} checks)` } });
  }
  return blocks;
};

module.exports = {
  STATUS, OVERRIDE_LABELS, getNextAction,
  buildAttendanceMenu, buildConfirmation, buildWeeklyReport, buildMissingAlert,
  buildDailySummary, buildOvertimeAlert, buildLunchReminder,
  buildAdminMenu, buildPingSummaryReport, buildPresenceSummaryReport,
};
