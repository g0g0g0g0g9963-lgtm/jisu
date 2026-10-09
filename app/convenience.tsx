import { useEffect, useRef, useState } from "react";
import { type CurrentUser, requestApi } from "./lib/api";
import type { Booking, Employee } from "./lib/bookings";
import { rooms, roomById } from "./lib/rooms";

export function useFavorites(user: CurrentUser | null, ready: boolean) {
  const [ids,setIds]=useState<string[]>([]), [pending,setPending]=useState<string[]>([]), [message,setMessage]=useState("");
  const [loaded,setLoaded]=useState(false);
  useEffect(()=>{
    let active=true; setIds([]); setLoaded(false); setMessage("");
    if (!ready) return;
    (async()=>{
      try {
        let values: unknown;
        if (user) {
          const {response,payload}=await requestApi<{roomIds:string[]}>("/api/favorites");
          if (!response.ok || !Array.isArray(payload?.roomIds)) throw Error();
          values=payload.roomIds;
        } else values=JSON.parse(localStorage.getItem("meeting-room-preview-favorites") || "[]");
        if(active) { setIds(Array.isArray(values)?values.filter(id=>rooms.some(r=>r.id===id)):[]);setLoaded(true); }
      } catch { if(active)setMessage("즐겨찾기를 불러오지 못했습니다. 새로고침해 주세요."); }
    })();
    return ()=>{active=false;};
  },[user?.email,ready]);
  async function toggle(id:string) {
    if(!loaded || pending.includes(id))return;
    const favorite=!ids.includes(id);setPending(p=>[...p,id]);setMessage("");
    try {
      if(user){
        const {response}=await requestApi(`/api/favorites/${encodeURIComponent(id)}`,{method:"PUT",headers:{"content-type":"application/json","x-booking-action":"1"},body:JSON.stringify({favorite})});
        if(!response.ok)throw Error();
      } else {
        const stored=JSON.parse(localStorage.getItem("meeting-room-preview-favorites")||"[]");
        const list=Array.isArray(stored)?stored.filter(x=>typeof x==="string"):[];
        localStorage.setItem("meeting-room-preview-favorites",JSON.stringify(favorite?[...new Set([...list,id])]:list.filter(x=>x!==id)));
      }
      setIds(list=>favorite?[...new Set([...list,id])]:list.filter(x=>x!==id));
    }catch{setMessage("즐겨찾기 저장 결과를 확인하지 못했습니다. 새로고침해 주세요.");setLoaded(false);}
    finally{setPending(p=>p.filter(x=>x!==id));}
  }
  return {ids,pending,message,loaded,toggle};
}
export function FavoriteButton({roomId,active,disabled,onClick}:{roomId:string;active:boolean;disabled:boolean;onClick:()=>void}) {
  const room=roomById(roomId), label=`${room?.floor}층 ${room?.name} 즐겨찾기 ${active?"해제":"추가"}`;
  return <button type="button" className={`room-favorite ${active?"is-favorite":""}`} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>
    <svg viewBox="0 0 24 24" fill={active?"currentColor":"none"} stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg>
  </button>;
}

export function EmployeePicker({value,onChange,limit}:{value:Employee[];onChange:(next:Employee[])=>void;limit:number}) {
  const [query,setQuery]=useState(""),[results,setResults]=useState<Employee[]>([]),[source,setSource]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[index,setIndex]=useState(-1);
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    let active=true;setResults([]);setIndex(-1);setMessage("");setSource("");
    if(!query.trim()){setBusy(false);return;}
    setBusy(true);
    const timer=setTimeout(async()=>{
      try {
        const {response,payload}=await requestApi<{employees:Employee[];source:string;error?:string}>(`/api/employees?q=${encodeURIComponent(query.trim())}`);
        if(!response.ok || !Array.isArray(payload?.employees))throw Error(payload?.error || "직원 검색을 다시 시도해 주세요.");
        if(active){setResults(payload.employees);setSource(payload.source);}
      }catch(error){if(active)setMessage(error instanceof Error?error.message:"검색 실패");}
      finally{if(active)setBusy(false);}
    },300);
    return()=>{active=false;clearTimeout(timer);};
  },[query]);
  const choices=results.filter(e=>!value.some(v=>v.id===e.id));
  function select(employee:Employee) {
    if(value.length>=limit){setMessage("참석자 최대 인원에 도달했습니다.");return;}
    onChange([...value,employee]);setQuery("");input.current?.focus();
  }
  return <section className="employee-picker" aria-label="직원 참석자 선택">
    <label htmlFor="employee-search" className="field-label">직원 참석자 <em>(선택)</em></label>
    <p className="convenience-hint">이름이 같으면 이메일을 확인해 선택하세요.</p>
    <div className="employee-chips">{value.map(e=><div className="employee-chip" key={e.id}><span><b>{e.name}</b><small>{e.email}</small></span><button type="button" aria-label={`${e.name} ${e.email} 선택 해제`} onClick={()=>onChange(value.filter(v=>v.id!==e.id))}>×</button></div>)}</div>
    <input ref={input} id="employee-search" role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={choices.length>0} aria-controls="employee-results" aria-activedescendant={index>=0?`employee-choice-${index}`:undefined} value={query} maxLength={100} placeholder="직원 이름 또는 이메일 검색" onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{
      if(e.nativeEvent.isComposing)return;
      if(e.key==="ArrowDown"){e.preventDefault();setIndex(i=>Math.min(i+1,choices.length-1));}
      if(e.key==="ArrowUp"){e.preventDefault();setIndex(i=>Math.max(0,i-1));}
      if(e.key==="Enter"){e.preventDefault();if(choices[index])select(choices[index]);}
      if(e.key==="Escape"){e.preventDefault();e.stopPropagation();setQuery("");}
    }}/>
    <div id="employee-results" role="listbox" aria-label="직원 검색 결과" className="employee-results">{choices.map((e,i)=><button key={e.id} id={`employee-choice-${i}`} type="button" role="option" aria-selected={i===index} onClick={()=>select(e)}><b>{e.name}</b><small>{e.email}</small></button>)}</div>
    <p className="convenience-hint" role="status">{busy?"직원을 찾는 중…":message || (query.trim() && !choices.length?"선택 가능한 검색 결과가 없습니다.":`${value.length}명 선택됨 · 초대 메일은 발송하지 않습니다.`)}</p>
    {source==="site" && <p className="convenience-hint">현재는 사이트에 로그인한 직원만 검색됩니다. 회사 전체 검색은 아래 Microsoft 연결 후 사용할 수 있습니다.</p>}
  </section>;
}

type CalendarStatus = {configured:boolean;connected:boolean;reminderMinutes:number;pendingCount:number;jobs:{bookingId:string;cancelled:boolean;status:string;error:string}[]};
export function MicrosoftPanel({bookings}:{bookings:Booking[]}) {
  const [state,setState]=useState<CalendarStatus|null>(null),[error,setError]=useState(""),[retrying,setRetrying]=useState(false),[revision,setRevision]=useState(0);
  const refreshKey=bookings.map(b=>`${b.id}:${b.date}:${b.start}:${b.end}:${b.purpose}`).join("|");
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>;
    async function refresh(){
      if(document.hidden){timer=setTimeout(()=>void refresh(),30000);return;}
      let delay=30000;
      try{const {response,payload}=await requestApi<CalendarStatus>("/api/microsoft/status");if(!response.ok||!payload)throw Error();delay=payload.connected&&payload.pendingCount?5000:30000;if(active){setState(payload);setError("");}}
      catch{if(active)setError("Outlook 반영 상태를 확인하지 못했습니다.");}
      finally{if(active)timer=setTimeout(()=>void refresh(),delay);}
    }
    void refresh();return()=>{active=false;clearTimeout(timer);};
  },[refreshKey,revision]);
  async function disconnect(){
    if(!window.confirm("Microsoft 연결을 해제할까요? 기존 Outlook 일정은 유지되며, 이후 예약 변경·취소는 재연결 전까지 Outlook에 반영되지 않습니다. 진행 중인 작업은 완료될 수 있습니다."))return;
    try{const {response}=await requestApi("/api/microsoft/disconnect",{method:"POST",headers:{"content-type":"application/json","x-booking-action":"1"},body:"{}"});if(!response.ok)throw Error();setRevision(v=>v+1);}catch{setError("연결 해제 결과를 확인하지 못했습니다. 새로고침해 주세요.");}
  }
  async function retry(){setRetrying(true);try{const {response}=await requestApi("/api/microsoft/retry",{method:"POST",headers:{"content-type":"application/json","x-booking-action":"1"},body:"{}"});if(!response.ok)throw Error();setError("다시 반영 요청했습니다. 예약은 새로 만들지 않습니다.");}catch{setError("Microsoft 연결 상태를 확인한 뒤 다시 시도해 주세요.");}finally{setRetrying(false);}}
  const problems=state?.jobs.filter(j=>j.status!=="synced")||[];
  return <section className={`microsoft-panel ${state?.connected?"connected":""}`} aria-label="Outlook 일정 연결">
    <div className="microsoft-panel-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5 3 3 5-5"/></svg><strong>Outlook 자동 일정</strong><span>{state?.connected?"연결됨":state?"연결 필요":"확인 중"}</span></div>
    <p>{state?.connected?`예약 후 본인 일정에 자동 추가 · ${state.reminderMinutes}분 전 Outlook 알림`:state?.configured?"한 번 연결하면 이후 예약·변경·취소가 본인 Outlook 일정에 반영됩니다.":"전산 담당자의 Microsoft 연동 설정이 필요합니다. 설정 전에는 일정이 자동 추가되지 않습니다."}</p>
    {state?.configured&&!state.connected&&<a href="/auth/microsoft/connect">Microsoft 계정 연결</a>}
    {state?.connected&&<small>참석자 초대 없음 · Teams 알림은 개인 설정에 따라 다릅니다.</small>}
    {state?.connected&&<details><summary>연결 관리</summary><small>로그아웃 후에도 일정 반영을 이어갑니다. 원하지 않으면 연결을 해제하세요.</small><button type="button" onClick={()=>void disconnect()}>Microsoft 연결 해제</button></details>}
    {!!state?.pendingCount&&<p role="status">예약 저장과 별도로 일정 {state.pendingCount}건이 반영 대기 또는 확인 필요 상태입니다.</p>}
    {!!state?.jobs.length&&<details><summary>최근 일정 반영 내역</summary><ul>{state.jobs.slice(0,10).map(j=>{const b=bookings.find(b=>b.id===j.bookingId);return <li key={j.bookingId}><span>{b?`${b.date} ${b.start} · ${roomById(b.roomId)?.name}`:j.cancelled?"취소한 예약 일정":"예약 일정"}</span><b>{j.status==="synced"?(j.cancelled?"일정 삭제 완료":"반영 완료"):j.error==="event_missing"?"Outlook에서 삭제됨 · 확인 필요":!state.connected?"연결 후 반영":j.status==="attention"?"권한·연결 확인 필요":j.status==="retrying"?"지연 · 재시도 대기":"반영 대기"}</b></li>;})}</ul><small>최근 10건 표시 · 기존 일정이 있더라도 다시 예약하지 마세요.</small></details>}
    {state?.connected&&problems.some(j=>j.status==="attention"&&j.error!=="event_missing")&&<><button type="button" disabled={retrying} onClick={()=>void retry()}>{retrying?"요청 중…":"일정 반영 다시 요청"}</button><a href="/auth/microsoft/connect">Microsoft 권한 다시 확인</a></>}
    {error&&<p role="status">{error}</p>}
  </section>;
}
