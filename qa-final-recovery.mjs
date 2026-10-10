// Final QA only: current save-recovery flow; no removed early-end UI assumptions.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
const root=dirname(fileURLToPath(import.meta.url));
const run=resolve(root,'data-qa-recovery-final',String(Date.now()));mkdirSync(run,{recursive:true});
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`,results=[];
const env={...process.env,NODE_ENV:'test',DATA_DIR:run,CLIENT_DIR:resolve(root,'dist'),HOST:'127.0.0.1',PORT:String(port),ALLOW_ANONYMOUS:'1',SEED_DEMO:'0',MS_TENANT_ID:'',MS_CLIENT_ID:'',MS_CLIENT_SECRET:'',APP_BASE_URL:'',MICROSOFT_TOKEN_KEY:'',BACKUP_DIR:'',BACKUP_INTERVAL_MINUTES:'0',ADMIN_MS_EMAIL:'',ADMIN_MS_OBJECT_ID:''};
const server=spawn(process.execPath,['--import',pathToFileURL(resolve(root,'qa-recovery-preload.mjs')).href,'server/index.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='',browser;server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function check(name,pass,detail={}){results.push({name,pass:Boolean(pass),...detail});console.log(JSON.stringify(results.at(-1)));if(!pass)throw Error(name);}
async function rows(){return(await(await fetch(base+'/api/bookings')).json()).bookings;}
try{
 let ready=false;for(let i=0;i<120;i++){if(server.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await pause(100);}if(!ready)throw Error('Fixture startup timeout');
 const {chromium}=await import(pathToFileURL(process.env.QA_PLAYWRIGHT_MODULE));browser=await chromium.launch({executablePath:process.env.QA_BROWSER,headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900},timezoneId:'Asia/Seoul'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await page.clock.setFixedTime(new Date('2026-10-08T02:10:00Z'));await page.goto(base,{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'빠른 예약 펼치기'}).click();await page.locator('.booking-extra-details > summary').click();await page.locator('#purpose-input').fill('QA delayed write');
 for(const [selector,time]of[['#start-time-select','14:00'],['#end-time-select','15:00']]){await page.locator(selector).click();await page.getByRole('option',{name:time,exact:true}).click();}
 const submit=async()=>{await page.locator('#reserve-button').click();await page.getByRole('dialog',{name:'이 내용으로 예약할까요?'}).getByRole('button',{name:'예약하기',exact:true}).click();};
 let writes=0,held;const hold=async route=>{if(route.request().method()==='POST'){writes++;held=route;}else await route.continue();};await page.route('**/api/bookings',hold);
 const before=performance.now();await submit();await page.locator('.booking-recovery').waitFor({state:'visible',timeout:22000});const elapsed=performance.now()-before;
 check('stalled save unlocks into result-check flow',elapsed>=14000&&elapsed<22000&&await page.getByRole('button',{name:'예약 결과 확인',exact:true}).isEnabled(),{elapsedMs:Math.round(elapsed)});
 check('timeout preserves draft and never automatically retries',await page.locator('#purpose-input').inputValue()==='QA delayed write'&&writes===1);
 await page.screenshot({path:resolve(run,'save-timeout-desktop.png'),fullPage:true});if(held)await held.abort().catch(()=>{});await page.unroute('**/api/bookings',hold);
 await page.getByRole('button',{name:'예약 결과 확인',exact:true}).click();await page.getByRole('dialog',{name:'내 예약',exact:true}).waitFor();check('result check is read-only',writes===1&&(await rows()).length===1);await page.getByRole('button',{name:'내 예약 닫기'}).click();
 await page.locator('#purpose-input').fill('QA committed response lost');const lost=async route=>{if(route.request().method()==='POST'){writes++;await route.fetch();await route.abort('failed');}else await route.continue();};await page.route('**/api/bookings',lost);await submit();await page.locator('.booking-recovery').waitFor({state:'visible'});await page.unroute('**/api/bookings',lost);
 check('lost response retains one committed reservation',(await rows()).filter(b=>b.purpose==='QA committed response lost').length===1);
 const failRead=route=>route.abort('failed');await page.route('**/api/bookings?*',failRead);await page.getByRole('button',{name:'예약 결과 확인',exact:true}).click();await page.getByText('아직 예약 내역을 불러오지 못했습니다.',{exact:false}).waitFor();
 check('failed read allows another read-only check',await page.getByRole('button',{name:'예약 결과 확인',exact:true}).isEnabled()&&writes===2);await page.unroute('**/api/bookings?*',failRead);
 await page.getByRole('button',{name:'예약 결과 확인',exact:true}).click();await page.getByRole('dialog',{name:'내 예약',exact:true}).waitFor();check('successful read finds the committed booking without replay',await page.getByRole('dialog',{name:'내 예약',exact:true}).getByText('QA committed response lost',{exact:false}).count()===1&&writes===2);
 await page.screenshot({path:resolve(run,'recovered-booking-desktop.png'),fullPage:true});check('no browser runtime errors',errors.length===0,{errors});
}catch(error){results.push({name:'harness',pass:false,error:error.stack});console.log(error.stack);process.exitCode=1;}
finally{if(browser)await browser.close();server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));writeFileSync(resolve(run,'results.json'),JSON.stringify({scope:'isolated loopback; synthetic database; outbound browser blocked; Microsoft disabled',passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));writeFileSync(resolve(run,'server.log'),logs);console.log('EVIDENCE '+run);}
