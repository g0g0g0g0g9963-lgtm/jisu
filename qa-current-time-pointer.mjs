// Desktop-only regression. Uses a disposable synthetic database, never the preview DB.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, 'data-qa-current-time-pointer', String(Date.now()));
mkdirSync(run, { recursive: true });
const socket = net.createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const instant = '2026-10-09T05:32:00Z';
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
  for (const [width, height, floor, expanded] of [[1440,960,9,false],[1280,720,9,true],[1280,720,12,true],[1920,1080,12,false]]) {
    await page.setViewportSize({ width, height }); await page.goto(base);
    await page.locator('.current-time-pointer').waitFor();
    if (expanded) await page.getByRole('button', { name: '빠른 예약 펼치기' }).click();
    await page.getByRole('button', { name: `${floor}층`, exact: true }).click();
    await pause(550);
    const label = page.locator('.current-time-pointer');
    check(`time only ${width}/${floor}F/panel=${expanded}`, await label.textContent().then(s => s.trim() === '14:32'));
    const geometry = await label.evaluate(el => {
      const grid = el.closest('.daily-timeline'), header = grid.querySelector('.axis-corner').getBoundingClientRect();
      const box = el.getBoundingClientRect(), line = grid.querySelector('.current-time-line-all').getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(el); const text = range.getBoundingClientRect();
      const arrow = getComputedStyle(el, '::after');
      el.style.pointerEvents = 'auto';
      const paintedAboveAxis = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === el;
      el.style.removeProperty('pointer-events');
      return { paintedAboveAxis, contained: box.left >= grid.getBoundingClientRect().left && box.top >= header.bottom && box.bottom <= grid.getBoundingClientRect().bottom,
        textFits: text.left >= box.left && text.right <= box.right,
        connected: Math.abs(box.right + parseFloat(arrow.borderLeftWidth) - line.left) < 1,
        aligned: Math.abs(box.top + box.height / 2 - line.top) < 1,
        ignoresPointer: getComputedStyle(el).pointerEvents === 'none' };
    });
    console.log('GEOMETRY ' + JSON.stringify({width,height,floor,geometry}));
    await page.screenshot({ path: resolve(run, `pointer-${width}-${floor}.png`), fullPage: true });
    check(`pointer fits and connects ${width}/${floor}F`, Object.values(geometry).every(Boolean));
  }
  for (const [clock, expected] of [['2026-10-08T15:00:00Z','00:00'],['2026-10-09T05:59:00Z','14:59'],['2026-10-09T06:00:00Z','15:00'],['2026-10-09T14:59:00Z','23:59']]) {
    await page.clock.setFixedTime(new Date(clock)); await page.reload();
    const label = page.locator('.current-time-pointer'); await label.waitFor();
    check(`clock ${expected}`, (await label.textContent()).trim() === expected);
    check(`regular hour text does not collide ${expected}`, await label.evaluate(el => {
      const label = el.getBoundingClientRect();
      return [...el.closest('.daily-timeline').querySelectorAll('.time-axis-body time')].filter(t => getComputedStyle(t).visibility !== 'hidden').every(t => {
        const r = t.getBoundingClientRect(); return r.bottom <= label.top || r.top >= label.bottom;
      });
    }));
  }
  await page.clock.setFixedTime(new Date(instant)); await page.reload();
  await page.locator('.current-time-pointer').waitFor();
  const grid = page.locator('.daily-timeline');
  await grid.evaluate(el => { el.scrollTop = 700; }); await pause(200);
  const past = await grid.evaluate(el => el.scrollTop);
  await page.clock.setFixedTime(new Date('2026-10-09T05:33:00Z'));
  await page.waitForFunction(() => document.querySelector('.current-time-pointer')?.textContent.trim() === '14:33', null, { timeout: 35000 });
  check('clock updates without undoing manual scroll', Math.abs(await grid.evaluate(el => el.scrollTop) - past) < 1);
  await page.getByRole('button', { name: '다음 날짜', exact: true }).click();
  check('other date has no current-time pointer', await page.locator('.current-time-pointer,.current-time-line-all').count() === 0);
  await page.getByRole('button', { name: '주간', exact: true }).click();
  check('daily marker does not leak into weekly view', await page.locator('.current-time-pointer').count() === 0);
  check('no browser errors', errors.length === 0);
  writeFileSync(resolve(run, 'results.json'), JSON.stringify({ passed: results.length, results, errors }, null, 2));
  console.log('RESULT ' + results.length + ' passed; ' + run);
} finally { if (browser) await browser.close(); child.kill(); }
