const express = require('express');
const dayjs = require('dayjs');
const db = require('./database');

const setupDashboard = (boltApp) => {
  const router = express.Router();

  // ─── Dashboard home ──────────────────────────────────────────────
  router.get('/', (req, res) => {
    const today = dayjs().format('YYYY-MM-DD');
    const weekStart = dayjs().startOf('week').format('YYYY-MM-DD');
    const weekEnd = dayjs().endOf('week').format('YYYY-MM-DD');

    const todayRecords = db.getRecordsByDateRange(today, today);
    const missing = db.getMissingToday(today);
    const weeklySummary = db.getWeeklySummary(weekStart, weekEnd);
    const users = db.getAllUsers.all();
    const tracked = db.getTrackedUsers.all();

    res.send(renderDashboard({ todayRecords, missing, weeklySummary, users, tracked, today }));
  });

  // ─── Records ─────────────────────────────────────────────────────
  router.get('/records', (req, res) => {
    const { from, to, user } = req.query;
    const startDate = from || dayjs().startOf('month').format('YYYY-MM-DD');
    const endDate = to || dayjs().format('YYYY-MM-DD');

    const records = user
      ? db.getUserRecordsByDateRange(user, startDate, endDate)
      : db.getRecordsByDateRange(startDate, endDate);

    const users = db.getAllUsers.all();
    res.send(renderRecords({ records, users, startDate, endDate, selectedUser: user }));
  });

  // ─── Activity page ───────────────────────────────────────────────
  router.get('/activity', (req, res) => {
    const { from, to } = req.query;
    const startDate = from || dayjs().startOf('week').format('YYYY-MM-DD');
    const endDate = to || dayjs().format('YYYY-MM-DD');

    const pingSummary = db.getPingSummary(startDate, endDate);
    const pings = db.getPingsByDateRange(startDate, endDate);
    const tracked = db.getTrackedUsers.all();

    const presenceData = tracked.map(u => {
      const ps = db.getPresenceSummary(u.slack_id, startDate, endDate);
      return { ...ps, name: u.name, real_name: u.real_name, slack_id: u.slack_id };
    }).filter(p => p.total_checks > 0);

    res.send(renderActivity({ pingSummary, pings, presenceData, startDate, endDate }));
  });

  // ─── Users management page ───────────────────────────────────────
  router.get('/users', (req, res) => {
    const users = db.getAllUsers.all();
    const tracked = db.getTrackedUsers.all();
    const admins = db.getAdminUsers.all();
    res.send(renderUsers({ users, tracked, admins }));
  });

  // ─── APIs ────────────────────────────────────────────────────────
  router.get('/api/records', (req, res) => {
    const { from, to, user } = req.query;
    const startDate = from || dayjs().startOf('month').format('YYYY-MM-DD');
    const endDate = to || dayjs().format('YYYY-MM-DD');
    const records = user
      ? db.getUserRecordsByDateRange(user, startDate, endDate)
      : db.getRecordsByDateRange(startDate, endDate);
    res.json({ records, startDate, endDate });
  });

  router.get('/api/summary', (req, res) => {
    const { from, to } = req.query;
    const startDate = from || dayjs().startOf('week').format('YYYY-MM-DD');
    const endDate = to || dayjs().format('YYYY-MM-DD');
    res.json({ summary: db.getWeeklySummary(startDate, endDate), startDate, endDate });
  });

  router.get('/api/activity', (req, res) => {
    const { from, to } = req.query;
    const startDate = from || dayjs().startOf('week').format('YYYY-MM-DD');
    const endDate = to || dayjs().format('YYYY-MM-DD');
    res.json({
      pingSummary: db.getPingSummary(startDate, endDate),
      pings: db.getPingsByDateRange(startDate, endDate),
    });
  });

  boltApp.receiver.app.use('/dashboard', router);
  console.log(`[dashboard] Available at /dashboard`);
};

// ═══════════════════════════════════════════════════════════════════
// HTML STYLES
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
  .card .value.green { color: var(--green); } .card .value.yellow { color: var(--yellow); }
  .card .value.red { color: var(--red); }
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
  .progress-bar.green { background: var(--green); }
  .progress-bar.yellow { background: var(--yellow); }
  .progress-bar.red { background: var(--red); }
</style>
`;

const layout = (title, nav, body) => `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Hoopla Asistencia</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${STYLES}
</head>
<body>
  <div class="container">
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
  </div>
</body>
</html>
`;

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD HOME
// ═══════════════════════════════════════════════════════════════════

const renderDashboard = ({ todayRecords, missing, weeklySummary, users, tracked, today }) => {
  const presentCount = todayRecords.length;
  const completeCount = todayRecords.filter(r => r.exit_time).length;
  const weeklyHours = weeklySummary.reduce((sum, r) => sum + (r.total_hours || 0), 0);

  const todayRows = todayRecords.map(r => `
    <tr>
      <td>${r.real_name || r.name}</td>
      <td>${r.entry_time || '—'}</td>
      <td>${r.lunch_start || '—'} – ${r.lunch_end || '—'}</td>
      <td>${r.exit_time || '—'}</td>
      <td>${r.total_hours ? r.total_hours + 'hs' : '—'}</td>
      <td><span class="badge ${r.exit_time ? 'complete' : 'partial'}">${r.exit_time ? 'Completo' : 'En curso'}</span></td>
    </tr>
  `).join('');

  const missingRows = missing.map(u => `
    <tr><td>${u.real_name || u.name}</td><td><span class="badge missing">Sin registro</span></td></tr>
  `).join('');

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
// RECORDS
// ═══════════════════════════════════════════════════════════════════

const renderRecords = ({ records, users, startDate, endDate, selectedUser }) => {
  const userOptions = users.map(u =>
    `<option value="${u.slack_id}" ${selectedUser === u.slack_id ? 'selected' : ''}>${u.real_name || u.name}</option>`
  ).join('');

  const rows = records.map(r => {
    const status = r.exit_time ? 'complete' : (r.entry_time ? 'partial' : 'missing');
    const label = r.exit_time ? 'Completo' : (r.entry_time ? 'Parcial' : 'Sin datos');
    return `<tr>
      <td>${dayjs(r.date).format('DD/MM/YYYY')}</td><td>${r.real_name || r.name}</td>
      <td>${r.entry_time || '—'}</td><td>${r.lunch_start || '—'}</td><td>${r.lunch_end || '—'}</td>
      <td>${r.exit_time || '—'}</td><td>${r.total_hours ? r.total_hours + 'hs' : '—'}</td>
      <td><span class="badge ${status}">${label}</span></td>
    </tr>`;
  }).join('');

  return layout('Registros', 'records', `
    <form class="filters" method="GET" action="/dashboard/records">
      <div><label>Desde</label><input type="date" name="from" value="${startDate}"></div>
      <div><label>Hasta</label><input type="date" name="to" value="${endDate}"></div>
      <div><label>Persona</label><select name="user"><option value="">Todas</option>${userOptions}</select></div>
      <button type="submit">Filtrar</button>
    </form>
    <div class="card">
      ${records.length > 0 ? `<table><thead><tr>
        <th>Fecha</th><th>Persona</th><th>Entrada</th><th>Almuerzo ini</th><th>Almuerzo fin</th><th>Salida</th><th>Horas</th><th>Estado</th>
      </tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="empty">No hay registros para el período seleccionado</p>'}
    </div>
  `);
};

// ═══════════════════════════════════════════════════════════════════
// ACTIVITY
// ═══════════════════════════════════════════════════════════════════

const renderActivity = ({ pingSummary, pings, presenceData, startDate, endDate }) => {
  const pingRows = pingSummary.map(r => {
    const rate = r.total_pings > 0 ? Math.round((r.responded / r.total_pings) * 100) : 0;
    const avgSec = r.avg_response_ms ? Math.round(r.avg_response_ms / 1000) : '—';
    const barColor = rate >= 70 ? 'green' : rate >= 50 ? 'yellow' : 'red';
    return `<tr>
      <td>${r.real_name || r.name}</td>
      <td>${r.total_pings}</td><td>${r.responded}</td><td>${r.missed}</td>
      <td>${rate}% <div class="progress"><div class="progress-bar ${barColor}" style="width:${rate}%"></div></div></td>
      <td>${avgSec}s</td>
    </tr>`;
  }).join('');

  const presenceRows = presenceData.map(r => {
    const pct = r.active_pct || 0;
    const barColor = pct >= 70 ? 'green' : pct >= 50 ? 'yellow' : 'red';
    return `<tr>
      <td>${r.real_name || r.name}</td>
      <td>${r.total_checks}</td><td>${r.active_count}</td><td>${r.away_count}</td>
      <td>${pct}% <div class="progress"><div class="progress-bar ${barColor}" style="width:${pct}%"></div></div></td>
    </tr>`;
  }).join('');

  return layout('Actividad', 'activity', `
    <form class="filters" method="GET" action="/dashboard/activity">
      <div><label>Desde</label><input type="date" name="from" value="${startDate}"></div>
      <div><label>Hasta</label><input type="date" name="to" value="${endDate}"></div>
      <button type="submit">Filtrar</button>
    </form>

    <div class="card" style="margin-bottom:1.5rem">
      <h3>🏓 Pings de actividad</h3>
      ${pingSummary.length > 0 ? `<table><thead><tr>
        <th>Persona</th><th>Enviados</th><th>Respondidos</th><th>Perdidos</th><th>Tasa</th><th>Promedio</th>
      </tr></thead><tbody>${pingRows}</tbody></table>`
      : '<p class="empty">No hay datos de pings para el período</p>'}
    </div>

    <div class="card">
      <h3>👁️ Presencia Slack</h3>
      ${presenceData.length > 0 ? `<table><thead><tr>
        <th>Persona</th><th>Checks</th><th>Active</th><th>Away</th><th>Presencia</th>
      </tr></thead><tbody>${presenceRows}</tbody></table>`
      : '<p class="empty">No hay datos de presencia para el período</p>'}
    </div>
  `);
};

// ═══════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════

const renderUsers = ({ users, tracked, admins }) => {
  const trackedIds = new Set(tracked.map(u => u.slack_id));
  const adminIds = new Set(admins.map(u => u.slack_id));

  const rows = users.map(u => {
    const badges = [];
    if (adminIds.has(u.slack_id)) badges.push('<span class="badge admin">Admin</span>');
    if (trackedIds.has(u.slack_id)) badges.push('<span class="badge tracked">Trackeado</span>');
    return `<tr>
      <td>${u.real_name || u.name}</td>
      <td style="font-size:0.75rem;color:var(--text-muted)">${u.slack_id}</td>
      <td>${badges.join(' ') || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="font-size:0.75rem;color:var(--text-muted)">${u.created_at || '—'}</td>
    </tr>`;
  }).join('');

  return layout('Usuarios', 'users', `
    <div class="grid">
      <div class="card"><h3>Total usuarios</h3><div class="value">${users.length}</div></div>
      <div class="card"><h3>Trackeados</h3><div class="value green">${tracked.length}</div></div>
      <div class="card"><h3>Admins</h3><div class="value" style="color:var(--accent-light)">${admins.length}</div></div>
    </div>

    <div class="card">
      <h3>Todos los usuarios</h3>
      <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:1rem">
        Gestión vía Slack: <code>/admin agregar @usuario</code> · <code>/admin sacar @usuario</code>
      </p>
      ${users.length > 0 ? `<table><thead><tr>
        <th>Nombre</th><th>Slack ID</th><th>Rol</th><th>Desde</th>
      </tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="empty">No hay usuarios registrados</p>'}
    </div>
  `);
};

module.exports = { setupDashboard };
