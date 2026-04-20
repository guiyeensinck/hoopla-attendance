const t = require('./time');
const dayjs = t.dayjs;
const db = require('./database');

// ─── Leave type definitions ────────────────────────────────────────
const LEAVE_TYPES = {
  vacation:    { label: 'Vacaciones',           emoji: '🏖️', override: 'vacation',   multi: true  },
  day_off:     { label: 'Día libre',            emoji: '📅', override: 'day_off',    multi: false },
  exam:        { label: 'Día de exámenes',      emoji: '📚', override: 'day_off',    multi: false },
  half_am:     { label: 'Medio día — mañana',   emoji: '🌅', override: 'day_off',    multi: false },
  half_pm:     { label: 'Medio día — tarde',    emoji: '🌇', override: 'early_exit', multi: false },
  medical:     { label: 'Turno médico',         emoji: '🏥', override: 'medical',    multi: false },
  personal:    { label: 'Asunto personal',      emoji: '🙏', override: 'day_off',    multi: false },
  bereavement: { label: 'Duelo familiar',       emoji: '💙', override: 'absent',     multi: true  },
};

const typeInfo = (type) => LEAVE_TYPES[type] || { label: type, emoji: '📋', override: 'day_off', multi: false };

const periodLabel = (dateFrom, dateTo) =>
  dateFrom === dateTo
    ? dayjs(dateFrom).format('DD/MM/YYYY')
    : `${dayjs(dateFrom).format('DD/MM')} al ${dayjs(dateTo).format('DD/MM/YYYY')}`;

// ─── Block builders ────────────────────────────────────────────────

const buildRequestModal = () => ({
  type: 'modal',
  callback_id: 'modal_leave_request',
  title: { type: 'plain_text', text: 'Pedir ausencia' },
  submit: { type: 'plain_text', text: 'Enviar solicitud' },
  close: { type: 'plain_text', text: 'Cancelar' },
  blocks: [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '📋 Completá el formulario.\n\n⚠️ *Pedir no es otorgar* — tu solicitud será revisada. Te avisamos cuando haya una respuesta.' },
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
        options: Object.entries(LEAVE_TYPES).map(([value, { label, emoji }]) => ({
          text: { type: 'plain_text', text: `${emoji}  ${label}` },
          value,
        })),
      },
    },
    {
      type: 'input',
      block_id: 'blk_from',
      label: { type: 'plain_text', text: 'Fecha' },
      hint: { type: 'plain_text', text: 'Para un solo día, dejá las dos fechas iguales.' },
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
      label: { type: 'plain_text', text: 'Fecha hasta' },
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
        placeholder: { type: 'plain_text', text: 'Ej: viaje programado, turno con el Dr. García, etc.' },
      },
    },
  ],
});

const buildAdminNotificationBlocks = (requestId, userName, ti, period, notes) => [
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
          text: { type: 'mrkdwn', text: `Se crearán los días correspondientes en el sistema.` },
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
    elements: [{ type: 'mrkdwn', text: `_⚠️ Recordá que pedir no es otorgar. No contés con el tiempo libre hasta recibir confirmación. · #${requestId}_` }],
  },
];

const buildEmployeeResolvedBlocks = (ti, period, adminName, approved, reason) => {
  if (approved) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🎉 *Tu solicitud fue aprobada*` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Tipo:*\n${ti.emoji}  ${ti.label}` },
          { type: 'mrkdwn', text: `*Período:*\n${period}` },
          { type: 'mrkdwn', text: `*Aprobado por:*\n${adminName}` },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_Los días ya están registrados en el sistema._ ✓` }],
      },
    ];
  }
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `❌ *Tu solicitud no fue aprobada*` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tipo:*\n${ti.emoji}  ${ti.label}` },
        { type: 'mrkdwn', text: `*Período:*\n${period}` },
        { type: 'mrkdwn', text: `*Revisado por:*\n${adminName}` },
        ...(reason ? [{ type: 'mrkdwn', text: `*Motivo:*\n_${reason}_` }] : []),
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Si tenés dudas, hablá con tu admin directamente._` }],
    },
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

// Update all stored admin notification messages to reflect the resolved state
const updateAdminMessages = async (client, requestId, requestBody, resolvedBlocks, resolvedText) => {
  const notifications = db.getLeaveAdminNotifications(requestId);
  const updatedTs = new Set();

  // Always update the message the admin clicked on
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

  // Update all other stored notifications
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
    const vals = view.state.values;
    const type     = vals.blk_type.sel_type.selected_option?.value;
    const dateFrom = vals.blk_from.sel_from.selected_date;
    const dateTo   = vals.blk_to.sel_to.selected_date;
    const notes    = vals.blk_notes?.sel_notes?.value || '';
    const userId   = body.user.id;

    // Validate date range
    if (dayjs(dateTo).isBefore(dayjs(dateFrom))) {
      await ack({
        response_action: 'errors',
        errors: { blk_to: 'La fecha de fin no puede ser anterior a la de inicio.' },
      });
      return;
    }
    await ack();

    const requestId = db.createLeaveRequest(userId, type, dateFrom, dateTo, notes);
    const ti = typeInfo(type);
    const period = periodLabel(dateFrom, dateTo);
    const user = db.getUser(userId);
    const displayName = user?.real_name || user?.name || body.user.name;

    // DM employee: confirmation
    try {
      await client.chat.postMessage({
        channel: userId,
        text: `✅ Tu solicitud de ${ti.label} fue enviada. Esperando aprobación.`,
        blocks: buildEmployeeConfirmBlocks(requestId, ti, period, notes),
      });
    } catch(e) { console.error('[leaves] Error DM employee:', e.message); }

    // DM all admins: notification with approve/reject buttons
    const admins = db.getAdminUsers();
    for (const admin of admins) {
      if (admin.slack_id === userId) continue;
      try {
        const msg = await client.chat.postMessage({
          channel: admin.slack_id,
          text: `📋 Nueva solicitud de ausencia de ${displayName}`,
          blocks: buildAdminNotificationBlocks(requestId, displayName, ti, period, notes),
        });
        if (msg.ts) {
          db.addLeaveAdminNotification(requestId, admin.slack_id, admin.slack_id, msg.ts);
        }
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
    if (!request || request.status !== 'pending') return; // Already handled

    // Approve in DB + create day_overrides
    db.approveLeaveRequest(requestId, adminId);
    applyOverrides(request, adminId);

    const ti = typeInfo(request.type);
    const period = periodLabel(request.date_from, request.date_to);
    const admin = db.getUser(adminId);
    const adminName = admin?.real_name || admin?.name || adminId;
    const userName = request.real_name || request.name || request.slack_id;

    const resolvedBlocks = buildResolvedBlocks(requestId, userName, ti, period, adminName, true, null);
    await updateAdminMessages(client, requestId, body, resolvedBlocks, `✅ Solicitud aprobada — ${userName}`);

    // DM employee
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

    const request = db.getLeaveRequest(requestId);
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

    const ti = typeInfo(request.type);
    const period = periodLabel(request.date_from, request.date_to);
    const admin = db.getUser(adminId);
    const adminName = admin?.real_name || admin?.name || adminId;
    const userName = request.real_name || request.name || request.slack_id;

    // Build a fake body so updateAdminMessages can update the original message
    const fakeBody = { channel: { id: channelId }, message: { ts: messageTs } };
    const resolvedBlocks = buildResolvedBlocks(requestId, userName, ti, period, adminName, false, reason);
    await updateAdminMessages(client, requestId, fakeBody, resolvedBlocks, `❌ Solicitud rechazada — ${userName}`);

    // DM employee
    try {
      await client.chat.postMessage({
        channel: request.slack_id,
        text: `❌ Tu solicitud de ${ti.label} no fue aprobada`,
        blocks: buildEmployeeResolvedBlocks(ti, period, adminName, false, reason),
      });
    } catch(e) { console.error('[leaves] Error DM reject employee:', e.message); }

    console.log(`[leaves] Request #${requestId} rejected by ${adminName}`);
  });

  console.log('[leaves] /pedir configurado');
};

module.exports = { setupLeaves, LEAVE_TYPES };
