// Compact list and deletion-history regression. Every booking/mutation uses an isolated DB.
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
  const mutations = [];
  page.on('request', req => { if (['POST','PATCH','DELETE'].includes(req.method()) && new URL(req.url()).pathname.startsWith('/api/bookings')) { writes++; mutations.push({method:req.method(),path:new URL(req.url()).pathname}); } });
  await page.clock.setFixedTime(new Date(instant)); await page.goto(base);
  const entry = page.getByRole('button', {name:/^내 예약 열기/});
  await entry.click();
  const dialog = page.getByRole('dialog', {name:'내 예약',exact:true});
  const listRows = dialog.locator('.my-bookings-list tbody > tr.my-booking-row');
  const editor = page.getByRole('dialog',{name:'예약 수정',exact:true});
  const confirm = page.locator('.cancel-dialog');
  const toolbarDelete = dialog.locator('.my-bookings-cancelbar .cancel-confirm');
  const until = async condition => {for(let i=0;i<80;i++){if(await condition())return;await pause(100);}assert.fail('Timed out waiting for isolated data/UI change');};
  const originalRunning = initialRows.find(b=>b.owner==='QA List'&&b.roomId==='9-c1');
  const retryFixture = initialRows.find(b=>b.owner==='QA List'&&b.date==='2026-10-12');
  const geometry = [], deleteResponses = [];
  page.on('response',response=>{if(response.request().method()==='DELETE')deleteResponses.push(response.json().then(body=>({status:response.status(),path:new URL(response.url()).pathname,body})));});
  await dialog.waitFor();
  check('close receives initial focus',await dialog.getByRole('button',{name:'내 예약 닫기'}).evaluate(el=>el===document.activeElement));
  await dialog.getByLabel('예약자 이름',{exact:true}).fill('QA Single'); await listRows.waitFor();
  check('single booking uses compact table row with room and time',await dialog.locator('table.my-bookings-list').count()===1&&await listRows.count()===1&&(await listRows.locator('.my-booking-room').textContent()).includes('Conference Room 3')&&/21:30.*23:00/.test(await listRows.textContent()));
  check('active row exposes selection edit delete without standalone early-end',await listRows.getByRole('checkbox',{name:/예약 선택$/}).count()===1&&await listRows.locator('.edit-booking').textContent()==='수정'&&await listRows.locator('.delete-booking').textContent()==='삭제'&&await dialog.getByRole('button',{name:/일찍 끝내기/}).count()===0);
  check('selection deletion starts disabled',await toolbarDelete.isDisabled()&&(await toolbarDelete.textContent()).includes('선택 삭제'));
  await listRows.locator('.edit-booking').click(); await editor.waitFor();
  check('editor opens the chosen booking',await editor.getByLabel('회의 목적',{exact:true}).inputValue()==='회의'&&await editor.locator('.edit-time-row select').first().inputValue()==='21:30');
  await editor.getByLabel('회의 목적',{exact:true}).fill('저장하지 않을 수정');
  await page.keyboard.press('Escape'); await editor.waitFor({state:'hidden'});
  check('Escape returns to list and restores edit focus without mutation',await dialog.isVisible()&&writes===0&&await listRows.locator('.edit-booking').evaluate(el=>el===document.activeElement));
  await listRows.locator('.edit-booking').click(); await editor.waitFor();
  check('discarded draft does not leak into reopened editor',await editor.getByLabel('회의 목적',{exact:true}).inputValue()==='회의');
  check('editor X has a visible 44px target',await editor.getByRole('button',{name:'예약 수정 닫기'}).evaluate(el=>{const r=el.getBoundingClientRect();return r.width>=44&&r.height>=44;}));
  await editor.getByRole('button',{name:'예약 수정 닫기'}).click(); await editor.waitFor({state:'hidden'});
  check('X returns to list without data changes',await dialog.isVisible()&&writes===0&&(await rows()).find(b=>b.owner==='QA Single').purpose==='회의');
  check('dialog keeps a clean white surface',await dialog.evaluate(el=>{const s=getComputedStyle(el);return s.backgroundImage==='none'&&s.backgroundColor==='rgb(255, 255, 255)'&&s.backdropFilter==='none';}));
  for(const [width,height] of [[1440,960],[1280,720],[1366,768]]){
    await page.setViewportSize({width,height});
    check('single row and controls fit '+width+'x'+height,await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth&&el.scrollWidth<=el.clientWidth&&[...el.querySelectorAll('button')].every(b=>{const q=b.getBoundingClientRect();return q.top>=r.top&&q.bottom<=r.bottom&&q.width>0&&q.height>=32;});}));
    await dialog.screenshot({path:resolve(run,'my-bookings-single-'+width+'.png')});
  }
  await dialog.getByRole('button',{name:'내 예약 닫기'}).focus(); await page.keyboard.press('Shift+Tab');
  check('focus wraps to last enabled control',await dialog.evaluate(el=>{const a=[...el.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(n=>!n.disabled&&n.tabIndex>=0&&n.getClientRects().length);return document.activeElement===a.at(-1);}));
  await page.keyboard.press('Tab');
  check('focus wraps back to close',await dialog.getByRole('button',{name:'내 예약 닫기'}).evaluate(el=>el===document.activeElement));
  await listRows.locator('.delete-booking').click(); await confirm.waitFor();
  check('individual deletion requires confirmation before writing',(await confirm.textContent()).includes('예약 1건을 삭제할까요?')&&(await confirm.textContent()).includes('예정 예약 삭제')&&writes===0&&(await rows()).length===initialRows.length);
  await page.keyboard.press('Escape'); await confirm.waitFor({state:'hidden'});
  check('Escape dismisses confirmation only',await dialog.isVisible()&&writes===0);
  await dialog.getByRole('button',{name:'내 예약 닫기'}).click(); await dialog.waitFor({state:'hidden'});
  check('list X restores entry focus',writes===0&&await entry.evaluate(el=>el===document.activeElement));
  await entry.click(); await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
  check('Escape closes list without mutation',writes===0);
  await entry.click(); await page.mouse.click(8,8); await dialog.waitFor({state:'hidden'});
  check('backdrop dismissal remains available',writes===0);
  await entry.click(); await dialog.getByLabel('예약자 이름',{exact:true}).fill('QA Nobody');
  check('empty result is labelled',await dialog.getByRole('status').textContent()==='예약이 없습니다.'&&await listRows.count()===0);
  await dialog.getByLabel('예약자 이름',{exact:true}).fill('QA List'); await listRows.first().waitFor();
  check('counts include six active and one history row',/예정 예약 6/.test(await dialog.locator('.my-bookings-summary').textContent())&&/최근 1개월 1/.test(await dialog.locator('.my-bookings-summary').textContent())&&await listRows.count()===7);
  check('past row stays read-only and last',await listRows.last().evaluate(el=>el.classList.contains('is-past')&&!el.querySelector('button,input')));
  const running=listRows.filter({has:page.locator('.booking-status',{hasText:'진행 중'})});
  check('running row has selection edit delete but no early-end button',await running.locator('.edit-booking').count()===1&&await running.locator('.delete-booking').count()===1&&await running.getByRole('checkbox').count()===1&&await dialog.getByRole('button',{name:/일찍 끝내기/}).count()===0);
  check('running badge renders calm green instead of legacy red',await running.locator('.booking-status').evaluate(el=>{const s=getComputedStyle(el);return s.color==='rgb(8, 116, 91)'&&s.backgroundColor==='rgb(233, 245, 240)';}));
  check('all upcoming badges consistently render soft blue',await listRows.locator('.booking-status').evaluateAll(nodes=>{const planned=nodes.filter(el=>el.textContent==='예정');return planned.length===5&&planned.every(el=>{const s=getComputedStyle(el);return s.color==='rgb(48, 75, 120)'&&s.backgroundColor==='rgb(237, 242, 248)';});}));
  check('past badge renders muted gray',await listRows.last().locator('.booking-status').evaluate(el=>{const s=getComputedStyle(el);return s.backgroundColor==='rgb(243, 245, 248)'&&s.color==='rgb(104, 119, 142)';}));
  await running.locator('.edit-booking').click(); await editor.waitFor();
  check('running editor preserves original start without standalone early-end action',await editor.locator('.edit-time-row select').first().inputValue()==='14:00'&&await editor.getByRole('button',{name:/일찍 끝내기/}).count()===0);
  await editor.getByRole('button',{name:'닫기',exact:true}).click(); await editor.waitFor({state:'hidden'});
  check('editor footer close returns to complete list',await dialog.isVisible()&&writes===0&&await listRows.count()===7);
  await running.locator('.delete-booking').click(); await confirm.waitFor();
  check('running delete review explains history preservation and release time',(await confirm.textContent()).includes('사용 기록 보존')&&(await confirm.textContent()).includes('15:00부터 예약 가능')&&writes===0);
  await confirm.getByRole('button',{name:'닫기',exact:true}).click(); await confirm.waitFor({state:'hidden'});
  const detailed=listRows.filter({has:page.locator('.my-booking-purpose',{hasText:'긴 회의 목적'})});
  check('long purpose and department remain in row without overflow',(await detailed.locator('.my-booking-purpose').textContent()).includes('확인합니다.')&&(await detailed.locator('.my-booking-department').textContent()).includes('시험용 긴 본부명')&&await detailed.evaluate(el=>el.scrollWidth<=el.clientWidth));
  check('anonymous response hides attendee identities',await dialog.locator('.booking-attendee-detail').count()===0);
  for(const [width,height] of [[1440,960],[1280,720],[1366,768],[1920,1080]]){
    await page.setViewportSize({width,height}); await dialog.locator('.my-bookings-list-wrap').evaluate(el=>{el.scrollTop=0;});
    const m=await dialog.evaluate(el=>{const r=el.getBoundingClientRect(),wrap=el.querySelector('.my-bookings-list-wrap'),w=wrap.getBoundingClientRect();return {fit:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth&&el.scrollWidth<=el.clientWidth&&wrap.scrollWidth<=wrap.clientWidth,visible:[...el.querySelectorAll('tbody > tr.my-booking-row')].filter(row=>{const q=row.getBoundingClientRect();return q.top>=w.top&&q.bottom<=w.bottom;}).length,controlsVisible:[...el.querySelectorAll('.booking-confirm-close,.my-bookings-cancelbar button')].every(b=>{const q=b.getBoundingClientRect();return q.top>=r.top&&q.bottom<=r.bottom&&q.left>=r.left&&q.right<=r.right;})};});
    geometry.push({width,height,...m});
    check('compact list shows multiple rows and controls '+width+'x'+height,m.fit&&m.visible>=2&&m.controlsVisible);
    await page.screenshot({path:resolve(run,'my-bookings-many-default-'+width+'.png')});
    await dialog.locator('.my-bookings-list-wrap').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    check('last history row reachable by list scroll '+width,await listRows.last().evaluate(el=>{const r=el.getBoundingClientRect(),w=el.closest('.my-bookings-list-wrap').getBoundingClientRect();return r.top>=w.top&&r.bottom<=w.bottom;}));
  }
  const repeated=listRows.filter({has:page.locator('.my-booking-purpose',{hasText:'반복 회의'})});
  await repeated.first().getByRole('checkbox').check();
  check('selection keeps every per-row action available',await listRows.locator('.edit-booking').count()===6&&await listRows.locator('.delete-booking').count()===6&&await listRows.getByRole('checkbox').count()===6&&(await toolbarDelete.textContent()).includes('1건 삭제'));
  await dialog.locator('.pick-series').click();
  check('series selection picks exactly four repeated reservations',await listRows.locator('input:checked').count()===4&&(await toolbarDelete.textContent()).includes('4건 삭제'));
  await toolbarDelete.click(); await confirm.waitFor();
  check('repeat review shows selected count and series explanation',(await confirm.textContent()).includes('예약 4건을 삭제할까요?')&&(await confirm.textContent()).includes('같은 반복 예약')&&writes===0);
  await confirm.getByRole('button',{name:'닫기',exact:true}).click();
  await dialog.getByRole('checkbox',{name:'전체선택',exact:true}).check();
  check('select all excludes history and retains actions',await listRows.locator('input:checked').count()===6&&await listRows.locator('.is-past input').count()===0&&await listRows.locator('.edit-booking').count()===6);
  await toolbarDelete.click(); await confirm.waitFor(); const mixedText=await confirm.textContent();
  check('mixed review distinguishes future removal and running release',mixedText.includes('예약 6건을 삭제할까요?')&&mixedText.includes('예정 예약은 삭제되고')&&mixedText.includes('사용 기록은 남습니다')&&mixedText.includes('사용 기록 보존')&&mixedText.includes('15:00부터 예약 가능')&&mixedText.includes('예정 예약 삭제')&&writes===0);
  await confirm.screenshot({path:resolve(run,'my-bookings-mixed-delete-confirm.png')});
  await page.keyboard.press('Escape'); await confirm.waitFor({state:'hidden'});
  await dialog.getByRole('checkbox',{name:'전체선택',exact:true}).uncheck();
  check('clear selection disables delete without touching data',await listRows.locator('input:checked').count()===0&&await toolbarDelete.isDisabled()&&writes===0&&(await rows()).length===initialRows.length);
  await running.locator('.edit-booking').click(); await editor.waitFor();
  await editor.getByLabel('회의 목적',{exact:true}).fill('진행 중인 회의 수정 확인');
  await editor.getByRole('button',{name:'수정 저장',exact:true}).click(); await editor.waitFor({state:'hidden'});
  const updatedRunning=(await rows()).find(b=>b.id===originalRunning.id);
  check('running edit saves once without altering past start',writes===1&&mutations[0].method==='PATCH'&&updatedRunning.purpose==='진행 중인 회의 수정 확인'&&updatedRunning.start==='14:00'&&(await rows()).length===initialRows.length&&(await running.locator('.my-booking-purpose').textContent())===updatedRunning.purpose);
  await dialog.getByLabel('예약자 이름',{exact:true}).fill('QA Single');
  await listRows.locator('.edit-booking').click(); await editor.waitFor();
  await editor.getByLabel('회의 목적',{exact:true}).fill('예정 회의 수정 확인'); await editor.getByLabel('본부',{exact:true}).fill('수정된 시험 본부');
  await editor.getByRole('button',{name:'수정 저장',exact:true}).click(); await editor.waitFor({state:'hidden'});
  const updatedSingle=(await rows()).find(b=>b.owner==='QA Single');
  check('upcoming edit saves one PATCH and refreshes table row',writes===2&&mutations[1].method==='PATCH'&&updatedSingle.purpose==='예정 회의 수정 확인'&&updatedSingle.team==='수정된 시험 본부'&&(await listRows.locator('.my-booking-purpose').textContent())===updatedSingle.purpose&&(await listRows.locator('.my-booking-department').textContent())===updatedSingle.team);
  await listRows.locator('.delete-booking').click(); await confirm.waitFor(); await confirm.locator('.cancel-go').click(); await confirm.waitFor({state:'hidden'});
  await dialog.getByRole('status').waitFor();
  check('future delete removes only the intended isolated reservation',writes===3&&mutations[2].method==='DELETE'&&(await rows()).length===initialRows.length-1&&!(await rows()).some(b=>b.id===updatedSingle.id));
  await dialog.getByLabel('예약자 이름',{exact:true}).fill('QA List'); await listRows.first().waitFor();
  let injectedFailure=0;
  await page.route('**/api/bookings/'+retryFixture.id,async route=>{if(route.request().method()==='DELETE'&&injectedFailure===0){injectedFailure++;await route.fulfill({status:503,json:{error:'시험용 일시 오류입니다. 다시 시도해 주세요.'}});}else await route.continue();});
  await dialog.getByRole('checkbox',{name:'전체선택',exact:true}).check(); await toolbarDelete.click(); await confirm.waitFor(); await confirm.locator('.cancel-go').click(); await confirm.waitFor({state:'hidden'});
  await dialog.getByRole('alert').waitFor(); await until(async()=>await listRows.count()===3);
  const afterMixed=await rows(),ended=afterMixed.find(b=>b.id===originalRunning.id);
  const history=listRows.filter({has:page.locator('.my-booking-purpose',{hasText:'진행 중인 회의 수정 확인'})});
  check('mixed delete requests each selection once and reports partial failure',writes===9&&mutations.slice(3).every(m=>m.method==='DELETE')&&new Set(mutations.slice(3).map(m=>m.path)).size===6&&injectedFailure===1&&(await dialog.getByRole('alert').textContent()).includes('시험용 일시 오류'));
  check('running delete preserves used interval and explicit endedAt',ended&&ended.start==='14:00'&&ended.end==='15:00'&&ended.endedAt&&new Date(ended.endedAt).getTime()===new Date(instant).getTime()&&afterMixed.length===initialRows.length-5);
  check('ended booking is read-only history before rounded release boundary',await history.evaluate(el=>el.classList.contains('is-past')&&!el.querySelector('button,input'))&&(await dialog.locator('.my-bookings-summary').textContent()).includes('최근 1개월 2'));
  check('newly ended booking switches from green to history gray',await history.locator('.booking-status').evaluate(el=>{const s=getComputedStyle(el);return s.backgroundColor==='rgb(243, 245, 248)'&&s.color==='rgb(104, 119, 142)';}));
  check('only failed future row remains selected and actionable',await listRows.locator('input:checked').count()===1&&await listRows.locator('.edit-booking').count()===1&&await listRows.locator('.delete-booking').count()===1&&(await toolbarDelete.textContent()).includes('1건 삭제')&&afterMixed.some(b=>b.id===retryFixture.id));
  await page.screenshot({path:resolve(run,'my-bookings-partial-failure-history.png')});
  await toolbarDelete.click(); await confirm.waitFor();
  check('retry review contains only failed reservation',(await confirm.textContent()).includes('예약 1건을 삭제할까요?')&&!(await confirm.textContent()).includes('사용 기록 보존 · 15:00'));
  await confirm.locator('.cancel-go').click(); await confirm.waitFor({state:'hidden'}); await until(async()=>await listRows.count()===2);
  check('retry only deletes failed row without replaying successful changes',writes===10&&mutations.at(-1).path.endsWith('/'+retryFixture.id)&&(await rows()).length===initialRows.length-6&&!(await rows()).some(b=>b.id===retryFixture.id)&&await listRows.locator('button,input').count()===0&&await toolbarDelete.count()===0);
  const responseResults=await Promise.all(deleteResponses);
  check('delete API distinguishes removed bookings from retained history',responseResults.some(r=>r.status===200&&r.path.endsWith('/'+originalRunning.id)&&r.body.ok&&r.body.action==='ended'&&r.body.booking?.endedAt)&&responseResults.some(r=>r.status===200&&r.path.endsWith('/'+updatedSingle.id)&&r.body.ok&&r.body.action==='deleted'));
  const retryEnded=await fetch(base+'/api/bookings/'+originalRunning.id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:'QA List'})}),retryEndedBody=await retryEnded.json();
  check('repeated deletion of ended history returns unchanged and preserves it',retryEnded.status===200&&retryEndedBody.action==='unchanged'&&(await rows()).some(b=>b.id===originalRunning.id&&b.end==='15:00'&&b.endedAt===ended.endedAt));
  const freed=await fetch(base+'/api/bookings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:'QA Freed Slot',team:'시험 본부',purpose:'해제 시간 확인',roomId:originalRunning.roomId,dates:['2026-10-09'],start:'15:00',end:'16:00'})});
  check('another booking can reserve the released remainder from displayed boundary',freed.status===201);
  // Final API fixture stays only in this disposable database.
  const sso=await browser.newPage({viewport:{width:1280,height:720},timezoneId:'Asia/Seoul'});
  sso.on('pageerror',e=>errors.push(e.message)); await sso.clock.setFixedTime(new Date(instant));
  await sso.route('**/api/me',route=>route.fulfill({json:{user:{name:'QA Signed In',email:'qa@example.invalid'}}}));
  await sso.route('**/api/bookings',async route=>{const response=await route.fetch(),data=await response.json();await route.fulfill({json:{bookings:data.bookings.map((b,i)=>({...b,isMine:i===0,...(i===0?{attendeeAccounts:[{id:'fixture-person',name:'QA Attendee',email:'attendee@example.invalid'}]}:{})}))}});});
  await sso.goto(base); await sso.getByRole('button',{name:/^내 예약 열기/}).click();
  const signedDialog=sso.getByRole('dialog',{name:'내 예약',exact:true}); await signedDialog.locator('.my-booking-row').waitFor();
  check('SSO removes manual name search and respects server ownership flags',await signedDialog.locator('.my-bookings-search').count()===0&&await signedDialog.locator('.my-booking-row').count()===1);
  await signedDialog.locator('.booking-attendee-detail summary').click();
  check('owner can inspect employee attendee identities from row',(await signedDialog.locator('.booking-attendee-detail').textContent()).includes('attendee@example.invalid'));
  await signedDialog.screenshot({path:resolve(run,'my-bookings-signed-in.png')});
  check('no browser errors',errors.length===0);
  writeFileSync(resolve(run,'results.json'),JSON.stringify({passed:results.length,results,errors,mutations,deleteResponses:responseResults,geometry},null,2));
  console.log('RESULT '+results.length+' passed; '+run);
} finally { if(browser) await browser.close(); child.kill(); }
