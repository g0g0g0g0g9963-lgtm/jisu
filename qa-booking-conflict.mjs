// Synthetic database, fixed clock and mock SSO only. No production/Microsoft writes.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, 'data-qa-booking-conflict', String(Date.now()));
mkdirSync(run, { recursive: true });
const rooms = JSON.parse(readFileSync(resolve(root, 'app/config/rooms.json'), 'utf8'));
// Start from the old schema to verify that existing bookings survive migration.
const legacy = new DatabaseSync(resolve(run, 'bookings.sqlite'));
legacy.exec(`CREATE TABLE bookings(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,date TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,owner TEXT NOT NULL,team TEXT NOT NULL DEFAULT '',purpose TEXT NOT NULL DEFAULT '회의',created_at TEXT NOT NULL)`);
legacy.prepare('INSERT INTO bookings VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-test', rooms[2].id, '2026-10-09', '10:00', '11:00', 'QA legacy', 'QA', 'Preserved purpose', '2026-10-08');
legacy.close();
const socket = net.createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const instant = '2026-10-08T05:15:00Z';
const child = spawn(process.execPath, ['--import', './qa-preload.mjs', 'server/index.mjs'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: run,
    CLIENT_DIR: resolve(root, 'dist'), ALLOW_ANONYMOUS: '', SEED_DEMO: '0', SESSION_SECRET: 'qa-only',
    MS_TENANT_ID: 'qa-tenant', MS_CLIENT_ID: 'qa-client', MS_CLIENT_SECRET: 'qa-only', APP_BASE_URL: base,
    MICROSOFT_TOKEN_KEY: '', ADMIN_MS_EMAIL: '', ADMIN_MS_OBJECT_ID: '', BACKUP_DIR: '', BACKUP_INTERVAL_MINUTES: '0',
    TEST_NOW: instant, TEST_FIXTURE_SSO: '0', TEST_FIXTURE_BOUNDARIES: '0' },
});
let logs = '', browser, db, debugPage;
child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x);
const pause = ms => new Promise(r => setTimeout(r, ms));
const results = [], errors = [];
const check = (name, good) => { assert.ok(good, name); results.push(name); console.log('PASS ' + name); };
async function req(path, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(base + path, { method, redirect: 'manual', headers: {
    ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, json };
}
async function login(code) {
  const start = await req('/auth/login');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const result = await req('/auth/callback?state=' + state + '&code=' + code, { cookie: start.headers.getSetCookie()[0].split(';')[0] });
  assert.equal(result.status, 302);
  return result.headers.getSetCookie().find(c => c.startsWith('bdo-session=') && !c.startsWith('bdo-session=;')).split(';')[0];
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(logs);
    try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
    await pause(100);
  }
  assert.ok(ready, logs);
  db = new DatabaseSync(resolve(run, 'bookings.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  const alice = await login('alice'), bob = await login('bob');
  const list = async () => (await req('/api/bookings', { cookie: alice })).json.bookings;
  const migrated = (await list()).find(b => b.id === 'legacy-test');
  check('legacy database gains revision without losing booking', migrated.revision === 1 && migrated.purpose === 'Preserved purpose');
  const body = { roomId: rooms[0].id, date: '2026-10-08', start: '15:00', end: '16:00', owner: 'QA Alice', team: 'QA', purpose: '주간회의', attendees: ['QA guest'] };
  const create = async (extra = {}) => (await req('/api/bookings', { method: 'POST', cookie: alice, body: { ...body, ...extra } })).json.created[0];
  const patch = (booking, extra = {}, cookie = alice) => req('/api/bookings/' + booking.id, { method: 'PATCH', cookie, body: { ...body, ...booking, expectedRevision: booking.revision, ...extra } });
  const snapshot = id => JSON.stringify({ booking: db.prepare('SELECT * FROM bookings WHERE id=?').get(id),
    audit: db.prepare('SELECT count(*) n FROM booking_audit WHERE booking_id=?').get(id),
    calendar: db.prepare('SELECT desired_json,version FROM calendar_jobs WHERE booking_id=?').get(id) });
  let booking = await create();
  check('created response and list expose revision', booking.revision === 1 && (await list()).find(b => b.id === booking.id).revision === 1);
  const a = await patch(booking, { purpose: '예산회의' });
  check('first edit increments revision', a.status === 200 && a.json.booking.revision === 2);
  const before = snapshot(booking.id);
  const stale = await patch(booking, { team: 'Other team' });
  check('stale edit rejected with owner-only latest booking', stale.status === 409 && stale.json.code === 'booking-changed' && stale.json.latest.purpose === '예산회의');
  check('stale edit leaves booking, audit and Outlook job unchanged', before === snapshot(booking.id));
  for (const value of [undefined, null, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    const result = await patch(booking, { expectedRevision: value });
    check('missing/invalid revision fails closed: ' + String(value), result.status === 428 && before === snapshot(booking.id));
  }
  const forbidden = await patch(booking, {}, bob);
  check('other account receives no latest booking data', forbidden.status === 403 && !forbidden.json.latest);
  const race = await Promise.all(Array.from({ length: 20 }, (_, i) => patch(a.json.booking, { purpose: 'Concurrent ' + i })));
  check('20 simultaneous edits have exactly one winner', race.filter(r => r.status === 200).length === 1 && race.filter(r => r.status === 409 && r.json.code === 'booking-changed').length === 19);
  booking = (await list()).find(b => b.id === booking.id);
  check('race advances revision only once', booking.revision === 3);
  const blocker = await create({ roomId: rooms[1].id });
  const clash = await patch(booking, { roomId: rooms[1].id });
  check('slot conflict stays distinct from stale edits', clash.status === 409 && clash.json.conflict && !clash.json.code);
  await req('/api/bookings/' + blocker.id, { method: 'DELETE', cookie: alice, body: {} });
  await req('/api/bookings/' + booking.id, { method: 'DELETE', cookie: alice, body: {} });
  check('cancelled booking cannot be recreated by stale edit', (await patch(booking)).status === 404);

  booking = await create();
  const { chromium } = await import(pathToFileURL(process.env.QA_PLAYWRIGHT_MODULE));
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Seoul' });
  await context.addCookies([{ name: 'bdo-session', value: alice.split('=')[1], url: base }]);
  const pageA = await context.newPage(), pageB = await context.newPage();
  for (const page of [pageA, pageB]) {
    debugPage = page;
    page.on('pageerror', e => errors.push(e.message));
    await page.clock.setFixedTime(new Date(instant));
    await page.goto(base);
    await page.locator('.timeline-event.is-mine').click();
    await page.getByRole('dialog', { name: '예약 수정', exact: true }).waitFor();
  }
  const editor = pageB.locator('.edit-dialog');
  await pageA.locator('.edit-dialog').getByLabel('회의 목적', { exact: true }).fill('예산회의');
  await pageA.getByRole('button', { name: '수정 저장', exact: true }).click();
  await pageA.locator('.edit-dialog').waitFor({ state: 'detached' });
  await editor.getByLabel('본부', { exact: true }).fill('경영지원본부');
  await editor.getByRole('button', { name: '수정 저장', exact: true }).click();
  const dialog = pageB.locator('.booking-conflict-dialog');
  await dialog.waitFor();
  check('second browser tab sees stale-save warning', await dialog.getByText('예약 내용이 변경되었어요', { exact: true }).isVisible());
  check('decorative refresh icon removed', await dialog.locator('svg,i,.conflict-symbol').count() === 0);
  check('dialog actions have no inherited site footer stripe', await dialog.locator('footer').evaluate(el => getComputedStyle(el).borderBottomWidth === '0px' && getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)'));
  check('underlying editor is inert', await pageB.locator('.edit-backdrop').first().evaluate(el => el.inert));
  await pageB.screenshot({ path: resolve(run, 'warning-desktop.png'), fullPage: true });
  await dialog.screenshot({ path: resolve(run, 'warning-dialog.png') });
  await dialog.getByRole('button', { name: '최신 내용 확인', exact: true }).focus();
  await pageB.keyboard.press('Tab');
  check('keyboard focus stays in topmost dialog', await dialog.getByRole('button', { name: '안내 닫고 입력 내용으로 돌아가기', exact: true }).evaluate(el => el === document.activeElement));
  // Transient read failure does not discard the draft or dismiss the warning.
  await pageB.route('**/api/bookings', route => route.abort(), { times: 1 });
  await dialog.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  check('latest-read failure allows retry without losing draft', await editor.getByLabel('본부', { exact: true }).inputValue() === '경영지원본부');
  await dialog.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
  await dialog.locator('table').waitFor();
  check('comparison shows saved and unsaved purposes', (await dialog.innerText()).includes('예산회의') && (await dialog.innerText()).includes('주간회의'));
  check('comparison highlights only differing fields', await dialog.locator('tbody tr.changed').count() === 2);
  await dialog.screenshot({ path: resolve(run, 'comparison-dialog.png') });
  await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();
  check('Back preserves unsaved purpose and team', await editor.getByLabel('회의 목적', { exact: true }).inputValue() === '주간회의' && await editor.getByLabel('본부', { exact: true }).inputValue() === '경영지원본부');
  await editor.getByRole('button', { name: '수정 저장', exact: true }).click(); await dialog.waitFor();
  await pageB.keyboard.press('Escape');
  check('Escape closes only warning', await editor.isVisible() && await dialog.count() === 0);
  await editor.getByRole('button', { name: '수정 저장', exact: true }).click(); await dialog.waitFor();
  await dialog.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
  await dialog.getByRole('button', { name: '최신 내용으로 다시 수정', exact: true }).click();
  check('explicit reload updates draft to latest', await editor.getByLabel('회의 목적', { exact: true }).inputValue() === '예산회의' && await editor.getByLabel('본부', { exact: true }).inputValue() === 'QA');
  await editor.getByLabel('본부', { exact: true }).fill('경영지원본부');
  await editor.getByRole('button', { name: '수정 저장', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  booking = (await list()).find(b => b.id === booking.id);
  check('resave preserves first tab purpose and second tab team', booking.purpose === '예산회의' && booking.team === '경영지원본부' && booking.revision === 3);
  await pageB.locator('.timeline-event.is-mine').click();
  await patch(booking, { purpose: '추가 변경' });
  await editor.getByRole('button', { name: '수정 저장', exact: true }).click(); await dialog.waitFor();
  await req('/api/bookings/' + booking.id, { method: 'DELETE', cookie: alice, body: {} });
  await dialog.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  check('deletion during conflict review gives clear notice', (await dialog.getByRole('alert').innerText()).includes('예약이 취소되었거나'));
  await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();
  await editor.getByRole('button', { name: '수정 저장', exact: true }).click();
  await pageB.getByText('예약을 찾을 수 없습니다.', { exact: true }).waitFor();
  check('deleted reservation remains absent', !(await list()).some(b => b.id === booking.id));
  check('no browser runtime errors', errors.length === 0);
  writeFileSync(resolve(run, 'results.json'), JSON.stringify({ passed: results.length, results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, evidence: run }));
} catch (error) {
  if (debugPage) {
    await debugPage.screenshot({ path: resolve(run, 'failure.png'), fullPage: true });
    console.log(JSON.stringify({ url: debugPage.url(), text: (await debugPage.locator('body').innerText()).slice(0, 3500), errors, run }));
  }
  throw error;
} finally {
  if (browser) await browser.close();
  db?.close(); child.kill();
}
