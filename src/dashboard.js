const express = require('express');
const t = require('./time');
const dayjs = t.dayjs;
const db = require('./database');
const verify = require('./verification');

const setupDashboard = (boltApp) => {
  const router = express.Router();

  // ─── Dashboard home ──────────────────────────────────────────────
  router.get('/', (req, res) => {
    const today = t.today();
    const weekStart = t.weekStart();
    const weekEnd = t.weekEnd();
    const todayRecords = db.getRecordsByDateRange(today, today);
    const missing = db.getMissingToday(today);
    const weeklySummary = db.getWeeklySummary(weekStart, weekEnd);
    const users = db.getAllUsers();
    const tracked = db.getTrackedUsers();
    res.send(renderDashboard({ todayRecords, missing, weeklySummary, users, tracked, today }));
  });

  // ─── Records ─────────────────────────────────────────────────────
  router.get('/records', (req, res) => {
    const { from, to, user } = req.query;
    const startDate = from || t.monthStart();
    const endDate = to || t.today();
    const records = user ? db.getUserRecordsByDateRange(user, startDate, endDate) : db.getRecordsByDateRange(startDate, endDate);
    const users = db.getAllUsers();
    res.send(renderRecords({ records, users, startDate, endDate, selectedUser: user }));
  });

  // ─── Activity ────────────────────────────────────────────────────
  router.get('/activity', (req, res) => {
    const { from, to } = req.query;
    const startDate = from || t.weekStart();
    const endDate = to || t.today();
    const pingSummary = db.getPingSummary(startDate, endDate);
    const tracked = db.getTrackedUsers();
    const presenceData = tracked
      .map(u => ({ ...db.getPresenceSummary(u.slack_id, startDate, endDate), name: u.name, real_name: u.real_name, slack_id: u.slack_id }))
      .filter(p => p.total_checks > 0);
    res.send(renderActivity({ pingSummary, presenceData, startDate, endDate }));
  });

  // ─── Users ───────────────────────────────────────────────────────
  router.get('/users', (req, res) => {
    const users = db.getAllUsers();
    const tracked = db.getTrackedUsers();
    const admins = db.getAdminUsers();
    res.send(renderUsers({ users, tracked, admins }));
  });

  // PIN is now per-user, no global API needed

  // ─── JSON APIs ───────────────────────────────────────────────────
  router.get('/api/records', (req, res) => {
    const { from, to, user } = req.query;
    const startDate = from || t.monthStart();
    const endDate = to || t.today();
    const records = user ? db.getUserRecordsByDateRange(user, startDate, endDate) : db.getRecordsByDateRange(startDate, endDate);
    res.json({ records, startDate, endDate });
  });

  router.get('/api/summary', (req, res) => {
    const { from, to } = req.query;
    const startDate = from || t.weekStart();
    const endDate = to || t.today();
    res.json({ summary: db.getWeeklySummary(startDate, endDate), startDate, endDate });
  });

  boltApp.receiver.app.use('/dashboard', router);

  // ═══════════════════════════════════════════════════════════════════
  // VERIFICATION ROUTES (mounted at root, not under /dashboard)
  // ═══════════════════════════════════════════════════════════════════

  const verifyRouter = express.Router();
  verifyRouter.use(express.urlencoded({ extended: true }));

  // GET /verify/:token — Check desktop, show PIN form
  verifyRouter.get('/:token', (req, res) => {
    const { token } = req.params;
    const ua = req.headers['user-agent'] || '';

    if (verify.isMobileUA(ua)) {
      res.send(renderVerifyError('Dispositivo no permitido', 'Este registro solo funciona desde un navegador de escritorio. Abrí el link desde tu computadora.'));
      return;
    }

    const peek = verify.peekToken(token);
    if (!peek) {
      res.send(renderVerifyError('Link expirado', 'Este link ya fue usado o expiró. Generá uno nuevo con /marcar en Slack.'));
      return;
    }
    const slackId = peek.slackId;

    const today = t.today();
    const user = db.getUser(slackId);
    const record = db.getOrCreateRecord(slackId, today);
    const nextAction = getNextAction(record);

    if (!nextAction) {
      res.send(renderVerifySuccess({ user, record, action_type: null, time: null, alreadyComplete: true }));
      return;
    }

    res.send(renderVerifyForm({ token, user, record, today, nextAction }));
  });

  // POST /verify/:token — Verify PIN + register with server time
  verifyRouter.post('/:token', (req, res) => {
    const { token } = req.params;
    const { pin } = req.body;
    const ua = req.headers['user-agent'] || '';

    if (verify.isMobileUA(ua)) {
      res.send(renderVerifyError('Dispositivo no permitido', 'Este registro solo funciona desde un navegador de escritorio.'));
      return;
    }

    // consumeToken verifies PIN + token in one step
    const slackId = verify.consumeToken(token, pin);
    if (!slackId) {
      res.send(renderVerifyError('Link o PIN incorrecto', 'El link expiró, ya fue usado, o el PIN no coincide. Generá uno nuevo con /marcar en Slack.'));
      return;
    }

    const today = t.today();
    const time = t.currentTime();
    const record = db.getOrCreateRecord(slackId, today);
    const nextAction = getNextAction(record);

    if (!nextAction) {
      const user = db.getUser(slackId);
      res.send(renderVerifySuccess({ user, record, action_type: null, time, alreadyComplete: true }));
      return;
    }

    try {
      const updated = db.updateField(slackId, today, nextAction, time);
      const user = db.getUser(slackId);
      res.send(renderVerifySuccess({ user, record: updated, action_type: nextAction, time, alreadyComplete: false }));
    } catch (err) {
      res.send(renderVerifyError('Error', err.message));
    }
  });

  boltApp.receiver.app.use('/verify', verifyRouter);

  console.log('[dashboard] Available at /dashboard');
  console.log('[verify] Verification routes at /verify/:token');
};

// ═══════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════

const STYLES = `
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --surface-2: #232736;
    --border: #2d3145; --text: #e2e4ea; --text-muted: #8b8fa3;
    --accent: #6c5ce7; --accent-light: #a29bfe;
    --green: #00b894; --yellow: #fdcb6e; --red: #ff6b6b; --orange: #e17055;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'JetBrains Mono', monospace; background: var(--bg); color: var(--text); line-height: 1.6; }
  .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; gap: 1rem; }
  header h1 { font-size: 1.5rem; font-weight: 600; color: var(--accent-light); letter-spacing: -0.02em; }
  header nav a { color: var(--text-muted); text-decoration: none; margin-left: 1.5rem; font-size: 0.85rem; transition: color 0.2s; }
  header nav a:hover, header nav a.active { color: var(--accent-light); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; }
  .card h3 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin-bottom: 0.5rem; }
  .card .value { font-size: 2rem; font-weight: 700; }
  .card .value.green { color: var(--green); } .card .value.yellow { color: var(--yellow); } .card .value.red { color: var(--red); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; padding: 0.75rem 1rem; color: var(--text-muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid var(--border); font-weight: 500; }
  td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
  tr:hover { background: var(--surface-2); }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 500; }
  .badge.complete { background: rgba(0,184,148,0.15); color: var(--green); }
  .badge.partial { background: rgba(253,203,110,0.15); color: var(--yellow); }
  .badge.missing { background: rgba(255,107,107,0.15); color: var(--red); }
  .badge.admin { background: rgba(108,92,231,0.15); color: var(--accent-light); }
  .badge.tracked { background: rgba(0,184,148,0.15); color: var(--green); }
  .filters { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; align-items: end; }
  .filters label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); display: block; margin-bottom: 0.25rem; }
  .filters input, .filters select { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 0.5rem 0.75rem; border-radius: 4px; font-family: inherit; font-size: 0.85rem; }
  .filters button { background: var(--accent); color: white; border: none; padding: 0.5rem 1.25rem; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 0.85rem; }
  .filters button:hover { opacity: 0.85; }
  .empty { color: var(--text-muted); text-align: center; padding: 3rem; }
  .progress { background: var(--surface-2); border-radius: 4px; height: 8px; overflow: hidden; margin-top: 0.25rem; }
  .progress-bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .progress-bar.green { background: var(--green); } .progress-bar.yellow { background: var(--yellow); } .progress-bar.red { background: var(--red); }

  /* PIN display */
  .pin-box { background: var(--surface); border: 2px solid var(--accent); border-radius: 12px; padding: 1.5rem; text-align: center; }
  .pin-code { font-size: 3rem; font-weight: 700; color: var(--accent-light); letter-spacing: 0.5em; margin: 0.5rem 0; }
  .pin-ttl { font-size: 0.8rem; color: var(--text-muted); }

  /* Verify page */
  .verify-container { max-width: 480px; margin: 4rem auto; padding: 2rem; }
  .verify-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; }
  .verify-card h2 { font-size: 1.2rem; color: var(--accent-light); margin-bottom: 1.5rem; text-align: center; }
  .form-group { margin-bottom: 1.25rem; }
  .form-group label { display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 0.4rem; }
  .form-group select, .form-group input { width: 100%; background: var(--surface-2); border: 1px solid var(--border); color: var(--text); padding: 0.6rem 0.75rem; border-radius: 6px; font-family: inherit; font-size: 0.9rem; }
  .form-group input.pin-input { font-size: 1.8rem; text-align: center; letter-spacing: 0.5em; font-weight: 700; padding: 0.75rem; }
  .btn-primary { width: 100%; background: var(--accent); color: white; border: none; padding: 0.75rem; border-radius: 6px; font-family: inherit; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 0.5rem; }
  .btn-primary:hover { opacity: 0.9; }
  .btn-secondary { width: 100%; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); padding: 0.75rem; border-radius: 6px; font-family: inherit; font-size: 0.9rem; cursor: pointer; margin-top: 0.5rem; }
  .btn-secondary:hover { background: var(--border); }
  .status-row { display: flex; justify-content: space-between; padding: 0.4rem 0; font-size: 0.85rem; border-bottom: 1px solid var(--border); }
  .status-row:last-child { border-bottom: none; }
  .error-box { background: rgba(255,107,107,0.1); border: 1px solid var(--red); border-radius: 8px; padding: 2rem; text-align: center; }
  .error-box h2 { color: var(--red); margin-bottom: 0.5rem; }
  .success-box { background: rgba(0,184,148,0.1); border: 1px solid var(--green); border-radius: 8px; padding: 2rem; text-align: center; }
  .success-box h2 { color: var(--green); margin-bottom: 0.5rem; }
  .or-divider { text-align: center; color: var(--text-muted); font-size: 0.8rem; margin: 0.75rem 0; }
</style>
`;

const layout = (title, nav, body) => `
<!DOCTYPE html><html lang="es"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Hoopla Asistencia</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${STYLES}
</head><body><div class="container">
  <header>
    <h1>⚡ hoopla::asistencia</h1>
    <nav>
      <a href="/dashboard" class="${nav === 'home' ? 'active' : ''}">Dashboard</a>
      <a href="/dashboard/records" class="${nav === 'records' ? 'active' : ''}">Registros</a>
      <a href="/dashboard/activity" class="${nav === 'activity' ? 'active' : ''}">Actividad</a>
      <a href="/dashboard/users" class="${nav === 'users' ? 'active' : ''}">Usuarios</a>
    </nav>
  </header>
  ${body}
</div></body></html>`;

const miniLayout = (title, body) => `
<!DOCTYPE html><html lang="es"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Hoopla Asistencia</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${STYLES}
</head><body><div class="verify-container">${body}</div></body></html>`;

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD HOME (with PIN)
// ═══════════════════════════════════════════════════════════════════

const renderDashboard = ({ todayRecords, missing, weeklySummary, users, tracked, today }) => {
  const presentCount = todayRecords.length;
  const completeCount = todayRecords.filter(r => r.exit_time).length;
  const weeklyHours = weeklySummary.reduce((sum, r) => sum + (r.total_hours || 0), 0);

  const todayRows = todayRecords.map(r => `
    <tr>
      <td>${r.real_name || r.name}</td><td>${r.entry_time || '—'}</td>
      <td>${r.lunch_start || '—'} – ${r.lunch_end || '—'}</td>
      <td>${r.exit_time || '—'}</td><td>${r.total_hours ? r.total_hours + 'hs' : '—'}</td>
      <td><span class="badge ${r.exit_time ? 'complete' : 'partial'}">${r.exit_time ? 'Completo' : 'En curso'}</span></td>
    </tr>`).join('');

  const missingRows = missing.map(u => `
    <tr><td>${u.real_name || u.name}</td><td><span class="badge missing">Sin registro</span></td></tr>`).join('');

  return layout('Dashboard', 'home', `
    <div class="grid">
      <div class="card"><h3>Trackeados</h3><div class="value">${tracked.length}</div></div>
      <div class="card"><h3>Presentes hoy</h3><div class="value green">${presentCount}</div></div>
      <div class="card"><h3>Jornada completa</h3><div class="value ${completeCount === presentCount ? 'green' : 'yellow'}">${completeCount}</div></div>
      <div class="card"><h3>Sin registro</h3><div class="value ${missing.length > 0 ? 'red' : 'green'}">${missing.length}</div></div>
      <div class="card"><h3>Horas equipo (semana)</h3><div class="value">${Math.round(weeklyHours * 10) / 10}</div></div>
    </div>

    <div class="card" style="margin-bottom:1.5rem">
      <h3>Hoy — ${dayjs(today).format('DD/MM/YYYY')}</h3>
      ${todayRecords.length > 0 ? `
        <table><thead><tr><th>Persona</th><th>Entrada</th><th>Almuerzo</th><th>Salida</th><th>Horas</th><th>Estado</th></tr></thead>
        <tbody>${todayRows}</tbody></table>
      ` : '<p class="empty">No hay registros para hoy</p>'}
    </div>

    ${missing.length > 0 ? `<div class="card"><h3>⚠️ Faltantes</h3>
      <table><thead><tr><th>Persona</th><th>Estado</th></tr></thead><tbody>${missingRows}</tbody></table>
    </div>` : ''}
  `);
};

// ═══════════════════════════════════════════════════════════════════
// RECORDS PAGE
// ═══════════════════════════════════════════════════════════════════

const renderRecords = ({ records, users, startDate, endDate, selectedUser }) => {
  const userOpts = users.map(u =>
    `<option value="${u.slack_id}" ${selectedUser === u.slack_id ? 'selected' : ''}>${u.real_name || u.name}</option>`
  ).join('');
  const rows = records.map(r => {
    const st = r.exit_time ? 'complete' : (r.entry_time ? 'partial' : 'missing');
    const lb = r.exit_time ? 'Completo' : (r.entry_time ? 'Parcial' : 'Sin datos');
    return `<tr><td>${dayjs(r.date).format('DD/MM/YYYY')}</td><td>${r.real_name || r.name}</td>
      <td>${r.entry_time || '—'}</td><td>${r.lunch_start || '—'}</td><td>${r.lunch_end || '—'}</td>
      <td>${r.exit_time || '—'}</td><td>${r.total_hours ? r.total_hours + 'hs' : '—'}</td>
      <td><span class="badge ${st}">${lb}</span></td></tr>`;
  }).join('');
  return layout('Registros', 'records', `
    <form class="filters" method="GET" action="/dashboard/records">
      <div><label>Desde</label><input type="date" name="from" value="${startDate}"></div>
      <div><label>Hasta</label><input type="date" name="to" value="${endDate}"></div>
      <div><label>Persona</label><select name="user"><option value="">Todas</option>${userOpts}</select></div>
      <button type="submit">Filtrar</button>
    </form>
    <div class="card">${records.length > 0 ? `<table><thead><tr>
      <th>Fecha</th><th>Persona</th><th>Entrada</th><th>Almuerzo ini</th><th>Almuerzo fin</th><th>Salida</th><th>Horas</th><th>Estado</th>
    </tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No hay registros</p>'}</div>`);
};

// ═══════════════════════════════════════════════════════════════════
// ACTIVITY PAGE
// ═══════════════════════════════════════════════════════════════════

const renderActivity = ({ pingSummary, presenceData, startDate, endDate }) => {
  const pingRows = pingSummary.map(r => {
    const rate = r.total_pings > 0 ? Math.round((r.responded / r.total_pings) * 100) : 0;
    const avg = r.avg_response_ms ? Math.round(r.avg_response_ms / 1000) : '—';
    const c = rate >= 70 ? 'green' : rate >= 50 ? 'yellow' : 'red';
    return `<tr><td>${r.real_name || r.name}</td><td>${r.total_pings}</td><td>${r.responded}</td><td>${r.missed}</td>
      <td>${rate}% <div class="progress"><div class="progress-bar ${c}" style="width:${rate}%"></div></div></td><td>${avg}s</td></tr>`;
  }).join('');
  const presRows = presenceData.map(r => {
    const p = r.active_pct || 0; const c = p >= 70 ? 'green' : p >= 50 ? 'yellow' : 'red';
    return `<tr><td>${r.real_name || r.name}</td><td>${r.total_checks}</td><td>${r.active_count}</td><td>${r.away_count}</td>
      <td>${p}% <div class="progress"><div class="progress-bar ${c}" style="width:${p}%"></div></div></td></tr>`;
  }).join('');
  return layout('Actividad', 'activity', `
    <form class="filters" method="GET" action="/dashboard/activity">
      <div><label>Desde</label><input type="date" name="from" value="${startDate}"></div>
      <div><label>Hasta</label><input type="date" name="to" value="${endDate}"></div>
      <button type="submit">Filtrar</button>
    </form>
    <div class="card" style="margin-bottom:1.5rem"><h3>🏓 Pings de actividad</h3>
      ${pingSummary.length > 0 ? `<table><thead><tr><th>Persona</th><th>Enviados</th><th>OK</th><th>Perdidos</th><th>Tasa</th><th>Promedio</th></tr></thead><tbody>${pingRows}</tbody></table>` : '<p class="empty">Sin datos</p>'}
    </div>
    <div class="card"><h3>👁️ Presencia Slack</h3>
      ${presenceData.length > 0 ? `<table><thead><tr><th>Persona</th><th>Checks</th><th>Active</th><th>Away</th><th>Presencia</th></tr></thead><tbody>${presRows}</tbody></table>` : '<p class="empty">Sin datos</p>'}
    </div>`);
};

// ═══════════════════════════════════════════════════════════════════
// USERS PAGE
// ═══════════════════════════════════════════════════════════════════

const renderUsers = ({ users, tracked, admins }) => {
  const tIds = new Set(tracked.map(u => u.slack_id));
  const aIds = new Set(admins.map(u => u.slack_id));
  const rows = users.map(u => {
    const b = [];
    if (aIds.has(u.slack_id)) b.push('<span class="badge admin">Admin</span>');
    if (tIds.has(u.slack_id)) b.push('<span class="badge tracked">Trackeado</span>');
    return `<tr><td>${u.real_name || u.name}</td><td style="font-size:0.75rem;color:var(--text-muted)">${u.slack_id}</td>
      <td>${b.join(' ') || '—'}</td><td style="font-size:0.75rem;color:var(--text-muted)">${u.created_at || '—'}</td></tr>`;
  }).join('');
  return layout('Usuarios', 'users', `
    <div class="grid">
      <div class="card"><h3>Total</h3><div class="value">${users.length}</div></div>
      <div class="card"><h3>Trackeados</h3><div class="value green">${tracked.length}</div></div>
      <div class="card"><h3>Admins</h3><div class="value" style="color:var(--accent-light)">${admins.length}</div></div>
    </div>
    <div class="card"><h3>Todos los usuarios</h3>
      <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:1rem">Gestión: <code>/admin agregar @usuario</code> · <code>/admin sacar @usuario</code></p>
      ${users.length > 0 ? `<table><thead><tr><th>Nombre</th><th>Slack ID</th><th>Rol</th><th>Desde</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">Sin usuarios</p>'}
    </div>`);
};

// ═══════════════════════════════════════════════════════════════════
// VERIFICATION PAGES
// ═══════════════════════════════════════════════════════════════════

const STATUS_LABELS = {
  entry_time: '🟢 Entrada',
  lunch_start: '🍽️ Inicio almuerzo',
  lunch_end: '🔄 Fin almuerzo',
  exit_time: '🔴 Salida',
};

const getNextAction = (record) => {
  if (!record || !record.entry_time) return 'entry_time';
  if (!record.lunch_start) return 'lunch_start';
  if (!record.lunch_end) return 'lunch_end';
  if (!record.exit_time) return 'exit_time';
  return null;
};

const renderVerifyForm = ({ token, user, record, today, nextAction }) => {
  const name = user?.real_name || user?.name || 'Usuario';
  const nextLabel = STATUS_LABELS[nextAction];

  const statusRows = Object.entries(STATUS_LABELS).map(([field, label]) =>
    `<div class="status-row"><span>${label}</span><span>${record[field] || '—'}</span></div>`
  ).join('');

  return miniLayout('Registrar asistencia', `
    <div class="verify-card">
      <h2>📋 ${name}</h2>
      <p style="text-align:center;color:var(--text-muted);font-size:0.85rem;margin-bottom:1.25rem">${dayjs(today).format('DD/MM/YYYY')}</p>

      <div style="margin-bottom:1.25rem">${statusRows}</div>

      <div style="text-align:center;margin-bottom:1.25rem;padding:0.75rem;background:var(--surface-2);border-radius:6px;">
        <span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;">Registrando</span><br>
        <span style="font-size:1.2rem;font-weight:600;">${nextLabel}</span>
      </div>

      <form method="POST" action="/verify/${token}">
        <div class="form-group">
          <label>Ingresá el PIN que te apareció en Slack</label>
          <input type="text" name="pin" class="pin-input" maxlength="4" pattern="[0-9]{4}" placeholder="0000" required autocomplete="off" inputmode="numeric">
        </div>

        <button type="submit" class="btn-primary">✅ Registrar ${nextLabel}</button>
      </form>
    </div>`);
};

const renderVerifyError = (title, message) => miniLayout('Error', `
  <div class="error-box">
    <h2>❌ ${title}</h2>
    <p style="margin-top:0.75rem">${message}</p>
  </div>`);

const renderVerifySuccess = ({ user, record, action_type, time, alreadyComplete }) => {
  const name = user?.real_name || user?.name || 'Usuario';

  if (alreadyComplete) {
    const statusRows = Object.entries(STATUS_LABELS).map(([field, lb]) =>
      `<div class="status-row"><span>${lb}</span><span>${record[field] || '—'}</span></div>`
    ).join('');
    return miniLayout('Día completo', `
      <div class="success-box">
        <h2>✅ Día completo</h2>
        <p>${name}, ya tenés todas las marcaciones registradas para hoy.</p>
      </div>
      <div class="verify-card" style="margin-top:1rem">${statusRows}</div>`);
  }

  const label = STATUS_LABELS[action_type] || action_type;
  const statusRows = Object.entries(STATUS_LABELS).map(([field, lb]) =>
    `<div class="status-row"><span>${lb}</span><span style="${field === action_type ? 'color:var(--green);font-weight:700' : ''}">${record[field] || '—'}</span></div>`
  ).join('');

  return miniLayout('Registrado', `
    <div class="success-box">
      <h2>✅ Registrado</h2>
      <p style="margin-top:0.5rem"><strong>${label}</strong> a las <strong>${time}</strong></p>
      <p style="color:var(--text-muted);font-size:0.85rem;margin-top:0.25rem">${name} — ${t.now().format('DD/MM/YYYY')}</p>
    </div>
    <div class="verify-card" style="margin-top:1rem">${statusRows}</div>`);
};

module.exports = { setupDashboard };
