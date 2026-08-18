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
// 참석자 목록. JSON 배열 문자열로 담는다(이름에 쉼표가 있어도 안전하다).
if (!bookingColumns.includes("attendees")) {
  db.exec("ALTER TABLE bookings ADD COLUMN attendees TEXT NOT NULL DEFAULT '[]'");
}
// 비품 요청. { "camera": 1, "laptop": 2 } 형태의 JSON 객체 문자열.
if (!bookingColumns.includes("equipment")) {
  db.exec("ALTER TABLE bookings ADD COLUMN equipment TEXT NOT NULL DEFAULT '{}'");
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
  "SELECT id, room_id, date, start, end, owner, team, purpose, attendees, equipment FROM bookings ORDER BY date, start",
);
const selectRange = db.prepare(
  "SELECT id, room_id, date, start, end, owner, team, purpose, attendees, equipment FROM bookings WHERE date >= ? AND date <= ? ORDER BY date, start",
);
const selectOverlap = db.prepare(
  "SELECT id, room_id, date, start, end, owner FROM bookings WHERE room_id = ? AND date = ? AND start < ? AND end > ? LIMIT 1",
);
const selectById = db.prepare("SELECT id, owner, owner_email FROM bookings WHERE id = ?");
// 수정할 때는 자기 자신을 겹침 검사에서 빼야 한다.
const selectOverlapExcept = db.prepare(
  "SELECT id, room_id, date, start, end, owner FROM bookings WHERE room_id = ? AND date = ? AND start < ? AND end > ? AND id <> ? LIMIT 1",
);
const selectFullById = db.prepare(
  "SELECT id, room_id, date, start, end, owner, owner_email, team, purpose, attendees, equipment FROM bookings WHERE id = ?",
);
const updateById = db.prepare(
  "UPDATE bookings SET room_id = ?, date = ?, start = ?, end = ?, team = ?, purpose = ?, attendees = ?, equipment = ? WHERE id = ?",
);
const insertBooking = db.prepare(
  "INSERT INTO bookings (id, room_id, date, start, end, owner, owner_email, team, purpose, attendees, equipment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
/** 같은 날 같은 시간대에 걸친 예약들의 비품 요청. 남은 재고를 셀 때 쓴다. */
const selectEquipmentInSlot = db.prepare(
  "SELECT id, equipment FROM bookings WHERE date = ? AND start < ? AND end > ?",
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

/** 비품 칸은 { id: 수량 } JSON 객체다. 깨진 값이나 옛 행은 빈 객체로 돌려준다. */
const parseEquipment = (value) => {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, count]) => Number.isInteger(count) && count > 0),
    );
  } catch {
    return {};
  }
};

/**
 * 그 시간대에 이미 요청된 비품 수량. 회의실과 무관하게 사무실 전체에서 센다
 * (화상카메라 한 대를 두 회의실이 동시에 쓸 수는 없다).
 * exceptId는 수정할 때 자기 자신을 빼기 위한 것.
 */
export function equipmentUsedInSlot({ date, start, end, exceptId = null }) {
  const used = {};
  for (const row of selectEquipmentInSlot.all(date, end, start)) {
    if (exceptId && row.id === exceptId) continue;
    for (const [id, count] of Object.entries(parseEquipment(row.equipment))) {
      used[id] = (used[id] ?? 0) + count;
    }
  }
  return used;
}

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
  attendees: parseAttendees(row.attendees),
  equipment: parseEquipment(row.equipment),
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
export function createBookings({ roomId, dates, start, end, owner, ownerEmail = "", team, purpose, attendees = [], equipment = {}, equipmentStock = new Map() }) {
  const createdAt = new Date().toISOString();
  const attendeesJson = JSON.stringify(attendees);
  const equipmentJson = JSON.stringify(equipment);
  db.exec("BEGIN IMMEDIATE");
  try {
    // 먼저 모든 날짜를 훑어 안 되는 날을 전부 모은다. 첫 번째만 알려 주면
    // 반복 예약에서 사용자가 몇 번이고 다시 시도해야 한다.
    const blocked = [];
    for (const date of dates) {
      const clash = selectOverlap.get(roomId, date, end, start);
      if (clash) {
        blocked.push({ date, kind: "conflict", conflict: toBooking({ ...clash, team: "", purpose: "" }) });
        continue;
      }
      // 비품 재고도 트랜잭션 안에서 본다. 동시에 두 사람이 마지막 한 대를 잡지 못하게.
      const used = equipmentUsedInSlot({ date, start, end });
      for (const [id, count] of Object.entries(equipment)) {
        const left = (equipmentStock.get(id) ?? 0) - (used[id] ?? 0);
        if (count > left) {
          blocked.push({ date, kind: "shortage", shortage: { id, date, wanted: count, left: Math.max(0, left) } });
          break;
        }
      }
    }
    if (blocked.length > 0) {
      db.exec("ROLLBACK");
      return { ok: false, blocked };
    }

    const created = [];
    for (const date of dates) {
      const id = `bk-${crypto.randomUUID()}`;
      insertBooking.run(id, roomId, date, start, end, owner, ownerEmail, team, purpose, attendeesJson, equipmentJson, createdAt);
      created.push({ id, roomId, date, start, end, owner, team: team || undefined, purpose, attendees, equipment });
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
const isOwner = (row, { owner = "", ownerEmail = "" }) =>
  (ownerEmail && row.owner_email ? row.owner_email === ownerEmail : row.owner === owner);

export function deleteBooking(id, identity = {}) {
  const row = selectById.get(id);
  if (!row) return { ok: false, reason: "not-found" };
  if (!isOwner(row, identity)) return { ok: false, reason: "forbidden" };
  deleteById.run(id);
  return { ok: true };
}

/**
 * 예약 내용 수정. 본인 확인은 취소와 같은 규칙을 쓴다.
 * 참석자를 넘기지 않으면 기존 값을 그대로 둔다.
 */
export function updateBooking(id, identity = {}, patch, { equipmentStock = new Map(), today = "" } = {}) {
  const row = selectFullById.get(id);
  if (!row) return { ok: false, reason: "not-found" };
  if (!isOwner(row, identity)) return { ok: false, reason: "forbidden" };

  // 지난 날짜로 옮기는 것만 막는다. 이미 지나간 예약의 내용을 고치거나
  // 회의를 일찍 끝내는 것(날짜가 그대로인 수정)은 그대로 되어야 한다.
  if (today && patch.date < today && patch.date !== row.date) {
    return { ok: false, reason: "past" };
  }

  const attendees = patch.attendees ?? parseAttendees(row.attendees);
  const equipment = patch.equipment ?? parseEquipment(row.equipment);

  // 겹침과 비품 재고를 한 트랜잭션 안에서 본다. 등록할 때와 같은 규칙이어야
  // 수정을 통해 남이 쓰는 비품을 가져가는 일이 생기지 않는다.
  db.exec("BEGIN IMMEDIATE");
  try {
    const clash = selectOverlapExcept.get(patch.roomId, patch.date, patch.end, patch.start, id);
    if (clash) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "conflict", conflict: toBooking({ ...clash, team: "", purpose: "" }) };
    }

    // 옮겨 간 시간대 기준으로 다시 센다. 자기 자신이 쓰던 몫은 빼고 본다.
    const used = equipmentUsedInSlot({ date: patch.date, start: patch.start, end: patch.end, exceptId: id });
    for (const [itemId, count] of Object.entries(equipment)) {
      const left = (equipmentStock.get(itemId) ?? 0) - (used[itemId] ?? 0);
      if (count > left) {
        db.exec("ROLLBACK");
        return { ok: false, reason: "shortage", shortage: { id: itemId, date: patch.date, wanted: count, left: Math.max(0, left) } };
      }
    }

    updateById.run(
      patch.roomId, patch.date, patch.start, patch.end,
      patch.team, patch.purpose, JSON.stringify(attendees), JSON.stringify(equipment), id,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    ok: true,
    booking: toBooking({
      ...row, ...patch, room_id: patch.roomId,
      attendees: JSON.stringify(attendees), equipment: JSON.stringify(equipment),
    }),
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
