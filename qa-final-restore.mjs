// Restore only a synthetic backup produced by qa-admin into a new test-only server.
import {spawn} from 'node:child_process';
import {mkdirSync,copyFileSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import net from 'node:net';
const root=dirname(fileURLToPath(import.meta.url)),source=resolve(process.argv[2]||'');
if(!relative(resolve(root,'data-qa-admin'),source)||relative(resolve(root,'data-qa-admin'),source).startsWith('..'))throw Error('Requires a qa-admin synthetic run directory');
const names=readdirSync(resolve(source,'admin/backups')).filter(n=>/^bookings-\d{13}-[a-f0-9-]{36}\.sqlite$/.test(n));
if(!names.length)throw Error('No synthetic backup available');
const run=resolve(root,'data-qa-final-restore',String(Date.now()));mkdirSync(run,{recursive:true});
const original=new DatabaseSync(resolve(source,'admin/backups',names[0]),{readOnly:true});
const expected=original.prepare('SELECT id,room_id,date,start,end,owner,revision,ended_at FROM bookings ORDER BY id').all();
const expectedAudit=original.prepare('SELECT COUNT(*) AS n FROM booking_audit').get().n;
const oldSession=original.prepare('SELECT sid,user_json FROM sessions LIMIT 1').get();original.close();
copyFileSync(resolve(source,'admin/backups',names[0]),resolve(run,'bookings.sqlite'));
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`,results=[];let logs='';
const env={...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:run,CLIENT_DIR:resolve(root,'dist'),ALLOW_ANONYMOUS:'',SEED_DEMO:'0',MS_TENANT_ID:'qa-tenant',MS_CLIENT_ID:'qa-client',MS_CLIENT_SECRET:'test-only',APP_BASE_URL:base,SESSION_SECRET:'test-only',MICROSOFT_TOKEN_KEY:'',ADMIN_MS_EMAIL:'alice@example.invalid',ADMIN_MS_OBJECT_ID:'fixture-alice',BACKUP_DIR:'',BACKUP_INTERVAL_MINUTES:'0',TEST_FIXTURE_SSO:'0',TEST_FIXTURE_BOUNDARIES:'0',TEST_NOW:'2026-10-09T01:00:00Z'};
const server=spawn(process.execPath,['--import',pathToFileURL(resolve(root,'qa-preload.mjs')).href,'server/index.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,pass,detail={})=>{results.push({name,pass:Boolean(pass),...detail});console.log(JSON.stringify(results.at(-1)));if(!pass)throw Error(name);};
async function req(path,{method='GET',cookie,body}={}){const response=await fetch(base+path,{method,redirect:'manual',headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});let json;try{json=await response.json();}catch{}return{response,json};}
async function login(){const begin=await req('/auth/login');const state=new URL(begin.response.headers.get('location')).searchParams.get('state');const cookie=begin.response.headers.getSetCookie()[0].split(';')[0];const end=await req('/auth/callback?state='+state+'&code=alice',{cookie});return end.response.headers.getSetCookie().find(v=>v.startsWith('bdo-session=')&&!v.startsWith('bdo-session=;')).split(';')[0];}
try{
 let ready=false;for(let i=0;i<120;i++){if(server.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await pause(100);}check('restored backup starts as a separate service',ready);
 if(oldSession){const old=await req('/api/me',{cookie:'bdo-session='+oldSession.sid});check('restore also restores previous valid sessions: operational revocation required',old.response.status===200,{risk:'Synthetic session restored; production restore must invalidate sessions explicitly.'});}
 const cookie=await login();const list=await req('/api/bookings',{cookie});check('restored bookings are readable through authenticated API',list.response.status===200&&list.json.bookings.length===expected.length&&list.json.bookings.every(b=>expected.some(e=>e.id===b.id&&e.start===b.start&&e.end===b.end&&e.revision===b.revision)));
 const audit=await req('/api/admin/audit',{cookie});check('restored audit history is accessible to authorized administrator',audit.response.status===200&&audit.json.items.length===expectedAudit);
 const room=JSON.parse(readFileSync(resolve(root,'app/config/rooms.json'),'utf8'))[0].id;
 const body={roomId:room,dates:['2026-10-20'],start:'15:00',end:'16:00',owner:'QA Restore',team:'QA',purpose:'Synthetic post-restore booking'};
 const created=await req('/api/bookings',{method:'POST',cookie,body}),booking=created.json?.created?.[0];check('restored service can create a new booking',created.response.status===201&&Boolean(booking?.id));
 const changed=await req('/api/bookings/'+booking.id,{method:'PATCH',cookie,body:{...body,date:body.dates[0],end:'16:30',expectedRevision:booking.revision}});check('restored service can update with concurrency protection',changed.response.status===200&&changed.json.booking.end==='16:30'&&changed.json.booking.revision===booking.revision+1);
 const deleted=await req('/api/bookings/'+booking.id,{method:'DELETE',cookie,body:{}});check('restored service can delete a future booking',deleted.response.status===200&&deleted.json.action==='deleted');
 const final=await req('/api/bookings',{cookie});check('post-restore cycle leaves original records intact',final.json.bookings.length===expected.length&&final.json.bookings.every(b=>expected.some(e=>e.id===b.id&&e.end===b.end)));
 const database=new DatabaseSync(resolve(run,'bookings.sqlite'),{readOnly:true});check('restored database integrity and added audit events',database.prepare('PRAGMA integrity_check').get().integrity_check==='ok'&&database.prepare('SELECT COUNT(*) AS n FROM booking_audit').get().n===expectedAudit+3);database.close();
 const locked=new DatabaseSync(resolve(run,'bookings.sqlite'));locked.exec('BEGIN IMMEDIATE');
 let blocked;try{blocked=await req('/api/bookings',{method:'POST',cookie,body:{...body,dates:['2026-10-21']}});}finally{locked.exec('ROLLBACK');locked.close();}
 check('real database write lock returns a controlled failure',blocked.response.status===500&&!JSON.stringify(blocked.json).includes('sqlite'));
 const status=await req('/api/admin/status',{cookie});check('database lock and failed write are visible to administrator',status.response.status===200&&status.json.metrics.lockErrors>=1&&status.json.metrics.writeFailures>=1&&status.json.alerts.some(v=>v.level==='danger')&&status.json.alerts.some(v=>v.text.includes('DB 잠금')));
 check('external alerting, offsite copy and rollback are not falsely advertised',status.json.externalMonitoring.connected===false&&status.json.offsiteCopy.connected===false&&status.json.rollback.connected===false);
}catch(error){results.push({name:'harness',pass:false,error:error.stack});console.log(error.stack);process.exitCode=1;}
finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));writeFileSync(resolve(run,'results.json'),JSON.stringify({scope:'Synthetic qa-admin backup only, new temporary loopback service; real NAS restore not tested',source:relative(root,source),passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));writeFileSync(resolve(run,'server.log'),logs);console.log('EVIDENCE '+run);}
