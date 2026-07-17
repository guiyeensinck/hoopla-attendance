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
  router.use(express.urlencoded({ extended: true }));

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

  // ─── Proyectos ────────────────────────────────────────────────────
  router.get('/proyectos', (req, res) => {
    const from = req.query.from || t.monthStart();
    const to = req.query.to || t.today();
    res.send(renderProyectos({
      from, to, err: req.query.err || null,
      clientes: db.horasPorCliente(from, to),
      proyectos: db.horasPorProyecto(from, to),
      detalle: db.horasProyectoPersona(from, to),
      categorias: db.horasPorCategoria(from, to),
      activos: db.getProyectos(true),
      todos: db.getProyectos(false),
    }));
  });

  // Alta de proyecto desde el dashboard (mismo basic auth)
  router.post('/proyectos/nuevo', (req, res) => {
    const nombre = (req.body.nombre || '').trim();
    const cliente = (req.body.cliente || '').trim() || null;
    if (nombre) {
      db.crearProyecto(nombre, cliente);
      console.log(`[dashboard] Proyecto creado/actualizado: ${cliente ? cliente + ' / ' : ''}${nombre}`);
    }
    res.redirect('/dashboard/proyectos');
  });

  router.post('/proyectos/archivar', (req, res) => {
    const id = parseInt(req.body.id, 10);
    if (id) db.archivarProyecto(id);
    res.redirect('/dashboard/proyectos');
  });

  router.post('/proyectos/reactivar', (req, res) => {
    const id = parseInt(req.body.id, 10);
    if (id) db.reactivarProyecto(id);
    res.redirect('/dashboard/proyectos');
  });

  // Edición inline de nombre/cliente (las horas imputadas siguen al proyecto)
  router.post('/proyectos/editar', (req, res) => {
    const id = parseInt(req.body.id, 10);
    const nombre = (req.body.nombre || '').trim();
    if (!id || !nombre) { res.redirect('/dashboard/proyectos'); return; }
    const ok = db.editarProyecto(id, nombre, (req.body.cliente || '').trim() || null);
    if (ok) console.log(`[dashboard] Proyecto ${id} editado → ${req.body.cliente || '—'} / ${nombre}`);
    res.redirect(`/dashboard/proyectos${ok ? '' : '?err=duplicado'}`);
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

const renderProyectos = ({ from, to, err, clientes, proyectos, detalle, categorias, activos, todos }) => {
  const totalImputado = Math.round(clientes.reduce((s, c) => s + c.horas, 0) * 10) / 10;

  // Catálogo completo, editable inline: cliente y nombre son inputs asociados
  // al form de "Guardar" de su fila (atributo form=)
  const btnMini = 'background:none;border:1px solid var(--border);color:var(--text-muted);padding:0.2rem 0.6rem;border-radius:4px;cursor:pointer;font-family:inherit;font-size:0.75rem';
  const inpMini = 'background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:0.35rem 0.5rem;border-radius:4px;font-family:inherit;font-size:0.8rem;width:100%';
  const catalogoRows = todos.map(p => `
    <tr>
      <td><input form="ed${p.id}" name="cliente" value="${p.cliente || ''}" placeholder="—" style="${inpMini}"></td>
      <td><input form="ed${p.id}" name="nombre" value="${p.nombre}" required style="${inpMini};font-weight:600"></td>
      <td>${p.activo ? '<span class="badge tracked">Activo</span>' : '<span class="badge missing">Archivado</span>'}</td>
      <td style="white-space:nowrap">
        <form id="ed${p.id}" method="POST" action="/dashboard/proyectos/editar" style="display:inline">
          <input type="hidden" name="id" value="${p.id}">
          <button type="submit" style="${btnMini}" title="Guardar cambios de nombre/cliente">💾 Guardar</button>
        </form>
        ${p.activo ? `<form method="POST" action="/dashboard/proyectos/archivar" style="display:inline" onsubmit="return confirm('¿Archivar ${p.nombre}? Las horas imputadas se conservan.')">
          <input type="hidden" name="id" value="${p.id}">
          <button type="submit" style="${btnMini}">Archivar</button>
        </form>` : `<form method="POST" action="/dashboard/proyectos/reactivar" style="display:inline">
          <input type="hidden" name="id" value="${p.id}">
          <button type="submit" style="${btnMini};color:var(--green);border-color:var(--green)">Reactivar</button>
        </form>`}
      </td>
    </tr>`).join('');

  const formAlta = `
    <form method="POST" action="/dashboard/proyectos/nuevo" class="filters" style="margin-bottom:1rem">
      <div><label>Cliente (opcional)</label><input type="text" name="cliente" placeholder="Cencosud"></div>
      <div><label>Proyecto</label><input type="text" name="nombre" placeholder="Jumbo" required></div>
      <button type="submit">➕ Agregar</button>
    </form>`;

  const clienteRows = clientes.map(c => {
    const pct = totalImputado ? Math.round((c.horas / totalImputado) * 100) : 0;
    return `<tr><td><strong>${c.cliente}</strong></td><td>${c.horas}hs</td>
      <td>${pct}% <div class="progress"><div class="progress-bar green" style="width:${pct}%"></div></div></td>
      <td>${c.proyectos}</td><td>${c.personas}</td></tr>`;
  }).join('');

  const proyectoRows = proyectos.map(p => {
    const personas = detalle.filter(d => d.proyecto === p.nombre).map(d => `${d.persona} ${d.horas}hs`).join(' · ');
    return `<tr><td style="color:var(--text-muted)">${p.cliente || '—'}</td><td><strong>${p.nombre}</strong></td>
      <td>${p.horas}hs</td><td style="font-size:0.8rem;color:var(--text-muted)">${personas}</td></tr>`;
  }).join('');

  const conCategoria = categorias.filter(c => c.categoria !== 'sin categoría');
  const catRows = categorias.map(c => `<tr><td>${c.categoria}</td><td>${c.horas}hs</td></tr>`).join('');

  return layout('Proyectos', 'proyectos', `
    <form class="filters" method="GET" action="/dashboard/proyectos">
      <div><label>Desde</label><input type="date" name="from" value="${from}"></div>
      <div><label>Hasta</label><input type="date" name="to" value="${to}"></div>
      <button type="submit">Filtrar</button>
    </form>
    <div class="grid">
      <div class="card"><h3>Horas imputadas</h3><div class="value">${totalImputado}</div></div>
      <div class="card"><h3>Clientes con horas</h3><div class="value green">${clientes.length}</div></div>
      <div class="card"><h3>Proyectos con horas</h3><div class="value">${proyectos.length}</div></div>
      <div class="card"><h3>Proyectos activos</h3><div class="value" style="color:var(--accent-light)">${activos.length}</div></div>
    </div>
    <div class="card" style="margin-bottom:1.5rem"><h3>🏢 Por cliente</h3>
      ${clientes.length ? `<table><thead><tr><th>Cliente</th><th>Horas</th><th>% del total</th><th>Proyectos</th><th>Personas</th></tr></thead><tbody>${clienteRows}</tbody></table>` : '<p class="empty">Sin horas imputadas en el período</p>'}
    </div>
    <div class="card" style="margin-bottom:1.5rem"><h3>🗂️ Por proyecto</h3>
      ${proyectos.length ? `<table><thead><tr><th>Cliente</th><th>Proyecto</th><th>Horas</th><th>Quiénes</th></tr></thead><tbody>${proyectoRows}</tbody></table>` : '<p class="empty">Sin horas imputadas en el período</p>'}
    </div>
    ${conCategoria.length ? `<div class="card" style="margin-bottom:1.5rem"><h3>🏷️ Por categoría de trabajo</h3>
      <table><thead><tr><th>Categoría</th><th>Horas</th></tr></thead><tbody>${catRows}</tbody></table>
    </div>` : ''}
    <div class="card"><h3>📚 Catálogo (${activos.length} activos)</h3>
      ${err === 'duplicado' ? '<p style="color:var(--red);font-size:0.85rem;margin-bottom:0.75rem">⚠️ Ya existe un proyecto con ese nombre — no guardé el cambio.</p>' : ''}
      ${formAlta}
      ${todos.length ? `<table><thead><tr><th>Cliente</th><th>Proyecto</th><th>Estado</th><th></th></tr></thead><tbody>${catalogoRows}</tbody></table>` : '<p class="empty">Sin proyectos — cargá el primero acá arriba o por DM con <code>admin proyecto agregar Cliente / Proyecto</code></p>'}
      <p style="font-size:0.75rem;color:var(--text-muted);margin-top:0.75rem">Editá cliente o nombre directo en la tabla y tocá 💾 — las horas imputadas siguen al proyecto.</p>
    </div>`);
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
    if (u.modo === 'solo_proyectos') b.push('<span class="badge partial">Solo proyectos</span>');
    return `<tr><td>${u.nombre}</td><td style="font-size:0.75rem;color:var(--text-muted)">${u.slack_id}</td>
      <td>${u.equipo || '—'}</td>
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
      ${users.length ? `<table><thead><tr><th>Nombre</th><th>Slack ID</th><th>Equipo</th><th>Horario</th><th>Carga</th><th>Badges</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">Sin usuarios</p>'}
    </div>`);
};

module.exports = { setupDashboard };
