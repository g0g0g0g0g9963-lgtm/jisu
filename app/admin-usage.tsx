import { useCallback, useEffect, useRef, useState } from "react";
import { requestApi } from "./lib/api";
import site from "./config/site.json";

type Range = { from: string; to: string };
type Hour = { hour: number; label: string; bookings: number; bookedMinutes: number };
type Usage = {
  at: string;
  timeZone: string;
  range: Range & { days: number };
  summary: { bookings: number; identifiedUsers: number; unidentifiedBookings: number; bookedMinutes: number };
  users: { key: string; name: string; email: string; bookings: number; bookedMinutes: number }[];
  rooms: { roomId: string; name: string; floor: number | null; bookings: number; bookedMinutes: number }[];
  hours: Hour[];
  peakHour: Hour | null;
};
type Preset = "month" | "30" | "90";

function todayInSite() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: site.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}
function presetRange(preset: Preset): Range {
  const to = todayInSite();
  if (preset === "month") return { from: `${to.slice(0, 7)}-01`, to };
  const date = new Date(`${to}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (Number(preset) - 1));
  return { from: date.toISOString().slice(0, 10), to };
}
function validRange(range: Range): string {
  const timestamps = [range.from, range.to].map(value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() : NaN;
  });
  if (timestamps.some(value => !Number.isFinite(value))) return "조회 시작일과 종료일을 올바르게 입력해 주세요.";
  if (timestamps[0] > timestamps[1]) return "조회 종료일은 시작일보다 빠를 수 없습니다.";
  if ((timestamps[1] - timestamps[0]) / 86400000 + 1 > 366) return "한 번에 최대 366일까지 조회할 수 있습니다.";
  return "";
}
const count = (value: number) => value.toLocaleString("ko-KR");
const hours = (minutes: number) => `${(minutes / 60).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}시간`;
const rangeLabel = (range: Range) => `${range.from.replaceAll("-", ".")} – ${range.to.replaceAll("-", ".")}`;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonnegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const measured = (value: unknown): value is Record<string, unknown> => isRecord(value) && nonnegativeInteger(value.bookings) && nonnegativeInteger(value.bookedMinutes);
const validHour = (value: unknown): value is Hour => measured(value) && nonnegativeInteger(value.hour) && value.hour < 24 && typeof value.label === "string" && !!value.label.trim();
function validUsage(value: unknown, range: Range): value is Usage {
  if (!isRecord(value) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || typeof value.timeZone !== "string") return false;
  try { new Intl.DateTimeFormat("ko-KR", { timeZone: value.timeZone }); } catch { return false; }
  if (!isRecord(value.range) || value.range.from !== range.from || value.range.to !== range.to || !nonnegativeInteger(value.range.days)
    || value.range.days !== (Date.parse(range.to) - Date.parse(range.from)) / 86400000 + 1) return false;
  if (!measured(value.summary) || !nonnegativeInteger(value.summary.identifiedUsers) || !nonnegativeInteger(value.summary.unidentifiedBookings)) return false;
  if (!Array.isArray(value.users) || !value.users.every(person => measured(person) && typeof person.key === "string" && !!person.key
    && typeof person.name === "string" && typeof person.email === "string") || new Set(value.users.map(person => person.key)).size !== value.users.length) return false;
  if (!Array.isArray(value.rooms) || !value.rooms.every(room => measured(room) && typeof room.roomId === "string" && !!room.roomId
    && typeof room.name === "string" && (room.floor === null || (typeof room.floor === "number" && Number.isSafeInteger(room.floor))))
    || new Set(value.rooms.map(room => room.roomId)).size !== value.rooms.length) return false;
  if (!Array.isArray(value.hours) || value.hours.length !== 24 || !value.hours.every((hour, index) => validHour(hour) && hour.hour === index)) return false;
  return value.peakHour === null || validHour(value.peakHour);
}

export default function AdminUsage({ refreshKey, onAccessDenied }: { refreshKey: number; onAccessDenied: () => void }) {
  const [range, setRange] = useState<Range>(() => presetRange("30"));
  const [draft, setDraft] = useState<Range>(range);
  const [preset, setPreset] = useState<Preset | null>("30");
  const [validation, setValidation] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const requestSeq = useRef(0);

  const applyRange = useCallback((next: Range, nextPreset: Preset | null) => {
    const message = validRange(next);
    setValidation(message);
    if (message) return;
    // Clear the previous result before a new range can be presented as selected.
    requestSeq.current++;
    setUsage(null);
    setLoading(true);
    setError("");
    setRange({ ...next });
    setDraft({ ...next });
    setPreset(nextPreset);
  }, []);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setUsage(null);
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const { response, payload } = await requestApi<Usage & { error?: string }>(`/api/admin/usage?${new URLSearchParams(range)}`, { headers: { accept: "application/json" } });
        if (seq !== requestSeq.current) return;
        if (response.status === 401 || response.status === 403) {
          requestSeq.current++;
          setUsage(null);
          onAccessDenied();
          return;
        }
        if (!response.ok || !payload) throw new Error(payload?.error || "통계 조회 실패");
        if (!validUsage(payload, range)) throw new Error("InvalidUsageResponse");
        setUsage(payload);
      } catch (cause) {
        if (seq !== requestSeq.current) return;
        setUsage(null);
        if (cause instanceof Error && cause.message === "로그인이 필요해 로그인 화면으로 이동합니다.") {
          requestSeq.current++;
          onAccessDenied();
          return;
        }
        setError(cause instanceof Error && cause.name === "TimeoutError"
          ? "응답이 늦어 통계를 확인하지 못했습니다. 잠시 후 다시 조회해 주세요."
          : "이용 통계를 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.");
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    })();
    return () => { requestSeq.current++; };
  }, [range, refreshKey, retry, onAccessDenied]);

  const maxRoom = Math.max(1, ...(usage?.rooms.map(room => room.bookings) || []));
  const maxHour = Math.max(1, ...(usage?.hours.map(hour => hour.bookings) || []));
  const duplicateEmails = new Set(usage?.users.filter(person => person.email && usage.users.some(other => other.key !== person.key && other.email === person.email)).map(person => person.email));
  return <div className="admin-usage">
    <section className="admin-card admin-usage-filter" aria-labelledby="admin-usage-heading">
      <div className="admin-section-head"><div><h2 id="admin-usage-heading">회의실 이용 통계</h2><p className="admin-sub">누가, 언제, 어떤 회의실을 예약했는지 확인하세요.</p></div><span className="admin-usage-basis">예약 데이터 기준</span></div>
      <div className="admin-usage-filters">
        <div className="admin-usage-presets" aria-label="통계 조회 기간">{([["month", "이번 달"], ["30", "최근 30일"], ["90", "최근 90일"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={preset === value} onClick={() => applyRange(presetRange(value), value)}>{label}</button>)}</div>
        <form className="admin-usage-dates" onSubmit={event => { event.preventDefault(); applyRange(draft, null); }} noValidate>
          <label>시작일<input type="date" aria-label="조회 시작일" value={draft.from} onChange={event => { setDraft(previous => ({ ...previous, from: event.target.value })); setValidation(""); }} /></label>
          <span aria-hidden="true">–</span>
          <label>종료일<input type="date" aria-label="조회 종료일" value={draft.to} onChange={event => { setDraft(previous => ({ ...previous, to: event.target.value })); setValidation(""); }} /></label>
          <button type="submit" className="admin-button">기간 적용</button>
        </form>
      </div>
      {validation && <p className="admin-error" role="alert">{validation}</p>}
      <p className="admin-usage-period">집계 기간 <strong>{rangeLabel(range)}</strong><span>{site.timeZone} · 최대 366일</span></p>
    </section>

    {loading && <div className="admin-card admin-usage-state" role="status" aria-live="polite">선택한 기간의 이용 통계를 불러오고 있습니다…</div>}
    {error && <div className="admin-card admin-usage-state"><p role="alert" className="admin-error">{error}</p><button type="button" className="admin-button" onClick={() => setRetry(value => value + 1)}>통계 다시 조회</button></div>}
    {usage && <>
      <div className="admin-summary admin-usage-summary" aria-label="이용 통계 요약">
        <div><span>예약 건수</span><strong>{count(usage.summary.bookings)}<em>건</em></strong><small>반복 예약은 날짜별로 집계</small></div>
        <div><span>예약한 직원</span><strong>{count(usage.summary.identifiedUsers)}<em>명</em></strong><small>고유 계정으로 구분</small></div>
        <div><span>누적 예약 시간</span><strong>{hours(usage.summary.bookedMinutes)}</strong><small>각 회의실의 예약 시간 합계</small></div>
        <div><span>예약이 가장 많은 시간대</span><strong className="admin-usage-peak">{usage.peakHour?.label || "—"}</strong><small>{usage.peakHour ? `해당 시간과 겹친 예약 ${count(usage.peakHour.bookings)}건` : "집계할 예약이 없습니다"}</small></div>
      </div>
      {usage.summary.bookings === 0 && <div className="admin-banner" role="status">선택한 기간에 남아 있는 예약이 없습니다. 다른 기간을 선택해 주세요.</div>}
      <div className="admin-grid admin-usage-grid">
        <section className="admin-card admin-usage-people" aria-labelledby="admin-usage-people-heading">
          <div className="admin-section-head"><div><h2 id="admin-usage-people-heading">예약이 많은 직원</h2><p className="admin-sub">예약 건수 상위 10명 · 동일 이름은 계정으로 구분</p></div></div>
          {usage.users.length ? <div className="admin-usage-table-wrap"><table className="admin-usage-table"><thead><tr><th scope="col">순위</th><th scope="col">직원 / 계정</th><th scope="col">예약</th><th scope="col">예약 시간</th></tr></thead><tbody>{usage.users.slice(0, 10).map((person, index) => <tr key={person.key}><td><span className={`admin-usage-rank${index === 0 ? " leading" : ""}`}>{index + 1}</span></td><th scope="row"><strong>{person.name || "이름 미확인"}</strong><small title={person.email || person.key}>{person.email || `계정 ${person.key.slice(0, 16)}${person.key.length > 16 ? "…" : ""}`}</small>{duplicateEmails.has(person.email) && <small title={person.key}>계정 {person.key.slice(0, 12)}</small>}</th><td><b>{count(person.bookings)}</b>건</td><td>{hours(person.bookedMinutes)}</td></tr>)}</tbody></table></div> : <p className="admin-empty">집계할 직원 예약이 없습니다.</p>}
          {usage.summary.unidentifiedBookings > 0 && <p className="admin-hint admin-usage-excluded">계정 식별 정보가 없는 예약 {count(usage.summary.unidentifiedBookings)}건은 직원 순위에서 제외했습니다. 전체 건수·회의실·시간대 통계에는 포함됩니다.</p>}
        </section>
        <section className="admin-card" aria-labelledby="admin-usage-rooms-heading"><h2 id="admin-usage-rooms-heading">예약이 많은 회의실</h2><p className="admin-sub">기간 내 예약 건수 기준 · 예약이 없는 회의실도 표시</p>
          <ul className="admin-usage-rooms">{usage.rooms.map(room => <li key={room.roomId}><div className="admin-usage-room-label"><strong>{room.name}{room.floor !== null && <span>{room.floor}F</span>}</strong><b>{count(room.bookings)}<small>건</small></b></div><div className="admin-usage-bar-track" role="img" aria-label={`${room.name}${room.floor !== null ? ` ${room.floor}층` : ""}: 예약 ${room.bookings}건, ${hours(room.bookedMinutes)}`}><span style={{ width: `${room.bookings / maxRoom * 100}%` }} /></div><p>{hours(room.bookedMinutes)}</p></li>)}</ul>
        </section>
      </div>
      <section className="admin-card admin-spaced admin-usage-hour-card" aria-labelledby="admin-usage-hours-heading"><div className="admin-section-head"><div><h2 id="admin-usage-hours-heading">시간대별 예약 현황</h2><p className="admin-sub">해당 1시간에 조금이라도 겹친 예약 수 · 한 예약이 여러 시간대에 포함될 수 있습니다.</p></div><span className="admin-usage-chart-unit">단위: 건</span></div>
        <figure className="admin-usage-chart"><div className="admin-usage-chart-bars">{usage.hours.map(hour => <div className={`admin-usage-hour${usage.peakHour?.hour === hour.hour ? " peak" : ""}`} key={hour.hour} tabIndex={0} role="img" aria-label={`${hour.label}: 예약 ${hour.bookings}건, ${hours(hour.bookedMinutes)}`}><div className="admin-usage-hour-column"><span className="admin-usage-hour-tooltip">{hour.label}<strong>{count(hour.bookings)}건 · {hours(hour.bookedMinutes)}</strong></span><span className="admin-usage-hour-count">{hour.bookings > 0 ? count(hour.bookings) : ""}</span><span className="admin-usage-hour-bar" style={{ height: hour.bookings ? `${Math.max(3, hour.bookings / maxHour * 132)}px` : "0px" }} /></div><span className="admin-usage-hour-label">{String(hour.hour).padStart(2, "0")}</span></div>)}</div><figcaption>00시부터 23시까지 · 막대 위에 마우스를 올리거나 키보드로 이동하면 상세 내용을 볼 수 있습니다.</figcaption></figure>
      </section>
      <section className="admin-usage-notes" aria-label="이용 통계 집계 기준"><h3>통계는 이렇게 집계합니다</h3><p>예약일 기준으로, 현재 남아 있는 예약과 보존된 과거 예약 이력을 집계합니다. 취소된 미래 예약은 제외하며, 반복 예약은 날짜마다 1건입니다.</p><p>진행 중 삭제로 단축된 예약은 남아 있는 종료 시각까지만 합산합니다. 시간대별 건수는 겹치는 예약을 중복 집계하므로 전체 예약 건수와 합계가 다를 수 있습니다.</p><p>예약 건수가 같으면 누적 예약 시간이 긴 순서로 표시합니다. 가장 많은 시간대도 건수와 예약 시간이 모두 같을 때 이른 시간대를 표시합니다.</p><p>사이트 방문 횟수·로그인 횟수나 실제 회의 참석 기록은 아닙니다. 직원별 정보는 관리자에게만 표시됩니다.</p><small>통계 조회 {new Intl.DateTimeFormat("ko-KR", { timeZone: usage.timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(usage.at))} · {usage.timeZone}</small></section>
    </>}
  </div>;
}
