import { createHash } from "node:crypto";
import { database } from "./db.mjs";
import { roomsConfig, siteConfig } from "./config.mjs";

const DAY_MS = 86_400_000;
const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: siteConfig.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
});
// The existing date index bounds this read. Audit entries must not inflate usage.
const selectUsage = database.prepare(`SELECT room_id, start, end, owner, owner_id, owner_email
  FROM bookings WHERE date >= ? AND date <= ? ORDER BY created_at DESC, id DESC`);
const normalized = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
const trimmed = (value) => typeof value === "string" ? value.trim() : "";
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byUsage = (a, b) => b.bookings - a.bookings || b.bookedMinutes - a.bookedMinutes;
const dateMillis = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const millis = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value ? millis : NaN;
};

export function usageRange(query, at = new Date()) {
  let { from, to } = query;
  if (from === undefined && to === undefined) {
    const parts = Object.fromEntries(dateFormatter.formatToParts(at).map(({ type, value }) => [type, value]));
    to = `${parts.year}-${parts.month}-${parts.day}`;
    from = new Date(dateMillis(to) - 29 * DAY_MS).toISOString().slice(0, 10);
  }
  // Arrays (duplicate parameters), partial ranges and impossible dates are rejected.
  const start = dateMillis(from), end = dateMillis(to);
  const days = (end - start) / DAY_MS + 1;
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new RangeError("조회 시작일과 종료일을 YYYY-MM-DD 형식으로 지정해 주세요. 최대 366일까지 조회할 수 있습니다.");
  }
  return { from, to, days };
}

const minuteOf = (value, allowClosing = false) => {
  if (allowClosing && value === "24:00") return 1440;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
};

export function bookingUsage(range, at = new Date()) {
  const rows = selectUsage.all(range.from, range.to);
  const rooms = new Map(roomsConfig.map(room => [room.id, {
    roomId: room.id, name: room.name, floor: Number.isInteger(room.floor) ? room.floor : null,
    bookings: 0, bookedMinutes: 0,
  }]));
  const users = new Map();
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour, label: `${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00`,
    bookings: 0, bookedMinutes: 0,
  }));
  let bookedMinutes = 0, unidentifiedBookings = 0;
  for (const row of rows) {
    const start = minuteOf(row.start), end = minuteOf(row.end, true);
    // Legacy malformed intervals still count as records, but never invent usage time.
    const duration = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0;
    bookedMinutes += duration;
    if (!rooms.has(row.room_id)) rooms.set(row.room_id, {
      roomId: row.room_id, name: `미등록 회의실 (${row.room_id})`, floor: null, bookings: 0, bookedMinutes: 0,
    });
    const room = rooms.get(row.room_id);
    room.bookings += 1;
    room.bookedMinutes += duration;

    const ownerId = normalized(row.owner_id), email = normalized(row.owner_email);
    const identity = ownerId ? `oid:${ownerId}` : email ? `email:${email}` : "";
    if (identity) {
      if (!users.has(identity)) users.set(identity, {
        key: createHash("sha256").update(identity).digest("hex"),
        name: trimmed(row.owner) || "이름 미등록", email, bookings: 0, bookedMinutes: 0,
      });
      const user = users.get(identity);
      user.bookings += 1;
      user.bookedMinutes += duration;
    } else unidentifiedBookings += 1;

    if (duration > 0) {
      for (const bucket of hours) {
        const minutes = Math.max(0, Math.min(end, (bucket.hour + 1) * 60) - Math.max(start, bucket.hour * 60));
        if (minutes > 0) {
          bucket.bookings += 1;
          bucket.bookedMinutes += minutes;
        }
      }
    }
  }
  const peakHour = [...hours].sort((a, b) => byUsage(a, b) || a.hour - b.hour)[0];
  return {
    at: at.toISOString(), timeZone: siteConfig.timeZone, range,
    summary: { bookings: rows.length, identifiedUsers: users.size, unidentifiedBookings, bookedMinutes },
    users: [...users.values()].sort((a, b) => byUsage(a, b) || compareText(a.name, b.name) || compareText(a.key, b.key)).slice(0, 10),
    rooms: [...rooms.values()].sort((a, b) => byUsage(a, b) || compareText(a.name, b.name) || compareText(a.roomId, b.roomId)),
    hours, peakHour: peakHour.bookings ? peakHour : null,
  };
}

// Register only after the server's /api/admin authentication and role middleware.
export function registerAdminUsageRoute(app) {
  app.get("/api/admin/usage", (req, res) => {
    const at = new Date();
    let range;
    try { range = usageRange(req.query, at); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      res.status(400).json({ error: error.message });
      return;
    }
    res.json(bookingUsage(range, at));
  });
}
