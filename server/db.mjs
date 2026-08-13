import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "bookings.sqlite"));

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL,
    date       TEXT NOT NULL,
    start      TEXT NOT NULL,
    end        TEXT NOT NULL,
    owner      TEXT NOT NULL,
    team       TEXT NOT NULL DEFAULT '',
    purpose    TEXT NOT NULL DEFAULT '회의',
    created_at TEXT NOT NULL
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_room_date ON bookings (room_id, date)");
db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings (date)");

// SSO 도입으로 추가된 컬럼. 기존 DB에는 없을 수 있어 조용히 보강한다.
const bookingColumns = db.prepare("SELECT name FROM pragma_table_info('bookings')").all().map((row) => row.name);
if (!bookingColumns.includes("owner_email")) {
  db.exec("ALTER TABLE bookings ADD COLUMN owner_email TEXT NOT NULL DEFAULT ''");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT PRIMARY KEY,
    user_json  TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

const selectAll = db.prepare(
  "SELECT id, room_id, date, start, end, owner, team, purpose FROM bookings ORDER BY date, start",
);
const selectRange = db.prepare(
  "SELECT id, room_id, date, start, end, owner, team, purpose FROM bookings WHERE date >= ? AND date <= ? ORDER BY date, start",
);
const selectOverlap = db.prepare(
  "SELECT id, room_id, date, start, end, owner FROM bookings WHERE room_id = ? AND date = ? AND start < ? AND end > ? LIMIT 1",
);
const selectById = db.prepare("SELECT id, owner, owner_email FROM bookings WHERE id = ?");
const insertBooking = db.prepare(
  "INSERT INTO bookings (id, room_id, date, start, end, owner, owner_email, team, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const deleteById = db.prepare("DELETE FROM bookings WHERE id = ?");
const countAll = db.prepare("SELECT COUNT(*) AS total FROM bookings");

const insertSession = db.prepare("INSERT INTO sessions (sid, user_json, expires_at) VALUES (?, ?, ?)");
const selectSession = db.prepare("SELECT user_json, expires_at FROM sessions WHERE sid = ?");
const removeSession = db.prepare("DELETE FROM sessions WHERE sid = ?");
const purgeSessions = db.prepare("DELETE FROM sessions WHERE expires_at < ?");
const selectMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
const upsertMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

/** DB 행(snake_case)을 프런트엔드 Booking 형태(camelCase)로 변환. */
const toBooking = (row) => ({
  id: row.id,
  roomId: row.room_id,
  date: row.date,
  start: row.start,
  end: row.end,
  owner: row.owner,
  team: row.team || undefined,
  purpose: row.purpose,
});

export function listBookings({ from, to } = {}) {
  const rows = from && to ? selectRange.all(from, to) : selectAll.all();
  return rows.map(toBooking);
}

export function countBookings() {
  return Number(countAll.get().total);
}

/**
 * 여러 날짜(반복 예약)를 하나의 트랜잭션으로 등록한다.
 * 하나라도 시간이 겹치면 전체를 취소하고 겹친 예약을 돌려준다.
 * (프런트엔드도 같은 검사를 하지만, 두 사람이 동시에 누르는 경우의
 *  최종 판정은 반드시 서버가 한다.)
 */
export function createBookings({ roomId, dates, start, end, owner, ownerEmail = "", team, purpose }) {
  const createdAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const created = [];
    for (const date of dates) {
      const clash = selectOverlap.get(roomId, date, end, start);
      if (clash) {
        db.exec("ROLLBACK");
        return { ok: false, conflict: toBooking({ ...clash, team: "", purpose: "" }) };
      }
      const id = `bk-${crypto.randomUUID()}`;
      insertBooking.run(id, roomId, date, start, end, owner, ownerEmail, team, purpose, createdAt);
      created.push({ id, roomId, date, start, end, owner, team: team || undefined, purpose });
    }
    db.exec("COMMIT");
    return { ok: true, created };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 예약 취소. SSO 모드에서는 로그인 이메일로, 익명 모드에서는 이름으로 본인을 확인한다.
 * (과거 데이터는 owner_email이 비어 있을 수 있어 그때는 이름 비교로 폴백)
 */
export function deleteBooking(id, { owner = "", ownerEmail = "" } = {}) {
  const row = selectById.get(id);
  if (!row) return { ok: false, reason: "not-found" };
  const authorized = ownerEmail && row.owner_email
    ? row.owner_email === ownerEmail
    : row.owner === owner;
  if (!authorized) return { ok: false, reason: "forbidden" };
  deleteById.run(id);
  return { ok: true };
}

/* --- 세션/메타 (SSO용) -------------------------------------------------- */

export function createSession(user, days) {
  purgeSessions.run(new Date().toISOString());
  const sid = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  insertSession.run(sid, JSON.stringify(user), expiresAt);
  return sid;
}

export function getSession(sid) {
  const row = selectSession.get(sid);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    removeSession.run(sid);
    return null;
  }
  try {
    return JSON.parse(row.user_json);
  } catch {
    return null;
  }
}

export function deleteSession(sid) {
  removeSession.run(sid);
}

export function getMetaValue(key) {
  return selectMeta.get(key)?.value ?? null;
}

export function setMetaValue(key, value) {
  upsertMeta.run(key, value);
}
