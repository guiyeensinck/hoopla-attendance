const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const t = require('./time');

const DB_DIR = process.env.DB_PATH || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'attendance.db');
fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
console.log(`[db] SQLite en ${DB_PATH}`);

// ─── Schema ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    slack_id       TEXT PRIMARY KEY,
    nombre         TEXT NOT NULL,
    es_admin       INTEGER DEFAULT 0,
    trackeado      INTEGER DEFAULT 0,
    hora_entrada   TEXT DEFAULT '09:30',
    hora_salida    TEXT DEFAULT '18:30',
    carga_horaria  REAL DEFAULT 8,
    created_at     TEXT DEFAULT (datetime('now'))
  );

  -- Una fila por marcación: entrada | almuerzo_inicio | almuerzo_fin | salida
  CREATE TABLE IF NOT EXISTS registros (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT NOT NULL,
    fecha           TEXT NOT NULL,
    tipo            TEXT NOT NULL,
    hora            TEXT NOT NULL,
    tarde_min       INTEGER DEFAULT 0,
    anticipado_min  INTEGER DEFAULT 0,
    origen          TEXT DEFAULT 'web',   -- web | mobile_remoto | slack | auto
    auto_closed     INTEGER DEFAULT 0,
    corregido       INTEGER DEFAULT 0,
    valor_original  TEXT,
    nota            TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, fecha, tipo),
    FOREIGN KEY (user_id) REFERENCES users(slack_id)
  );

  CREATE TABLE IF NOT EXISTS tokens (
    token    TEXT PRIMARY KEY,
    user_id  TEXT NOT NULL,
    expira   INTEGER NOT NULL,   -- epoch ms
    usado    INTEGER DEFAULT 0
  );

  -- user_id NULL = aplica a todos (feriados)
  CREATE TABLE IF NOT EXISTS novedades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT,
    tipo        TEXT NOT NULL,   -- feriado | vacaciones | medico | ausente | libre | salida | remoto
    fecha       TEXT NOT NULL,
    motivo      TEXT,
    creado_por  TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS extras (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    fecha        TEXT NOT NULL,
    aprobado_por TEXT,
    bloques      INTEGER DEFAULT 0,   -- bloques de 30 min
    UNIQUE(user_id, fecha)
  );

  CREATE TABLE IF NOT EXISTS presencia (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  TEXT NOT NULL,
    fecha    TEXT NOT NULL,
    hora     TEXT NOT NULL,
    status   TEXT NOT NULL   -- active | away
  );

  CREATE TABLE IF NOT EXISTS pings (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    fecha             TEXT NOT NULL,
    enviado           TEXT NOT NULL,      -- HH:MM:SS
    respondido        INTEGER,            -- NULL pendiente | 1 ok | 0 perdido
    tiempo_respuesta  INTEGER             -- segundos
  );

  CREATE TABLE IF NOT EXISTS ping_modo (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    desde        TEXT NOT NULL,
    hasta        TEXT NOT NULL,
    activado_por TEXT
  );

  -- Estado del flujo de cierre del día por persona
  CREATE TABLE IF NOT EXISTS cierres (
    user_id       TEXT NOT NULL,
    fecha         TEXT NOT NULL,
    estado        TEXT NOT NULL,   -- esperando | extra_pendiente | extra_activa | pregunta | cerrado
    dm_hora       TEXT,            -- cuándo se mandó el DM de cierre / rechazo
    extra_hasta   TEXT,            -- fin del bloque extra vigente
    pregunta_hora TEXT,            -- cuándo se mandó "¿seguís trabajando?"
    PRIMARY KEY (user_id, fecha)
  );

  CREATE TABLE IF NOT EXISTS intentos_mobile (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    fecha      TEXT NOT NULL,
    hora       TEXT NOT NULL,
    user_agent TEXT
  );

  -- Deduplicación de avisos del scheduler (sobrevive reinicios)
  CREATE TABLE IF NOT EXISTS avisos (
    user_id TEXT NOT NULL,
    fecha   TEXT NOT NULL,
    tipo    TEXT NOT NULL,
    PRIMARY KEY (user_id, fecha, tipo)
  );

  CREATE INDEX IF NOT EXISTS idx_registros_fecha ON registros(fecha);
  CREATE INDEX IF NOT EXISTS idx_registros_user ON registros(user_id, fecha);
  CREATE INDEX IF NOT EXISTS idx_novedades_fecha ON novedades(fecha);
  CREATE INDEX IF NOT EXISTS idx_presencia ON presencia(user_id, fecha);
  CREATE INDEX IF NOT EXISTS idx_pings_fecha ON pings(fecha);
`);

const TIPOS_ORDEN = ['entrada', 'almuerzo_inicio', 'almuerzo_fin', 'salida'];
const NOVEDADES_EXENTAS = ['feriado', 'vacaciones', 'medico', 'ausente', 'libre'];

// ═══════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════
const upsertUser = (slackId, nombre) =>
  db.prepare(`INSERT INTO users (slack_id, nombre) VALUES (?, ?)
    ON CONFLICT(slack_id) DO UPDATE SET nombre = excluded.nombre`).run(slackId, nombre || slackId);

const getUser = (id) => db.prepare('SELECT * FROM users WHERE slack_id = ?').get(id);
const getAllUsers = () => db.prepare('SELECT * FROM users ORDER BY nombre').all();
const getTracked = () => db.prepare('SELECT * FROM users WHERE trackeado = 1 ORDER BY nombre').all();
const setTracked = (id, v) => db.prepare('UPDATE users SET trackeado = ? WHERE slack_id = ?').run(v ? 1 : 0, id);
const setAdmin = (id, v) => db.prepare('UPDATE users SET es_admin = ? WHERE slack_id = ?').run(v ? 1 : 0, id);
const setHorario = (id, entrada, salida, carga) =>
  db.prepare('UPDATE users SET hora_entrada = ?, hora_salida = ?, carga_horaria = ? WHERE slack_id = ?')
    .run(entrada, salida, carga, id);

const superAdmins = () => (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isSuperAdmin = (id) => superAdmins().includes(id);
const isAdmin = (id) => isSuperAdmin(id) || getUser(id)?.es_admin === 1;

// ═══════════════════════════════════════════════════════════════════
// REGISTROS
// ═══════════════════════════════════════════════════════════════════

/** Marcaciones del día como mapa { entrada: row, almuerzo_inicio: row, ... } */
const getDia = (userId, fecha) => {
  const rows = db.prepare('SELECT * FROM registros WHERE user_id = ? AND fecha = ?').all(userId, fecha);
  const dia = {};
  for (const r of rows) dia[r.tipo] = r;
  return dia;
};

/** Próxima marcación pendiente en la secuencia, o null si el día está completo */
const nextTipo = (dia) => TIPOS_ORDEN.find(tp => !dia[tp]) || null;

/** Horas trabajadas de un día (salida − entrada − almuerzo), o null si está incompleto */
const horasDia = (dia) => {
  if (!dia.entrada || !dia.salida) return null;
  let mins = t.toMin(dia.salida.hora) - t.toMin(dia.entrada.hora);
  if (dia.almuerzo_inicio && dia.almuerzo_fin) {
    mins -= t.toMin(dia.almuerzo_fin.hora) - t.toMin(dia.almuerzo_inicio.hora);
  }
  return Math.round((mins / 60) * 100) / 100;
};

/**
 * Registra una marcación con hora del servidor.
 * Calcula tarde_min (entrada) y anticipado_min (salida) contra el horario personal.
 */
const registrar = (user, fecha, tipo, hora, origen, extra = {}) => {
  let tarde = 0, anticipado = 0;
  if (tipo === 'entrada') tarde = Math.max(0, t.toMin(hora) - t.toMin(user.hora_entrada));
  if (tipo === 'salida' && !hasNovedad(user.slack_id, fecha, 'salida')) {
    anticipado = Math.max(0, t.toMin(user.hora_salida) - t.toMin(hora));
  }
  db.prepare(`INSERT INTO registros (user_id, fecha, tipo, hora, tarde_min, anticipado_min, origen, auto_closed, nota)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.slack_id, fecha, tipo, hora, tarde, anticipado, origen, extra.auto_closed ? 1 : 0, extra.nota || null);
  return { tarde_min: tarde, anticipado_min: anticipado };
};

/** Imputa almuerzo 13:00–14:00 si falta (para auto-cierres) */
const imputarAlmuerzo = (user, fecha) => {
  const dia = getDia(user.slack_id, fecha);
  if (!dia.almuerzo_inicio) {
    registrar(user, fecha, 'almuerzo_inicio', '13:00', 'auto', { nota: 'imputado' });
    registrar(user, fecha, 'almuerzo_fin', '14:00', 'auto', { nota: 'imputado' });
  } else if (!dia.almuerzo_fin) {
    const fin = t.toHHMM(t.toMin(dia.almuerzo_inicio.hora) + 60);
    registrar(user, fecha, 'almuerzo_fin', fin, 'auto', { nota: 'imputado' });
  }
};

/**
 * Corrige una salida auto-cerrada (una sola vez). El valor original queda loggeado.
 * Devuelve false si no es corregible (salida manual o ya corregida).
 */
const corregirSalida = (user, fecha, nuevaHora) => {
  const dia = getDia(user.slack_id, fecha);
  const s = dia.salida;
  if (!s || !s.auto_closed || s.corregido) return false;
  const anticipado = Math.max(0, t.toMin(user.hora_salida) - t.toMin(nuevaHora));
  db.prepare(`UPDATE registros SET valor_original = hora, hora = ?, corregido = 1, anticipado_min = ? WHERE id = ?`)
    .run(nuevaHora, anticipado, s.id);
  return true;
};

/** Días pivotados (una fila por persona/fecha) para reportes y dashboard */
const getDias = (from, to, userId = null) => {
  const rows = db.prepare(`
    SELECT r.user_id, r.fecha, u.nombre, u.carga_horaria, u.hora_entrada, u.hora_salida,
      MAX(CASE WHEN tipo='entrada' THEN hora END) entrada,
      MAX(CASE WHEN tipo='almuerzo_inicio' THEN hora END) almuerzo_inicio,
      MAX(CASE WHEN tipo='almuerzo_fin' THEN hora END) almuerzo_fin,
      MAX(CASE WHEN tipo='salida' THEN hora END) salida,
      MAX(CASE WHEN tipo='entrada' THEN tarde_min END) tarde_min,
      MAX(CASE WHEN tipo='salida' THEN anticipado_min END) anticipado_min,
      MAX(CASE WHEN tipo='salida' THEN auto_closed END) auto_closed,
      MAX(CASE WHEN tipo='salida' THEN corregido END) corregido,
      MAX(CASE WHEN tipo='salida' THEN valor_original END) valor_original,
      MAX(CASE WHEN tipo='entrada' THEN origen END) origen
    FROM registros r JOIN users u ON u.slack_id = r.user_id
    WHERE r.fecha BETWEEN ? AND ? ${userId ? 'AND r.user_id = ?' : ''}
    GROUP BY r.user_id, r.fecha
    ORDER BY r.fecha DESC, u.nombre
  `).all(...(userId ? [from, to, userId] : [from, to]));

  for (const r of rows) {
    let horas = null;
    if (r.entrada && r.salida) {
      let mins = t.toMin(r.salida) - t.toMin(r.entrada);
      if (r.almuerzo_inicio && r.almuerzo_fin) mins -= t.toMin(r.almuerzo_fin) - t.toMin(r.almuerzo_inicio);
      horas = Math.round((mins / 60) * 100) / 100;
    }
    r.horas = horas;
  }
  return rows;
};

// ═══════════════════════════════════════════════════════════════════
// NOVEDADES
// ═══════════════════════════════════════════════════════════════════
const addNovedad = (userId, tipo, fecha, motivo, creadoPor) =>
  db.prepare('INSERT INTO novedades (user_id, tipo, fecha, motivo, creado_por) VALUES (?, ?, ?, ?, ?)')
    .run(userId, tipo, fecha, motivo || null, creadoPor);

const getNovedadesFecha = (fecha) => db.prepare(`
  SELECT n.*, u.nombre FROM novedades n LEFT JOIN users u ON u.slack_id = n.user_id
  WHERE n.fecha = ? ORDER BY n.tipo, u.nombre`).all(fecha);

const getNovedadesRange = (from, to) => db.prepare(`
  SELECT n.*, u.nombre FROM novedades n LEFT JOIN users u ON u.slack_id = n.user_id
  WHERE n.fecha BETWEEN ? AND ? ORDER BY n.fecha, n.tipo`).all(from, to);

const isFeriado = (fecha) =>
  db.prepare("SELECT 1 FROM novedades WHERE fecha = ? AND tipo = 'feriado' AND user_id IS NULL").get(fecha) != null;

const hasNovedad = (userId, fecha, tipo) =>
  db.prepare('SELECT 1 FROM novedades WHERE fecha = ? AND tipo = ? AND user_id = ?').get(fecha, tipo, userId) != null;

/** ¿La persona está exenta de trabajar ese día? (feriado global o novedad personal) */
const isExento = (userId, fecha) => db.prepare(`
  SELECT 1 FROM novedades WHERE fecha = ?
    AND ((user_id IS NULL AND tipo = 'feriado') OR (user_id = ? AND tipo IN (${NOVEDADES_EXENTAS.map(() => '?').join(',')})))
  `).get(fecha, userId, ...NOVEDADES_EXENTAS) != null;

/** Días hábiles esperados para una persona en un rango (excluye feriados y novedades exentas) */
const diasEsperados = (userId, from, to) => {
  let count = 0;
  let d = t.dayjs(from);
  const end = t.dayjs(to);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    const ds = d.format('YYYY-MM-DD');
    if (t.isWeekday(ds) && !isExento(userId, ds)) count++;
    d = d.add(1, 'day');
  }
  return count;
};

// ═══════════════════════════════════════════════════════════════════
// TOKENS (persistidos — sobreviven redeploys)
// ═══════════════════════════════════════════════════════════════════
const TOKEN_TTL_MS = 5 * 60 * 1000;

const createToken = (userId) => {
  db.prepare('DELETE FROM tokens WHERE expira < ?').run(Date.now());
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO tokens (token, user_id, expira) VALUES (?, ?, ?)').run(token, userId, Date.now() + TOKEN_TTL_MS);
  return token;
};

/** Mira el token sin consumirlo. Devuelve user_id o null. */
const peekToken = (token) => {
  const row = db.prepare('SELECT * FROM tokens WHERE token = ?').get(token);
  if (!row || row.usado || row.expira < Date.now()) return null;
  return row.user_id;
};

/** Consume el token (un solo uso). Devuelve user_id o null. */
const consumeToken = (token) => {
  const userId = peekToken(token);
  if (userId) db.prepare('UPDATE tokens SET usado = 1 WHERE token = ?').run(token);
  return userId;
};

// ═══════════════════════════════════════════════════════════════════
// CIERRES / EXTRAS
// ═══════════════════════════════════════════════════════════════════
const getCierre = (userId, fecha) =>
  db.prepare('SELECT * FROM cierres WHERE user_id = ? AND fecha = ?').get(userId, fecha);

const setCierre = (userId, fecha, fields) => {
  const cur = getCierre(userId, fecha) || {};
  const merged = { estado: null, dm_hora: null, extra_hasta: null, pregunta_hora: null, ...cur, ...fields };
  db.prepare(`INSERT INTO cierres (user_id, fecha, estado, dm_hora, extra_hasta, pregunta_hora)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, fecha) DO UPDATE SET estado = excluded.estado, dm_hora = excluded.dm_hora,
      extra_hasta = excluded.extra_hasta, pregunta_hora = excluded.pregunta_hora`)
    .run(userId, fecha, merged.estado, merged.dm_hora, merged.extra_hasta, merged.pregunta_hora);
};

/** Suma un bloque de 30 min de horas extra */
const addBloqueExtra = (userId, fecha, aprobadoPor) => {
  db.prepare(`INSERT INTO extras (user_id, fecha, aprobado_por, bloques) VALUES (?, ?, ?, 1)
    ON CONFLICT(user_id, fecha) DO UPDATE SET bloques = bloques + 1`).run(userId, fecha, aprobadoPor);
};

const getExtrasRange = (from, to) => db.prepare(`
  SELECT e.*, u.nombre FROM extras e JOIN users u ON u.slack_id = e.user_id
  WHERE e.fecha BETWEEN ? AND ? ORDER BY e.fecha, u.nombre`).all(from, to);

// ═══════════════════════════════════════════════════════════════════
// PRESENCIA
// ═══════════════════════════════════════════════════════════════════
const logPresencia = (userId, fecha, hora, status) =>
  db.prepare('INSERT INTO presencia (user_id, fecha, hora, status) VALUES (?, ?, ?, ?)').run(userId, fecha, hora, status);

const presenciaSummary = (from, to) => db.prepare(`
  SELECT p.user_id, u.nombre, COUNT(*) as checks,
    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as activos,
    ROUND(100.0 * SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) / COUNT(*), 1) as pct
  FROM presencia p JOIN users u ON u.slack_id = p.user_id
  WHERE p.fecha BETWEEN ? AND ? GROUP BY p.user_id ORDER BY u.nombre`).all(from, to);

// ═══════════════════════════════════════════════════════════════════
// PINGS DIRIGIDOS
// ═══════════════════════════════════════════════════════════════════
const addPingModo = (userId, desde, hasta, por) =>
  db.prepare('INSERT INTO ping_modo (user_id, desde, hasta, activado_por) VALUES (?, ?, ?, ?)').run(userId, desde, hasta, por);

const getPingModoActivo = (userId, fecha) =>
  db.prepare('SELECT * FROM ping_modo WHERE user_id = ? AND desde <= ? AND hasta >= ?').get(userId, fecha, fecha);

const getPingModosEnRango = (from, to) => db.prepare(
  'SELECT 1 FROM ping_modo WHERE desde <= ? AND hasta >= ? LIMIT 1').get(to, from) != null;

const createPing = (userId, fecha, enviado) => {
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO pings (id, user_id, fecha, enviado) VALUES (?, ?, ?, ?)').run(id, userId, fecha, enviado);
  return id;
};

const respondPing = (pingId) => {
  const ping = db.prepare('SELECT * FROM pings WHERE id = ?').get(pingId);
  if (!ping || ping.respondido !== null) return null;
  const seg = Math.max(0, t.now().diff(t.dayjs.tz(`${ping.fecha} ${ping.enviado}`, t.TZ), 'second'));
  db.prepare('UPDATE pings SET respondido = 1, tiempo_respuesta = ? WHERE id = ?').run(seg, pingId);
  return seg;
};

const expirarPings = (fecha, cutoffHHMMSS) =>
  db.prepare('UPDATE pings SET respondido = 0 WHERE respondido IS NULL AND fecha = ? AND enviado < ?').run(fecha, cutoffHHMMSS);

const pingsHoyCount = (userId, fecha) =>
  db.prepare('SELECT COUNT(*) c FROM pings WHERE user_id = ? AND fecha = ?').get(userId, fecha)?.c || 0;

const pingSummary = (from, to) => db.prepare(`
  SELECT p.user_id, u.nombre, COUNT(*) as enviados,
    SUM(CASE WHEN respondido = 1 THEN 1 ELSE 0 END) as ok,
    SUM(CASE WHEN respondido = 0 THEN 1 ELSE 0 END) as perdidos,
    ROUND(AVG(tiempo_respuesta)) as prom_seg
  FROM pings p JOIN users u ON u.slack_id = p.user_id
  WHERE p.fecha BETWEEN ? AND ? GROUP BY p.user_id ORDER BY u.nombre`).all(from, to);

// ═══════════════════════════════════════════════════════════════════
// INTENTOS MOBILE / AVISOS
// ═══════════════════════════════════════════════════════════════════
const logIntentoMobile = (userId, fecha, hora, ua) =>
  db.prepare('INSERT INTO intentos_mobile (user_id, fecha, hora, user_agent) VALUES (?, ?, ?, ?)')
    .run(userId, fecha, hora, (ua || '').slice(0, 300));

const getIntentosMobile = (from, to) => db.prepare(`
  SELECT i.*, u.nombre FROM intentos_mobile i LEFT JOIN users u ON u.slack_id = i.user_id
  WHERE i.fecha BETWEEN ? AND ? ORDER BY i.fecha, i.hora`).all(from, to);

const avisoEnviado = (userId, fecha, tipo) =>
  db.prepare('SELECT 1 FROM avisos WHERE user_id = ? AND fecha = ? AND tipo = ?').get(userId, fecha, tipo) != null;

const marcarAviso = (userId, fecha, tipo) =>
  db.prepare('INSERT OR IGNORE INTO avisos (user_id, fecha, tipo) VALUES (?, ?, ?)').run(userId, fecha, tipo);

// ═══════════════════════════════════════════════════════════════════
// REPORTES
// ═══════════════════════════════════════════════════════════════════

/** Tracked sin entrada hoy y sin novedad que lo justifique */
const faltantes = (fecha) => db.prepare(`
  SELECT u.* FROM users u WHERE u.trackeado = 1
    AND u.slack_id NOT IN (SELECT user_id FROM registros WHERE fecha = ? AND tipo = 'entrada')
    AND u.slack_id NOT IN (SELECT user_id FROM novedades WHERE fecha = ? AND user_id IS NOT NULL
                           AND tipo IN (${NOVEDADES_EXENTAS.map(() => '?').join(',')}))
  ORDER BY u.nombre`).all(fecha, fecha, ...NOVEDADES_EXENTAS);

/** Resumen agregado por persona para un rango (reporte semanal/mensual) */
const resumenPersonas = (from, to) => {
  const users = getTracked();
  const dias = getDias(from, to);
  const extras = getExtrasRange(from, to);
  return users.map(u => {
    const propios = dias.filter(d => d.user_id === u.slack_id);
    const horas = Math.round(propios.reduce((s, d) => s + (d.horas || 0), 0) * 100) / 100;
    const esperadas = Math.round(diasEsperados(u.slack_id, from, to) * u.carga_horaria * 100) / 100;
    const tardes = propios.filter(d => d.tarde_min > 0).length;
    const autoCierres = propios.filter(d => d.auto_closed).length;
    const bloquesExtra = extras.filter(e => e.user_id === u.slack_id).reduce((s, e) => s + e.bloques, 0);
    return { ...u, horas, esperadas, tardes, autoCierres, extraHs: bloquesExtra * 0.5, diasTrabajados: propios.filter(d => d.entrada).length };
  });
};

module.exports = {
  db, TIPOS_ORDEN, NOVEDADES_EXENTAS,
  upsertUser, getUser, getAllUsers, getTracked, setTracked, setAdmin, setHorario, isAdmin, isSuperAdmin,
  getDia, nextTipo, horasDia, registrar, imputarAlmuerzo, corregirSalida, getDias,
  addNovedad, getNovedadesFecha, getNovedadesRange, isFeriado, hasNovedad, isExento, diasEsperados,
  createToken, peekToken, consumeToken,
  getCierre, setCierre, addBloqueExtra, getExtrasRange,
  logPresencia, presenciaSummary,
  addPingModo, getPingModoActivo, getPingModosEnRango, createPing, respondPing, expirarPings, pingsHoyCount, pingSummary,
  logIntentoMobile, getIntentosMobile, avisoEnviado, marcarAviso,
  faltantes, resumenPersonas,
};
