// Synthetic local-only regression suite. It never opens production data or Microsoft.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";

const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, "data-qa-kiosk-api", String(Date.now()));
mkdirSync(run, { recursive: true });
const rooms = JSON.parse(readFileSync(resolve(root, "app/config/rooms.json"), "utf8"));
const code = "synthetic-only-kiosk-pairing-code-" + crypto.randomUUID();
const children = [], databases = [], checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log("PASS " + name); };
const pause = ms => new Promise(r => setTimeout(r, ms));
async function start(name, extra = {}, dataOverride) {
  const socket = net.createServer(); await new Promise(r => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const base = "http://127.0.0.1:" + port, data = dataOverride || resolve(run, name);
  mkdirSync(data, { recursive: true });
  const env = { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), DATA_DIR: data,
    CLIENT_DIR: resolve(root, "dist"), ALLOW_ANONYMOUS: "", SEED_DEMO: "0", SESSION_SECRET: "qa-only",
    MS_TENANT_ID: "qa-tenant", MS_CLIENT_ID: "qa-client", MS_CLIENT_SECRET: "qa-only", APP_BASE_URL: base,
    ADMIN_MS_EMAIL: "alice@example.invalid", ADMIN_MS_OBJECT_ID: "", BACKUP_DIR: "", BACKUP_INTERVAL_MINUTES: "0",
    TEST_FIXTURE_SSO: "0", TEST_FIXTURE_BOUNDARIES: "0", TEST_NOW: "2026-10-12T01:00:00Z",
    KIOSK_ENABLED: "1", KIOSK_PAIRING_CODE: code, ...extra };
  const child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "qa-preload.mjs")).href, "server/index.mjs"],
    { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let log = "";
  child.stdout.on("data", x => log += x); child.stderr.on("data", x => log += x);
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error(log);
    try { if ((await fetch(base + "/api/health")).ok) return { base, data, child, origin: env.APP_BASE_URL || base }; } catch {}
    await pause(100);
  }
  throw Error("Startup timeout: " + log);
}
async function request(s, path, { method = "GET", body, cookie, headers = {} } = {}) {
  const r = await fetch(s.base + path, { method, redirect: "manual", headers: {
    ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function pair(s) {
  const result = await request(s, "/api/kiosk/session", { method: "POST", body: { code }, headers: { origin: s.origin, "x-kiosk-action": "pair" } });
  assert.equal(result.status, 200);
  return { cookie: result.headers.getSetCookie()[0].split(";")[0], csrf: result.json.csrfToken, response: result };
}
async function login(s, name) {
  const begin = await request(s, "/auth/login?returnTo=/admin");
  const state = new URL(begin.headers.get("location")).searchParams.get("state");
  const cookie = begin.headers.getSetCookie()[0].split(";")[0];
  const end = await request(s, "/auth/callback?state=" + state + "&code=" + name, { cookie });
  assert.equal(end.status, 302);
  return end.headers.getSetCookie().find(v => v.startsWith("bdo-session=") && !v.startsWith("bdo-session=;")).split(";")[0];
}
const body = { roomId: rooms[0].id, date: "2026-10-12", start: "11:00", end: "12:00", owner: "QA 직접 입력", purpose: "비공개 시험 목적" };
const mutation = (s, device, payload = body, key = crypto.randomUUID()) => ({ method: "POST", cookie: device.cookie, body: payload,
  headers: { origin: s.origin, "x-kiosk-csrf": device.csrf, "idempotency-key": key } });

try {
  const off = await start("disabled", { KIOSK_ENABLED: "0" });
  check("disabled by default exposes no device authorization", (await request(off, "/api/kiosk/session")).json.enabled === false);
  check("disabled kiosk data API fails closed", (await request(off, "/api/kiosk/bookings?from=2026-10-12&to=2026-10-18")).status === 503);
  const weak = await start("weak-key", { KIOSK_PAIRING_CODE: "weak" });
  check("short pairing code fails closed", (await request(weak, "/api/kiosk/session")).json.enabled === false);
  const s = await start("enabled"), path = "/api/kiosk/bookings?from=2026-10-12&to=2026-10-18";
  const initial = await request(s, "/api/kiosk/session");
  check("unpaired status is explicitly unauthorized and not cached", initial.json.enabled && !initial.json.authorized && !initial.json.csrfToken && initial.headers.get("cache-control") === "no-store");
  check("anonymous cannot read kiosk bookings", (await request(s, path)).status === 401);
  const alice = await login(s, "alice");
  check("personal SSO alone does not authorize kiosk", (await request(s, path, { cookie: alice })).status === 401);
  for (const headers of [{ origin: "https://other.invalid", "x-kiosk-action": "pair" }, { origin: s.origin }, { "x-kiosk-action": "pair" }, { origin: s.origin, "x-kiosk-action": "pair", "sec-fetch-site": "cross-site" }]) {
    check("pairing requires exact origin and custom action " + checks.length, (await request(s, "/api/kiosk/session", { method: "POST", body: { code }, headers })).status === 403);
  }
  check("incorrect pairing code is rejected", (await request(s, "/api/kiosk/session", { method: "POST", body: { code: "wrong" }, headers: { origin: s.origin, "x-kiosk-action": "pair" } })).status === 401);
  const a = await pair(s), b = await pair(s);
  const setCookie = a.response.headers.getSetCookie()[0];
  check("device cookie is HttpOnly Strict and isolated to kiosk API", setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Strict") && setCookie.includes("Path=/api/kiosk") && setCookie.includes("Max-Age=2592000"));
  check("pairing secret is never returned", !a.response.text.includes(code) && !setCookie.includes(code));
  check("device cookies cannot access private or admin APIs", (await request(s, "/api/me", { cookie: a.cookie })).status === 401 && (await request(s, "/api/admin/usage", { cookie: a.cookie })).status === 401);
  check("altered device cookie is rejected", (await request(s, path, { cookie: a.cookie + "x" })).status === 401);
  check("device cannot read cross-site", (await request(s, path, { cookie: a.cookie, headers: { "sec-fetch-site": "cross-site" } })).status === 403);
  check("authorized device reads empty bounded timetable", (await request(s, path, { cookie: a.cookie })).json.bookings.length === 0);
  for (const range of ["", "?from=2026-10-12", "?from=2026-02-30&to=2026-03-01", "?from=2026-10-12&to=2026-10-19", "?from=2026-10-18&to=2026-10-12", "?from=2026-10-12&from=2026-10-12&to=2026-10-18"]) {
    check("invalid or oversized date range rejected " + range, (await request(s, "/api/kiosk/bookings" + range, { cookie: a.cookie })).status === 400);
  }
  const noCsrf = mutation(s, a); delete noCsrf.headers["x-kiosk-csrf"];
  check("creation requires CSRF token", (await request(s, "/api/kiosk/bookings", noCsrf)).status === 403);
  const foreignCsrf = mutation(s, a); foreignCsrf.headers["x-kiosk-csrf"] = b.csrf;
  check("CSRF is bound to the paired device", (await request(s, "/api/kiosk/bookings", foreignCsrf)).status === 403);
  const noOrigin = mutation(s, a); delete noOrigin.headers.origin;
  check("creation rejects missing Origin", (await request(s, "/api/kiosk/bookings", noOrigin)).status === 403);
  const noKey = mutation(s, a); delete noKey.headers["idempotency-key"];
  check("creation requires unique request key", (await request(s, "/api/kiosk/bookings", noKey)).status === 400);
  for (const patch of [{ owner: "" }, { owner: "x".repeat(41) }, { ownerId: "fixture-alice" }, { ownerEmail: "alice@example.invalid" }, { team: "false organization" }, { dates: ["2026-10-12"] }, { roomId: "unknown" }, { date: "2026-10-11" }, { start: "09:30", end: "10:00" }, { start: "11:15" }, { end: "10:30" }, { date: "2028-01-01" }]) {
    check("invalid or identity-injecting booking rejected " + JSON.stringify(patch), (await request(s, "/api/kiosk/bookings", mutation(s, a, { ...body, ...patch }))).status === 400);
  }
  const key = crypto.randomUUID(), created = await request(s, "/api/kiosk/bookings", mutation(s, a, body, key));
  check("valid name-required booking created", created.status === 201 && created.json.created.length === 1 && created.json.created[0].owner === body.owner);
  const id = created.json.created[0].id;
  const retried = await request(s, "/api/kiosk/bookings", mutation(s, a, body, key));
  check("retry returns exactly the same booking", retried.status === 200 && retried.json.replayed && retried.json.created[0].id === id);
  check("same key different payload rejected", (await request(s, "/api/kiosk/bookings", mutation(s, a, { ...body, owner: "another" }, key))).status === 409);
  check("another device cannot reuse key to bypass collision", (await request(s, "/api/kiosk/bookings", mutation(s, b, body, key))).status === 409);
  const db = new DatabaseSync(resolve(s.data, "bookings.sqlite")); databases.push(db);
  const row = db.prepare("SELECT * FROM bookings WHERE id=?").get(id);
  check("kiosk persists source but never employee identity or fake department", row.source === "kiosk" && row.owner_id === "" && row.owner_email === "" && row.team === "");
  check("kiosk never queues personal Outlook export", db.prepare("SELECT COUNT(*) n FROM calendar_jobs WHERE booking_id=?").get(id).n === 0);
  const audit = db.prepare("SELECT * FROM booking_audit WHERE booking_id=?").all(id);
  check("audit uses device actor once, not typed employee identity", audit.length === 1 && audit[0].actor_id.startsWith("kiosk:") && !audit[0].actor_name.includes(body.owner));
  const visible = (await request(s, path, { cookie: a.cookie })).json.bookings[0];
  check("public monitor omits purpose, organization, email and attendees", Object.keys(visible).sort().join() === ["id", "roomId", "date", "start", "end", "owner"].sort().join());
  const personal = await request(s, "/api/bookings?from=2026-10-12&to=2026-10-18", { cookie: alice });
  check("kiosk booking appears on personal timetable but is not claimed", personal.json.bookings.some(v => v.id === id && v.isMine === false));
  for (const method of ["DELETE", "PATCH"]) {
    check("kiosk cannot modify or delete " + method, (await request(s, "/api/kiosk/bookings/" + id, { ...mutation(s, a), method })).status === 405);
    check("SSO identity cannot claim self-reported kiosk booking " + method, (await request(s, "/api/bookings/" + id, { method, cookie: alice, body: { ...body, expectedRevision: 1 }, headers: { origin: s.origin } })).status === 403);
  }
  const siteClash = await request(s, "/api/bookings", { method: "POST", cookie: alice, body, headers: { origin: s.origin } });
  check("personal booking cannot overlap kiosk booking", siteClash.status === 409);
  const next = { ...body, roomId: rooms[1].id };
  const race = await Promise.all([request(s, "/api/kiosk/bookings", mutation(s, a, next)), request(s, "/api/kiosk/bookings", mutation(s, b, next))]);
  check("two devices racing the same slot produce one success", race.map(r => r.status).sort().join() === "201,409");
  const once = crypto.randomUUID(), slot = { ...body, roomId: rooms[2].id };
  const retries = await Promise.all(Array.from({ length: 6 }, () => request(s, "/api/kiosk/bookings", mutation(s, b, slot, once))));
  check("parallel retries produce one row and consistent identifiers", retries.filter(r => r.status === 201).length === 1 && new Set(retries.map(r => r.json.created[0].id)).size === 1);
  const usage = (await request(s, "/api/admin/usage?from=2026-10-12&to=2026-10-18", { cookie: alice })).json;
  check("unverified kiosk names are excluded from employee rankings", usage.summary.bookings === 3 && usage.summary.unidentifiedBookings === 3 && usage.users.length === 0);
  const competition = { ...body, roomId: rooms[3].id, start: "14:00", end: "15:00" };
  const mixedRace = await Promise.all([
    request(s, "/api/kiosk/bookings", mutation(s, b, competition)),
    request(s, "/api/bookings", { method: "POST", cookie: alice, body: competition, headers: { origin: s.origin } }),
  ]);
  check("personal and kiosk simultaneous requests share one collision authority", mixedRace.map(r => r.status).sort().join() === "201,409");
  const privateSite = await request(s, "/api/bookings", { method: "POST", cookie: alice,
    body: { ...body, roomId: rooms[3].id, start: "16:00", end: "17:00", purpose: "private detail", team: "private team", attendees: ["private attendee"] }, headers: { origin: s.origin } });
  check("normal authenticated site booking still succeeds", privateSite.status === 201);
  const allVisible = await request(s, path, { cookie: b.cookie });
  check("personal bookings appear without their private details on kiosk", allVisible.json.bookings.some(v => v.id === privateSite.json.created[0].id) && !allVisible.text.includes("private detail") && !allVisible.text.includes("private attendee") && !allVisible.text.includes("private team"));
  check("persistent retry receipt does not duplicate meeting purpose or account data", !db.prepare("SELECT result_json FROM kiosk_requests WHERE request_key=?").get(key).result_json.includes(body.purpose));
  let createThrottled;
  for (let i = 0; i < 31; i++) createThrottled = await request(s, "/api/kiosk/bookings", mutation(s, b, { ...body, roomId: "unknown" }));
  check("device reservation flood is rate limited", createThrottled.status === 429 && createThrottled.headers.get("retry-after") === "300");
  check("successful retry remains available during reservation rate limit", (await request(s, "/api/kiosk/bookings", mutation(s, b, slot, once))).status === 200);
  const restart = await start("restart", {}, s.data);
  check("device cookie survives restart with shared persisted state", (await request(restart, path, { cookie: a.cookie })).status === 200);
  const replay = await request(restart, "/api/kiosk/bookings", mutation(restart, a, body, key));
  check("idempotency survives process restart", replay.status === 200 && replay.json.created[0].id === id);
  const rotated = await start("rotated", { KIOSK_PAIRING_CODE: code + "-rotated" }, s.data);
  check("rotating pairing key invalidates earlier sessions", (await request(rotated, path, { cookie: a.cookie })).status === 401);
  const anon = await start("anonymous-personal", { ALLOW_ANONYMOUS: "1", MS_TENANT_ID: "", MS_CLIENT_ID: "", MS_CLIENT_SECRET: "", APP_BASE_URL: "" }, s.data);
  check("development name matching cannot delete kiosk records", (await request(anon, "/api/bookings/" + id, { method: "DELETE", body: { owner: body.owner } })).status === 403);
  const signedOut = await request(s, "/api/kiosk/session", { method: "DELETE", cookie: a.cookie, headers: { origin: s.origin, "x-kiosk-csrf": a.csrf } });
  check("unpair clears cookie and revokes device server-side", signedOut.status === 200 && signedOut.headers.get("set-cookie").includes("Max-Age=0") && (await request(s, path, { cookie: a.cookie })).status === 401);
  const expiring = await pair(restart);
  const payload = JSON.parse(Buffer.from(expiring.cookie.split("=")[1].split(".")[0], "base64url").toString());
  db.prepare("UPDATE kiosk_devices SET expires_at=0 WHERE device_id=?").run(payload.id);
  check("expired device registration is denied", (await request(s, path, { cookie: expiring.cookie })).status === 401);
  const rate = await start("rate-limit");
  let throttled;
  for (let i = 0; i < 6; i++) throttled = await request(rate, "/api/kiosk/session", { method: "POST", body: { code: "incorrect" }, headers: { origin: rate.origin, "x-kiosk-action": "pair" } });
  check("pairing brute force is rate limited", throttled.status === 429 && throttled.headers.get("retry-after") === "900");
  const secure = await start("secure-production", { NODE_ENV: "production", APP_BASE_URL: "https://kiosk.example.invalid" });
  const secured = await pair(secure);
  check("production cookie requires Secure attribute", secured.response.headers.get("set-cookie").includes("; Secure"));
  const device = await pair(rate).catch(() => null);
  check("valid pairing code does not bypass active brute-force lockout", device === null);
  writeFileSync(resolve(run, "results.json"), JSON.stringify({ passed: checks.length, checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, results: resolve(run, "results.json") }));
} finally {
  for (const db of databases) db.close();
  for (const child of children) child.kill();
}
