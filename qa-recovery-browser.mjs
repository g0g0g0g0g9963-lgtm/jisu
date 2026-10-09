// Run with QA_PLAYWRIGHT_MODULE and QA_BROWSER supplied by the local runtime.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(root, 'data-qa-recovery-20261009', 'browser-' + Date.now());
mkdirSync(run, { recursive: true });
const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port; await new Promise(r => listener.close(r));
const base = `http://127.0.0.1:${port}`, results = [];
const child = spawn(process.execPath, ['--import', pathToFileURL(resolve(root, 'qa-recovery-preload.mjs')).href, 'server/index.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test', DATA_DIR: run, HOST: '127.0.0.1', PORT: String(port), CLIENT_DIR: resolve(root,'dist'), ALLOW_ANONYMOUS: '1', SEED_DEMO: '0', MS_TENANT_ID: '', MS_CLIENT_ID: '', MS_CLIENT_SECRET: '', APP_BASE_URL: '' } });
let logs = '', browser;
child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
function check(name, good, details = {}) { const item = { name, pass: Boolean(good), ...details }; results.push(item); console.log(JSON.stringify(item)); if (!good) throw Error(name); }
async function rows() { return (await (await fetch(base + '/api/bookings')).json()).bookings; }
try {
  let ready = false;
  for (let i=0;i<200;i++) { if(child.exitCode !== null) throw Error(logs); try { if ((await fetch(base+'/api/health')).ok) { ready=true; break; } } catch {} await new Promise(r=>setTimeout(r,100)); }
  if(!ready) throw Error('Startup timeout');
  const { chromium } = await import(pathToFileURL(process.env.QA_PLAYWRIGHT_MODULE).href);
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Seoul' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.clock.setFixedTime(new Date('2026-10-08T02:10:00Z'));
  await page.goto(base, { waitUntil:'networkidle' });
  await page.getByRole('button',{name:'빠른 예약 펼치기'}).click();
  await page.locator('.booking-extra-details > summary').click();
  await page.locator('#purpose-input').fill('QA delayed write');
  async function pick(start,end) { await page.locator('#start-time-select').click(); await page.getByRole('option',{name:start,exact:true}).click(); await page.locator('#end-time-select').click(); await page.getByRole('option',{name:end,exact:true}).click(); }
  async function submit() { await page.locator('#reserve-button').click(); await page.getByRole('dialog',{name:'이 내용으로 예약할까요?'}).getByRole('button',{name:'예약하기',exact:true}).click(); }
  await pick('14:00','15:00');
  let writes=0, held;
  const hold = async route => { if(route.request().method()==='POST') { writes++; held=route; } else await route.continue(); };
  await page.route('**/api/bookings', hold);
  const before = performance.now(); await submit();
  await page.locator('.booking-recovery').waitFor({state:'visible',timeout:20000});
  const elapsed = performance.now()-before;
  check('stalled save leaves loading and exposes result check',elapsed>=14000 && elapsed<20000 && await page.getByRole('button',{name:'예약 결과 확인',exact:true}).isEnabled(),{elapsedMs:Math.round(elapsed),writes});
  check('draft survives timeout',await page.locator('#purpose-input').inputValue()==='QA delayed write');
  await page.screenshot({path:resolve(run,'recovery-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  const button = await page.getByRole('button',{name:'예약 결과 확인',exact:true}).boundingBox();
  check('mobile result-check control is reachable',button && button.y>=0 && button.y+button.height<=844 && await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:resolve(run,'recovery-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:960});
  if(held) await held.abort().catch(()=>{}); await page.unroute('**/api/bookings',hold);
  await page.getByRole('button',{name:'예약 결과 확인',exact:true}).click();
  await page.getByRole('dialog',{name:'내 예약',exact:true}).waitFor();
  check('lookup never resends the booking',writes===1 && (await rows()).length===1);
  await page.getByRole('button',{name:'내 예약 닫기'}).click();
  await page.locator('#purpose-input').fill('QA committed response lost');
  const lost = async route => { if(route.request().method()==='POST') { writes++; await route.fetch(); await route.abort('failed'); } else await route.continue(); };
  await page.route('**/api/bookings',lost); await submit();
  await page.locator('.booking-recovery').waitFor({state:'visible'});
  await page.unroute('**/api/bookings',lost);
  check('lost response leaves exactly one committed booking',(await rows()).filter(b=>b.purpose==='QA committed response lost').length===1);
  const failRead = route => route.abort('failed'); await page.route('**/api/bookings?*',failRead);
  await page.getByRole('button',{name:'예약 결과 확인',exact:true}).click();
  await page.getByText('아직 예약 내역을 불러오지 못했습니다.',{exact:false}).waitFor();
  check('failed lookup re-enables read-only retry',await page.getByRole('button',{name:'예약 결과 확인',exact:true}).isEnabled() && writes===2);
  await page.unroute('**/api/bookings?*',failRead);
  await page.getByRole('button',{name:'예약 결과 확인',exact:true}).click();
  await page.getByRole('dialog',{name:'내 예약',exact:true}).waitFor();
  check('successful lookup shows saved booking',await page.getByRole('dialog',{name:'내 예약',exact:true}).getByText('QA committed response lost',{exact:false}).count()===1 && writes===2);
  await page.getByRole('button',{name:'내 예약 닫기'}).click();
  await page.getByRole('button',{name:/내 예약 10:00–13:00/}).click();
  await page.getByRole('button',{name:'회의 일찍 끝내기'}).click();
  const early = page.getByRole('dialog',{name:'회의를 일찍 끝낼까요?'});
  check('11:10 preview shows actual 11:30 release',await early.getByText('11:30부터 예약 가능',{exact:true}).isVisible() && await early.getByRole('button',{name:'11:30에 종료',exact:true}).isVisible());
  await page.screenshot({path:resolve(run,'early-end-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844}); await page.screenshot({path:resolve(run,'early-end-mobile.png'),fullPage:true});
  let patches=0; page.on('request',r=>{if(r.method()==='PATCH')patches++;});
  await page.clock.setFixedTime(new Date('2026-10-08T02:31:00Z'));
  await early.getByRole('button',{name:'11:30에 종료',exact:true}).click();
  await early.getByText('시간이 지나 종료 가능 시각이 12:00',{exact:false}).waitFor();
  check('crossing a boundary requires renewed confirmation',patches===0 && await early.getByRole('button',{name:'12:00에 종료',exact:true}).isVisible());
  await early.getByRole('button',{name:'12:00에 종료',exact:true}).click(); await early.waitFor({state:'hidden'});
  check('confirmed boundary is persisted',(await rows()).find(b=>b.purpose==='QA synthetic ongoing')?.end==='12:00' && patches===1);
  check('no browser runtime errors',errors.length===0,{errors});
} catch(error) { results.push({name:'browser harness',pass:false,error:error.stack}); console.log(error.stack); process.exitCode=1; }
finally { if(browser) await browser.close(); child.kill(); await new Promise(r=>child.exitCode!==null?r():child.once('exit',r)); writeFileSync(resolve(run,'server.log'),logs); writeFileSync(resolve(run,'results.json'),JSON.stringify(results,null,2)); console.log('EVIDENCE '+run); }
