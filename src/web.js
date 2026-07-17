const express = require('express');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { isMobileUA } = require('./verification');
const { semanaUsuario } = require('./balance');
const { promptImputacion, fechaDestino, guardarYResumir, CATEGORIAS } = require('./proyectos');
const { miniLayout } = require('./styles');

/**
 * Páginas de marcación: GET /verify/:token muestra el formulario,
 * POST /verify/:token consume el token y registra con hora del servidor.
 * Tras registrar, el bot confirma por DM (el historial queda en el chat).
 *
 * Mobile: bloqueado salvo novedad `remoto` para ese día. Los intentos
 * bloqueados se loguean para el reporte admin.
 */
const setupWeb = (receiver, slackClient = null) => {
  // Acuse por DM sin bloquear la respuesta HTTP
  const confirmarPorDM = (userId, texto) => {
    if (!slackClient) return;
    slackClient.chat.postMessage({ channel: userId, text: texto })
      .catch(e => console.error('[web] No pude confirmar por DM:', e.message));
  };
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  const checkMobile = (req, userId) => {
    const ua = req.headers['user-agent'] || '';
    if (!isMobileUA(ua)) return { blocked: false, origen: 'web' };
    if (userId && db.hasNovedad(userId, t.today(), 'remoto')) return { blocked: false, origen: 'mobile_remoto' };
    if (userId) db.logIntentoMobile(userId, t.today(), t.currentTime(), ua);
    return { blocked: true };
  };

  router.get('/:token', (req, res) => {
    const userId = db.peekToken(req.params.token);
    if (!userId) { res.status(410).send(renderError(txt.web.linkInvalido, txt.web.linkInvalidoDetalle)); return; }

    const mob = checkMobile(req, userId);
    if (mob.blocked) { res.status(403).send(renderError(txt.web.mobileBloqueado, txt.web.mobileBloqueadoDetalle)); return; }

    const user = db.getUser(userId);
    const fecha = t.today();
    const dia = db.getDia(userId, fecha);
    const next = db.nextTipo(dia);
    const corregible = !next && dia.salida?.auto_closed === 1 && !dia.salida.corregido;

    if (!next && !corregible) {
      res.send(renderResultado({ user, dia, titulo: txt.web.diaCompleto, detalle: null }));
      return;
    }
    res.send(renderForm({ token: req.params.token, user, dia, next, corregible }));
  });

  router.post('/:token', (req, res) => {
    try {
      const peekId = db.peekToken(req.params.token);
      const mob = checkMobile(req, peekId);
      if (mob.blocked) { res.status(403).send(renderError(txt.web.mobileBloqueado, txt.web.mobileBloqueadoDetalle)); return; }

      const userId = db.consumeToken(req.params.token);
      if (!userId) { res.status(410).send(renderError(txt.web.linkInvalido, txt.web.linkInvalidoDetalle)); return; }

      const user = db.getUser(userId);
      const fecha = t.today();
      const hora = t.currentTime(); // SIEMPRE hora del servidor
      let dia = db.getDia(userId, fecha);
      const next = db.nextTipo(dia);

      let titulo, detalle = null;
      if (next) {
        const { tarde_min, anticipado_min } = db.registrar(user, fecha, next, hora, mob.origen);
        titulo = `${txt.web.registrado} — ${txt.TIPOS[next].label} ${hora}`;
        if (tarde_min > 0) detalle = txt.web.tarde(tarde_min);
        if (anticipado_min > 0) detalle = txt.web.anticipado(anticipado_min);
        confirmarPorDM(userId, txt.marcar.confirmacionDM(txt.TIPOS[next].emoji, txt.TIPOS[next].label, hora)
          + (tarde_min > 0 ? txt.marcar.confirmacionTarde(tarde_min) : ''));
        // Al marcar salida, preguntar en qué se fue el día
        if (next === 'salida' && slackClient) promptImputacion(slackClient, user, fecha);
      } else if (dia.salida?.auto_closed === 1 && !dia.salida.corregido) {
        // Corrección única del auto-cierre — el valor original queda loggeado
        const original = dia.salida.hora;
        db.corregirSalida(user, fecha, hora);
        titulo = `${txt.web.corregido} — ${hora}`;
        confirmarPorDM(userId, txt.marcar.confirmacionCorreccion(hora, original));
      } else {
        titulo = txt.web.diaCompleto;
      }

      dia = db.getDia(userId, fecha);
      res.send(renderResultado({ user, dia, titulo, detalle }));
    } catch (err) {
      console.error('[web] Error en POST /verify:', err.message);
      res.status(500).send(renderError('Error', 'Algo falló al registrar. Escribile "marcar" al bot en Slack y probá con un link nuevo.'));
    }
  });

  receiver.app.use('/verify', router);

  // ─── Formulario de imputación con selects ─────────────────────────
  // Sin bloqueo mobile: imputar horas no es una marcación de asistencia.
  const imputar = express.Router();
  imputar.use(express.urlencoded({ extended: true }));

  const contextoImputar = (userId) => {
    const user = db.getUser(userId);
    const fecha = fechaDestino(userId);
    const trabajadas = db.horasDia(db.getDia(userId, fecha)) ?? user.carga_horaria;
    return { user, fecha, trabajadas, existentes: db.getImputacionesDia(userId, fecha), proyectos: db.getProyectos(true) };
  };

  imputar.get('/:token', (req, res) => {
    const userId = db.peekToken(req.params.token, 'imputar');
    if (!userId) { res.status(410).send(renderError(txt.web.linkInvalido, txt.imputar.webLinkInvalido)); return; }
    res.send(renderImputar({ token: req.params.token, ...contextoImputar(userId), error: null }));
  });

  imputar.post('/:token', (req, res) => {
    try {
      const userId = db.peekToken(req.params.token, 'imputar');
      if (!userId) { res.status(410).send(renderError(txt.web.linkInvalido, txt.imputar.webLinkInvalido)); return; }

      const ctx = contextoImputar(userId);
      const proys = [].concat(req.body.proyecto || []);
      const cats = [].concat(req.body.categoria || []);
      const hrs = [].concat(req.body.horas || []);

      // Filas → pares {proyecto_id, nombre, horas, categoria}, sumando duplicados
      const porClave = {};
      for (let i = 0; i < proys.length; i++) {
        const pid = parseInt(proys[i], 10);
        const h = parseFloat(hrs[i]);
        if (!pid || !(h > 0)) continue; // fila vacía
        const proyecto = ctx.proyectos.find(p => p.id === pid);
        if (!proyecto || h > 16) { res.send(renderImputar({ token: req.params.token, ...ctx, error: 'Revisá las filas: proyecto válido y horas entre 0.25 y 16.' })); return; }
        const categoria = CATEGORIAS.includes(cats[i]) ? cats[i] : null;
        const clave = `${pid}|${categoria || ''}`;
        porClave[clave] = porClave[clave] || { proyecto_id: pid, nombre: proyecto.nombre, horas: 0, categoria };
        porClave[clave].horas = Math.round((porClave[clave].horas + h) * 100) / 100;
      }
      const finales = Object.values(porClave);
      if (!finales.length) { res.send(renderImputar({ token: req.params.token, ...ctx, error: 'Cargá al menos una fila con proyecto y horas.' })); return; }
      if (finales.reduce((s, p) => s + p.horas, 0) > 24) { res.send(renderImputar({ token: req.params.token, ...ctx, error: 'El total no puede superar las 24hs.' })); return; }

      db.consumeToken(req.params.token, 'imputar');
      const resumen = guardarYResumir(ctx.user, ctx.fecha, finales, 'web');
      confirmarPorDM(userId, resumen);
      res.send(renderImputarOk({ user: ctx.user, fecha: ctx.fecha, trabajadas: ctx.trabajadas, finales }));
    } catch (err) {
      console.error('[web] Error en POST /imputar:', err.message);
      res.status(500).send(renderError('Error', 'Algo falló al guardar. Escribile "proyectos" al bot en Slack y pedí otro link.'));
    }
  });

  receiver.app.use('/imputar', imputar);
  receiver.app.get('/health', (_req, res) => res.json({ ok: true, ts: t.now().format() }));
  console.log('[web] Rutas /verify/:token, /imputar/:token y /health listas');
};

// ─── Renders ────────────────────────────────────────────────────────

const statusRows = (dia) => Object.entries(txt.TIPOS).map(([tipo, info]) => {
  const r = dia[tipo];
  let val = r ? r.hora : '—';
  if (r?.auto_closed) val += r.corregido ? ` (corregida, era ${r.valor_original})` : ' (auto)';
  return `<div class="status-row"><span>${info.emoji} ${info.label}</span><span>${val}</span></div>`;
}).join('');

const renderError = (titulo, detalle) => miniLayout('Error', `
  <div class="error-box"><h2>❌ ${titulo}</h2><p style="margin-top:0.75rem">${detalle}</p></div>`);

const renderForm = ({ token, user, dia, next, corregible }) => {
  const accion = next
    ? `${txt.TIPOS[next].emoji} Registrar ${txt.TIPOS[next].label}`
    : '✏️ Corregir salida (una sola vez)';
  const nota = corregible
    ? `<p style="text-align:center;font-size:0.8rem;color:var(--yellow);margin-bottom:1rem">⚠️ Tu salida fue cerrada automáticamente a las ${dia.salida.hora}. Al confirmar, se corrige a la hora actual y no se puede volver a cambiar.</p>`
    : '';
  return miniLayout('Marcar', `
    <div class="verify-card">
      <h2>📋 ${user.nombre}</h2>
      <p style="text-align:center;color:var(--text-muted);font-size:0.85rem;margin-bottom:1.25rem">${t.fmtDate(t.today())} · Horario ${user.hora_entrada}–${user.hora_salida}</p>
      <div style="margin-bottom:1.25rem">${statusRows(dia)}</div>
      ${nota}
      <form method="POST" action="/verify/${token}">
        <button type="submit" class="btn-primary">${accion}</button>
      </form>
      <p style="text-align:center;font-size:0.75rem;color:var(--text-muted);margin-top:1rem">La hora la registra el servidor al confirmar.</p>
    </div>`);
};

/** Página post-registro: marcaciones del día + desglose semanal con semáforo */
const renderResultado = ({ user, dia, titulo, detalle }) => {
  const semana = semanaUsuario(user);

  const filas = semana.dias.map(d => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--border);font-size:0.85rem;">
      <span>${d.semaforo} <strong>${d.label}</strong>${d.auto ? ' <span style="font-size:0.7rem;color:var(--yellow)">(auto)</span>' : ''}</span>
      <span style="font-weight:600">${d.horas != null ? d.horas + 'hs' : '—'}</span>
      <span style="color:var(--text-muted);font-size:0.75rem;max-width:40%">${d.detalle}</span>
    </div>`).join('');

  let balanceMsg;
  if (semana.diff >= 0) {
    balanceMsg = semana.diff > 0 ? `🟢 ${txt.web.balanceAFavor(semana.diff)}` : `🟢 ${txt.web.balanceOk}`;
  } else if (semana.horaCompensa) {
    balanceMsg = `${Math.abs(semana.diff) > 2 ? '🔴' : '🟡'} ${txt.web.balanceDebe(Math.abs(semana.diff), semana.horaCompensa)}`;
  } else {
    balanceMsg = `${Math.abs(semana.diff) > 2 ? '🔴' : '🟡'} ${txt.web.balanceDebeGeneral(Math.abs(semana.diff))}`;
  }

  return miniLayout('Registrado', `
    <div class="success-box">
      <h2>${titulo}</h2>
      <p style="color:var(--text-muted);font-size:0.85rem">${user.nombre} — ${t.fmtDate(t.today())}</p>
      ${detalle ? `<p style="margin-top:0.5rem;color:var(--yellow);font-size:0.9rem">${detalle}</p>` : ''}
    </div>
    <div class="verify-card" style="margin-top:1rem">${statusRows(dia)}</div>
    <div class="verify-card" style="margin-top:1rem">
      <h3 style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:0.75rem;">📅 Tu semana</h3>
      ${filas}
      <div style="display:flex;justify-content:space-between;padding:0.75rem 0 0.25rem;font-size:0.9rem;font-weight:600;">
        <span>Total</span><span>${semana.trabajadas}hs / ${semana.esperadas}hs</span>
      </div>
      <div style="text-align:center;padding:0.75rem;margin-top:0.5rem;background:var(--surface-2);border-radius:6px;font-size:0.9rem;">
        ${balanceMsg}
      </div>
    </div>`);
};

// ─── Formulario de imputación ───────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const opcionesProyectos = (proyectos, seleccionado = null) => {
  const grupos = {};
  for (const p of proyectos) (grupos[p.cliente || 'Otros'] ||= []).push(p);
  return ['<option value="">— proyecto —</option>']
    .concat(Object.keys(grupos).sort().map(cli =>
      `<optgroup label="${esc(cli)}">${grupos[cli].map(p =>
        `<option value="${p.id}"${p.id === seleccionado ? ' selected' : ''}>${esc(p.nombre)}</option>`).join('')}</optgroup>`))
    .join('');
};

const opcionesCategorias = (seleccionada = null) =>
  ['<option value="">sin categoría</option>']
    .concat(CATEGORIAS.map(c => `<option value="${esc(c)}"${c === seleccionada ? ' selected' : ''}>${esc(c)}</option>`))
    .join('');

const filaImputar = (proyectos, imp = null) => `
  <div class="fila-imp">
    <select name="proyecto" class="sel-proyecto">${opcionesProyectos(proyectos, imp?.proyecto_id ?? null)}</select>
    <div class="fila-imp-detalle">
      <select name="categoria">${opcionesCategorias(imp?.categoria ?? null)}</select>
      <input type="number" name="horas" min="0.25" max="16" step="0.25" placeholder="hs" value="${imp ? imp.horas : ''}" class="inp-horas">
      <button type="button" class="btn-quitar" onclick="quitarFila(this)">✕</button>
    </div>
  </div>`;

const renderImputar = ({ token, user, fecha, trabajadas, existentes, proyectos, error }) => {
  // Prefill con lo ya imputado (editar reemplaza el día) o una fila vacía
  const filas = existentes.length
    ? existentes.map(i => filaImputar(proyectos, i)).join('')
    : filaImputar(proyectos);

  return miniLayout('Imputar horas', `
    <style>
      .fila-imp { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; margin-bottom: 0.75rem; }
      .fila-imp select, .fila-imp input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 0.5rem; border-radius: 6px; font-family: inherit; font-size: 0.85rem; }
      .sel-proyecto { width: 100%; margin-bottom: 0.5rem; }
      .fila-imp-detalle { display: flex; gap: 0.5rem; }
      .fila-imp-detalle select { flex: 1; }
      .inp-horas { width: 5.5rem; }
      .btn-quitar { background: none; border: 1px solid var(--border); color: var(--text-muted); border-radius: 6px; padding: 0 0.6rem; cursor: pointer; font-family: inherit; }
      .btn-quitar:hover { color: var(--red); border-color: var(--red); }
      .btn-agregar { width: 100%; background: none; border: 1px dashed var(--border); color: var(--text-muted); padding: 0.6rem; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 0.85rem; margin-bottom: 1rem; }
      .btn-agregar:hover { color: var(--accent-light); border-color: var(--accent); }
      #total-linea { display: flex; justify-content: space-between; padding: 0.6rem 0.25rem; font-size: 0.9rem; font-weight: 600; }
    </style>
    <div class="verify-card">
      <h2>${txt.imputar.webTitulo}</h2>
      <p style="text-align:center;color:var(--text-muted);font-size:0.85rem;margin-bottom:1.25rem">${esc(user.nombre)} · ${t.fmtDate(fecha)}${trabajadas != null ? ` · ${trabajadas}hs de jornada` : ''}</p>
      ${error ? `<p style="text-align:center;color:var(--red);font-size:0.85rem;margin-bottom:1rem">⚠️ ${esc(error)}</p>` : ''}
      ${existentes.length ? '<p style="text-align:center;color:var(--yellow);font-size:0.8rem;margin-bottom:1rem">Ya tenías horas cargadas para este día — al guardar se reemplazan por lo que dejes acá.</p>' : ''}
      <form method="POST" action="/imputar/${token}">
        <div id="filas">${filas}</div>
        <button type="button" class="btn-agregar" onclick="agregarFila()">+ Agregar proyecto</button>
        <div id="total-linea"><span>Total</span><span><span id="total">0</span>hs${trabajadas != null ? ` / ${trabajadas}hs` : ''}</span></div>
        <button type="submit" class="btn-primary">💾 Guardar mi día</button>
      </form>
      <p style="text-align:center;font-size:0.75rem;color:var(--text-muted);margin-top:1rem">Podés repetir proyecto con distinta categoría. El link dura 30 minutos.</p>
    </div>
    <template id="tpl-fila">${filaImputar(proyectos)}</template>
    <script>
      const trabajadas = ${trabajadas != null ? trabajadas : 'null'};
      function agregarFila() {
        document.getElementById('filas').insertAdjacentHTML('beforeend', document.getElementById('tpl-fila').innerHTML);
        recalcular();
      }
      function quitarFila(btn) {
        const filas = document.querySelectorAll('.fila-imp');
        if (filas.length > 1) btn.closest('.fila-imp').remove();
        else btn.closest('.fila-imp').querySelectorAll('select,input').forEach(e => e.value = '');
        recalcular();
      }
      function recalcular() {
        let total = 0;
        document.querySelectorAll('.inp-horas').forEach(i => { const v = parseFloat(i.value); if (v > 0) total += v; });
        total = Math.round(total * 100) / 100;
        const el = document.getElementById('total');
        el.textContent = total;
        el.style.color = trabajadas == null ? '' : Math.abs(total - trabajadas) <= 0.5 ? 'var(--green)' : 'var(--yellow)';
      }
      document.getElementById('filas').addEventListener('input', recalcular);
      recalcular();
    </script>`);
};

const renderImputarOk = ({ user, fecha, trabajadas, finales }) => {
  const total = Math.round(finales.reduce((s, p) => s + p.horas, 0) * 10) / 10;
  const filas = finales.map(p => `
    <div class="status-row"><span>${esc(p.nombre)}${p.categoria ? ` <span style="color:var(--text-muted)">(${esc(p.categoria)})</span>` : ''}</span><span>${p.horas}hs</span></div>`).join('');
  return miniLayout('Horas guardadas', `
    <div class="success-box">
      <h2>${txt.imputar.webGuardado}</h2>
      <p style="color:var(--text-muted);font-size:0.85rem">${esc(user.nombre)} — ${t.fmtDate(fecha)}</p>
    </div>
    <div class="verify-card" style="margin-top:1rem">
      ${filas}
      <div style="display:flex;justify-content:space-between;padding:0.75rem 0 0.25rem;font-size:0.9rem;font-weight:600;">
        <span>Total</span><span>${total}hs${trabajadas != null ? ` / ${trabajadas}hs` : ''}</span>
      </div>
    </div>
    <p style="text-align:center;font-size:0.8rem;color:var(--text-muted);margin-top:1rem">Te dejé la confirmación por DM. Si querés corregir, pedile otro link al bot (escribile <em>proyectos</em>).</p>`);
};

module.exports = { setupWeb };
