const express = require('express');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { layout } = require('./styles');

const dashboardAuth = (req, res, next) => {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return next();
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Basic ')) {
    const [, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (pass === token) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Hoopla Asistencia"');
  res.status(401).send('Acceso no autorizado');
};

const setupDashboard = (receiver) => {
  const router = express.Router();
  router.use(dashboardAuth);

  // ─── Hoy ──────────────────────────────────────────────────────────
  router.get('/', (_req, res) => {
    const hoy = t.today();
    const dias = db.getDias(hoy, hoy);
    const tracked = db.getTracked();
    const falt = db.faltantes(hoy);
    const novedades = db.getNovedadesFecha(hoy);
    res.send(renderHoy({ hoy, dias, tracked, falt, novedades }));
  });

  // ─── Registros ────────────────────────────────────────────────────
  router.get('/registros', (req, res) => {
    const from = req.query.from || t.monthStart();
    const to = req.query.to || t.today();
    const user = req.query.user || '';
    const dias = db.getDias(from, to, user || null);
    res.send(renderRegistros({ dias, users: db.getAllUsers(), from, to, selected: user }));
  });

  // ─── Actividad ────────────────────────────────────────────────────
  router.get('/actividad', (req, res) => {
    const from = req.query.from || t.weekStart();
    const to = req.query.to || t.today();
    const presencia = db.presenciaSummary(from, to);
    // Pings solo se muestran si hubo modo dirigido en el rango
    const huboPings = db.getPingModosEnRango(from, to);
    const pings = huboPings ? db.pingSummary(from, to) : [];
    res.send(renderActividad({ presencia, pings, huboPings, from, to }));
  });

  // ─── Usuarios ─────────────────────────────────────────────────────
  router.get('/usuarios', (_req, res) => {
    res.send(renderUsuarios({ users: db.getAllUsers() }));
  });

  receiver.app.use('/dashboard', router);
  console.log('[dashboard] Disponible en /dashboard');
};

// ─── Renders ────────────────────────────────────────────────────────

const flagsCell = (d) => {
  const f = [];
  if (d.tarde_min > 0) f.push(`<span class="badge missing">+${d.tarde_min}' tarde</span>`);
  if (d.anticipado_min > 0) f.push(`<span class="badge partial">−${d.anticipado_min}' antic.</span>`);
  if (d.auto_closed) f.push(`<span class="badge auto">${d.corregido ? `auto → corregida (era ${d.valor_original})` : 'auto sin respuesta'}</span>`);
  if (d.origen === 'mobile_remoto') f.push('<span class="badge remoto">📱 remoto</span>');
  return f.join(' ') || '—';
};

const filaDia = (d, conFecha) => `
  <tr>
    ${conFecha ? `<td>${t.fmtDate(d.fecha)}</td>` : ''}
    <td>${d.nombre}</td>
    <td>${d.entrada || '—'}</td>
    <td>${d.almuerzo_inicio || '—'} – ${d.almuerzo_fin || '—'}</td>
    <td>${d.salida || '—'}</td>
    <td>${d.horas != null ? d.horas + 'hs' : '—'}</td>
    <td>${flagsCell(d)}</td>
    <td><span class="badge ${d.salida ? 'complete' : 'partial'}">${d.salida ? 'Completo' : 'En curso'}</span></td>
  </tr>`;

const renderHoy = ({ hoy, dias, tracked, falt, novedades }) => {
  const completos = dias.filter(d => d.salida).length;
  const horasEquipo = Math.round(dias.reduce((s, d) => s + (d.horas || 0), 0) * 10) / 10;

  const faltRows = falt.map(u => `<tr><td>${u.nombre}</td><td>${u.hora_entrada}</td><td><span class="badge missing">Sin registro</span></td></tr>`).join('');
  const novRows = novedades.map(n => `<tr><td>${txt.NOVEDADES[n.tipo] || n.tipo}</td><td>${n.nombre || 'Todos'}</td><td>${n.motivo || '—'}</td></tr>`).join('');

  return layout('Hoy', 'hoy', `
    <div class="grid">
      <div class="card"><h3>Presentes</h3><div class="value green">${dias.filter(d => d.entrada).length}</div></div>
      <div class="card"><h3>Faltantes</h3><div class="value ${falt.length ? 'red' : 'green'}">${falt.length}</div></div>
      <div class="card"><h3>Jornada completa</h3><div class="value ${completos === dias.length && dias.length ? 'green' : 'yellow'}">${completos}</div></div>
      <div class="card"><h3>Horas del equipo</h3><div class="value">${horasEquipo}</div></div>
      <div class="card"><h3>Trackeados</h3><div class="value">${tracked.length}</div></div>
    </div>
    <div class="card" style="margin-bottom:1.5rem">
      <h3>Hoy — ${t.fmtDate(hoy)}</h3>
      ${dias.length ? `<table><thead><tr><th>Persona</th><th>Entrada</th><th>Almuerzo</th><th>Salida</th><th>Horas</th><th>Flags</th><th>Estado</th></tr></thead>
        <tbody>${dias.map(d => filaDia(d, false)).join('')}</tbody></table>` : '<p class="empty">Sin registros por ahora</p>'}
    </div>
    ${falt.length ? `<div class="card" style="margin-bottom:1.5rem"><h3>⚠️ Faltantes (sin novedad)</h3>
      <table><thead><tr><th>Persona</th><th>Su entrada</th><th>Estado</th></tr></thead><tbody>${faltRows}</tbody></table></div>` : ''}
    ${novedades.length ? `<div class="card"><h3>📋 Novedades de hoy</h3>
      <table><thead><tr><th>Tipo</th><th>Persona</th><th>Motivo</th></tr></thead><tbody>${novRows}</tbody></table></div>` : ''}
  `);
};

const renderRegistros = ({ dias, users, from, to, selected }) => {
  const opts = users.map(u => `<option value="${u.slack_id}" ${selected === u.slack_id ? 'selected' : ''}>${u.nombre}</option>`).join('');
  return layout('Registros', 'registros', `
    <form class="filters" method="GET" action="/dashboard/registros">
      <div><label>Desde</label><input type="date" name="from" value="${from}"></div>
      <div><label>Hasta</label><input type="date" name="to" value="${to}"></div>
      <div><label>Persona</label><select name="user"><option value="">Todas</option>${opts}</select></div>
      <button type="submit">Filtrar</button>
    </form>
    <div class="card">${dias.length ? `<table><thead><tr>
      <th>Fecha</th><th>Persona</th><th>Entrada</th><th>Almuerzo</th><th>Salida</th><th>Horas</th><th>Flags</th><th>Estado</th>
    </tr></thead><tbody>${dias.map(d => filaDia(d, true)).join('')}</tbody></table>` : '<p class="empty">No hay registros</p>'}</div>`);
};

const renderActividad = ({ presencia, pings, huboPings, from, to }) => {
  const presRows = presencia.map(p => {
    const c = p.pct >= 70 ? 'green' : p.pct >= 50 ? 'yellow' : 'red';
    return `<tr><td>${p.nombre}</td><td>${p.checks}</td><td>${p.activos}</td>
      <td>${p.pct}% <div class="progress"><div class="progress-bar ${c}" style="width:${p.pct}%"></div></div></td></tr>`;
  }).join('');
  const pingRows = pings.map(p => `<tr><td>${p.nombre}</td><td>${p.enviados}</td><td>${p.ok}</td><td>${p.perdidos}</td><td>${p.prom_seg != null ? p.prom_seg + 's' : '—'}</td></tr>`).join('');
  return layout('Actividad', 'actividad', `
    <form class="filters" method="GET" action="/dashboard/actividad">
      <div><label>Desde</label><input type="date" name="from" value="${from}"></div>
      <div><label>Hasta</label><input type="date" name="to" value="${to}"></div>
      <button type="submit">Filtrar</button>
    </form>
    <div class="card" style="margin-bottom:1.5rem"><h3>👁️ Presencia Slack (% activo en horario laboral)</h3>
      ${presencia.length ? `<table><thead><tr><th>Persona</th><th>Checks</th><th>Activo</th><th>% presencia</th></tr></thead><tbody>${presRows}</tbody></table>` : '<p class="empty">Sin datos</p>'}
    </div>
    ${huboPings ? `<div class="card"><h3>🏓 Pings dirigidos</h3>
      ${pings.length ? `<table><thead><tr><th>Persona</th><th>Enviados</th><th>OK</th><th>Perdidos</th><th>Respuesta prom.</th></tr></thead><tbody>${pingRows}</tbody></table>` : '<p class="empty">Sin pings en el rango</p>'}
    </div>` : ''}`);
};

const renderUsuarios = ({ users }) => {
  const rows = users.map(u => {
    const b = [];
    if (u.es_admin) b.push('<span class="badge admin">Admin</span>');
    if (u.trackeado) b.push('<span class="badge tracked">Trackeado</span>');
    return `<tr><td>${u.nombre}</td><td style="font-size:0.75rem;color:var(--text-muted)">${u.slack_id}</td>
      <td>${u.hora_entrada}–${u.hora_salida}</td><td>${u.carga_horaria}hs</td><td>${b.join(' ') || '—'}</td></tr>`;
  }).join('');
  return layout('Usuarios', 'usuarios', `
    <div class="grid">
      <div class="card"><h3>Total</h3><div class="value">${users.length}</div></div>
      <div class="card"><h3>Trackeados</h3><div class="value green">${users.filter(u => u.trackeado).length}</div></div>
      <div class="card"><h3>Admins</h3><div class="value" style="color:var(--accent-light)">${users.filter(u => u.es_admin).length}</div></div>
    </div>
    <div class="card"><h3>Roster</h3>
      <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:1rem">Gestión por DM al bot: <code>admin agregar @usuario</code> · <code>admin horario @usuario HH:MM HH:MM Nhs</code></p>
      ${users.length ? `<table><thead><tr><th>Nombre</th><th>Slack ID</th><th>Horario</th><th>Carga</th><th>Badges</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">Sin usuarios</p>'}
    </div>`);
};

module.exports = { setupDashboard };
