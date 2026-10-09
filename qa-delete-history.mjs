// Isolated regression for deleting future bookings and releasing ongoing bookings.
// No real reservation database, Microsoft endpoint, or local preview is touched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { roomsConfig } from "./server/config.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));

if (mode) {
  assert.ok(process.env.DATA_DIR?.includes("data-qa-delete-history"), "Fixture modes require an isolated QA directory");
  const { database: db, createBookings, deleteBooking, updateBooking, listBookings, listAudit } = await import("./server/db.mjs");
  const identity = { sso: true, ownerId: "qa-delete-owner", ownerEmail: "owner@example.invalid", ownerName: "QA Delete" };
  let sequence = 0;
  const create = (extra = {}) => {
    const result = createBookings({ roomId: `qa-room-${++sequence}`, dates: ["2026-10-09"], start: "13:00", end: "17:00",
      owner: "QA Delete", ownerId: identity.ownerId, ownerEmail: identity.ownerEmail, team: "QA Team", purpose: "Preserve this purpose",
      attendees: ["QA Participant"], attendeeAccounts: [{ id: "qa-attendee", name: "QA Participant", email: "participant@example.invalid" }], identity, ...extra });
    assert.equal(result.ok, true); return result.created[0];
  };
  const clock = (now, nowSeconds = 0) => ({ today: "2026-10-09", now, nowSeconds });
  const row = id => db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
  const job = id => db.prepare("SELECT * FROM calendar_jobs WHERE booking_id = ?").get(id);
  const audits = id => listAudit({ limit: 200 }).items.filter(item => item.bookingId === id);

  if (mode === "database") {
    const results = [];
    const check = (name, action) => { action(); results.push(name); };
    const ongoing = create();
    const original = row(ongoing.id);
    const ended = deleteBooking(ongoing.id, identity, clock("14:15"));
    check("ongoing deletion retains usage through the next slot boundary", () => {
      assert.equal(ended.action, "ended"); assert.equal(ended.booking.start, "13:00"); assert.equal(ended.booking.end, "14:30");
      assert.ok(ended.booking.endedAt); assert.equal(ended.booking.revision, 2);
      for (const key of ["id", "room_id", "date", "start", "owner", "owner_id", "owner_email", "team", "purpose", "attendees", "attendee_accounts", "created_at"]) assert.equal(row(ongoing.id)[key], original[key], key);
    });
    check("release audits are updates and Outlook appointments are shortened, not deleted", () => {
      assert.equal(audits(ongoing.id)[0].action, "update");
      assert.deepEqual(audits(ongoing.id)[0].changed, ["end", "ended_at"]);
      assert.equal(audits(ongoing.id)[0].before.end, "17:00"); assert.equal(audits(ongoing.id)[0].after.end, "14:30");
      assert.equal(JSON.parse(job(ongoing.id).desired_json).end, "14:30"); assert.equal(job(ongoing.id).version, 2);
    });
    check("duplicate deletion never removes history or writes another audit/calendar job", () => {
      for (const now of ["14:16", "15:30", "23:59"]) {
        const repeat = deleteBooking(ongoing.id, identity, clock(now));
        assert.equal(repeat.action, "unchanged"); assert.deepEqual(repeat.booking, ended.booking);
      }
      assert.equal(audits(ongoing.id).length, 2); assert.equal(job(ongoing.id).version, 2);
    });
    check("released usage history cannot be changed or extended", () => {
      const result = updateBooking(ongoing.id, identity, { roomId: ongoing.roomId, date: ongoing.date, start: ongoing.start, end: "18:00", expectedRevision: 2 }, clock("14:16"));
      assert.equal(result.reason, "past"); assert.equal(row(ongoing.id).end, "14:30");
    });
    check("the released slot is bookable but the retained usage remains protected", () => {
      assert.equal(createBookings({ roomId: ongoing.roomId, dates: [ongoing.date], start: "14:30", end: "15:00", owner: "QA Other", purpose: "Released slot" }).ok, true);
      assert.equal(createBookings({ roomId: ongoing.roomId, dates: [ongoing.date], start: "14:00", end: "14:30", owner: "QA Other", purpose: "Usage overlap" }).ok, false);
    });
    check("an exact boundary is released immediately", () => {
      const booking = create(); const result = deleteBooking(booking.id, identity, clock("14:30"));
      assert.equal(result.booking.end, "14:30");
    });
    check("seconds after a boundary round up instead of backdating release", () => {
      const booking = create(); const result = deleteBooking(booking.id, identity, clock("14:30", 1));
      assert.equal(result.booking.end, "15:00");
    });
    check("one millisecond after a boundary also rounds up to the next slot", () => {
      const booking = create(); const result = deleteBooking(booking.id, identity, clock("14:30", 0.001));
      assert.equal(result.booking.end, "15:00");
    });
    check("deletion in the last slot retains history without extending the booking", () => {
      const booking = create({ end: "14:30" }); const result = deleteBooking(booking.id, identity, clock("14:15"));
      assert.equal(result.action, "ended"); assert.equal(result.booking.end, "14:30"); assert.ok(result.booking.endedAt);
      assert.deepEqual(audits(booking.id)[0].changed, ["ended_at"]);
    });
    check("last slot before midnight retains a valid 24:00 boundary", () => {
      const booking = create({ start: "23:00", end: "24:00" });
      assert.equal(deleteBooking(booking.id, identity, clock("23:59", 59)).booking.end, "24:00");
    });
    check("future and exact-start bookings with no elapsed usage are removed", () => {
      for (const start of ["14:30", "15:00"]) {
        const booking = create({ start });
        assert.equal(deleteBooking(booking.id, identity, clock("14:30")).action, "deleted");
        assert.equal(row(booking.id), undefined); assert.equal(job(booking.id).desired_json, null); assert.equal(audits(booking.id)[0].action, "cancel");
      }
      const booking = create({ start: "14:30" });
      assert.equal(deleteBooking(booking.id, identity, clock("14:30", 1)).booking.end, "15:00");
    });
    check("past bookings are protected and unauthorized users cannot trim or delete", () => {
      const past = create({ start: "09:00", end: "10:00" });
      assert.equal(deleteBooking(past.id, identity, clock("14:15")).reason, "past");
      const today = create();
      assert.equal(deleteBooking(today.id, { ...identity, ownerId: "qa-other" }, clock("14:15")).reason, "forbidden");
      assert.equal(deleteBooking(ongoing.id, { ...identity, ownerId: "qa-other" }, clock("14:15")).reason, "forbidden");
      assert.equal(deleteBooking("qa-missing", identity, clock("14:15")).reason, "not-found");
      assert.equal(row(today.id).revision, 1); assert.equal(audits(today.id).length, 1);
    });
    check("a later edit is retained when deletion reads the latest booking", () => {
      const booking = create();
      const updated = updateBooking(booking.id, identity, { roomId: booking.roomId, date: booking.date, start: booking.start, end: "16:00", purpose: "Latest purpose", team: "Latest team", expectedRevision: 1 }, clock("14:15"));
      assert.equal(updated.ok, true);
      const result = deleteBooking(booking.id, identity, clock("14:15"));
      assert.equal(result.booking.purpose, "Latest purpose"); assert.equal(result.booking.team, "Latest team"); assert.equal(result.booking.revision, 3);
    });
    check("audit failure rolls back booking changes and the Outlook outbox together", () => {
      const booking = create(); const before = row(booking.id); const beforeJob = job(booking.id);
      db.exec("CREATE TEMP TRIGGER qa_reject_audit BEFORE INSERT ON booking_audit WHEN NEW.action = 'update' BEGIN SELECT RAISE(ABORT, 'QA audit failure'); END");
      assert.throws(() => deleteBooking(booking.id, identity, clock("14:15")), /QA audit failure/);
      db.exec("DROP TRIGGER qa_reject_audit");
      assert.deepEqual(row(booking.id), before); assert.deepEqual(job(booking.id), beforeJob);
    });
    check("booking list publishes the retained record with endedAt", () => {
      const listed = listBookings({ identity }).find(booking => booking.id === ongoing.id);
      assert.deepEqual(listed, ended.booking);
    });
    process.stdout.write(JSON.stringify({ results }));
  } else if (mode === "fixtures") {
    const ongoing = create({ roomId: roomsConfig[0].id, ownerId: "", ownerEmail: "" });
    const future = create({ roomId: roomsConfig[0].id, start: "19:00", end: "20:00", ownerId: "", ownerEmail: "" });
    const past = create({ roomId: roomsConfig[0].id, start: "09:00", end: "10:00", ownerId: "", ownerEmail: "" });
    const concurrent = create({ roomId: roomsConfig[1].id, ownerId: "", ownerEmail: "" });
    process.stdout.write(JSON.stringify({ ongoing, future, past, concurrent }));
  } else if (mode === "edit-hold") {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE bookings SET purpose = 'Concurrent latest purpose', revision = revision + 1 WHERE id = ?").run(process.argv[3]);
    process.stdout.write("locked\n");
    await pause(650);
    db.exec("COMMIT");
  } else if (mode === "delete-after-lock") {
    process.stdout.write(JSON.stringify(deleteBooking(process.argv[3], { owner: "QA Delete" }, clock("14:15"))));
  } else throw Error("Unknown fixture mode");
  db.close();
} else {
  const run = resolve(root, "data-qa-delete-history", String(Date.now()));
  mkdirSync(run, { recursive: true });
  const results = [];
  const childEnvironment = data => ({ ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", DATA_DIR: data,
    CLIENT_DIR: resolve(root, "dist"), ALLOW_ANONYMOUS: "1", SEED_DEMO: "0", MS_TENANT_ID: "", MS_CLIENT_ID: "", MS_CLIENT_SECRET: "",
    APP_BASE_URL: "", MICROSOFT_TOKEN_KEY: "", ADMIN_MS_EMAIL: "", ADMIN_MS_OBJECT_ID: "", BACKUP_DIR: "", BACKUP_INTERVAL_MINUTES: "0",
    TEST_NOW: "2026-10-09T05:15:00Z", TEST_FIXTURE_BOUNDARIES: "", TEST_FIXTURE_SSO: "" });
  const start = (args, env) => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    const done = new Promise((yes, no) => { child.on("error", no); child.on("exit", code => code === 0 ? yes(stdout) : no(Error(stderr || `Exited ${code}`))); });
    return { child, done, output: () => stdout + stderr };
  };
  const unit = start(["qa-delete-history.mjs", "database"], childEnvironment(resolve(run, "unit")));
  results.push(...JSON.parse(await unit.done).results);
  const data = resolve(run, "api");
  const fixtures = JSON.parse(await start(["qa-delete-history.mjs", "fixtures"], childEnvironment(data)).done);
  // The deleter must block behind an editor's transaction and see the committed edit.
  const editor = start(["qa-delete-history.mjs", "edit-hold", fixtures.concurrent.id], childEnvironment(data));
  for (let i = 0; i < 100 && !editor.output().includes("locked"); i++) await pause(20);
  assert.match(editor.output(), /locked/);
  const deleter = start(["qa-delete-history.mjs", "delete-after-lock", fixtures.concurrent.id], childEnvironment(data));
  const latest = JSON.parse(await deleter.done); await editor.done;
  assert.equal(latest.booking.purpose, "Concurrent latest purpose"); assert.equal(latest.booking.revision, 3);
  results.push("cross-process deletion waits for a concurrent edit and preserves its latest values");

  const socket = net.createServer(); await new Promise(resolveListen => socket.listen(0, "127.0.0.1", resolveListen));
  const port = socket.address().port; await new Promise(resolveClose => socket.close(resolveClose));
  const server = start(["--import", "./qa-preload.mjs", "server/index.mjs"], { ...childEnvironment(data), PORT: String(port) });
  // A running server is intentionally terminated in finally, so don't reject its exit.
  server.done.catch(() => {});
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, id, body = { owner: "QA Delete" }) => {
    const response = await fetch(`${base}/api/bookings/${id}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await pause(50);
    }
    assert.ok(ready, server.output());
    const concurrentDeletes = await Promise.all(Array.from({ length: 8 }, () => call("DELETE", fixtures.ongoing.id)));
    assert.equal(concurrentDeletes.filter(result => result.body.action === "ended").length, 1);
    assert.equal(concurrentDeletes.filter(result => result.body.action === "unchanged").length, 7);
    assert.ok(concurrentDeletes.every(result => result.status === 200 && result.body.booking.end === "14:30" && result.body.booking.revision === 2));
    results.push("simultaneous DELETE requests return one ended result and idempotent unchanged results");
    const future = await call("DELETE", fixtures.future.id);
    assert.equal(future.status, 200); assert.deepEqual(future.body, { ok: true, action: "deleted" });
    results.push("future DELETE response explicitly reports deletion");
    assert.equal((await call("DELETE", fixtures.past.id)).status, 400);
    assert.equal((await call("DELETE", fixtures.ongoing.id, { owner: "Another Person" })).status, 403);
    assert.equal((await call("DELETE", "missing")).status, 404);
    results.push("API preserves past, ownership and missing-booking protections");
    const patch = await call("PATCH", fixtures.ongoing.id, { owner: "QA Delete", roomId: fixtures.ongoing.roomId,
      date: fixtures.ongoing.date, start: fixtures.ongoing.start, end: "17:00", expectedRevision: 2 });
    assert.equal(patch.status, 400); assert.match(patch.body.error, /지난 예약/);
    const listed = (await (await fetch(base + "/api/bookings")).json()).bookings;
    assert.equal(listed.find(item => item.id === fixtures.ongoing.id).end, "14:30");
    assert.ok(listed.find(item => item.id === fixtures.ongoing.id).endedAt);
    assert.ok(!listed.some(item => item.id === fixtures.future.id));
    results.push("API lists retained usage and blocks any attempted re-extension");
    console.log(results.map(result => "PASS " + result).join("\n"));
    console.log(`Passed ${results.length} checks. Isolated output: ${run}`);
    writeFileSync(resolve(run, "results.json"), JSON.stringify({ results }, null, 2));
  } finally {
    server.child.kill();
    writeFileSync(resolve(run, "server.log"), server.output());
  }
}
