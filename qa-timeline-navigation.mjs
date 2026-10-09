// Browser regression with a fixed office clock and an isolated synthetic database.
// Never modifies the preview database or contacts Microsoft.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, 'data-qa-timeline-navigation', String(Date.now()));
mkdirSync(run, { recursive: true });
const socket = net.createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const instant = '2026-10-08T05:15:00Z'; // 14:15 in Seoul
const child = spawn(process.execPath, ['--import', './qa-preload.mjs', 'server/index.mjs'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: run,
    ALLOW_ANONYMOUS: '1', SEED_DEMO: '0', MS_TENANT_ID: '', MS_CLIENT_ID: '', MS_CLIENT_SECRET: '',
    APP_BASE_URL: '', MICROSOFT_TOKEN_KEY: '', ADMIN_MS_EMAIL: '', ADMIN_MS_OBJECT_ID: '', BACKUP_DIR: '',
    TEST_NOW: instant, TEST_FIXTURE_BOUNDARIES: '1', TEST_FIXTURE_SSO: '', TEST_ROOM: '9-c1', TEST_ROOM2: '9-c2' },
});
let logs = '', browser;
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
const pause = ms => new Promise(r => setTimeout(r, ms));
const results = [], errors = [];
const check = (name, good) => { assert.ok(good, name); results.push(name); console.log('PASS ' + name); };
const geometry = page => page.locator('.daily-timeline').evaluate(grid => {
  const line = grid.querySelector('.current-time-line-all').getBoundingClientRect();
  const head = grid.querySelector('.daily-room-head').getBoundingClientRect();
  return { scroll: grid.scrollTop, ratio: (line.top - head.bottom) / (grid.clientHeight - head.height) };
});
const positionAt = (page, minute, index = 2) => page.locator('.daily-timeline').evaluate((grid, { minute, index }) => {
  const body = grid.querySelectorAll('.timeline-day-body')[index].getBoundingClientRect();
  return { x: body.left + body.width / 2, y: body.top + minute / 1440 * body.height };
}, { minute, index });
const browsePast = async (page, focusHour = 9) => {
  await page.locator('.daily-timeline').evaluate((grid, focusHour) => {
    const body = grid.querySelector('.timeline-day-body').getBoundingClientRect();
    const head = grid.querySelector('.daily-room-head');
    grid.scrollTop += body.top - grid.getBoundingClientRect().top + body.height * focusHour / 24 - head.offsetHeight - 20;
  }, focusHour);
  await pause(120);
};
const clickPoint = (page, point) => page.mouse.click(point.x, point.y);
const nearTop = async page => { await pause(650); const g = await geometry(page); return g.ratio > 0 && g.ratio < 0.055; };

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(logs);
    try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
    await pause(100);
  }
  assert.ok(ready, logs);
  const { chromium } = await import(pathToFileURL(process.env.QA_PLAYWRIGHT_MODULE));
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Seoul' });
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.setFixedTime(new Date(instant));
  await page.goto(base);
  await page.locator('.current-time-line-all').waitFor();
  check('full-day label and its toolbar space are removed', await page.locator('.daily-timeline-toolbar').count() === 0 && await page.getByText('24시간 보기', { exact: true }).count() === 0);
  check('initial current line is near the top', await nearTop(page));
  await clickPoint(page, await positionAt(page, 860));
  check('partly elapsed half-hour stays blocked without the removed past-time notice', await page.locator('.schedule-selection-feedback,.timeline-draft').count() === 0);
  await page.screenshot({ path: resolve(run, 'current-time-top.png'), fullPage: true });
  await browsePast(page);
  const old = (await geometry(page)).scroll;
  await pause(500);
  check('manual past scroll stays in place', Math.abs((await geometry(page)).scroll - old) < 1);
  await clickPoint(page, await positionAt(page, 600));
  check('past blank click returns to current time', await nearTop(page));
  check('return click creates no reservation draft or error', await page.locator('.timeline-draft,.schedule-selection-feedback').count() === 0);
  await browsePast(page);
  const axis = await positionAt(page, 600);
  const axisBox = await page.locator('.time-axis').boundingBox();
  await page.mouse.click(axisBox.x + axisBox.width / 2, axis.y);
  check('past time-axis click also returns', await nearTop(page));
  await browsePast(page);
  const drag = await positionAt(page, 600);
  await page.mouse.move(drag.x, drag.y); await page.mouse.down();
  await page.mouse.move(drag.x + 20, drag.y + 40, { steps: 8 });
  await page.mouse.move(drag.x, drag.y, { steps: 8 }); await page.mouse.up(); await pause(250);
  check('past drag out and back does not jump', Math.abs((await geometry(page)).scroll - old) < 1);
  await clickPoint(page, await positionAt(page, 570, 0)); await pause(200);
  check('past reservation click does not move the timeline', Math.abs((await geometry(page)).scroll - old) < 1);
  await page.getByRole('button', { name: '이전 날짜', exact: true }).click();
  await browsePast(page); await clickPoint(page, await positionAt(page, 600));
  check('past date stays read-only without the removed past-time notice', await page.locator('.schedule-selection-feedback,.timeline-draft').count() === 0);
  await page.locator('.nav-today').click(); await nearTop(page);
  await page.getByRole('button', { name: '다음 날짜', exact: true }).click();
  await browsePast(page);
  const futureScroll = await page.locator('.daily-timeline').evaluate(el => el.scrollTop);
  await clickPoint(page, await positionAt(page, 600)); await pause(250);
  check('another date remains selected and does not jump', await page.locator('.current-time-line-all').count() === 0 && Math.abs(await page.locator('.daily-timeline').evaluate(el => el.scrollTop) - futureScroll) < 1);
  await page.locator('.nav-today').click();
  check('today button still returns to current time', await nearTop(page));
  const from = await positionAt(page, 901), to = await positionAt(page, 958);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
  await page.locator('.timeline-draft').waitFor();
  check('future drag still fills the chosen reservation time', (await page.locator('.timeline-draft').textContent()).includes('15:00–16:00'));
  await page.reload(); await page.locator('.current-time-line-all').waitFor();
  await browsePast(page);
  const wheelPoint = await positionAt(page, 600);
  await page.mouse.move(wheelPoint.x, wheelPoint.y); await page.mouse.wheel(0, -180); await pause(300);
  check('wheel scrolling into the past is not reset', (await geometry(page)).scroll < old - 100);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await clickPoint(page, await positionAt(page, 510));
  check('reduced-motion click return works', await nearTop(page));
  await page.getByRole('button', { name: '12층', exact: true }).click();
  check('floor change keeps current time at the top', await nearTop(page));
  await page.getByRole('button', { name: '9층', exact: true }).click();
  for (const [width, height] of [[1280, 720], [390, 844]]) {
    await page.setViewportSize({ width, height }); await page.locator('.nav-today').click();
    check(`current line near top at ${width}px`, await nearTop(page));
    await page.screenshot({ path: resolve(run, `current-time-top-${width}.png`), fullPage: true });
  }
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Seoul' });
  mobile.on('pageerror', e => errors.push(e.message));
  await mobile.clock.setFixedTime(new Date(instant)); await mobile.goto(base); await mobile.locator('.current-time-line-all').waitFor();
  await browsePast(mobile, 11);
  const tap = await positionAt(mobile, 690, 0);
  await mobile.touchscreen.tap(tap.x, tap.y);
  check('touch tap on a past blank slot returns', await nearTop(mobile));
  await browsePast(mobile, 11);
  const touch = await positionAt(mobile, 690, 0);
  const beforePan = (await geometry(mobile)).scroll;
  const cdp = await mobile.context().newCDPSession(mobile);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touch.x, y: touch.y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touch.x, y: touch.y + i * 16 }] }); await pause(25);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pause(500);
  check('touch pan scrolls without snapping to current time', (await geometry(mobile)).scroll < beforePan - 20);
  const equipmentPage = await browser.newPage({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Seoul' });
  equipmentPage.on('pageerror', e => errors.push(e.message));
  await equipmentPage.clock.setFixedTime(new Date(instant)); await equipmentPage.goto(base);
  await equipmentPage.locator('.room-equipment-chip').first().waitFor();
  const firstRoom = equipmentPage.locator('.daily-room').first();
  check('short equipment labels match the chosen design', JSON.stringify(await firstRoom.locator('.room-equipment-chip:visible').allTextContents()) === JSON.stringify(['프로젝터', '화이트보드', '+1']));
  check('single-equipment room has no unnecessary more button', await equipmentPage.locator('.daily-room').nth(1).locator('.room-equipment-chip:visible').count() === 1);
  const selectedBefore = await equipmentPage.locator('.daily-room.active .daily-room-title strong').textContent();
  await equipmentPage.locator('.daily-room').nth(1).locator('.room-equipment-chip:visible').first().click();
  await equipmentPage.locator('.room-equipment-popover:popover-open').waitFor();
  check('equipment click does not change the selected booking room', await equipmentPage.locator('.daily-room.active .daily-room-title strong').textContent() === selectedBefore);
  await firstRoom.locator('.room-equipment-chip:visible').first().click();
  check('only one equipment popover opens at a time', await equipmentPage.locator('.room-equipment-popover:popover-open').count() === 1);
  check('full equipment includes the hidden screen', JSON.stringify(await equipmentPage.locator('.room-equipment-popover:popover-open li span').allTextContents()) === JSON.stringify(['프로젝터', '화이트보드', '스크린']));
  await equipmentPage.locator('.room-equipment-popover:popover-open').screenshot({ path: resolve(run, 'equipment-details.png') });
  await equipmentPage.keyboard.press('Escape');
  check('Escape closes equipment and returns focus', await equipmentPage.locator('.room-equipment-popover:popover-open').count() === 0 && await firstRoom.locator('.room-equipment-chip').first().evaluate(el => document.activeElement === el));
  await equipmentPage.keyboard.press('Enter');
  check('keyboard can open equipment details', await equipmentPage.locator('.room-equipment-popover:popover-open').count() === 1);
  await equipmentPage.getByRole('button', { name: '장비 정보 닫기', exact: true }).filter({ visible: true }).click();
  check('close button dismisses details', await equipmentPage.locator('.room-equipment-popover:popover-open').count() === 0);
  const roomConfig = JSON.parse(readFileSync(resolve(root, 'app/config/rooms.json'), 'utf8'));
  for (const [width, floor, expanded] of [[1440, 9, false], [1280, 9, true], [1280, 12, true], [390, 12, false], [320, 9, false]]) {
    await equipmentPage.setViewportSize({ width, height: 900 });
    if (expanded && await equipmentPage.getByRole('button', { name: '빠른 예약 펼치기' }).isVisible()) await equipmentPage.getByRole('button', { name: '빠른 예약 펼치기' }).click();
    if (!expanded) await equipmentPage.reload();
    await equipmentPage.getByRole('button', { name: `${floor}층`, exact: true }).click(); await pause(150);
    const measurements = await equipmentPage.locator('.daily-room-head').evaluateAll(headers => headers.map(head => {
      const bounds = head.getBoundingClientRect();
      const children = [...head.querySelectorAll('.daily-room-title strong, .daily-room-meta, .room-equipment-chip')].filter(el => el.getClientRects().length);
      return { width: bounds.width, height: bounds.height, contained: children.every(el => { const r = el.getBoundingClientRect(); return r.top >= bounds.top && r.bottom <= bounds.bottom + 1 && r.left >= bounds.left && r.right <= bounds.right + 1; }), bodyTop: head.nextElementSibling.getBoundingClientRect().top };
    }));
    console.log('EQUIPMENT_LAYOUT ' + JSON.stringify({ width, floor, expanded, measurements }));
    check(`equipment fits headers ${width}px/${floor}F/panel=${expanded}`, measurements.every(item => item.contained) && measurements.every(item => Math.abs(item.bodyTop - measurements[0].bodyTop) < 1));
    const allEquipment = await equipmentPage.locator('.daily-room .room-equipment-popover li span').allTextContents();
    check(`equipment remains sourced from room data ${width}px/${floor}F`, JSON.stringify([...allEquipment].sort()) === JSON.stringify(roomConfig.filter(room => room.floor === floor).flatMap(room => room.equipment).sort()));
    await equipmentPage.screenshot({ path: resolve(run, `equipment-${width}-${floor}.png`), fullPage: true });
  }
  check('room headers never nest interactive buttons', await equipmentPage.locator('.daily-room-head button button').count() === 0);
  for (const [width, floor, expanded] of [[1440, 9, false], [1280, 12, true], [390, 12, false], [320, 9, false]]) {
    await equipmentPage.setViewportSize({ width, height: 900 }); await equipmentPage.reload();
    await equipmentPage.getByRole('button', { name: `${floor}층`, exact: true }).click();
    await equipmentPage.getByRole('button', { name: '주간', exact: true }).click();
    if (expanded) await equipmentPage.getByRole('button', { name: '빠른 예약 펼치기' }).click();
    await equipmentPage.locator('.weekly-room-name .room-equipment').first().waitFor();
    check(`weekly equipment shown for every room ${width}px/${floor}F`, await equipmentPage.locator('.weekly-room-name .room-equipment').count() === roomConfig.filter(room => room.floor === floor && room.equipment.length).length);
    check(`weekly room labels fit ${width}px/${floor}F`, await equipmentPage.locator('.weekly-room-name').evaluateAll(headers => headers.every(head => {
      const bounds = head.getBoundingClientRect();
      return [...head.querySelectorAll('.weekly-room-title,.weekly-room-floor,.weekly-room-select small,.room-equipment-chip')].filter(el => el.getClientRects().length).every(el => {
        const r = el.getBoundingClientRect(); return r.top >= bounds.top && r.bottom <= bounds.bottom + 1 && r.left >= bounds.left && r.right <= bounds.right + 1;
      });
    })));
    const names = await equipmentPage.locator('.weekly-room-name .room-equipment-popover li span').allTextContents();
    check(`weekly equipment uses the same room data ${width}px/${floor}F`, JSON.stringify([...names].sort()) === JSON.stringify(roomConfig.filter(room => room.floor === floor).flatMap(room => room.equipment).sort()));
    await equipmentPage.screenshot({ path: resolve(run, `equipment-weekly-${width}-${floor}.png`), fullPage: true });
    const roomLabels = equipmentPage.locator('.weekly-room-name');
    await roomLabels.nth(1).locator('.weekly-room-select').click();
    check(`weekly room selection still works ${width}px`, await roomLabels.nth(1).locator('.weekly-room-select').getAttribute('aria-pressed') === 'true');
    await roomLabels.first().locator('.room-equipment-chip:visible').first().click();
    await equipmentPage.locator('.room-equipment-popover:popover-open').waitFor();
    check(`weekly equipment details do not change room selection ${width}px`, await roomLabels.nth(1).locator('.weekly-room-select').getAttribute('aria-pressed') === 'true');
    check(`weekly equipment details are not clipped ${width}px`, await equipmentPage.locator('.room-equipment-popover:popover-open').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
    await equipmentPage.keyboard.press('Escape');
    check(`weekly equipment closes without nested buttons ${width}px`, await equipmentPage.locator('.room-equipment-popover:popover-open').count() === 0 && await equipmentPage.locator('.weekly-room-name button button').count() === 0);
  }
  await equipmentPage.close();
  await mobile.locator('.nav-today').tap();
  await mobile.locator('.room-equipment-chip:visible').first().tap();
  await mobile.locator('.room-equipment-popover:popover-open').waitFor();
  check('touch equipment details fit the viewport', await mobile.locator('.room-equipment-popover:popover-open').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
  check('touch equipment controls have comfortable hit targets', await mobile.locator('.room-equipment-chip:visible').first().evaluate(el => el.getBoundingClientRect().height >= 44));
  await mobile.locator('.room-equipment-popover:popover-open button').tap();
  await mobile.getByRole('button', { name: '주간', exact: true }).tap();
  await mobile.locator('.weekly-room-name .room-equipment-chip:visible').first().tap();
  check('weekly equipment details open on touch', await mobile.locator('.room-equipment-popover:popover-open').isVisible());
  await mobile.locator('.room-equipment-popover:popover-open button').tap();
  await mobile.getByRole('button', { name: '일간', exact: true }).tap();
  check('daily equipment remains available after leaving weekly view', await mobile.locator('.daily-room-head .room-equipment-chip:visible').first().isVisible());
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.clock.setFixedTime(new Date('2026-10-07T15:00:00Z')); await page.reload();
  await page.locator('.current-time-line-all').waitFor();
  check('midnight current line stays visible below the header', await nearTop(page));
  await page.clock.setFixedTime(new Date('2026-10-08T14:59:00Z')); await page.reload();
  await page.locator('.current-time-line-all').waitFor(); await pause(200);
  const late = await geometry(page);
  check('late-night current line stays visible at the end-of-day scroll boundary', late.ratio > 0 && late.ratio < 1);
  check('no browser errors', errors.length === 0);
  writeFileSync(resolve(run, 'results.json'), JSON.stringify({ passed: results.length, results, errors }, null, 2));
  console.log('RESULT ' + results.length + ' passed; ' + run);
} finally { if (browser) await browser.close(); child.kill(); }
