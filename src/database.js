const Database = require('better-sqlite3');
const path = require('path');
const t = require('./time');
const dayjs = t.dayjs;
const fs = require('fs');

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
    work_mode     TEXT DEFAULT 'office',  -- office | field
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

  CREATE TABLE IF NOT EXISTS day_overrides (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_id    TEXT,              -- NULL = applies to everyone (holidays)
    date        TEXT NOT NULL,
    type        TEXT NOT NULL,     -- holiday | vacation | medical | field | absent | early_exit | day_off
    reason      TEXT,
    created_by  TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
  CREATE INDEX IF NOT EXISTS idx_records_slack ON records(slack_id);
  CREATE INDEX IF NOT EXISTS idx_pings_date ON activity_pings(date);
  CREATE INDEX IF NOT EXISTS idx_pings_status ON activity_pings(status);
  CREATE INDEX IF NOT EXISTS idx_presence_date ON presence_logs(date);
  CREATE INDEX IF NOT EXISTS idx_overrides_date ON day_overrides(date);
  CREATE INDEX IF NOT EXISTS idx_overrides_slack ON day_overrides(slack_id);

  CREATE TABLE IF NOT EXISTS meetings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_id      TEXT NOT NULL,
    date          TEXT NOT NULL,
    start_time    TEXT NOT NULL,
    end_time      TEXT,
    reason        TEXT,
    duration_min  INTEGER,
    FOREIGN KEY (slack_id) REFERENCES users(slack_id)
  );

  CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);
  CREATE INDEX IF NOT EXISTS idx_meetings_slack ON meetings(slack_id);
`);

// Migrations
try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN is_tracked INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE records ADD COLUMN work_mode TEXT DEFAULT \'office\''); } catch(e) {}
try { db.exec('ALTER TABLE records ADD COLUMN last_seen TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE records ADD COLUMN auto_closed INTEGER DEFAULT 0'); } catch(e) {}

// ═══════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════
const _upsertUser = db.prepare(`INSERT INTO users (slack_id, name, real_name) VALUES (@slack_id, @name, @real_name) ON CONFLICT(slack_id) DO UPDATE SET name = @name, real_name = @real_name`);
const upsertUser = (d) => _upsertUser.run(d);
const getUser = (id) => db.prepare('SELECT * FROM users WHERE slack_id = ?').get(id);
const getAllUsers = () => db.prepare('SELECT * FROM users ORDER BY name').all();
const getTrackedUsers = () => db.prepare('SELECT * FROM users WHERE is_tracked = 1 ORDER BY name').all();
const getAdminUsers = () => db.prepare('SELECT * FROM users WHERE is_admin = 1').all();
const setAdmin = (v, id) => db.prepare('UPDATE users SET is_admin = ? WHERE slack_id = ?').run(v, id);
const setTracked = (v, id) => db.prepare('UPDATE users SET is_tracked = ? WHERE slack_id = ?').run(v, id);
const isAdmin = (id) => {
  const envAdmins = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envAdmins.includes(id)) return true;
  return getUser(id)?.is_admin === 1;
};

// ═══════════════════════════════════════════════════════════════════
// RECORDS
// ═══════════════════════════════════════════════════════════════════
const getOrCreateRecord = (slackId, date) => {
  let r = db.prepare('SELECT * FROM records WHERE slack_id = ? AND date = ?').get(slackId, date);
  if (r) return r;
  db.prepare('INSERT INTO records (slack_id, date) VALUES (?, ?)').run(slackId, date);
  return db.prepare('SELECT * FROM records WHERE slack_id = ? AND date = ?').get(slackId, date);
};

const updateField = (slackId, date, field, value) => {
  const allowed = ['entry_time', 'lunch_start', 'lunch_end', 'exit_time', 'notes', 'work_mode'];
  if (!allowed.includes(field)) throw new Error(`Campo no permitido: ${field}`);
  db.prepare(`UPDATE records SET ${field} = ? WHERE slack_id = ? AND date = ?`).run(value, slackId, date);

  // If correcting exit_time, clear auto_closed flag
  if (field === 'exit_time') {
    db.prepare('UPDATE records SET auto_closed = 0 WHERE slack_id = ? AND date = ?').run(slackId, date);
  }

  const record = db.prepare('SELECT * FROM records WHERE slack_id = ? AND date = ?').get(slackId, date);
  if (record.entry_time && record.exit_time) {
    const entry = dayjs(`${date} ${record.entry_time}`);
    const exit = dayjs(`${date} ${record.exit_time}`);
    let mins = exit.diff(entry, 'minute');
    if (record.lunch_start && record.lunch_end) {
      mins -= dayjs(`${date} ${record.lunch_end}`).diff(dayjs(`${date} ${record.lunch_start}`), 'minute');
    }
    db.prepare('UPDATE records SET total_hours = ? WHERE slack_id = ? AND date = ?').run(Math.round((mins / 60) * 100) / 100, slackId, date);
  }
  return db.prepare('SELECT * FROM records WHERE slack_id = ? AND date = ?').get(slackId, date);
};

const setWorkMode = (slackId, date, mode) => {
  getOrCreateRecord(slackId, date);
  db.prepare('UPDATE records SET work_mode = ? WHERE slack_id = ? AND date = ?').run(mode, slackId, date);
};

const getRecord = (slackId, date) => db.prepare('SELECT * FROM records WHERE slack_id = ? AND date = ?').get(slackId, date);

/** Update last_seen timestamp whenever user interacts */
const updateLastSeen = (slackId, date, time) => {
  getOrCreateRecord(slackId, date);
  db.prepare('UPDATE records SET last_seen = ? WHERE slack_id = ? AND date = ?').run(time, slackId, date);
};

/**
 * Auto-close all open days at end of day.
 * - Field/meeting users without exit → exit at closeTime (e.g. 18:30)
 * - Office users without exit → exit at their last_seen, or closeTime as fallback
 * - Auto-fill missing lunch if entry exists but no lunch
 * Returns array of closed records for notification
 */
const autoCloseDay = (date, closeTime) => {
  const open = db.prepare(`
    SELECT r.*, u.name, u.real_name FROM records r
    JOIN users u ON r.slack_id = u.slack_id
    WHERE r.date = ? AND r.entry_time IS NOT NULL AND r.exit_time IS NULL AND u.is_tracked = 1
  `).all(date);

  const closed = [];

  for (const r of open) {
    const isField = r.work_mode === 'field';
    const hasMeeting = db.prepare("SELECT COUNT(*) as c FROM meetings WHERE slack_id = ? AND date = ? AND end_time IS NULL").get(r.slack_id, date)?.c > 0;

    // Determine exit time
    let exitTime;
    if (isField || hasMeeting) {
      exitTime = closeTime; // 18:30 for field/meeting
    } else {
      // Use last_seen, fallback to closeTime
      exitTime = r.last_seen || closeTime;
    }

    // Auto-close open meetings
    if (hasMeeting) {
      db.prepare("UPDATE meetings SET end_time = ?, duration_min = NULL WHERE slack_id = ? AND date = ? AND end_time IS NULL")
        .run(closeTime, r.slack_id, date);
    }

    // Auto-fill missing lunch (default 1hr: 13:00-14:00)
    if (!r.lunch_start) {
      db.prepare('UPDATE records SET lunch_start = ?, lunch_end = ? WHERE slack_id = ? AND date = ?')
        .run('13:00', '14:00', r.slack_id, date);
    } else if (r.lunch_start && !r.lunch_end) {
      // Started lunch but never ended — assume 1hr
      const lunchStart = dayjs(`${date} ${r.lunch_start}`);
      const autoEnd = lunchStart.add(60, 'minute').format('HH:mm');
      db.prepare('UPDATE records SET lunch_end = ? WHERE slack_id = ? AND date = ?')
        .run(autoEnd, r.slack_id, date);
    }

    // Set exit
    db.prepare('UPDATE records SET exit_time = ?, auto_closed = 1 WHERE slack_id = ? AND date = ?')
      .run(exitTime, r.slack_id, date);

    // Recalculate hours
    const updated = db.prepare('SELECT * FROM records WHERE slack_id = ? AND date = ?').get(r.slack_id, date);
    if (updated.entry_time && updated.exit_time) {
      const entry = dayjs(`${date} ${updated.entry_time}`);
      const exit = dayjs(`${date} ${updated.exit_time}`);
      let mins = exit.diff(entry, 'minute');
      if (updated.lunch_start && updated.lunch_end) {
        mins -= dayjs(`${date} ${updated.lunch_end}`).diff(dayjs(`${date} ${updated.lunch_start}`), 'minute');
      }
      db.prepare('UPDATE records SET total_hours = ? WHERE slack_id = ? AND date = ?')
        .run(Math.round((mins / 60) * 100) / 100, r.slack_id, date);
    }

    closed.push({ slack_id: r.slack_id, name: r.name, real_name: r.real_name, exit_time: exitTime, was_field: isField });
  }

  return closed;
};

// ═══════════════════════════════════════════════════════════════════
// DAY OVERRIDES (holidays, vacations, medical, etc.)
// ═══════════════════════════════════════════════════════════════════
const addOverride = (slackId, date, type, reason, createdBy) => {
  db.prepare('INSERT INTO day_overrides (slack_id, date, type, reason, created_by) VALUES (?, ?, ?, ?, ?)').run(slackId, date, type, reason, createdBy);
};

const removeOverride = (id) => db.prepare('DELETE FROM day_overrides WHERE id = ?').run(id);

const getOverridesForDate = (date) => db.prepare(`
  SELECT o.*, u.name, u.real_name FROM day_overrides o
  LEFT JOIN users u ON o.slack_id = u.slack_id
  WHERE o.date = ? ORDER BY o.type, u.name
`).all(date);

const getUserOverride = (slackId, date) => db.prepare(`
  SELECT * FROM day_overrides WHERE date = ? AND (slack_id = ? OR slack_id IS NULL) ORDER BY slack_id DESC LIMIT 1
`).get(date, slackId);

const isHoliday = (date) => {
  return db.prepare("SELECT COUNT(*) as c FROM day_overrides WHERE date = ? AND type = 'holiday' AND slack_id IS NULL").get(date)?.c > 0;
};

const getOverridesByRange = (start, end) => db.prepare(`
  SELECT o.*, u.name, u.real_name FROM day_overrides o
  LEFT JOIN users u ON o.slack_id = u.slack_id
  WHERE o.date BETWEEN ? AND ? ORDER BY o.date, o.type
`).all(start, end);

const isUserExemptToday = (slackId, date) => {
  const ov = getUserOverride(slackId, date);
  if (!ov) return false;
  return ['holiday', 'vacation', 'medical', 'absent', 'day_off'].includes(ov.type);
};

const isFieldDay = (slackId, date) => {
  const ov = getUserOverride(slackId, date);
  return ov?.type === 'field';
};

// ═══════════════════════════════════════════════════════════════════
// REPORTS (scoped to tracked users)
// ═══════════════════════════════════════════════════════════════════
const getRecordsByDateRange = (s, e) => db.prepare(`
  SELECT r.*, u.name, u.real_name, u.is_tracked FROM records r
  JOIN users u ON r.slack_id = u.slack_id WHERE r.date BETWEEN ? AND ?
  ORDER BY r.date DESC, u.name ASC
`).all(s, e);

const getUserRecordsByDateRange = (id, s, e) => db.prepare(`
  SELECT r.*, u.name, u.real_name FROM records r
  JOIN users u ON r.slack_id = u.slack_id WHERE r.slack_id = ? AND r.date BETWEEN ? AND ?
  ORDER BY r.date DESC
`).all(id, s, e);

const getMissingToday = (date) => db.prepare(`
  SELECT u.slack_id, u.name, u.real_name FROM users u
  WHERE u.is_tracked = 1
    AND u.slack_id NOT IN (SELECT slack_id FROM records WHERE date = ? AND entry_time IS NOT NULL)
    AND u.slack_id NOT IN (SELECT slack_id FROM day_overrides WHERE date = ? AND type IN ('holiday','vacation','medical','absent','day_off'))
`).all(date, date);

const getIncompleteToday = (date) => db.prepare(`
  SELECT r.*, u.name, u.real_name FROM records r
  JOIN users u ON r.slack_id = u.slack_id
  WHERE r.date = ? AND r.entry_time IS NOT NULL AND r.exit_time IS NULL AND u.is_tracked = 1
`).all(date);

const getNoLunchYet = (date) => db.prepare(`
  SELECT r.*, u.name, u.real_name FROM records r
  JOIN users u ON r.slack_id = u.slack_id
  WHERE r.date = ? AND r.entry_time IS NOT NULL AND r.lunch_start IS NULL AND u.is_tracked = 1
    AND u.slack_id NOT IN (SELECT slack_id FROM day_overrides WHERE date = ? AND type IN ('holiday','vacation','medical','absent','day_off'))
`).all(date, date);

const getWeeklySummary = (s, e) => db.prepare(`
  SELECT u.slack_id, u.name, u.real_name, u.is_tracked,
    COUNT(r.entry_time) as days_worked,
    ROUND(SUM(COALESCE(r.total_hours, 0)), 2) as total_hours,
    ROUND(AVG(COALESCE(r.total_hours, 0)), 2) as avg_hours
  FROM users u LEFT JOIN records r ON u.slack_id = r.slack_id AND r.date BETWEEN ? AND ?
  WHERE u.is_tracked = 1 GROUP BY u.slack_id ORDER BY u.name
`).all(s, e);

const getOvertimeToday = (date, maxHours) => db.prepare(`
  SELECT r.*, u.name, u.real_name FROM records r
  JOIN users u ON r.slack_id = u.slack_id
  WHERE r.date = ? AND r.total_hours > ? AND u.is_tracked = 1
`).all(date, maxHours);

const getDailySummary = (date) => {
  const tracked = getTrackedUsers();
  const records = getRecordsByDateRange(date, date);
  const missing = getMissingToday(date);
  const overrides = getOverridesForDate(date);
  const withEntry = records.filter(r => r.entry_time);
  const complete = records.filter(r => r.exit_time);
  const fieldWorkers = records.filter(r => r.work_mode === 'field');
  const totalHours = complete.reduce((s, r) => s + (r.total_hours || 0), 0);
  return { tracked: tracked.length, present: withEntry.length, complete: complete.length, missing: missing.length, field: fieldWorkers.length, overrides, totalHours, avgHours: complete.length > 0 ? Math.round((totalHours / complete.length) * 10) / 10 : 0 };
};

// ═══════════════════════════════════════════════════════════════════
// PINGS
// ═══════════════════════════════════════════════════════════════════
const createPing = (slackId, date, sentAt) => db.prepare('INSERT INTO activity_pings (slack_id, date, sent_at) VALUES (?, ?, ?)').run(slackId, date, sentAt).lastInsertRowid;

const respondToPing = (pingId) => {
  const ping = db.prepare('SELECT * FROM activity_pings WHERE id = ?').get(pingId);
  if (!ping || ping.status !== 'pending') return null;
  const now = t.now();
  const ms = now.diff(dayjs(`${ping.date} ${ping.sent_at}`), 'millisecond');
  db.prepare("UPDATE activity_pings SET responded_at = ?, response_ms = ?, status = 'ok' WHERE id = ?").run(now.format('HH:mm:ss'), ms, pingId);
  return db.prepare('SELECT * FROM activity_pings WHERE id = ?').get(pingId);
};

const expirePings = (cutoff, date) => db.prepare("UPDATE activity_pings SET status = 'missed' WHERE status = 'pending' AND date = ? AND sent_at < ?").run(date, cutoff);
const getPendingPings = (id) => db.prepare("SELECT * FROM activity_pings WHERE slack_id = ? AND status = 'pending' ORDER BY sent_at DESC LIMIT 1").get(id);
const getTodayPingCount = (id, date) => db.prepare('SELECT COUNT(*) as c FROM activity_pings WHERE slack_id = ? AND date = ?').get(id, date)?.c || 0;
const getPingSummary = (s, e) => db.prepare(`
  SELECT u.slack_id, u.name, u.real_name, COUNT(*) as total_pings,
    SUM(CASE WHEN p.status = 'ok' THEN 1 ELSE 0 END) as responded,
    SUM(CASE WHEN p.status = 'missed' THEN 1 ELSE 0 END) as missed,
    ROUND(AVG(CASE WHEN p.response_ms IS NOT NULL THEN p.response_ms END)) as avg_response_ms
  FROM activity_pings p JOIN users u ON p.slack_id = u.slack_id
  WHERE p.date BETWEEN ? AND ? GROUP BY u.slack_id ORDER BY missed DESC, u.name ASC
`).all(s, e);
const getPingsByDateRange = (s, e) => db.prepare(`
  SELECT p.*, u.name, u.real_name FROM activity_pings p JOIN users u ON p.slack_id = u.slack_id
  WHERE p.date BETWEEN ? AND ? ORDER BY p.date DESC, p.sent_at DESC
`).all(s, e);

// ═══════════════════════════════════════════════════════════════════
// PRESENCE
// ═══════════════════════════════════════════════════════════════════
const logPresence = (id, date, at, status) => db.prepare('INSERT INTO presence_logs (slack_id, date, checked_at, status) VALUES (?, ?, ?, ?)').run(id, date, at, status);
const getPresenceByDate = (date) => db.prepare('SELECT p.*, u.name, u.real_name FROM presence_logs p JOIN users u ON p.slack_id = u.slack_id WHERE p.date = ? ORDER BY p.checked_at DESC').all(date);
const getPresenceSummary = (id, s, e) => db.prepare(`
  SELECT COUNT(*) as total_checks,
    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
    SUM(CASE WHEN status = 'away' THEN 1 ELSE 0 END) as away_count,
    ROUND(100.0 * SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) / COUNT(*), 1) as active_pct
  FROM presence_logs WHERE slack_id = ? AND date BETWEEN ? AND ?
`).get(id, s, e);

// ═══════════════════════════════════════════════════════════════════
// MONTHLY EXPORT DATA
// ═══════════════════════════════════════════════════════════════════
const getMonthlyExportData = (startDate, endDate) => {
  const users = getTrackedUsers();
  const records = db.prepare(`
    SELECT r.*, u.name, u.real_name FROM records r
    JOIN users u ON r.slack_id = u.slack_id
    WHERE r.date BETWEEN ? AND ? AND u.is_tracked = 1
    ORDER BY u.name, r.date
  `).all(startDate, endDate);
  const overrides = getOverridesByRange(startDate, endDate);
  return { users, records, overrides };
};

// ═══════════════════════════════════════════════════════════════════
// MEETINGS
// ═══════════════════════════════════════════════════════════════════
const startMeeting = (slackId, date, startTime, reason) => {
  const r = db.prepare('INSERT INTO meetings (slack_id, date, start_time, reason) VALUES (?, ?, ?, ?)').run(slackId, date, startTime, reason);
  return r.lastInsertRowid;
};

const endMeeting = (meetingId, endTime) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  if (!m || m.end_time) return null;
  const start = dayjs(`${m.date} ${m.start_time}`);
  const end = dayjs(`${m.date} ${endTime}`);
  const duration = end.diff(start, 'minute');
  db.prepare('UPDATE meetings SET end_time = ?, duration_min = ? WHERE id = ?').run(endTime, duration, meetingId);
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
};

const getActiveMeeting = (slackId, date) => db.prepare(
  'SELECT * FROM meetings WHERE slack_id = ? AND date = ? AND end_time IS NULL ORDER BY start_time DESC LIMIT 1'
).get(slackId, date);

const getUserMeetings = (slackId, date) => db.prepare(
  'SELECT * FROM meetings WHERE slack_id = ? AND date = ? ORDER BY start_time'
).all(slackId, date);

const getInMeetingUsers = (date) => db.prepare(`
  SELECT m.*, u.name, u.real_name FROM meetings m
  JOIN users u ON m.slack_id = u.slack_id
  WHERE m.date = ? AND m.end_time IS NULL
`).all(date);

// ═══════════════════════════════════════════════════════════════════
// WEEKLY BALANCE
// ═══════════════════════════════════════════════════════════════════
const getUserWeeklyRecords = (slackId, weekStart, weekEnd) => db.prepare(`
  SELECT * FROM records WHERE slack_id = ? AND date BETWEEN ? AND ? ORDER BY date
`).all(slackId, weekStart, weekEnd);

const countWorkdaysInRange = (startDate, endDate) => {
  let count = 0;
  let d = dayjs(startDate);
  const end = dayjs(endDate);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    if (d.day() !== 0 && d.day() !== 6) count++;
    d = d.add(1, 'day');
  }
  return count;
};

module.exports = {
  db, upsertUser, getUser, getAllUsers, getTrackedUsers, getAdminUsers, setAdmin, setTracked, isAdmin,
  getOrCreateRecord, updateField, setWorkMode, getRecord, updateLastSeen, autoCloseDay,
  addOverride, removeOverride, getOverridesForDate, getUserOverride, isHoliday, getOverridesByRange, isUserExemptToday, isFieldDay,
  getRecordsByDateRange, getUserRecordsByDateRange, getMissingToday, getIncompleteToday, getNoLunchYet,
  getWeeklySummary, getOvertimeToday, getDailySummary, getMonthlyExportData,
  createPing, respondToPing, expirePings, getPendingPings, getTodayPingCount, getPingSummary, getPingsByDateRange,
  logPresence, getPresenceByDate, getPresenceSummary,
  startMeeting, endMeeting, getActiveMeeting, getUserMeetings, getInMeetingUsers,
  getUserWeeklyRecords, countWorkdaysInRange,
};
