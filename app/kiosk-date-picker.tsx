import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { formatDateLabel, moveDate, todayKey, weekdayOf } from "./lib/datetime";
import { publicHolidayOf } from "./lib/holidays";

const dateKey = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return todayKey();
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : todayKey();
};
const monthShift = (value: string, direction: number) => {
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00Z`);
  const day = Number(value.slice(8));
  date.setUTCMonth(date.getUTCMonth() + direction);
  const last = new Date(date);
  last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  date.setUTCDate(Math.min(day, last.getUTCDate()));
  return date.toISOString().slice(0, 10);
};

/** Calendar navigation for viewing reservations, independent of booking date limits. */
export function KioskDatePicker({ value, onChange }: { value: string; onChange: (date: string) => void }) {
  const selected = dateKey(value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(selected.slice(0, 7));
  const [focusedDay, setFocusedDay] = useState(selected);
  const wrapper = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const id = useId();
  const today = todayKey();
  const [year, monthNumber] = month.split("-").map(Number);
  const firstDate = `${month}-01`;
  const firstWeekday = weekdayOf(firstDate);
  const lastDate = moveDate(monthShift(firstDate, 1), -1);
  const daysInMonth = Number(lastDate.slice(8));

  const close = useCallback((restoreFocus = true) => {
    setOpen(false); pendingFocus.current = false;
    if (restoreFocus) toggle.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) close(false);
    };
    const focus = (event: FocusEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) close(false);
    };
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("focusin", focus);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("keydown", keyboard);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open || !pendingFocus.current) return;
    const button = wrapper.current?.querySelector<HTMLButtonElement>(`button[data-date-key="${focusedDay}"]`);
    if (button) { pendingFocus.current = false; button.focus({ preventScroll: true }); }
  }, [open, month, focusedDay]);

  const choose = (next: string) => { onChange(next); close(); };
  const changeMonth = (direction: number) => {
    const next = monthShift(focusedDay.slice(0, 7) === month ? focusedDay : firstDate, direction);
    pendingFocus.current = false; setMonth(next.slice(0, 7)); setFocusedDay(next);
  };
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, current: string) => {
    let next: string | null = null;
    if (event.key === "ArrowLeft") next = moveDate(current, -1);
    else if (event.key === "ArrowRight") next = moveDate(current, 1);
    else if (event.key === "ArrowUp") next = moveDate(current, -7);
    else if (event.key === "ArrowDown") next = moveDate(current, 7);
    else if (event.key === "Home") next = moveDate(current, -weekdayOf(current));
    else if (event.key === "End") next = moveDate(current, 6 - weekdayOf(current));
    else if (event.key === "PageUp") next = monthShift(current, event.shiftKey ? -12 : -1);
    else if (event.key === "PageDown") next = monthShift(current, event.shiftKey ? 12 : 1);
    if (!next) return;
    event.preventDefault(); pendingFocus.current = true; setFocusedDay(next); setMonth(next.slice(0, 7));
  };

  return <div className="kiosk-calendar-picker" ref={wrapper}>
    <button type="button" className="kiosk-calendar-toggle" data-testid="kiosk-calendar-toggle" ref={toggle}
      aria-label="날짜 선택" title="날짜 선택" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => {
        if (open) { close(); return; }
        setMonth(selected.slice(0, 7)); setFocusedDay(selected); pendingFocus.current = true; setOpen(true);
      }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16" /><path d="M8 15h2" />
      </svg>
    </button>
    {open && <div className="kiosk-calendar-popover" id={id} role="dialog" aria-labelledby={`${id}-month`}>
      <div className="kiosk-calendar-head">
        <button type="button" className="kiosk-calendar-month-prev" aria-label="이전 달" onClick={() => changeMonth(-1)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
        </button>
        <strong id={`${id}-month`} aria-live="polite">{year}년 {monthNumber}월</strong>
        <button type="button" className="kiosk-calendar-month-next" aria-label="다음 달" onClick={() => changeMonth(1)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg>
        </button>
      </div>
      <div className="kiosk-calendar-weekdays" aria-hidden="true">{["일", "월", "화", "수", "목", "금", "토"].map((day, index) => <span key={day} className={index === 0 ? "is-sun" : index === 6 ? "is-sat" : undefined}>{day}</span>)}</div>
      <div className="kiosk-calendar-days">
        {Array.from({ length: firstWeekday }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const key = `${month}-${String(index + 1).padStart(2, "0")}`;
          const weekday = (firstWeekday + index) % 7;
          const holiday = publicHolidayOf(key);
          const isToday = key === today;
          const classes = [key === selected && "is-selected", isToday && "is-today", weekday === 0 && "is-sun", weekday === 6 && "is-sat", holiday && "is-holiday"].filter(Boolean).join(" ");
          return <button type="button" key={key} data-date-key={key} className={classes} aria-pressed={key === selected}
            aria-current={isToday ? "date" : undefined} tabIndex={key === focusedDay ? 0 : -1}
            aria-label={`${year}년 ${formatDateLabel(key)}${holiday ? `, ${holiday.name}` : ""}${isToday ? ", 오늘" : ""}`}
            title={holiday?.name} onClick={() => choose(key)} onFocus={() => setFocusedDay(key)} onKeyDown={event => moveFocus(event, key)}>
            <span>{index + 1}</span>{(holiday || isToday) && <small>{holiday?.calendarLabel ?? "오늘"}</small>}
          </button>;
        })}
      </div>
      <div className="kiosk-calendar-footer"><button type="button" onClick={() => choose(today)}>오늘로 이동</button></div>
    </div>}
  </div>;
}
