const Database = require('better-sqlite3');
const path = require('path');
const dayjs = require('dayjs');
const fs = require('fs');

// Railway: use /data volume. Local: use ./data/
const DB_DIR = process.env.DB_PATH || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'attendance.db');
fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ─── Schema ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    slack_id    TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    real_name   TEXT,
    is_admin    INTEGER DEFAULT 0,
    is_tracked  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS records (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_id      TEXT NOT NULL,
    date          TEXT NOT NULL,
    entry_time    TEXT,
    lunch_start   TEXT,
    lunch_end     TEXT,
    exit_time     TEXT,
    total_hours   REAL,
    notes         TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (slack_id) REFERENCES users(slack_id),
    UNIQUE(slack_id, date)
  );

  CREATE TABLE IF NOT EXISTS activity_pings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_id      TEXT NOT NULL,
    date          TEXT NOT NULL,
    sent_at       TEXT NOT NULL,
    responded_at  TEXT,
    response_ms   INTEGER,
    status        TEXT DEFAULT 'pending',
    FOREIGN KEY (slack_id) REFERENCES users(slack_id)
  );

  CREATE TABLE IF NOT EXISTS presence_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_id      TEXT NOT NULL,
    date          TEXT NOT NULL,
    checked_at    TEXT NOT NULL,
    status        TEXT NOT NULL,
    FOREIGN KEY (slack_id) REFERENCES users(slack_id)
  );

  CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
  CREATE INDEX IF NOT EXISTS idx_records_slack ON records(slack_id);
  CREATE INDEX IF NOT EXISTS idx_pings_date ON activity_pings(date);
  CREATE INDEX IF NOT EXISTS idx_pings_status ON activity_pings(status);
  CREATE INDEX IF NOT EXISTS idx_presence_date ON presence_logs(date);
`);

// Migration for existing DBs
try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN is_tracked INTEGER DEFAULT 0'); } catch(e) {}

// ═══════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════

const upsertUser = db.prepare(`
  INSERT INTO users (slack_id, name, real_name)
  VALUES (@slack_id, @name, @real_name)
  ON CONFLICT(slack_id) DO UPDATE SET name = @name, real_name = @real_name
`);

const getUser = db.prepare('SELECT * FROM users WHERE slack_id = ?');
const getAllUsers = db.prepare('SELECT * FROM users ORDER BY name');
const getTrackedUsers = db.prepare('SELECT * FROM users WHERE is_tracked = 1 ORDER BY name');
const getAdminUsers = db.prepare('SELECT * FROM users WHERE is_admin = 1');
const setAdmin = db.prepare('UPDATE users SET is_admin = ? WHERE slack_id = ?');
const setTracked = db.prepare('UPDATE users SET is_tracked = ? WHERE slack_id = ?');

const isAdmin = (slackId) => {
  const envAdmins = (process.env.ADMIN_USER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (envAdmins.includes(slackId)) return true;
  const user = getUser.get(slackId);
  return user?.is_admin === 1;
};

// ═══════════════════════════════════════════════════════════════════
// ATTENDANCE RECORDS
// ═══════════════════════════════════════════════════════════════════

const getOrCreateRecord = (slackId, date) => {
  const existing = db.prepare(
    'SELECT * FROM records WHERE slack_id = ? AND date = ?'
  ).get(slackId, date);
  if (existing) return existing;
  db.prepare('INSERT INTO records (slack_id, date) VALUES (?, ?)').run(slackId, date);
  return db.prepare('SELECT * FROM records WHERE slack_id = ? AND date = ?').get(slackId, date);
};

const updateField = (slackId, date, field, value) => {
  const allowed = ['entry_time', 'lunch_start', 'lunch_end', 'exit_time', 'notes'];
  if (!allowed.includes(field)) throw new Error(`Campo no permitido: ${field}`);

  db.prepare(`UPDATE records SET ${field} = ? WHERE slack_id = ? AND date = ?`)
    .run(value, slackId, date);

  const record = db.prepare('SELECT * FROM records WHERE slack_id = ? AND date = ?')
    .get(slackId, date);

  if (record.entry_time && record.exit_time) {
    const entry = dayjs(`${date} ${record.entry_time}`);
    const exit = dayjs(`${date} ${record.exit_time}`);
    let totalMinutes = exit.diff(entry, 'minute');
    if (record.lunch_start && record.lunch_end) {
      const lunchStart = dayjs(`${date} ${record.lunch_start}`);
      const lunchEnd = dayjs(`${date} ${record.lunch_end}`);
      totalMinutes -= lunchEnd.diff(lunchStart, 'minute');
    }
    db.prepare('UPDATE records SET total_hours = ? WHERE slack_id = ? AND date = ?')
      .run(Math.round((totalMinutes / 60) * 100) / 100, slackId, date);
  }

  return db.prepare('SELECT * FROM records WHERE slack_id = ? AND date = ?').get(slackId, date);
};

const getRecord = (slackId, date) =>
  db.prepare('SELECT * FROM records WHERE slack_id = ? AND date = ?').get(slackId, date);

// ═══════════════════════════════════════════════════════════════════
// REPORTS (scoped to tracked users)
// ═══════════════════════════════════════════════════════════════════

const getRecordsByDateRange = (startDate, endDate) => db.prepare(`
  SELECT r.*, u.name, u.real_name, u.is_tracked
  FROM records r JOIN users u ON r.slack_id = u.slack_id
  WHERE r.date BETWEEN ? AND ?
  ORDER BY r.date DESC, u.name ASC
`).all(startDate, endDate);

const getUserRecordsByDateRange = (slackId, startDate, endDate) => db.prepare(`
  SELECT r.*, u.name, u.real_name
  FROM records r JOIN users u ON r.slack_id = u.slack_id
  WHERE r.slack_id = ? AND r.date BETWEEN ? AND ?
  ORDER BY r.date DESC
`).all(slackId, startDate, endDate);

const getMissingToday = (date) => db.prepare(`
  SELECT u.slack_id, u.name, u.real_name
  FROM users u
  WHERE u.is_tracked = 1
    AND u.slack_id NOT IN (
      SELECT slack_id FROM records WHERE date = ? AND entry_time IS NOT NULL
    )
`).all(date);

const getIncompleteToday = (date) => db.prepare(`
  SELECT r.*, u.name, u.real_name
  FROM records r JOIN users u ON r.slack_id = u.slack_id
  WHERE r.date = ? AND r.entry_time IS NOT NULL AND r.exit_time IS NULL
    AND u.is_tracked = 1
`).all(date);

const getWeeklySummary = (startDate, endDate) => db.prepare(`
  SELECT u.slack_id, u.name, u.real_name, u.is_tracked,
    COUNT(r.entry_time) as days_worked,
    ROUND(SUM(COALESCE(r.total_hours, 0)), 2) as total_hours,
    ROUND(AVG(COALESCE(r.total_hours, 0)), 2) as avg_hours
  FROM users u
  LEFT JOIN records r ON u.slack_id = r.slack_id AND r.date BETWEEN ? AND ?
  WHERE u.is_tracked = 1
  GROUP BY u.slack_id ORDER BY u.name
`).all(startDate, endDate);

// ═══════════════════════════════════════════════════════════════════
// ACTIVITY PINGS
// ═══════════════════════════════════════════════════════════════════

const createPing = (slackId, date, sentAt) => {
  const r = db.prepare(
    'INSERT INTO activity_pings (slack_id, date, sent_at) VALUES (?, ?, ?)'
  ).run(slackId, date, sentAt);
  return r.lastInsertRowid;
};

const respondToPing = (pingId) => {
  const ping = db.prepare('SELECT * FROM activity_pings WHERE id = ?').get(pingId);
  if (!ping || ping.status !== 'pending') return null;
  const now = dayjs();
  const responseMs = now.diff(dayjs(`${ping.date} ${ping.sent_at}`), 'millisecond');
  db.prepare(`
    UPDATE activity_pings SET responded_at = ?, response_ms = ?, status = 'ok' WHERE id = ?
  `).run(now.format('HH:mm:ss'), responseMs, pingId);
  return db.prepare('SELECT * FROM activity_pings WHERE id = ?').get(pingId);
};

const expirePings = (cutoffTime, date) => db.prepare(`
  UPDATE activity_pings SET status = 'missed'
  WHERE status = 'pending' AND date = ? AND sent_at < ?
`).run(date, cutoffTime);

const getPendingPings = (slackId) => db.prepare(
  "SELECT * FROM activity_pings WHERE slack_id = ? AND status = 'pending' ORDER BY sent_at DESC LIMIT 1"
).get(slackId);

const getTodayPingCount = (slackId, date) =>
  db.prepare('SELECT COUNT(*) as c FROM activity_pings WHERE slack_id = ? AND date = ?')
    .get(slackId, date)?.c || 0;

const getPingSummary = (startDate, endDate) => db.prepare(`
  SELECT u.slack_id, u.name, u.real_name,
    COUNT(*) as total_pings,
    SUM(CASE WHEN p.status = 'ok' THEN 1 ELSE 0 END) as responded,
    SUM(CASE WHEN p.status = 'missed' THEN 1 ELSE 0 END) as missed,
    ROUND(AVG(CASE WHEN p.response_ms IS NOT NULL THEN p.response_ms END)) as avg_response_ms
  FROM activity_pings p JOIN users u ON p.slack_id = u.slack_id
  WHERE p.date BETWEEN ? AND ?
  GROUP BY u.slack_id ORDER BY missed DESC, u.name ASC
`).all(startDate, endDate);

const getPingsByDateRange = (startDate, endDate) => db.prepare(`
  SELECT p.*, u.name, u.real_name
  FROM activity_pings p JOIN users u ON p.slack_id = u.slack_id
  WHERE p.date BETWEEN ? AND ?
  ORDER BY p.date DESC, p.sent_at DESC
`).all(startDate, endDate);

// ═══════════════════════════════════════════════════════════════════
// PRESENCE LOGS
// ═══════════════════════════════════════════════════════════════════

const logPresence = (slackId, date, checkedAt, status) =>
  db.prepare('INSERT INTO presence_logs (slack_id, date, checked_at, status) VALUES (?, ?, ?, ?)')
    .run(slackId, date, checkedAt, status);

const getPresenceByDate = (date) => db.prepare(`
  SELECT p.*, u.name, u.real_name
  FROM presence_logs p JOIN users u ON p.slack_id = u.slack_id
  WHERE p.date = ? ORDER BY p.checked_at DESC
`).all(date);

const getPresenceSummary = (slackId, startDate, endDate) => db.prepare(`
  SELECT
    COUNT(*) as total_checks,
    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
    SUM(CASE WHEN status = 'away' THEN 1 ELSE 0 END) as away_count,
    ROUND(100.0 * SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) / COUNT(*), 1) as active_pct
  FROM presence_logs
  WHERE slack_id = ? AND date BETWEEN ? AND ?
`).get(slackId, startDate, endDate);

module.exports = {
  db,
  upsertUser, getUser, getAllUsers, getTrackedUsers, getAdminUsers,
  setAdmin, setTracked, isAdmin,
  getOrCreateRecord, updateField, getRecord,
  getRecordsByDateRange, getUserRecordsByDateRange,
  getMissingToday, getIncompleteToday, getWeeklySummary,
  createPing, respondToPing, expirePings, getPendingPings,
  getTodayPingCount, getPingSummary, getPingsByDateRange,
  logPresence, getPresenceByDate, getPresenceSummary,
};
