import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMe, requestApi, type CurrentUser } from "./lib/api";
import rooms from "./config/rooms.json";
import site from "./config/site.json";
import AdminUsage from "./admin-usage";
import "./admin.css";

type Backup = {name:string;at:string;bytes?:number;bookings?:number};
type Job = {id:string;kind:string;state:"running"|"success"|"failed";at:string;error?:string};
type Status = {
  at:string;startedAt:string;bookings:number|null;databaseOk:boolean;
  metrics:{windowMinutes:number;samples:number;p95Ms:number|null;writeFailures:number;lockErrors:number;disk:{freeBytes:number;freePercent:number}|null};
  backup:{configured:boolean;readable:boolean;intervalMinutes:number;maxFiles:number;fileCount:number;last:Backup|null;lastFilePresent:boolean;verification:{at:string;name:string;bookings:number;scope:string}|null;job:Job|null;files:Backup[]};
  alerts:{level:string;text:string}[];
  response:{primary:string;secondary:string};
};
type Snapshot = {roomId:string;date:string;start:string;end:string};
type Audit = {id:number;at:string;action:"create"|"update"|"cancel";bookingId:string;actorId:string;actorName:string;before:Snapshot|null;after:Snapshot|null;changed:string[]};
type AuditResult = {items:Audit[];nextCursor:number|null};
const clock = (value?:string|null) => value ? new Intl.DateTimeFormat("ko-KR",{timeZone:site.timeZone,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(value)) : "기록 없음";
const bytes = (value?:number) => value===undefined?"—":value>=1024**3?`${(value/1024**3).toFixed(1)} GB`:value>=1024**2?`${(value/1024**2).toFixed(1)} MB`:`${Math.ceil(value/1024)} KB`;
const labels = {create:"생성",update:"변경",cancel:"취소"};
const fields:Record<string,string>={room_id:"회의실",date:"날짜",start:"시작",end:"종료",team:"본부",purpose:"목적",attendees:"참석자"};
const roomName = (id:string) => {const room=rooms.find(room=>room.id===id);return room?`${room.floor}층 · ${room.name}`:"회의실 정보 없음";};
async function adminRequest<T>(path:string,init?:RequestInit):Promise<T> {
  try {
    const {response,payload}=await requestApi<T & {error?:string}>(path,init);
    if(response.status===401||response.status===403){const error=new Error("관리자 계정만 접근할 수 있습니다.");error.name="AdminAccessDenied";throw error;}
    if(!response.ok||!payload)throw new Error(payload?.error || "관리자 정보를 불러오지 못했습니다.");
    return payload;
  } catch(error) {
    if(error instanceof Error&&error.message==="로그인이 필요해 로그인 화면으로 이동합니다.")error.name="AdminAccessDenied";
    throw error;
  }
}
function Icon({kind}:{kind:"shield"|"database"|"history"|"activity"}) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==="shield"?<><path d="M12 3 4.5 6v6c0 4.6 7.5 9 7.5 9s7.5-4.4 7.5-9V6L12 3Z"/><path d="m8.5 12 2.3 2.3 4.7-4.8"/></>:
      kind==="database"?<><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>:
      kind==="history"?<><path d="M4 7a9 9 0 1 1-1 8M4 3v5h5M12 7v5l3 2"/></>:
      <path d="M2 12h5l3-8 4 16 3-8h5"/>}
  </svg>;
}

export default function Admin() {
  const [user,setUser]=useState<CurrentUser|null>(null);
  const [auth,setAuth]=useState<"loading"|"allowed"|"denied"|"error">("loading");
  const [tab,setTab]=useState<"overview"|"usage"|"audit"|"response">("overview");
  const [usageRefresh,setUsageRefresh]=useState(0);
  const [status,setStatus]=useState<Status|null>(null);
  const [error,setError]=useState("");
  const [auditError,setAuditError]=useState("");
  const [audit,setAudit]=useState<AuditResult>({items:[],nextCursor:null});
  const [action,setAction]=useState("");
  const [loadingAudit,setLoadingAudit]=useState(false);
  const [working,setWorking]=useState(false);
  const [notice,setNotice]=useState("");
  const statusSeq=useRef(0);const auditSeq=useRef(0);
  const deny = useCallback(()=>{statusSeq.current++;auditSeq.current++;setAuth("denied");setUser(null);setStatus(null);setAudit({items:[],nextCursor:null});setNotice("");setError("");setAuditError("");},[]);
  useEffect(()=>{let active=true;void fetchMe().then(current=>{if(!active)return;if(current?.isAdmin){setUser(current);setAuth("allowed");}else setAuth("denied");}).catch(()=>{if(active)setAuth("error");});return()=>{active=false;};},[]);
  const refreshStatus=useCallback(async()=>{
    const seq=++statusSeq.current;
    try {const next=await adminRequest<Status>("/api/admin/status");if(seq===statusSeq.current){setStatus(next);setError("");}}
    catch(e){if(seq!==statusSeq.current)return;if(e instanceof Error&&e.name==="AdminAccessDenied")deny();else setError("최신 상태를 확인하지 못했습니다. 표시된 정보는 마지막 조회 시점의 값입니다.");}
  },[deny]);
  const refreshAudit=useCallback(async(before?:number)=>{
    const seq=++auditSeq.current;setLoadingAudit(true);setAuditError("");
    try {const query=new URLSearchParams({action});if(before)query.set("before",String(before));const next=await adminRequest<AuditResult>(`/api/admin/audit?${query}`);if(seq===auditSeq.current)setAudit(previous=>({items:before?[...previous.items,...next.items]:next.items,nextCursor:next.nextCursor}));}
    catch(e){if(seq!==auditSeq.current)return;if(e instanceof Error&&e.name==="AdminAccessDenied")deny();else setAuditError("이력을 불러오지 못했습니다. 다시 조회해 주세요.");}
    finally {if(seq===auditSeq.current)setLoadingAudit(false);}
  },[action,deny]);
  const running=status?.backup.job?.state==="running";
  useEffect(()=>{if(auth!=="allowed")return;void refreshStatus();const timer=window.setInterval(()=>void refreshStatus(),running?2000:30000);return()=>{window.clearInterval(timer);statusSeq.current++;};},[auth,refreshStatus,running]);
  useEffect(()=>{if(auth==="allowed"&&tab==="audit"){setAudit({items:[],nextCursor:null});void refreshAudit();}return()=>{auditSeq.current++;};},[auth,tab,refreshAudit]);
  async function start(kind:"backups"|"verify-latest") {
    if(working||running||error)return;
    setWorking(true);setNotice("");
    try {await adminRequest(`/api/admin/${kind}`,{method:"POST",headers:{"content-type":"application/json","x-admin-action":"1"},body:"{}"});setNotice("작업을 시작했습니다. 아래 작업 상태에서 완료 여부를 확인해 주세요.");}
    catch(e){if(e instanceof Error&&e.name==="AdminAccessDenied")deny();else setNotice(e instanceof Error&&e.name==="TimeoutError"?"응답이 지연되었습니다. 다시 실행하기 전에 작업 상태를 확인해 주세요.":e instanceof Error?e.message:"요청 결과를 확인해 주세요.");}
    finally {await refreshStatus();setWorking(false);}
  }
  if(auth!=="allowed")return <main className="admin-gate"><Icon kind="shield"/><h1>{auth==="loading"?"관리자 권한 확인 중…":auth==="error"?"로그인 상태를 확인하지 못했습니다":"관리자 전용 페이지입니다"}</h1><p>{auth==="denied"?"허용된 Microsoft 계정으로 로그인해 주세요.":"계정과 접근 권한을 서버에서 확인합니다."}</p>{auth==="denied"&&<p className="admin-access-help">회사 Microsoft 로그인과 관리자 계정 설정이 완료되면, 예약 화면 오른쪽 위의 ‘관리자 모드’에서 열 수 있습니다. 메뉴가 보이지 않으면 전산담당자에게 설정을 확인해 주세요.</p>}<a href="/">예약 화면으로 돌아가기</a>{auth==="error"&&<button onClick={()=>window.location.reload()}>다시 확인</button>}</main>;
  return <div className="admin-shell">
    <header className="admin-header"><a href="/" className="admin-brand"><img src="/bdo-logo.png" alt="BDO"/><span>MEETING ROOMS<small>운영 관리</small></span></a><div className="admin-account"><span>{user?.name}님<small>{user?.email}</small></span><a href="/">예약 화면</a><a href="/auth/logout">로그아웃</a></div></header>
    <main className="admin-main">
      <div className="admin-title"><div><p className="admin-eyebrow">ADMIN ONLY</p><h1>회의실 운영 관리</h1><p>예약 데이터와 서비스 상태를 한곳에서 확인하세요.</p></div><button className="admin-button" onClick={()=>{void refreshStatus();if(tab==="usage")setUsageRefresh(value=>value+1);if(tab==="audit")void refreshAudit();}}>새로고침</button></div>
      <nav className="admin-tabs" aria-label="관리자 메뉴">{([['overview','운영 현황'],['usage','이용 통계'],['audit','변경 이력'],['response','복구·대응 안내']] as const).map(([value,label])=><button key={value} onClick={()=>setTab(value)} aria-current={tab===value?"page":undefined}>{label}</button>)}</nav>
      {error&&<div role="alert" className="admin-banner danger">{error}</div>}
      {notice&&<div role="status" className="admin-banner">{notice}</div>}
      {!status&&!error&&tab!=="usage"&&<p role="status">실제 운영 상태를 조회하고 있습니다…</p>}
      {tab==="usage"&&<AdminUsage refreshKey={usageRefresh} onAccessDenied={deny}/>}
      {tab==="overview"&&status&&<>
        <div className="admin-summary"><div><span>예약 데이터베이스</span><strong>{status.databaseOk?"조회 정상":"확인 필요"}</strong><small>{status.bookings===null?"예약 건수 확인 불가":`저장된 예약 ${status.bookings.toLocaleString()}건`}</small></div><div><span>마지막 정상 백업</span><strong>{clock(status.backup.last?.at)}</strong><small>{status.backup.last&&!status.backup.lastFilePresent?"기존 백업 파일을 찾을 수 없음":status.backup.intervalMinutes?`${status.backup.intervalMinutes}분마다 자동 백업`:"자동 백업 미설정"}</small></div><div><span>운영 점검</span><strong>{status.alerts.length?`${status.alerts.length}개 항목 확인`:"화면 내 경고 없음"}</strong><small>외부 장애 감시·알림은 미연결</small></div></div>
        {status.alerts.length>0&&<section className="admin-alerts" aria-label="운영 확인 항목">{status.alerts.map((item,i)=><p key={i} className={item.level}><b>{item.level==="setup"?"설정":item.level==="danger"?"오류":"주의"}</b>{item.text}</p>)}</section>}
        <div className="admin-grid">
          <section className="admin-card"><h2><Icon kind="database"/>백업·검증</h2><dl><div><dt>백업 위치</dt><dd>{status.backup.configured?"서버 전용 위치 설정됨":"설정 필요"}</dd></div><div><dt>보관 파일</dt><dd>{status.backup.fileCount} / {status.backup.maxFiles}개</dd></div><div><dt>마지막 파일 검사</dt><dd>{clock(status.backup.verification?.at)}</dd></div><div><dt>최근 작업</dt><dd>{status.backup.job?`${status.backup.job.kind==="backup"?"백업":"검증"} · ${{running:"진행 중",success:"완료",failed:"실패"}[status.backup.job.state]}`:"실행 기록 없음"}</dd></div></dl>
            {status.backup.job?.error&&<p className="admin-error">{status.backup.job.error}</p>}
            <div className="admin-actions"><button className="admin-button primary" disabled={!status.backup.configured||working||running||!!error} onClick={()=>void start("backups")}>{working||running?"작업 상태 확인 중…":"지금 백업"}</button><button className="admin-button" disabled={!status.backup.lastFilePresent||working||running||!!error} onClick={()=>void start("verify-latest")}>최근 백업 검사</button></div>
            <p className="admin-hint">검사는 백업 파일의 무결성·구조·예약 건수만 확인합니다. 운영 데이터는 덮어쓰지 않으며, 실제 복원 후 예약 기능 시험과는 다릅니다.</p>
            <p className="admin-hint">별도 장비 보관·암호화·보관 기간 정리는 전산팀 설정이 필요합니다. 파일 수 한도에 도달하면 기존 파일을 지우지 않고 백업을 중단합니다.</p>
          </section>
          <section className="admin-card"><h2><Icon kind="activity"/>서비스 상태</h2><p className="admin-sub">최근 {status.metrics.windowMinutes}분 · 예약 API {status.metrics.samples.toLocaleString()}개 표본</p><dl><div><dt>조회 응답 시간 (95%)</dt><dd>{status.metrics.p95Ms===null?"아직 표본 없음":`${status.metrics.p95Ms} ms`}</dd></div><div><dt>저장 서버 오류</dt><dd>{status.metrics.writeFailures}건</dd></div><div><dt>DB 잠금 오류</dt><dd>{status.metrics.lockErrors}건</dd></div><div><dt>디스크 여유</dt><dd>{status.metrics.disk?`${status.metrics.disk.freePercent}% · ${bytes(status.metrics.disk.freeBytes)}`:"확인 불가"}</dd></div></dl><p className="admin-hint">정상적인 예약 충돌·입력 오류는 저장 서버 오류에 포함하지 않습니다. 표본은 서버 재시작 시 초기화됩니다.</p><div className="admin-setup">외부 감시·이메일/Teams 알림: 미연결</div><p className="admin-hint">이 화면을 닫거나 NAS가 정지하면 여기서 장애를 알릴 수 없습니다. 별도 감시 장비 연결이 필요합니다.</p></section>
        </div>
        <section className="admin-card admin-spaced"><h2>최근 백업 파일</h2>{status.backup.files.length?<ul className="admin-files">{status.backup.files.map(file=><li key={file.name}><span>{clock(file.at)}<small>{file.name}</small></span><strong>{bytes(file.bytes)}</strong></li>)}</ul>:<p className="admin-sub">아직 보관된 백업 파일이 없습니다.</p>}<p className="admin-hint">개인정보와 로그인 세션이 포함될 수 있어 브라우저 다운로드는 제공하지 않습니다.</p></section>
      </>}
      {tab==="audit"&&<section className="admin-card"><div className="admin-section-head"><div><h2><Icon kind="history"/>예약 변경 이력</h2><p className="admin-sub">기능 적용 이후의 기록만 표시됩니다. 취소된 예약의 이력도 남습니다.</p></div><label>처리 종류 <select value={action} onChange={e=>setAction(e.target.value)}><option value="">전체</option><option value="create">생성</option><option value="update">변경</option><option value="cancel">취소</option></select></label></div>
        {auditError&&<p role="alert" className="admin-error">{auditError}</p>}
        {!audit.items.length&&!loadingAudit&&!auditError&&<div className="admin-empty">표시할 변경 이력이 없습니다.</div>}
        <div className="admin-audit-list">{audit.items.map(item=><article key={item.id}><div className="admin-audit-top"><span className={`admin-tag ${item.action}`}>{labels[item.action]}</span><time>{clock(item.at)}</time><strong>{item.actorName}</strong></div><p>{roomName((item.after||item.before)!.roomId)}</p><div className="admin-audit-times">{item.before&&<span>{item.before.date} · {item.before.start}–{item.before.end}</span>}{item.before&&item.after&&<b>→</b>}{item.after&&<span>{item.after.date} · {item.after.start}–{item.after.end}</span>}{item.action==="cancel"&&<span>예약 취소</span>}</div>{item.changed.length>0&&<p className="admin-sub">변경 항목: {item.changed.map(key=>fields[key]||key).join(", ")}</p>}<details><summary>예약·계정 식별자</summary><p>예약: {item.bookingId}</p><p>계정: {item.actorId==="development"?"개발용 익명 사용자":item.actorId}</p></details></article>)}</div>
        {loadingAudit&&<p role="status">이력을 불러오는 중…</p>}{audit.nextCursor&&<button className="admin-button" disabled={loadingAudit} onClick={()=>void refreshAudit(audit.nextCursor!)}>이전 이력 더 보기</button>}<p className="admin-hint">회의 목적·참석자 이름 등 민감한 상세 내용은 이력에 복사하지 않습니다. 관리자 화면에서 이력을 수정·삭제할 수 없습니다.</p>
      </section>}
      {tab==="response"&&<div className="admin-grid"><section className="admin-card"><h2><Icon kind="shield"/>복원·업데이트 복구</h2><div className="admin-setup">운영 복원 / 자동 되돌리기: 별도 절차 필요</div><ol className="admin-steps"><li><strong>문제와 영향 범위 확인</strong><span>신규 예약을 계속 받아도 안전한지 판단합니다.</span></li><li><strong>현재 데이터와 정상 버전 보존</strong><span>프로그램 복귀와 예약 데이터 복원을 구분합니다.</span></li><li><strong>별도 환경에서 복원 시험</strong><span>예약 조회·생성·수정·취소와 DB 구조 호환성을 확인합니다.</span></li><li><strong>승인 후 복구하고 정상 동작 확인</strong><span>복원 시점 이후 예약 누락을 확인하고 필요한 안내를 합니다. DB 복원 후 기존 로그인 세션은 무효화합니다.</span></li></ol><p className="admin-hint">데이터 손실 위험이 있어 운영 DB 덮어쓰기·배포 실행 버튼은 제공하지 않습니다.</p></section><section className="admin-card"><h2>장애 연락·대응</h2><dl><div><dt>주 담당자</dt><dd>{status?.response.primary||"설정 필요"}</dd></div><div><dt>대체 담당자</dt><dd>{status?.response.secondary||"설정 필요"}</dd></div><div><dt>알림 전달</dt><dd>미연결</dd></div></dl><p className="admin-hint">담당자 표시는 알림 연결을 의미하지 않습니다. 전산팀과 연락 수단·미확인 시 전달 기준·복구 공지 절차를 정해 주세요.</p><div className="admin-setup">백업 보관 기간·복원 목표 시간·이력 보관 정책도 운영 전 확정이 필요합니다.</div></section></div>}
      <footer className="admin-footer"><span>관리자 전용 · 서버에서 접근 권한 확인</span><span>{status?`마지막 조회 ${clock(status.at)} · ${site.timeZone}`:"조회 중"}</span></footer>
    </main>
  </div>;
}
