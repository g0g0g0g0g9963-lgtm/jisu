// Pre-release API checks only. Every database and server is isolated from user previews.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import assert from "node:assert/strict";
import { roomsConfig } from "./server/config.mjs";

const root = dirname(fileURLToPath(import.meta.url));
if (process.env.QA_FINAL_API_FIXTURE === "1") {
  assert.ok(process.env.DATA_DIR?.includes("data-qa-final-api"));
  await import("./qa-preload.mjs"); // Blocks external HTTP and supplies synthetic Microsoft identities.
  const { createBookings } = await import("./server/db.mjs");
  createBookings({ roomId: roomsConfig[0].id, dates: ["2026-10-08"], start: "23:00", end: "24:00",
    owner: "QA Alice", ownerId: "fixture-alice", ownerEmail: "alice@example.invalid", team: "QA", purpose: "Midnight fixture" });
} else {
  const run = resolve(root, "data-qa-final-api", String(Date.now())); mkdirSync(run, { recursive: true });
  const checks = [], measurements = [], findings = [], servers = [];
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const started = performance.now();
  const check = (name, good, detail = {}) => { checks.push({ name, pass: Boolean(good), ...detail }); console.log(`${good ? "PASS" : "FAIL"} ${name}`); };
  const port = async () => { const socket = net.createServer(); await new Promise(r => socket.listen(0, "127.0.0.1", r)); const p = socket.address().port; await new Promise(r => socket.close(r)); return p; };
  async function start(name, instant = "2026-10-08T01:15:00.000Z", fixture = false) {
    const p = await port(), data = resolve(run, name), base = `http://127.0.0.1:${p}`;
    const child = spawn(process.execPath, ["--import", fixture ? "./qa-final-api.mjs" : "./qa-preload.mjs", "server/index.mjs"], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(p),
        DATA_DIR: data, CLIENT_DIR: resolve(root, "dist"), SEED_DEMO: "0", ALLOW_ANONYMOUS: "", SESSION_SECRET: "qa-final-only",
        MS_TENANT_ID: "qa-tenant", MS_CLIENT_ID: "qa-client", MS_CLIENT_SECRET: "qa-fake-secret", APP_BASE_URL: base,
        MICROSOFT_TOKEN_KEY: "", ADMIN_MS_EMAIL: "", ADMIN_MS_OBJECT_ID: "", BACKUP_DIR: "", BACKUP_INTERVAL_MINUTES: "0",
        TEST_NOW: instant, TEST_FIXTURE_SSO: "0", TEST_FIXTURE_BOUNDARIES: "0", QA_FINAL_API_FIXTURE: fixture ? "1" : "0" },
    });
    const server = { name, base, data, child, log: "" }; servers.push(server);
    child.stdout.on("data", b => server.log += b); child.stderr.on("data", b => server.log += b);
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw Error(server.log);
      try { if ((await fetch(base + "/api/health")).ok) return server; } catch {}
      await pause(50);
    }
    throw Error("Fixture startup timed out: " + server.log);
  }
  async function req(server, path, method = "GET", body, cookie) {
    const start = performance.now();
    const response = await fetch(server.base + path, { method, redirect: "manual", signal: AbortSignal.timeout(15000), headers: { ...(cookie ? { cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch {}
    return { status: response.status, headers: response.headers, json, ms: performance.now() - start };
  }
  async function login(server, code) {
    const start = await req(server, "/auth/login"), state = new URL(start.headers.get("location")).searchParams.get("state");
    const result = await req(server, `/auth/callback?state=${encodeURIComponent(state)}&code=${code}`, "GET", undefined, start.headers.getSetCookie()[0].split(";")[0]);
    assert.equal(result.status, 302);
    return result.headers.getSetCookie().find(c => c.startsWith("bdo-session=") && !c.startsWith("bdo-session=;")).split(";")[0];
  }
  const summary = (name, responses, wallMs) => {
    const durations = responses.map(r => r.ms).sort((a, b) => a - b), status = {};
    responses.forEach(r => status[r.status] = (status[r.status] || 0) + 1);
    const item = { name, requests: responses.length, status, wallMs: Math.round(wallMs), p50Ms: Math.round(durations[Math.ceil(durations.length * .50) - 1]), p95Ms: Math.round(durations[Math.ceil(durations.length * .95) - 1]), maxMs: Math.round(durations.at(-1)) };
    measurements.push(item); console.log("METRIC " + JSON.stringify(item));
  };
  try {
    const s = await start("load"), alice = await login(s, "alice"), sameName = await login(s, "spoof");
    const body = { roomId: roomsConfig[0].id, date: "2026-10-09", start: "09:00", end: "10:00", owner: "Forged", team: "QA", purpose: "QA final" };
    const create = (extra, cookie = alice) => req(s, "/api/bookings", "POST", { ...body, ...extra }, cookie);
    const rows = async () => (await req(s, "/api/bookings", "GET", undefined, alice)).json.bookings;
    const owned = (await create({})).json.created[0];
    const namesake = (await create({ roomId: roomsConfig[1].id }, sameName)).json.created[0];
    check("same display name can own separate reservations by immutable account identity", owned.owner === namesake.owner && (await rows()).find(r => r.id === namesake.id).isMine === false);
    const forbidden = await req(s, "/api/bookings/" + owned.id, "DELETE", { owner: owned.owner, ownerId: "fixture-alice" }, sameName);
    check("namesake with forged owner data cannot delete the other account's reservation", forbidden.status === 403);
    for (const [i, count] of [10, 50, 200].entries()) {
      const date = `2026-10-${12 + i}`, tick = performance.now();
      const responses = await Promise.all(Array.from({ length: count }, () => create({ date, start: "13:00", end: "14:00" })));
      summary(`same-slot-${count}`, responses, performance.now() - tick);
      check(`${count} simultaneous same-slot requests have exactly one winner`, responses.filter(r => r.status === 201).length === 1 && responses.filter(r => r.status === 409).length === count - 1 && (await rows()).filter(r => r.date === date && r.start === "13:00").length === 1);
    }
    let tick = performance.now();
    const independent = await Promise.all(Array.from({ length: 200 }, (_, i) => create({ roomId: roomsConfig[1].id, date: new Date(Date.UTC(2026, 9, 15 + i)).toISOString().slice(0, 10), start: "12:00", end: "12:30" })));
    summary("independent-writes-200", independent, performance.now() - tick);
    check("200 non-conflicting reservations all persist", independent.every(r => r.status === 201) && (await rows()).filter(r => r.start === "12:00").length === 200);
    tick = performance.now();
    const reads = await Promise.all(Array.from({ length: 200 }, () => req(s, "/api/bookings?from=2026-10-01&to=2027-10-01", "GET", undefined, alice)));
    summary("list-reads-200", reads, performance.now() - tick);
    check("200 simultaneous date-range reads succeed", reads.every(r => r.status === 200 && r.json.bookings.length >= 205));
    const editable = independent[0].json.created[0]; tick = performance.now();
    const edits = await Promise.all(Array.from({ length: 200 }, (_, i) => req(s, "/api/bookings/" + editable.id, "PATCH", { ...editable, expectedRevision: editable.revision, purpose: "Concurrent edit " + i }, alice)));
    summary("same-revision-edits-200", edits, performance.now() - tick);
    check("200 edits of the same revision have exactly one winner", edits.filter(r => r.status === 200).length === 1 && edits.filter(r => r.status === 409 && r.json.code === "booking-changed").length === 199);
    const current = (await rows()).find(r => r.id === editable.id);
    check("losing edits do not overwrite the winner or increment its revision", current.revision === editable.revision + 1 && current.purpose === edits.find(r => r.status === 200).json.booking.purpose);
    const duplicates = await Promise.all(Array.from({ length: 20 }, () => req(s, "/api/bookings/" + owned.id, "DELETE", {}, alice)));
    check("20 duplicate future cancellations leave no booking and only one successful deletion", duplicates.filter(r => r.status === 200 && r.json.action === "deleted").length === 1 && duplicates.filter(r => r.status === 404).length === 19 && !(await rows()).some(r => r.id === owned.id));
    const db = new DatabaseSync(resolve(s.data, "bookings.sqlite"), { readOnly: true });
    check("duplicate cancellations produce exactly one cancellation audit", db.prepare("SELECT count(*) n FROM booking_audit WHERE booking_id=? AND action='cancel'").get(owned.id).n === 1);
    const repeatDates = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10));
    const repeat = await create({ roomId: roomsConfig[2].id, dates: repeatDates, start: "15:00", end: "16:00" });
    check("maximum supported 60-date repetition succeeds atomically", repeat.status === 201 && repeat.json.created.length === 60 && new Set(repeat.json.created.map(r => r.seriesId)).size === 1);
    const before = (await rows()).length;
    const conflict = await create({ roomId: roomsConfig[2].id, dates: [repeatDates[0], "2027-04-01"], start: "15:00", end: "16:00" });
    check("repeat conflict leaves no partial new dates", conflict.status === 409 && (await rows()).length === before && !(await rows()).some(r => r.date === "2027-04-01" && r.roomId === roomsConfig[2].id));
    const purpose = "회의 목적 검증 ".repeat(20);
    const long = await create({ roomId: roomsConfig[2].id, date: "2027-05-01", purpose });
    const longPreserved = long.status === 400 || long.json.created[0].purpose === purpose.trim();
    check("overlong meeting purpose is either preserved or explicitly rejected", longPreserved, { status: long.status, sentCharacters: purpose.trim().length, savedCharacters: long.json?.created?.[0]?.purpose?.length });
    if (!longPreserved) findings.push({ severity: "P2", title: "Meeting purpose is silently truncated to 100 characters", sent: purpose.trim().length, saved: long.json.created[0].purpose.length, source: "server/index.mjs:115" });
    check("SQLite integrity remains valid after concurrent operations", db.prepare("PRAGMA integrity_check").get().integrity_check === "ok"); db.close();
    for (const [name, instant, expected] of [["midnight-before", "2026-10-08T14:59:59.999Z", 200], ["midnight-exact", "2026-10-08T15:00:00.000Z", 400]]) {
      const server = await start(name, instant, true), cookie = await login(server, "alice");
      const booking = (await req(server, "/api/bookings", "GET", undefined, cookie)).json.bookings[0];
      const result = await req(server, "/api/bookings/" + booking.id, "DELETE", {}, cookie);
      check(name + " uses business-date boundary", result.status === expected && (expected !== 200 || result.json.action === "ended" && result.json.booking.end === "24:00" && Boolean(result.json.booking.endedAt)));
      if (expected === 200) {
        const again = await req(server, "/api/bookings/" + booking.id, "DELETE", {}, cookie);
        check("midnight retained history survives duplicate cancellation", again.status === 200 && again.json.action === "unchanged" && again.json.booking.end === "24:00");
      }
    }
  } catch (error) { check("suite execution", false, { error: String(error), stack: error.stack }); }
  finally {
    for (const server of servers) {
      if (server.child.exitCode === null) server.child.kill();
      writeFileSync(resolve(run, server.name + ".log"), server.log);
    }
    const result = { elapsedMs: Math.round(performance.now() - started), scope: "Loopback API requests, synthetic identities/databases; not 200 real users or production NAS load", counts: { total: checks.length, pass: checks.filter(c => c.pass).length, fail: checks.filter(c => !c.pass).length }, checks, measurements, findings };
    writeFileSync(resolve(run, "results.json"), JSON.stringify(result, null, 2));
    console.log("SUMMARY " + JSON.stringify(result.counts)); console.log("OUTPUT " + run); process.exitCode = result.counts.fail ? 1 : 0;
  }
}
