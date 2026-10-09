// Clean summary regression. Every booking and mutation is isolated from the preview DB.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, 'data-qa-my-bookings-design', String(Date.now()));
mkdirSync(run, { recursive: true });
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`, instant = '2026-10-09T05:32:00Z';
const seed = `
  const { createBookings } = await import('./server/db.mjs');
  const common = {owner:'QA List',team:'시험 본부',purpose:'주간 업무 회의',dates:['2026-10-09'],start:'18:00',end:'19:00'};
  const fixtures = [
    {...common,owner:'QA Single',roomId:'9-c3',start:'21:30',end:'23:00',purpose:'회의'},
    {...common,roomId:'9-c1',start:'14:00',end:'16:00',purpose:'진행 중인 회의'},
    {...common,roomId:'9-c2',dates:['2026-10-12','2026-10-13','2026-10-14','2026-10-15'],start:'09:00',end:'10:00',purpose:'반복 회의'},
    {...common,roomId:'9-c4',purpose:'긴 회의 목적이 생략되지 않고 읽히는지 확인합니다. '.repeat(3),team:'시험용 긴 본부명 '.repeat(6),attendeeAccounts:[{id:'fixture-person',name:'QA Attendee',email:'attendee@example.invalid'}]},
    {...common,roomId:'9-c3',dates:['2026-10-08'],purpose:'지난 예약 기록'},
  ];
  for(const fixture of fixtures) { const result = createBookings(fixture); if(!result.ok) throw Error('Fixture collision'); }
  await import('./server/index.mjs');
`;
const child = spawn(process.execPath, ['--import', './qa-preload.mjs', '--input-type=module', '--eval', seed], {
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
  const initialRows = await rows();
  const { chromium } = await import(pathToFileURL(process.env.QA_PLAYWRIGHT_MODULE));
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Seoul' });
  page.on('pageerror', e => errors.push(e.message));
  let writes = 0;
  page.on('request', req => { if (['POST','PATCH','DELETE'].includes(req.method()) && new URL(req.url()).pathname.startsWith('/api/bookings')) writes++; });
  await page.clock.setFixedTime(new Date(instant)); await page.goto(base);
  const entry = page.getByRole('button', {name:/^내 예약 열기/});
  await entry.click();
  const dialog = page.getByRole('dialog', {name:'내 예약',exact:true});
  await dialog.waitFor();
  check('close receives initial focus', await dialog.getByRole('button',{name:'내 예약 닫기'}).evaluate(el => el === document.activeElement));
  await dialog.getByLabel('예약자 이름',{exact:true}).fill('QA Single');
  await dialog.locator('.my-booking-card').waitFor();
  check('single reservation uses the shared clean room and time summary', await dialog.locator('.my-booking-card').count() === 1 && await dialog.locator('.booking-confirm-room strong').textContent() === 'Conference Room 3' && await dialog.locator('.booking-confirm-floor').textContent() === '9F' && await dialog.locator('.booking-confirm-time').textContent() === '21:30 — 23:00' && await dialog.locator('.booking-confirm-duration').textContent() === '1시간 30분');
  check('white surface has no layered glass background', await dialog.evaluate(el => { const s = getComputedStyle(el); return s.backgroundImage === 'none' && s.backgroundColor === 'rgb(255, 255, 255)' && s.borderRadius === '18px' && s.backdropFilter === 'none'; }));
  for (const [width,height] of [[1440,960],[1280,720],[1366,768]]) {
    await page.setViewportSize({width,height});
    check(`single booking and controls fit ${width}x${height}`, await dialog.evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth && [...el.querySelectorAll('button')].every(b => {const q=b.getBoundingClientRect();return q.top>=r.top&&q.bottom<=r.bottom&&q.height>=44;});
    }));
    await dialog.screenshot({path:resolve(run,`my-bookings-single-${width}.png`)});
  }
  await dialog.getByRole('button',{name:'내 예약 닫기'}).focus(); await page.keyboard.press('Shift+Tab');
  check('keyboard focus wraps to last action', await dialog.getByRole('button',{name:'예약 취소',exact:true}).evaluate(el => el === document.activeElement));
  await page.keyboard.press('Tab');
  check('keyboard focus wraps back to close', await dialog.getByRole('button',{name:'내 예약 닫기'}).evaluate(el => el === document.activeElement));
  await dialog.getByRole('button',{name:'예약 취소',exact:true}).click();
  const cancelDialog = page.getByRole('dialog',{name:'예약 1건을 취소할까요?',exact:true}); await cancelDialog.waitFor();
  check('cancel action still asks before changing data', writes === 0 && (await rows()).length === initialRows.length);
  await page.keyboard.press('Escape'); await cancelDialog.waitFor({state:'hidden'});
  check('Escape closes only cancellation confirmation', await dialog.isVisible() && writes === 0);
  await dialog.getByRole('button',{name:'내 예약 닫기'}).click(); await dialog.waitFor({state:'hidden'});
  check('X closes without changing any reservation and restores focus', writes === 0 && await entry.evaluate(el => el === document.activeElement));
  await entry.click(); await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
  check('Escape closes my bookings without mutation', writes === 0);
  await entry.click(); await page.mouse.click(8,8); await dialog.waitFor({state:'hidden'});
  check('backdrop dismissal still works', writes === 0);
  await entry.click(); await dialog.getByLabel('예약자 이름',{exact:true}).fill('QA Nobody');
  check('empty results are clearly labelled', await dialog.getByRole('status').textContent() === '예약이 없습니다.' && await dialog.locator('.my-booking-card').count() === 0);
  await dialog.getByLabel('예약자 이름',{exact:true}).fill('QA List');
  await dialog.locator('.my-booking-card').first().waitFor();
  check('upcoming and past counts stay correct', /예정 예약 6/.test(await dialog.locator('.my-bookings-summary').textContent()) && /최근 1개월 1/.test(await dialog.locator('.my-bookings-summary').textContent()) && await dialog.locator('.my-booking-card').count() === 7);
  check('past reservation stays read-only and last', await dialog.locator('.my-booking-card').last().evaluate(el => el.classList.contains('is-past') && !el.querySelector('button,input')));
  check('running reservation retains early-end action', await dialog.locator('.my-booking-card').first().getByRole('button',{name:'일찍 끝내기'}).count() === 1 && await dialog.locator('.my-booking-badge.running').count() === 1);
  await dialog.getByRole('button',{name:'일찍 끝내기'}).click();
  const early = page.getByRole('dialog',{name:'회의를 일찍 끝낼까요?',exact:true}); await early.waitFor();
  await page.keyboard.press('Escape'); await early.waitFor({state:'hidden'});
  check('early-end review can be dismissed without a write', writes === 0 && await dialog.isVisible());
  const detailed = dialog.locator('.my-booking-card').filter({has:page.locator('.my-booking-purpose',{hasText:'긴 회의 목적'})});
  await detailed.scrollIntoViewIfNeeded();
  check('long purpose and department remain readable without overflow', (await detailed.locator('.my-booking-purpose').textContent()).includes('확인합니다.') && await detailed.evaluate(el => el.scrollWidth <= el.clientWidth));
  check('anonymous responses still hide attendee account identities', await dialog.locator('.booking-attendee-detail').count() === 0);
  await dialog.getByRole('button',{name:'선택해서 취소'}).click();
  check('bulk mode starts empty with disabled final action', await dialog.getByRole('button',{name:'0건 취소하기'}).isDisabled() && await dialog.locator('.my-booking-card input').count() === 6);
  const repeated = dialog.locator('.my-booking-card').filter({has:page.locator('.my-booking-purpose',{hasText:'반복 회의'})});
  await repeated.first().getByRole('checkbox').check();
  await dialog.getByRole('button',{name:'같은 반복 예약 4건 모두'}).click();
  check('same-series selection still selects only four bookings', await dialog.locator('.my-booking-card.is-picked').count() === 4);
  await dialog.getByRole('button',{name:'4건 취소하기'}).click();
  const bulk = page.getByRole('dialog',{name:'예약 4건을 취소할까요?',exact:true}); await bulk.waitFor();
  check('bulk preview retains repeat-series explanation', (await bulk.textContent()).includes('같은 반복 예약 4건을 모두 취소합니다.') && writes === 0);
  await bulk.getByRole('button',{name:'닫기',exact:true}).click();
  await dialog.getByRole('checkbox',{name:'전체선택',exact:true}).check();
  check('select all excludes past reservations', await dialog.locator('.my-booking-card.is-picked').count() === 6 && await dialog.locator('.is-past input').count() === 0);
  for (const [width,height] of [[1280,720],[1366,768],[1920,1080]]) {
    await page.setViewportSize({width,height});
    check(`list scrolls while close and bulk actions stay visible ${width}`, await dialog.evaluate(el => {
      const list = el.querySelector('.my-bookings-list-wrap');
      const controls = el.querySelectorAll('.booking-confirm-close,.my-bookings-cancelbar button');
      const r = el.getBoundingClientRect();
      return r.top>=0 && r.bottom<=innerHeight && el.scrollWidth<=el.clientWidth && list.clientHeight>100 && list.scrollHeight>list.clientHeight && [...controls].every(b=>{const q=b.getBoundingClientRect();return q.top>=r.top&&q.bottom<=r.bottom&&q.left>=r.left&&q.right<=r.right;});
    }));
    await dialog.locator('.my-bookings-list-wrap').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    await dialog.screenshot({path:resolve(run,`my-bookings-many-${width}.png`)});
  }
  await dialog.getByRole('button',{name:'선택 해제',exact:true}).click();
  check('leaving selection preserves reservations', writes === 0 && await dialog.locator('.my-bookings-cancelbar').count() === 0 && (await rows()).length === initialRows.length);
  await dialog.getByLabel('예약자 이름',{exact:true}).fill('QA Single');
  await dialog.getByRole('button',{name:'예약 취소',exact:true}).click(); await cancelDialog.waitFor();
  await cancelDialog.getByRole('button',{name:'1건 취소하기',exact:true}).click();
  await dialog.getByRole('status').waitFor();
  check('explicit confirmation deletes only the intended isolated fixture', writes === 1 && (await rows()).length === initialRows.length - 1 && !(await rows()).some(b=>b.owner==='QA Single'));
  const sso = await browser.newPage({viewport:{width:1280,height:720},timezoneId:'Asia/Seoul'});
  sso.on('pageerror',e=>errors.push(e.message));
  await sso.clock.setFixedTime(new Date(instant));
  // UI fixture only: ownership and real SSO remain server controlled and unchanged.
  await sso.route('**/api/me',route=>route.fulfill({json:{user:{name:'QA Signed In',email:'qa@example.invalid'}}}));
  await sso.route('**/api/bookings',async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({json:{bookings:data.bookings.map((b,i)=>({...b,isMine:i===0,...(i===0?{attendeeAccounts:[{id:'fixture-person',name:'QA Attendee',email:'attendee@example.invalid'}]}:{})}))}});});
  await sso.goto(base); await sso.getByRole('button',{name:/^내 예약 열기/}).click();
  const signedDialog=sso.getByRole('dialog',{name:'내 예약',exact:true});
  await signedDialog.locator('.my-booking-card').waitFor();
  check('signed-in layout has no manual name search and respects server ownership flags', await signedDialog.locator('.my-bookings-search').count()===0 && await signedDialog.locator('.my-booking-card').count()===1);
  await signedDialog.locator('.booking-attendee-detail summary').click();
  check('signed-in owner can expand employee attendee identities', (await signedDialog.locator('.booking-attendee-detail').textContent()).includes('attendee@example.invalid'));
  await signedDialog.screenshot({path:resolve(run,'my-bookings-signed-in.png')});
  check('no browser errors', errors.length===0);
  writeFileSync(resolve(run,'results.json'),JSON.stringify({passed:results.length,results,errors},null,2));
  console.log('RESULT '+results.length+' passed; '+run);
} finally { if(browser) await browser.close(); child.kill(); }
