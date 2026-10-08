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
  "SELECT id, room_id, date, start, end, owner, owner_id, owner_email, series_id, team, purpose, attendees FROM bookings ORDER BY date, start",
);
const selectRange = db.prepare(
  "SELECT id, room_id, date, start, end, owner, owner_id, owner_email, series_id, team, purpose, attendees FROM bookings WHERE date >= ? AND date <= ? ORDER BY date, start",
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
  "SELECT id, room_id, date, start, end, owner, owner_id, owner_email, series_id, team, purpose, attendees FROM bookings WHERE id = ?",
);
const updateById = db.prepare(
  "UPDATE bookings SET room_id = ?, date = ?, start = ?, end = ?, team = ?, purpose = ?, attendees = ? WHERE id = ?",
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
  roomId: row.room_id,
  date: row.date,
  start: row.start,
  end: row.end,
  owner: row.owner,
  team: row.team || undefined,
  purpose: row.purpose,
  attendees: parseAttendees(row.attendees),
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
export function createBookings({ roomId, dates, start, end, owner, ownerId = "", ownerEmail = "", team = "", purpose, attendees = [], identity }) {
  const createdAt = new Date().toISOString();
  const attendeesJson = JSON.stringify(attendees);
  const seriesId = dates.length > 1 ? "series-" + crypto.randomUUID() : null;
  db.exec("BEGIN IMMEDIATE");
  try {
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
      created.push(toBooking({ id, room_id: roomId, date, start, end, owner, owner_id: ownerId,
        owner_email: ownerEmail, series_id: seriesId, team, purpose, attendees: attendeesJson }, identity));
    }
    db.exec("COMMIT");
    return { ok: true, created };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** SSO identity never falls back to a display name. Email is only for rows without an ID. */
const normalized = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
const isOwner = (row, { owner = "", ownerId = "", ownerEmail = "", sso = false } = {}) => {
  if (sso) {
    const storedId = normalized(row.owner_id);
    if (storedId) return Boolean(normalized(ownerId)) && storedId === normalized(ownerId);
    const storedEmail = normalized(row.owner_email);
    return Boolean(storedEmail && normalized(ownerEmail)) && storedEmail === normalized(ownerEmail);
  }
  return Boolean(owner) && row.owner === owner;
};
const hasEnded = (row, today, now) => Boolean(today) &&
  (row.date < today || (row.date === today && Boolean(now) && row.end <= now));

export function deleteBooking(id, identity = {}, { today = "", now = "" } = {}) {
  const row = selectById.get(id);
  if (!row) return { ok: false, reason: "not-found" };
  if (!isOwner(row, identity)) return { ok: false, reason: "forbidden" };
  // 지난 예약은 취소할 수 없다. 화면에서도 그 버튼을 숨기지만, API를 직접
  // 불러도 막히도록 여기서도 확인한다.
  if (hasEnded(row, today, now)) return { ok: false, reason: "past" };
  deleteById.run(id);
  return { ok: true };
}

/**
 * 예약 내용 수정. 본인 확인은 취소와 같은 규칙을 쓴다.
 * 참석자를 넘기지 않으면 기존 값을 그대로 둔다.
 */
export function updateBooking(id, identity = {}, patch, { today = "", now = "", maxDate = "" } = {}) {
  const row = selectFullById.get(id);
  if (!row) return { ok: false, reason: "not-found" };
  if (!isOwner(row, identity)) return { ok: false, reason: "forbidden" };

  // 이미 지나간 예약은 통째로 고칠 수 없다. 지난 예약은 기록으로 남아야
  // 하고, 지난 날짜로 "옮기는" 것도 같은 이유로 막는다.
  if (hasEnded(row, today, now)) return { ok: false, reason: "past" };
  if (today && patch.date < today) return { ok: false, reason: "past" };
  if (maxDate && patch.date > maxDate) return { ok: false, reason: "too-far" };
  if (today && now && patch.date === today && patch.start < now) {
    // Keep an ongoing booking's room/date/start stable. Its end may move to
    // the current or a future slot; the overlap check below still applies.
    const sameOngoingStart = row.date === today && row.start < now && row.end > now &&
      patch.roomId === row.room_id && patch.start === row.start;
    if (!sameOngoingStart || patch.end < now) {
      return { ok: false, reason: "past-time" };
    }
  }

  const team = patch.team ?? row.team;
  const purpose = patch.purpose ?? row.purpose;
  const attendees = patch.attendees ?? parseAttendees(row.attendees);

  db.exec("BEGIN IMMEDIATE");
  try {
    const clash = selectOverlapExcept.get(patch.roomId, patch.date, patch.end, patch.start, id);
    if (clash) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "conflict", conflict: toBooking({ ...clash, team: "", purpose: "" }) };
    }

    updateById.run(
      patch.roomId, patch.date, patch.start, patch.end,
      team, purpose, JSON.stringify(attendees), id,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    ok: true,
    booking: toBooking({
      ...row, ...patch, room_id: patch.roomId, team, purpose,
      attendees: JSON.stringify(attendees),
    }, identity),
  };
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
