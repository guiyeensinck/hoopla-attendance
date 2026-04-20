const t = require('./time');
const dayjs = t.dayjs;
const db = require('./database');

// ─── Leave type definitions ────────────────────────────────────────
// group: used to aggregate quota checks
const LEAVE_TYPES = {
  vacation_summer: {
    label: 'Vacaciones de verano',
    emoji: '🏖️',
    override: 'vacation',
    multi: true,
    group: 'vacation',
    hint: '14 días corridos · Oct–Abr · Inicia lunes · 4 semanas de anticipación',
  },
  vacation_winter: {
    label: 'Vacaciones de invierno',
    emoji: '⛷️',
    override: 'vacation',
    multi: true,
    group: 'vacation',
    hint: '7 días corridos · Jul–Sep · Inicia lunes · 4 semanas de anticipación',
  },
  personal: {
    label: 'Trámite personal (día completo)',
    emoji: '📅',
    override: 'day_off',
    multi: false,
    group: 'personal',
    hint: '2 días/año · máx 1 día c/2 meses · 2 semanas de anticipación',
  },
  personal_am: {
    label: 'Trámite personal (½ día AM — hasta 13hs)',
    emoji: '🌅',
    override: 'day_off',
    multi: false,
    group: 'personal',
    hint: '4 medios días/año · máx 2 medios días c/2 meses · 2 semanas anticipación',
  },
  personal_pm: {
    label: 'Trámite personal (½ día PM — desde 15hs)',
    emoji: '🌇',
    override: 'early_exit',
    multi: false,
    group: 'personal',
    hint: '4 medios días/año · máx 2 medios días c/2 meses · 2 semanas anticipación',
  },
  medical_am: {
    label: 'Turno médico (AM — hasta 13hs)',
    emoji: '🏥',
    override: 'day_off',
    multi: false,
    group: 'medical',
    hint: '4 medios días/año · requiere certificado',
  },
  medical_pm: {
    label: 'Turno médico (PM — desde 15hs)',
    emoji: '🏥',
    override: 'early_exit',
    multi: false,
    group: 'medical',
    hint: '4 medios días/año · requiere certificado',
  },
  exam: {
    label: 'Día de examen',
    emoji: '📚',
    override: 'day_off',
    multi: true,
    group: 'exam',
    hint: '10 días/año (5 por semestre) · máx 4/mes · 10 días hábiles anticipación · solo universitarios',
  },
  bereavement: {
    label: 'Duelo familiar',
    emoji: '💙',
    override: 'absent',
    multi: true,
    group: 'other',
    hint: 'Requiere documentación',
  },
};

const typeInfo = (type) => LEAVE_TYPES[type] || { label: type, emoji: '📋', override: 'day_off', multi: false, group: 'other', hint: '' };

const periodLabel = (dateFrom, dateTo) =>
  dateFrom === dateTo
    ? dayjs(dateFrom).format('DD/MM/YYYY')
    : `${dayjs(dateFrom).format('DD/MM')} al ${dayjs(dateTo).format('DD/MM/YYYY')}`;

// ─── Modal builder ─────────────────────────────────────────────────

const buildRequestModal = () => ({
  type: 'modal',
  callback_id: 'modal_leave_request',
  title: { type: 'plain_text', text: 'Pedir ausencia' },
  submit: { type: 'plain_text', text: 'Enviar solicitud' },
  close: { type: 'plain_text', text: 'Cancelar' },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '📋 Completá el formulario.\n\n⚠️ *Pedir no es otorgar* — tu solicitud será revisada. Te avisamos cuando haya una respuesta.\n\n_Las políticas de RRHH aplican automáticamente. Si algo no está permitido, el sistema te lo indica antes de enviar._',
      },
    },
    { type: 'divider' },
    {
      type: 'input',
      block_id: 'blk_type',
      label: { type: 'plain_text', text: 'Tipo de ausencia' },
      element: {
        type: 'static_select',
        action_id: 'sel_type',
        placeholder: { type: 'plain_text', text: 'Elegí...' },
        option_groups: [
          {
            label: { type: 'plain_text', text: '🏖️  Vacaciones' },
            options: [
              { text: { type: 'plain_text', text: '🏖️  Vacaciones de verano' }, value: 'vacation_summer' },
              { text: { type: 'plain_text', text: '⛷️  Vacaciones de invierno' }, value: 'vacation_winter' },
            ],
          },
          {
            label: { type: 'plain_text', text: '📅  Trámites personales' },
            options: [
              { text: { type: 'plain_text', text: '📅  Trámite personal — día completo' }, value: 'personal' },
              { text: { type: 'plain_text', text: '🌅  Trámite personal — ½ día AM (hasta 13hs)' }, value: 'personal_am' },
              { text: { type: 'plain_text', text: '🌇  Trámite personal — ½ día PM (desde 15hs)' }, value: 'personal_pm' },
            ],
          },
          {
            label: { type: 'plain_text', text: '🏥  Médico' },
            options: [
              { text: { type: 'plain_text', text: '🏥  Turno médico — AM (hasta 13hs)' }, value: 'medical_am' },
              { text: { type: 'plain_text', text: '🏥  Turno médico — PM (desde 15hs)' }, value: 'medical_pm' },
            ],
          },
          {
            label: { type: 'plain_text', text: '📚  Estudio' },
            options: [
              { text: { type: 'plain_text', text: '📚  Día de examen' }, value: 'exam' },
            ],
          },
          {
            label: { type: 'plain_text', text: '💙  Otros' },
            options: [
              { text: { type: 'plain_text', text: '💙  Duelo familiar' }, value: 'bereavement' },
            ],
          },
        ],
      },
    },
    {
      type: 'input',
      block_id: 'blk_from',
      label: { type: 'plain_text', text: 'Fecha de inicio' },
      hint: { type: 'plain_text', text: 'Para medio día o un solo día, dejá las dos fechas iguales.' },
      element: {
        type: 'datepicker',
        action_id: 'sel_from',
        initial_date: t.today(),
        placeholder: { type: 'plain_text', text: 'Desde' },
      },
    },
    {
      type: 'input',
      block_id: 'blk_to',
      label: { type: 'plain_text', text: 'Fecha de fin' },
      element: {
        type: 'datepicker',
        action_id: 'sel_to',
        initial_date: t.today(),
        placeholder: { type: 'plain_text', text: 'Hasta' },
      },
    },
    {
      type: 'input',
      block_id: 'blk_notes',
      label: { type: 'plain_text', text: 'Notas (opcional)' },
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'sel_notes',
        multiline: true,
        max_length: 300,
        placeholder: { type: 'plain_text', text: 'Ej: viaje programado, turno con el Dr. García...' },
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '⚠️ *Pedir no es otorgar.* La empresa se reserva el derecho de definir las fechas según las necesidades operativas.',
      }],
    },
  ],
});

// ─── Block builders ────────────────────────────────────────────────

const buildAdminNotificationBlocks = (requestId, userName, ti, period, notes, validationWarning) => [
  {
    type: 'header',
    text: { type: 'plain_text', text: '📋 Nueva solicitud de ausencia' },
  },
  {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Persona:*\n${userName}` },
      { type: 'mrkdwn', text: `*Tipo:*\n${ti.emoji}  ${ti.label}` },
      { type: 'mrkdwn', text: `*Período:*\n${period}` },
      ...(notes ? [{ type: 'mrkdwn', text: `*Nota:*\n_${notes}_` }] : []),
    ],
  },
  ...(validationWarning ? [{
    type: 'section',
    text: { type: 'mrkdwn', text: `⚠️ *Advertencia:* ${validationWarning}` },
  }] : []),
  {
    type: 'actions',
    block_id: 'blk_actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅  Aprobar' },
        style: 'primary',
        action_id: 'leave_approve',
        value: String(requestId),
        confirm: {
          title: { type: 'plain_text', text: '¿Aprobás esta solicitud?' },
          text: { type: 'mrkdwn', text: 'Se crearán los días correspondientes en el sistema.' },
          confirm: { type: 'plain_text', text: 'Sí, aprobar' },
          deny: { type: 'plain_text', text: 'Cancelar' },
        },
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '❌  Rechazar' },
        style: 'danger',
        action_id: 'leave_reject',
        value: String(requestId),
      },
    ],
  },
  {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_Solicitud #${requestId} · ${dayjs().format('DD/MM/YYYY HH:mm')}_` }],
  },
];

const buildResolvedBlocks = (requestId, userName, ti, period, adminName, approved, reason) => [
  {
    type: 'header',
    text: { type: 'plain_text', text: approved ? '✅ Solicitud aprobada' : '❌ Solicitud rechazada' },
  },
  {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Persona:*\n${userName}` },
      { type: 'mrkdwn', text: `*Tipo:*\n${ti.emoji}  ${ti.label}` },
      { type: 'mrkdwn', text: `*Período:*\n${period}` },
      { type: 'mrkdwn', text: `*Revisado por:*\n${adminName}` },
      ...(reason ? [{ type: 'mrkdwn', text: `*Motivo:*\n_${reason}_` }] : []),
    ],
  },
  {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_Solicitud #${requestId} · ${dayjs().format('DD/MM/YYYY HH:mm')}_` }],
  },
];

const buildEmployeeConfirmBlocks = (requestId, ti, period, notes) => [
  {
    type: 'section',
    text: { type: 'mrkdwn', text: `✅ *Solicitud enviada — pendiente de aprobación*\nTe avisamos cuando haya una respuesta.` },
  },
  {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Tipo:*\n${ti.emoji}  ${ti.label}` },
      { type: 'mrkdwn', text: `*Período:*\n${period}` },
      ...(notes ? [{ type: 'mrkdwn', text: `*Nota:*\n_${notes}_` }] : []),
    ],
  },
  {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_⚠️ Recordá: pedir no es otorgar. No contés con el tiempo libre hasta recibir confirmación. · #${requestId}_` }],
  },
];

const buildEmployeeResolvedBlocks = (ti, period, adminName, approved, reason) => {
  if (approved) {
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `🎉 *Tu solicitud fue aprobada*` } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Tipo:*\n${ti.emoji}  ${ti.label}` },
          { type: 'mrkdwn', text: `*Período:*\n${period}` },
          { type: 'mrkdwn', text: `*Aprobado por:*\n${adminName}` },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Los días ya están registrados en el sistema._ ✓' }] },
    ];
  }
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `❌ *Tu solicitud no fue aprobada*` } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tipo:*\n${ti.emoji}  ${ti.label}` },
        { type: 'mrkdwn', text: `*Período:*\n${period}` },
        { type: 'mrkdwn', text: `*Revisado por:*\n${adminName}` },
        ...(reason ? [{ type: 'mrkdwn', text: `*Motivo:*\n_${reason}_` }] : []),
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '_Si tenés dudas, hablá con tu admin directamente._' }] },
  ];
};

// ─── Helpers ──────────────────────────────────────────────────────

const applyOverrides = (request, adminId) => {
  const ti = typeInfo(request.type);
  const reason = `${ti.label} — aprobado`;
  let d = dayjs(request.date_from);
  const end = dayjs(request.date_to);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    if (d.day() !== 0 && d.day() !== 6) {
      db.addOverride(request.slack_id, d.format('YYYY-MM-DD'), ti.override, reason, adminId);
    }
    d = d.add(1, 'day');
  }
};

const updateAdminMessages = async (client, requestId, requestBody, resolvedBlocks, resolvedText) => {
  const notifications = db.getLeaveAdminNotifications(requestId);
  const updatedTs = new Set();

  if (requestBody?.channel?.id && requestBody?.message?.ts) {
    try {
      await client.chat.update({
        channel: requestBody.channel.id,
        ts: requestBody.message.ts,
        text: resolvedText,
        blocks: resolvedBlocks,
      });
      updatedTs.add(requestBody.message.ts);
    } catch(e) { console.error('[leaves] Error updating clicked message:', e.message); }
  }

  for (const n of notifications) {
    if (updatedTs.has(n.message_ts)) continue;
    try {
      await client.chat.update({
        channel: n.channel_id,
        ts: n.message_ts,
        text: resolvedText,
        blocks: resolvedBlocks,
      });
      updatedTs.add(n.message_ts);
    } catch(e) { console.error('[leaves] Error updating stored notification:', e.message); }
  }
};

// ─── Quota summary text (shown in /mi-balance) ─────────────────────

const buildQuotaSummary = (slackId) => {
  const year = dayjs().year();
  const user = db.getUser(slackId);

  // Vacation blocks
  const summerUsed = db.countVacationBlocksThisYear(slackId, year, 'vacation_summer');
  const winterUsed = db.countVacationBlocksThisYear(slackId, year, 'vacation_winter');

  // Personal half-days
  const personalUsedHD = db.countPersonalHalfDaysInWindow(slackId, `${year}-01-01`, `${year}-12-31`);

  // Medical half-days
  const medicalUsedHD = db.countApprovedLeaveHalfDays(slackId, year, ['medical_am', 'medical_pm']);

  // Exam days (by semester)
  const sem1Used = db.countExamDaysInSemester(slackId, year, 1);
  const sem2Used = db.countExamDaysInSemester(slackId, year, 2);

  const line = (label, used, total, unit = '') =>
    `${used >= total ? '🔴' : used > 0 ? '🟡' : '🟢'} ${label}: *${used}/${total}* ${unit}`;

  const lines = [
    `📊 *Tu balance de ausencias — ${year}*\n`,
    line('Vacaciones verano', summerUsed, 1, 'bloque (14 días)'),
    line('Vacaciones invierno', winterUsed, 1, 'bloque (7 días)'),
    line('Trámites personales', personalUsedHD, 4, 'medios días (2 = 1 día completo)'),
    line('Turnos médicos', medicalUsedHD, 4, 'medios días'),
  ];

  if (user?.is_student) {
    lines.push(line(`Exámenes 1° sem`, sem1Used, 5, 'días'));
    lines.push(line(`Exámenes 2° sem`, sem2Used, 5, 'días'));
  }

  return lines.join('\n');
};

// ─── Setup ────────────────────────────────────────────────────────

const setupLeaves = (app) => {

  // ── /pedir — open modal ──────────────────────────────────────────
  app.command('/pedir', async ({ command, ack, client }) => {
    await ack();
    const { user_id, user_name } = command;
    db.upsertUser({ slack_id: user_id, name: user_name, real_name: user_name });
    try {
      await client.views.open({ trigger_id: command.trigger_id, view: buildRequestModal() });
    } catch(e) {
      console.error('[leaves] Error opening modal:', e.message);
    }
  });

  // ── View submission: modal_leave_request ─────────────────────────
  app.view('modal_leave_request', async ({ view, ack, body, client }) => {
    const vals    = view.state.values;
    const type    = vals.blk_type.sel_type.selected_option?.value;
    const dateFrom = vals.blk_from.sel_from.selected_date;
    const dateTo   = vals.blk_to.sel_to.selected_date;
    const notes    = vals.blk_notes?.sel_notes?.value || '';
    const userId   = body.user.id;

    if (!type || !dateFrom || !dateTo) {
      await ack({ response_action: 'errors', errors: { blk_type: 'Completá todos los campos.' } });
      return;
    }

    // ── Policy validation ─────────────────────────────────────────
    const { errors } = db.validateLeaveRequest(userId, type, dateFrom, dateTo, notes);

    if (errors.length > 0) {
      // Return errors in the modal — map to appropriate field
      const fieldErrors = {};
      // Try to associate to the most relevant field
      const dateError = errors.find(e =>
        e.includes('fecha') || e.includes('lunes') || e.includes('anticipación') ||
        e.includes('corridos') || e.includes('verano') || e.includes('invierno') ||
        e.includes('julio') || e.includes('septiembre') || e.includes('abril')
      );
      const typeError = errors.find(e =>
        e.includes('límite') || e.includes('bloque') || e.includes('semestre') ||
        e.includes('mes') || e.includes('año') || e.includes('examen') ||
        e.includes('universitarios') || e.includes('semana corta') || e.includes('mezclar')
      );

      if (dateError) fieldErrors.blk_from = dateError;
      if (typeError && typeError !== dateError) fieldErrors.blk_type = typeError;

      // If only one error, put it on from-date
      if (errors.length === 1) {
        fieldErrors.blk_from = errors[0];
        delete fieldErrors.blk_type;
      }

      // Slack allows max 1 error per block
      await ack({ response_action: 'errors', errors: fieldErrors });
      return;
    }

    await ack();

    const requestId  = db.createLeaveRequest(userId, type, dateFrom, dateTo, notes);
    const ti         = typeInfo(type);
    const period     = periodLabel(dateFrom, dateTo);
    const user       = db.getUser(userId);
    const displayName = user?.real_name || user?.name || body.user.name;

    // DM employee
    try {
      await client.chat.postMessage({
        channel: userId,
        text: `✅ Tu solicitud de ${ti.label} fue enviada. Esperando aprobación.`,
        blocks: buildEmployeeConfirmBlocks(requestId, ti, period, notes),
      });
    } catch(e) { console.error('[leaves] Error DM employee:', e.message); }

    // DM all admins
    const admins = db.getAdminUsers();
    for (const admin of admins) {
      if (admin.slack_id === userId) continue;
      try {
        const msg = await client.chat.postMessage({
          channel: admin.slack_id,
          text: `📋 Nueva solicitud de ausencia de ${displayName}`,
          blocks: buildAdminNotificationBlocks(requestId, displayName, ti, period, notes, null),
        });
        if (msg.ts) db.addLeaveAdminNotification(requestId, admin.slack_id, admin.slack_id, msg.ts);
      } catch(e) { console.error(`[leaves] Error notifying admin ${admin.slack_id}:`, e.message); }
    }

    console.log(`[leaves] Request #${requestId} created: ${displayName} → ${ti.label} (${period})`);
  });

  // ── Action: leave_approve ────────────────────────────────────────
  app.action('leave_approve', async ({ action, body, ack, client }) => {
    await ack();
    const requestId = parseInt(action.value, 10);
    const adminId   = body.user.id;

    const request = db.getLeaveRequest(requestId);
    if (!request || request.status !== 'pending') return;

    db.approveLeaveRequest(requestId, adminId);
    applyOverrides(request, adminId);

    const ti       = typeInfo(request.type);
    const period   = periodLabel(request.date_from, request.date_to);
    const admin    = db.getUser(adminId);
    const adminName = admin?.real_name || admin?.name || adminId;
    const userName  = request.real_name || request.name || request.slack_id;

    const resolvedBlocks = buildResolvedBlocks(requestId, userName, ti, period, adminName, true, null);
    await updateAdminMessages(client, requestId, body, resolvedBlocks, `✅ Solicitud aprobada — ${userName}`);

    try {
      await client.chat.postMessage({
        channel: request.slack_id,
        text: `🎉 Tu solicitud de ${ti.label} fue aprobada`,
        blocks: buildEmployeeResolvedBlocks(ti, period, adminName, true, null),
      });
    } catch(e) { console.error('[leaves] Error DM approve employee:', e.message); }

    console.log(`[leaves] Request #${requestId} approved by ${adminName}`);
  });

  // ── Action: leave_reject → open reason modal ─────────────────────
  app.action('leave_reject', async ({ action, body, ack, client }) => {
    await ack();
    const requestId = parseInt(action.value, 10);
    const request   = db.getLeaveRequest(requestId);
    if (!request || request.status !== 'pending') return;

    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'modal_leave_reject',
          private_metadata: JSON.stringify({
            requestId,
            channelId: body.channel?.id || body.user.id,
            messageTs: body.message?.ts || '',
          }),
          title: { type: 'plain_text', text: 'Rechazar solicitud' },
          submit: { type: 'plain_text', text: 'Confirmar rechazo' },
          close: { type: 'plain_text', text: 'Cancelar' },
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `¿Seguro que querés rechazar la solicitud *#${requestId}*?\n\nPodés agregar un motivo para que la persona sepa por qué.` },
            },
            {
              type: 'input',
              block_id: 'blk_reason',
              label: { type: 'plain_text', text: 'Motivo (opcional)' },
              optional: true,
              element: {
                type: 'plain_text_input',
                action_id: 'sel_reason',
                multiline: true,
                max_length: 300,
                placeholder: { type: 'plain_text', text: 'Ej: No hay cobertura suficiente esas fechas...' },
              },
            },
          ],
        },
      });
    } catch(e) { console.error('[leaves] Error opening reject modal:', e.message); }
  });

  // ── View submission: modal_leave_reject ──────────────────────────
  app.view('modal_leave_reject', async ({ view, ack, body, client }) => {
    await ack();
    const { requestId, channelId, messageTs } = JSON.parse(view.private_metadata);
    const adminId = body.user.id;
    const reason  = view.state.values.blk_reason?.sel_reason?.value || '';

    const request = db.getLeaveRequest(requestId);
    if (!request || request.status !== 'pending') return;

    db.rejectLeaveRequest(requestId, adminId, reason);

    const ti        = typeInfo(request.type);
    const period    = periodLabel(request.date_from, request.date_to);
    const admin     = db.getUser(adminId);
    const adminName  = admin?.real_name || admin?.name || adminId;
    const userName   = request.real_name || request.name || request.slack_id;

    const fakeBody   = { channel: { id: channelId }, message: { ts: messageTs } };
    const resolvedBlocks = buildResolvedBlocks(requestId, userName, ti, period, adminName, false, reason);
    await updateAdminMessages(client, requestId, fakeBody, resolvedBlocks, `❌ Solicitud rechazada — ${userName}`);

    try {
      await client.chat.postMessage({
        channel: request.slack_id,
        text: `❌ Tu solicitud de ${ti.label} no fue aprobada`,
        blocks: buildEmployeeResolvedBlocks(ti, period, adminName, false, reason),
      });
    } catch(e) { console.error('[leaves] Error DM reject employee:', e.message); }

    console.log(`[leaves] Request #${requestId} rejected by ${adminName}`);
  });

  console.log('[leaves] /pedir y /mi-balance configurados');
};

module.exports = { setupLeaves, LEAVE_TYPES, buildQuotaSummary };
