import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import net from 'node:net';
const root=dirname(fileURLToPath(import.meta.url));
const run=resolve(root,'data-qa-admin',String(Date.now()));mkdirSync(run,{recursive:true});
const children=[],results=[];
const room=JSON.parse(readFileSync(resolve(root,'app/config/rooms.json'),'utf8'))[0].id;
const record=(name,test)=>{assert.ok(test,name);results.push(name);console.log('PASS '+name);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const value=socket.address().port;await new Promise(r=>socket.close(r));return value;}
async function start(mode='admin',extra={}){
 const p=await port(),data=resolve(run,mode);mkdirSync(data,{recursive:true});
 const base='http://127.0.0.1:'+p;
 const env={...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(p),DATA_DIR:data,CLIENT_DIR:resolve(root,'dist'),ALLOW_ANONYMOUS:'',SEED_DEMO:'0',SESSION_SECRET:'test-only',MS_TENANT_ID:'qa-tenant',MS_CLIENT_ID:'qa-client',MS_CLIENT_SECRET:'test-only',APP_BASE_URL:base,ADMIN_MS_EMAIL:'alice@example.invalid',ADMIN_MS_OBJECT_ID:'',BACKUP_DIR:resolve(data,'backups'),BACKUP_INTERVAL_MINUTES:'0',BACKUP_MAX_FILES:'2',OPS_PRIMARY_CONTACT:'',OPS_SECONDARY_CONTACT:'',TEST_FIXTURE_SSO:'0',TEST_FIXTURE_BOUNDARIES:'0',TEST_NOW:'2026-10-09T01:00:00Z',...extra};
 const child=spawn(process.execPath,['--import',pathToFileURL(resolve(root,'qa-preload.mjs')).href,'server/index.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 const s={base,data,child};
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/api/health')).ok)return s;}catch{}await pause(100);}throw Error('Startup timeout '+logs);
}
async function req(s,path,{method='GET',body,cookie,headers={}}={}){
 if(method==='PATCH'&&path.startsWith('/api/bookings/')&&body?.expectedRevision===undefined){
  const current=(await req(s,'/api/bookings',{cookie})).json?.bookings?.find(b=>b.id===path.split('/').at(-1));
  body={...body,expectedRevision:current?.revision};
 }
 const r=await fetch(s.base+path,{method,redirect:'manual',headers:{...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});const text=await r.text();let json;try{json=JSON.parse(text);}catch{}return{status:r.status,json,text,headers:r.headers};
}
async function login(s,code){const begin=await req(s,'/auth/login?returnTo=/admin');const state=new URL(begin.headers.get('location')).searchParams.get('state');const c=begin.headers.getSetCookie()[0].split(';')[0];const end=await req(s,'/auth/callback?state='+state+'&code='+code,{cookie:c});assert.equal(end.status,302);return end.headers.getSetCookie().find(v=>v.startsWith('bdo-session=')&&!v.startsWith('bdo-session=;')).split(';')[0];}
const body={roomId:room,date:'2026-10-12',start:'11:00',end:'12:00',owner:'ATTACKER INPUT',purpose:'PRIVATE PURPOSE DO NOT LOG',attendees:['PRIVATE ATTENDEE'],team:'QA'};
async function jobDone(s,cookie){for(let i=0;i<100;i++){const r=await req(s,'/api/admin/status',{cookie});if(r.json.backup.job?.state!=='running')return r.json;await pause(50);}throw Error('Job timeout');}
try {
 const s=await start();
 record('guest page redirects to SSO',(await req(s,'/admin')).status===302);
 record('guest admin API requires authentication',(await req(s,'/api/admin/status')).status===401);
 const alice=await login(s,'alice'),bob=await login(s,'bob');
 record('configured Microsoft account receives role',(await req(s,'/api/me',{cookie:alice})).json.user.isAdmin===true);
 record('ordinary employee does not receive role',(await req(s,'/api/me',{cookie:bob})).json.user.isAdmin===false);
 for(const path of ['/admin','/admin/','/ADMIN','/api/admin/status','/api/admin/audit'])record('nonadmin denied '+path,(await req(s,path,{cookie:bob})).status===403);
 record('nonadmin backup denied',(await req(s,'/api/admin/backups',{cookie:bob,method:'POST',body:{isAdmin:true},headers:{'x-admin-action':'1'}})).status===403);
 const spoof=await login(s,'spoof');record('reused email with different object ID denied',(await req(s,'/api/me',{cookie:spoof})).json.user.isAdmin===false);
 const renamed=await login(s,'renamed');record('display-name change retains pinned identity',(await req(s,'/api/me',{cookie:renamed})).json.user.isAdmin===true);
 let r=await req(s,'/api/admin/status',{cookie:alice});record('admin status is private and genuine',r.status===200&&r.headers.get('cache-control')==='no-store'&&r.json.backup.last===null&&r.json.externalMonitoring.connected===false);
 record('admin page allowed',(await req(s,'/admin',{cookie:alice})).status===200);
 record('missing action header rejected',(await req(s,'/api/admin/backups',{cookie:alice,method:'POST',body:{}})).status===403);
 record('cross-origin action rejected',(await req(s,'/api/admin/backups',{cookie:alice,method:'POST',body:{},headers:{'x-admin-action':'1',origin:'https://evil.example'}})).status===403);
 r=await req(s,'/api/bookings',{cookie:alice,method:'POST',body});record('normal booking creation still succeeds',r.status===201);const id=r.json.created[0].id;
 r=await req(s,'/api/bookings/'+id,{cookie:alice,method:'PATCH',body:{...body,end:'12:30',purpose:'CHANGED PRIVATE PURPOSE'}});record('normal edit succeeds',r.status===200);
 r=await req(s,'/api/bookings/'+id,{cookie:alice,method:'DELETE',body:{}});record('normal cancellation succeeds',r.status===204);
 const audit=(await req(s,'/api/admin/audit',{cookie:alice})).json;
 record('create update cancel all recorded',audit.items.length===3&&audit.items.map(e=>e.action).join(',')==='cancel,update,create');
 record('audit trusts server identity',audit.items.every(e=>e.actorId==='fixture-alice'&&e.actorName==='QA Alice'));
 record('audit excludes sensitive purpose and attendees',!JSON.stringify(audit).includes('PRIVATE')&&!JSON.stringify(audit).includes('ATTACKER INPUT'));
 record('audit records previous and new end times',audit.items[1].before.end==='12:00'&&audit.items[1].after.end==='12:30');
 record('cancelled booking absent but audit survives',(await req(s,'/api/bookings',{cookie:alice})).json.bookings.length===0);
 record('audit filtering',(await req(s,'/api/admin/audit?action=cancel',{cookie:alice})).json.items.length===1);
 record('audit cursor validation',(await req(s,'/api/admin/audit?before=-1',{cookie:alice})).status===400);
 const db=new DatabaseSync(resolve(s.data,'bookings.sqlite'));
 db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON booking_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
 r=await req(s,'/api/bookings',{cookie:alice,method:'POST',body});record('audit failure rolls back booking creation',r.status===500&&db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n===0);
 db.exec('DROP TRIGGER fail_audit');
 r=await req(s,'/api/bookings',{cookie:alice,method:'POST',body});const keptId=r.json.created[0].id;
 db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON booking_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
 r=await req(s,'/api/bookings/'+keptId,{cookie:alice,method:'PATCH',body:{...body,end:'13:00'}});record('audit failure rolls back edit',r.status===500&&db.prepare('SELECT end FROM bookings WHERE id=?').get(keptId).end==='12:00');
 r=await req(s,'/api/bookings/'+keptId,{cookie:alice,method:'DELETE',body:{}});record('audit failure rolls back cancellation',r.status===500&&db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n===1);
 db.exec('DROP TRIGGER fail_audit');db.close();
 r=await req(s,'/api/admin/status',{cookie:alice});record('monitor counts real write errors',r.json.metrics.writeFailures===3&&r.json.alerts.some(v=>v.level==='danger'));
 const actionOptions={cookie:alice,method:'POST',body:{},headers:{'x-admin-action':'1',origin:s.base}};
 r=await req(s,'/api/admin/backups',actionOptions);record('backup starts asynchronously',r.status===202);
 let status=await jobDone(s,alice);record('backup completes with integrity check',status.backup.job.state==='success'&&status.backup.verification.bookings===1);
 const copy=new DatabaseSync(resolve(s.data,'backups',status.backup.last.name),{readOnly:true});record('backup includes committed WAL and audit history',copy.prepare('SELECT COUNT(*) AS n FROM bookings').get().n===1&&copy.prepare('SELECT COUNT(*) AS n FROM booking_audit').get().n===4);copy.close();
 record('backup cannot be downloaded through admin API',(await req(s,'/api/admin/backups/'+status.backup.last.name,{cookie:alice})).status===404);
 r=await req(s,'/api/admin/verify-latest',actionOptions);status=await jobDone(s,alice);record('verification leaves live bookings unchanged',r.status===202&&status.backup.job.state==='success'&&(await req(s,'/api/bookings',{cookie:alice})).json.bookings.length===1);
 await req(s,'/api/admin/backups',actionOptions);await jobDone(s,alice);await req(s,'/api/admin/backups',actionOptions);status=await jobDone(s,alice);record('file limit does not delete existing backups',status.backup.job.state==='failed'&&status.backup.fileCount===2);
 const unknown=await start('unconfigured',{ADMIN_MS_EMAIL:'',BACKUP_DIR:''});const unknownUser=await login(unknown,'alice');record('unconfigured administrator defaults to deny',(await req(unknown,'/api/admin/status',{cookie:unknownUser})).status===403);
 const anonymous=await start('anonymous',{ALLOW_ANONYMOUS:'1',MS_TENANT_ID:'',MS_CLIENT_ID:'',MS_CLIENT_SECRET:'',APP_BASE_URL:'',BACKUP_DIR:''});record('anonymous preview cannot become admin',(await req(anonymous,'/api/admin/status')).status===403&&(await req(anonymous,'/admin')).status===403);
 if(process.env.QA_PLAYWRIGHT_MODULE&&process.env.QA_BROWSER){
  const {chromium}=await import(pathToFileURL(process.env.QA_PLAYWRIGHT_MODULE));const browser=await chromium.launch({executablePath:process.env.QA_BROWSER,headless:true});
  try {
   const context=await browser.newContext({viewport:{width:1440,height:1100}});await context.addCookies([{name:'bdo-session',value:alice.split('=')[1],url:s.base}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(s.base+'/admin');await page.getByRole('heading',{name:'회의실 운영 관리',exact:true}).waitFor();await page.getByRole('heading',{name:'백업·검증',exact:true}).waitFor();await page.screenshot({path:resolve(run,'admin-desktop.png'),fullPage:true});
   await page.getByRole('button',{name:'변경 이력',exact:true}).click();await page.getByText('기능 적용 이후의 기록만 표시됩니다.',{exact:false}).waitFor();await page.locator('.admin-audit-list article').first().waitFor();record('real audit rows render',await page.locator('.admin-audit-list article').count()===4);await page.screenshot({path:resolve(run,'admin-audit.png'),fullPage:true});
   for(const tab of ['운영 현황','변경 이력','복구·대응 안내']){await page.getByRole('button',{name:tab,exact:true}).click();await page.setViewportSize({width:390,height:844});await pause(150);record('mobile layout '+tab,await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.locator('.admin-footer').scrollIntoViewIfNeeded();record('mobile footer reachable '+tab,await page.locator('.admin-footer').evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom<=innerHeight+2&&r.top>=0;}));await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:resolve(run,'admin-mobile-'+(['운영 현황','변경 이력','복구·대응 안내'].indexOf(tab))+'.png'),fullPage:true});}
   record('no browser runtime errors',errors.length===0);
   await page.setViewportSize({width:1280,height:900});await page.goto(s.base+'/');await page.getByRole('link',{name:'관리자',exact:true}).waitFor();record('admin menu visible only for authorized user',await page.getByRole('link',{name:'관리자',exact:true}).isVisible());
   const normal=await browser.newContext();await normal.addCookies([{name:'bdo-session',value:bob.split('=')[1],url:s.base}]);const ordinary=await normal.newPage();await ordinary.goto(s.base+'/');await ordinary.getByText('QA Bob님',{exact:false}).waitFor();record('ordinary user has no administrator menu',await ordinary.getByRole('link',{name:'관리자',exact:true}).count()===0);await normal.close();await context.close();
  }finally{await browser.close();}
 }
 const missing=await start('backup-unconfigured',{BACKUP_DIR:''});const missingCookie=await login(missing,'alice');record('unconfigured backup cannot run',(await req(missing,'/api/admin/backups',{cookie:missingCookie,method:'POST',body:{},headers:{'x-admin-action':'1'}})).status===409);
 const scheduled=await start('scheduled',{BACKUP_INTERVAL_MINUTES:'0.001'});const scheduledCookie=await login(scheduled,'alice');let scheduledStatus;for(let i=0;i<80;i++){scheduledStatus=(await req(scheduled,'/api/admin/status',{cookie:scheduledCookie})).json;if(scheduledStatus.backup.last)break;await pause(100);}record('configured schedule produces verified backup',!!scheduledStatus.backup.last&&!!scheduledStatus.backup.verification);
 const exact=await start('explicit-id',{ADMIN_MS_OBJECT_ID:'fixture-alice'});record('explicit object ID rejects wrong identity before pinning',(await req(exact,'/api/me',{cookie:await login(exact,'spoof')})).json.user.isAdmin===false);record('explicit object ID accepts intended identity',(await req(exact,'/api/me',{cookie:await login(exact,'alice')})).json.user.isAdmin===true);
 const dates=Array.from({length:60},(_,i)=>new Date(Date.UTC(2026,10,1+i)).toISOString().slice(0,10));r=await req(s,'/api/bookings',{cookie:alice,method:'POST',body:{...body,dates}});record('repeated reservations write individual audit events',r.status===201&&r.json.created.length===60);
 const firstPage=(await req(s,'/api/admin/audit',{cookie:alice})).json;const nextPage=(await req(s,'/api/admin/audit?before='+firstPage.nextCursor,{cookie:alice})).json;record('audit pagination has no missing or duplicate events',firstPage.items.length===50&&nextPage.items.length===14&&new Set([...firstPage.items,...nextPage.items].map(x=>x.id)).size===64);
 writeFileSync(resolve(run,'results.json'),JSON.stringify({passed:results.length,results},null,2));console.log('RESULT '+results.length+' checks passed; evidence '+run);
}finally{for(const child of children)child.kill();}
