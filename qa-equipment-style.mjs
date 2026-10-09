// Visual regression against an isolated test server; no real reservations or Microsoft calls.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, 'data-qa-equipment-style', String(Date.now()));
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
  await page.goto(base);
  for (const [width, height, floor, view, expanded] of [[1440,900,9,'일간',false],[1280,720,9,'일간',false],[1280,720,12,'일간',false],[1366,768,9,'일간',true],[1280,720,12,'일간',true],[1440,900,9,'주간',false],[1280,720,12,'주간',false]]) {
    await page.setViewportSize({ width, height });
    await page.goto(base);
    await page.getByRole('button', { name: `${floor}층`, exact: true }).click();
    await page.getByRole('button', { name: view, exact: true }).click();
    if (expanded) await page.getByRole('button', { name: '빠른 예약 펼치기' }).click();
    await page.mouse.move(0, 0);
    const items = page.locator('.room-equipment-chip:visible');
    await items.first().waitFor();
    const key = `${width}-${height}-${floor}-${view === '일간' ? 'day' : 'week'}-${expanded ? 'expanded' : 'collapsed'}`;
    if (view === '일간') {
      check(`compact headers retain all three information rows ${key}`, await page.locator('.daily-room-head').evaluateAll(headers => headers.every(head => {
        const box = head.getBoundingClientRect();
        const content = [...head.querySelectorAll('.daily-room-title strong,.daily-room-meta,.room-equipment-chip')].filter(el => el.getClientRects().length);
        return box.height === 92 && content.every(el => { const r = el.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left && r.right <= box.right && el.scrollWidth <= el.clientWidth + 1; });
      })));
      check(`time axis and room headers remain aligned ${key}`, await page.locator('.daily-timeline').evaluate(grid => {
        const head = grid.querySelector('.daily-room-head').getBoundingClientRect();
        const axis = grid.querySelector('.axis-corner').getBoundingClientRect();
        const bodies = [...grid.querySelectorAll('.timeline-day-body')].map(el => el.getBoundingClientRect().top);
        return head.height === axis.height && Math.abs(head.bottom-axis.bottom) < 1 && bodies.every(top => Math.abs(top-bodies[0])<1);
      }));
    }
    check(`transparent blue equipment ${key}`, await items.evaluateAll(items => items.every(el => {
      const css = getComputedStyle(el);
      return css.backgroundColor === 'rgba(0, 0, 0, 0)' && css.color === 'rgb(59, 99, 151)';
    })));
    check(`labels fit ${key}`, await items.evaluateAll(items => items.every(el => el.scrollWidth <= el.clientWidth)));
    await page.screenshot({ path: resolve(run, `equipment-${key}.png`), fullPage: true });
    await items.first().hover();
    await page.waitForFunction(() => {
      const hovered = document.querySelector('.room-equipment-chip:hover');
      return hovered && getComputedStyle(hovered).backgroundColor === 'rgb(237, 244, 252)';
    }, null, { timeout: 3000 });
    check(`blue hover feedback ${key}`, await items.first().evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(237, 244, 252)'));
    await items.first().click();
    check(`equipment details still open ${key}`, await page.locator('.room-equipment-popover:popover-open').isVisible());
    await page.keyboard.press('Escape');
    check(`keyboard close still works ${key}`, await page.locator('.room-equipment-popover:popover-open').count() === 0);
  }
  check('no browser errors', errors.length === 0);
  writeFileSync(resolve(run, 'results.json'), JSON.stringify({ passed: results.length, results, errors }, null, 2));
  console.log('RESULT ' + results.length + ' passed; ' + run);
} finally { if (browser) await browser.close(); child.kill(); }
