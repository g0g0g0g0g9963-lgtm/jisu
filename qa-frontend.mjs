import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),appRoot=root;
const ts=createRequire(path.join(appRoot,'package.json'))('typescript'),cache=new Map(),results=[];
function check(id,title,good,details={}){const r={id,title,status:good?'PASS':'FAIL',...details};results.push(r);console.log(JSON.stringify(r));}
function load(file){
 const p=path.resolve(file);if(cache.has(p))return cache.get(p).exports;if(p.endsWith('.json'))return JSON.parse(fs.readFileSync(p,'utf8'));
 const m={exports:{}};cache.set(p,m);
 const js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},fileName:p}).outputText;
 const req=s=>{if(!s.startsWith('.'))throw Error(s);const b=path.resolve(path.dirname(p),s);return load([b,b+'.ts',b+'.json'].find(x=>fs.existsSync(x)));};
 vm.runInNewContext('(function(require,module,exports){'+js+'\n})',{console},{filename:p})(req,m,m.exports);return m.exports;
}
const lib=load(path.join(appRoot,'app/lib/bookings.ts')),dt=load(path.join(appRoot,'app/lib/datetime.ts'));
const src=fs.readFileSync(path.join(appRoot,'app/page.tsx'),'utf8'),ast=ts.createSourceFile('page.tsx',src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),initializers=new Map();let disabled;
function walk(n){
 if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer)initializers.set(n.name.text,n.initializer.getText(ast));
 if(ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n)){const a=n.attributes.properties.filter(ts.isJsxAttribute),id=a.find(x=>x.name.getText(ast)==='id');if(id?.initializer&&ts.isStringLiteral(id.initializer)&&id.initializer.text==='reserve-button')disabled=a.find(x=>x.name.getText(ast)==='disabled').initializer.expression.getText(ast);}
 ts.forEachChild(n,walk);
}walk(ast);
function fn(name,c){if(!initializers.has(name))throw Error('Missing original source initializer: '+name);vm.runInContext(ts.transpileModule('globalThis.__fn = '+initializers.get(name)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);return c.__fn;}
const plain=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x)),equal=(a,b)=>JSON.stringify(plain(a))===JSON.stringify(b);
function context(overrides={}){
 const c={authReady:true,mutationBusy:false,submitting:false,selectedTimeConflict:false,timeNeedsPick:false,REQUIRED_FIELDS:[{key:'owner',id:'owner-input',value:'QA User'},{key:'team',id:'team-input',value:'QA Team'}],officeTeams:[{name:'QA Team'}],owner:'QA User',myBookingOwner:'QA User',currentUser:null,team:'QA Team',purpose:'QA',attendees:[],selected:{id:'qa-room',name:'QA room'},start:'10:00',end:'11:00',today:'2026-10-08',date:'2026-10-12',nowMinutes:615,reservationDates:['2026-10-12'],conflictDates:[],bookingDefaults:lib.bookingDefaults,minutesOf:dt.minutesOf,formatDateLabel:dt.formatDateLabel,formatMinutes:dt.formatMinutes,addMinutes:dt.addMinutes,findConflictingDates:lib.findConflictingDates,bookings:[],startTimeOptions:['10:00','11:00','12:00'],lastSelectableTime:'18:00',allDay:false,draftKey:'original-draft',latestDraftKey:{current:'original-draft'},slot:{date:'2026-10-12',start:'10:00',end:'11:00'},roomById:()=>({name:'QA room'}),useCallback:f=>f,useMemo:f=>f(),document:{getElementById:()=>({focus(){}}),querySelector:()=>({scrollTo(){}})},window:{requestAnimationFrame:f=>f()},...overrides};
 c.state={};c.calls={refresh:0,post:0,patch:0,delete:0};
 c.refreshBookings=overrides.refreshBookings??(async()=>{c.calls.refresh++;});
 for(const f of ['Notice','MissingField','TeamOpen','RepeatAsk','SubmitPreviewDates','SelectedId','DraftActive','BookingPanelOpen','RoomPickerOpen','TimeNeedsPick','EditBusy','EarlyEndBusy','CancelBusy','Submitting','CancelSelection','SyncError','Toast','EditDraft','EditNotice','EarlyEndNotice','EarlyEnd','EditConfirmDelete','MyBookingOwner','Purpose','Attendees','AttendeeDraft','Slot','Date']){
  const key=f[0].toLowerCase()+f.slice(1);
  c['set'+f]=v=>{c.state[key]=typeof v==='function'?v(c.state[key]??c[key]):v;};
 }
 return vm.createContext(c);
}
const one={id:'independent-A',roomId:'qa-room',date:'2026-10-12',start:'10:00',end:'11:00',owner:'QA User',team:'QA Team',purpose:'QA'},two={...one,id:'independent-B',date:'2026-11-23'};
try{
 check('F01','Weekdays-only weekend interval is empty',lib.expandRepeatDates('2026-10-10','2026-10-11','weekdays').length===0);
 check('FC01','Weekdays include following Monday',equal(lib.expandRepeatDates('2026-10-10','2026-10-12','weekdays'),['2026-10-12']));
 check('FC-HOLIDAY','Weekdays exclude configured public holiday',lib.expandRepeatDates('2026-10-09','2026-10-09','weekdays').length===0);
 check('FC-REVERSED','Repeat reversed interval is empty',lib.expandRepeatDates('2026-10-12','2026-10-10','everyday').length===0);
 let c=context({upcomingMyBookings:[one,two]});
 check('F02','Matching independent bookings remain separate',equal(fn('sameSeriesIds',c)(one),[one.id]));
 const a={...one,seriesId:'series-a'},b={...two,seriesId:'series-a',start:'13:00',end:'14:00',purpose:'Changed purpose'},other={...one,id:'other-series',seriesId:'series-b'};
 c=context({upcomingMyBookings:[a,b,other]});
 check('SERIES-POSITIVE','True series siblings stay grouped after a member edit',equal(fn('sameSeriesIds',c)(a),[a.id,b.id]));
 for(const [id,booking,overrides,want]of [
  ['server-true',{...one,owner:'Previous name',isMine:true},{currentUser:{name:'Renamed'},myBookingOwner:''},true],
  ['server-false',{...one,isMine:false},{currentUser:{name:'QA User'}},false],
  ['sso-no-field',one,{currentUser:{name:'QA User'}},false],
  ['anonymous',one,{},true],
  ['not-ready',{...one,isMine:true},{authReady:false},false],
 ]){
  c=context(overrides);check('OWN-'+id,'Ownership guard: '+id,fn('isMyBooking',c)(booking)===want);
 }
 c=context();const ended=fn('hasEnded',c);
 check('ENDED-SAME-DAY','Same-day elapsed reservation is ended',ended({...one,date:'2026-10-08',end:'10:00'}));
 check('ENDED-BOUNDARY','Booking ending exactly now is ended',ended({...one,date:'2026-10-08',end:'10:15'}));
 check('ENDED-ONGOING','Ongoing reservation is not ended',!ended({...one,date:'2026-10-08',end:'11:00'}));
 const dates=['2026-10-12','2026-10-13'],clashes=lib.findConflictingDates([one],'qa-room',dates,'10:00','11:00');
 c=context({reservationDates:dates,conflictDates:clashes,selectedTimeConflict:true});
 await fn('submitReservation',c)({preventDefault(){}});
 check('F03','Partial repeat reaches exact free-date confirmation',!vm.runInContext(disabled,c)&&equal(c.state.repeatAsk?.free,['2026-10-13'])&&equal(c.state.repeatAsk?.conflicts,['2026-10-12']));
 c=context({reservationDates:[],conflictDates:[]});await fn('submitReservation',c)({preventDefault(){}});
 check('EMPTY-REPEAT','Empty repeated dates cannot reach confirmation',!c.state.submitPreviewDates&&!c.state.repeatAsk&&!!c.state.notice);
 c=context();fn('askWeekdaySlot',c)({id:'qa-room'},'2026-10-13');
 const weekly=context({...c,timeNeedsPick:c.state.timeNeedsPick,date:c.state.date,reservationDates:[c.state.date]});
 await fn('submitReservation',weekly)({preventDefault(){}});
 check('F04','Weekly booking requires explicit time selection',weekly.timeNeedsPick===true&&!weekly.state.submitPreviewDates&&!!weekly.state.notice);
 c=context({date:'2026-10-08',reservationDates:['2026-10-08'],start:'10:00'});await fn('submitReservation',c)({preventDefault(){}});
 check('SUBMIT-PAST-TODAY','Past start today cannot reach preview',!c.state.submitPreviewDates&&!!c.state.notice);
 c=context();await fn('submitReservation',c)({preventDefault(){}});
 check('SUBMIT-VALID','Valid future draft reaches preview',equal(c.state.submitPreviewDates,['2026-10-12']));
 for(const [id,overrides,want]of [
  ['all-free',{reservationDates:dates,slotIsFree:()=>true},true],
  ['later-conflict',{reservationDates:dates,slotIsFree:(_r,d)=>d!=='2026-10-13'},false],
  ['empty',{reservationDates:[],slotIsFree:()=>true},false],
  ['past-today',{reservationDates:['2026-10-08'],slotIsFree:()=>true},false],
 ]){
  c=context(overrides);check('ALTERNATIVE-'+id,'Room alternative covers all valid dates: '+id,fn('slotIsBookable',c)('qa-room','10:00','11:00')===want);
 }
 const handlers=[['sendBooking','submitting','notice',['2026-10-12'],'post'],['saveEdit','editBusy','editNotice',undefined,'patch'],['cancelBookings','cancelBusy','syncError',[one.id],'delete'],['confirmEarlyEnd','earlyEndBusy','earlyEndNotice',undefined,'patch'],['deleteEditing','editBusy','editNotice',undefined,'delete']];
 for(const [name,busy,notice,arg,request]of handlers){
  for(const mode of ['network','http','success']){
   c=context({editDraft:one,earlyEnd:one,earlyEndTime:()=> '10:30'});
   const dependency=async()=>{c.calls[request]++;if(mode==='network')throw new TypeError('Synthetic network loss');return mode==='http'?{ok:false,message:'Synthetic API rejection'}:{ok:true};};
   c.postBookings=c.patchBookingRequest=c.deleteBookingRequest=dependency;
   let error;try{await fn(name,c)(arg);}catch(e){error=String(e);}
   check('ASYNC-'+name+'-'+mode,'Mutation resolves busy state and reports result: '+name+'/'+mode,!error&&c.calls[request]===1&&c.state[busy]===false&&(mode==='success'?!!c.state.toast:!!c.state[notice]),{error,busy:c.state[busy],requestCalls:c.calls[request],hasNotice:!!c.state[notice]});
  }
  c=context({editDraft:one,earlyEnd:one,mutationBusy:true,earlyEndTime:()=> '10:30'});
  c.postBookings=c.patchBookingRequest=c.deleteBookingRequest=async()=>{c.calls[request]++;return{ok:true};};
  await fn(name,c)(arg);check('BUSY-'+name,'Busy mutation does not dispatch again: '+name,c.calls[request]===0);
 }
 c=context({editDraft:one,earlyEnd:one});const deleteIds=[];
 c.deleteBookingRequest=async id=>{deleteIds.push(id);if(id==='network')throw Error('offline');return id==='ok'?{ok:true}:{ok:false,message:'API refused'};};
 await fn('cancelBookings',c)(['ok','http','network','ok']);
 check('CANCEL-PARTIAL','Batch cancellation deduplicates and preserves only failed IDs',equal(deleteIds,['ok','http','network'])&&equal(c.state.cancelSelection,['http','network'])&&c.state.cancelBusy===false&&!!c.state.syncError&&!c.state.toast);
 c=context({purpose:'A new draft',attendees:['New attendee']});c.postBookings=async()=>{c.latestDraftKey.current='changed-draft';return{ok:true};};
 await fn('sendBooking',c)(['2026-10-12']);
 check('DRAFT-PRESERVE','Completed request does not erase a newer draft',!('purpose'in c.state)&&!('attendees'in c.state)&&!('slot'in c.state)&&c.state.submitting===false);
 c=context();c.postBookings=async()=>{c.calls.post++;return{ok:true};};await fn('sendBooking',c)([]);
 check('SEND-EMPTY','Direct empty-date send is blocked',c.calls.post===0);
 c=context({authReady:false});c.postBookings=async()=>{c.calls.post++;return{ok:true};};await fn('sendBooking',c)(['2026-10-12']);
 check('AUTH-NOT-READY','Unknown authentication blocks creation and disables button',c.calls.post===0&&vm.runInContext(disabled,c)===true);
 c=context({nowMinutes:630});check('EARLY-END-BOUNDARY','Exact slot early-end uses current boundary',fn('earlyEndTime',c)({...one,date:'2026-10-08',start:'09:00',end:'11:00'})==='10:30');
}catch(e){check('FRONTEND-HARNESS','Frontend harness completion',false,{error:String(e),stack:e.stack});}
const out={testedAt:new Date().toISOString(),method:'Actual TypeScript AST handlers executed in isolated VM; state setters captured separately to preserve React closure semantics; not browser end-to-end',counts:{total:results.length,pass:results.filter(x=>x.status==='PASS').length,fail:results.filter(x=>x.status==='FAIL').length},results};
fs.mkdirSync(path.join(root,'evidence'),{recursive:true});fs.writeFileSync(path.join(root,'evidence','fixed-frontend-results.json'),JSON.stringify(out,null,2));console.log('SUMMARY '+JSON.stringify(out.counts));process.exitCode=out.counts.fail?1:0;

