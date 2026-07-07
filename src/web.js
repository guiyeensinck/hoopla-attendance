const express = require('express');
const t = require('./time');
const db = require('./database');
const txt = require('./texts');
const { isMobileUA } = require('./verification');
const { semanaUsuario } = require('./balance');
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
  receiver.app.get('/health', (_req, res) => res.json({ ok: true, ts: t.now().format() }));
  console.log('[web] Rutas /verify/:token y /health listas');
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

module.exports = { setupWeb };
