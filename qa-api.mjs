import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import net from 'node:net';
import crypto from 'node:crypto';
const root=dirname(fileURLToPath(import.meta.url));
const app=root;
const runs=resolve(root,'evidence','fixed-run-'+Date.now());mkdirSync(runs,{recursive:true});
const rooms=JSON.parse(readFileSync(resolve(app,'app/config/rooms.json'),'utf8'));
const room=rooms[0].id,room2=rooms[1].id,results=[],children=[],servers=[];
function check(id,title,good,details={}){results.push({id,title,status:good?'PASS':'FAIL',...details});console.log(JSON.stringify(results.at(-1)));}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function launch(mode){
 const p=await port(),data=resolve(runs,mode);mkdirSync(data);
 const env={...process.env,HOST:'127.0.0.1',PORT:String(p),DATA_DIR:data,TZ:'UTC',NODE_ENV:'test',ALLOW_ANONYMOUS:'',SEED_DEMO:'0',MS_TENANT_ID:'',MS_CLIENT_ID:'',MS_CLIENT_SECRET:'',APP_BASE_URL:'',SESSION_SECRET:'qa-only-secret-not-for-production',TEST_FIXTURE_SSO:'0',TEST_FIXTURE_BOUNDARIES:'0',TEST_ROOM:room,TEST_ROOM2:room2,TEST_NOW:'2026-10-08T01:15:00Z'};
 if(mode==='anonymous'||mode.startsWith('boundaries'))env.ALLOW_ANONYMOUS='1';
 if(mode.startsWith('boundaries'))env.TEST_FIXTURE_BOUNDARIES='1';
 if(mode==='boundaries-exact')env.TEST_NOW='2026-10-08T01:30:00Z';
 if(mode==='sso')Object.assign(env,{MS_TENANT_ID:'qa-tenant',MS_CLIENT_ID:'qa-client',MS_CLIENT_SECRET:'qa-fake-secret',APP_BASE_URL:'http://127.0.0.1:'+p,TEST_FIXTURE_SSO:'1'});
 if(mode==='partial')Object.assign(env,{MS_TENANT_ID:'qa-tenant',MS_CLIENT_ID:'qa-client',APP_BASE_URL:'http://127.0.0.1:'+p,ALLOW_ANONYMOUS:'1'});
 if(mode==='production-anonymous')Object.assign(env,{NODE_ENV:'production',ALLOW_ANONYMOUS:'1'});
 if(mode==='production-http')Object.assign(env,{NODE_ENV:'production',MS_TENANT_ID:'qa-tenant',MS_CLIENT_ID:'qa-client',MS_CLIENT_SECRET:'qa-fake-secret',APP_BASE_URL:'http://127.0.0.1:'+p});
 const c=spawn(process.execPath,['--import',pathToFileURL(resolve(root,'qa-preload.mjs')).href,'server/index.mjs'],{cwd:app,env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(c);let logs='';
 c.stdout.on('data',x=>logs+=x);c.stderr.on('data',x=>logs+=x);
 const s={mode,base:'http://127.0.0.1:'+p,c,data,log:()=>logs};servers.push(s);return s;
}
async function start(mode){
 const s=await launch(mode);
 for(let i=0;i<100;i++){if(s.c.exitCode!==null)throw Error('Unexpected server exit '+mode+': '+s.log());try{const r=await fetch(s.base+'/api/health');if(r.ok)return s;}catch{}await new Promise(r=>setTimeout(r,100));}
 throw Error('Server startup timeout '+mode+': '+s.log());
}
async function configReject(mode){
 const s=await launch(mode);let listened=false;
 for(let i=0;i<100&&s.c.exitCode===null;i++){try{const r=await fetch(s.base+'/api/health');listened ||= r.ok;}catch{}await new Promise(r=>setTimeout(r,50));}
 check('AUTH-CONFIG-'+mode,'Unsafe configuration fails closed: '+mode,!listened&&s.c.exitCode!==null&&s.c.exitCode!==0,{listened,exitCode:s.c.exitCode});
 if(s.c.exitCode===null)s.c.kill();
}
async function req(s,path,method='GET',body,cookie,extra={}){
 // Existing scenarios test booking rules against the version read immediately before editing.
 // Stale/missing-version requests are tested without this helper in qa-booking-conflict.mjs.
 if(method==='PATCH'&&path.startsWith('/api/bookings/')&&body&&typeof body==='object'&&body.expectedRevision===undefined){
  const current=(await req(s,'/api/bookings','GET',undefined,cookie)).data?.bookings?.find(b=>b.id===path.split('/').at(-1));
  body={...body,expectedRevision:current?.revision};
 }
 const r=await fetch(s.base+path,{method,redirect:'manual',headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...extra},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
 const text=await r.text();let data;try{data=JSON.parse(text);}catch{}return{status:r.status,data,text,headers:r.headers};
}
const valid={roomId:room,date:'2026-10-09',start:'09:00',end:'10:00',owner:'QA Alice',team:'QA',purpose:'Test booking',attendees:['QA attendee']};
const create=(s,o={},cookie)=>req(s,'/api/bookings','POST',{...valid,...o},cookie);
const idOf=r=>r.data?.created?.[0]?.id;
const rows=async(s,cookie)=>(await req(s,'/api/bookings','GET',undefined,cookie)).data.bookings;
async function loginStart(s,returnTo='/'){
 const r=await req(s,'/auth/login?returnTo='+encodeURIComponent(returnTo));
 const cookie=r.headers.get('set-cookie')?.split(';')[0],state=new URL(r.headers.get('location')).searchParams.get('state');
 return{cookie,state};
}
async function login(s,code,returnTo='/'){
 const st=await loginStart(s,returnTo),done=await req(s,'/auth/callback?state='+encodeURIComponent(st.state)+'&code='+encodeURIComponent(code),'GET',undefined,st.cookie);
 return{cookie:done.headers.getSetCookie().find(x=>x.startsWith('bdo-session=')&&!x.startsWith('bdo-session=;'))?.split(';')[0],response:done,stateCookie:st.cookie};
}
try{
 for(const mode of ['unconfigured','partial','production-anonymous','production-http'])await configReject(mode);
 const anon=await start('anonymous');
 let r=await req(anon,'/api/health');check('C01','Health and empty synthetic database',r.status===200&&r.data.bookings===0&&r.data.sso===false);
 r=await create(anon);const first=idOf(r);check('C02','Create valid booking',r.status===201&&!!first);
 r=await req(anon,'/api/bookings');check('C03','Persist and list booking',r.data.bookings.length===1&&r.data.bookings[0].attendees.length===1&&!('isMine' in r.data.bookings[0]));
 r=await create(anon,{start:'09:30',end:'10:30'});check('C04','Overlapping booking rejected',r.status===409);
 r=await create(anon,{start:'10:00',end:'10:30'});check('C05','Adjacent booking allowed',r.status===201);
 check('CACHE-BOOKING','Booking responses disable cache',r.headers.get('cache-control')==='no-store');
 const bads=[['C06','Unknown room',{roomId:'absent'}],['C07','Invalid calendar date',{date:'2026-02-30'}],['C08','Past date',{date:'2026-10-07'}],['C09','Today past time',{date:'2026-10-08'}],['C10','Beyond 12 months',{date:'2028-01-10'}],['C11','End before start',{start:'11:00',end:'10:00'}],['C12','Start at closing boundary',{start:'24:00',end:'24:00'}],['C13','Non 30-minute boundary',{start:'11:10',end:'12:00'}],['C14','Invalid time format',{start:'9:00'}],['C15','Blank owner',{owner:' '}],['C16','Long owner',{owner:'x'.repeat(41)}],['C17','Null body',null]];
 for(const [id,title,b] of bads){r=b===null?await req(anon,'/api/bookings','POST','null'):await create(anon,b);check(id,title+' rejected',r.status===400,{actual:r.status});}
 const dates=Array.from({length:61},(_,i)=>new Date(Date.UTC(2026,9,10+i)).toISOString().slice(0,10));
 r=await create(anon,{dates});check('C18','61-date batch rejected',r.status===400);
 r=await create(anon,{dates:['2026-10-10','2026-10-10'],start:'11:00',end:'12:00'});check('C19','Duplicate date deduplicated',r.status===201&&r.data.created.length===1);
 const before=(await rows(anon)).length;r=await create(anon,{dates:['2026-10-09','2026-10-11']});const after=(await rows(anon)).length;
 check('C20','Repeated batch conflict is atomic',r.status===409&&after===before,{before,after});
 const races=await Promise.all(Array.from({length:20},()=>create(anon,{date:'2026-10-12',start:'13:00',end:'14:00'})));
 check('C21','20 simultaneous requests create exactly one booking',races.filter(x=>x.status===201).length===1&&races.filter(x=>x.status===409).length===19);
 r=await req(anon,'/api/bookings/'+first,'DELETE',{owner:'QA Bob'});check('C22','Wrong anonymous name rejected',r.status===403);
 r=await req(anon,'/api/bookings/absent','DELETE',{owner:'QA Alice'});check('C23','Missing booking returns 404',r.status===404);
 r=await req(anon,'/api/bookings/'+first,'PATCH',{roomId:room,date:'2026-10-09',start:'14:00',end:'15:00',owner:'QA Alice'});
 check('C24','Patch preserves omitted metadata',r.status===200&&r.data.booking.purpose===valid.purpose&&r.data.booking.attendees[0]==='QA attendee'&&r.data.booking.team==='QA');
 r=await req(anon,'/api/bookings/'+first,'PATCH',{...valid,start:'10:00',end:'10:30'});check('C25','Patch collision rejected',r.status===409);
 r=await req(anon,'/api/bookings?from=2026-10-09');check('C26','Incomplete date range rejected',r.status===400);
 r=await req(anon,'/api/bookings?from=2026-10-09&to=2026-10-09');check('C27','Date range filter',r.status===200&&r.data.bookings.every(x=>x.date==='2026-10-09'));
 r=await req(anon,'/api/bookings?from=2026-10-10&to=2026-10-09');check('RANGE-ORDER','Reversed date range rejected',r.status===400);
 r=await create(anon,{date:'2026-10-13',purpose:"'; DROP TABLE bookings;--",owner:'QA SQL'});check('C28','SQL metacharacters stored as data',r.status===201&&(await req(anon,'/api/health')).status===200);
 r=await req(anon,'/api/bookings/'+first,'PATCH',{...valid,date:'2028-01-10'});check('B01','Patch rejects beyond 12 months',r.status===400,{actual:r.status});
 const second=await create(anon,{date:'2026-10-14'});r=await req(anon,'/api/bookings/'+idOf(second),'PATCH',{...valid,date:'2026-10-08'});check('B02','Patch rejects elapsed today',r.status===400,{actual:r.status});
 r=await req(anon,'/api/bookings','POST','{');check('B03','Malformed JSON returns 400',r.status===400);
 check('CACHE-MALFORMED','Malformed request errors disable cache',r.headers.get('cache-control')==='no-store');
 r=await create(anon,{date:'2026-10-15',purpose:'x'.repeat(70000)});check('B04','Oversized request returns 413',r.status===413);
 check('CACHE-OVERSIZED','Oversized request errors disable cache',r.headers.get('cache-control')==='no-store');
 const own=await create(anon,{date:'2026-10-16'});r=await req(anon,'/api/bookings/'+idOf(own),'DELETE',{owner:'QA Alice'});check('C29','Delete persists',r.status===204&&!(await rows(anon)).some(x=>x.id===idOf(own)));
 const seriesA=await create(anon,{dates:['2026-10-19','2026-10-20'],seriesId:'attacker-series'}),seriesB=await create(anon,{dates:['2026-10-21','2026-10-22'],seriesId:'attacker-series'});
 const sa=seriesA.data?.created,sb=seriesB.data?.created;
 check('SERIES-A','One batch has a server-generated shared series',seriesA.status===201&&sa.length===2&&!!sa[0].seriesId&&sa[0].seriesId===sa[1].seriesId&&sa[0].seriesId!=='attacker-series');
 check('SERIES-B','Matching fields in independent batches have different series',seriesB.status===201&&sa[0].seriesId!==sb[0].seriesId);
 r=await create(anon,{date:'2026-10-23',seriesId:sa[0].seriesId});check('SERIES-SINGLE','Single independent booking has no series',r.status===201&&r.data.created[0].seriesId==null);
 r=await req(anon,'/api/bookings/'+sa[0].id,'PATCH',{...valid,date:'2026-10-19',start:'11:00',end:'12:00',seriesId:'forged'});check('SERIES-PATCH','Patch preserves original series',r.status===200&&r.data.booking.seriesId===sa[0].seriesId);
 const boundary=await start('boundaries'),fixtures=await rows(boundary),ongoing=fixtures.find(x=>x.purpose==='Ongoing fixture'),ended=fixtures.find(x=>x.purpose==='Ended fixture');
 for(const [name,patch]of[['past-end',{end:'10:00'}],['room',{roomId:room2}],['start',{start:'09:30'}],['past-date',{date:'2026-10-07'}]]){
  r=await req(boundary,'/api/bookings/'+ongoing.id,'PATCH',{...ongoing,...patch});check('ONGOING-'+name,'Ongoing booking rejects invalid change: '+name,r.status===400,{actual:r.status});
 }
const blocker=await create(boundary,{date:'2026-10-08',start:'11:30',end:'12:00'});
 check('EXTEND-BLOCKER','Future reservation after ongoing meeting creates',blocker.status===201);
 r=await req(boundary,'/api/bookings/'+ongoing.id,'PATCH',{...ongoing,end:'11:30'});
 check('ONGOING-EXTEND','Ongoing meeting can extend into free future time',r.status===200&&r.data.booking.end==='11:30',{actual:r.status});
 r=await req(boundary,'/api/bookings/'+ongoing.id,'PATCH',{...ongoing,end:'12:00'});
 check('ONGOING-EXTEND-CONFLICT','Ongoing extension cannot overlap following reservation',r.status===409,{actual:r.status});
  r=await req(boundary,'/api/bookings/'+ongoing.id,'PATCH',{...ongoing,end:'10:30'});check('EARLY-END','Legitimate ongoing early-end succeeds',r.status===200&&r.data.booking.end==='10:30',{actual:r.status});
 r=await req(boundary,'/api/bookings/'+ended.id,'PATCH',{...ended,start:'11:00',end:'12:00'});check('ENDED-PATCH','Ended same-day booking cannot be moved',r.status===400);
 r=await req(boundary,'/api/bookings/'+ended.id,'DELETE',{owner:ended.owner});check('ENDED-DELETE','Ended same-day booking cannot be deleted',r.status===400);
 const exact=await start('boundaries-exact'),exactRow=(await rows(exact)).find(x=>x.purpose==='Ongoing fixture');
 r=await req(exact,'/api/bookings/'+exactRow.id,'PATCH',{...exactRow,end:'10:30'});check('EARLY-END-EXACT','Early-end at exact current slot boundary is allowed',r.status===200&&r.data.booking.end==='10:30',{actual:r.status});
 r=await req(exact,'/api/bookings/'+exactRow.id,'DELETE',{owner:exactRow.owner});check('ENDED-EXACT','Booking ending exactly now cannot be deleted',r.status===400);
 const sso=await start('sso');r=await req(sso,'/api/bookings');check('C30','SSO anonymous API denied',r.status===401);
 check('CACHE-UNAUTHORIZED','Unauthenticated API errors disable cache',r.headers.get('cache-control')==='no-store');
 r=await req(sso,'/');check('C31','SSO anonymous UI redirects to login',r.status===302&&r.headers.get('location').startsWith('/auth/login'));
 const a=await login(sso,'alice'),b=await login(sso,'bob');check('C32','Mock OIDC yields local session',a.response.status===302&&!!a.cookie);
 r=await req(sso,'/api/me','GET',undefined,a.cookie);check('C33','Session identity',r.status===200&&r.data.user.email==='alice@example.invalid');
 r=await create(sso,{owner:'Forged name',ownerId:'fixture-bob',ownerEmail:'bob@example.invalid'},a.cookie);const aid=idOf(r);
 check('C34','SSO ignores supplied ownership',r.status===201&&r.data.created[0].owner==='QA Alice'&&r.data.created[0].isMine===true);
 const ownBefore=JSON.stringify((await rows(sso,a.cookie)).find(x=>x.id===aid));
 const spoof=await login(sso,'spoof');
 for(const [who,session]of[['bob',b],['same-email-different-oid',spoof]]){
  r=await req(sso,'/api/bookings/'+aid,'DELETE',{owner:'QA Alice',ownerEmail:'alice@example.invalid',ownerId:'fixture-alice'},session.cookie);check('OWNER-DELETE-'+who,'Other immutable identity cannot delete: '+who,r.status===403);
  r=await req(sso,'/api/bookings/'+aid,'PATCH',{...valid,start:'10:00',end:'11:00',ownerEmail:'alice@example.invalid',ownerId:'fixture-alice'},session.cookie);check('OWNER-PATCH-'+who,'Other immutable identity cannot patch: '+who,r.status===403);
  check('OWNER-MARK-'+who,'isMine rejects other immutable identity: '+who,(await rows(sso,session.cookie)).find(x=>x.id===aid)?.isMine===false);
 }
 check('OWNER-UNCHANGED','Rejected mutations leave booking unchanged',JSON.stringify((await rows(sso,a.cookie)).find(x=>x.id===aid))===ownBefore);
 const same=await login(sso,'same'),legacy=(await rows(sso,same.cookie)).find(x=>x.purpose==='Legacy ownership fixture');
 for(const method of ['DELETE','PATCH']){
  r=await req(sso,'/api/bookings/'+legacy.id,method,method==='DELETE'?{}:{...legacy,start:'15:00',end:'16:00'},same.cookie);
  check('B06-'+method,'Namesake cannot mutate unrelated name-only legacy booking: '+method,r.status===403);
 }
 check('LEGACY-MARK','Name-only legacy booking isMine false',legacy.isMine===false);
 const oldEmail=(await rows(sso,a.cookie)).find(x=>x.purpose==='Legacy email ownership fixture');
 r=await req(sso,'/api/bookings/'+oldEmail.id,'PATCH',{...oldEmail,purpose:'Legacy email updated'},a.cookie);check('LEGACY-EMAIL','Legacy row with recorded email retains email ownership',r.status===200&&oldEmail.isMine===true);
 for(const code of ['renamed','emailChanged']){
  const who=await login(sso,code);r=await req(sso,'/api/bookings/'+aid,'PATCH',{...valid,start:'14:00',end:'15:00'},who.cookie);
  check('B10-'+code,'Same oid retains ownership after '+code,r.status===200&&(await rows(sso,who.cookie)).find(x=>x.id===aid)?.isMine===true);
 }
 const aRows=await rows(sso,a.cookie);check('OWNER-PRIVATE','API does not expose immutable IDs or email ownership fields',aRows.every(x=>!('ownerId'in x)&&!('owner_id'in x)&&!('ownerEmail'in x)&&!('owner_email'in x)));
 const noOid=await login(sso,'noOid');check('AUTH-NO-OID','Missing immutable identity cannot create session',noOid.response.status===401&&!noOid.cookie);
 const payload='<img src=x onerror="window.__qa_xss=1">';
 for(const stateKind of ['valid','missing','wrong']){
  const st=await loginStart(sso);const query=stateKind==='missing'?'':('&state='+encodeURIComponent(stateKind==='valid'?st.state:'wrong'));
  r=await req(sso,'/auth/callback?error=denied&error_description='+encodeURIComponent(payload)+query,'GET',undefined,st.cookie);
  check('B07-'+stateKind,'Provider error with '+stateKind+' state is safe',r.status===401&&!r.text.includes(payload)&&!r.headers.getSetCookie().some(x=>x.startsWith('bdo-session=')));
 }
 r=(await login(sso,'token_error')).response;check('AUTH-TOKEN-ERROR','Token-exchange error is HTML-escaped',r.status===401&&!r.text.includes(payload));
 for(const [n,returnTo,safe]of [['backslash','/\\example.invalid',false],['double-slash','//example.invalid',false],['absolute','https://example.invalid/',false],['crlf','/\r\nX-Evil: true',false],['normalized-parent','/..//example.invalid',false],['normalized-deep','/a/..//example.invalid',false],['normalized-encoded','/%2e%2e//example.invalid',false],['local','/rooms?floor=2',true]]){
  const redir=await login(sso,'alice',returnTo),loc=redir.response.headers.get('location');
  check('B08-'+n,'Return target remains local: '+n,redir.response.status===302&&new URL(loc,sso.base).origin===sso.base&&(!safe||loc===returnTo),{location:loc});
 }
 r=await req(sso,'/api/me','GET',undefined,'bdo-session=%ZZ');check('B09','Malformed cookie is unauthenticated',r.status===401);
 r=await req(sso,'/auth/logout','GET',undefined,a.cookie);const again=await req(sso,'/api/me','GET',undefined,a.cookie);check('C37','Logout invalidates session',r.status===302&&again.status===401);
 for(const kind of ['wrong','tampered']){
  const st=await loginStart(sso),cookie=kind==='tampered'?st.cookie.slice(0,-1)+(st.cookie.endsWith('a')?'b':'a'):st.cookie;
  r=await req(sso,'/auth/callback?state=wrong&code=alice','GET',undefined,cookie);check('C38-'+kind,'Invalid auth state rejected: '+kind,r.status===401&&!r.headers.getSetCookie().some(x=>x.startsWith('bdo-session=')));
 }
 const expState=await loginStart(sso),rawCookie=decodeURIComponent(expState.cookie.split('=').slice(1).join('=')),box=JSON.parse(Buffer.from(rawCookie.split('.')[0],'base64url').toString('utf8'));
 box.expiresAt=Date.parse('2026-10-08T01:15:00Z')-1;
 const expBox=Buffer.from(JSON.stringify(box)).toString('base64url'),expSign=crypto.createHmac('sha256','qa-only-secret-not-for-production').update(expBox).digest('base64url');
 r=await req(sso,'/auth/callback?state='+encodeURIComponent(expState.state)+'&code=alice','GET',undefined,'bdo-auth-state='+encodeURIComponent(expBox+'.'+expSign));
 check('AUTH-EXPIRED-STATE','Validly signed expired state is rejected',r.status===401&&!r.headers.getSetCookie().some(x=>x.startsWith('bdo-session=')));
 const count=(await rows(anon)).length,exit=new Promise(r=>anon.c.once('exit',r));anon.c.kill();await exit;
 const dbScript="const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify({count:d.prepare('select count(*) n from bookings').get().n,integrity:d.prepare('pragma integrity_check').get().integrity_check,columns:d.prepare('select name from pragma_table_info(\\'bookings\\')').all().map(x=>x.name)}));";
 const d=JSON.parse(execFileSync(process.execPath,['-e',dbScript,resolve(anon.data,'bookings.sqlite')],{encoding:'utf8',windowsHide:true}));
 check('C40','SQLite survives stop and integrity_check with new columns',d.count===count&&d.integrity==='ok'&&d.columns.includes('owner_id')&&d.columns.includes('series_id'),d);
}catch(e){check('HARNESS','Harness completion',false,{error:String(e),stack:e.stack});}
finally{
 for(const c of children)if(c.exitCode===null)c.kill();
 for(const s of servers)writeFileSync(resolve(runs,s.mode+'-server.log'),s.log());
 const summary={testedAt:new Date().toISOString(),appClock:'2026-10-08T10:15:00+09:00',isolation:'Loopback only; synthetic SQLite; OIDC response mocked; no real Microsoft network',counts:{total:results.length,pass:results.filter(x=>x.status==='PASS').length,fail:results.filter(x=>x.status==='FAIL').length},results};
 writeFileSync(resolve(runs,'api-results.json'),JSON.stringify(summary,null,2));writeFileSync(resolve(root,'evidence','fixed-api-results.json'),JSON.stringify(summary,null,2));
 console.log('SUMMARY '+JSON.stringify(summary.counts));console.log('EVIDENCE '+runs);process.exitCode=summary.counts.fail?1:0;
}


