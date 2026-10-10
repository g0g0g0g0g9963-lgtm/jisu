// Isolated shared-monitor UI regression. No production data or Microsoft calls.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import net from 'node:net';

const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, 'data-qa-kiosk-ui', String(Date.now()));
mkdirSync(run, { recursive: true });
const fixedNow = '2026-10-12T01:00:00Z';
const pairingCode = 'synthetic-kiosk-ui-pairing-code-' + randomUUID();
const results = [], errors = [], children = [];
const personalSources = ['app/page.tsx', 'app/globals.css'];
const personalHashes = personalSources.map(path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'));
const record = (name, ok) => { assert.ok(ok, name); results.push(name); console.log('PASS ' + name); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, server, page;

async function start() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = 'http://127.0.0.1:' + port, data = resolve(run, 'data');
  mkdirSync(data, { recursive: true });
  const env = { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data,
    CLIENT_DIR: resolve(root, 'dist'), ALLOW_ANONYMOUS: '', SEED_DEMO: '0', SESSION_SECRET: 'qa-kiosk-only',
    MS_TENANT_ID: 'qa-tenant', MS_CLIENT_ID: 'qa-client', MS_CLIENT_SECRET: 'qa-only', APP_BASE_URL: base,
    ADMIN_MS_EMAIL: 'alice@example.invalid', ADMIN_MS_OBJECT_ID: '', BACKUP_DIR: resolve(data, 'backups'),
    BACKUP_INTERVAL_MINUTES: '0', TEST_FIXTURE_SSO: '0', TEST_FIXTURE_BOUNDARIES: '0', TEST_NOW: fixedNow,
    KIOSK_ENABLED: '1', KIOSK_PAIRING_CODE: pairingCode };
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(root, 'qa-preload.mjs')).href, 'server/index.mjs'],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let logs = '';
  child.stdout.on('data', chunk => logs += chunk);
  child.stderr.on('data', chunk => logs += chunk);
  // OneDrive-backed workspaces can take longer to hydrate Node dependencies.
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) throw Error(logs);
    try { if ((await fetch(base + '/api/health')).ok) return { base, data, logs: () => logs }; } catch {}
    await pause(100);
  }
  throw Error('Isolated server startup timed out: ' + logs);
}
async function request(path, { cookie, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(server.base + path, { method, redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { response, status: response.status, text, json };
}
async function staffLogin() {
  const begin = await request('/auth/login?returnTo=/admin');
  const state = new URL(begin.response.headers.get('location')).searchParams.get('state');
  const cookie = begin.response.headers.getSetCookie()[0].split(';')[0];
  const end = await request('/auth/callback?state=' + state + '&code=alice', { cookie });
  assert.equal(end.status, 302);
  return end.response.headers.getSetCookie().find(value => value.startsWith('bdo-session=') && !value.startsWith('bdo-session=;')).split(';')[0];
}
async function fixtureSession() {
  const result = await request('/api/kiosk/session', { method: 'POST', body: { code: pairingCode },
    headers: { Origin: server.base, 'X-Kiosk-Action': 'pair' } });
  assert.equal(result.status, 200, result.text);
  return { cookie: result.response.headers.getSetCookie().find(value => value.startsWith('bdo-kiosk-device=')).split(';')[0], csrf: result.json.csrfToken };
}
async function create(session, roomId, date, start, end, owner) {
  const result = await request('/api/kiosk/bookings', { method: 'POST', cookie: session.cookie,
    headers: { Origin: server.base, 'X-Kiosk-CSRF': session.csrf, 'Idempotency-Key': randomUUID() },
    body: { roomId, date, start, end, owner, purpose: '공용 모니터 화면 시험용 가상 예약' } });
  assert.equal(result.status, 201, result.text);
  return result.json.created[0];
}
async function ready() {
  await page.getByTestId('kiosk-scroll').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="kiosk-scroll"]')?.getAttribute('data-ready') === 'true');
}
async function wakeRefresh() {
  // The same non-mutating refresh used when an unattended monitor becomes visible.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}
async function slot(roomId = '9-c2', date = '2026-10-12', time = '14:00') {
  const target = page.locator(`[data-testid="kiosk-slot"][data-room="${roomId}"][data-date="${date}"][data-start="${time}"]`);
  await target.scrollIntoViewIfNeeded();
  return target;
}
async function closePanel() {
  await page.getByTestId('kiosk-quick-close').click();
  await page.getByTestId('kiosk-quick-panel').waitFor({ state: 'hidden' });
}
async function visibleDates(roomId = '9-c1') {
  return page.locator(`[data-testid="kiosk-slot"][data-room="${roomId}"]`).evaluateAll(elements => [...new Set(elements.map(element => element.dataset.date))]);
}
async function waitForDay(date) {
  await page.waitForFunction(expected => {
    const slots = [...document.querySelectorAll('[data-testid="kiosk-slot"]')];
    return slots.length > 0 && slots.every(element => element.dataset.date === expected);
  }, date);
  await ready();
}
async function toolbarControlsFit() {
  return page.evaluate(() => {
    const selectors = ['[data-testid="kiosk-hero-date"]', '.kiosk-floor-tabs', '.kiosk-date-navigation', '.kiosk-view-tabs'];
    const boxes = selectors.map(selector => document.querySelector(selector).getBoundingClientRect());
    const panel = document.querySelector('[data-testid="kiosk-quick-panel"]').getBoundingClientRect();
    return boxes.every(box => box.left >= 0 && box.right <= panel.left + 1) && boxes.every((box, index) => boxes.slice(index + 1).every(other => {
      const overlapX = Math.min(box.right, other.right) - Math.max(box.left, other.left);
      const overlapY = Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
      return overlapX <= 1 || overlapY <= 1;
    }));
  });
}
async function verifyHourlyGrid(mode) {
  const styles = await page.getByTestId('kiosk-slot').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    const channels = style.borderTopColor.match(/[\d.]+/g).map(Number);
    return { hour: element.classList.contains('is-hour'), border: style.borderTopWidth, alpha: channels.length === 4 ? channels[3] : 1, height: element.getBoundingClientRect().height };
  }));
  record(`${mode} view has only faint hourly lines and transparent half-hour boundaries`,
    styles.length > 0 && styles.every(style => style.border === '1px' && style.height === 40 && Math.abs(style.alpha - (style.hour ? .07 : 0)) < .001));
  const area = page.getByTestId('kiosk-scroll');
  const prior = await area.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
  const target = await slot('9-c4', '2026-10-12', '12:30');
  await target.hover();
  const hover = await page.getByTestId('kiosk-slot').evaluateAll(elements => elements.filter(element => {
    const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g).map(Number);
    return channels.length === 3 || channels[3] > 0;
  }).map(element => ({ room: element.dataset.room, start: element.dataset.start, height: element.getBoundingClientRect().height })));
  record(`${mode} hover highlights only one unchanged 30-minute slot`,
    hover.length === 1 && hover[0].room === '9-c4' && hover[0].start === '12:30' && hover[0].height === 40 &&
    !(await page.getByTestId('kiosk-quick-panel').isVisible()));
  await page.mouse.move(5, 5);
  await area.evaluate((element, position) => { element.scrollLeft = position.left; element.scrollTop = position.top; }, prior);
}
async function verifyRoomSeparators(mode) {
  const area = page.getByTestId('kiosk-scroll');
  await area.evaluate(element => { element.scrollLeft = 0; });
  const layout = await page.evaluate(() => {
    const shell = document.querySelector('.kiosk-calendar-shell'), shellStyle = getComputedStyle(shell);
    const headers = [...document.querySelectorAll('[data-testid="kiosk-room-header"]')];
    const bodies = [...document.querySelectorAll('.kiosk-room-body')];
    const aligned = headers.every((header, index) => {
      const head = header.getBoundingClientRect(), body = bodies[index].getBoundingClientRect();
      return Math.abs(head.left - body.left) <= 1 && Math.abs(head.right - body.right) <= 1 &&
        parseFloat(getComputedStyle(header).borderRightWidth) <= 1 && parseFloat(getComputedStyle(bodies[index]).borderRightWidth) <= 1;
    });
    const last = bodies[0].lastElementChild.getBoundingClientRect(), next = bodies[1].firstElementChild.getBoundingClientRect();
    const head = headers[0].getBoundingClientRect(), scroll = document.querySelector('.kiosk-scroll').getBoundingClientRect();
    const x = (last.right + next.left) / 2, y = Math.min(head.bottom + 70, scroll.bottom - 25);
    const target = document.elementFromPoint(x, y);
    return { flat: shellStyle.borderTopWidth === '0px' && shellStyle.borderRadius === '0px' && shellStyle.boxShadow === 'none', aligned,
      gap: next.left - last.right, x, y, gapIsNotBooking: !target?.closest('[data-testid="kiosk-slot"],[data-testid="kiosk-booking"]') };
  });
  record(`${mode} timetable uses a flat borderless outer frame`, layout.flat);
  record(`${mode} room headers and bodies align with thin boundaries and real spacing`, layout.aligned && layout.gap >= 8 && layout.gap <= 13);
  record(`${mode} room spacing is outside all reservation hit targets`, layout.gapIsNotBooking);
  await page.mouse.click(layout.x, layout.y);
  record(`${mode} clicking room spacing cannot start a reservation`, !(await page.getByTestId('kiosk-quick-panel').isVisible()));
}
function contrastRatio(foreground, background) {
  const light = value => {
    const rgb = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
      const normalized = channel / 255;
      return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
    });
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const a = light(foreground), b = light(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

try {
  server = await start();
  const staff = await staffLogin(), fixture = await fixtureSession();
  const seed = await create(fixture, '9-c1', '2026-10-12', '13:00', '14:00', '가상 직원 가');
  const seed12 = await create(fixture, '12-big', '2026-10-13', '11:00', '12:00', '가상 직원 나');
  record('Synthetic reservations are created only in the isolated shared database', seed.roomId === '9-c1');
  const modulePath = process.env.QA_PLAYWRIGHT_MODULE || 'C:/Users/김지수JisuKim/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
  const { chromium } = await import(pathToFileURL(modulePath));
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, hasTouch: true });
  await context.addCookies([{ name: 'bdo-session', value: staff.split('=')[1], url: server.base }]);
  await context.addInitScript(value => {
    const NativeDate = Date; let fixed = NativeDate.parse(value);
    window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };
    window.__kioskQaAdvanceNow = milliseconds => { fixed += milliseconds; };
  }, fixedNow);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const protectedRequests = [];
  page.on('request', request => { if (/\/api\/admin\//.test(request.url())) protectedRequests.push(request.url()); });
  const initial = await page.goto(server.base + '/kiosk?preview=1');
  record('Separate public kiosk shell is available without bypassing employee login', initial.status() === 200);
  await page.getByTestId('kiosk-connect-code').waitFor();
  record('Microsoft administrator cookie does not automatically authorize a shared terminal', await page.getByTestId('kiosk-scroll').count() === 0);
  await page.getByTestId('kiosk-connect-code').fill(pairingCode);
  await page.getByTestId('kiosk-connect-submit').click();
  await ready();
  record('Explicit device pairing opens the shared-monitor schedule', await page.getByTestId('kiosk-scroll').isVisible());
  record('The removed heading, guidance, preview note, sync status and regular refresh controls are absent',
    await page.getByRole('heading', { name: '회의실 예약', exact: true }).count() === 0 &&
    await page.getByText('실제 예약에 반영되지 않음', { exact: false }).count() === 0 &&
    await page.getByText('옆으로 넘겨 회의실을 확인하고', { exact: false }).count() === 0 &&
    await page.getByTestId('kiosk-last-updated').count() === 0 && await page.getByTestId('kiosk-refresh').count() === 0 && await page.getByTestId('kiosk-retry').count() === 0);
  record('The current time starts near the top of the timetable', await page.getByTestId('kiosk-scroll').evaluate(element => Math.abs(element.scrollTop - 784) < 50));
  record('Kiosk has no administrator or personal booking menus', await page.getByRole('link', { name: '관리자 모드', exact: true }).count() === 0 && await page.getByRole('button', { name: '내 예약', exact: true }).count() === 0 && protectedRequests.length === 0);
  record('Footer retains only its legend and name hint, without current-time or room-navigation buttons',
    await page.locator('.kiosk-footer button').count() === 0 && await page.locator('.kiosk-room-navigation').count() === 0 &&
    await page.getByRole('button', { name: '이전 회의실 보기', exact: true }).count() === 0 &&
    await page.getByRole('button', { name: '다음 회의실 보기', exact: true }).count() === 0 &&
    await page.locator('.kiosk-footer').getByText('예약됨', { exact: false }).count() > 0 &&
    await page.locator('.kiosk-footer').getByText('현재 시간', { exact: false }).count() > 0 &&
    await page.locator('.kiosk-footer').getByText('예약자 이름은 매번 직접 입력합니다.', { exact: true }).count() === 1);
  record('Floor starts at 9F with four separate room groups', (await page.getByTestId('kiosk-room-header').count()) === 4);
  record('The large selected date, day/week switch and calendar are available with week view as default',
    await page.getByTestId('kiosk-hero-date').isVisible() && await page.getByTestId('kiosk-calendar-toggle').isVisible() &&
    await page.getByTestId('kiosk-view-week').getAttribute('aria-pressed') === 'true' &&
    await page.getByTestId('kiosk-view-day').getAttribute('aria-pressed') === 'false');
  record('Every room always shows Monday through Sunday with no weekend switch',
    (await page.locator('[data-testid="kiosk-slot"][data-room="9-c1"]').evaluateAll(elements => [...new Set(elements.map(element => element.dataset.date))])).join(',') === '2026-10-12,2026-10-13,2026-10-14,2026-10-15,2026-10-16,2026-10-17,2026-10-18' &&
    await page.getByTestId('kiosk-weekend-toggle').count() === 0);
  await verifyHourlyGrid('Weekly');
  await verifyRoomSeparators('Weekly');
  record('Each room header includes the existing SVG equipment icon style', await page.getByTestId('kiosk-room-header').evaluateAll(elements => elements.every(element => element.querySelector('.room-equipment-chip svg'))));
  const firstRoomHeader = page.locator('[data-testid="kiosk-room-header"][data-room="9-c1"]');
  record('Equipment previews use the employee-site order with the screen behind primary equipment',
    (await firstRoomHeader.locator('.room-equipment-chip:not(.room-equipment-more)').allTextContents()).join(',') === '프로젝터,화이트보드');
  await firstRoomHeader.getByRole('button', { name: '추가 장비 1개 · Conference Room 1 전체 장비 보기', exact: true }).tap();
  const equipmentDialog = page.getByRole('dialog', { name: '9층 Conference Room 1 장비', exact: true });
  await equipmentDialog.waitFor();
  record('Tapping the equipment plus button opens all actual equipment without opening a booking',
    (await equipmentDialog.locator('li').allTextContents()).join(',') === '프로젝터,화이트보드,스크린' &&
    !(await page.getByTestId('kiosk-quick-panel').isVisible()));
  await page.screenshot({ path: resolve(run, 'kiosk-equipment-popover-1366.png'), fullPage: true });
  await equipmentDialog.getByRole('button', { name: '장비 정보 닫기', exact: true }).click();
  record('Equipment details close without leaving a blocking dialog', !(await equipmentDialog.isVisible()));
  await firstRoomHeader.getByRole('button', { name: '추가 장비 1개 · Conference Room 1 전체 장비 보기', exact: true }).tap();
  await equipmentDialog.waitFor();
  await page.getByTestId('kiosk-scroll').evaluate(element => { element.scrollTop += 30; });
  await equipmentDialog.waitFor({ state: 'hidden' });
  record('Scrolling the timetable automatically dismisses equipment details', !(await equipmentDialog.isVisible()));
  const automaticRefresh = await page.waitForRequest(request => request.url().includes('/api/kiosk/bookings?') && request.method() === 'GET', { timeout: 35000 });
  record('Automatic background refresh continues with no normal refresh control', automaticRefresh.url().includes('from=2026-10-12') && automaticRefresh.url().includes('to=2026-10-18'));
  await ready();
  await page.getByTestId('kiosk-floor-12').click();
  await ready();
  record('12F uses requested W Room, large-room, 1, 2, 3 order', (await page.getByTestId('kiosk-room-header').evaluateAll(elements => elements.map(element => element.dataset.room))).join(',') === '12-w,12-big,12-r1,12-r2,12-r3');
  await page.screenshot({ path: resolve(run, 'kiosk-12f-1366.png'), fullPage: true });
  await page.getByTestId('kiosk-week-next').click(); await ready();
  record('Next-week navigation advances the actual requested date', await page.locator('[data-testid="kiosk-slot"][data-date="2026-10-19"]').count() > 0);
  record('A different week has no misleading current-time line', await page.getByTestId('kiosk-now-line').count() === 0);
  await page.getByTestId('kiosk-week-today').click(); await ready();
  record('This-week navigation returns to the current week', await page.locator('[data-testid="kiosk-slot"][data-date="2026-10-12"]').count() > 0);
  await page.getByTestId('kiosk-floor-9').click(); await ready();

  // Date selection is independent of layout. Mode changes must not silently
  // replace a chosen weekday with Monday or turn an old fetch into fresh data.
  await page.getByTestId('kiosk-view-day').click(); await waitForDay('2026-10-12');
  record('Daily view shows only the selected date with every room side by side',
    (await visibleDates()).join(',') === '2026-10-12' && await page.getByTestId('kiosk-room-header').count() === 4 &&
    await page.getByTestId('kiosk-view-day').getAttribute('aria-pressed') === 'true');
  await verifyHourlyGrid('Daily');
  await verifyRoomSeparators('Daily');
  record('Daily view shows today reservations and one current-time line',
    await page.locator(`[data-testid="kiosk-booking"][data-booking-id="${seed.id}"]`).count() === 1 &&
    await page.getByTestId('kiosk-now-line').count() === 1);
  const dayLineAligned = await page.evaluate(() => {
    const line = document.querySelector('[data-testid="kiosk-now-line"]').getBoundingClientRect();
    const pointer = document.querySelector('.kiosk-now-label').getBoundingClientRect();
    return Math.abs(line.y + line.height / 2 - pointer.y - pointer.height / 2) <= 2;
  });
  record('The daily current-time pointer stays aligned after the smaller room header',
    dayLineAligned);
  for (const viewport of [{ width: 1242, height: 668 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    record(`Daily view keeps the header and timetable inside the ${viewport.width}px screen`,
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1));
    await page.screenshot({ path: resolve(run, `kiosk-day-${viewport.width}.png`), fullPage: true });
  }
  await page.getByTestId('kiosk-week-next').click(); await waitForDay('2026-10-13');
  record('Daily next-date navigation advances by one day and removes a misleading current-time line',
    (await visibleDates()).join(',') === '2026-10-13' && await page.getByTestId('kiosk-now-line').count() === 0 &&
    await page.locator(`[data-testid="kiosk-booking"][data-booking-id="${seed.id}"]`).count() === 0);
  await page.getByTestId('kiosk-floor-12').click(); await ready();
  record('Daily floor selection preserves the chosen date and shows the corresponding reservation',
    (await visibleDates('12-big')).join(',') === '2026-10-13' && await page.getByTestId('kiosk-room-header').count() === 5 &&
    await page.locator(`[data-testid="kiosk-booking"][data-booking-id="${seed12.id}"]`).count() === 1);
  await page.getByTestId('kiosk-view-week').click(); await ready();
  await page.getByTestId('kiosk-week-next').click(); await ready();
  await page.getByTestId('kiosk-view-day').click(); await waitForDay('2026-10-20');
  record('Weekly next navigation advances seven days while keeping the selected weekday across mode changes',
    (await visibleDates('12-big')).join(',') === '2026-10-20');
  await page.getByTestId('kiosk-week-prev').click(); await waitForDay('2026-10-19');
  record('Daily previous-date navigation moves back exactly one day', (await visibleDates('12-big')).join(',') === '2026-10-19');
  await page.getByTestId('kiosk-quick-open').click();
  record('Quick booking from a future daily view starts on that selected date with no previous visitor name',
    await page.getByTestId('kiosk-date').inputValue() === '2026-10-19' && await page.getByTestId('kiosk-owner').inputValue() === '');
  await closePanel();
  await page.getByTestId('kiosk-week-today').click(); await waitForDay('2026-10-12');
  record('Today navigation returns to today without unexpectedly changing daily mode',
    await page.getByTestId('kiosk-view-day').getAttribute('aria-pressed') === 'true' && await page.getByTestId('kiosk-now-line').count() === 1);
  await page.getByTestId('kiosk-floor-9').click(); await ready();
  await page.getByTestId('kiosk-calendar-toggle').click();
  await page.locator('.kiosk-calendar-days button[data-date-key="2026-10-12"]').waitFor();
  await page.keyboard.press('ArrowRight');
  record('Calendar keyboard movement changes focus without changing the selected date',
    await page.evaluate(() => document.activeElement?.getAttribute('data-date-key')) === '2026-10-13' &&
    await page.getByTestId('kiosk-hero-date').getAttribute('data-date') === '2026-10-12');
  await page.keyboard.press('Escape');
  record('Escape closes the calendar and restores focus without altering the schedule',
    await page.locator('.kiosk-calendar-popover').count() === 0 &&
    await page.getByTestId('kiosk-calendar-toggle').evaluate(element => document.activeElement === element) &&
    (await visibleDates()).join(',') === '2026-10-12');
  await page.getByTestId('kiosk-calendar-toggle').click();
  await page.getByRole('button', { name: '다음 달', exact: true }).click();
  record('Calendar month controls show the correct number of dates for the next month',
    await page.locator('.kiosk-calendar-days button[data-date-key^="2026-11-"]').count() === 30);
  await page.getByRole('button', { name: '이전 달', exact: true }).click();
  await page.locator('.kiosk-calendar-days button[data-date-key="2026-10-31"]').waitFor();
  await page.screenshot({ path: resolve(run, 'kiosk-calendar-open-1366.png'), fullPage: true });
  await page.locator('.kiosk-calendar-days button[data-date-key="2026-10-31"]').click();
  await waitForDay('2026-10-31');
  record('Calendar selection changes the large date and daily schedule to the chosen weekend',
    await page.getByTestId('kiosk-hero-date').getAttribute('data-date') === '2026-10-31' &&
    (await visibleDates()).join(',') === '2026-10-31' &&
    !(await page.locator('.kiosk-calendar-days button[data-date-key="2026-10-31"]').isVisible()));
  await page.getByTestId('kiosk-week-next').click(); await waitForDay('2026-11-01');
  record('Daily navigation crosses a month boundary without changing the selected day incorrectly',
    await page.getByTestId('kiosk-hero-date').getAttribute('data-date') === '2026-11-01' && (await visibleDates()).join(',') === '2026-11-01');

  let releaseNextWeek, nextWeekRequested;
  const nextWeekGate = new Promise(resolve => { releaseNextWeek = resolve; });
  const nextWeekRequest = new Promise(resolve => { nextWeekRequested = resolve; });
  await page.route('**/api/kiosk/bookings?*', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('from') === '2026-11-02') {
      nextWeekRequested(url); await nextWeekGate;
    }
    return route.continue();
  });
  try {
    await page.getByTestId('kiosk-week-next').click();
    const requestedWeek = await Promise.race([nextWeekRequest, pause(5000).then(() => { throw Error('Daily boundary navigation did not request its calendar week'); })]);
    record('Crossing a week boundary loads the complete seven-day API range even in daily view',
      requestedWeek.searchParams.get('from') === '2026-11-02' && requestedWeek.searchParams.get('to') === '2026-11-08');
    record('A date change cannot present the previous loaded week as fresh reservation data',
      await page.getByTestId('kiosk-scroll').getAttribute('data-ready') === 'false' &&
      (await visibleDates()).join(',') === '2026-11-02' && await page.getByTestId('kiosk-booking').count() === 0);
    await (await slot('9-c1', '2026-11-02', '14:00')).click();
    record('New daily reservations remain blocked until the selected week finishes loading',
      !(await page.getByTestId('kiosk-quick-panel').isVisible()));
  } finally {
    releaseNextWeek();
    // Let the intercepted request finish before removing its handler; removing
    // a route while it is awaiting the gate can make Playwright handle it twice.
    await ready();
    await page.unroute('**/api/kiosk/bookings?*');
  }
  await waitForDay('2026-11-02');
  await page.getByTestId('kiosk-week-today').click(); await waitForDay('2026-10-12');
  await page.getByTestId('kiosk-view-week').click(); await ready();
  await page.getByTestId('kiosk-floor-9').click(); await ready();

  record('Quick booking starts collapsed with a visible open rail', await page.getByTestId('kiosk-quick-open').isVisible() && !(await page.getByTestId('kiosk-quick-panel').isVisible()));
  await page.getByTestId('kiosk-quick-open').click();
  await page.getByTestId('kiosk-quick-panel').waitFor();
  record('The rail opens a docked right panel with a blank required name, not a blocking dialog', await page.getByTestId('kiosk-quick-panel').evaluate(element => element.tagName === 'ASIDE') && await page.getByTestId('kiosk-owner').inputValue() === '' && await page.getByTestId('kiosk-owner').getAttribute('required') !== null && await page.getByRole('dialog').count() === 0);
  await page.getByTestId('kiosk-room').selectOption('12-big');
  await page.getByTestId('kiosk-date').fill('2026-10-15');
  await page.getByTestId('kiosk-start').selectOption('15:00');
  await page.getByTestId('kiosk-end').selectOption('16:00');
  record('The quick panel lets visitors choose a room, date and time without a grid selection', await page.getByTestId('kiosk-room').inputValue() === '12-big' && await page.getByTestId('kiosk-date').inputValue() === '2026-10-15' && await page.getByTestId('kiosk-start').inputValue() === '15:00' && await page.getByTestId('kiosk-end').inputValue() === '16:00');
  await page.getByTestId('kiosk-owner').fill('이전 빠른 예약 방문자');
  await page.getByTestId('kiosk-purpose').fill('다음 방문자에게 남기지 않음');
  await closePanel();
  await page.getByTestId('kiosk-quick-open').click();
  record('Closing and reopening the rail clears personal form values', await page.getByTestId('kiosk-owner').inputValue() === '' && await page.getByTestId('kiosk-purpose').inputValue() === '');
  await page.getByTestId('kiosk-owner').fill('자리 비운 방문자');
  await page.evaluate(() => window.__kioskQaAdvanceNow(121000));
  await page.getByTestId('kiosk-quick-panel').waitFor({ state: 'hidden', timeout: 5000 });
  await page.evaluate(() => window.__kioskQaAdvanceNow(-121000));
  await wakeRefresh(); await ready();
  await page.getByTestId('kiosk-quick-open').click();
  record('Idle timeout collapses the panel and clears the previous visitor name', await page.getByTestId('kiosk-owner').inputValue() === '');
  await closePanel();
  await page.getByTestId('kiosk-floor-9').click(); await ready();
  const seedElement = page.locator(`[data-testid="kiosk-booking"][data-booking-id="${seed.id}"]`);
  await seedElement.scrollIntoViewIfNeeded(); await seedElement.click();
  await page.getByTestId('kiosk-detail-dialog').waitFor();
  record('Existing reservations are read-only in the shared terminal', await page.getByTestId('kiosk-detail-dialog').getByRole('button', { name: /수정|삭제|취소/ }).count() === 0);
  await page.keyboard.press('Escape');
  await page.getByTestId('kiosk-detail-dialog').waitFor({ state: 'hidden' });

  await (await slot()).click(); await page.getByTestId('kiosk-quick-panel').waitFor();
  record('A grid tap opens the right panel with the chosen room, date and start time', await page.getByTestId('kiosk-room').inputValue() === '9-c2' && await page.getByTestId('kiosk-date').inputValue() === '2026-10-12' && await page.getByTestId('kiosk-start').inputValue() === '14:00');
  record('Every booking starts with a blank name despite a logged-in employee cookie', (await page.getByTestId('kiosk-owner').inputValue()) === '');
  record('Name field is explicitly required', await page.getByTestId('kiosk-owner').getAttribute('required') !== null);
  await page.screenshot({ path: resolve(run, 'kiosk-empty-name-form-1366.png'), fullPage: true });
  for (const viewport of [{ width: 1242, height: 668 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    const panelBounds = await page.getByTestId('kiosk-quick-panel').boundingBox();
    const calendarBounds = await page.getByTestId('kiosk-scroll').boundingBox();
    record(`Quick booking is docked on the right without covering the timetable at ${viewport.width}`, panelBounds.x > viewport.width * .6 && panelBounds.x + panelBounds.width <= viewport.width + 2 && calendarBounds.x + calendarBounds.width <= panelBounds.x + 2);
    record(`The panel does not introduce document overflow at ${viewport.width}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1));
    record(`Date, floor, navigation and view controls stay distinct with the quick panel open at ${viewport.width}`, await toolbarControlsFit());
    await page.screenshot({ path: resolve(run, `kiosk-quick-panel-${viewport.width}.png`), fullPage: true });
    await page.getByTestId('kiosk-calendar-toggle').click();
    const calendarPopup = await page.locator('.kiosk-calendar-popover').boundingBox();
    record(`Calendar remains fully on screen with the quick panel open at ${viewport.width}`,
      calendarPopup.x >= 0 && calendarPopup.y >= 0 && calendarPopup.x + calendarPopup.width <= viewport.width + 1 && calendarPopup.y + calendarPopup.height <= viewport.height + 1);
    await page.screenshot({ path: resolve(run, `kiosk-calendar-panel-${viewport.width}.png`), fullPage: true });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1242, height: 668 });
  await page.getByTestId('kiosk-calendar-toggle').click();
  await page.getByRole('button', { name: '다음 달', exact: true }).click();
  await page.getByRole('button', { name: '다음 달', exact: true }).click();
  await page.locator('.kiosk-calendar-days button[data-date-key="2026-12-31"]').click(); await ready();
  record('The long year-crossing week label does not cover floor or date controls beside the quick panel',
    await page.getByTestId('kiosk-hero-date').getAttribute('data-date') === '2026-12-31' && await toolbarControlsFit());
  await page.screenshot({ path: resolve(run, 'kiosk-year-boundary-panel-1242.png'), fullPage: true });
  record('Browsing another week does not silently replace the date of an open reservation draft',
    await page.getByTestId('kiosk-date').inputValue() === '2026-10-12' && await page.getByTestId('kiosk-submit').isDisabled());
  await page.getByTestId('kiosk-week-today').click(); await ready();
  await page.setViewportSize({ width: 1366, height: 768 });
  record('Blank-name submission is disabled and cannot create a reservation', await page.getByTestId('kiosk-submit').isDisabled() && (await request('/api/kiosk/bookings?from=2026-10-12&to=2026-10-18', { cookie: fixture.cookie })).json.bookings.length === 2);
  await page.getByTestId('kiosk-owner').fill('이전 방문자');
  await page.getByTestId('kiosk-purpose').fill('남겨지면 안 되는 입력');
  await closePanel();
  await (await slot()).click();
  record('Closing and reopening clears both the previous visitor name and meeting purpose', await page.getByTestId('kiosk-owner').inputValue() === '' && await page.getByTestId('kiosk-purpose').inputValue() === '');
  await page.getByTestId('kiosk-owner').fill('공용 화면 시험자');
  await page.getByTestId('kiosk-purpose').fill('이 예약은 자동화 시험용 가상 데이터입니다');
  await page.getByTestId('kiosk-submit').click();
  await page.getByTestId('kiosk-quick-panel').waitFor({ state: 'hidden' });
  const after = await request('/api/kiosk/bookings?from=2026-10-12&to=2026-10-18', { cookie: fixture.cookie });
  record('A valid manually named reservation is persisted through the real API', after.json.bookings.length === 3 && after.json.bookings.some(booking => booking.owner === '공용 화면 시험자'));
  await (await slot('9-c2', '2026-10-13')).click();
  record('Successful reservation never pre-fills the next visitor name', await page.getByTestId('kiosk-owner').inputValue() === '');
  await closePanel();

  let loseFirstResponse = true;
  const retryKeys = [];
  await page.route('**/api/kiosk/bookings', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    retryKeys.push(route.request().headers()['idempotency-key']);
    if (!loseFirstResponse) return route.continue();
    loseFirstResponse = false;
    const accepted = await route.fetch();
    assert.equal(accepted.status(), 201, await accepted.text());
    return route.abort('failed');
  });
  await (await slot('9-c3', '2026-10-14')).click();
  await page.getByTestId('kiosk-owner').fill('응답 유실 시험자');
  await page.getByTestId('kiosk-submit').click();
  await page.getByRole('button', { name: '저장 결과 다시 확인', exact: true }).waitFor();
  record('Lost success response explicitly explains uncertain storage and freezes the draft', await page.getByTestId('kiosk-owner').isDisabled() && await page.getByTestId('kiosk-start').isDisabled());
  record('An uncertain reservation locks room and date changes while keeping explicit close available', await page.getByTestId('kiosk-room').isDisabled() && await page.getByTestId('kiosk-date').isDisabled() && await page.getByTestId('kiosk-quick-close').isEnabled());
  await (await slot('9-c4', '2026-10-15', '15:00')).click();
  record('A grid tap cannot replace an unresolved quick-booking draft', await page.getByTestId('kiosk-owner').inputValue() === '응답 유실 시험자' && await page.getByTestId('kiosk-room').inputValue() === '9-c3' && await page.getByTestId('kiosk-date').inputValue() === '2026-10-14');
  await page.getByTestId('kiosk-submit').click();
  await page.getByTestId('kiosk-quick-panel').waitFor({ state: 'hidden' });
  const afterRetry = await request('/api/kiosk/bookings?from=2026-10-12&to=2026-10-18', { cookie: fixture.cookie });
  record('Uncertain-response retry uses the same request key and creates only one reservation', retryKeys.length === 2 && retryKeys[0] === retryKeys[1] && afterRetry.json.bookings.length === 4 && afterRetry.json.bookings.filter(booking => booking.owner === '응답 유실 시험자').length === 1);
  await page.unroute('**/api/kiosk/bookings');

  // Simulate another terminal winning a race after this visitor starts typing.
  await (await slot('9-c4', '2026-10-15', '15:00')).click();
  await page.getByTestId('kiosk-owner').fill('충돌 후 유지할 이름');
  await page.getByTestId('kiosk-purpose').fill('충돌 후 유지할 회의 목적');
  let collide = true;
  await page.route('**/api/kiosk/bookings', async route => {
    if (route.request().method() === 'POST' && collide) {
      collide = false;
      await create(fixture, '9-c4', '2026-10-15', '15:00', '16:00', '먼저 예약한 가상 직원');
    }
    return route.continue();
  });
  await page.getByTestId('kiosk-submit').click();
  await page.getByTestId('kiosk-quick-panel').getByRole('alert').waitFor();
  record('A genuine 409 conflict keeps the panel open and preserves the manually entered name and purpose', await page.getByTestId('kiosk-owner').inputValue() === '충돌 후 유지할 이름' && await page.getByTestId('kiosk-purpose').inputValue() === '충돌 후 유지할 회의 목적' && !(await page.getByTestId('kiosk-start').isDisabled()));
  await page.unroute('**/api/kiosk/bookings');
  await closePanel();

  const colorA = await create(fixture, '9-c1', '2026-10-14', '14:00', '14:30', '색상 검증 김민지');
  const colorAOtherDay = await create(fixture, '9-c1', '2026-10-15', '14:30', '15:30', '색상 검증 김민지');
  const colorAOtherRoom = await create(fixture, '12-big', '2026-10-16', '11:00', '12:00', '색상 검증 김민지');
  const colorB = await create(fixture, '9-c1', '2026-10-14', '15:00', '15:30', '색상 검증 박서준');
  const bookingElement = id => page.locator(`[data-testid="kiosk-booking"][data-booking-id="${id}"]`);
  const colorFor = async id => {
    await page.mouse.move(5, 5);
    await bookingElement(id).waitFor({ state: 'attached' });
    return bookingElement(id).evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderLeftColor, name: getComputedStyle(element.querySelector('strong')).color, time: getComputedStyle(element.querySelector('time')).color, opacity: style.opacity };
    });
  };
  await wakeRefresh(); await ready();
  const firstColor = await colorFor(colorA.id), otherDateColor = await colorFor(colorAOtherDay.id), differentColor = await colorFor(colorB.id);
  record('The same typed name has exactly the same booking colours on different dates', JSON.stringify(firstColor) === JSON.stringify(otherDateColor));
  record('Different synthetic names receive visibly different booking colours', firstColor.background !== differentColor.background && firstColor.name !== differentColor.name);
  await page.getByTestId('kiosk-floor-12').click(); await ready();
  const otherRoomColor = await colorFor(colorAOtherRoom.id);
  record('The same name keeps its booking colours in a different room and floor', JSON.stringify(firstColor) === JSON.stringify(otherRoomColor));
  await page.getByTestId('kiosk-floor-9').click(); await ready();
  await page.evaluate(() => window.__kioskQaAdvanceNow(53 * 60 * 60 * 1000));
  await wakeRefresh(); await ready();
  record('An ended reservation retains its name colour instead of switching to grey', await bookingElement(colorA.id).evaluate(element => element.classList.contains('is-ended')) && JSON.stringify(await colorFor(colorA.id)) === JSON.stringify(firstColor));
  await page.evaluate(() => window.__kioskQaAdvanceNow(-53 * 60 * 60 * 1000));
  await wakeRefresh(); await ready();
  await page.reload(); await ready();
  record('Booking colours are stable after a full page reload with no assignment stored in the browser', JSON.stringify(await colorFor(colorA.id)) === JSON.stringify(firstColor));
  const contrasts = [firstColor, differentColor].flatMap(color => [contrastRatio(color.name, color.background), contrastRatio(color.time, color.background)]);
  record('Name and time colours meet 4.5:1 text contrast against their booking backgrounds', contrasts.every(value => value >= 4.5));
  for (const viewport of [{ width: 1242, height: 668 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await page.getByTestId('kiosk-scroll').evaluate(element => { element.scrollLeft = 0; element.scrollTop = 1000; });
    const compact = await bookingElement(colorA.id).evaluate(element => {
      const box = element.getBoundingClientRect(), name = element.querySelector('strong'), time = element.querySelector('time');
      const nameBox = name.getBoundingClientRect(), timeBox = time.getBoundingClientRect();
      return { compact: element.classList.contains('is-compact'), owner: name.textContent, time: time.textContent,
        rowsFit: nameBox.top >= box.top && timeBox.bottom <= box.bottom + 1 && timeBox.top >= nameBox.bottom - 1,
        noHorizontalTextOverflow: name.clientWidth <= element.clientWidth && time.scrollWidth <= time.clientWidth + 1 };
    });
    record(`A narrow 30-minute reservation keeps both name and full time visible at ${viewport.width}`, compact.compact && compact.owner === '색상 검증 김민지' && compact.time === '14:00–14:30' && compact.rowsFit && compact.noHorizontalTextOverflow);
    record(`Name-coloured bookings do not introduce horizontal page overflow at ${viewport.width}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: resolve(run, `kiosk-owner-colors-${viewport.width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1366, height: 768 });

  // A genuine touch swipe must scroll, not create a reservation.
  const scroll = page.getByTestId('kiosk-scroll');
  await scroll.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 350; });
  const bounds = await scroll.boundingBox();
  const x = bounds.x + Math.min(bounds.width - 90, 900), y = bounds.y + Math.min(bounds.height - 50, 260);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step * 55, y, id: 1 }] });
    await pause(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pause(350);
  record('Horizontal finger swipe moves the room schedule', await scroll.evaluate(element => element.scrollLeft > 40));
  record('Finger swipe does not accidentally open the booking panel or a detail dialog', !(await page.getByTestId('kiosk-quick-panel').isVisible()) && !(await page.getByTestId('kiosk-detail-dialog').isVisible()));

  const line = page.getByTestId('kiosk-now-line');
  await scroll.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 790; });
  record('Only one red current-time line spans all seven days and every room boundary', await line.count() === 1 && await line.evaluate(element => {
    const grid = element.closest('.kiosk-grid');
    const rect = element.getBoundingClientRect(), gridRect = grid.getBoundingClientRect();
    const color = getComputedStyle(element).backgroundColor.match(/\d+/g)?.map(Number) || [];
    return Math.abs(rect.width - (grid.scrollWidth - 70)) <= 2 && Math.abs(rect.left - gridRect.left - 70) <= 2 && color[0] > 180 && color[1] < 120;
  }));
  // Sample rectangle and actual scroll coordinates atomically: native touch
  // inertia may still be finishing, so hard-coded offsets are not reliable.
  const measureLine = () => line.evaluate(element => {
    const rect = element.getBoundingClientRect(), area = element.closest('.kiosk-scroll');
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollLeft: area.scrollLeft, scrollTop: area.scrollTop };
  });
  const lineBefore = await measureLine();
  await scroll.evaluate(element => { element.scrollLeft = 310; element.scrollTop = 830; });
  const lineAfter = await measureLine();
  record('Continuous line stays attached to the same time after horizontal and vertical scroll', Math.abs(lineAfter.x - lineBefore.x + lineAfter.scrollLeft - lineBefore.scrollLeft) <= 2 && Math.abs(lineAfter.y - lineBefore.y + lineAfter.scrollTop - lineBefore.scrollTop) <= 2 && Math.abs(lineAfter.width - lineBefore.width) <= 2);
  const lineCenter = lineAfter.y + lineAfter.height / 2;
  const label = await page.locator('.kiosk-now-label').boundingBox();
  record('The pinned time label stays aligned with the continuous line while scrolling', Math.abs(label.y + label.height / 2 - lineCenter) <= 2);

  for (const viewport of [{ width: 1242, height: 668 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await scroll.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 790; });
    await page.getByTestId('kiosk-toast').waitFor({ state: 'hidden' });
    record(`Page shell fits ${viewport.width}×${viewport.height} without document overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1));
    const height = (await scroll.boundingBox()).height;
    record(`Most of the ${viewport.height}px monitor is available for the schedule`, height >= viewport.height * .6);
    await page.screenshot({ path: resolve(run, `kiosk-${viewport.width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByTestId('kiosk-quick-open').click();
  await page.getByTestId('kiosk-owner').fill('통신 오류에도 유지할 이름');
  await page.getByTestId('kiosk-purpose').fill('통신 오류에도 유지할 회의 목적');
  let mode = 'fail';
  await page.route('**/api/kiosk/bookings?*', async route => {
    if (mode === 'fail') return route.abort('failed');
    return route.continue();
  });
  await wakeRefresh();
  await page.getByRole('alert').first().waitFor();
  record('A failed refresh is visible and is not silently presented as an empty calendar', await page.getByRole('alert').first().isVisible());
  record('A stale-data error preserves the open quick-booking inputs but disables submission', await page.getByTestId('kiosk-owner').inputValue() === '통신 오류에도 유지할 이름' && await page.getByTestId('kiosk-purpose').inputValue() === '통신 오류에도 유지할 회의 목적' && await page.getByTestId('kiosk-submit').isDisabled());
  await closePanel();
  await (await slot('9-c4', '2026-10-14')).click();
  record('An out-of-date schedule blocks new reservation entry until refreshed', !(await page.getByTestId('kiosk-quick-panel').isVisible()));
  mode = 'normal';
  await page.getByTestId('kiosk-retry').click(); await ready();
  record('Error-only retry recovers the actual reservation list and disappears after success', await page.locator('[data-testid="kiosk-booking"]').count() >= 2 && await page.getByTestId('kiosk-retry').count() === 0);
  await page.getByTestId('kiosk-quick-open').click();
  await page.getByTestId('kiosk-owner').fill('연결 해제 때 지워질 이름');
  const activeDevice = await context.request.get(server.base + '/api/kiosk/session').then(response => response.json());
  const disconnect = await context.request.delete(server.base + '/api/kiosk/session', { headers: { Origin: server.base, 'X-Kiosk-CSRF': activeDevice.csrfToken } });
  record('The real server revokes the connected test device', disconnect.status() === 200);
  await wakeRefresh();
  await page.getByTestId('kiosk-connect-code').waitFor();
  record('Revoked device access clears the calendar and quick-booking name before reconnecting', await page.getByTestId('kiosk-scroll').count() === 0 && await page.getByTestId('kiosk-owner').count() === 0);
  record('The shared screen never requests administrator APIs', protectedRequests.length === 0);
  record('Personal employee page and global styles remain unchanged during kiosk regression', personalSources.every((path, index) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex') === personalHashes[index]));
  record('No browser runtime exceptions', errors.length === 0);
  writeFileSync(resolve(run, 'results.json'), JSON.stringify({ passed: results.length, results, errors, evidence: run, syntheticOnly: true, dataChanges: 'Only unique isolated DATA_DIR' }, null, 2));
  console.log('RESULT ' + JSON.stringify({ passed: results.length, evidence: run }));
} catch (error) {
  if (page) await page.screenshot({ path: resolve(run, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(resolve(run, 'failure.json'), JSON.stringify({ passed: results.length, results, errors, failure: error.stack, server: server?.logs() }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  for (const child of children) child.kill();
}
