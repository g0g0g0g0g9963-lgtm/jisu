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
const lib=load(path.join(appRoot,'app/lib/bookings.ts')),dt=load(path.join(appRoot,'app/lib/datetime.ts')),roomLib=load(path.join(appRoot,'app/lib/rooms.ts'));
const src=fs.readFileSync(process.env.QA_PAGE_SOURCE || path.join(appRoot,'app/page.tsx'),'utf8'),ast=ts.createSourceFile('page.tsx',src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),initializers=new Map(),jsxNodes=[];let disabled;
function walk(n){
 if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer)initializers.set(n.name.text,n.initializer.getText(ast));
 if(ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n)){jsxNodes.push(n);const a=n.attributes.properties.filter(ts.isJsxAttribute),id=a.find(x=>x.name.getText(ast)==='id');if(id?.initializer&&ts.isStringLiteral(id.initializer)&&id.initializer.text==='reserve-button')disabled=a.find(x=>x.name.getText(ast)==='disabled').initializer.expression.getText(ast);}
 ts.forEachChild(n,walk);
}walk(ast);
function fn(name,c){if(!initializers.has(name))throw Error('Missing original source initializer: '+name);vm.runInContext(ts.transpileModule('globalThis.__fn = '+initializers.get(name)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);return c.__fn;}
const plain=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x)),equal=(a,b)=>JSON.stringify(plain(a))===JSON.stringify(b);
const attr=(node,name)=>node.attributes.properties.find(item=>ts.isJsxAttribute(item)&&item.name.getText(ast)===name);
const hasClass=(node,name)=>attr(node,'className')?.initializer?.getText(ast).includes(name);
const nodesForClass=name=>jsxNodes.filter(node=>hasClass(node,name));
const nodeContent=node=>node.parent.getText(ast);
function context(overrides={}){
 const c={authReady:true,mutationBusy:false,submitting:false,selectedTimeConflict:false,timeNeedsPick:false,REQUIRED_FIELDS:[{key:'owner',id:'owner-input',value:'QA User'},{key:'team',id:'team-input',value:'QA Team'}],officeTeams:[{name:'QA Team'}],owner:'QA User',myBookingOwner:'QA User',currentUser:null,team:'QA Team',purpose:'QA',attendees:[],selected:{id:'qa-room',name:'QA room'},start:'10:00',end:'11:00',today:'2026-10-08',date:'2026-10-12',nowMinutes:615,reservationDates:['2026-10-12'],conflictDates:[],bookingDefaults:lib.bookingDefaults,minutesOf:dt.minutesOf,formatDateLabel:dt.formatDateLabel,formatMinutes:dt.formatMinutes,addMinutes:dt.addMinutes,findConflictingDates:lib.findConflictingDates,bookings:[],startTimeOptions:['10:00','11:00','12:00'],lastSelectableTime:lib.bookingDefaults.closingTime,allDay:false,draftKey:'original-draft',latestDraftKey:{current:'original-draft'},slot:{date:'2026-10-12',start:'10:00',end:'11:00'},roomById:()=>({name:'QA room'}),useCallback:f=>f,useMemo:f=>f(),document:{getElementById:()=>({focus(){}}),querySelector:()=>({scrollTo(){}})},window:{requestAnimationFrame:f=>f()},...overrides};
 Object.assign(c,{bookingBlockReason:'',syncError:'',selectedId:'qa-room',keyboardSelection:null,timePickerOpen:null,selectionFeedback:'',bookingRecovery:null,checkingBookingResult:false,refreshSeq:{current:0},earlyEndDisplayTime:'10:30',officeMinutesOfDay:()=>615,todayKey:()=> '2026-10-12',describeRoomSlotAvailability:roomLib.describeRoomSlotAvailability,formatCapacity:roomLib.formatCapacity,...overrides});
 c.selected={floor:9,...c.selected};
 c.attendeeAccounts=overrides.attendeeAccounts??[];
 c.setAttendeeAccounts=value=>{c.state.attendeeAccounts=value;c.attendeeAccounts=value;};
 if(!overrides.roomById)c.roomById=()=>({id:'qa-room',floor:9,name:'QA room'});
 c.state={};c.calls={refresh:0,post:0,patch:0,delete:0,focus:0,flash:0};
 if(!overrides.document)c.document={activeElement:null,getElementById:id=>({focus(){c.calls.focus++;c.state.focusedId=id;}}),querySelector:()=>({scrollTo(){}})};
 vm.createContext(c);
 c.roomIdentity=fn('roomIdentity',c);c.spokenDuration=fn('spokenDuration',c);
 c.flashFilled=(title,detail)=>{c.calls.flash++;c.state.filledNotice={title,detail};};
 c.applySlotSelection=selection=>fn('applySlotSelection',c)(selection);
 c.refreshBookings=overrides.refreshBookings??(async()=>{c.calls.refresh++;});
 for(const f of ['Notice','MissingField','TeamOpen','RepeatAsk','SubmitPreviewDates','SelectedId','DraftActive','BookingPanelOpen','RoomPickerOpen','TimeNeedsPick','EditBusy','EarlyEndBusy','CancelBusy','Submitting','CancelSelection','SyncError','Toast','EditDraft','EditNotice','EarlyEndNotice','EarlyEnd','EditConfirmDelete','MyBookingOwner','Purpose','Attendees','AttendeeDraft','Slot','Date','AllDay','Duration','KeyboardSelection','SelectionFeedback','TimePickerOpen','BookingRecovery','CheckingBookingResult','Bookings','MyBookingsOpen','EarlyEndReviewTime']){
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
 c=context({bookingBlockReason:'Synthetic invalid slot'});await fn('submitReservation',c)({preventDefault(){}});
 check('UX-SUBMIT-EARLY-BLOCK','Known invalid slot is blocked before confirmation and disables CTA',!c.state.submitPreviewDates&&c.state.notice==='Synthetic invalid slot'&&vm.runInContext(disabled,c)===true);
 c=context();fn('askWeekdaySlot',c)({id:'qa-room',floor:9,name:'QA room'},'2026-10-07');
 check('UX-WEEK-PAST','Past weekly date does not open a booking draft',!c.state.bookingPanelOpen&&!c.state.draftActive&&!!c.state.selectionFeedback);
 c=context({nowMinutes:dt.minutesOf(lib.bookingDefaults.closingTime)});fn('askWeekdaySlot',c)({id:'qa-room',floor:9,name:'QA room'},c.today);
 check('UX-WEEK-CLOSED','Closed same-day weekly date does not open a booking draft',!c.state.bookingPanelOpen&&!c.state.draftActive&&!!c.state.selectionFeedback);
 const timelineRoom={id:'qa-room',floor:9,name:'QA room'},timelineTarget={},timelineEvent=key=>({key,target:timelineTarget,currentTarget:timelineTarget,preventDefault(){}});
 c=context();fn('handleTimelineKey',c)(timelineRoom,c.date,timelineEvent('ArrowDown'));
 check('UX-KEYBOARD-PREVIEW','Arrow moves only the timeline preview without committing or changing focus',c.state.keyboardSelection?.start==='10:30'&&!c.state.slot&&!c.state.bookingPanelOpen&&c.calls.focus===0&&c.calls.flash===0);
 c.keyboardSelection=c.state.keyboardSelection;fn('handleTimelineKey',c)(timelineRoom,c.date,timelineEvent('ArrowDown'));
 check('UX-KEYBOARD-REPEAT','A second arrow continues from the existing preview',c.state.keyboardSelection?.start==='11:00'&&c.calls.flash===0);
 c.keyboardSelection=c.state.keyboardSelection;fn('handleTimelineKey',c)(timelineRoom,c.date,timelineEvent('Enter'));
 check('UX-KEYBOARD-COMMIT','Enter commits the preview and opens the booking panel once',c.state.slot?.start==='11:00'&&c.state.slot?.end==='12:00'&&c.state.bookingPanelOpen===true&&c.state.keyboardSelection===null&&c.calls.flash===1);
 c=context({keyboardSelection:{roomId:'qa-room',date:'2026-10-12',start:'11:00',end:'12:00'}});fn('handleTimelineKey',c)(timelineRoom,c.date,timelineEvent('Escape'));
 check('UX-KEYBOARD-ESCAPE','Escape clears only the preview without opening or erasing a form draft',c.state.keyboardSelection===null&&!c.state.slot&&!c.state.bookingPanelOpen&&c.calls.focus===0);
 c=context();fn('handleTimelineKey',c)(timelineRoom,c.date,{...timelineEvent('Enter'),target:{}});
 check('UX-KEYBOARD-CHILD','Reservation-button key events do not also select a parent timeline slot',Object.keys(c.state).length===0&&c.calls.flash===0);
 c=context();c.applySlotSelection({roomId:'qa-room',date:'2026-10-07',start:'10:00',end:'11:00'});
 check('UX-SLOT-PAST','Past daily selection stays blocked without the removed timeline notice',!c.state.slot&&!c.state.bookingPanelOpen&&c.state.selectionFeedback==='');
 c=context({bookings:[one]});c.applySlotSelection({roomId:'qa-room',date:'2026-10-12',start:'10:30',end:'11:30'});
 check('UX-SLOT-CONFLICT','Conflicting daily selection gives feedback without replacing the form draft',!c.state.slot&&!c.state.bookingPanelOpen&&!!c.state.selectionFeedback);
 c=context();check('UX-FLOOR-IDENTITY','Same-name rooms retain distinct floor information',fn('roomIdentity',c)({floor:9,name:'Conference Room 1'})==='9층 · Conference Room 1'&&fn('roomIdentity',c)({floor:12,name:'Conference Room 1'})==='12층 · Conference Room 1');
 for(const [name,expression]of [['reserve-button-room','roomIdentity(selected)'],['booking-confirm-summary','roomIdentity(selected)'],['my-booking-room','roomIdentity(roomById(booking.roomId))']]){
  const nodes=nodesForClass(name);check('UX-FLOOR-MARKUP-'+name,'Floor-aware room identity is rendered in '+name,nodes.length>0&&nodes.some(node=>nodeContent(node).includes(expression)));
 }
 const weeklyEvents=nodesForClass('weekly-room-event');
 check('UX-WEEK-LIST','Weekly bookings are normal-flow list items, not overlapping absolute-time rectangles',nodesForClass('weekly-booking-list').length===1&&weeklyEvents.length===1&&!attr(weeklyEvents[0],'style'));
 check('UX-WEEK-CONTENT','Every weekly booking retains owner, end time, and department',weeklyEvents.length===1&&['booking.owner','booking.end','teamOf(booking)'].every(text=>nodeContent(weeklyEvents[0]).includes(text)));
 const pickerOptions=[0,1,2].map(index=>({focus(){c.document.activeElement=this;c.state.pickerFocusedIndex=index;},scrollIntoView(){}}));
 c=context({timePickerOpen:'start'});c.document.activeElement=pickerOptions[0];c.closeTimePicker=()=>fn('closeTimePicker',c)();
 const pickerEvent=key=>({key,currentTarget:{querySelectorAll:()=>pickerOptions},preventDefault(){},stopPropagation(){}});
 fn('handleTimePickerKey',c)(pickerEvent('ArrowDown'));check('UX-TIME-ARROW','Time listbox ArrowDown focuses the next option',c.state.pickerFocusedIndex===1);
 fn('handleTimePickerKey',c)(pickerEvent('End'));check('UX-TIME-END','Time listbox End focuses the final option',c.state.pickerFocusedIndex===2);
 fn('handleTimePickerKey',c)(pickerEvent('Home'));check('UX-TIME-HOME','Time listbox Home focuses the first option',c.state.pickerFocusedIndex===0);
 fn('handleTimePickerKey',c)(pickerEvent('Escape'));check('UX-TIME-ESCAPE','Time listbox Escape closes and restores trigger focus',c.state.timePickerOpen===null&&c.state.focusedId==='start-time-select');
 c=context({selectionAvailability:{status:'conflict',nextLabel:'Synthetic overlap'},selectedTimeConflict:true,reservationDates:['2026-10-12','2026-10-13'],conflictDates:['2026-10-12']});
 check('UX-REPEAT-PARTIAL-BLOCK','Partial repeat conflicts do not block the free-date confirmation path',fn('bookingBlockReason',c)==='');
 c=context({selectionAvailability:{status:'conflict',nextLabel:'Synthetic overlap'},selectedTimeConflict:true,reservationDates:['2026-10-12'],conflictDates:['2026-10-12']});
 check('UX-REPEAT-ALL-BLOCK','All-date repeat conflict has an immediate blocking reason',Boolean(fn('bookingBlockReason',c)));
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
 for(const [id,overrides,date]of [['expired',{today:'2026-10-12',date:'2026-10-12',nowMinutes:615},'2026-10-12'],['new-conflict',{bookings:[one]},'2026-10-12'],['disconnected',{syncError:'Synthetic offline'},'2026-10-12']]){
  c=context(overrides);c.postBookings=async()=>{c.calls.post++;return{ok:true};};await fn('sendBooking',c)([date]);
  check('UX-SEND-RECHECK-'+id,'Final send rechecks the slot before dispatch: '+id,c.calls.post===0&&!!c.state.notice&&c.state.submitPreviewDates===null);
 }
 c=context({nowMinutes:630});check('EARLY-END-BOUNDARY','Exact slot early-end uses current boundary',fn('earlyEndTime',c)({...one,date:'2026-10-08',start:'09:00',end:'11:00'})==='10:30');
 c=context({earlyEnd:one,earlyEndDisplayTime:'10:30',earlyEndTime:()=> '11:00'});c.patchBookingRequest=async()=>{c.calls.patch++;return{ok:true};};await fn('confirmEarlyEnd',c)();
 check('EARLY-END-NO-TIME','No remaining reducible time is not submitted',c.calls.patch===0&&!!c.state.earlyEndNotice);
 c=context({earlyEnd:{...one,end:'12:00'},earlyEndDisplayTime:'10:30',earlyEndTime:()=> '11:00'});c.patchBookingRequest=async()=>{c.calls.patch++;return{ok:true};};await fn('confirmEarlyEnd',c)();
 check('EARLY-END-RECONFIRM','Changed boundary requires explicit review before save',c.calls.patch===0&&c.state.earlyEndReviewTime==='11:00'&&c.state.earlyEndNotice.includes('11:00'));
 c=context({earlyEnd:one,earlyEndTime:()=> '10:30'});c.patchBookingRequest=async()=>({ok:true,booking:{...one,end:'10:30'}});await fn('confirmEarlyEnd',c)();
 check('EARLY-END-ACTUAL','Completion uses the server-confirmed end time',c.state.toast?.text==='회의가 단축되었습니다.'&&c.state.toast?.time==='10:30부터 예약 가능');
 const recovery={owner:'QA User',roomId:'qa-room',dates:['2026-10-12'],start:'10:00',end:'11:00',timedOut:true};
 c=context();c.postBookings=async()=>{c.calls.post++;throw vm.runInContext("Object.assign(new Error('Timed out'),{name:'TimeoutError'})",c);};await fn('sendBooking',c)(['2026-10-12']);
 check('RECOVERY-SNAPSHOT','Unknown write result preserves a separate submitted snapshot and releases busy',c.calls.post===1&&c.state.submitting===false&&equal(c.state.bookingRecovery,recovery)&&!('purpose' in c.state));
 c=context({bookingRecovery:recovery});c.postBookings=async()=>{c.calls.post++;return{ok:true};};await fn('sendBooking',c)(recovery.dates);
 check('RECOVERY-NO-RESEND','Unknown result blocks another create until lookup',c.calls.post===0&&vm.runInContext(disabled,c)===true);
 c=context({bookingRecovery:recovery});let requestedRange;c.fetchBookings=async range=>{requestedRange=range;return[one];};await fn('checkBookingResult',c)();
 check('RECOVERY-LOOKUP','Result button only reads the submitted date range and opens my bookings',equal(requestedRange,{from:'2026-10-12',to:'2026-10-12'})&&c.state.myBookingsOpen===true&&c.state.bookingRecovery===null&&c.state.checkingBookingResult===false&&c.state.notice.includes('1건')&&c.calls.post===0);
 c=context({bookingRecovery:recovery,currentUser:{name:'QA User'}});c.fetchBookings=async()=>[{...one,isMine:false}];await fn('checkBookingResult',c)();
 check('RECOVERY-NAMESAKE','Namesake reservation is not reported as own success',c.state.notice.includes('내 예약이 없습니다')&&!c.state.notice.includes('1건'));
 c=context({bookingRecovery:recovery});c.fetchBookings=async()=>{throw Error('still offline');};await fn('checkBookingResult',c)();
 check('RECOVERY-RETRYABLE','Failed lookup preserves recovery and enables another read',!('bookingRecovery' in c.state)&&c.state.checkingBookingResult===false&&!!c.state.notice&&c.calls.post===0);
 c=context({bookingRecovery:recovery});c.fetchBookings=async()=>{c.refreshSeq.current++;return[one];};await fn('checkBookingResult',c)();
 check('RECOVERY-LATE-READ','Superseded lookup cannot overwrite newer list state',!('bookings' in c.state)&&!('bookingRecovery' in c.state)&&c.state.checkingBookingResult===false);
}catch(e){check('FRONTEND-HARNESS','Frontend harness completion',false,{error:String(e),stack:e.stack});}
const out={testedAt:new Date().toISOString(),method:'Actual TypeScript AST handlers executed in isolated VM; state setters captured separately to preserve React closure semantics; not browser end-to-end',counts:{total:results.length,pass:results.filter(x=>x.status==='PASS').length,fail:results.filter(x=>x.status==='FAIL').length},results};
fs.mkdirSync(path.join(root,'evidence'),{recursive:true});fs.writeFileSync(path.join(root,'evidence','fixed-frontend-results.json'),JSON.stringify(out,null,2));console.log('SUMMARY '+JSON.stringify(out.counts));process.exitCode=out.counts.fail?1:0;

