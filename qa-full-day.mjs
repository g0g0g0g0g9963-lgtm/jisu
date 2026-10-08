// Run with `node qa-full-day.mjs`. Only a disposable synthetic database is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const [site, rooms] = await Promise.all([
  readFile(join(root, "app/config/site.json"), "utf8").then(JSON.parse),
  readFile(join(root, "app/config/rooms.json"), "utf8").then(JSON.parse),
]);
assert.equal(site.timeZone, "Asia/Seoul");
assert.equal(site.booking.openingTime, "00:00");
assert.equal(site.booking.closingTime, "24:00");
assert.equal(site.booking.slotMinutes, 30);
const dataDir = await mkdtemp(join(tmpdir(), "meeting-full-day-"));
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));

// The server clock is 23:15 in the configured business time zone (Asia/Seoul).
const clockSource = `
  const NativeDate = Date;
  const now = NativeDate.parse("2026-10-08T14:15:00Z");
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
`;
const child = spawn(process.execPath, [
  "--import", `data:text/javascript,${encodeURIComponent(clockSource)}`,
  join(root, "server/index.mjs"),
], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
    DATA_DIR: dataDir, TZ: "UTC", ALLOW_ANONYMOUS: "1", SEED_DEMO: "0",
    MS_TENANT_ID: "", MS_CLIENT_ID: "", MS_CLIENT_SECRET: "",
    APP_BASE_URL: "", SESSION_SECRET: "qa-full-day-only",
  },
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
let childError;
child.once("error", (error) => { childError = error; });
const exit = new Promise((resolve) => child.once("exit", resolve));
const base = `http://127.0.0.1:${port}`;
let passed = 0;

async function request(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
function expect(result, status, description) {
  assert.equal(result.status, status, `${description}: ${JSON.stringify(result.data)}`);
  passed += 1;
  console.log(`PASS ${description}`);
  return result.data;
}
const valid = {
  roomId: rooms[0].id, date: "2026-10-09", owner: "Full-day QA",
  start: "00:00", end: "00:30", purpose: "Synthetic full-day boundary test",
};
const create = (changes = {}) => request("POST", "/api/bookings", { ...valid, ...changes });
const patch = (id, changes = {}) => request("PATCH", `/api/bookings/${id}`, { ...valid, ...changes });

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (childError) throw childError;
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try {
      const health = await request("GET", "/api/health");
      if (health.status === 200) {
        assert.equal(health.data.bookings, 0, "Test database must begin empty");
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Server startup timed out: ${logs}`);

  expect(await create(), 201, "00:00–00:30 creates");
  expect(await create({ start: "00:30", end: "01:00" }), 201, "Adjacent early slots create");
  const late = expect(await create({ start: "23:30", end: "24:00" }), 201, "23:30–24:00 creates").created[0];
  expect(await create({ start: "23:00", end: "24:00" }), 409, "Late overlap is rejected");
  expect(await create({ date: "2026-10-10" }), 201, "Next day 00:00 is adjacent to prior 24:00");
  expect(await create({ date: "2026-10-11", start: "00:00", end: "24:00" }), 201, "Entire day creates");
  expect(await create({ date: "2026-10-11", start: "12:00", end: "12:30" }), 409, "Entire day blocks interior slots");

  for (const [start, end] of [
    ["24:00", "24:00"], ["24:00", "24:30"], ["23:30", "24:30"],
    ["25:00", "26:00"], ["00:00", "25:00"], ["-1:00", "00:30"],
    ["0:00", "00:30"], ["00:00", "24:0"], ["23:60", "24:00"],
    ["23:45", "24:00"], ["00:00", "00:15"], ["00:00", "00:00"],
    ["23:30", "00:00"], ["23:30", "00:30"],
  ]) {
    expect(await create({ date: "2026-10-12", start, end }), 400, `Invalid ${start}–${end} is rejected`);
  }

  expect(await patch(late.id, { start: "23:00", end: "24:00" }), 200, "Patch can end at 24:00");
  expect(await patch(late.id, { start: "24:00", end: "24:00" }), 400, "Patch cannot start at 24:00");
  expect(await patch(late.id, { start: "23:30", end: "24:30" }), 400, "Patch cannot end after 24:00");
  expect(await patch(late.id, { start: "00:00", end: "24:00" }), 409, "Patch retains conflict detection");
  expect(await patch(late.id, { owner: "Other QA", start: "22:30", end: "24:00" }), 403, "Patch retains ownership enforcement");
  expect(await create({ date: "2026-10-08", start: "23:00", end: "24:00" }), 400, "Past start today remains rejected");
  const today = expect(await create({ date: "2026-10-08", start: "23:30", end: "24:00" }), 201, "Last future slot today creates").created[0];
  expect(await patch(today.id, { date: "2026-10-08", start: "23:00", end: "24:00" }), 400, "Patch cannot move into elapsed time");
  expect(await create({ date: "2026-10-07", start: "23:30", end: "24:00" }), 400, "Prior day ending at 24:00 is past");

  const rows = expect(await request("GET", "/api/bookings"), 200, "Bookings list succeeds").bookings;
  assert.equal(rows.find((row) => row.id === late.id)?.end, "24:00", "24:00 persists unchanged");
  console.log(`PASS ${passed} full-day API checks; 24:00 persisted; synthetic database only`);
} finally {
  if (child.exitCode === null && !childError) child.kill();
  if (!childError) await exit;
  await rm(dataDir, { recursive: true, force: true });
}
