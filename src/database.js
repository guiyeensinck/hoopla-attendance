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

// ─── Leave request tables ───────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS leave_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_id      TEXT NOT NULL,
    type          TEXT NOT NULL,
    date_from     TEXT NOT NULL,
    date_to       TEXT NOT NULL,
    notes         TEXT,
    status        TEXT DEFAULT 'pending',
    reviewed_by   TEXT,
    reviewed_at   TEXT,
    reject_reason TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (slack_id) REFERENCES users(slack_id)
  );
  CREATE TABLE IF NOT EXISTS leave_admin_notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id  INTEGER NOT NULL,
    slack_id    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    message_ts  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leaves_slack  ON leave_requests(slack_id);
  CREATE INDEX IF NOT EXISTS idx_leaves_status ON leave_requests(status);
  CREATE INDEX IF NOT EXISTS idx_leaves_date   ON leave_requests(date_from);
`);

// Migrations
try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN is_tracked INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN is_student INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE records ADD COLUMN work_mode TEXT DEFAULT \'office\''); } catch(e) {}
try { db.exec('ALTER TABLE records ADD COLUMN last_seen TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE records ADD COLUMN auto_closed INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE records ADD COLUMN location TEXT'); } catch(e) {}

// ─── Seed holidays ─────────────────────────────────────────────────
const HOLIDAYS_2026 = [
  { date: '2026-05-01', label: 'Día del Trabajador' },
  { date: '2026-05-25', label: 'Día de la Revolución de Mayo' },
  { date: '2026-06-20', label: 'Día de la Bandera' },
  { date: '2026-07-09', label: 'Día de la Independencia' },
  { date: '2026-07-10', label: 'Puente turístico' },
  { date: '2026-08-17', label: 'Paso a la Inmortalidad del Gral. San Martín' },
  { date: '2026-10-12', label: 'Día del Respeto a la Diversidad Cultural' },
  { date: '2026-11-20', label: 'Día de la Soberanía Nacional' },
  { date: '2026-12-07', label: 'Puente turístico' },
  { date: '2026-12-08', label: 'Inmaculada Concepción de María' },
  { date: '2026-12-24', label: 'Nochebuena' },
  { date: '2026-12-25', label: 'Navidad' },
  { date: '2026-12-31', label: 'Nochevieja' },
];

const _insertHoliday = db.prepare(
  `INSERT INTO day_overrides (slack_id, date, type, reason)
   SELECT NULL, @date, 'holiday', @label
   WHERE NOT EXISTS (
     SELECT 1 FROM day_overrides WHERE slack_id IS NULL AND date = @date AND type = 'holiday'
   )`
);
const seedHolidays = db.transaction(() => {
  for (const h of HOLIDAYS_2026) _insertHoliday.run(h);
});
seedHolidays();

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

const setLocation = (slackId, date, location) => {
  db.prepare('UPDATE records SET location = ? WHERE slack_id = ? AND date = ?').run(location, slackId, date);
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

const fillMissingLunch = (slackId, date, r) => {
  if (!r.lunch_start) {
    db.prepare('UPDATE records SET lunch_start = ?, lunch_end = ? WHERE slack_id = ? AND date = ?')
      .run('13:00', '14:00', slackId, date);
  } else if (r.lunch_start && !r.lunch_end) {
    const autoEnd = dayjs(`${date} ${r.lunch_start}`).add(60, 'minute').format('HH:mm');
    db.prepare('UPDATE records SET lunch_end = ? WHERE slack_id = ? AND date = ?')
      .run(autoEnd, slackId, date);
  }
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

    fillMissingLunch(r.slack_id, date, r);

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
  const holidays = new Set(
    db.prepare("SELECT date FROM day_overrides WHERE type = 'holiday' AND slack_id IS NULL AND date BETWEEN ? AND ?")
      .all(startDate, endDate)
      .map(r => r.date)
  );
  let count = 0;
  let d = dayjs(startDate);
  const end = dayjs(endDate);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    const ds = d.format('YYYY-MM-DD');
    if (d.day() !== 0 && d.day() !== 6 && !holidays.has(ds)) count++;
    d = d.add(1, 'day');
  }
  return count;
};

// Days a user should have worked but has no entry_time (excludes weekends, holidays, leaves)
const countMissedDays = (slackId, from, to) => {
  const cap = t.today(); // don't count future days
  const effectiveTo = to > cap ? cap : to;
  const presentSet = new Set(
    db.prepare('SELECT date FROM records WHERE slack_id = ? AND date BETWEEN ? AND ? AND entry_time IS NOT NULL')
      .all(slackId, from, effectiveTo).map(r => r.date)
  );
  const leaveSet = new Set(
    db.prepare(`SELECT date FROM day_overrides WHERE (slack_id = ? OR slack_id IS NULL) AND date BETWEEN ? AND ? AND type IN ('vacation','medical','day_off','absent','field','holiday','early_exit')`)
      .all(slackId, from, effectiveTo).map(r => r.date)
  );
  let missed = 0;
  let d = dayjs(from);
  const end = dayjs(effectiveTo);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    const ds = d.format('YYYY-MM-DD');
    if (d.day() !== 0 && d.day() !== 6 && !leaveSet.has(ds) && !presentSet.has(ds)) missed++;
    d = d.add(1, 'day');
  }
  return missed;
};

const getHolidays = (year) =>
  db.prepare(
    "SELECT date, reason FROM day_overrides WHERE slack_id IS NULL AND type = 'holiday' AND date LIKE ? ORDER BY date"
  ).all(`${year}-%`);

// ═══════════════════════════════════════════════════════════════════
// LEAVE REQUESTS
// ═══════════════════════════════════════════════════════════════════
const createLeaveRequest = (slackId, type, dateFrom, dateTo, notes) => {
  const r = db.prepare(
    `INSERT INTO leave_requests (slack_id, type, date_from, date_to, notes) VALUES (?, ?, ?, ?, ?)`
  ).run(slackId, type, dateFrom, dateTo, notes || null);
  return r.lastInsertRowid;
};

const getLeaveRequest = (id) =>
  db.prepare(`SELECT lr.*, u.name, u.real_name FROM leave_requests lr
    LEFT JOIN users u ON u.slack_id = lr.slack_id WHERE lr.id = ?`).get(id);

const approveLeaveRequest = (id, reviewerId) =>
  db.prepare(`UPDATE leave_requests SET status='approved', reviewed_by=?, reviewed_at=datetime('now') WHERE id=?`)
    .run(reviewerId, id);

const rejectLeaveRequest = (id, reviewerId, reason) =>
  db.prepare(`UPDATE leave_requests SET status='rejected', reviewed_by=?, reviewed_at=datetime('now'), reject_reason=? WHERE id=?`)
    .run(reviewerId, reason || null, id);

const getPendingLeaveRequests = () =>
  db.prepare(`SELECT lr.*, u.name, u.real_name FROM leave_requests lr
    LEFT JOIN users u ON u.slack_id = lr.slack_id
    WHERE lr.status = 'pending' ORDER BY lr.created_at ASC`).all();

const getAllLeaveRequests = (from, to) =>
  db.prepare(`SELECT lr.*, u.name, u.real_name,
    rv.name AS reviewer_name, rv.real_name AS reviewer_real_name
    FROM leave_requests lr
    LEFT JOIN users u  ON u.slack_id  = lr.slack_id
    LEFT JOIN users rv ON rv.slack_id = lr.reviewed_by
    WHERE lr.date_from BETWEEN ? AND ? ORDER BY lr.created_at DESC`)
    .all(from, to);

const getUserLeaveRequests = (slackId, limit = 10) =>
  db.prepare(`SELECT * FROM leave_requests WHERE slack_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(slackId, limit);

const addLeaveAdminNotification = (requestId, slackId, channelId, messageTs) =>
  db.prepare(`INSERT INTO leave_admin_notifications (request_id, slack_id, channel_id, message_ts) VALUES (?,?,?,?)`)
    .run(requestId, slackId, channelId, messageTs);

const getLeaveAdminNotifications = (requestId) =>
  db.prepare(`SELECT * FROM leave_admin_notifications WHERE request_id = ?`).all(requestId);

// ═══════════════════════════════════════════════════════════════════
// LEAVE QUOTA & VALIDATION
// ═══════════════════════════════════════════════════════════════════

/** Returns all APPROVED leave_requests for a user in a calendar year */
const getApprovedLeavesByYear = (slackId, year) =>
  db.prepare(`SELECT * FROM leave_requests WHERE slack_id = ? AND status = 'approved'
    AND (date_from LIKE ? OR date_to LIKE ?) ORDER BY date_from`)
    .all(slackId, `${year}-%`, `${year}-%`);

/** Count approved days for a specific type (or array of types) in a year */
const countApprovedLeaveHalfDays = (slackId, year, types) => {
  const typeList = Array.isArray(types) ? types : [types];
  const rows = db.prepare(
    `SELECT type, date_from, date_to FROM leave_requests
     WHERE slack_id = ? AND status = 'approved'
     AND substr(date_from,1,4) = ? AND type IN (${typeList.map(() => '?').join(',')})`)
    .all(slackId, String(year), ...typeList);
  // personal = 2 half-days, personal_am/pm = 1 half-day each
  // medical_am/pm = 1 half-day each
  // exam / vacation = count workdays in range
  let total = 0;
  for (const r of rows) {
    if (r.type === 'personal') total += 2;
    else if (r.type === 'personal_am' || r.type === 'personal_pm') total += 1;
    else if (r.type === 'medical_am' || r.type === 'medical_pm') total += 1;
    else if (r.type === 'exam') total += countWorkdaysInRange(r.date_from, r.date_to);
    else if (r.type === 'vacation_summer' || r.type === 'vacation_winter') total += 1; // 1 block
  }
  return total;
};

/** Count approved personal half-days used in a 2-month window [from, to] */
const countPersonalHalfDaysInWindow = (slackId, from, to) => {
  const rows = db.prepare(
    `SELECT type FROM leave_requests WHERE slack_id = ? AND status = 'approved'
     AND date_from BETWEEN ? AND ? AND type IN ('personal','personal_am','personal_pm')`)
    .all(slackId, from, to);
  let total = 0;
  for (const r of rows) total += r.type === 'personal' ? 2 : 1;
  return total;
};

/** Count approved exam days in a specific year+semester */
const countExamDaysInSemester = (slackId, year, semester) => {
  const [from, to] = semester === 1
    ? [`${year}-01-01`, `${year}-06-30`]
    : [`${year}-07-01`, `${year}-12-31`];
  const rows = db.prepare(
    `SELECT date_from, date_to FROM leave_requests WHERE slack_id = ? AND status = 'approved'
     AND type = 'exam' AND date_from BETWEEN ? AND ?`)
    .all(slackId, from, to);
  return rows.reduce((s, r) => s + countWorkdaysInRange(r.date_from, r.date_to), 0);
};

/** Count approved exam days in a specific year+month */
const countExamDaysInMonth = (slackId, year, month) => {
  const m = String(month).padStart(2, '0');
  const rows = db.prepare(
    `SELECT date_from, date_to FROM leave_requests WHERE slack_id = ? AND status = 'approved'
     AND type = 'exam' AND substr(date_from,1,7) = ?`)
    .all(slackId, `${year}-${m}`);
  return rows.reduce((s, r) => s + countWorkdaysInRange(r.date_from, r.date_to), 0);
};

/** True if the ISO week containing `date` has a public holiday (= semana corta) */
const isShortWeek = (date) => {
  const d = dayjs(date);
  const monday = d.startOf('isoWeek').format('YYYY-MM-DD');
  const friday = d.startOf('isoWeek').add(4, 'day').format('YYYY-MM-DD');
  const count = db.prepare(
    `SELECT COUNT(*) as c FROM day_overrides WHERE slack_id IS NULL AND type='holiday' AND date BETWEEN ? AND ?`)
    .get(monday, friday)?.c || 0;
  return count > 0;
};

/** Count business days between two dates (inclusive), excluding holidays */
const countBusinessDays = (from, to) => {
  const holidays = new Set(
    db.prepare(`SELECT date FROM day_overrides WHERE type='holiday' AND slack_id IS NULL AND date BETWEEN ? AND ?`)
      .all(from, to).map(r => r.date)
  );
  let count = 0;
  let d = dayjs(from);
  const end = dayjs(to);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    if (d.day() !== 0 && d.day() !== 6 && !holidays.has(d.format('YYYY-MM-DD'))) count++;
    d = d.add(1, 'day');
  }
  return count;
};

/** Check if same week as `date` already has an approved leave of given types (for mixing rule) */
const hasApprovedLeaveInWeek = (slackId, date, types) => {
  const monday = dayjs(date).startOf('isoWeek').format('YYYY-MM-DD');
  const friday = dayjs(date).startOf('isoWeek').add(4, 'day').format('YYYY-MM-DD');
  const typeList = Array.isArray(types) ? types : [types];
  const count = db.prepare(
    `SELECT COUNT(*) as c FROM leave_requests WHERE slack_id = ? AND status = 'approved'
     AND date_from <= ? AND date_to >= ?
     AND type IN (${typeList.map(() => '?').join(',')})`)
    .get(slackId, friday, monday, ...typeList)?.c || 0;
  return count > 0;
};

/** Count how many summer or winter vacation blocks were approved this year */
const countVacationBlocksThisYear = (slackId, year, type) => {
  return db.prepare(
    `SELECT COUNT(*) as c FROM leave_requests WHERE slack_id = ? AND status = 'approved'
     AND type = ? AND substr(date_from,1,4) = ?`)
    .get(slackId, type, String(year))?.c || 0;
};

/**
 * Comprehensive validation for a leave request.
 * Returns { errors: string[] }. Empty array = valid.
 */
const validateLeaveRequest = (slackId, type, dateFrom, dateTo, _notes) => {
  const errors = [];
  const today = dayjs(t.today());
  const from  = dayjs(dateFrom);
  const to    = dayjs(dateTo);
  const year  = from.year();

  // ── Common: date order ────────────────────────────────────────────
  if (to.isBefore(from)) {
    errors.push('La fecha de fin no puede ser anterior a la de inicio.');
    return { errors };
  }

  // ── Common: can't request past dates ─────────────────────────────
  if (from.isBefore(today, 'day')) {
    errors.push('No podés pedir días en el pasado.');
    return { errors };
  }

  // ─────────────────────────────────────────────────────────────────
  if (type === 'vacation_summer' || type === 'vacation_winter') {
    const maxDays    = type === 'vacation_summer' ? 14 : 7;
    const advDays    = 28; // 4 weeks
    const blockLabel = type === 'vacation_summer' ? 'verano' : 'invierno';

    // Must start on Monday
    if (from.day() !== 1) {
      errors.push(`Las vacaciones deben arrancar un *lunes*. ${from.format('dddd DD/MM')} no es lunes.`);
    }

    // Advance notice
    const daysUntil = from.diff(today, 'day');
    if (daysUntil < advDays) {
      errors.push(`Las vacaciones requieren al menos 4 semanas de anticipación (${advDays} días). Faltan solo ${daysUntil} días.`);
    }

    // Season window
    const month = from.month() + 1; // 1-indexed
    if (type === 'vacation_summer') {
      // Oct (10) to Mar (3) — dateTo must be before Apr 1
      const validMonths = [10, 11, 12, 1, 2, 3];
      if (!validMonths.includes(month)) {
        errors.push('Las vacaciones de verano deben tomarse entre octubre y el 1 de abril.');
      }
      const apr1 = dayjs(`${to.month() >= 9 ? to.year() + 1 : to.year()}-04-01`);
      if (to.isAfter(apr1)) {
        errors.push('Las vacaciones de verano deben terminar antes del 1 de abril.');
      }
    } else {
      // Winter: Jul–Sep
      const validMonths = [7, 8, 9];
      if (!validMonths.includes(month)) {
        errors.push('Las vacaciones de invierno deben tomarse entre julio y septiembre.');
      }
      if (to.month() + 1 > 9) {
        errors.push('Las vacaciones de invierno deben terminar antes del 30 de septiembre.');
      }
    }

    // Max consecutive days (holidays don't add, they just don't subtract)
    const calendarDays = to.diff(from, 'day') + 1;
    if (calendarDays > maxDays) {
      errors.push(`Máximo ${maxDays} días corridos para vacaciones de ${blockLabel}. Pediste ${calendarDays}.`);
    }

    // Only 1 block per year
    const blocksUsed = countVacationBlocksThisYear(slackId, year, type);
    if (blocksUsed >= 1) {
      errors.push(`Ya usaste tu bloque de vacaciones de ${blockLabel} ${year}.`);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  else if (type === 'personal' || type === 'personal_am' || type === 'personal_pm') {
    const ANNUAL_HD = 4; // 2 full days = 4 half-days
    const PER2M_HD  = 2; // 1 full day = 2 half-days per 2 months

    // Advance notice: 2 weeks
    const daysUntil = from.diff(today, 'day');
    if (daysUntil < 14) {
      errors.push(`Los trámites personales requieren al menos 2 semanas de anticipación. Faltan ${daysUntil} días.`);
    }

    // Cannot be in short week or week before a short week
    if (isShortWeek(dateFrom)) {
      errors.push('No se pueden tomar trámites personales en una semana corta (semana con feriado).');
    }
    const prevWeekMonday = from.startOf('isoWeek').subtract(7, 'day').format('YYYY-MM-DD');
    const nextWeek = from.startOf('isoWeek').add(7, 'day').format('YYYY-MM-DD');
    if (isShortWeek(nextWeek)) {
      errors.push('No se pueden tomar trámites personales en la semana previa a una semana corta.');
    }

    // Annual quota
    const usedHD = countPersonalHalfDaysInWindow(slackId, `${year}-01-01`, `${year}-12-31`);
    const requestHD = type === 'personal' ? 2 : 1;
    if (usedHD + requestHD > ANNUAL_HD) {
      const remainHD = ANNUAL_HD - usedHD;
      const remainLabel = remainHD <= 0 ? 'ninguno' : remainHD === 1 ? '½ día' : `${remainHD / 2} día(s)`;
      errors.push(`Superás el límite anual de trámites personales (2 días / 4 medios días). Te quedan: ${remainLabel}.`);
    }

    // Per-2-month quota: check the 2-month window containing `from`
    const wMonth = from.month(); // 0-indexed
    const windowStart = from.startOf('year').add(Math.floor(wMonth / 2) * 2, 'month');
    const windowEnd   = windowStart.add(2, 'month').subtract(1, 'day');
    const usedInWindow = countPersonalHalfDaysInWindow(slackId, windowStart.format('YYYY-MM-DD'), windowEnd.format('YYYY-MM-DD'));
    if (usedInWindow + requestHD > PER2M_HD) {
      errors.push(`Superás el límite de ${PER2M_HD / 2 === 1 ? '1 día completo' : `${PER2M_HD} medios días`} cada 2 meses. Ya usaste ${usedInWindow / 2} en este bimestre.`);
    }

    // No mixing with exam or medical in same week
    if (hasApprovedLeaveInWeek(slackId, dateFrom, ['exam', 'medical_am', 'medical_pm'])) {
      errors.push('No podés mezclar trámites personales con días de examen o turnos médicos en la misma semana.');
    }
  }

  // ─────────────────────────────────────────────────────────────────
  else if (type === 'medical_am' || type === 'medical_pm') {
    const ANNUAL_HD = 4;
    const usedHD = countApprovedLeaveHalfDays(slackId, year, ['medical_am', 'medical_pm']);
    if (usedHD + 1 > ANNUAL_HD) {
      errors.push(`Superás el límite de ${ANNUAL_HD} medios días médicos por año. Ya usaste ${usedHD}.`);
    }
    // No mixing in same week
    if (hasApprovedLeaveInWeek(slackId, dateFrom, ['exam', 'personal', 'personal_am', 'personal_pm'])) {
      errors.push('No podés mezclar turnos médicos con trámites personales o días de examen en la misma semana.');
    }
  }

  // ─────────────────────────────────────────────────────────────────
  else if (type === 'exam') {
    // Must be student
    const user = getUser(slackId);
    if (!user?.is_student) {
      errors.push('Los días de examen son solo para quienes cursan una carrera de grado reconocida por el Ministerio de Educación. Pedile al admin que active este permiso en tu perfil.');
    }

    // Advance notice: 10 business days
    const bizDays = countBusinessDays(t.today(), from.subtract(1, 'day').format('YYYY-MM-DD'));
    if (bizDays < 10) {
      errors.push(`Los días de examen requieren al menos 10 días hábiles de anticipación. Faltan solo ${bizDays} días hábiles.`);
    }

    // Max 2 consecutive days
    const calDays = to.diff(from, 'day') + 1;
    if (calDays > 2) {
      errors.push('Solo podés pedir hasta 2 días corridos por examen.');
    }

    // Semester quota (5 per semester)
    const semester = from.month() < 6 ? 1 : 2;
    const usedSem  = countExamDaysInSemester(slackId, year, semester);
    const requestDays = countWorkdaysInRange(dateFrom, dateTo);
    if (usedSem + requestDays > 5) {
      errors.push(`Superás el límite de 5 días de examen por semestre. Ya usaste ${usedSem} en el ${semester}° semestre.`);
    }

    // Monthly quota (max 4)
    const usedMonth = countExamDaysInMonth(slackId, year, from.month() + 1);
    if (usedMonth + requestDays > 4) {
      errors.push(`Superás el límite de 4 días de examen por mes. Ya usaste ${usedMonth} este mes.`);
    }

    // No mixing in same week with personal or medical
    if (hasApprovedLeaveInWeek(slackId, dateFrom, ['personal', 'personal_am', 'personal_pm', 'medical_am', 'medical_pm'])) {
      errors.push('No podés mezclar días de examen con trámites personales o turnos médicos en la misma semana.');
    }
  }

  return { errors };
};

const setStudentFlag = (slackId, value) =>
  db.prepare('UPDATE users SET is_student = ? WHERE slack_id = ?').run(value ? 1 : 0, slackId);

module.exports = {
  db, upsertUser, getUser, getAllUsers, getTrackedUsers, getAdminUsers, setAdmin, setTracked, isAdmin,
  getOrCreateRecord, updateField, setWorkMode, setLocation, getRecord, updateLastSeen, autoCloseDay,
  addOverride, removeOverride, getOverridesForDate, getUserOverride, isHoliday, getOverridesByRange, isUserExemptToday, isFieldDay,
  getRecordsByDateRange, getUserRecordsByDateRange, getMissingToday, getIncompleteToday, getNoLunchYet,
  getWeeklySummary, getOvertimeToday, getDailySummary, getMonthlyExportData,
  createPing, respondToPing, expirePings, getPendingPings, getTodayPingCount, getPingSummary, getPingsByDateRange,
  logPresence, getPresenceByDate, getPresenceSummary,
  startMeeting, endMeeting, getActiveMeeting, getUserMeetings, getInMeetingUsers,
  getUserWeeklyRecords, countWorkdaysInRange, fillMissingLunch, getHolidays, countMissedDays,
  createLeaveRequest, getLeaveRequest, approveLeaveRequest, rejectLeaveRequest,
  getPendingLeaveRequests, getAllLeaveRequests, getUserLeaveRequests,
  addLeaveAdminNotification, getLeaveAdminNotifications,
  validateLeaveRequest, setStudentFlag,
  getApprovedLeavesByYear, countApprovedLeaveHalfDays, countPersonalHalfDaysInWindow,
  countExamDaysInSemester, countExamDaysInMonth, isShortWeek, countBusinessDays,
  hasApprovedLeaveInWeek, countVacationBlocksThisYear,
};
