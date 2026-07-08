// Estilos y layouts compartidos entre el dashboard y las páginas de verificación

const STYLES = `
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --surface-2: #232736;
    --border: #2d3145; --text: #e2e4ea; --text-muted: #8b8fa3;
    --accent: #6c5ce7; --accent-light: #a29bfe;
    --green: #00b894; --yellow: #fdcb6e; --red: #ff6b6b;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'JetBrains Mono', monospace; background: var(--bg); color: var(--text); line-height: 1.6; }
  .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; gap: 1rem; }
  header h1 { font-size: 1.5rem; font-weight: 600; color: var(--accent-light); letter-spacing: -0.02em; }
  header nav a { color: var(--text-muted); text-decoration: none; margin-left: 1.5rem; font-size: 0.85rem; transition: color 0.2s; }
  header nav a:hover, header nav a.active { color: var(--accent-light); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
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
  .badge.auto { background: rgba(253,203,110,0.15); color: var(--yellow); }
  .badge.remoto { background: rgba(108,92,231,0.15); color: var(--accent-light); }
  .filters { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; align-items: end; }
  .filters label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); display: block; margin-bottom: 0.25rem; }
  .filters input, .filters select { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 0.5rem 0.75rem; border-radius: 4px; font-family: inherit; font-size: 0.85rem; }
  .filters button { background: var(--accent); color: white; border: none; padding: 0.5rem 1.25rem; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 0.85rem; }
  .filters button:hover { opacity: 0.85; }
  .empty { color: var(--text-muted); text-align: center; padding: 3rem; }
  .progress { background: var(--surface-2); border-radius: 4px; height: 8px; overflow: hidden; margin-top: 0.25rem; }
  .progress-bar { height: 100%; border-radius: 4px; }
  .progress-bar.green { background: var(--green); } .progress-bar.yellow { background: var(--yellow); } .progress-bar.red { background: var(--red); }

  /* Páginas de verificación */
  .verify-container { max-width: 480px; margin: 4rem auto; padding: 2rem; }
  .verify-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; }
  .verify-card h2 { font-size: 1.2rem; color: var(--accent-light); margin-bottom: 1.5rem; text-align: center; }
  .btn-primary { width: 100%; background: var(--accent); color: white; border: none; padding: 0.85rem; border-radius: 6px; font-family: inherit; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 0.5rem; }
  .btn-primary:hover { opacity: 0.9; }
  .status-row { display: flex; justify-content: space-between; padding: 0.4rem 0; font-size: 0.85rem; border-bottom: 1px solid var(--border); }
  .status-row:last-child { border-bottom: none; }
  .error-box { background: rgba(255,107,107,0.1); border: 1px solid var(--red); border-radius: 8px; padding: 2rem; text-align: center; }
  .error-box h2 { color: var(--red); margin-bottom: 0.5rem; }
  .success-box { background: rgba(0,184,148,0.1); border: 1px solid var(--green); border-radius: 8px; padding: 2rem; text-align: center; }
  .success-box h2 { color: var(--green); margin-bottom: 0.5rem; }
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
      <a href="/dashboard" class="${nav === 'hoy' ? 'active' : ''}">Hoy</a>
      <a href="/dashboard/registros" class="${nav === 'registros' ? 'active' : ''}">Registros</a>
      <a href="/dashboard/proyectos" class="${nav === 'proyectos' ? 'active' : ''}">Proyectos</a>
      <a href="/dashboard/actividad" class="${nav === 'actividad' ? 'active' : ''}">Actividad</a>
      <a href="/dashboard/usuarios" class="${nav === 'usuarios' ? 'active' : ''}">Usuarios</a>
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

module.exports = { STYLES, layout, miniLayout };
