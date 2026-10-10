// Isolated administrator statistics UI regression. All identities and reservations are synthetic.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import net from 'node:net';

const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, 'data-qa-admin-usage-ui', String(Date.now()));
mkdirSync(run, { recursive: true });
const results = [], errors = [], children = [];
const rooms = JSON.parse(readFileSync(resolve(root, 'app/config/rooms.json'), 'utf8'));
const record = (name, ok) => { assert.ok(ok, name); results.push(name); console.log('PASS ' + name); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, server, testPage;

async function start() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = 'http://127.0.0.1:' + port, data = resolve(run, 'data');
  mkdirSync(data, { recursive: true });
  const env = { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data,
    CLIENT_DIR: resolve(root, 'dist'), ALLOW_ANONYMOUS: '', SEED_DEMO: '0', SESSION_SECRET: 'qa-only',
    MS_TENANT_ID: 'qa-tenant', MS_CLIENT_ID: 'qa-client', MS_CLIENT_SECRET: 'qa-only', APP_BASE_URL: base,
    ADMIN_MS_EMAIL: 'alice@example.invalid', ADMIN_MS_OBJECT_ID: '', BACKUP_DIR: resolve(data, 'backups'),
    BACKUP_INTERVAL_MINUTES: '0', TEST_FIXTURE_SSO: '0', TEST_FIXTURE_BOUNDARIES: '0', TEST_NOW: '2026-10-09T01:00:00Z' };
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(root, 'qa-preload.mjs')).href, 'server/index.mjs'],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let logs = '';
  child.stdout.on('data', chunk => logs += chunk);
  child.stderr.on('data', chunk => logs += chunk);
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error(logs);
    try { if ((await fetch(base + '/api/health')).ok) return { base, data, logs: () => logs }; } catch {}
    await pause(100);
  }
  throw Error('Isolated server startup timed out: ' + logs);
}
async function request(path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(server.base + path, { method, redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { response, status: response.status, text, json };
}
async function login(code) {
  const begin = await request('/auth/login?returnTo=/admin');
  const state = new URL(begin.response.headers.get('location')).searchParams.get('state');
  const cookie = begin.response.headers.getSetCookie()[0].split(';')[0];
  const end = await request('/auth/callback?state=' + state + '&code=' + code, { cookie });
  assert.equal(end.status, 302);
  return end.response.headers.getSetCookie().find(value => value.startsWith('bdo-session=') && !value.startsWith('bdo-session=;')).split(';')[0];
}
async function create(cookie, roomIndex, start, end) {
  const result = await request('/api/bookings', { cookie, method: 'POST', body: {
    roomId: rooms[roomIndex].id, date: '2026-10-09', start, end, owner: 'Synthetic input ignored', team: 'QA',
    purpose: 'QA 이용 통계 화면 검증용 가상 예약', attendees: [] } });
  assert.equal(result.status, 201, result.text);
  return result.json.created[0];
}
async function authenticatedContext(cookie, viewport = { width: 1366, height: 768 }) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{ name: 'bdo-session', value: cookie.split('=')[1], url: server.base }]);
  await context.addInitScript(() => {
    const NativeDate = Date, fixed = NativeDate.parse('2026-10-09T05:00:00Z');
    window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };
  });
  return context;
}
async function ready(page) {
  await page.locator('.admin-usage-summary').waitFor();
  assert.equal(await page.locator('.admin-usage-state[role="status"]').count(), 0);
}

try {
  server = await start();
  const alice = await login('alice');
  record('Configured Microsoft account receives administrator role and pins its object ID', (await request('/api/me', { cookie: alice })).json.user.isAdmin === true);
  const bob = await login('bob'), same = await login('same'), spoof = await login('spoof');
  record('Anonymous statistics request requires authentication', (await request('/api/admin/usage')).status === 401);
  record('Ordinary employee statistics request is forbidden', (await request('/api/admin/usage', { cookie: bob })).status === 403);
  record('Same-name different-ID employee is not administrator', (await request('/api/me', { cookie: spoof })).json.user.isAdmin === false);
  const modulePath = process.env.QA_PLAYWRIGHT_MODULE || 'C:/Users/김지수JisuKim/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
  const { chromium } = await import(pathToFileURL(modulePath));
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await authenticatedContext(alice);
  const page = await context.newPage(); testPage = page;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.base + '/');
  await page.getByRole('link', { name: '관리자 모드', exact: true }).waitFor();
  record('Authentic administrator sees 관리자 모드 in reservation header', await page.getByRole('link', { name: '관리자 모드', exact: true }).isVisible());
  await page.getByRole('link', { name: '관리자 모드', exact: true }).click();
  await page.getByRole('heading', { name: '회의실 운영 관리', exact: true }).waitFor();
  record('Header administrator link opens protected /admin', new URL(page.url()).pathname === '/admin');
  await page.getByRole('button', { name: '이용 통계', exact: true }).click();
  await ready(page);
  record('Statistics starts with real empty database, not example numbers', await page.getByText('선택한 기간에 남아 있는 예약이 없습니다.', { exact: false }).isVisible());
  record('Empty data lists all configured rooms', await page.locator('.admin-usage-rooms > li').count() === rooms.length);
  record('Empty data lists all 24 hours', await page.locator('.admin-usage-hour').count() === 24);
  record('No-data employee ranking clearly empty', await page.getByText('집계할 직원 예약이 없습니다.', { exact: true }).isVisible());
  record('Default last 30 days is exact in site timezone', await page.getByLabel('조회 시작일', { exact: true }).inputValue() === '2026-09-10' && await page.getByLabel('조회 종료일', { exact: true }).inputValue() === '2026-10-09');
  await page.screenshot({ path: resolve(run, 'usage-empty-1366.png'), fullPage: true });

  for (const hour of [10, 11, 12, 13, 14]) await create(alice, 0, `${hour}:00`, `${hour}:30`);
  for (const roomIndex of [4, 5]) for (const hour of [10, 11]) await create(alice, roomIndex, `${hour}:00`, `${hour + 1}:00`);
  for (const hour of [10, 11, 12]) await create(bob, 1, `${hour}:00`, `${hour + 1}:00`);
  for (const hour of [12, 13]) await create(bob, 5, `${hour}:00`, `${hour + 1}:00`);
  await create(bob, 6, '10:00', '11:00');
  for (const roomIndex of [2, 3]) for (const hour of [10, 11]) await create(same, roomIndex, `${hour}:00`, `${hour}:30`);
  for (const hour of [10, 11]) await create(spoof, 7, `${hour}:00`, `${hour + 1}:00`);
  const stats = await request('/api/admin/usage?from=2026-09-10&to=2026-10-09', { cookie: alice });
  record('21 synthetic reservations persist through real API', stats.status === 200 && stats.json.summary.bookings === 21);
  record('Statistics response is private/no-store', stats.response.headers.get('cache-control') === 'no-store');
  record('Identical display names are separate employee accounts', stats.json.users.filter(user => user.name === 'QA Alice').length === 2 && stats.json.summary.identifiedUsers === 4);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await ready(page);
  const summaries = await page.locator('.admin-usage-summary > div > strong').allTextContents();
  record('Live summary displays 21 bookings and four accounts', summaries[0] === '21건' && summaries[1] === '4명');
  record('Employee ranking is correct descending booking counts', (await page.locator('.admin-usage-table tbody tr td:nth-child(3)').allTextContents()).join(',') === '9건,6건,4건,2건');
  record('Employee ranking visibly distinguishes duplicate names by account', await page.locator('.admin-usage-table tbody tr').filter({ hasText: 'QA Alice' }).count() === 2 && await page.locator('.admin-usage-table tbody tr').count() === 4);
  record('Even duplicate email identities show distinct short account keys', new Set(await page.locator('.admin-usage-table tbody tr').filter({ hasText: 'QA Alice' }).locator('th small:last-child').allTextContents()).size === 2);
  record('Room ranking shows busiest room first', (await page.locator('.admin-usage-rooms > li').first().innerText()).includes('Conference Room 1') && (await page.locator('.admin-usage-rooms > li').first().innerText()).includes('5건'));
  record('All room and 24-hour elements remain present with bookings', await page.locator('.admin-usage-rooms > li').count() === rooms.length && await page.locator('.admin-usage-hour').count() === 24);
  record('Count-vs-actual-usage interpretation is documented', await page.getByText('사이트 방문 횟수·로그인 횟수나 실제 회의 참석 기록은 아닙니다.', { exact: false }).isVisible());
  for (const width of [1366, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 768 });
    await page.evaluate(() => window.scrollTo(0, 0));
    record(`No horizontal desktop overflow at ${width}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    record(`All 24-hour bars fit chart at ${width}`, await page.locator('.admin-usage-chart-bars').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: resolve(run, `admin-usage-demo-${width}.png`), fullPage: true });
  }
  const apply = async (from, to) => {
    await page.getByLabel('조회 시작일', { exact: true }).fill(from);
    await page.getByLabel('조회 종료일', { exact: true }).fill(to);
    await page.getByRole('button', { name: '기간 적용', exact: true }).click();
  };
  await page.getByRole('button', { name: '이번 달', exact: true }).click(); await ready(page);
  record('This-month preset starts first day', await page.getByLabel('조회 시작일', { exact: true }).inputValue() === '2026-10-01');
  await page.getByRole('button', { name: '최근 90일', exact: true }).click(); await ready(page);
  record('90-day preset counts inclusive days', await page.getByLabel('조회 시작일', { exact: true }).inputValue() === '2026-07-12');
  await apply('2026-10-01', '2026-10-08'); await ready(page);
  record('Custom range excludes bookings outside selected days', (await page.locator('.admin-usage-summary > div > strong').first().innerText()) === '0건');
  await apply('2026-10-10', '2026-10-09');
  await page.getByText('조회 종료일은 시작일보다 빠를 수 없습니다.', { exact: true }).waitFor();
  record('Reversed custom dates show inline validation without misleading data', await page.locator('.admin-usage-period').innerText().then(value => value.includes('2026.10.01 – 2026.10.08')));
  await apply('2025-01-01', '2026-10-09');
  record('More than 366 days cannot be applied', await page.getByText('한 번에 최대 366일까지 조회할 수 있습니다.', { exact: true }).isVisible());
  await page.getByLabel('조회 시작일', { exact: true }).fill('');
  await page.getByRole('button', { name: '기간 적용', exact: true }).click();
  record('Blank start date cannot be applied', await page.getByText('조회 시작일과 종료일을 올바르게 입력해 주세요.', { exact: true }).isVisible());
  await page.getByRole('button', { name: '최근 30일', exact: true }).click(); await ready(page);

  let mode = 'normal', releaseOld, signalHeld;
  const held = new Promise(resolve => { signalHeld = resolve; });
  await page.route('**/api/admin/usage?*', async route => {
    if (mode === 'fail') { mode = 'normal'; return route.abort('failed'); }
    if (mode === 'forbidden') return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'QA synthetic revoked administrator' }) });
    if (mode === 'malformed') {
      mode = 'normal';
      const response = await route.fetch(), data = await response.json();
      delete data.summary.bookedMinutes;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    }
    if (mode === 'hold') {
      mode = 'normal'; const response = await route.fetch();
      signalHeld(); await new Promise(resolve => { releaseOld = resolve; });
      return route.fulfill({ response });
    }
    return route.continue();
  });
  mode = 'fail';
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('button', { name: '통계 다시 조회', exact: true }).waitFor();
  record('Network error has visible retry', await page.getByText('이용 통계를 불러오지 못했습니다.', { exact: false }).isVisible());
  record('Failed refresh does not display stale employee or summary data', await page.locator('.admin-usage-summary').count() === 0 && await page.locator('.admin-usage-table').count() === 0);
  await page.getByRole('button', { name: '통계 다시 조회', exact: true }).click(); await ready(page);
  record('Retry recovers real statistics', (await page.locator('.admin-usage-summary > div > strong').first().innerText()) === '21건');
  mode = 'malformed';
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('button', { name: '통계 다시 조회', exact: true }).waitFor();
  record('Malformed HTTP-200 response is safely rejected without rendering broken statistics', await page.locator('.admin-usage-summary').count() === 0 && errors.length === 0);
  await page.getByRole('button', { name: '통계 다시 조회', exact: true }).click(); await ready(page);
  mode = 'hold';
  await page.getByRole('button', { name: '최근 90일', exact: true }).click(); await held;
  record('Pending new range hides the previous result', await page.locator('.admin-usage-summary').count() === 0);
  await page.getByRole('button', { name: '이번 달', exact: true }).click(); await ready(page);
  releaseOld(); await pause(150);
  record('Delayed previous request cannot overwrite latest range', (await page.locator('.admin-usage-period').innerText()).includes('2026.10.01 – 2026.10.09') && await page.getByRole('button', { name: '이번 달', exact: true }).getAttribute('aria-pressed') === 'true');
  await page.getByRole('button', { name: '운영 현황', exact: true }).click();
  await page.getByRole('heading', { name: '백업·검증', exact: true }).waitFor();
  record('Existing operations overview remains usable', await page.getByRole('button', { name: '지금 백업', exact: true }).isVisible());
  await page.getByRole('button', { name: '변경 이력', exact: true }).click();
  await page.locator('.admin-audit-list article').first().waitFor();
  record('Existing audit tab shows all synthetic creation events', await page.locator('.admin-audit-list article').count() === 21);
  await page.getByRole('button', { name: '복구·대응 안내', exact: true }).click();
  record('Existing recovery guide remains usable', await page.getByRole('heading', { name: '복원·업데이트 복구', exact: true }).isVisible());
  await page.getByRole('button', { name: '이용 통계', exact: true }).click(); await ready(page);
  mode = 'forbidden';
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.getByRole('heading', { name: '관리자 전용 페이지입니다', exact: true }).waitFor();
  record('Revoked authorization clears all sensitive statistics', await page.locator('.admin-shell').count() === 0 && await page.locator('.admin-usage-table').count() === 0 && !(await page.locator('body').innerText()).includes('alice@example.invalid'));
  await page.screenshot({ path: resolve(run, 'usage-access-revoked.png'), fullPage: true });
  const normal = await authenticatedContext(bob);
  const ordinary = await normal.newPage();
  const leakedRequests = [];
  ordinary.on('request', request => { if (request.url().includes('/api/admin/')) leakedRequests.push(request.url()); });
  await ordinary.goto(server.base + '/');
  await ordinary.getByText('QA Bob님', { exact: false }).waitFor();
  record('Normal employees do not see administrator or usage links', await ordinary.getByRole('link', { name: '관리자 모드', exact: true }).count() === 0 && await ordinary.getByRole('button', { name: '이용 통계', exact: true }).count() === 0);
  record('Normal reservation screen does not request protected admin data', leakedRequests.length === 0);
  record('Normal employee direct admin page request returns 403', (await ordinary.goto(server.base + '/admin')).status() === 403);
  record('No browser runtime errors', errors.length === 0);
  await normal.close(); await context.close();
  const result = { passed: results.length, results, errors, evidence: run, syntheticOnly: true, dataChanges: 'Only unique isolated DATA_DIR', summary: stats.json.summary };
  writeFileSync(resolve(run, 'results.json'), JSON.stringify(result, null, 2));
  console.log('RESULT ' + JSON.stringify(result));
} catch (error) {
  if (testPage) await testPage.screenshot({ path: resolve(run, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(resolve(run, 'failure.json'), JSON.stringify({ passed: results.length, results, errors, failure: error.stack, server: server?.logs() }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  for (const child of children) child.kill();
}
