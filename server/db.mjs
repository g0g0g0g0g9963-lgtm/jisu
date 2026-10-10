import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { siteConfig } from "./config.mjs";

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
export const dataDirectory = dataDir;
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "bookings.sqlite"));
// Shared connection keeps reservation changes and their calendar outbox atomic.
export const database = db;

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
// Preserve stable account identity and exact repeated-booking membership.
if (!bookingColumns.includes("owner_id")) {
  db.exec("ALTER TABLE bookings ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
}
if (!bookingColumns.includes("series_id")) {
  db.exec("ALTER TABLE bookings ADD COLUMN series_id TEXT");
}
// 참석자 목록은 JSON 배열로 보관한다.
if (!bookingColumns.includes("attendees")) {
  db.exec("ALTER TABLE bookings ADD COLUMN attendees TEXT NOT NULL DEFAULT '[]'");
}
if (!bookingColumns.includes("attendee_accounts")) {
  db.exec("ALTER TABLE bookings ADD COLUMN attendee_accounts TEXT NOT NULL DEFAULT '[]'");
}
if (!bookingColumns.includes("revision")) {
  db.exec("ALTER TABLE bookings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
}
// A released ongoing reservation remains as immutable usage history.
if (!bookingColumns.includes("ended_at")) {
  db.exec("ALTER TABLE bookings ADD COLUMN ended_at TEXT");
}
// A kiosk name is self-reported, never a verified employee identity.
if (!bookingColumns.includes("source")) {
  db.exec("ALTER TABLE bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'site'");
}
db.exec(`CREATE TABLE IF NOT EXISTS kiosk_requests (
  device_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(device_id, request_key)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS kiosk_devices (
  device_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
)`);

export function createKioskDevice(deviceId, expiresAt) {
  db.prepare("INSERT INTO kiosk_devices(device_id,expires_at) VALUES(?,?)").run(deviceId, expiresAt);
}
export function kioskDeviceActive(deviceId, expiresAt, now) {
  const row = db.prepare("SELECT expires_at,revoked FROM kiosk_devices WHERE device_id=?").get(deviceId);
  return Boolean(row && !row.revoked && row.expires_at === expiresAt && row.expires_at > now);
}
export function revokeKioskDevice(deviceId) {
  db.prepare("UPDATE kiosk_devices SET revoked=1 WHERE device_id=?").run(deviceId);
}
db.exec(`CREATE TABLE IF NOT EXISTS calendar_jobs (
  booking_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, desired_json TEXT,
  version INTEGER NOT NULL DEFAULT 1, synced_version INTEGER NOT NULL DEFAULT 0,
  event_id TEXT, transaction_id TEXT NOT NULL, first_payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_jobs_due ON calendar_jobs(status, next_attempt);
CREATE INDEX IF NOT EXISTS idx_calendar_jobs_owner_updated ON calendar_jobs(owner_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS room_favorites (owner_id TEXT NOT NULL, room_id TEXT NOT NULL, PRIMARY KEY(owner_id,room_id));
CREATE TABLE IF NOT EXISTS microsoft_connections (owner_id TEXT PRIMARY KEY, encrypted_tokens TEXT NOT NULL);`);

const queueCalendar = (row, cancelled = false) => {
  if (!row.owner_id) return;
  // Calendar payload excludes participant details; this is an owner-only appointment.
  const desired = cancelled ? null : JSON.stringify({ id: row.id, roomId: row.room_id,
    date: row.date, start: row.start, end: row.end, purpose: row.purpose });
  db.prepare(`INSERT INTO calendar_jobs(booking_id,owner_id,desired_json,transaction_id,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET desired_json=excluded.desired_json,
    version=calendar_jobs.version+1,status='pending',attempts=0,next_attempt=0,error_code='',updated_at=excluded.updated_at`)
    .run(row.id,row.owner_id,desired,crypto.randomUUID(),new Date().toISOString());
};

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
  "SELECT * FROM bookings ORDER BY date, start",
);
const selectRange = db.prepare(
  "SELECT * FROM bookings WHERE date >= ? AND date <= ? ORDER BY date, start",
);
const selectOverlap = db.prepare(
  "SELECT id, room_id, date, start, end, owner FROM bookings WHERE room_id = ? AND date = ? AND start < ? AND end > ? LIMIT 1",
);
const selectById = db.prepare("SELECT id, owner, owner_id, owner_email, date, end FROM bookings WHERE id = ?");
// 수정할 때는 자기 자신을 겹침 검사에서 빼야 한다.
const selectOverlapExcept = db.prepare(
  "SELECT id, room_id, date, start, end, owner FROM bookings WHERE room_id = ? AND date = ? AND start < ? AND end > ? AND id <> ? LIMIT 1",
);
const selectFullById = db.prepare(
  "SELECT * FROM bookings WHERE id = ?",
);
const updateById = db.prepare(
  "UPDATE bookings SET room_id = ?, date = ?, start = ?, end = ?, team = ?, purpose = ?, attendees = ?, revision = revision + 1 WHERE id = ? AND revision = ?",
);
const insertBooking = db.prepare(
  "INSERT INTO bookings (id, room_id, date, start, end, owner, owner_id, owner_email, series_id, team, purpose, attendees, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const deleteById = db.prepare("DELETE FROM bookings WHERE id = ?");
const countAll = db.prepare("SELECT COUNT(*) AS total FROM bookings");

const insertSession = db.prepare("INSERT INTO sessions (sid, user_json, expires_at) VALUES (?, ?, ?)");
const selectSession = db.prepare("SELECT user_json, expires_at FROM sessions WHERE sid = ?");
const removeSession = db.prepare("DELETE FROM sessions WHERE sid = ?");
const purgeSessions = db.prepare("DELETE FROM sessions WHERE expires_at < ?");
const selectMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
const upsertMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

// Minimal audit data only: never persist tokens, meeting purpose text or attendee names.
db.exec(`CREATE TABLE IF NOT EXISTS booking_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, action TEXT NOT NULL, booking_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
  before_json TEXT, after_json TEXT, changed_json TEXT NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_booking_audit_action_id ON booking_audit(action, id)");
const auditInsert = db.prepare("INSERT INTO booking_audit(at, action, booking_id, actor_id, actor_name, before_json, after_json, changed_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const auditSnapshot = (row) => row ? ({roomId:row.room_id, date:row.date, start:row.start, end:row.end,
  ...(row.ended_at ? {endedAt:row.ended_at} : {})}) : null;
const writeAudit = (action, row, after, identity, changed = []) => auditInsert.run(
  new Date().toISOString(), action, row.id, identity?.kiosk ? `kiosk:${identity.deviceId}` : identity?.sso ? identity.ownerId : "development",
  identity?.kiosk ? "공용 모니터 (예약자 이름 직접 입력)" : identity?.ownerName || row.owner || "개발용 사용자",
  action === "create" ? null : JSON.stringify(auditSnapshot(row)),
  after ? JSON.stringify(auditSnapshot(after)) : null, JSON.stringify(changed),
);

export function listAudit({ before = Number.MAX_SAFE_INTEGER, action = "", limit = 50 } = {}) {
  const rows = db.prepare("SELECT * FROM booking_audit WHERE id < ? AND (? = '' OR action = ?) ORDER BY id DESC LIMIT ?").all(before, action, action, limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(row => ({id:row.id, at:row.at, action:row.action,
    bookingId:row.booking_id, actorId:row.actor_id, actorName:row.actor_name,
    before:JSON.parse(row.before_json || "null"), after:JSON.parse(row.after_json || "null"), changed:JSON.parse(row.changed_json)}));
  return { items, nextCursor: more ? items.at(-1).id : null };
}

export const backupDatabase = (destination) => backup(db, destination);

/** 참석자 칸은 JSON 배열 문자열이다. 옛 행이나 깨진 값이 와도 빈 배열로 돌려준다. */
const parseAttendees = (value) => {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
};

/** DB 행(snake_case)을 프런트엔드 Booking 형태(camelCase)로 변환. */
const toBooking = (row, identity) => ({
  id: row.id,
  revision: row.revision,
  roomId: row.room_id,
  date: row.date,
  start: row.start,
  end: row.end,
  endedAt: row.ended_at || null,
  owner: row.owner,
  source: row.source || "site",
  team: row.team || undefined,
  purpose: row.purpose,
  attendees: parseAttendees(row.attendees),
  // Email/IDs are visible only to the owner, not every viewer of the timetable.
  ...(identity?.sso && isOwner(row, identity) ? { attendeeAccounts: JSON.parse(row.attendee_accounts || "[]") } : {}),
  seriesId: row.series_id || null,
  ...(identity?.sso ? { isMine: isOwner(row, identity) } : {}),
});

export function listBookings({ from, to, identity } = {}) {
  const rows = from && to ? selectRange.all(from, to) : selectAll.all();
  return rows.map((row) => toBooking(row, identity));
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
export function getKioskRequest(deviceId, requestKey) {
  const row = db.prepare("SELECT request_hash, result_json FROM kiosk_requests WHERE device_id=? AND request_key=?").get(deviceId, requestKey);
  return row ? { hash: row.request_hash, result: JSON.parse(row.result_json) } : null;
}

export function createBookings({ roomId, dates, start, end, owner, ownerId = "", ownerEmail = "", team = "", purpose, attendees = [], attendeeAccounts = [], identity, kioskRequest }) {
  const createdAt = new Date().toISOString();
  const attendeesJson = JSON.stringify(attendees);
  const seriesId = dates.length > 1 ? "series-" + crypto.randomUUID() : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (kioskRequest) {
      const previous = getKioskRequest(kioskRequest.deviceId, kioskRequest.key);
      if (previous) {
        db.exec("ROLLBACK");
        return previous.hash === kioskRequest.hash ? { ...previous.result, replayed: true } : { ok: false, reason: "idempotency-conflict" };
      }
      // Never allow a typed kiosk name to acquire a personal account's privileges.
      if (!identity?.kiosk || !identity.deviceId || identity.deviceId !== kioskRequest.deviceId || ownerId || ownerEmail) {
        throw new Error("Invalid kiosk booking identity");
      }
    }
    // 먼저 모든 날짜를 훑어 안 되는 날을 전부 모은다. 첫 번째만 알려 주면
    // 반복 예약에서 사용자가 몇 번이고 다시 시도해야 한다.
    const blocked = [];
    for (const date of dates) {
      const clash = selectOverlap.get(roomId, date, end, start);
      if (clash) {
        blocked.push({ date, kind: "conflict", conflict: toBooking({ ...clash, team: "", purpose: "" }) });
      }
    }
    if (blocked.length > 0) {
      db.exec("ROLLBACK");
      return { ok: false, blocked };
    }

    const created = [];
    for (const date of dates) {
      const id = `bk-${crypto.randomUUID()}`;
      insertBooking.run(id, roomId, date, start, end, owner, ownerId, ownerEmail, seriesId, team, purpose, attendeesJson, createdAt);
      const source = kioskRequest ? "kiosk" : "site";
      if (source === "kiosk") db.prepare("UPDATE bookings SET source='kiosk' WHERE id=?").run(id);
      db.prepare("UPDATE bookings SET attendee_accounts=? WHERE id=?").run(JSON.stringify(attendeeAccounts),id);
      queueCalendar({id,room_id:roomId,date,start,end,owner_id:ownerId,purpose});
      const auditRow = {id,room_id:roomId,date,start,end,owner};
      writeAudit("create", auditRow, auditRow, identity);
      created.push(toBooking({ id, room_id: roomId, date, start, end, owner, owner_id: ownerId,
        owner_email: ownerEmail, source, series_id: seriesId, revision: 1, team, purpose, attendees: attendeesJson, attendee_accounts: JSON.stringify(attendeeAccounts) }, identity));
    }
    const result = { ok: true, created };
    if (kioskRequest) db.prepare("INSERT INTO kiosk_requests(device_id,request_key,request_hash,result_json,created_at) VALUES(?,?,?,?,?)")
      .run(kioskRequest.deviceId, kioskRequest.key, kioskRequest.hash, JSON.stringify({ ok: true,
        created: created.map(({ id, roomId, date, start, end, owner }) => ({ id, roomId, date, start, end, owner })) }), createdAt);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** SSO identity never falls back to a display name. Email is only for rows without an ID. */
const normalized = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
const isOwner = (row, { owner = "", ownerId = "", ownerEmail = "", sso = false } = {}) => {
  if (row.source === "kiosk") return false;
  if (sso) {
    const storedId = normalized(row.owner_id);
    if (storedId) return Boolean(normalized(ownerId)) && storedId === normalized(ownerId);
    const storedEmail = normalized(row.owner_email);
    return Boolean(storedEmail && normalized(ownerEmail)) && storedEmail === normalized(ownerEmail);
  }
  return Boolean(owner) && row.owner === owner;
};
const hasEnded = (row, today, now) => Boolean(row.ended_at) || (Boolean(today) &&
  (row.date < today || (row.date === today && Boolean(now) && row.end <= now)));

export function deleteBooking(id, identity = {}, limits = {}) {
  // Read and authorize under the write lock so an intervening edit cannot be lost.
  db.exec("BEGIN IMMEDIATE");
  const reject = (reason) => {
    db.exec("ROLLBACK");
    return { ok: false, reason };
  };
  try {
    const row = selectFullById.get(id);
    if (!row) return reject("not-found");
    if (!isOwner(row, identity)) return reject("forbidden");
    // Retrying a completed request must never delete or trim its retained history.
    if (row.ended_at) {
      db.exec("COMMIT");
      return { ok: true, action: "unchanged", booking: toBooking(row, identity) };
    }
    // The API supplies a clock callback: take the time after acquiring the lock.
    const { today = "", now = "", nowSeconds = 0 } = typeof limits === "function" ? limits() : limits;
    if (hasEnded(row, today, now)) return reject("past");
    const minuteOf = (time) => {
      const [hours, minutes] = time.split(":").map(Number);
      return hours * 60 + minutes;
    };
    const nowMinute = now ? minuteOf(now) + nowSeconds / 60 : null;
    const hasStarted = row.date === today && nowMinute !== null && minuteOf(row.start) < nowMinute;
    if (hasStarted) {
      const { openingTime, slotMinutes } = siteConfig.booking;
      const firstMinute = minuteOf(openingTime);
      const releaseMinute = Math.min(minuteOf(row.end), firstMinute + Math.ceil((nowMinute - firstMinute) / slotMinutes) * slotMinutes);
      const end = `${String(Math.floor(releaseMinute / 60)).padStart(2, "0")}:${String(releaseMinute % 60).padStart(2, "0")}`;
      const after = { ...row, end, ended_at: new Date().toISOString(), revision: row.revision + 1 };
      const changed = ["end", "ended_at"].filter((key) => row[key] !== after[key]);
      db.prepare("UPDATE bookings SET end = ?, ended_at = ?, revision = revision + 1 WHERE id = ?")
        .run(after.end, after.ended_at, id);
      // Keep the shortened Outlook appointment as history; do not cancel it.
      queueCalendar(after);
      writeAudit("update", row, after, identity, changed);
      db.exec("COMMIT");
      return { ok: true, action: "ended", booking: toBooking(after, identity) };
    }
    deleteById.run(id);
    queueCalendar(row, true);
    writeAudit("cancel", row, null, identity);
    db.exec("COMMIT");
    return { ok: true, action: "deleted" };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/**
 * 예약 내용 수정. 본인 확인은 취소와 같은 규칙을 쓴다.
 * 참석자를 넘기지 않으면 기존 값을 그대로 둔다.
 */
export function updateBooking(id, identity = {}, patch, { today = "", now = "", maxDate = "" } = {}) {
  // Read, authorize and compare under the same write lock, including across workers.
  db.exec("BEGIN IMMEDIATE");
  const reject = (reason, extra = {}) => {
    db.exec("ROLLBACK");
    return { ok: false, reason, ...extra };
  };
  try {
    const row = selectFullById.get(id);
    if (!row) return reject("not-found");
    if (!isOwner(row, identity)) return reject("forbidden");
    if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 1) return reject("revision-required");
    if (patch.expectedRevision !== row.revision) return reject("stale", { latest: toBooking(row, identity) });
    if (hasEnded(row, today, now)) return reject("past");
    if (today && patch.date < today) return reject("past");
    if (maxDate && patch.date > maxDate) return reject("too-far");
    if (today && now && patch.date === today && patch.start < now) {
      const sameOngoingStart = row.date === today && row.start < now && row.end > now &&
        patch.roomId === row.room_id && patch.start === row.start;
      if (!sameOngoingStart || patch.end < now) return reject("past-time");
    }
    const team = patch.team ?? row.team;
    const purpose = patch.purpose ?? row.purpose;
    const attendees = patch.attendees ?? parseAttendees(row.attendees);
    const clash = selectOverlapExcept.get(patch.roomId, patch.date, patch.end, patch.start, id);
    if (clash) {
      return reject("conflict", { conflict: toBooking({ ...clash, team: "", purpose: "" }) });
    }

    const updated = updateById.run(
      patch.roomId, patch.date, patch.start, patch.end,
      team, purpose, JSON.stringify(attendees), id, patch.expectedRevision,
    );
    if (updated.changes !== 1) throw new Error("Booking revision update failed");
    const after = {...row,revision:row.revision+1,room_id:patch.roomId,date:patch.date,start:patch.start,end:patch.end,team,purpose,attendees:JSON.stringify(attendees)};
    if (patch.attendeeAccounts !== undefined) {
      after.attendee_accounts = JSON.stringify(patch.attendeeAccounts);
      db.prepare("UPDATE bookings SET attendee_accounts=? WHERE id=?").run(after.attendee_accounts,id);
    }
    queueCalendar(after);
    const changed = ["room_id","date","start","end","team","purpose","attendees","attendee_accounts"].filter(key => row[key] !== after[key]);
    writeAudit("update", row, after, identity, changed);
    db.exec("COMMIT");
    return { ok: true, booking: toBooking(after, identity) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
