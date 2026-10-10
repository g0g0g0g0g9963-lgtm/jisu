import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import siteConfig from "./config/site.json";
import { RoomEquipment } from "./room-equipment";
import { kioskBookingColors } from "./lib/kiosk-booking-colors";
import { KioskDatePicker } from "./kiosk-date-picker";
import { dayOfMonth, formatDateLabel, formatMinutes, formatWeekday, formatWeekdayEnglish, getWorkWeek, isWeekend, minutesOf, moveDate, officeMinutesOfDay, todayKey } from "./lib/datetime";
import { publicHolidayOf } from "./lib/holidays";
import { floors, roomById, rooms, type Room } from "./lib/rooms";
import { connectKiosk, createKioskBooking, getKioskBookings, KioskError, kioskRequestId, kioskSession, type KioskBooking, type KioskDraft, type KioskSession } from "./lib/kiosk-api";

const SLOT = siteConfig.booking.slotMinutes;
const START = minutesOf(siteConfig.booking.openingTime);
const END = minutesOf(siteConfig.booking.closingTime);
const SLOT_HEIGHT = 40;
const ROOM_GAP = 10;
const WEEK_HEADER_HEIGHT = 146;
const DAY_HEADER_HEIGHT = 106;
const timeSlots = Array.from({ length: Math.floor((END - START) / SLOT) }, (_, i) => START + i * SLOT);
const END_TIMES = [...timeSlots.slice(1), END];
const hourSlots = timeSlots.filter(value => value % 60 === 0);
const modalIdleMs = 120000;
const warningIdleMs = 90000;

function Icon({ name, size = 20 }: { name: "left" | "right" | "close" | "calendar" | "clock" | "check" | "monitor" | "refresh" | "expand" | "hand" | "lock"; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "left" ? <path d="m14 6-6 6 6 6" /> : name === "right" ? <path d="m10 6 6 6-6 6" /> : name === "close" ? <path d="m6 6 12 12M18 6 6 18" /> : name === "calendar" ? <><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16" /><path d="M8 15h2" /></> : name === "clock" ? <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> : name === "check" ? <path d="m5 12 4 4L19 6" /> : name === "refresh" ? <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 7a8 8 0 0 1 13-1L20 9M4 15l1.4 3a8 8 0 0 0 13-1" /></> : name === "expand" ? <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /> : name === "hand" ? <><path d="M9 12V5a2 2 0 0 1 4 0v5m0-2a2 2 0 0 1 4 0v3m0-1a2 2 0 0 1 4 0v5a7 7 0 0 1-12 5l-5-6a2 2 0 0 1 3-3l2 2" /></> : name === "lock" ? <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></> : <><rect x="3" y="4" width="18" height="13" rx="3" /><path d="M8 21h8m-4-4v4" /></>}
  </svg>;
}

function Brand() {
  return <div className="kiosk-brand"><img src="/bdo-logo.png" alt="BDO" /><span className="kiosk-brand-divider" /><div><span className="kiosk-eyebrow">SEOUL OFFICE</span><strong>MEETING ROOMS</strong></div></div>;
}

function dateRangeLabel(from: string, to: string) {
  const [year, month, day] = from.split("-").map(Number);
  const [endYear, endMonth, endDay] = to.split("-").map(Number);
  return `${year}. ${month}. ${day} — ${year === endYear ? "" : `${endYear}. `}${month === endMonth && year === endYear ? "" : `${endMonth}. `}${endDay}`;
}

const slashDate = (date: string) => `${Number(date.slice(5, 7))}/${dayOfMonth(date)}`;
const shortWeekLabel = (from: string, to: string) => `${slashDate(from)}–${from.slice(0, 7) === to.slice(0, 7) ? dayOfMonth(to) : slashDate(to)}`;
const weekKicker = (date: string) => `${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][Number(date.slice(5, 7)) - 1]} · WEEK ${Math.floor((dayOfMonth(date) - 1) / 7) + 1}`;

function maximumDate(today: string) {
  const date = new Date(`${today}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + siteConfig.booking.maxAdvanceMonths);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

function nextAvailableSlot(date: string, minute: number, now: Date) {
  if (date !== todayKey(now)) return minute;
  return Math.max(minute, Math.ceil(officeMinutesOfDay(now) / SLOT) * SLOT);
}

function MonitorAccess({ state, error, onConnected, onRetry }: { state: KioskSession | null; error: string; onConnected: (value: KioskSession) => void; onRetry: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true); setLocalError("");
    try { const value = await connectKiosk(code.trim()); setCode(""); if (!value.authorized) throw new Error("모니터 연결을 확인하지 못했습니다."); onConnected(value); }
    catch (problem) { setLocalError(problem instanceof Error ? problem.message : "연결할 수 없습니다."); setCode(""); }
    finally { setBusy(false); }
  };
  return <div className="kiosk-access"><header><Brand /><span className="kiosk-mode"><Icon name="monitor" size={17} />공용 모니터 전용</span></header><main className="kiosk-access-card">
    <div className="kiosk-access-icon"><Icon name="monitor" size={32} /></div>
    <span className="kiosk-eyebrow">SHARED DISPLAY</span>
    <h1>회의실 예약 모니터</h1>
    {!state && !error ? <p role="status">모니터 연결 상태를 확인하고 있습니다.</p> : !state ? <><p role="alert">{error}</p><button type="button" className="kiosk-primary" onClick={onRetry}>다시 확인</button></> : !state.enabled ? <><p>공용 모니터 연결이 아직 설정되지 않았습니다.</p><div className="kiosk-access-note"><Icon name="lock" /><span>전산 담당자가 이 모니터를 연결하면<br />회의실 주간 시간표와 예약 화면이 열립니다.</span></div><button type="button" className="kiosk-secondary" onClick={onRetry}>연결 상태 다시 확인</button></> : <>
      <p>전산 담당자에게 받은 연결 코드를 입력해 주세요.<br />직원 개인 계정으로 로그인하지 않습니다.</p>
      <form onSubmit={submit} autoComplete="off"><label htmlFor="kiosk-code">모니터 연결 코드</label><input id="kiosk-code" data-testid="kiosk-connect-code" type="password" autoComplete="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} maxLength={256} required disabled={busy} />{(localError || error) && <p className="kiosk-inline-error" role="alert">{localError || error}</p>}<button className="kiosk-primary" data-testid="kiosk-connect-submit" type="submit" disabled={busy || !code.trim()}>{busy ? "연결 확인 중…" : "이 모니터 연결하기"}<Icon name="right" /></button></form>
    </>}
    <small>이 화면은 공용 모니터용입니다. 개인 계정 정보는 불러오지 않습니다.</small>
  </main><footer>BDO KOREA · MEETING ROOM RESERVATION</footer></div>;
}

export default function Kiosk() {
  const [session, setSession] = useState<KioskSession | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [floor, setFloor] = useState(floors[0] ?? 9);
  const [selectedDate, setSelectedDate] = useState(() => todayKey());
  const [view, setView] = useState<"day" | "week">("week");
  const [bookings, setBookings] = useState<KioskBooking[]>([]);
  const [loadedRange, setLoadedRange] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [draft, setDraft] = useState<KioskDraft | null>(null);
  const [detail, setDetail] = useState<KioskBooking | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [idleWarning, setIdleWarning] = useState(false);
  const [toast, setToast] = useState("");
  const [fullScreen, setFullScreen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const lastActivity = useRef(Date.now());
  const requestIdentity = useRef<{ fingerprint: string; key: string } | null>(null);
  const initialScrolled = useRef(false);
  const gesture = useRef<{ id: number; x: number; y: number; moved: boolean; scrollLeft: number; scrollTop: number } | null>(null);
  const suppressClick = useRef(false);
  const savingRef = useRef(false);
  const today = todayKey(now);
  const minuteNow = officeMinutesOfDay(now);
  const week = getWorkWeek(selectedDate)[0];
  const endDate = moveDate(week, 6);
  // Keep the full week cached so switching day/week does not lose bookings or
  // briefly declare a different date available before its data has loaded.
  const dates = useMemo(() => view === "day" ? [selectedDate] : Array.from({ length: 7 }, (_, index) => moveDate(week, index)), [view, selectedDate, week]);
  const headerHeight = view === "day" ? DAY_HEADER_HEIGHT : WEEK_HEADER_HEIGHT;
  const selectedHoliday = publicHolidayOf(selectedDate);
  const rangeKey = `${week}/${endDate}`;
  const currentRooms = useMemo(() => rooms.filter(room => room.floor === floor), [floor]);
  const roomWidth = Math.max(650, dates.length * 130);
  const fresh = loadedRange === rangeKey && !!lastUpdated && now.getTime() - lastUpdated.getTime() < 90000 && !loadError;
  const openModal = Boolean(draft || detail);
  const gridHeight = timeSlots.length * SLOT_HEIGHT;
  const bookingGroups = useMemo(() => {
    const result = new Map<string, KioskBooking[]>();
    for (const booking of bookings) {
      const key = `${booking.roomId}/${booking.date}`;
      const list = result.get(key) ?? []; list.push(booking); result.set(key, list);
    }
    return result;
  }, [bookings]);

  const checkSession = useCallback(async () => {
    setSessionError("");
    try { setSession(await kioskSession()); }
    catch (problem) { setSession(null); setSessionError(problem instanceof Error ? problem.message : "연결 상태를 확인할 수 없습니다."); }
  }, []);

  useEffect(() => { void checkSession(); }, [checkSession]);

  const clearModal = useCallback(() => {
    if (savingRef.current) return;
    setDraft(null); setDetail(null); setFormError(""); setIdleWarning(false); setUncertain(false); requestIdentity.current = null;
  }, []);

  const refresh = useCallback(async () => {
    if (!session?.authorized) return;
    const requestId = ++sequence.current;
    setLoading(true);
    try {
      const response = await getKioskBookings(week, endDate);
      if (requestId !== sequence.current) return;
      setBookings(response.bookings); setLoadedRange(`${week}/${endDate}`); setLastUpdated(new Date()); setLoadError("");
    } catch (problem) {
      if (requestId !== sequence.current) return;
      if (problem instanceof KioskError && (problem.status === 401 || problem.status === 403)) {
        setBookings([]); setLoadedRange(""); setLastUpdated(null); clearModal(); await checkSession();
      }
      setLoadError(problem instanceof Error ? problem.message : "최신 예약을 확인할 수 없습니다.");
    } finally { if (requestId === sequence.current) setLoading(false); }
  }, [session?.authorized, week, endDate, checkSession, clearModal]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    const visible = () => { if (!document.hidden) { setNow(new Date()); void refresh(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { ++sequence.current; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);

  useEffect(() => {
    if (session?.authorized) return;
    ++sequence.current; setBookings([]); setLoadedRange(""); setLastUpdated(null); setDraft(null); setDetail(null); setFormError(""); requestIdentity.current = null;
  }, [session?.authorized]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const focusTime = useCallback((instant = new Date(), behavior: ScrollBehavior = "smooth") => {
    const area = scrollRef.current;
    if (!area) return;
    const focus = dates.includes(todayKey(instant)) ? officeMinutesOfDay(instant) : 9 * 60;
    area.scrollTo({ top: Math.max(0, ((focus - START) / SLOT) * SLOT_HEIGHT - 16), behavior });
  }, [dates]);

  useEffect(() => {
    if (!session?.authorized) { initialScrolled.current = false; return; }
    const frame = requestAnimationFrame(() => { if (!initialScrolled.current) { focusTime(new Date(), "instant"); initialScrolled.current = true; } });
    return () => cancelAnimationFrame(frame);
  }, [session?.authorized, focusTime]);

  useEffect(() => {
    if (!detail) { dialogRef.current?.close(); return; }
    lastActivity.current = Date.now(); setIdleWarning(false);
    dialogRef.current?.showModal();
  }, [Boolean(detail)]);

  useEffect(() => {
    if (!draft) return;
    lastActivity.current = Date.now(); setIdleWarning(false);
    panelRef.current?.focus({ preventScroll: true });
  }, [Boolean(draft)]);

  useEffect(() => {
    if (!openModal) return;
    const activity = () => { lastActivity.current = Date.now(); setIdleWarning(false); };
    const timer = window.setInterval(() => {
      if (savingRef.current) { lastActivity.current = Date.now(); return; }
      const idleFor = Date.now() - lastActivity.current;
      if (idleFor >= modalIdleMs) { clearModal(); setToast("입력 대기 시간이 지나 예약창을 닫았습니다."); }
      else if (idleFor >= warningIdleMs) setIdleWarning(true);
    }, 1000);
    document.addEventListener("pointerdown", activity); document.addEventListener("keydown", activity); document.addEventListener("input", activity);
    return () => { window.clearInterval(timer); document.removeEventListener("pointerdown", activity); document.removeEventListener("keydown", activity); document.removeEventListener("input", activity); };
  }, [openModal, clearModal]);

  useEffect(() => {
    const change = () => setFullScreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);

  const pickSlot = (room: Room, date: string, start: number) => {
    if (suppressClick.current) return;
    if (savingRef.current || uncertain) { setToast("진행 중인 예약의 저장 결과를 먼저 확인해 주세요."); return; }
    if (!fresh) { setToast("최신 예약을 확인한 후 다시 선택해 주세요."); return; }
    const current = new Date();
    if (date < todayKey(current) || date === todayKey(current) && start < officeMinutesOfDay(current)) { setToast("지난 시간에는 예약할 수 없습니다. 앞으로의 시간을 선택해 주세요."); return; }
    if (date > maximumDate(todayKey(current))) { setToast("예약 가능한 기간을 벗어났습니다."); return; }
    const list = bookingGroups.get(`${room.id}/${date}`) ?? [];
    const next = list.filter(item => minutesOf(item.start) > start).reduce((earliest, item) => Math.min(earliest, minutesOf(item.start)), END);
    const end = Math.min(END, next, start + siteConfig.booking.defaultDurationMinutes);
    if (end <= start) return;
    requestIdentity.current = null; setFormError(""); setUncertain(false); setDetail(null);
    setSelectedDate(date);
    setDraft(value => ({ roomId: room.id, date, start: formatMinutes(start), end: formatMinutes(end), owner: value?.owner ?? "", purpose: value?.purpose ?? "" }));
  };

  const startGesture = (event: ReactPointerEvent) => {
    const area = scrollRef.current;
    if (!area) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, scrollLeft: area.scrollLeft, scrollTop: area.scrollTop };
    suppressClick.current = false;
  };
  const moveGesture = (event: ReactPointerEvent) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) { current.moved = true; suppressClick.current = true; }
  };
  const finishGesture = () => {
    const current = gesture.current; const area = scrollRef.current;
    if (current && area && (current.moved || Math.abs(area.scrollLeft - current.scrollLeft) > 4 || Math.abs(area.scrollTop - current.scrollTop) > 4)) suppressClick.current = true;
    gesture.current = null;
    window.setTimeout(() => { suppressClick.current = false; }, 450);
  };

  const changeDraft = (patch: Partial<KioskDraft>) => {
    if (saving || uncertain) return;
    setDraft(value => value ? { ...value, ...patch } : null); setFormError(""); requestIdentity.current = null;
    if (patch.date && /^\d{4}-\d{2}-\d{2}$/.test(patch.date)) setSelectedDate(patch.date);
    if (patch.roomId) {
      const selected = roomById(patch.roomId);
      if (selected) { setFloor(selected.floor); scrollRef.current?.scrollTo({ left: 0, behavior: "instant" }); }
    }
  };

  const openQuickBooking = () => {
    if (savingRef.current || draft) return;
    const instant = new Date(); const currentToday = todayKey(instant);
    let date = selectedDate > currentToday ? selectedDate : currentToday;
    let start = date === currentToday ? nextAvailableSlot(date, START, instant) : 9 * 60;
    if (start >= END) { date = moveDate(date, 1); start = 9 * 60; }
    const room = currentRooms[0];
    if (!room) return;
    setSelectedDate(date); setNow(instant); setDetail(null); setFormError(""); setUncertain(false); requestIdentity.current = null;
    setDraft({ roomId: room.id, date, start: formatMinutes(start), end: formatMinutes(Math.min(END, start + siteConfig.booking.defaultDurationMinutes)), owner: "", purpose: "" });
  };

  const draftRangeLoaded = Boolean(draft && draft.date >= week && draft.date <= endDate && fresh);
  const draftConflict = draft && bookings.some(item => item.roomId === draft.roomId && item.date === draft.date && minutesOf(item.start) < minutesOf(draft.end) && minutesOf(item.end) > minutesOf(draft.start));
  const draftInvalidTime = draft && (!draft.date || draft.date < today || draft.date > maximumDate(today) || minutesOf(draft.end) <= minutesOf(draft.start) || draft.date === today && minutesOf(draft.start) < minuteNow);

  const submitBooking = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || savingRef.current || !session?.csrfToken) return;
    const payload = { ...draft, owner: draft.owner.trim(), purpose: draft.purpose.trim() };
    if (!payload.owner) { setFormError("예약자 이름을 입력해 주세요."); nameRef.current?.focus(); return; }
    // A retry after an uncertain response must reach the idempotency record even
    // if a refresh now contains this very booking or its start time has passed.
    if (!uncertain && (!draftRangeLoaded || draftConflict || draftInvalidTime)) { setFormError(!draftRangeLoaded ? "예약 날짜의 최신 시간표를 확인해 주세요." : draftConflict ? "선택한 시간에 이미 예약이 있습니다. 다른 시간을 선택해 주세요." : "앞으로의 날짜와 올바른 시간을 선택해 주세요."); return; }
    const fingerprint = JSON.stringify(payload);
    if (requestIdentity.current?.fingerprint !== fingerprint) requestIdentity.current = { fingerprint, key: kioskRequestId() };
    const key = requestIdentity.current.key;
    savingRef.current = true; setSaving(true); setFormError("");
    try {
      await createKioskBooking(payload, session.csrfToken, key);
      savingRef.current = false; setSaving(false); clearModal(); setToast("예약이 완료되었습니다. 다음 이용자를 위해 입력 내용을 지웠습니다."); await refresh();
    } catch (problem) {
      if (problem instanceof KioskError && (problem.status === 401 || problem.status === 403)) {
        savingRef.current = false; setSaving(false); clearModal(); await checkSession(); setToast("모니터 연결 상태를 다시 확인했습니다. 예약이 저장되었는지 시간표를 확인해 주세요.");
      } else {
        const unknown = problem instanceof KioskError && problem.uncertain;
        setUncertain(unknown); setFormError(problem instanceof Error ? problem.message : "예약을 처리하지 못했습니다.");
        if (!unknown) requestIdentity.current = null;
        if (problem instanceof KioskError && problem.status === 409) void refresh();
      }
    } finally { savingRef.current = false; setSaving(false); lastActivity.current = Date.now(); }
  };

  const selectDate = (date: string) => {
    setSelectedDate(date);
    scrollRef.current?.scrollTo({ left: 0, top: (9 * 60 - START) / SLOT * SLOT_HEIGHT, behavior: "instant" });
  };

  const navigateDate = (direction: number) => selectDate(moveDate(selectedDate, direction * (view === "day" ? 1 : 7)));
  const selectView = (value: "day" | "week") => { setView(value); scrollRef.current?.scrollTo({ left: 0, behavior: "instant" }); };

  const changeFloor = (value: number) => { setFloor(value); scrollRef.current?.scrollTo({ left: 0, behavior: "instant" }); };

  const jumpToday = () => {
    const instant = new Date(); const currentToday = todayKey(instant);
    setNow(instant); setSelectedDate(currentToday);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ left: 0, top: Math.max(0, (officeMinutesOfDay(instant) - START) / SLOT * SLOT_HEIGHT - 16), behavior: "smooth" }));
  };

  const fullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { setToast("이 브라우저에서는 전체 화면을 전환할 수 없습니다."); }
  };

  if (!session?.authorized) return <MonitorAccess state={session} error={sessionError} onConnected={setSession} onRetry={() => void checkSession()} />;

  const selectedRoom = draft ? roomById(draft.roomId) : detail ? roomById(detail.roomId) : undefined;
  return <div className={`kiosk-app is-${view}-view${draft ? " is-panel-open" : ""}`}>
    <header className="kiosk-topbar"><Brand /><div className="kiosk-topbar-right"><span className="kiosk-mode"><Icon name="monitor" size={17} />공용 모니터</span><span className="kiosk-live-date">{formatDateLabel(today)}<strong>{formatMinutes(minuteNow)}</strong></span><button type="button" className="kiosk-icon-button" title={fullScreen ? "전체 화면 종료" : "전체 화면"} aria-label={fullScreen ? "전체 화면 종료" : "전체 화면"} onClick={() => void fullscreen()}><Icon name="expand" /></button></div></header>
    <main className="kiosk-main" aria-label="공용 모니터 회의실 예약">
      <section className="kiosk-toolbar" aria-label="층과 주간 선택">
        <div className="kiosk-date-floor">
          <div className={`kiosk-date-hero${view === "week" ? " is-range" : ""}`} data-testid="kiosk-hero-date" data-date={selectedDate}>
            <span className={`kiosk-hero-weekday${formatWeekday(selectedDate) === "토" ? " is-sat" : ""}${selectedHoliday ? " is-holiday" : ""}`}>{view === "week" ? weekKicker(week) : formatWeekdayEnglish(selectedDate)}{view === "day" && selectedHoliday && <em>{selectedHoliday.name}</em>}</span>
            <strong className={`kiosk-hero-date${view === "week" ? " is-range" : ""}`} data-testid={view === "week" ? "kiosk-week-label" : undefined} aria-label={view === "week" ? dateRangeLabel(week, endDate) : formatDateLabel(selectedDate)}>{view === "week" ? shortWeekLabel(week, endDate) : slashDate(selectedDate)}</strong>
          </div>
          <div className="kiosk-floor-tabs" aria-label="층 선택">{floors.map(value => <button key={value} type="button" data-testid={`kiosk-floor-${value}`} className={floor === value ? "is-active" : ""} aria-pressed={floor === value} onClick={() => changeFloor(value)}>{value}<span>F</span></button>)}</div>
        </div>
        <div className="kiosk-date-navigation"><button type="button" data-testid="kiosk-week-prev" className="kiosk-date-arrow" aria-label={view === "week" ? "이전 주" : "이전 날짜"} onClick={() => navigateDate(-1)}><Icon name="left" /></button><button type="button" data-testid="kiosk-week-today" className="kiosk-date-today" onClick={jumpToday}>{view === "week" ? "이번 주" : "오늘"}</button><button type="button" data-testid="kiosk-week-next" className="kiosk-date-arrow" aria-label={view === "week" ? "다음 주" : "다음 날짜"} onClick={() => navigateDate(1)}><Icon name="right" /></button><KioskDatePicker value={selectedDate} onChange={selectDate} /></div>
        <div className="kiosk-view-tabs" role="group" aria-label="예약 현황 보기 방식"><button type="button" data-testid="kiosk-view-day" className={view === "day" ? "is-active" : ""} aria-pressed={view === "day"} onClick={() => selectView("day")}>일간</button><button type="button" data-testid="kiosk-view-week" className={view === "week" ? "is-active" : ""} aria-pressed={view === "week"} onClick={() => selectView("week")}>주간</button></div>
      </section>
      {(loadError || loadedRange === rangeKey && lastUpdated && !fresh) && <div className="kiosk-load-alert" role="alert"><div>{loadError || "최신 예약을 확인하고 있습니다."}<span>표시된 예약은 최신 상태가 아닐 수 있습니다. 확인 전에는 새 예약을 받지 않습니다.</span></div><button type="button" className="kiosk-secondary" data-testid="kiosk-retry" onClick={() => void refresh()} disabled={loading}>{loading ? "확인 중…" : "다시 확인"}</button></div>}
      <div className={`kiosk-calendar-shell${!fresh ? " is-stale" : ""}`} style={{ "--kiosk-timeline-head-height": `${headerHeight}px` } as CSSProperties}>
        <div className="kiosk-scroll" ref={scrollRef} data-testid="kiosk-scroll" data-ready={fresh && !loading ? "true" : "false"} aria-busy={loading} aria-label={`${floor}층 ${view === "week" ? "회의실별 주간" : `${formatDateLabel(selectedDate)} 일간`} 시간표. 좌우 및 위아래로 스크롤할 수 있습니다.`} onPointerDownCapture={startGesture} onPointerMoveCapture={moveGesture} onPointerUpCapture={finishGesture} onPointerCancelCapture={finishGesture}>
          <div className="kiosk-grid" style={{ "--kiosk-room-width": `${roomWidth}px`, "--kiosk-room-gap": `${ROOM_GAP}px`, "--kiosk-days": dates.length, minWidth: view === "day" ? 70 + currentRooms.length * (250 + ROOM_GAP) : undefined, gridTemplateColumns: `70px repeat(${currentRooms.length}, ${view === "day" ? "minmax(250px, 1fr)" : `${roomWidth}px`})`, gridTemplateRows: `${headerHeight}px ${gridHeight}px` } as CSSProperties}>
            <div className="kiosk-time-corner"><Icon name="clock" size={18} /><span>TIME</span></div>
            {currentRooms.map((room, index) => {
              const statusKnown = fresh && today >= week && today <= endDate;
              const busy = statusKnown && (bookingGroups.get(`${room.id}/${today}`) ?? []).some(item => minutesOf(item.start) <= minuteNow && minutesOf(item.end) > minuteNow);
              return <div className={`kiosk-room-header${draft?.roomId === room.id ? " is-selected" : ""}${index === currentRooms.length - 1 ? " is-last-room" : ""}`} data-testid="kiosk-room-header" data-room={room.id} key={room.id} style={{ gridColumn: index + 2, gridRow: 1 }}>
                <div className="kiosk-room-heading"><div><div className="kiosk-room-title-row"><h2>{room.name}</h2><span className="kiosk-floor-tag">{room.floor}F</span></div>
                  <p className={`kiosk-room-status${statusKnown ? busy ? " is-busy" : " is-available" : ""}`}>{statusKnown && <><i aria-hidden="true" /><b>{busy ? "사용 중" : "지금 사용 가능"}</b><em>·</em></>}<span>최대 {room.capacity}명</span></p>
                  <RoomEquipment room={room} />
                </div></div>
                {view === "week" && <div className="kiosk-day-headings">{dates.map(date => <div key={date} className={`${date === today ? " is-today" : ""}${isWeekend(date) ? " is-weekend" : ""}`}><span>{formatWeekday(date)}</span><strong>{dayOfMonth(date)}</strong>{date === today && <small>오늘</small>}</div>)}</div>}
              </div>;
            })}
            <div className="kiosk-time-axis" style={{ gridColumn: 1, gridRow: 2, height: gridHeight }}>{hourSlots.map(time => <span key={time} style={{ top: (time - START) / SLOT * SLOT_HEIGHT }} className="kiosk-hour-label">{formatMinutes(time)}</span>)}<span className="kiosk-hour-label is-end" style={{ top: gridHeight }}>{formatMinutes(END)}</span>{dates.includes(today) && minuteNow >= START && minuteNow <= END && <span className="kiosk-now-label" style={{ top: (minuteNow - START) / SLOT * SLOT_HEIGHT }}>{formatMinutes(minuteNow)}</span>}</div>
            {currentRooms.map((room, index) => <div className={`kiosk-room-body${index === currentRooms.length - 1 ? " is-last-room" : ""}`} key={room.id} style={{ gridColumn: index + 2, gridRow: 2 }}>{dates.map(date => <div className={`kiosk-day-column${date === today ? " is-today" : ""}${date < today ? " is-past" : ""}`} key={date} style={{ height: gridHeight }}>
              {timeSlots.map(start => <button type="button" key={start} className={`kiosk-slot${start % 60 === 0 ? " is-hour" : ""}`} data-testid="kiosk-slot" data-room={room.id} data-date={date} data-start={formatMinutes(start)} aria-label={`${room.name} ${formatDateLabel(date)} ${formatMinutes(start)} 예약`} tabIndex={-1} onClick={() => pickSlot(room, date, start)} />)}
              {loadedRange === rangeKey && (bookingGroups.get(`${room.id}/${date}`) ?? []).map(booking => {
                const duration = minutesOf(booking.end) - minutesOf(booking.start);
                const ended = date < today || date === today && minutesOf(booking.end) <= minuteNow;
                return <button key={booking.id} type="button" className={`kiosk-booking${duration < 60 ? " is-compact" : ""}${ended ? " is-ended" : ""}`} data-testid="kiosk-booking" data-booking-id={booking.id}
                  style={{ ...kioskBookingColors(booking.owner), top: (minutesOf(booking.start) - START) / SLOT * SLOT_HEIGHT + 2, height: Math.max(28, duration / SLOT * SLOT_HEIGHT - 4) }}
                  onClick={() => { if (!suppressClick.current && !savingRef.current && !uncertain) { clearModal(); setDetail(booking); } }}
                  title={`${booking.owner} · ${booking.start}–${booking.end}`} aria-label={`${booking.owner}, ${booking.start}부터 ${booking.end}까지 예약 정보`}>
                  <strong>{booking.owner}</strong><time>{booking.start}–{booking.end}</time>{duration >= 60 && booking.purpose && <small>{booking.purpose}</small>}
                </button>;
              })}
            </div>)}</div>)}
            {dates.includes(today) && minuteNow >= START && minuteNow <= END && <div className="kiosk-now-line" data-testid="kiosk-now-line" style={{ top: headerHeight + (minuteNow - START) / SLOT * SLOT_HEIGHT }} aria-hidden="true" />}
          </div>
        </div>
        {!loadedRange && loading && <div className="kiosk-calendar-loading" role="status"><span className="kiosk-spinner" />예약을 불러오고 있습니다.</div>}
      </div>
      <footer className="kiosk-footer"><span><span className="kiosk-legend-booked" />예약됨<span className="kiosk-legend-now" />현재 시간</span><p>예약자 이름은 매번 직접 입력합니다.</p></footer>
    </main>
    {!draft ? <button type="button" className="kiosk-quick-rail" data-testid="kiosk-quick-open" aria-label="빠른 예약 펼치기" aria-expanded={false} aria-controls="kiosk-quick-booking" onClick={openQuickBooking}>
      <span className="kiosk-quick-rail-main"><Icon name="calendar" /><i aria-hidden="true" /><span>빠른 예약</span></span><span className="kiosk-quick-rail-arrow" aria-hidden="true"><Icon name="left" /></span>
    </button> : <aside className="kiosk-quick-panel" id="kiosk-quick-booking" data-testid="kiosk-quick-panel" aria-labelledby="kiosk-quick-title" ref={panelRef} tabIndex={-1}>
      <div className="kiosk-quick-title"><div className="kiosk-quick-title-copy"><span>QUICK BOOKING</span><h2 id="kiosk-quick-title">빠른 예약</h2></div>{draft.owner.trim() && <span className="kiosk-draft-chip">작성 중</span>}<button type="button" className="kiosk-quick-collapse" data-testid="kiosk-quick-close" aria-label="빠른 예약 접기" aria-expanded={true} aria-controls="kiosk-quick-booking" disabled={saving} onClick={clearModal}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m11 6-6 6 6 6m7-12-6 6 6 6" /></svg></button></div>
      <form id="kiosk-quick-form" className="kiosk-quick-form" autoComplete="off" onSubmit={submitBooking}>
        <div className="kiosk-quick-fields">
          <section className="kiosk-quick-section"><h3 className="kiosk-section-heading"><span>1</span>회의실</h3><div className="kiosk-room-picker"><select aria-label="회의실" id="kiosk-room" data-testid="kiosk-room" value={draft.roomId} disabled={saving || uncertain} onChange={event => changeDraft({ roomId: event.target.value })}>{floors.map(level => <optgroup key={level} label={level + "층"}>{rooms.filter(room => room.floor === level).map(room => <option key={room.id} value={room.id}>{room.name} · {room.floor}F</option>)}</optgroup>)}</select><p className="kiosk-room-specs">최대 {selectedRoom?.capacity}명 · {selectedRoom?.equipment.join(" · ")}</p></div></section>
          <section className="kiosk-quick-section"><h3 className="kiosk-section-heading"><span>2</span>예약 날짜</h3><div className="kiosk-form-row"><label htmlFor="kiosk-date"><Icon name="calendar" size={18} />날짜</label><input type="date" id="kiosk-date" data-testid="kiosk-date" value={draft.date} min={today} max={maximumDate(today)} disabled={saving || uncertain} required onChange={event => changeDraft({ date: event.target.value })} /></div></section>
          <section className="kiosk-quick-section"><h3 className="kiosk-section-heading"><span>3</span>시간 선택</h3><div className="kiosk-time-fields"><label htmlFor="kiosk-start">시작 시간<select id="kiosk-start" data-testid="kiosk-start" value={draft.start} disabled={saving || uncertain} onChange={event => { const start = event.target.value; changeDraft({ start, end: minutesOf(draft.end) <= minutesOf(start) ? formatMinutes(Math.min(END, minutesOf(start) + SLOT)) : draft.end }); }}>{timeSlots.map(time => <option key={time} value={formatMinutes(time)} disabled={draft.date === today && time < nextAvailableSlot(today, START, now)}>{formatMinutes(time)}</option>)}</select></label><span>—</span><label htmlFor="kiosk-end">종료 시간<select id="kiosk-end" data-testid="kiosk-end" value={draft.end} disabled={saving || uncertain} onChange={event => changeDraft({ end: event.target.value })}>{END_TIMES.map(time => <option key={time} value={formatMinutes(time)} disabled={time <= minutesOf(draft.start)}>{formatMinutes(time)}</option>)}</select></label></div><div className="kiosk-duration-options" role="group" aria-label="이용 시간">{siteConfig.booking.durationPresetsMinutes.map(duration => <button key={duration} type="button" aria-pressed={minutesOf(draft.end) - minutesOf(draft.start) === duration} disabled={saving || uncertain || minutesOf(draft.start) + duration > END} onClick={() => changeDraft({ end: formatMinutes(minutesOf(draft.start) + duration) })}>{duration / 60}시간</button>)}</div></section>
          <section className="kiosk-quick-section"><h3 className="kiosk-section-heading"><span>4</span>예약 정보</h3><div className="kiosk-name-field"><label htmlFor="kiosk-owner">예약자 이름 <em>필수</em></label><input id="kiosk-owner" data-testid="kiosk-owner" ref={nameRef} name="monitor-reservation-name" autoComplete="off" placeholder="예약하는 분의 이름을 입력해 주세요" value={draft.owner} onChange={event => changeDraft({ owner: event.target.value })} maxLength={40} required disabled={saving || uncertain} /><small>이전 이용자의 이름을 기억하거나 자동으로 채우지 않습니다.</small></div><div className="kiosk-purpose-field"><label htmlFor="kiosk-purpose">회의 목적 <span>선택</span></label><input id="kiosk-purpose" data-testid="kiosk-purpose" autoComplete="off" placeholder="예: 팀 회의" value={draft.purpose} onChange={event => changeDraft({ purpose: event.target.value })} maxLength={100} disabled={saving || uncertain} /></div></section>
          {(formError || (!uncertain && (draftConflict || draftInvalidTime || !draftRangeLoaded))) && <div className="kiosk-inline-error" role="alert">{formError || (draftConflict ? "선택한 시간에 이미 예약이 있습니다. 다른 시간을 선택해 주세요." : draftInvalidTime ? "앞으로의 날짜와 올바른 시간을 선택해 주세요." : "예약 날짜의 최신 시간표를 확인해 주세요.")}{!draftRangeLoaded && draft.date && !draftInvalidTime && <button type="button" className="kiosk-secondary" disabled={saving || uncertain || loading} onClick={() => { setSelectedDate(draft.date); if (draft.date >= week && draft.date <= endDate) void refresh(); }}>선택 날짜 시간표 확인</button>}</div>}
          {uncertain && <p className="kiosk-uncertain-note">서버에 저장되었을 수 있어 입력 내용을 잠갔습니다. 아래 버튼은 같은 요청의 결과를 확인하며 중복 예약을 만들지 않습니다. 닫기 전에 결과를 확인해 주세요.</p>}
          {idleWarning && <div className="kiosk-idle-warning" role="status">입력이 없으면 잠시 후 창을 닫고 이름을 지웁니다.<button type="button" onClick={() => { lastActivity.current = Date.now(); setIdleWarning(false); }}>계속 작성</button></div>}
        </div>
        <div className="kiosk-quick-submit"><div className="kiosk-quick-summary"><strong>{selectedRoom?.floor}층 · {selectedRoom?.name}</strong><span>{draft.date ? formatDateLabel(draft.date) : "날짜 선택"} · {draft.start}–{draft.end}</span></div><button type="submit" className="kiosk-primary" data-testid="kiosk-submit" disabled={saving || !draft.owner.trim() || !uncertain && (!draftRangeLoaded || Boolean(draftConflict) || Boolean(draftInvalidTime))}>{saving ? <><span className="kiosk-spinner" />예약 확인 중…</> : uncertain ? "저장 결과 다시 확인" : "예약하기"}</button></div>
      </form>
    </aside>}
    {toast && <div className="kiosk-toast" data-testid="kiosk-toast" role="status"><Icon name="check" />{toast}</div>}
    <dialog ref={dialogRef} className="kiosk-dialog" data-testid="kiosk-detail-dialog" aria-labelledby="kiosk-dialog-title" onCancel={event => { event.preventDefault(); clearModal(); }} onClick={event => { if (event.target === event.currentTarget && !saving) clearModal(); }}>
      {detail && <div className="kiosk-dialog-content"><button type="button" data-testid="kiosk-modal-close" className="kiosk-dialog-close kiosk-icon-button" aria-label="예약창 닫기" onClick={clearModal}><Icon name="close" size={24} /></button>
        <span className="kiosk-eyebrow">RESERVATION DETAILS</span><h2 id="kiosk-dialog-title">예약 정보</h2><p className="kiosk-dialog-intro">공용 화면에서는 예약 조회만 가능합니다.</p>
        <div className="kiosk-dialog-room"><h3>{selectedRoom?.name ?? "회의실"}</h3><span className="kiosk-floor-tag">{selectedRoom?.floor}F</span><span>최대 {selectedRoom?.capacity}명</span></div>
        <div className="kiosk-detail-list"><p><Icon name="calendar" /><span>{formatDateLabel(detail.date)}</span></p><p><Icon name="clock" /><span>{detail.start} — {detail.end}</span></p><dl><div><dt>예약자</dt><dd>{detail.owner}</dd></div>{detail.purpose && <div><dt>회의 목적</dt><dd>{detail.purpose}</dd></div>}</dl></div><p className="kiosk-detail-note">변경·취소가 필요하면 예약자 또는 관리자에게 문의해 주세요.</p><button type="button" className="kiosk-primary" onClick={clearModal}>확인</button>
      </div>}
    </dialog>
  </div>;
}
