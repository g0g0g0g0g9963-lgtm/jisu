// Isolated synthetic-only API regression tests. Never opens the live data directory.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import net from "node:net";

const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, "data-qa-admin-usage", String(Date.now()));
mkdirSync(run, { recursive: true });
const rooms = JSON.parse(readFileSync(resolve(root, "app/config/rooms.json"), "utf8"));
const children = [], databases = [], results = [];
const record = (name, ok) => { assert.ok(ok, name); results.push(name); console.log("PASS " + name); };
const pause = ms => new Promise(r => setTimeout(r, ms));
async function freePort() {
  const socket = net.createServer(); await new Promise(r => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port; await new Promise(r => socket.close(r)); return port;
}
async function start(mode = "sso", extra = {}) {
  const port = await freePort(), base = "http://127.0.0.1:" + port, data = resolve(run, mode);
  mkdirSync(data, { recursive: true });
  const env = { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), DATA_DIR: data,
    CLIENT_DIR: resolve(root, "dist"), ALLOW_ANONYMOUS: "", SEED_DEMO: "0", SESSION_SECRET: "qa-only",
    MS_TENANT_ID: "qa-tenant", MS_CLIENT_ID: "qa-client", MS_CLIENT_SECRET: "qa-only", APP_BASE_URL: base,
    ADMIN_MS_EMAIL: "alice@example.invalid", ADMIN_MS_OBJECT_ID: "", BACKUP_DIR: "", BACKUP_INTERVAL_MINUTES: "0",
    TEST_FIXTURE_SSO: "0", TEST_FIXTURE_BOUNDARIES: "0", TEST_NOW: "2026-10-09T01:15:00Z", ...extra };
  const child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "qa-preload.mjs")).href, "server/index.mjs"],
    { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let logs = "";
  child.stdout.on("data", x => logs += x); child.stderr.on("data", x => logs += x);
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error(logs);
    try { if ((await fetch(base + "/api/health")).ok) return { base, data, child }; } catch {}
    await pause(100);
  }
  throw Error("Startup timeout " + logs);
}
async function req(s, path, { cookie, method = "GET", body } = {}) {
  const r = await fetch(s.base + path, { method, redirect: "manual",
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function login(s, code) {
  const begin = await req(s, "/auth/login?returnTo=/admin");
  const state = new URL(begin.headers.get("location")).searchParams.get("state");
  const cookie = begin.headers.getSetCookie()[0].split(";")[0];
  const end = await req(s, "/auth/callback?state=" + state + "&code=" + code, { cookie });
  assert.equal(end.status, 302);
  return end.headers.getSetCookie().find(v => v.startsWith("bdo-session=") && !v.startsWith("bdo-session=;")).split(";")[0];
}

try {
  const s = await start(), alice = await login(s, "alice"), bob = await login(s, "bob"), spoof = await login(s, "spoof");
  record("unauthenticated SSO requests require login", (await req(s, "/api/admin/usage")).status === 401);
  record("ordinary employee cannot read usage", (await req(s, "/api/admin/usage", { cookie: bob })).status === 403);
  const first = await req(s, "/api/admin/usage", { cookie: alice });
  record("admin usage is authorized and never cached", first.status === 200 && first.headers.get("cache-control") === "no-store");
  record("reused email with another OID cannot read usage", (await req(s, "/api/admin/usage", { cookie: spoof })).status === 403);
  record("default range includes today and previous 29 days in Seoul", first.json.timeZone === "Asia/Seoul" && first.json.range.from === "2026-09-10" && first.json.range.to === "2026-10-09" && first.json.range.days === 30);
  record("empty stats include all configured rooms and 24 zero hours", first.json.summary.bookings === 0 && first.json.users.length === 0 && first.json.rooms.length === rooms.length && first.json.rooms.every(v => v.bookings === 0) && first.json.hours.length === 24 && first.json.hours.every(v => v.bookings === 0) && first.json.peakHour === null);
  for (const query of ["from=2026-10-01", "to=2026-10-09", "from=&to=", "from=2026-02-30&to=2026-03-01", "from=2026-2-01&to=2026-03-01", "from=2026-10-10&to=2026-10-09", "from=2025-01-01&to=2026-01-02", "from=2026-10-01&from=2026-10-01&to=2026-10-09", "from=2026-10-01&to=2026-10-09&to=2026-10-09", "from=2026-10-01%20&to=2026-10-09", "from=not-a-date&to=2026-10-09"]) {
    record("invalid range is rejected: " + query, (await req(s, "/api/admin/usage?" + query, { cookie: alice })).status === 400);
  }
  record("366 inclusive days accepted", (await req(s, "/api/admin/usage?from=2024-01-01&to=2024-12-31", { cookie: alice })).json.range.days === 366);
  record("one-day range accepted", (await req(s, "/api/admin/usage?from=2026-10-09&to=2026-10-09", { cookie: alice })).json.range.days === 1);
  const midnight = await start("seoul-date", { TEST_NOW: "2026-10-08T16:10:00Z" });
  const midnightUser = await login(midnight, "alice");
  record("default date uses business timezone not server UTC date", (await req(midnight, "/api/admin/usage", { cookie: midnightUser })).json.range.to === "2026-10-09");
  const anon = await start("anonymous", { ALLOW_ANONYMOUS: "1", MS_TENANT_ID: "", MS_CLIENT_ID: "", MS_CLIENT_SECRET: "", APP_BASE_URL: "" });
  record("anonymous preview cannot read administrator usage", (await req(anon, "/api/admin/usage")).status === 403);
  const unconfigured = await start("unconfigured", { ADMIN_MS_EMAIL: "" });
  record("unconfigured admin role defaults to deny", (await req(unconfigured, "/api/admin/usage", { cookie: await login(unconfigured, "alice") })).status === 403);

  const db = new DatabaseSync(resolve(s.data, "bookings.sqlite")); databases.push(db);
  const insert = db.prepare(`INSERT INTO bookings (id,room_id,date,start,end,owner,owner_id,owner_email,created_at,ended_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  function fixture(id, date, start, end, ownerId, email, room = rooms[0].id, ended = null, name = "QA 동명이인") {
    insert.run(id, room, date, start, end, name, ownerId, email, "2026-09-01T00:00:00Z", ended);
  }
  fixture("a-1", "2026-10-01", "11:00", "12:00", " FIXTURE-ALICE ", "alice@example.invalid");
  fixture("a-2", "2026-10-02", "11:30", "12:30", "fixture-alice", "changed@example.invalid");
  fixture("b-1", "2026-10-03", "11:30", "12:00", "fixture-bob", "bob@example.invalid");
  fixture("legacy-1", "2026-10-04", "00:00", "24:00", "", " Legacy@Example.Invalid ", rooms[1].id);
  fixture("legacy-2", "2026-10-05", "23:30", "24:00", "", "legacy@example.invalid", rooms[1].id);
  fixture("anonymous-1", "2026-10-06", "10:00", "11:00", "", "");
  fixture("charlie-1", "2026-10-07", "10:00", "10:30", "fixture-charlie", "alice@example.invalid", "retired-room");
  fixture("ended-1", "2026-10-08", "09:00", "09:30", "fixture-ended", "ended@example.invalid", rooms[0].id, "2026-10-08T00:25:00Z");
  fixture("outside-before", "2026-09-30", "11:00", "12:00", "fixture-alice", "alice@example.invalid");
  fixture("outside-after", "2026-11-01", "11:00", "12:00", "fixture-alice", "alice@example.invalid");
  const path = "/api/admin/usage?from=2026-10-01&to=2026-10-31";
  let usage = (await req(s, path, { cookie: alice })).json;
  record("reservation date inclusively filters rows, not creation date", usage.summary.bookings === 8 && usage.summary.bookedMinutes === 1740);
  record("same name does not merge different stable identities", usage.summary.identifiedUsers === 5 && usage.users.length === 5 && new Set(usage.users.map(u => u.key)).size === 5);
  record("normalized OID combines changed email snapshots", usage.users.some(u => u.bookings === 2 && u.bookedMinutes === 120));
  record("legacy identity uses normalized email only without OID", usage.users.some(u => u.email === "legacy@example.invalid" && u.bookings === 2 && u.bookedMinutes === 1470));
  record("unidentified row remains in totals but not people ranking", usage.summary.unidentifiedBookings === 1 && usage.users.reduce((n, u) => n + u.bookings, 0) === 7);
  record("stable identity key is hashed, not the raw OID", usage.users.every(u => /^[a-f0-9]{64}$/.test(u.key)) && !JSON.stringify(usage).includes("fixture-alice"));
  record("all configured rooms including zero-booking rooms remain", usage.rooms.length === rooms.length + 1 && rooms.every(r => usage.rooms.some(u => u.roomId === r.id)) && usage.rooms.filter(r => r.bookings === 0).length === rooms.length - 2);
  record("retired unknown room has graceful label and null floor", usage.rooms.some(r => r.roomId === "retired-room" && r.floor === null && r.name.includes("미등록") && r.bookings === 1));
  record("room ranking uses booking count before booked minutes", usage.rooms[0].roomId === rooms[0].id && usage.rooms[0].bookings === 5 && usage.rooms[1].bookedMinutes === 1470);
  record("people tie is resolved by booked minutes", usage.users[0].email === "legacy@example.invalid");
  record("11:30 crossing and exclusive 12:00 boundary are correct", usage.hours[11].bookings === 4 && usage.hours[11].bookedMinutes === 180 && usage.hours[12].bookings === 2 && usage.hours[12].bookedMinutes === 90);
  record("full day plus 23:30-24:00 remains within day", usage.hours[0].bookings === 1 && usage.hours[0].bookedMinutes === 60 && usage.hours[23].bookings === 2 && usage.hours[23].bookedMinutes === 90);
  record("peak hour uses count and duration consistently", usage.peakHour.hour === 11 && usage.peakHour.bookings === 4 && usage.peakHour.bookedMinutes === 180);
  record("room and hour minute sums equal overall reserved minutes", usage.rooms.reduce((n, r) => n + r.bookedMinutes, 0) === usage.summary.bookedMinutes && usage.hours.reduce((n, h) => n + h.bookedMinutes, 0) === usage.summary.bookedMinutes);
  record("room counts sum to overall booking count", usage.rooms.reduce((n, r) => n + r.bookings, 0) === usage.summary.bookings);
  record("retained ended history is included", (await req(s, "/api/admin/usage?from=2026-10-08&to=2026-10-08", { cookie: alice })).json.summary.bookings === 1);

  const body = { roomId: rooms[2].id, dates: ["2026-10-12", "2026-10-13"], start: "14:00", end: "15:00", owner: "IGNORED", team: "QA", purpose: "Usage QA" };
  const created = await req(s, "/api/bookings", { cookie: alice, method: "POST", body });
  record("real repeated booking API creates two dates", created.status === 201 && created.json.created.length === 2);
  const ids = created.json.created.map(b => b.id);
  usage = (await req(s, path, { cookie: alice })).json;
  record("each date of repeated reservation adds one booking", usage.summary.bookings === 10 && usage.summary.bookedMinutes === 1860);
  const edited = await req(s, "/api/bookings/" + ids[0], { cookie: alice, method: "PATCH", body: { ...body, date: body.dates[0], expectedRevision: 1, end: "15:30" } });
  record("real edit succeeds", edited.status === 200);
  usage = (await req(s, path, { cookie: alice })).json;
  record("updates change duration but never inflate reservation count", usage.summary.bookings === 10 && usage.summary.bookedMinutes === 1890);
  record("future booking cancellation succeeds", (await req(s, "/api/bookings/" + ids[1], { cookie: alice, method: "DELETE", body: {} })).json.action === "deleted");
  usage = (await req(s, path, { cookie: alice })).json;
  record("cancelled rows are excluded despite their audit events", usage.summary.bookings === 9 && usage.summary.bookedMinutes === 1830 && db.prepare("SELECT COUNT(*) AS n FROM booking_audit").get().n === 4);
  fixture("ongoing", "2026-10-09", "10:00", "12:00", "fixture-alice", "alice@example.invalid", rooms[3].id);
  const stopped = await req(s, "/api/bookings/ongoing", { cookie: alice, method: "DELETE", body: {} });
  record("ongoing deletion retains history to 10:30 boundary", stopped.status === 200 && stopped.json.action === "ended" && stopped.json.booking.end === "10:30");
  usage = (await req(s, path, { cookie: alice })).json;
  record("only retained duration contributes after ongoing deletion", usage.summary.bookings === 10 && usage.summary.bookedMinutes === 1860);
  await req(s, "/api/bookings/ongoing", { cookie: alice, method: "DELETE", body: {} });
  record("repeated cancellation never inflates usage", (await req(s, path, { cookie: alice })).json.summary.bookedMinutes === 1860);

  for (let i = 0; i < 12; i++) fixture("rank-" + i, "2026-12-01", "09:00", "10:00", "rank-" + String(i).padStart(2, "0"), `rank${i}@example.invalid`, rooms[0].id, null, "동일 순위");
  const ranked = (await req(s, "/api/admin/usage?from=2026-12-01&to=2026-12-01", { cookie: alice })).json;
  const rankedAgain = (await req(s, "/api/admin/usage?from=2026-12-01&to=2026-12-01", { cookie: alice })).json;
  record("top ten limit preserves total identified-user count", ranked.users.length === 10 && ranked.summary.identifiedUsers === 12 && ranked.summary.bookings === 12);
  record("equal-rank ordering is stable across reads", JSON.stringify(ranked.users) === JSON.stringify(rankedAgain.users));
  fixture("invalid-time", "2026-12-02", "23:30", "24:30", "", "", rooms[0].id);
  fixture("zero-time", "2026-12-02", "11:30", "11:30", "", "", rooms[0].id);
  fixture("reverse-time", "2026-12-02", "12:00", "11:00", "", "", rooms[0].id);
  const malformed = (await req(s, "/api/admin/usage?from=2026-12-02&to=2026-12-02", { cookie: alice })).json;
  record("legacy malformed or empty intervals never invent negative or excessive minutes", malformed.summary.bookings === 3 && malformed.summary.bookedMinutes === 0 && malformed.hours.every(h => h.bookedMinutes === 0 && h.bookings === 0) && malformed.peakHour === null);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT room_id FROM bookings WHERE date >= ? AND date <= ?").all("2026-10-01", "2026-10-31");
  record("range query uses the existing booking date index", plan.some(p => p.detail.includes("idx_bookings_date")));
  record("synthetic database remains intact", db.prepare("PRAGMA integrity_check").get().integrity_check === "ok");
  writeFileSync(resolve(run, "sample-usage.json"), JSON.stringify(usage, null, 2));
  writeFileSync(resolve(run, "results.json"), JSON.stringify({ passed: results.length, results, evidence: run }, null, 2));
  console.log("RESULT " + results.length + " checks passed; evidence " + run);
} finally {
  for (const db of databases) db.close();
  for (const child of children) child.kill();
}
