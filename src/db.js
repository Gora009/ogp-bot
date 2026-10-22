import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';

mkdirSync('data', { recursive: true });
export const db = new DatabaseSync('data/bot.db');
// ждать, а не падать, если база на мгновение занята
db.exec('PRAGMA busy_timeout = 5000');
// WAL: запись не блокирует чтение и не ждёт сброса на диск при каждом изменении — быстрее на каждом нажатии;
// при сбое теряются максимум последние мгновения, база не повреждается
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
// при выключении — аккуратно закрыть базу (всё из журнала WAL переносится в bot.db)
process.on('exit', () => { try { db.close(); } catch { /* уже закрыта */ } });

// Кэш подготовленных запросов: один и тот же SQL компилируется один раз, а не при каждом вызове
const prepareRaw = db.prepare.bind(db);
const statements = new Map();
db.prepare = (sql) => {
  let st = statements.get(sql);
  if (!st) statements.set(sql, (st = prepareRaw(sql)));
  return st;
};

db.exec(`
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, channel_id TEXT, message_id TEXT, created_ts INTEGER);
CREATE TABLE IF NOT EXISTS prosecutors (user_id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS judges (user_id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS complaints (
  thread_id INTEGER PRIMARY KEY, number TEXT, title TEXT, author TEXT, url TEXT,
  created_ts INTEGER, message_id TEXT, assignee_id TEXT, status TEXT NOT NULL DEFAULT 'new',
  duplicate INTEGER NOT NULL DEFAULT 0, posted_ts INTEGER, assigned_ts INTEGER,
  respond_by INTEGER, close_by INTEGER, replies INTEGER NOT NULL DEFAULT 0,
  notified_respond INTEGER NOT NULL DEFAULT 0, notified_close INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cases (
  uin TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, accused TEXT, passport TEXT, opened_date TEXT,
  document TEXT, prosecutor_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', comment TEXT,
  created_ts INTEGER, review_channel_id TEXT, review_message_id TEXT, decided_by TEXT);
CREATE TABLE IF NOT EXISTS case_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uin TEXT NOT NULL, requester_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_ts INTEGER);
CREATE TABLE IF NOT EXISTS vacations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, start_ts INTEGER, end_ts INTEGER,
  reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created_ts INTEGER);
CREATE TABLE IF NOT EXISTS resignations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending',
  created_ts INTEGER, decided_by TEXT, decided_ts INTEGER, reject_reason TEXT);
CREATE TABLE IF NOT EXISTS mentorships (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mentor_id TEXT NOT NULL, mentee_id TEXT NOT NULL, created_by TEXT,
  mentor_name TEXT, mentor_tag TEXT, mentee_name TEXT, mentee_tag TEXT, goal TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_ts INTEGER, start_by INTEGER, end_by INTEGER,
  started_ts INTEGER, finished_ts INTEGER, result_comment TEXT, refuse_reason TEXT,
  channel_id TEXT, message_id TEXT,
  notified_start INTEGER NOT NULL DEFAULT 0, notified_end INTEGER NOT NULL DEFAULT 0, reminded INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS deadline_responsible (user_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS dm_log (channel_id TEXT, message_id TEXT);
CREATE TABLE IF NOT EXISTS names (user_id TEXT PRIMARY KEY, name TEXT NOT NULL);
-- кому не распределять жалобы (/distribution off)
CREATE TABLE IF NOT EXISTS assign_off (user_id TEXT PRIMARY KEY, by_id TEXT, ts INTEGER);
`);

// миграции для баз, созданных старыми версиями бота
for (const [table, col] of [
  ['complaints', 'accepted_ts INTEGER'], ['complaints', 'closed_ts INTEGER'], ['complaints', 'close_url TEXT'],
  ['complaints', 'result TEXT'], ['complaints', 'violator TEXT'], ['complaints', 'restricted INTEGER NOT NULL DEFAULT 0'],
  ['complaints', 'forum_checked_ts INTEGER'], ['complaints', 'applicant TEXT'],
  ['complaints', 'remind_stage INTEGER NOT NULL DEFAULT 0'], ['complaints', 'last_nag_ts INTEGER'],
  ['prosecutors', 'senior INTEGER NOT NULL DEFAULT 0'], ['prosecutors', 'position TEXT'], ['prosecutors', 'rank_id INTEGER'], ['complaints', 'target_rank INTEGER'],
  ['cases', 'decided_ts INTEGER'], ['cases', 'action TEXT'], ['cases', 'action_value TEXT'], ['cases', 'action_by TEXT'],
  ['mentorships', 'cancel_reason TEXT'],
  ['prosecutors', 'on_leave INTEGER NOT NULL DEFAULT 0'], ['complaints', 'dm_channel_id TEXT'], ['complaints', 'dm_message_id TEXT'],
  ['vacations', 'decided_by TEXT'], ['vacations', 'decided_ts INTEGER'], ['vacations', 'reject_reason TEXT'],
  ['vacations', 'channel_id TEXT'], ['vacations', 'message_id TEXT'], ['vacations', 'cancelled_by TEXT'], ['vacations', 'cancelled_ts INTEGER'],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* уже есть */ }
}
// частые выборки жалоб по статусу и исполнителю
db.exec(`CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
         CREATE INDEX IF NOT EXISTS idx_complaints_assignee ON complaints(assignee_id, status);
         CREATE INDEX IF NOT EXISTS idx_complaints_number ON complaints(number);`);

export const getSetting = (k) => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v ?? null;
export const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
export const panelOf = (type) => db.prepare('SELECT * FROM panels WHERE type=? ORDER BY id DESC').get(type);

/** Копия базы раз в сутки в data/backups (хранятся 7 последних). Вызывать можно часто — лишних копий не будет. */
export function backupDb() {
  mkdirSync('data/backups', { recursive: true });
  const file = `data/backups/bot-${new Date().toISOString().slice(0, 10)}.db`;
  if (existsSync(file)) return false;
  db.exec(`VACUUM INTO '${file}'`);
  const old = readdirSync('data/backups').filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -7);
  for (const f of old) unlinkSync(`data/backups/${f}`);
  return true;
}
