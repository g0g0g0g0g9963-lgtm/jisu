// Desktop confirmation regression; all writes go to an isolated synthetic database.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, 'data-qa-booking-confirmation', String(Date.now()));
mkdirSync(run, { recursive: true });
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`, instant = '2026-10-09T05:32:00Z';
const child = spawn(process.execPath, ['--import', './qa-preload.mjs', 'server/index.mjs'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: run,
    CLIENT_DIR: resolve(root, 'dist'), ALLOW_ANONYMOUS: '1', SEED_DEMO: '0',
    MS_TENANT_ID: '', MS_CLIENT_ID: '', MS_CLIENT_SECRET: '', APP_BASE_URL: '', MICROSOFT_TOKEN_KEY: '',
    ADMIN_MS_EMAIL: '', ADMIN_MS_OBJECT_ID: '', BACKUP_DIR: '', BACKUP_INTERVAL_MINUTES: '0',
    TEST_NOW: instant, TEST_FIXTURE_BOUNDARIES: '', TEST_FIXTURE_SSO: '' },
});
let logs = '', browser;
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
const pause = ms => new Promise(r => setTimeout(r, ms));
const results = [], errors = [];
const check = (name, good) => { assert.ok(good, name); results.push(name); console.log('PASS ' + name); };
const rows = async () => (await (await fetch(base + '/api/bookings')).json()).bookings;
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
  let writes = 0;
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/bookings') writes++; });
  await page.clock.setFixedTime(new Date(instant)); await page.goto(base);
  await page.getByRole('button', { name: '빠른 예약 펼치기' }).click();
  await page.locator('.daily-room-select').nth(2).click();
  await page.locator('#start-time-select').click(); await page.getByRole('option', { name: '21:00', exact: true }).click();
  await page.locator('#end-time-select').click(); await page.getByRole('option', { name: '22:30', exact: true }).click();
  await page.locator('#owner-input').fill('QA Confirmation');
  await page.locator('.booking-extra-details > summary').click();
  await page.locator('#purpose-input').fill('');
  const dialog = page.getByRole('dialog', { name: '이 내용으로 예약할까요?', exact: true });
  const open = async () => { await page.locator('#reserve-button').click(); await dialog.waitFor(); };
  const draft = async () => ({ owner: await page.locator('#owner-input').inputValue(), team: await page.locator('#team-input').inputValue(), purpose: await page.locator('#purpose-input').inputValue(), start: await page.locator('#start-time-select').textContent(), end: await page.locator('#end-time-select').textContent() });
  const before = await draft();
  await open();
  check('opening confirmation does not create a reservation', writes === 0 && (await rows()).length === 0);
  check('room name and floor stay distinct', (await dialog.locator('.booking-confirm-room strong').textContent()) === 'Conference Room 3' && (await dialog.locator('.booking-confirm-floor').textContent()) === '9F');
  check('date, range and duration remain visible', /10월 9일/.test(await dialog.locator('.booking-confirm-details').textContent()) && /21:00 — 22:30/.test(await dialog.locator('.booking-confirm-time').textContent()) && /1시간 30분/.test(await dialog.locator('.booking-confirm-duration').textContent()));
  check('close receives initial keyboard focus', await dialog.getByRole('button', { name: '예약 확인창 닫기' }).evaluate(el => el === document.activeElement));
  await page.keyboard.press('Shift+Tab');
  check('reverse Tab remains inside confirmation', await dialog.locator('.booking-confirm-submit').evaluate(el => el === document.activeElement));
  await page.keyboard.press('Tab');
  check('Tab wraps back to close', await dialog.locator('.booking-confirm-close').evaluate(el => el === document.activeElement));
  for (const [width, height] of [[1440,960],[1280,720],[1366,768]]) {
    await page.setViewportSize({width,height});
    check(`dialog and controls fit ${width}x${height}`, await dialog.evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth && [...el.querySelectorAll('button')].every(b => { const q = b.getBoundingClientRect(); return q.top >= r.top && q.bottom <= r.bottom && q.height >= 44; });
    }));
    await page.screenshot({path:resolve(run, `confirmation-${width}.png`), fullPage:true});
  }
  await dialog.screenshot({path:resolve(run, 'confirmation-clean-close.png')});
  await dialog.getByRole('button', { name: '예약 확인창 닫기' }).click(); await dialog.waitFor({state:'hidden'});
  check('X preserves all inputs and makes no request', JSON.stringify(await draft()) === JSON.stringify(before) && writes === 0 && (await rows()).length === 0);
  check('closing returns focus to the reservation button', await page.locator('#reserve-button').evaluate(el => el === document.activeElement));
  await open(); await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
  check('Escape preserves inputs without saving', JSON.stringify(await draft()) === JSON.stringify(before) && writes === 0);
  await open(); await dialog.getByRole('button', { name:'수정하기', exact:true }).click(); await dialog.waitFor({state:'hidden'});
  check('edit preserves inputs without saving', JSON.stringify(await draft()) === JSON.stringify(before) && writes === 0);
  // Keep the save fixture within the existing API's 100-character purpose limit.
  await page.locator('#purpose-input').fill('회의 목적과 긴 설명이 잘리지 않고 그대로 유지되는지 확인합니다. '.repeat(2));
  const longPurpose = (await page.locator('#purpose-input').inputValue()).trim();
  await open();
  check('long meeting purpose is retained', await dialog.locator('.booking-confirm-purpose p').textContent() === longPurpose);
  check('long content does not hide close or actions', await dialog.evaluate(el => [...el.querySelectorAll('button')].every(b => {const r=b.getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight; })));
  await page.keyboard.press('Escape');
  await page.locator('.repeat-option input').check();
  const calendar = page.locator('.repeat-settings .date-panel');
  await calendar.locator('[data-date-key="2026-10-12"]').click();
  await calendar.locator('[data-date-key="2026-10-23"]').click();
  await calendar.getByRole('button', {name:/완료/}).click();
  await open();
  check('repeat count remains in the clean summary', /총 \d+회/.test(await dialog.locator('.booking-confirm-details').textContent()));
  await dialog.locator('.booking-confirm-dates summary').click();
  check('repeat date details remain available', await dialog.locator('.booking-confirm-dates li').count() > 1);
  await dialog.getByRole('button',{name:'예약 확인창 닫기'}).click();
  check('closing a repeated confirmation creates no reservations', writes === 0 && (await rows()).length === 0);
  await page.locator('.repeat-option input').uncheck();
  await open();
  const confirmedTimes = await dialog.locator('.booking-confirm-time time').allTextContents();
  await dialog.getByRole('button', {name:'예약하기', exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  for (let i=0;i<50 && (await rows()).length===0;i++) await pause(100);
  const saved = await rows();
  check('only explicit final confirmation creates one reservation', writes === 1 && saved.length === 1 && saved[0].purpose === longPurpose && saved[0].start === confirmedTimes[0] && saved[0].end === confirmedTimes[1]);
  check('no browser errors', errors.length === 0);
  writeFileSync(resolve(run,'results.json'),JSON.stringify({passed:results.length,results,errors},null,2));
  console.log('RESULT ' + results.length + ' passed; ' + run);
} finally { if(browser) await browser.close(); child.kill(); }
