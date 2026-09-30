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

// ─── Migración desde la app vieja ──────────────────────────────────
// Si el volumen trae la DB del sistema anterior (users sin columna
// "nombre"), se recrea todo de cero: quedó definido que no hay datos
// para migrar.
const esquemaViejo = (() => {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  return cols.length > 0 && !cols.some(c => c.name === 'nombre');
})();
if (esquemaViejo) {
  console.log('[db] ⚠️ Schema viejo detectado — recreando la base desde cero (sin datos que migrar)');
  // Las tablas viejas tienen FKs entre sí: hay que apagarlas para poder dropear
  db.pragma('foreign_keys = OFF');
  const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const t of tablas) db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
  db.pragma('foreign_keys = ON');
}

// Migración: se eliminó el flujo de horas extra (tablas extras y cierres viejas)
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extras'").get()) {
  db.exec('DROP TABLE extras');
  db.exec('DROP TABLE IF EXISTS cierres');
  console.log('[db] Flujo de horas extra eliminado — tablas extras/cierres recreadas');
}

// Migración: imputaciones gana la dimensión "categoría" (cambia el UNIQUE,
// hay que recrear la tabla — el schema de abajo crea la versión nueva)
let migrarImputaciones = false;
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='imputaciones'").get()) {
  const colsImp = db.prepare('PRAGMA table_info(imputaciones)').all();
  if (!colsImp.some(c => c.name === 'categoria')) {
    db.exec('ALTER TABLE imputaciones RENAME TO imputaciones_old');
    migrarImputaciones = true;
  }
}

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
    estado        TEXT NOT NULL,   -- esperando | cerrado
    dm_hora       TEXT,            -- cuándo se mandó el DM de cierre
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

  -- Time tracking interno: catálogo de proyectos + horas imputadas por día
  CREATE TABLE IF NOT EXISTS proyectos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre     TEXT NOT NULL UNIQUE,
    activo     INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS imputaciones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    fecha       TEXT NOT NULL,
    proyecto_id INTEGER NOT NULL,
    horas       REAL NOT NULL,
    categoria   TEXT,               -- campaña | redes | website | branding | btl | otro
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, fecha, proyecto_id, categoria),
    FOREIGN KEY (proyecto_id) REFERENCES proyectos(id)
  );

  CREATE INDEX IF NOT EXISTS idx_imputaciones_fecha ON imputaciones(fecha);
  CREATE INDEX IF NOT EXISTS idx_imputaciones_user ON imputaciones(user_id, fecha);
  CREATE INDEX IF NOT EXISTS idx_registros_fecha ON registros(fecha);
  CREATE INDEX IF NOT EXISTS idx_registros_user ON registros(user_id, fecha);
  CREATE INDEX IF NOT EXISTS idx_novedades_fecha ON novedades(fecha);
  CREATE INDEX IF NOT EXISTS idx_presencia ON presencia(user_id, fecha);
  CREATE INDEX IF NOT EXISTS idx_pings_fecha ON pings(fecha);
`);

// Completa la migración de imputaciones (la tabla nueva ya existe)
if (migrarImputaciones) {
  db.exec(`INSERT INTO imputaciones (id, user_id, fecha, proyecto_id, horas, created_at)
           SELECT id, user_id, fecha, proyecto_id, horas, created_at FROM imputaciones_old`);
  db.exec('DROP TABLE imputaciones_old');
  console.log('[db] Imputaciones migradas — nueva dimensión: categoría de trabajo');
}

// Migración: columna equipo para agrupar reportes por área
try { db.exec('ALTER TABLE users ADD COLUMN equipo TEXT'); } catch (_) { /* ya existe */ }
// Migración: cliente del proyecto (rollup de horas por cliente)
try { db.exec('ALTER TABLE proyectos ADD COLUMN cliente TEXT'); } catch (_) { /* ya existe */ }
// Migración: modo de tracking — completo | solo_proyectos (sin asistencia)
try { db.exec("ALTER TABLE users ADD COLUMN modo TEXT DEFAULT 'completo'"); } catch (_) { /* ya existe */ }
// Migración: tipo de token — marcar | imputar (links web distintos, no intercambiables)
try { db.exec("ALTER TABLE tokens ADD COLUMN tipo TEXT DEFAULT 'marcar'"); } catch (_) { /* ya existe */ }
// Migración: días de vacaciones anuales por persona (corridos; default 21 = 14 verano + 7 invierno)
try { db.exec('ALTER TABLE users ADD COLUMN vacaciones_anuales REAL DEFAULT 21'); } catch (_) { /* ya existe */ }
// Migración: ausencias justificadas o no (NULL = no aplica)
try { db.exec('ALTER TABLE novedades ADD COLUMN justificada INTEGER'); } catch (_) { /* ya existe */ }
// Migración: cierre con "¿terminaste?" — hora de la última pregunta y de la última respuesta "sigo"
try { db.exec('ALTER TABLE cierres ADD COLUMN pregunta_hora TEXT'); } catch (_) { /* ya existe */ }
try { db.exec('ALTER TABLE cierres ADD COLUMN ultima_respuesta TEXT'); } catch (_) { /* ya existe */ }
// Migración: la presencia se registra también fuera de horario — en_horario
// separa los checks que cuentan para el % de presencia (los viejos eran todos en horario)
try { db.exec('ALTER TABLE presencia ADD COLUMN en_horario INTEGER DEFAULT 1'); } catch (_) { /* ya existe */ }
db.exec(`
  -- Actividad real en Slack (solo la hora, nunca el contenido): mensajes y
  -- reacciones en canales donde está el bot. Los DMs con el bot no cuentan.
  CREATE TABLE IF NOT EXISTS actividad (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  TEXT NOT NULL,
    fecha    TEXT NOT NULL,
    hora     TEXT NOT NULL,   -- HH:MM
    tipo     TEXT NOT NULL    -- mensaje | reaccion
  );
  CREATE INDEX IF NOT EXISTS idx_actividad ON actividad(user_id, fecha);

  -- Reclamos sobre un cierre automático ("estaba en una reunión"): los aprueba un admin
  CREATE TABLE IF NOT EXISTS reclamos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    fecha        TEXT NOT NULL,
    hora_pedida  TEXT NOT NULL,
    motivo       TEXT,
    estado       TEXT DEFAULT 'pendiente',   -- pendiente | aprobado | rechazado
    resuelto_por TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
`);
// Migración de datos: la tolerancia de 10 minutos aplica también a los
// registros históricos (idempotente — corre en cada arranque sin efecto)
db.exec('UPDATE registros SET tarde_min = 0 WHERE tarde_min > 0 AND tarde_min <= 10');
db.exec('UPDATE registros SET anticipado_min = 0 WHERE anticipado_min > 0 AND anticipado_min <= 10');

const TIPOS_ORDEN = ['entrada', 'almuerzo_inicio', 'almuerzo_fin', 'salida'];
const NOVEDADES_EXENTAS = ['feriado', 'vacaciones', 'medico', 'ausente', 'libre', 'licencia'];

// Los viernes todos salen a las 17:30 (quien sale antes mantiene su horario)
// y se esperan menos horas en proporción.
const SALIDA_VIERNES = '17:30';

/** Horario efectivo de una persona en una fecha (aplica el viernes corto) */
const horarioDia = (user, fecha) => {
  if (!user || t.dayjs(fecha).day() !== 5) return user;
  const menos = t.toMin(user.hora_salida) - t.toMin(SALIDA_VIERNES);
  if (menos <= 0) return user;
  return { ...user, hora_salida: SALIDA_VIERNES, carga_horaria: Math.max(0, Math.round((user.carga_horaria - menos / 60) * 100) / 100) };
};

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
const setEquipo = (id, equipo) => db.prepare('UPDATE users SET equipo = ? WHERE slack_id = ?').run(equipo, id);
const setModo = (id, modo) => db.prepare('UPDATE users SET modo = ? WHERE slack_id = ?').run(modo, id);
const esSoloProyectos = (u) => u?.modo === 'solo_proyectos';

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
// Tolerancia: 10' de gracia sobre el horario personal (9:30 → tarde recién
// después de 9:40; 18:30 → salida ok desde 18:20). Dentro de la tolerancia
// no se marca nada.
const TOLERANCIA_MIN = 10;

const registrar = (user, fecha, tipo, hora, origen, extra = {}) => {
  user = horarioDia(user, fecha);
  let tarde = 0, anticipado = 0;
  if (tipo === 'entrada') {
    tarde = Math.max(0, t.toMin(hora) - t.toMin(user.hora_entrada));
    if (tarde <= TOLERANCIA_MIN) tarde = 0;
  }
  if (tipo === 'salida' && !hasNovedad(user.slack_id, fecha, 'salida')) {
    anticipado = Math.max(0, t.toMin(user.hora_salida) - t.toMin(hora));
    if (anticipado <= TOLERANCIA_MIN) anticipado = 0;
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
const addNovedad = (userId, tipo, fecha, motivo, creadoPor, justificada = null) =>
  db.prepare('INSERT INTO novedades (user_id, tipo, fecha, motivo, creado_por, justificada) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, tipo, fecha, motivo || null, creadoPor, justificada);

const borrarNovedad = (id) => db.prepare('DELETE FROM novedades WHERE id = ?').run(id);

/**
 * Carga una novedad para un rango de días arrancando en `desde`.
 * Vacaciones se cuentan CORRIDAS (incluyen findes); el resto, por día hábil.
 * Dedupe por (user, fecha, tipo). Devuelve las fechas cargadas.
 */
const cargarNovedadRango = (userId, tipo, desde, dias, { motivo, creadoPor, justificada = null } = {}) => {
  // Vacaciones y licencias (maternidad, sin goce) se cuentan corridas
  const corridos = tipo === 'vacaciones' || tipo === 'licencia';
  const fechas = [];
  let d = t.dayjs(desde);
  while (fechas.length < dias) {
    const ds = d.format('YYYY-MM-DD');
    if (corridos || t.isWeekday(ds)) {
      if (!hasNovedad(userId, ds, tipo)) addNovedad(userId, tipo, ds, motivo, creadoPor, justificada);
      fechas.push(ds);
    }
    d = d.add(1, 'day');
  }
  return fechas;
};

const setVacacionesAnuales = (id, dias) =>
  db.prepare('UPDATE users SET vacaciones_anuales = ? WHERE slack_id = ?').run(dias, id);

/** Fechas de vacaciones de una persona en un año (corridas, como se cargan) */
const vacacionesFechas = (userId, anio) => db.prepare(
  "SELECT fecha FROM novedades WHERE user_id = ? AND tipo = 'vacaciones' AND fecha LIKE ? ORDER BY fecha")
  .all(userId, `${anio}-%`).map(r => r.fecha);

/** Agrupa fechas ISO consecutivas en rangos [{desde, hasta, dias}] */
const agruparRangos = (fechas) => {
  const rangos = [];
  for (const f of fechas) {
    const ult = rangos[rangos.length - 1];
    if (ult && t.dayjs(f).diff(t.dayjs(ult.hasta), 'day') === 1) { ult.hasta = f; ult.dias++; }
    else rangos.push({ desde: f, hasta: f, dias: 1 });
  }
  return rangos;
};

/** Panorama de vacaciones por persona trackeada: saldo del año + rangos */
const vacacionesResumen = () => {
  const anio = t.today().slice(0, 4);
  const hoy = t.today();
  // Todos los usuarios (no solo trackeados): la gente dada de alta en modo
  // silencioso también tiene vacaciones registradas antes del lanzamiento
  return getAllUsers().map(u => {
    const fechas = vacacionesFechas(u.slack_id, anio);
    const rangos = agruparRangos(fechas);
    const usadas = fechas.filter(f => f <= hoy).length;
    const proximas = rangos.filter(r => r.hasta >= hoy);
    return {
      slack_id: u.slack_id, nombre: u.nombre, equipo: u.equipo,
      anuales: u.vacaciones_anuales ?? 21,
      cargadas: fechas.length, usadas,
      quedan: Math.round(((u.vacaciones_anuales ?? 21) - fechas.length) * 10) / 10,
      proximas, enCurso: fechas.includes(hoy),
    };
  });
};

/** Novedades desde una fecha, agrupadas en rangos por persona+tipo (para gestión web) */
const novedadesRangosAdmin = (desde) => {
  const rows = db.prepare(`
    SELECT n.*, u.nombre FROM novedades n LEFT JOIN users u ON u.slack_id = n.user_id
    WHERE n.fecha >= ? AND n.user_id IS NOT NULL ORDER BY n.user_id, n.tipo, n.fecha`).all(desde);
  const grupos = [];
  for (const r of rows) {
    const ult = grupos[grupos.length - 1];
    if (ult && ult.user_id === r.user_id && ult.tipo === r.tipo
        && t.dayjs(r.fecha).diff(t.dayjs(ult.hasta), 'day') === 1) {
      ult.hasta = r.fecha; ult.dias++; ult.ids.push(r.id);
    } else {
      grupos.push({ user_id: r.user_id, nombre: r.nombre, tipo: r.tipo, motivo: r.motivo,
        justificada: r.justificada, desde: r.fecha, hasta: r.fecha, dias: 1, ids: [r.id] });
    }
  }
  return grupos.sort((a, b) => a.desde < b.desde ? -1 : 1);
};

const getNovedadesFecha = (fecha) => db.prepare(`
  SELECT n.*, u.nombre FROM novedades n LEFT JOIN users u ON u.slack_id = n.user_id
  WHERE n.fecha = ? ORDER BY n.tipo, u.nombre`).all(fecha);

const getNovedadesRange = (from, to) => db.prepare(`
  SELECT n.*, u.nombre FROM novedades n LEFT JOIN users u ON u.slack_id = n.user_id
  WHERE n.fecha BETWEEN ? AND ? ORDER BY n.fecha, n.tipo`).all(from, to);

const isFeriado = (fecha) =>
  db.prepare("SELECT 1 FROM novedades WHERE fecha = ? AND tipo = 'feriado' AND user_id IS NULL").get(fecha) != null;

const getFeriados = (desde) => db.prepare(
  "SELECT fecha, motivo FROM novedades WHERE tipo = 'feriado' AND user_id IS NULL AND fecha >= ? ORDER BY fecha").all(desde);

const hasNovedad = (userId, fecha, tipo) =>
  db.prepare('SELECT 1 FROM novedades WHERE fecha = ? AND tipo = ? AND user_id = ?').get(fecha, tipo, userId) != null;

/** ¿La persona está exenta de trabajar ese día? (feriado global o novedad personal) */
const isExento = (userId, fecha) => db.prepare(`
  SELECT 1 FROM novedades WHERE fecha = ?
    AND ((user_id IS NULL AND tipo = 'feriado') OR (user_id = ? AND tipo IN (${NOVEDADES_EXENTAS.map(() => '?').join(',')})))
  `).get(fecha, userId, ...NOVEDADES_EXENTAS) != null;

// ─── Evaluación de asistencia ───────────────────────────────────────
// Día OK = completo, sin tarde (>10' de tolerancia), sin salida anticipada
// (>10') y con almuerzo de hasta 1 hora (+10'). Solo días ya terminados.
const ALMUERZO_MAX_MIN = 60 + TOLERANCIA_MIN;

const evaluacionUsuario = (user, from, to) => {
  const r = {
    esperados: 0, presentes: 0, ok: 0, tardes: 0, anticipadas: 0, almuerzosLargos: 0,
    autoCierres: 0, ausJust: 0, ausInjust: 0, sinAviso: 0, exentos: 0,
    horas: 0, horasEsperadas: 0,
  };
  const hoy = t.today();
  let d = t.dayjs(from);
  const end = t.dayjs(to);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    const ds = d.format('YYYY-MM-DD');
    d = d.add(1, 'day');
    if (!t.isWeekday(ds) || ds >= hoy) continue; // solo días hábiles ya cerrados
    if (isExento(user.slack_id, ds)) {
      r.exentos++;
      const aus = db.prepare("SELECT justificada FROM novedades WHERE user_id = ? AND fecha = ? AND tipo = 'ausente'").get(user.slack_id, ds);
      if (aus) (aus.justificada === 0 ? r.ausInjust++ : r.ausJust++);
      continue;
    }
    r.esperados++;
    r.horasEsperadas += horarioDia(user, ds).carga_horaria;
    const dia = getDia(user.slack_id, ds);
    if (!dia.entrada) { r.sinAviso++; continue; }
    r.presentes++;
    const h = horasDia(dia);
    if (h != null) r.horas += h;
    const tarde = (dia.entrada.tarde_min || 0) > TOLERANCIA_MIN;
    const anticipada = (dia.salida?.anticipado_min || 0) > TOLERANCIA_MIN;
    const almuerzoMin = dia.almuerzo_inicio && dia.almuerzo_fin
      ? t.toMin(dia.almuerzo_fin.hora) - t.toMin(dia.almuerzo_inicio.hora) : null;
    const almLargo = almuerzoMin != null && almuerzoMin > ALMUERZO_MAX_MIN;
    const auto = dia.salida?.auto_closed === 1 && !dia.salida.corregido;
    if (tarde) r.tardes++;
    if (anticipada) r.anticipadas++;
    if (almLargo) r.almuerzosLargos++;
    if (auto) r.autoCierres++;
    if (dia.salida && !tarde && !anticipada && !almLargo) r.ok++;
  }
  r.horas = Math.round(r.horas * 10) / 10;
  r.horasEsperadas = Math.round(r.horasEsperadas * 10) / 10;
  r.pct = r.esperados ? Math.round((r.ok / r.esperados) * 100) : null;
  r.semaforo = r.pct == null ? '—' : r.pct >= 85 ? '🟢' : r.pct >= 65 ? '🟡' : '🔴';
  return r;
};

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

/** Horas esperadas de una persona en un rango (días esperados × carga de cada día, viernes corto incluido) */
const horasEsperadas = (user, from, to) => {
  let total = 0;
  let d = t.dayjs(from);
  const end = t.dayjs(to);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    const ds = d.format('YYYY-MM-DD');
    if (t.isWeekday(ds) && !isExento(user.slack_id, ds)) total += horarioDia(user, ds).carga_horaria;
    d = d.add(1, 'day');
  }
  return Math.round(total * 100) / 100;
};

// ═══════════════════════════════════════════════════════════════════
// TOKENS (persistidos — sobreviven redeploys)
// ═══════════════════════════════════════════════════════════════════
const TOKEN_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_LARGO_MS = 30 * 60 * 1000; // formularios/vistas web llevan más tiempo

const createToken = (userId, tipo = 'marcar') => {
  db.prepare('DELETE FROM tokens WHERE expira < ?').run(Date.now());
  const token = crypto.randomBytes(24).toString('hex');
  const ttl = tipo === 'marcar' ? TOKEN_TTL_MS : TOKEN_TTL_LARGO_MS;
  db.prepare('INSERT INTO tokens (token, user_id, tipo, expira) VALUES (?, ?, ?, ?)').run(token, userId, tipo, Date.now() + ttl);
  return token;
};

/** Mira el token sin consumirlo. Devuelve user_id o null. */
const peekToken = (token, tipo = 'marcar') => {
  const row = db.prepare('SELECT * FROM tokens WHERE token = ?').get(token);
  if (!row || row.usado || row.expira < Date.now()) return null;
  if ((row.tipo || 'marcar') !== tipo) return null;
  return row.user_id;
};

/** Consume el token (un solo uso). Devuelve user_id o null. */
const consumeToken = (token, tipo = 'marcar') => {
  const userId = peekToken(token, tipo);
  if (userId) db.prepare('UPDATE tokens SET usado = 1 WHERE token = ?').run(token);
  return userId;
};

// ═══════════════════════════════════════════════════════════════════
// CIERRES
// ═══════════════════════════════════════════════════════════════════
const getCierre = (userId, fecha) =>
  db.prepare('SELECT * FROM cierres WHERE user_id = ? AND fecha = ?').get(userId, fecha);

const setCierre = (userId, fecha, fields) => {
  const cur = getCierre(userId, fecha) || {};
  const m = { estado: null, dm_hora: null, pregunta_hora: null, ultima_respuesta: null, ...cur, ...fields };
  db.prepare(`INSERT INTO cierres (user_id, fecha, estado, dm_hora, pregunta_hora, ultima_respuesta) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, fecha) DO UPDATE SET estado = excluded.estado, dm_hora = excluded.dm_hora,
      pregunta_hora = excluded.pregunta_hora, ultima_respuesta = excluded.ultima_respuesta`)
    .run(userId, fecha, m.estado, m.dm_hora, m.pregunta_hora, m.ultima_respuesta);
};

// ═══════════════════════════════════════════════════════════════════
// PRESENCIA
// ═══════════════════════════════════════════════════════════════════
const logPresencia = (userId, fecha, hora, status, enHorario = true) =>
  db.prepare('INSERT INTO presencia (user_id, fecha, hora, status, en_horario) VALUES (?, ?, ?, ?, ?)')
    .run(userId, fecha, hora, status, enHorario ? 1 : 0);

const logActividad = (userId, fecha, hora, tipo) =>
  db.prepare('INSERT INTO actividad (user_id, fecha, hora, tipo) VALUES (?, ?, ?, ?)').run(userId, fecha, hora, tipo);

/**
 * Última actividad en SLACK del día (no con el bot): último check de
 * presencia "active" o último mensaje/reacción en canales, lo más tarde,
 * hasta la hora `hasta` inclusive. Las marcaciones y los botones del bot
 * no cuentan. Devuelve null si no hay ninguna señal ese día.
 */
const ultimaActividadSlack = (userId, fecha, hasta = '23:59') => {
  const pres = db.prepare("SELECT MAX(hora) h FROM presencia WHERE user_id = ? AND fecha = ? AND status = 'active' AND hora <= ?").get(userId, fecha, hasta)?.h;
  const act = db.prepare('SELECT MAX(hora) h FROM actividad WHERE user_id = ? AND fecha = ? AND hora <= ?').get(userId, fecha, hasta)?.h;
  const c = [pres, act].filter(Boolean).sort();
  return c.length ? c.pop() : null; // HH:MM ordena lexicográfico
};

/**
 * A qué hora se auto-cierra un día: la última actividad en Slack sin pasar
 * de la última pregunta sin respuesta (tope); si dijo "sigo trabajando",
 * su última respuesta es el piso. Sin ninguna señal, su horario de salida.
 * Nunca antes de la entrada. `user` ya viene con el horario del día.
 */
const horaAutoCierre = (user, fecha, cierre) => {
  const tope = cierre.pregunta_hora || cierre.dm_hora || user.hora_salida;
  const piso = cierre.ultima_respuesta || null;
  const actividad = ultimaActividadSlack(user.slack_id, fecha, tope);
  let hora, motivo;
  if (actividad && (!piso || actividad > piso)) { hora = actividad; motivo = 'actividad'; }
  else if (piso) { hora = piso; motivo = 'respuesta'; }
  else { hora = user.hora_salida; motivo = 'sin_datos'; }
  const entrada = getDia(user.slack_id, fecha).entrada?.hora;
  if (entrada && hora < entrada) { hora = entrada; motivo = 'actividad'; }
  return { hora, motivo };
};

/** Actividad Slack de un día: primera/última señal y tramos activos */
const actividadDia = (userId, fecha) => {
  const pres = db.prepare('SELECT hora, status FROM presencia WHERE user_id = ? AND fecha = ? ORDER BY hora').all(userId, fecha);
  const acts = db.prepare('SELECT hora, tipo FROM actividad WHERE user_id = ? AND fecha = ? ORDER BY hora').all(userId, fecha);
  const activos = [...pres.filter(p => p.status === 'active').map(p => p.hora), ...acts.map(a => a.hora)].sort();
  // Señales separadas por ≤ 15' se unen en un mismo tramo
  const tramos = [];
  for (const h of activos) {
    const last = tramos[tramos.length - 1];
    if (last && t.toMin(h) - t.toMin(last.hasta) <= 15) last.hasta = h;
    else tramos.push({ desde: h, hasta: h });
  }
  return {
    primera: activos[0] || null, ultima: activos[activos.length - 1] || null, tramos,
    checks: pres.length, mensajes: acts.filter(a => a.tipo === 'mensaje').length, reacciones: acts.filter(a => a.tipo === 'reaccion').length,
  };
};

const presenciaSummary = (from, to) => db.prepare(`
  SELECT p.user_id, u.nombre, COUNT(*) as checks,
    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as activos,
    ROUND(100.0 * SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) / COUNT(*), 1) as pct
  FROM presencia p JOIN users u ON u.slack_id = p.user_id
  WHERE p.fecha BETWEEN ? AND ? AND p.en_horario = 1 GROUP BY p.user_id ORDER BY u.nombre`).all(from, to);

/** % de presencia activa por día de una persona (para detección de patrones) */
const presenciaPorDia = (userId, from, to) => db.prepare(`
  SELECT fecha, COUNT(*) as checks,
    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as activos,
    ROUND(100.0 * SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) / COUNT(*), 1) as pct
  FROM presencia WHERE user_id = ? AND fecha BETWEEN ? AND ? AND en_horario = 1 GROUP BY fecha ORDER BY fecha`).all(userId, from, to);

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
  WHERE p.fecha BETWEEN ? AND ? AND p.en_horario = 1 GROUP BY p.user_id ORDER BY u.nombre`).all(from, to);

// ═══════════════════════════════════════════════════════════════════
// PROYECTOS E IMPUTACIONES (time tracking interno)
// ═══════════════════════════════════════════════════════════════════
const crearProyecto = (nombre, cliente = null) => {
  const existente = db.prepare('SELECT * FROM proyectos WHERE nombre = ? COLLATE NOCASE').get(nombre);
  if (existente) {
    // Re-agregar actualiza el cliente (permite asignar cliente a un proyecto viejo)
    db.prepare('UPDATE proyectos SET activo = 1, cliente = COALESCE(?, cliente) WHERE id = ?').run(cliente, existente.id);
    return { estado: existente.activo ? 'ya_existe' : 'reactivado', proyecto: db.prepare('SELECT * FROM proyectos WHERE id = ?').get(existente.id) };
  }
  const r = db.prepare('INSERT INTO proyectos (nombre, cliente) VALUES (?, ?)').run(nombre, cliente);
  return { estado: 'creado', proyecto: db.prepare('SELECT * FROM proyectos WHERE id = ?').get(r.lastInsertRowid) };
};

const archivarProyecto = (id) => db.prepare('UPDATE proyectos SET activo = 0 WHERE id = ?').run(id);
const reactivarProyecto = (id) => db.prepare('UPDATE proyectos SET activo = 1 WHERE id = ?').run(id);

/** Edita nombre/cliente conservando las horas (falla si el nombre nuevo ya existe) */
const editarProyecto = (id, nombre, cliente) => {
  try {
    db.prepare('UPDATE proyectos SET nombre = ?, cliente = ? WHERE id = ?').run(nombre, cliente || null, id);
    return true;
  } catch (_) { return false; } // UNIQUE(nombre) violado
};
const getProyectos = (soloActivos = true) =>
  db.prepare(`SELECT * FROM proyectos ${soloActivos ? 'WHERE activo = 1' : ''} ORDER BY nombre`).all();

/** Reemplaza las imputaciones del día de una persona (permite corregir) */
const setImputaciones = db.transaction((userId, fecha, pares) => {
  const habia = db.prepare('SELECT COUNT(*) c FROM imputaciones WHERE user_id = ? AND fecha = ?').get(userId, fecha).c > 0;
  db.prepare('DELETE FROM imputaciones WHERE user_id = ? AND fecha = ?').run(userId, fecha);
  for (const p of pares) {
    db.prepare('INSERT INTO imputaciones (user_id, fecha, proyecto_id, horas, categoria) VALUES (?, ?, ?, ?, ?)')
      .run(userId, fecha, p.proyecto_id, p.horas, p.categoria || null);
  }
  return habia;
});

const getImputacionesDia = (userId, fecha) => db.prepare(`
  SELECT i.*, p.nombre FROM imputaciones i JOIN proyectos p ON p.id = i.proyecto_id
  WHERE i.user_id = ? AND i.fecha = ? ORDER BY i.horas DESC`).all(userId, fecha);

const hayImputaciones = (userId, fecha) =>
  db.prepare('SELECT 1 FROM imputaciones WHERE user_id = ? AND fecha = ? LIMIT 1').get(userId, fecha) != null;

/** Totales por proyecto en un rango */
const horasPorProyecto = (from, to) => db.prepare(`
  SELECT p.nombre, p.cliente, ROUND(SUM(i.horas), 1) as horas, COUNT(DISTINCT i.user_id) as personas
  FROM imputaciones i JOIN proyectos p ON p.id = i.proyecto_id
  WHERE i.fecha BETWEEN ? AND ? GROUP BY p.id ORDER BY horas DESC`).all(from, to);

/** Rollup por cliente en un rango (proyectos sin cliente → "Sin cliente") */
const horasPorCliente = (from, to) => db.prepare(`
  SELECT COALESCE(p.cliente, 'Sin cliente') as cliente, ROUND(SUM(i.horas), 1) as horas,
    COUNT(DISTINCT p.id) as proyectos, COUNT(DISTINCT i.user_id) as personas
  FROM imputaciones i JOIN proyectos p ON p.id = i.proyecto_id
  WHERE i.fecha BETWEEN ? AND ? GROUP BY COALESCE(p.cliente, 'Sin cliente') ORDER BY horas DESC`).all(from, to);

/** Detalle proyecto × persona en un rango */
const horasProyectoPersona = (from, to) => db.prepare(`
  SELECT p.nombre as proyecto, u.nombre as persona, ROUND(SUM(i.horas), 1) as horas
  FROM imputaciones i
  JOIN proyectos p ON p.id = i.proyecto_id
  JOIN users u ON u.slack_id = i.user_id
  WHERE i.fecha BETWEEN ? AND ? GROUP BY p.id, i.user_id ORDER BY p.nombre, horas DESC`).all(from, to);

/** Imputaciones de una persona en un rango, agrupadas por proyecto */
const horasUsuarioPorProyecto = (userId, from, to) => db.prepare(`
  SELECT p.nombre, p.cliente, ROUND(SUM(i.horas), 1) as horas
  FROM imputaciones i JOIN proyectos p ON p.id = i.proyecto_id
  WHERE i.user_id = ? AND i.fecha BETWEEN ? AND ? GROUP BY p.id ORDER BY horas DESC`).all(userId, from, to);

/** Detalle diario para el Excel */
/** Rollup por categoría de trabajo en un rango */
const horasPorCategoria = (from, to) => db.prepare(`
  SELECT COALESCE(categoria, 'sin categoría') as categoria, ROUND(SUM(horas), 1) as horas
  FROM imputaciones WHERE fecha BETWEEN ? AND ? GROUP BY COALESCE(categoria, 'sin categoría') ORDER BY horas DESC`).all(from, to);

const getImputacionesRange = (from, to) => db.prepare(`
  SELECT i.fecha, u.nombre as persona, p.cliente, p.nombre as proyecto, i.horas, i.categoria
  FROM imputaciones i
  JOIN proyectos p ON p.id = i.proyecto_id
  JOIN users u ON u.slack_id = i.user_id
  WHERE i.fecha BETWEEN ? AND ? ORDER BY i.fecha, u.nombre`).all(from, to);

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
// RECLAMOS DE AUTO-CIERRE
// ═══════════════════════════════════════════════════════════════════
const crearReclamo = (userId, fecha, horaPedida, motivo) =>
  db.prepare('INSERT INTO reclamos (user_id, fecha, hora_pedida, motivo) VALUES (?, ?, ?, ?)').run(userId, fecha, horaPedida, motivo).lastInsertRowid;
const getReclamo = (id) => db.prepare('SELECT * FROM reclamos WHERE id = ?').get(id);
const reclamoPendiente = (userId, fecha) =>
  db.prepare("SELECT * FROM reclamos WHERE user_id = ? AND fecha = ? AND estado = 'pendiente'").get(userId, fecha);
/** Pasa el reclamo a aprobado/rechazado; false si ya estaba resuelto (dos admins a la vez) */
const resolverReclamo = (id, estado, adminId) =>
  db.prepare("UPDATE reclamos SET estado = ?, resuelto_por = ? WHERE id = ? AND estado = 'pendiente'").run(estado, adminId, id).changes > 0;

/** Reclamo aprobado: la salida auto-cerrada pasa a la hora pedida (el original queda loggeado) */
const aplicarReclamo = (user, fecha, hora) => {
  const s = getDia(user.slack_id, fecha).salida;
  if (!s) return false;
  let anticipado = Math.max(0, t.toMin(horarioDia(user, fecha).hora_salida) - t.toMin(hora));
  if (anticipado <= TOLERANCIA_MIN) anticipado = 0;
  db.prepare(`UPDATE registros SET valor_original = COALESCE(valor_original, hora), hora = ?, corregido = 1,
    anticipado_min = ?, nota = 'reclamo_aprobado' WHERE id = ?`).run(hora, anticipado, s.id);
  return true;
};

// ═══════════════════════════════════════════════════════════════════
// MARCAS (clientes) — imputación simplificada por %
// ═══════════════════════════════════════════════════════════════════

/** Marcas = clientes del catálogo; un proyecto sin cliente es su propia marca (Interno, Pitch) */
const getMarcas = () => {
  const marcas = {};
  for (const p of getProyectos(true)) (marcas[p.cliente || p.nombre] ||= []).push(p);
  return Object.keys(marcas).sort((a, b) => a.localeCompare(b, 'es')).map(nombre => ({ nombre, proyectos: marcas[nombre] }));
};

/**
 * Proyecto donde se imputan las horas de una marca: si tiene un solo
 * proyecto activo, ese; si tiene varios, uno "general" con el nombre del
 * cliente (se crea la primera vez). Los reportes por cliente no cambian.
 */
const proyectoDeMarca = (marca) => {
  const m = getMarcas().find(x => x.nombre === marca);
  if (!m) return null;
  if (m.proyectos.length === 1) return m.proyectos[0];
  return m.proyectos.find(p => p.nombre.toLowerCase() === marca.toLowerCase()) || crearProyecto(marca, marca).proyecto;
};

// ═══════════════════════════════════════════════════════════════════
// PRUEBAS — "admin probar reset": borra el día de una persona
// ═══════════════════════════════════════════════════════════════════
const resetDiaPrueba = db.transaction((userId, fecha) => {
  for (const tabla of ['registros', 'cierres', 'avisos', 'imputaciones', 'reclamos']) {
    db.prepare(`DELETE FROM ${tabla} WHERE user_id = ? AND fecha = ?`).run(userId, fecha);
  }
});

// ═══════════════════════════════════════════════════════════════════
// REPORTES
// ═══════════════════════════════════════════════════════════════════

/** Tracked sin entrada hoy y sin novedad que lo justifique (excluye modo solo_proyectos) */
const faltantes = (fecha) => db.prepare(`
  SELECT u.* FROM users u WHERE u.trackeado = 1
    AND COALESCE(u.modo, 'completo') != 'solo_proyectos'
    AND u.slack_id NOT IN (SELECT user_id FROM registros WHERE fecha = ? AND tipo = 'entrada')
    AND u.slack_id NOT IN (SELECT user_id FROM novedades WHERE fecha = ? AND user_id IS NOT NULL
                           AND tipo IN (${NOVEDADES_EXENTAS.map(() => '?').join(',')}))
  ORDER BY u.nombre`).all(fecha, fecha, ...NOVEDADES_EXENTAS);

/** Resumen agregado por persona para un rango (reporte semanal/mensual).
 *  Excluye modo solo_proyectos: no tienen horas esperadas de asistencia. */
const resumenPersonas = (from, to) => {
  const users = getTracked().filter(u => !esSoloProyectos(u));
  const dias = getDias(from, to);
  return users.map(u => {
    const propios = dias.filter(d => d.user_id === u.slack_id);
    const horas = Math.round(propios.reduce((s, d) => s + (d.horas || 0), 0) * 100) / 100;
    const esperadas = horasEsperadas(u, from, to);
    const tardes = propios.filter(d => d.tarde_min > 0).length;
    const autoCierres = propios.filter(d => d.auto_closed).length;
    return { ...u, horas, esperadas, tardes, autoCierres, diasTrabajados: propios.filter(d => d.entrada).length };
  });
};

module.exports = {
  db, TIPOS_ORDEN, NOVEDADES_EXENTAS,
  upsertUser, getUser, getAllUsers, getTracked, setTracked, setAdmin, setHorario, setEquipo, setModo, esSoloProyectos, isAdmin, isSuperAdmin,
  SALIDA_VIERNES, horarioDia, horasEsperadas,
  getDia, nextTipo, horasDia, registrar, imputarAlmuerzo, getDias,
  addNovedad, borrarNovedad, cargarNovedadRango, getNovedadesFecha, getNovedadesRange, isFeriado, getFeriados, hasNovedad, isExento, diasEsperados,
  setVacacionesAnuales, vacacionesResumen, novedadesRangosAdmin, evaluacionUsuario, TOLERANCIA_MIN,
  createToken, peekToken, consumeToken,
  getCierre, setCierre,
  logPresencia, logActividad, ultimaActividadSlack, horaAutoCierre, actividadDia, presenciaSummary, presenciaPorDia,
  crearReclamo, getReclamo, reclamoPendiente, resolverReclamo, aplicarReclamo,
  getMarcas, proyectoDeMarca, resetDiaPrueba,
  addPingModo, getPingModoActivo, getPingModosEnRango, createPing, respondPing, expirarPings, pingsHoyCount, pingSummary,
  crearProyecto, archivarProyecto, reactivarProyecto, editarProyecto, getProyectos, setImputaciones, getImputacionesDia, hayImputaciones,
  horasPorProyecto, horasPorCliente, horasPorCategoria, horasProyectoPersona, horasUsuarioPorProyecto, getImputacionesRange,
  logIntentoMobile, getIntentosMobile, avisoEnviado, marcarAviso,
  faltantes, resumenPersonas,
};
