"use client";

import { FocusEvent as ReactFocusEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import siteConfig from "./config/site.json";
import equipmentCatalog from "./config/equipment.json";
import officeTeams from "./config/teams.json";
import { type CurrentUser, deleteBookingRequest, type EquipmentSlot, fetchBookings, fetchEquipment, fetchMe, patchBookingRequest, postBookings } from "./lib/api";
import {
  type Booking,
  bookingDefaults,
  expandRepeatDates,
  findConflictingDates,
  layoutOverlappingBookings,
  nearestAvailableSlot,
  type RepeatCycle,
  teamOf,
  timeOptions,
} from "./lib/bookings";
import {
  addMinutes,
  type DateKey,
  dayOfMonth,
  formatDateLabel,
  formatMinutes,
  formatSpokenTime,
  formatWeekday,
  getWorkWeek,
  isWeekend,
  minutesOf,
  moveDate,
  officeMinutesOfDay,
  todayKey,
} from "./lib/datetime";
import { useNow, useStoredText } from "./lib/hooks";
import {
  describeRoomStatus,
  equipmentIcon,
  floors,
  formatCapacity,
  type Room,
  roomById,
  rooms,
  type RoomStatusInfo,
} from "./lib/rooms";

type SlotSelection = {
  roomId: string;
  date: DateKey;
  start: string;
  end: string;
};

type SlotDrag = SlotSelection & {
  anchorY: number;
};

/** 예약 양식의 날짜와 시간. 세 값이 함께 움직여서 하나로 묶어 둔다. */
type SlotForm = {
  date: DateKey;
  start: string;
  end: string;
};

/**
 * 예약 완료를 알리는 짧은 알림.
 * 같은 문구를 연달아 띄워도 새 객체라 표시 시간이 다시 시작된다.
 */
/** 내 예약 한 건을 고쳐 쓰는 중인 값. id로 어떤 예약인지 기억한다. */
type EditDraft = {
  id: string;
  roomId: string;
  date: DateKey;
  start: string;
  end: string;
  purpose: string;
  team: string;
};

type Toast = {
  text: string;
  /** 회의실과 날짜. 시간은 색을 달리 주려고 따로 둔다. */
  detail: string;
  time: string;
};

const OWNER_STORAGE_KEY = "bdo-meeting-owner";
const CLOCK_INTERVAL_MS = 30_000;
const UNKNOWN_STATUS: RoomStatusInfo = {
  status: "unknown",
  statusLabel: "확인 중",
  nextLabel: "현황 불러오는 중",
};

const startTimeOptions = timeOptions.slice(0, -1);
const timelineStart = siteConfig.timeline.startHour * 60;
const timelineEnd = siteConfig.timeline.endHour * 60;
const timelineHours = Array.from(
  { length: siteConfig.timeline.endHour - siteConfig.timeline.startHour + 1 },
  (_, index) => siteConfig.timeline.startHour + index,
);
const lastSelectableTime = timeOptions[timeOptions.length - 1];
/** 반복 예약은 평일만 지원한다. 매주 반복은 실제로 쓰이지 않아 없앴다. */
const REPEAT_CYCLE: RepeatCycle = "weekdays";

/**
 * 날짜 앞뒤 이동 꺾쇠.
 * 글꼴 문자(‹ ›)는 기준선 때문에 버튼 안에서 세로 중앙이 맞지 않아 도형으로 그린다.
 */
function ChevronIcon({ direction }: { direction: "prev" | "next" }) {
  return (
    <svg viewBox="0 0 9 15" fill="none" aria-hidden="true" focusable="false">
      <path
        d={direction === "prev" ? "M7 1.5 1.75 7.5 7 13.5" : "M2 1.5 7.25 7.5 2 13.5"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 창 닫기 ×. 글자 ×는 글꼴마다 크기·굵기가 달라 도형으로 그린다. */
function CloseIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
      <path d="M2 2 12 12M12 2 2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 배치도를 여는 자리 표시 핀. */
function PinIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path d="M10 18s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10Z" fill="currentColor" />
      <circle cx="10" cy="8" r="2.4" fill="#fff" />
    </svg>
  );
}

/** 날짜 선택 달력 아이콘. 안의 점은 날짜가 골라져 있다는 표시다. */
function CalendarIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <rect x="2.5" y="4.25" width="15" height="13.25" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.5 8.25h15" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.75 2.5v3.25M13.25 2.5v3.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <rect className="calendar-icon-dot" x="5.75" y="10.75" width="3.25" height="3.25" rx="1" fill="currentColor" />
    </svg>
  );
}

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

/** 비품 id → 이름. 예약에는 id만 남아 있어, 「내 예약」처럼 나중에 다시 보여줄 때 필요하다. */
const equipmentNameById = new Map(equipmentCatalog.items.map((item) => [item.id, item.name]));
const equipmentLabel = (id: string) => equipmentNameById.get(id) ?? id;

/** 예약에 딸린 비품을 "화상카메라 1 · 노트북 2"처럼 한 줄로. 없으면 빈 문자열. */
const equipmentSummary = (booking: Booking): string =>
  Object.entries(booking.equipment ?? {})
    .filter(([, count]) => count > 0)
    .map(([id, count]) => `${equipmentLabel(id)} ${count}`)
    .join(" · ");

/** "8/19". 일간 제목은 숫자만 크게 쓰므로 '월·일' 글자를 덜어낸다. */
const slashDate = (key: DateKey): string => `${Number(key.slice(5, 7))}/${dayOfMonth(key)}`;

/** 100분 → "1시간 40분". 시각(01:40)과 헷갈리지 않게 말로 적는다. */
const spokenDuration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}분`;
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
};


/**
 * "8월 3주차". 그 달의 몇 번째 주인지 숫자로 적는다.
 * 날짜 범위(8월 17–21일)는 제목으로 쓰기엔 너무 길고, 달을 걸치면 두 배가 된다.
 * 기준은 그 주 월요일이 속한 달이다.
 */
const weekOfMonthLabel = (key: DateKey): string => {
  const [, month, day] = key.split("-").map(Number);
  return `${month}월 ${Math.floor((day - 1) / 7) + 1}주차`;
};
const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * 날짜 입력칸. 브라우저 기본 달력은 위치와 모양을 바꿀 수 없어 직접 그린다.
 * 달력은 입력칸 오른쪽 끝선에 맞춰 열린다.
 */
function DateField({ value, min, onChange, rangeFrom, onRangeChange, variant = "field", allowAnyDate = false, openOnMount = false, skipWeekends = true, onSkipWeekendsChange, onDone }: {
  value: DateKey;
  min?: DateKey;
  onChange: (next: DateKey) => void;
  /** "icon"은 달력 아이콘만 보이는 형태. 예약현황 제어줄에서 쓴다. */
  variant?: "field" | "icon";
  /** 지난 날짜와 주말도 고를 수 있게 한다(예약이 아니라 현황을 볼 때). */
  allowAnyDate?: boolean;
  /**
   * 기간 고르기(반복 예약)에 쓴다. value가 종료일, rangeFrom이 시작일이다.
   * 끌면 시작·종료를 함께 바꾸고, 한 번만 누르면 시작일만 옮긴다.
   */
  rangeFrom?: DateKey;
  onRangeChange?: (start: DateKey, end: DateKey) => void;
  /** 칸이 나타나는 것 자체가 '날짜를 고르라'는 뜻일 때 달력을 바로 펼친다. */
  openOnMount?: boolean;
  /**
   * 기간 안의 토·일을 건너뛸지. 끄면 달력에서도 주말이 회색으로 빠지지 않는다.
   * 달력 아래 '주말 포함' 체크로 바꾼다.
   */
  skipWeekends?: boolean;
  onSkipWeekendsChange?: (skip: boolean) => void;
  /** 기간 고르기에서 '완료'를 눌러 달력을 닫았을 때. */
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(openOnMount);
  const [viewMonth, setViewMonth] = useState(() => value.slice(0, 7));
  const [dragging, setDragging] = useState(false);
  const [dragFrom, setDragFrom] = useState<DateKey | null>(null);
  const [dragTo, setDragTo] = useState<DateKey | null>(null);
  // 기간 고르기에서 지금 무엇을 고르는 중인지. 위의 시작일·종료일 상자로 바꾼다.
  const [pickTarget, setPickTarget] = useState<"start" | "end">("start");
  // 기간을 다 골랐는지. 다 골랐어도 창은 닫지 않고 '완료'를 기다린다.
  const [rangeSettled, setRangeSettled] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 달력을 새로 열 때는 언제나 시작일부터 고른다.
  useEffect(() => { if (open) { setPickTarget("start"); setRangeSettled(false); } }, [open]);

  // 값이 바깥에서 바뀌면(예: 빈 시간 자동 선택) 그 달을 보여 준다.
  useEffect(() => { setViewMonth(value.slice(0, 7)); }, [value]);

  /**
   * 예약 폼은 입력칸 영역만 스크롤되는데, 달력이 그보다 커서 위아래 어느 쪽으로
   * 펼쳐도 잘린다. 그 안에서 열릴 때는 화면 기준(fixed)으로 띄워 잘리지 않게 한다.
   */
  const [floatAt, setFloatAt] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!open) {
      setFloatAt(null);
      return;
    }
    const wrap = wrapRef.current;
    const panel = wrap?.querySelector<HTMLElement>(".date-panel");
    if (!wrap || !panel || !wrap.closest(".booking-fields")) return;

    const pane = wrap.closest<HTMLElement>(".booking-fields");

    /**
     * makeRoom을 켜면(처음 열 때만) 아래가 모자랄 때 입력칸 영역을 굴려 자리를
     * 만든다. 다시 자리를 잡을 때는 굴리지 않는다 — 스크롤이 또 스크롤을 부른다.
     */
    const place = (makeRoom: boolean) => {
      const height = panel.offsetHeight;
      const room = () => window.innerHeight - 8 - (wrap.getBoundingClientRect().bottom + 6);

      // 아래가 모자라면 위로 뒤집지 않고, 입력칸 영역을 굴려 자리를 만든다.
      // 위로 열면 방금 정한 날짜·시간을 전부 덮어 버린다.
      const short = height - room();
      if (makeRoom && short > 0 && pane) {
        const room4Scroll = Math.min(short, pane.scrollHeight - pane.clientHeight - pane.scrollTop);
        if (room4Scroll > 0) pane.scrollTop += room4Scroll;
      }

      const box = wrap.getBoundingClientRect();
      // 끝까지 굴려도 모자라면 화면 아래에 붙여 둔다. 그래도 위로는 열지 않는다.
      const top = Math.min(box.bottom + 6, Math.max(8, window.innerHeight - 8 - height));
      const left = Math.max(8, box.right - panel.offsetWidth);
      // 값이 그대로면 다시 그리지 않는다. 스크롤마다 상태를 바꾸면 끌기가 끊긴다.
      setFloatAt((current) =>
        current && Math.abs(current.left - left) < 1 && Math.abs(current.top - top) < 1
          ? current
          : { left, top });
    };
    place(true);
    // 예전에는 스크롤이 나면 닫아 버렸다. 그래서 날짜를 고르는 순간
    // 화면이 다시 그려지며 생긴 스크롤에도 달력이 사라졌다.
    // 닫는 것은 사람이 정한다. 여기서는 자리만 다시 잡는다.
    const follow = () => place(false);
    window.addEventListener("resize", follow);
    document.addEventListener("scroll", follow, true);
    return () => {
      window.removeEventListener("resize", follow);
      document.removeEventListener("scroll", follow, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // 끌기가 달력 밖에서 끝나도 선택이 확정되도록 창 전체에서 마우스 뗌을 듣는다.
  useEffect(() => {
    if (!dragging) return;
    const finish = () => {
      if (dragFrom && dragTo && onRangeChange) {
        const moved = dragFrom !== dragTo;
        // 다 골라도 창은 닫지 않는다. 고른 기간이 맞는지 눈으로 확인하고
        // 아래 '완료'로 직접 닫게 한다. 바로 닫히면 제대로 골랐는지 알 수 없다.
        if (moved) {
          // 끌었으면 기간을 통째로 정한다.
          const [first, last] = dragFrom <= dragTo ? [dragFrom, dragTo] : [dragTo, dragFrom];
          onRangeChange(first, last);
          setPickTarget("end");
          setRangeSettled(true);
        } else if (pickTarget === "start") {
          // 시작일을 골랐으면 종료일 차례.
          onRangeChange(dragFrom, value >= dragFrom ? value : dragFrom);
          setPickTarget("end");
        } else {
          // 종료일. 시작일보다 앞을 고르면 둘을 뒤집는다.
          const from = rangeFrom ?? dragFrom;
          const [first, last] = dragFrom >= from ? [from, dragFrom] : [dragFrom, from];
          onRangeChange(first, last);
          setPickTarget("end");
          setRangeSettled(true);
        }
      }
      setDragging(false);
      setDragFrom(null);
      setDragTo(null);
    };
    document.addEventListener("pointerup", finish);
    return () => document.removeEventListener("pointerup", finish);
  }, [dragging, dragFrom, dragTo, onRangeChange, value, pickTarget, rangeFrom]);

  const [year, month] = viewMonth.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // 지난 날짜에는 예약할 수 없다. 반복 종료일처럼 별도 하한이 있으면 늦은 쪽을 쓴다.
  const todayValue = todayKey();
  // 현황 보기용 달력은 하한이 없다(빈 문자열이면 어떤 날짜와 비교해도 걸리지 않는다).
  const earliest = allowAnyDate ? "" : (min && min > todayValue ? min : todayValue);
  // 끄는 중에는 미리보기, 아니면 실제 값으로 칠한다.
  const previewFrom = dragFrom && dragTo ? (dragFrom <= dragTo ? dragFrom : dragTo) : rangeFrom;
  const previewTo = dragFrom && dragTo ? (dragFrom <= dragTo ? dragTo : dragFrom) : (rangeFrom ? value : undefined);
  const shiftMonth = (step: number) => {
    const moved = new Date(Date.UTC(year, month - 1 + step, 1));
    setViewMonth(`${moved.getUTCFullYear()}-${pad2(moved.getUTCMonth() + 1)}`);
  };

  return (
    <div className={`date-field${variant === "icon" ? " date-field-icon" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="date-field-value"
        aria-expanded={open}
        aria-label={variant === "icon" ? "날짜 선택" : undefined}
        title={variant === "icon" ? formatDateLabel(value) : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {/* 왼쪽 머리줄은 '8월 17일 (월)'로 쓰는데 여기만 '2026-08-17'이라 달랐다. */}
        {variant === "field" && <span>{formatDateLabel(value)}</span>}
        <CalendarIcon />
      </button>
      {open && (
        <div
          className={`date-panel${floatAt ? " date-panel-float" : ""}`}
          style={floatAt ? { position: "fixed", left: floatAt.left, top: floatAt.top, right: "auto" } : undefined}
          role="dialog"
          aria-label="날짜 선택"
        >
          <div className="date-panel-head">
            <button type="button" aria-label="이전 달" disabled={viewMonth <= earliest.slice(0, 7)} onClick={() => shiftMonth(-1)}><ChevronIcon direction="prev" /></button>
            <b>{month}월 <em>{year}</em></b>
            <button type="button" aria-label="다음 달" onClick={() => shiftMonth(1)}><ChevronIcon direction="next" /></button>
          </div>
          {rangeFrom && (
            <div className="date-panel-range">
              {/* 두 규칙을 한 줄에 욱여넣지 않고, 지금 무엇을 고르는 중인지만 말한다. */}
              <p>{rangeSettled
                ? "선택한 기간이 맞으면 아래 완료를 누르세요"
                : pickTarget === "start"
                  ? "시작일을 고르세요 · 드래그하면 기간을 한 번에"
                  : "종료일을 고르세요"}</p>
              <div>
                <button
                  type="button"
                  className={pickTarget === "start" ? "active" : ""}
                  onClick={() => setPickTarget("start")}
                ><b>시작일</b>{formatDateLabel(previewFrom ?? rangeFrom)}</button>
                <i aria-hidden="true">→</i>
                <button
                  type="button"
                  className={pickTarget === "end" ? "active" : ""}
                  onClick={() => setPickTarget("end")}
                ><b>종료일</b>{formatDateLabel(previewTo ?? value)}</button>
              </div>
            </div>
          )}
          <div className="date-panel-dow">
            {WEEKDAY_LABELS.map((label, index) => (
              <span key={label} className={index === 0 ? "is-sun" : index === 6 ? "is-sat" : undefined}>{label}</span>
            ))}
          </div>
          <div className="date-panel-grid">
            {Array.from({ length: firstWeekday }, (_, index) => <span key={`blank-${index}`} />)}
            {Array.from({ length: lastDay }, (_, index) => {
              const day = index + 1;
              const key = `${year}-${pad2(month)}-${pad2(day)}`;
              // 주말 예약을 막아 둔 설정에서만 토·일을 고를 수 없다.
              const disabled = !allowAnyDate && (key < earliest || (!bookingDefaults.allowWeekends && isWeekend(key)));
              const isToday = key === todayValue;
              // 고를 수 있더라도 주말은 한눈에 구분되도록 색을 달리한다.
              const weekdayIndex = (firstWeekday + index) % 7;
              const weekendClass = weekdayIndex === 0 ? "is-sun" : weekdayIndex === 6 ? "is-sat" : "";
              const inRange = Boolean(previewFrom && previewTo && key > previewFrom && key < previewTo);
              // 기간 고르기는 반복 예약에만 쓰고 반복은 평일만 잡히므로,
              // 범위 안의 주말은 칠하지 않고 빠지는 날로 보여 준다.
              const skipped = inRange && Boolean(rangeFrom) && weekendClass !== "" && skipWeekends;
              const isEdge = rangeFrom
                ? key === previewFrom || key === previewTo
                : key === value;
              return (
                <button
                  type="button"
                  key={key}
                  // 고를 수 없는 날도 disabled 대신 표시만 막는다.
                  // disabled면 마우스 이벤트가 오지 않아 그 위를 지나는 순간 끌기가 끊긴다.
                  aria-disabled={disabled}
                  className={`${isEdge ? "selected" : ""} ${inRange && !skipped ? "in-range" : ""} ${skipped ? "range-skip" : ""} ${disabled ? "disabled" : ""} ${isToday ? "is-today" : ""} ${weekendClass}`}
                  onPointerDown={(event) => {
                    if (!rangeFrom || disabled) return;
                    // 끌기 도중 글자 선택이나 기본 끌기 동작이 끼어들지 않게 한다.
                    event.preventDefault();
                    setDragging(true);
                    setDragFrom(key);
                    setDragTo(key);
                  }}
                  onPointerMove={() => { if (dragging && !disabled && dragTo !== key) setDragTo(key); }}
                  onClick={() => { if (!disabled && !rangeFrom) { onChange(key); setOpen(false); } }}
                >
                  {day}
                  {isToday && <em>오늘</em>}
                </button>
              );
            })}
          </div>
          {/* 반복은 평일만 잡는 것이 기본이다. 주말에도 회의를 잡아야 하는
              사람을 위해 달력 안에 한 칸만 둔다. 켜면 회색으로 빠진 토·일이
              그 자리에서 곧바로 살아나므로 결과를 눈으로 보고 정할 수 있다. */}
          {(onSkipWeekendsChange || rangeFrom) && (
            <div className="date-panel-foot">
              {onSkipWeekendsChange && (
                <label className="date-panel-weekend">
                  <input
                    type="checkbox"
                    checked={!skipWeekends}
                    onChange={(event) => onSkipWeekendsChange(!event.target.checked)}
                  />
                  <span>주말 포함</span>
                  <em>{skipWeekends ? "토·일은 건너뜁니다" : "토·일도 예약합니다"}</em>
                </label>
              )}
              {/* 기간 고르기는 스스로 닫지 않는다. 닫는 것은 사람이 정한다. */}
              {rangeFrom && (
                <button
                  type="button"
                  className="date-panel-done"
                  onClick={() => { setOpen(false); onDone?.(); }}
                >완료</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RoomDetailPopover({
  room,
  status,
  date,
  bookings,
  onClose,
}: {
  room: Room;
  status: RoomStatusInfo;
  date: DateKey;
  bookings: Booking[];
  onClose: () => void;
}) {
  return (
    <section className="room-popover" role="dialog" aria-labelledby="room-popover-title">
      <button className="room-modal-close" type="button" aria-label="회의실 상세 창 닫기" onClick={onClose}><CloseIcon /></button>
      <p className="room-modal-kicker">선택된 회의실</p>
      <div className="modal-room-overview">
        <div className="modal-room-copy">
          <span className={`modal-status ${status.status}`}><i />{status.statusLabel}</span>
          <h3 id="room-popover-title">{room.name} <small>({room.floor}층)</small></h3>
          <p>{room.location}</p>
        </div>
      </div>
      <div className="popover-facts">
        <span><b>수용 인원</b>{formatCapacity(room.capacity)}</span>
        <span><b>예약 일정</b>{formatDateLabel(date)}</span>
      </div>
      <div className="modal-equipment compact-equipment">
        <strong>장비</strong>
        <div>{room.equipment.map((item) => <span key={item}><b>{equipmentIcon(item)}</b><em>{item}</em></span>)}</div>
      </div>
      <div className="modal-schedule-list compact-schedule">
        {bookings.length ? bookings.map((booking) => (
          <div key={booking.id}>
            <time>{booking.start}–{booking.end}</time>
            <span><strong>{booking.purpose}</strong><small>{booking.owner} · {teamOf(booking)}</small></span>
          </div>
        )) : <p>선택한 날짜에는 예약이 없습니다.</p>}
      </div>
      {/* 배치도에서는 예약하지 않는다. 어디에 있는 방인지 보는 곳이고,
          예약은 오른쪽 '빠른 예약' 한 곳에서만 끝낸다. */}
    </section>
  );
}

function ReservationHoverCard({ booking, room }: { booking: Booking; room: Room }) {
  return <span className="reservation-hover-card" role="tooltip">
    <strong>{booking.purpose}</strong>
    <span><b>일시</b>{formatDateLabel(booking.date)} · {booking.start}–{booking.end}</span>
    <span><b>회의실</b>{room.name}</span>
    <span><b>예약자</b>{booking.owner} · {teamOf(booking)}</span>
  </span>;
}

export default function Home() {
  // 현재 시각은 브라우저에서만 알 수 있다. 서버 렌더링 중에는 null이다.
  const clock = useNow(CLOCK_INTERVAL_MS);
  const today = todayKey(clock ?? undefined);
  const nowMinutes = clock ? officeMinutesOfDay(clock) : null;

  const [floor, setFloor] = useState<number>(floors[0]);
  const [selectedId, setSelectedId] = useState(rooms[0].id);
  const [scheduleView, setScheduleView] = useState<"week" | "day">("day");
  const [query, setQuery] = useState("");
  const [duration, setDuration] = useState(bookingDefaults.defaultDurationMinutes);
  const [slot, setSlot] = useState<SlotForm>(() =>
    nearestAvailableSlot(clock, bookingDefaults.defaultDurationMinutes),
  );
  // MS 로그인이 붙기 전까지 쓰는 시험용 기본값. site.json의 testUser에서 온다.
  // 로그인이 붙으면 이 줄과 site.json의 testUser를 지우면 된다.
  const [owner, setOwner] = useState(siteConfig.testUser?.name ?? "");
  const [team, setTeam] = useState(siteConfig.testUser?.team ?? "");
  const [teamOpen, setTeamOpen] = useState(false);
  const [teamActiveIndex, setTeamActiveIndex] = useState(0);
  const [purpose, setPurpose] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);
  const [attendeeDraft, setAttendeeDraft] = useState("");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [syncError, setSyncError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // SSO 모드에서는 로그인 계정이 예약자다. null이면 익명 모드(이름 직접 입력).
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [mapDetailId, setMapDetailId] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  // 배치도를 어느 버튼으로 열었는지는 더 이상 크기를 가르지 않는다.
  // 상단 배치도 버튼으로 연 것이 화면을 거의 다 덮을 만큼 커서, 회의실
  // 고를 때 쓰는 작은 크기로 통일했다. 값 자체는 다른 동작에 안 쓰여
  // 상태만 남겨 둔다.
  const [mapPurpose, setMapPurpose] = useState<"browse" | "pick">("browse");
  const [allDay, setAllDay] = useState(false);
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  // 반복은 평일만 잡는 것이 기본이다. 주말에도 회의를 잡는 사람을 위해
  // 달력 안에서 켤 수 있게 한다. (단건 예약은 원래 토·일도 된다)
  const [repeatWeekends, setRepeatWeekends] = useState(false);
  // 사용자가 달력에서 직접 고르기 전까지는 반복 종료일이 예약 날짜를 따라다닌다.
  const [repeatEndTouched, setRepeatEndTouched] = useState(false);
  const [repeatEnd, setRepeatEnd] = useState(() =>
    moveDate(todayKey(clock ?? undefined), bookingDefaults.defaultRepeatSpanDays),
  );
  const [myBookingsOpen, setMyBookingsOpen] = useState(false);
  const [myBookingOwner, setMyBookingOwner] = useStoredText(OWNER_STORAGE_KEY);
  // '내 예약'도 시험용 이름으로 바로 채워 둔다. 예전에 다른 이름으로 예약한
  // 기록이 남아 있으면 그것을 그대로 쓴다.
  useEffect(() => {
    if (!myBookingOwner && siteConfig.testUser?.name) setMyBookingOwner(siteConfig.testUser.name);
  }, [myBookingOwner, setMyBookingOwner]);
  // 취소는 여러 건을 골라 한 번에 한다. null이면 고르는 중이 아니다.
  const [cancelSelection, setCancelSelection] = useState<string[] | null>(null);
  // 취소는 되돌릴 수 없다. 누르는 즉시 지우지 말고 무엇이 사라지는지 먼저 보여준다.
  const [cancelAsk, setCancelAsk] = useState<string[] | null>(null);
  // 비어 있는 필수 칸. 브라우저가 그리는 흰 말풍선(required) 대신 우리가 표시한다.
  // 말풍선은 모양·문구를 바꿀 수 없고 화면 밖이면 보이지도 않는다.
  const [missingField, setMissingField] = useState<"owner" | "team" | "purpose" | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  // 참석자 칸은 선택 항목이라 접어 둔다.
  const [attendeesOpen, setAttendeesOpen] = useState(false);
  // 비품 요청도 선택 항목이라 접어 둔다. 재고는 고른 시간대 기준으로 서버에서 받는다.
  const [equipmentOpen, setEquipmentOpen] = useState(false);
  const [equipmentSlots, setEquipmentSlots] = useState<EquipmentSlot[]>([]);
  const [equipment, setEquipment] = useState<Record<string, number>>({});
  const equipmentCount = Object.values(equipment).reduce((sum, count) => sum + count, 0);
  // 조기 종료 확인 창에 띄울 예약.
  const [earlyEnd, setEarlyEnd] = useState<Booking | null>(null);
  const [earlyEndBusy, setEarlyEndBusy] = useState(false);
  // 주간 확인 창을 누른 자리에 띄우기 위한 좌표.
  const [confirmAt, setConfirmAt] = useState<{ x: number; y: number } | null>(null);
  // 표에서 값을 가져온 뒤 아직 예약하기를 누르지 않은 상태. 표의 점선 블록과
  // 패널의 '작성 중' 딱지를 띄우는 근거가 된다. 예약이 끝나면 내린다.
  const [draftActive, setDraftActive] = useState(false);
  // 표·배치도에서 값을 가져왔을 때 잠깐 띄우는 알림.
  const [filledNotice, setFilledNotice] = useState<{ title: string; detail: string } | null>(null);
  const filledTimer = useRef<number | null>(null);
  // 반복 예약 중 며칠만 이미 차 있을 때 "나머지만 예약할까요?"를 묻기 위한 값.
  const [repeatAsk, setRepeatAsk] = useState<{ conflicts: string[]; free: string[] } | null>(null);
  // 예약 현황에서 내 예약을 눌렀을 때 여는 수정 창.
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editNotice, setEditNotice] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editConfirmDelete, setEditConfirmDelete] = useState(false);
  const [bookingPanelOpen, setBookingPanelOpen] = useState(false);
  const [slotDrag, setSlotDrag] = useState<SlotDrag | null>(null);
  const [slotConfirmation, setSlotConfirmation] = useState<SlotSelection | null>(null);
  // 주간 화면 더블클릭은 일간 드래그와 달리 시간을 정한 적이 없다.
  // 회의실·날짜만 고르고, 시간은 빠른 예약 창에서 직접 고르게 한다.
  const [weeklyPick, setWeeklyPick] = useState<{ roomId: Room["id"]; date: DateKey } | null>(null);
  // 주간 더블클릭으로 넘어온 뒤, 시간을 아직 스스로 고르지 않았다는 표시.
  // 시작·종료 시간 중 하나라도 바꾸면 풀린다.
  const [timeNeedsPick, setTimeNeedsPick] = useState(false);

  const { date, start, end } = slot;
  const setDate = (next: DateKey) => setSlot((current) => ({ ...current, date: next }));

  // 예약의 진실의 원천은 서버 DB다. 30초 주기 + 창 포커스 시 다시 읽어
  // 다른 사람이 잡은 예약을 화면에 반영한다.
  const refreshBookings = useCallback(async () => {
    try {
      setBookings(await fetchBookings());
      setSyncError("");
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "서버와 통신할 수 없습니다.");
    }
  }, []);

  useEffect(() => {
    void refreshBookings();
    const timer = window.setInterval(() => { void refreshBookings(); }, CLOCK_INTERVAL_MS);
    const refreshOnFocus = () => { void refreshBookings(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [refreshBookings]);

  // 날짜·시간이 바뀌면 그 시간대의 남은 비품 수를 다시 받아 온다.
  useEffect(() => {
    let alive = true;
    void fetchEquipment(slot.date, slot.start, slot.end).then((items) => {
      if (!alive) return;
      setEquipmentSlots(items);
      // 남은 수량이 줄었으면 요청 수량도 따라 줄인다.
      setEquipment((current) => {
        const next: Record<string, number> = {};
        for (const item of items) {
          const wanted = Math.min(current[item.id] ?? 0, item.left);
          if (wanted > 0) next[item.id] = wanted;
        }
        return next;
      });
    });
    return () => { alive = false; };
  }, [slot.date, slot.start, slot.end, bookings]);

  // 아직 직접 고르지 않았다면 반복 종료일을 예약 날짜 기준으로 다시 잡는다.
  useEffect(() => {
    if (repeatEndTouched) return;
    setRepeatEnd(moveDate(date, bookingDefaults.defaultRepeatSpanDays));
  }, [date, repeatEndTouched]);

  useEffect(() => {
    void fetchMe().then((user) => {
      if (!user) return;
      setCurrentUser(user);
      setOwner(user.name);
      setMyBookingOwner(user.name);
    });
    // setMyBookingOwner는 useStoredText가 주는 안정된 setter라 의존성에 넣지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mapDetailId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMapDetailId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mapDetailId]);

  // 회의실 상태는 오늘 예약과 현재 시각에서 계산한다. 고정값이 아니다.
  // 상태는 '보고 있는 날짜' 기준으로 낸다. 예전에는 늘 오늘 예약만 봐서,
  // 다음 주를 보고 있어도 "사용 가능"이 오늘 기준으로 떠 있었다.
  const roomStatuses = useMemo(() => {
    const viewingToday = date === today;
    const byRoom = new Map<string, Booking[]>();
    for (const booking of bookings) {
      if (booking.date !== date) continue;
      const list = byRoom.get(booking.roomId);
      if (list) list.push(booking);
      else byRoom.set(booking.roomId, [booking]);
    }
    return new Map(
      rooms.map((room) => [
        room.id,
        describeRoomStatus(byRoom.get(room.id) ?? [], nowMinutes, { isToday: viewingToday }),
      ]),
    );
  }, [bookings, date, today, nowMinutes]);

  const statusOf = (room: Room) => roomStatuses.get(room.id) ?? UNKNOWN_STATUS;

  const floorRooms = rooms
    .filter((room) => room.floor === floor)
    .sort((a, b) => Number(b.id === "12-big") - Number(a.id === "12-big"));
  const filteredRooms = floorRooms.filter((room) => {
    const haystack = `${room.name} ${formatCapacity(room.capacity)} ${room.location} ${room.equipment.join(" ")}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });
  const selected = roomById(selectedId) ?? rooms[0];
  const selectedStatus = statusOf(selected);

  // 달력의 '주말 포함'을 켜면 토·일도 빠짐없이 잡는다.
  const repeatCycle: RepeatCycle = repeatWeekends ? "everyday" : REPEAT_CYCLE;
  // 반복 예약이면 전체 회차를, 아니면 그날 하루만 검사한다.
  const reservationDates = useMemo(
    () => (repeatWeekly ? expandRepeatDates(date, repeatEnd, repeatCycle) : [date]),
    [repeatWeekly, date, repeatEnd, repeatCycle],
  );
  const conflictDates = useMemo(
    () => findConflictingDates(bookings, selected.id, reservationDates, start, end),
    [bookings, selected.id, reservationDates, start, end],
  );
  const selectedTimeConflict = conflictDates.length > 0;

  const visibleStartTimeOptions = duration
    ? startTimeOptions.filter((time) => minutesOf(time) + duration <= minutesOf(lastSelectableTime))
    : startTimeOptions;
  const availableCount = floorRooms.filter((room) => statusOf(room).status === "available").length;
  const weekDays = useMemo(() => getWorkWeek(date), [date]);
  // 주간 화면에서는 날짜 칸이 한 주를 통째로 가리키고 화살표도 일주일씩 움직인다.
  const weekView = scheduleView === "week";
  // 같은 주인지는 월요일끼리 비교한다. 오늘이 토·일이면 월~금 목록에 없어서
  // 목록 포함 여부로 보면 '이번 주'가 표시되지 않는다.
  const thisWeek = weekDays[0] === getWorkWeek(today)[0];
  const mapDetail = mapDetailId ? roomById(mapDetailId) ?? null : null;
  const filteredTeams = officeTeams
    .filter((item) => item.name.toLowerCase().includes(team.trim().toLowerCase()))
    .slice(0, 8);
  const mapDetailBookings = mapDetail
    ? bookings.filter((booking) => booking.roomId === mapDetail.id && booking.date === date).sort((a, b) => a.start.localeCompare(b.start))
    : [];
  const currentTimePercent = nowMinutes !== null && nowMinutes >= timelineStart && nowMinutes <= timelineEnd
    ? ((nowMinutes - timelineStart) / (timelineEnd - timelineStart)) * 100
    : null;
  const showCurrentTime = currentTimePercent !== null && (scheduleView === "week" ? weekDays.includes(today) : date === today);

  // 일간 보기의 현재 시각 선. 회의실 칸(그리드 트랙)이 1fr(가변)이라 CSS의
  // top:%만으로는 세로 위치가 안정적으로 잡히지 않아, 칸들의 실제 픽셀
  // 크기를 재서 하나의 선으로 그린다. 이렇게 하면 회의실 카드 사이 여백에서
  // 선이 끊기지 않는다.
  const dailyGridRef = useRef<HTMLDivElement | null>(null);
  const [dailyGridMetrics, setDailyGridMetrics] = useState<{
    left: number; width: number; bodyTop: number; bodyHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    const grid = dailyGridRef.current;
    if (!grid) { setDailyGridMetrics(null); return; }

    const measure = () => {
      const bodies = grid.querySelectorAll<HTMLElement>(".timeline-day-body");
      if (!bodies.length) { setDailyGridMetrics(null); return; }
      const gridRect = grid.getBoundingClientRect();
      const first = bodies[0].getBoundingClientRect();
      const last = bodies[bodies.length - 1].getBoundingClientRect();
      setDailyGridMetrics({
        left: first.left - gridRect.left,
        width: last.right - first.left,
        bodyTop: first.top - gridRect.top,
        bodyHeight: first.height,
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [scheduleView, floor, floorRooms.length]);

  /** 층마다 지금 비어 있는 회의실 수. 층을 고르기 전에 알 수 있어야 한다. */
  const floorAvailability = floors.map((item) => {
    const list = rooms.filter((room) => room.floor === item);
    return { floor: item, free: list.filter((room) => statusOf(room).status === "available").length, total: list.length };
  });
  const myBookings = useMemo(() => bookings
    .filter((booking) => myBookingOwner.trim() && booking.owner === myBookingOwner.trim())
    .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)), [bookings, myBookingOwner]);
  const upcomingMyBookings = myBookings.filter((booking) => booking.date >= today);
  const pastMyBookings = myBookings.filter((booking) => booking.date < today).reverse();
  /** 예정 예약을 위, 지난 예약을 아래에 둔 한 벌의 표 데이터. */
  const myBookingRows = [
    ...upcomingMyBookings.map((booking) => ({ booking, upcoming: true })),
    ...pastMyBookings.map((booking) => ({ booking, upcoming: false })),
  ];

  const selectFloor = (nextFloor: number) => {
    setFloor(nextFloor);
    setSelectedId(rooms.find((room) => room.floor === nextFloor)?.id ?? selectedId);
    setMapDetailId(null);
    setNotice("");
  };

  const selectRoom = (room: Room, showMapDetail = false) => {
    setSelectedId(room.id);
    // 다른 층 회의실을 고르면 일정표도 그 층으로 따라간다.
    setRoomPickerOpen(false);
    setFloor(room.floor);
    setMapDetailId(showMapDetail ? room.id : null);
    setNotice("");
  };

  /** 내가 등록한 예약인지. 서버도 같은 검사를 하지만 화면에서 먼저 걸러 준다. */
  const isMyBooking = (booking: Booking) =>
    Boolean(myBookingOwner.trim()) && booking.owner === myBookingOwner.trim();

  /** 반복 예약처럼 회의실·시간·목적이 같은 한 벌. 한꺼번에 고를 때 쓴다. */
  const sameSeriesIds = (booking: Booking) => upcomingMyBookings
    .filter((item) => item.roomId === booking.roomId && item.start === booking.start
      && item.end === booking.end && item.purpose === booking.purpose)
    .map((item) => item.id);

  const cancelBookings = async (ids: string[]) => {
    if (ids.length === 0) return;
    setCancelBusy(true);
    const results = await Promise.all(ids.map((id) => deleteBookingRequest(id, myBookingOwner.trim())));
    setCancelBusy(false);
    setCancelSelection(null);
    await refreshBookings();
    // 새로고침이 성공하면 syncError가 비워지므로, 취소 실패 메시지는 그 뒤에 얹는다.
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) setSyncError(failed.message);
    else setToast({ text: `예약 ${ids.length}건을 취소했습니다.`, detail: "내 예약", time: "" });
  };

  const openEditor = (booking: Booking) => {
    if (!isMyBooking(booking)) return;
    // 지난 예약은 기록으로 남아야 한다. "내 예약" 목록에서는 지난 항목에
    // 버튼을 두지 않는 것과 같은 규칙을, 일정표에서 블록을 눌렀을 때도
    // 적용한다. 서버도 같은 검사를 하지만(past 응답) 열어놓고 저장 시점에
    // 막는 것보다, 열리지 않는 쪽이 헷갈리지 않는다.
    if (booking.date < today) return;
    setEditDraft({
      id: booking.id,
      roomId: booking.roomId,
      date: booking.date,
      start: booking.start,
      end: booking.end,
      purpose: booking.purpose,
      team: booking.team ?? "",
    });
    setEditNotice("");
    setEditConfirmDelete(false);
  };

  const saveEdit = async () => {
    if (!editDraft) return;
    if (editDraft.end <= editDraft.start) {
      setEditNotice("종료 시간은 시작 시간보다 늦어야 합니다.");
      return;
    }
    if (!editDraft.purpose.trim()) {
      setEditNotice("회의 목적을 입력해 주세요.");
      return;
    }
    setEditBusy(true);
    const result = await patchBookingRequest(editDraft.id, {
      roomId: editDraft.roomId,
      date: editDraft.date,
      start: editDraft.start,
      end: editDraft.end,
      owner: myBookingOwner.trim(),
      team: editDraft.team,
      purpose: editDraft.purpose,
    });
    setEditBusy(false);
    if (!result.ok) {
      setEditNotice(result.message);
      return;
    }
    await refreshBookings();
    setEditDraft(null);
    setToast({
      text: "예약을 수정했습니다.",
      detail: roomById(editDraft.roomId)?.name ?? "",
      time: `${formatDateLabel(editDraft.date)} ${editDraft.start}–${editDraft.end}`,
    });
  };

  /**
   * 조기 종료. 지금 시각을 10분 단위로 올림해 종료 시간으로 삼는다.
   * 13:47에 누르면 13:50으로 끝나 어중간한 끝시각이 생기지 않는다.
   */
  const earlyEndTime = (booking: Booking): string => {
    if (nowMinutes === null) return booking.end;
    const rounded = Math.ceil(nowMinutes / 10) * 10;
    // 시작 직후에 눌러도 최소 10분은 남기고, 원래 종료 시간을 넘지는 않는다.
    const floor = minutesOf(booking.start) + 10;
    return formatMinutes(Math.min(Math.max(rounded, floor), minutesOf(booking.end)));
  };

  /** 지금 진행 중인 내 예약인가. 조기 종료 버튼은 이때만 뜬다. */
  const isRunningNow = (booking: Booking): boolean =>
    isMyBooking(booking) && booking.date === today && nowMinutes !== null
    && minutesOf(booking.start) <= nowMinutes && nowMinutes < minutesOf(booking.end) - 10;

  const confirmEarlyEnd = async () => {
    if (!earlyEnd) return;
    const nextEnd = earlyEndTime(earlyEnd);
    setEarlyEndBusy(true);
    const result = await patchBookingRequest(earlyEnd.id, {
      roomId: earlyEnd.roomId,
      date: earlyEnd.date,
      start: earlyEnd.start,
      end: nextEnd,
      owner: myBookingOwner.trim(),
      team: earlyEnd.team ?? "",
      purpose: earlyEnd.purpose,
    });
    setEarlyEndBusy(false);
    if (!result.ok) {
      setSyncError(result.message);
      return;
    }
    await refreshBookings();
    setEarlyEnd(null);
    setToast({
      text: "회의를 끝냈습니다.",
      detail: roomById(earlyEnd.roomId)?.name ?? "",
      time: `${nextEnd}부터 예약 가능`,
    });
  };

  const deleteEditing = async () => {
    if (!editDraft) return;
    setEditBusy(true);
    const result = await deleteBookingRequest(editDraft.id, myBookingOwner.trim());
    setEditBusy(false);
    if (!result.ok) {
      setEditNotice(result.message);
      return;
    }
    await refreshBookings();
    setEditDraft(null);
    setToast({ text: "예약을 삭제했습니다.", detail: roomById(editDraft.roomId)?.name ?? "", time: formatDateLabel(editDraft.date) });
  };

  const getSlotMinutes = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.999, (event.clientY - bounds.top) / bounds.height));
    const { slotMinutes } = bookingDefaults;
    return Math.min(
      Math.max(minutesOf(timeOptions[0]), timelineStart + Math.floor((ratio * (timelineEnd - timelineStart)) / slotMinutes) * slotMinutes),
      timelineEnd - slotMinutes,
    );
  };

  const startSlotDrag = (room: Room, reservationDate: DateKey, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const startMinutes = getSlotMinutes(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setSlotConfirmation(null);
    setSlotDrag({
      roomId: room.id,
      date: reservationDate,
      start: formatMinutes(startMinutes),
      end: formatMinutes(startMinutes + bookingDefaults.slotMinutes),
      anchorY: event.clientY,
    });
  };

  const updateSlotDrag = (room: Room, reservationDate: DateKey, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!slotDrag || slotDrag.roomId !== room.id || slotDrag.date !== reservationDate) return;
    const anchorMinutes = minutesOf(slotDrag.start);
    const pointerMinutes = getSlotMinutes(event);
    const nextStart = Math.min(anchorMinutes, pointerMinutes);
    const nextEnd = Math.max(anchorMinutes, pointerMinutes) + bookingDefaults.slotMinutes;
    setSlotDrag({ ...slotDrag, start: formatMinutes(nextStart), end: formatMinutes(nextEnd) });
  };

  const finishSlotDrag = (room: Room, reservationDate: DateKey, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!slotDrag || slotDrag.roomId !== room.id || slotDrag.date !== reservationDate) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const moved = Math.abs(event.clientY - slotDrag.anchorY) >= 8;
    if (moved) setSlotConfirmation({ roomId: room.id, date: reservationDate, start: slotDrag.start, end: slotDrag.end });
    setSlotDrag(null);
  };

  /**
   * Enter나 쉼표로 참석자를 확정한다. 칸을 벗어날 때도 남은 글자를 살려 준다.
   * 같은 이름과 정원 초과는 조용히 걸러낸다.
   */
  const addAttendee = (event: ReactKeyboardEvent<HTMLInputElement> | ReactFocusEvent<HTMLInputElement>) => {
    if ("key" in event) {
      if (event.key !== "Enter" && event.key !== ",") return;
      // Enter가 예약 제출로 이어지지 않게 막는다.
      event.preventDefault();
    }
    const name = attendeeDraft.trim().slice(0, bookingDefaults.maxAttendeeNameLength);
    if (!name) return;
    setAttendeeDraft("");
    setAttendees((list) => (
      list.includes(name) || list.length >= bookingDefaults.maxAttendees ? list : [...list, name]
    ));
  };

  /**
   * 주간 화면에서 빈칸을 더블클릭했을 때. 회의실·날짜만 정하고 시간은 비워 둔다.
   * 예전에는 비어 있는 가장 이른 시간을 대신 골라 줬는데, 그게 원하는 시간이
   * 아닌 경우가 많아 결국 다시 고쳐야 했다. 시간은 빠른 예약 창에서
   * 사람이 직접 고른다 — 겹치는 시간이면 그 자리에서 바로 알려 준다.
   */
  const askWeekdaySlot = (room: Room, day: DateKey, at?: { x: number; y: number }) => {
    // 누른 자리에 창을 띄우려고 좌표를 함께 받는다. 표 가운데에 뜨면 어느 칸을 눌렀는지 알기 어렵다.
    setConfirmAt(at ?? null);
    setWeeklyPick({ roomId: room.id, date: day });
  };

  const confirmWeeklyPick = () => {
    if (!weeklyPick) return;
    setSelectedId(weeklyPick.roomId);
    setDate(weeklyPick.date);
    setWeeklyPick(null);
    setDraftActive(true);
    // 시간은 아직 안 정했다는 뜻이므로, 채워졌다는 알림 대신
    // 시작·종료 칸을 빨갛게 밝혀 무엇을 해야 하는지 바로 보이게 한다.
    setTimeNeedsPick(true);
    setNotice("");
    window.requestAnimationFrame(() => {
      document.querySelector(".booking-fields")?.scrollTo({ top: 0, behavior: "smooth" });
      document.getElementById("start-time-select")?.focus({ preventScroll: true });
    });
  };

  /**
   * 표나 배치도에서 고른 값을 오른쪽 칸에 채웠다고 알린다.
   * 창을 따로 띄우지 않으므로, 채워졌다는 사실을 3초짜리 알림으로만 전한다.
   * 칸이 아래로 내려가 있으면 채워진 자리가 안 보이므로 맨 위로 되돌린다.
   */
  /**
   * 빈 칸에 마우스를 올리면 그 자리에 '드래그해서 예약'을 띄운다.
   * 칸 가운데에 고정하면 예약 블록에 가려 안 보이므로 커서를 따라다니게 한다.
   * 예약 블록 위나 끌고 있는 중에는 뜨지 않는다.
   */
  useEffect(() => {
    const tip = document.createElement("div");
    tip.className = "drag-tip";
    tip.textContent = "＋ 드래그해서 예약";
    document.body.appendChild(tip);
    let pressing = false;
    const hide = () => tip.classList.remove("on");
    const move = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      // 확인 창이 떠 있으면 이미 고른 상태다. 알약이 남아 있으면 창과 겹쳐 어수선하다.
      if (pressing || document.querySelector(".slot-confirmation")) return hide();
      const day = target?.closest?.(".daily-timeline .timeline-day-body");
      const week = target?.closest?.(".weekly-room-cell");
      if ((!day && !week) || target?.closest?.(".timeline-event, .weekly-room-event")) return hide();
      tip.textContent = day ? "＋ 드래그해서 예약" : "＋ 더블클릭해서 예약";
      tip.classList.add("on");
      tip.style.left = `${event.clientX + 14}px`;
      tip.style.top = `${event.clientY + 16}px`;
    };
    const press = () => { pressing = true; hide(); };
    const release = () => { pressing = false; };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerdown", press);
    document.addEventListener("pointerup", release);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("pointerup", release);
      window.removeEventListener("blur", hide);
      tip.remove();
    };
  }, []);

  const flashFilled = (title: string, detail: string) => {
    setFilledNotice({ title, detail });
    if (filledTimer.current !== null) window.clearTimeout(filledTimer.current);
    filledTimer.current = window.setTimeout(() => setFilledNotice(null), 3000);
    window.requestAnimationFrame(() => {
      document.querySelector(".booking-fields")?.scrollTo({ top: 0, behavior: "smooth" });
      // 남은 필수칸은 회의 목적 하나뿐이다. 커서를 미리 넣어 두면 표시를
      // 읽기 전에 손이 먼저 움직인다. 스크롤은 위에서 이미 잡았다.
      document.getElementById("purpose-input")?.focus({ preventScroll: true });
    });
  };

  /** 필수 칸 순서. 넘김·검사·안내 문구가 모두 이 한 벌을 따른다. */
  const REQUIRED_FIELDS = [
    { key: "owner", id: "owner-input", value: owner, message: "예약자 이름을 적어 주세요" },
    { key: "team", id: "team-input", value: team, message: "본부명을 골라 주세요" },
    { key: "purpose", id: "purpose-input", value: purpose, message: "회의 목적을 적어 주세요" },
  ] as const;

  /** 빈 필수 칸 아래에 붙는 한 줄. 값이 들어오면 저절로 사라진다. */
  const missingNote = (key: string) => {
    if (missingField !== key) return null;
    const field = REQUIRED_FIELDS.find((item) => item.key === key);
    return <span className="field-missing-msg" role="alert"><i aria-hidden="true">!</i>{field?.message}</span>;
  };

  /**
   * 한 칸을 끝내면 아직 빈 다음 필수 칸으로 커서를 옮긴다. 남은 칸이 없으면
   * 예약 버튼으로 보내, 다 채웠다는 것과 다음에 누를 곳을 함께 알린다.
   */
  const focusNextRequired = (afterKey: string, reveal = false) => {
    const from = REQUIRED_FIELDS.findIndex((field) => field.key === afterKey);
    const next = REQUIRED_FIELDS.slice(from + 1).find((field) => !field.value.trim());
    const target = document.getElementById(next ? next.id : "reserve-button");
    if (!target) return;
    // 손으로 옮겨 온 경우(reveal)에는 그 칸이 화면 밖일 수 있다. 라벨까지 함께
    // 보이도록 감싼 칸을 끌어올린 뒤 커서를 넣는다.
    if (reveal) {
      // scrollIntoView는 페이지 전체를 움직여 버린다. 스크롤되는 것은 입력칸
      // 영역 하나뿐이므로 그 안에서 직접 계산해 라벨까지 가운데로 끌어올린다.
      const box = (target.closest("label") ?? target) as HTMLElement;
      const pane = document.querySelector(".booking-fields");
      if (pane instanceof HTMLElement) {
        const offset = box.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
        const middle = offset - Math.max(0, (pane.clientHeight - box.offsetHeight) / 2);
        pane.scrollTop = Math.max(0, middle);
      }
    }
    target.focus({ preventScroll: true });
  };

  /**
   * 반복 종료 날짜를 고르고 나면 남은 일은 회의 목적을 적는 것뿐이다.
   * 잠깐 뒤에 커서를 옮겨 준다 — 바로 옮기면 방금 고른 날짜를 확인할 틈이 없고,
   * 달력이 닫히는 것도 못 본다. 그 사이 사용자가 다른 칸을 누르면 비켜 준다.
   */
  /**
   * 참석자·비품처럼 접혀 있던 칸을 펼치면 그만큼 아래가 길어져 화면 밖으로
   * 나간다. 늘어난 높이만큼 입력칸 영역을 굴려, 방금 펼친 칸이 바로 보이게 한다.
   */
  const revealAfterExpand = (selector: string, open: () => void) => {
    const pane = document.querySelector<HTMLElement>(".booking-fields");
    const before = pane?.scrollHeight ?? 0;
    open();
    // 화면에 그려진 뒤에 재야 늘어난 높이를 알 수 있다.
    window.setTimeout(() => {
      if (!pane) return;
      const grew = pane.scrollHeight - before;
      if (grew <= 0) return;
      const max = pane.scrollHeight - pane.clientHeight;
      // 펼친 칸의 아래끝이 보이는 데까지만 굴린다. 늘어난 높이를 그대로 더하면
      // 칸이 다 안 들어갈 때 위쪽이 잘려 무엇이 열렸는지 안 보인다.
      const opened = pane.querySelector<HTMLElement>(selector);
      if (opened) {
        const over = opened.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom;
        if (over > 0) pane.scrollTop = Math.min(pane.scrollTop + over + 8, max);
        return;
      }
      pane.scrollTop = Math.min(pane.scrollTop + grew, max);
    }, 0);
  };

  const handOffTimer = useRef<number | null>(null);
  const handOffToPurpose = () => {
    if (handOffTimer.current !== null) window.clearTimeout(handOffTimer.current);
    handOffTimer.current = window.setTimeout(() => {
      handOffTimer.current = null;
      const active = document.activeElement;
      const inField = active instanceof HTMLElement
        && (active.tagName === "INPUT" || active.tagName === "SELECT" || active.tagName === "TEXTAREA");
      if (inField) return;
      focusNextRequired("team", true);
    }, 1000);
  };
  useEffect(() => () => {
    if (handOffTimer.current !== null) window.clearTimeout(handOffTimer.current);
  }, []);

  const confirmSlotBooking = () => {
    if (!slotConfirmation) return;
    const minutes = minutesOf(slotConfirmation.end) - minutesOf(slotConfirmation.start);
    setSelectedId(slotConfirmation.roomId);
    setAllDay(false);
    setDuration(bookingDefaults.durationPresetsMinutes.includes(minutes) ? minutes : 0);
    setSlot({ date: slotConfirmation.date, start: slotConfirmation.start, end: slotConfirmation.end });
    setNotice("");
    setSlotConfirmation(null);
    setDraftActive(true);
    setTimeNeedsPick(false);
    flashFilled(
      roomById(slotConfirmation.roomId)?.name ?? "회의실",
      `${formatDateLabel(slotConfirmation.date)} · ${slotConfirmation.start}–${slotConfirmation.end}`,
    );
  };

  const changeStart = (nextStart: string) => {
    setAllDay(false);
    setSlot((current) => ({
      ...current,
      start: nextStart,
      end: addMinutes(nextStart, duration || bookingDefaults.defaultDurationMinutes),
    }));
    setNotice("");
    setTimeNeedsPick(false);
  };

  const changeDuration = (minutes: number) => {
    setAllDay(false);
    const latestStartMinutes = minutesOf(lastSelectableTime) - minutes;
    setDuration(minutes);
    setSlot((current) => {
      const nextStart = minutesOf(current.start) > latestStartMinutes
        ? formatMinutes(latestStartMinutes)
        : current.start;
      return { ...current, start: nextStart, end: addMinutes(nextStart, minutes) };
    });
    setNotice("");
    setTimeNeedsPick(false);
  };

  const changeEnd = (nextEnd: string) => {
    setAllDay(false);
    setSlot((current) => ({ ...current, end: nextEnd }));
    const minutes = minutesOf(nextEnd) - minutesOf(start);
    setDuration(bookingDefaults.durationPresetsMinutes.includes(minutes) ? minutes : 0);
    setNotice("");
    setTimeNeedsPick(false);
  };

  const selectAllDay = () => {
    setAllDay(true);
    setDuration(0);
    setTimeNeedsPick(false);
    setSlot((current) => ({
      ...current,
      start: bookingDefaults.allDayStart,
      end: bookingDefaults.allDayEnd,
    }));
    setNotice("");
  };

  const submitReservation = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    // 빈 필수 칸이 있으면 첫 칸에 딱지를 붙이고 커서를 보낸다. 알림 문구는
    // 띄우지 않는다. 어느 칸인지 딱지가 직접 가리키므로 두 번 말할 필요가 없다.
    const empty = REQUIRED_FIELDS.find((field) => !field.value.trim());
    if (empty) {
      setNotice("");
      setMissingField(empty.key);
      document.getElementById(empty.id)?.focus({ preventScroll: true });
      return;
    }
    setMissingField(null);
    if (!officeTeams.some((item) => item.name === team.trim())) {
      setNotice("검색 목록에서 본부명을 선택해 주세요.");
      setTeamOpen(true);
      return;
    }
    if (minutesOf(end) <= minutesOf(start)) {
      setNotice("종료 시간은 시작 시간보다 늦게 선택해 주세요.");
      return;
    }
    if (reservationDates.some((day) => day < today)) {
      setNotice("지난 날짜에는 예약할 수 없습니다.");
      return;
    }
    if (conflictDates.length) {
      const free = reservationDates.filter((day) => !conflictDates.includes(day));
      if (free.length === 0) {
        setNotice(
          reservationDates.length === 1
            ? `${formatDateLabel(conflictDates[0])}에 이미 예약이 있어요. 다른 시간을 선택해 주세요.`
            : "고른 날짜가 모두 이미 예약되어 있어요. 다른 시간을 선택해 주세요.",
        );
        return;
      }
      // 반복 예약에서 며칠만 걸린 경우. 전부 실패시키지 말고 나머지를 예약할지 물어본다.
      setRepeatAsk({ conflicts: conflictDates, free });
      return;
    }
    await sendBooking(reservationDates);
  };

  /** 실제로 서버에 보내는 부분. '겹치는 날만 빼고' 보낼 때도 같은 길을 쓴다. */
  const sendBooking = async (dates: string[]) => {
    const ownerName = owner.trim();
    const teamName = team.trim();
    setRepeatAsk(null);
    setSubmitting(true);
    const result = await postBookings({
      roomId: selected.id,
      dates,
      start,
      end,
      owner: ownerName,
      team: teamName,
      purpose: purpose.trim(),
      attendees,
      equipment,
    });
    setSubmitting(false);

    if (!result.ok) {
      // 동시에 다른 사람이 먼저 잡았을 수 있다. 서버 판정을 보여주고 최신 상태로 맞춘다.
      setNotice(result.message);
      await refreshBookings();
      return;
    }

    setDraftActive(false);
    setTimeNeedsPick(false);
    setMyBookingOwner(ownerName);
    setPurpose("");
    setAttendees([]);
    setAttendeeDraft("");
    setBookingPanelOpen(false);
    setNotice("예약이 완료되었습니다.");
    setToast({
      text: "예약이 완료되었습니다",
      detail: dates.length > 1
        ? `${selected.name} · 반복 ${dates.length}회`
        : `${selected.name} · ${formatDateLabel(dates[0])}`,
      time: `${start}–${end}`,
    });
    // 방금 잡은 시간이 양식에 그대로 남으면 "이미 예약된 시간"으로 보인다.
    // 같은 길이로 비어 있는 시간대를 찾아 옮겨 두어 이어서 예약하기 쉽게 한다.
    const justBooked = dates.map((bookedDate) => ({
      id: `just-${bookedDate}`,
      roomId: selected.id,
      date: bookedDate,
      start,
      end,
      owner: ownerName,
      team: teamName,
      purpose: "",
    })) as Booking[];
    const pool = [...bookings, ...justBooked];
    const durationMinutes = minutesOf(end) - minutesOf(start);
    const freeStarts = startTimeOptions.filter((candidate) => {
      const candidateEnd = addMinutes(candidate, durationMinutes);
      if (minutesOf(candidateEnd) > minutesOf(lastSelectableTime)) return false;
      return findConflictingDates(pool, selected.id, dates, candidate, candidateEnd).length === 0;
    });
    // 방금 예약한 시간 뒤쪽을 먼저 보고, 없으면 그날 가장 이른 빈 시간으로 간다.
    const nextStart = freeStarts.find((candidate) => minutesOf(candidate) >= minutesOf(end)) ?? freeStarts[0];
    if (!allDay && nextStart) {
      setSlot((current) => ({ ...current, start: nextStart, end: addMinutes(nextStart, durationMinutes) }));
    }
    await refreshBookings();
  };

  return (
    <main className={`app-shell ${showMap ? "map-open" : ""}`}>
      {syncError && <div className="sync-error-banner" role="alert">{syncError}</div>}
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand-lockup">
            {/* 4KB짜리 고정 로고이고, 서버 없이 단독 파일로도 열려야 해서
                이미지 최적화 서버가 필요한 next/image 대신 <img>를 쓴다. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="bdo-logo" src="/bdo-logo.png" alt="BDO" />
          </div>
          <div className="product-name">
            <p className="eyebrow">SEOUL OFFICE</p>
            <h1>회의실 예약</h1>
          </div>
        </div>
        <div className="header-account">
          {currentUser
            ? <span className="header-user">{currentUser.name}님 <a className="header-logout" href="/auth/logout">로그아웃</a></span>
            : myBookingOwner && <span className="header-user">{myBookingOwner}님</span>}
          {/* 시계와 날짜는 뺐다. 보고 있는 날짜가 왼쪽에 크게 있고,
              현재 시각은 일정표의 빨간 선이 알려 준다. */}
          <a className="header-manual-help" title="매뉴얼" href="/회의실예약_매뉴얼.pdf" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="3.5" width="12" height="17" rx="1" /><path d="M9 8.5h6M9 12h6M9 15.5h3.5" /></svg>
          </a>
          <span className="header-sep" aria-hidden="true" />
          <button type="button" className="header-my-bookings" onClick={() => setMyBookingsOpen(true)}>내 예약</button>
        </div>
      </header>

      <section className="toolbar" aria-label="예약 조건 선택">
        <div className="floor-switch" aria-label="층 선택">
          {floors.map((item) => (
            <button key={item} type="button" className={floor === item ? "active" : ""} onClick={() => selectFloor(item)}>
              {item}층
              <small>{rooms.filter((room) => room.floor === item && statusOf(room).status === "available").length}개 사용 가능</small>
            </button>
          ))}
        </div>
        <div className="date-switch">
          <button type="button" aria-label="이전 날짜" onClick={() => setDate(moveDate(date, -1))}>‹</button>
          <button type="button" className="date-main" onClick={() => setDate(today)}>
            <span>{date === today ? "오늘" : "선택 날짜"}</span>
            <strong>{formatDateLabel(date)}</strong>
          </button>
          <button type="button" aria-label="다음 날짜" onClick={() => setDate(moveDate(date, 1))}>›</button>
        </div>
        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="회의실, 인원, 장비 검색" />
        </label>
        <div className="availability-summary">
          <span>{floor}층</span>
          <strong>{availableCount}</strong>
          <em>/ {floorRooms.length}개 사용 가능</em>
        </div>
        <button type="button" className="toolbar-my-bookings" onClick={() => setMyBookingsOpen(true)}>내 예약</button>
      </section>

      <section className="room-strip" aria-label={`${floor}층 회의실 선택`}>
        <strong>{floor}층 회의실</strong>
        <div className="room-strip-list">
          {floorRooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className={`room-strip-button ${selected.id === room.id ? "selected" : ""}`}
              onClick={() => selectRoom(room)}
              aria-pressed={selected.id === room.id}
            >
              <i className={statusOf(room).status} />
              <b>{room.name}</b>
              <span>· {formatCapacity(room.capacity)}</span>
            </button>
          ))}
        </div>
        <div className="room-strip-availability" aria-label={`${floor}층 ${availableCount}개 회의실 사용 가능`}>
          <span>{floor}층</span>
          <strong>{availableCount}</strong>
          <em>/ {floorRooms.length}개 사용 가능</em>
        </div>
      </section>

      <section className={`workspace ${bookingPanelOpen ? "booking-modal-open" : ""}`}>
        <aside className="room-list-panel">
          <div className="section-heading">
            <div><p>ROOMS</p><h2>{floor}층 회의실</h2></div>
            <span>{filteredRooms.length}개</span>
          </div>
          <p className="section-help">이름 또는 오른쪽 배치도에서 회의실을 선택하세요.</p>
          <div className="room-list">
            {filteredRooms.map((room) => {
              const status = statusOf(room);
              return (
                <div className="room-card-wrap" key={room.id}>
                <button
                  type="button"
                  className={`room-card ${selected.id === room.id ? "selected" : ""}`}
                  onClick={() => selectRoom(room)}
                  aria-pressed={selected.id === room.id}
                >
                  <div className="room-card-top">
                    <span className={`status-dot ${status.status}`} />
                    <span className={`status-text ${status.status}`}>{status.statusLabel}</span>
                    <span className="floor-pill">{room.floor}F</span>
                  </div>
                  <strong>{room.name}</strong>
                  <div className="room-meta"><span>{formatCapacity(room.capacity)}</span><span>{room.equipment[0]}</span></div>
                  <p>{status.nextLabel}</p>
                </button>
                <button
                  type="button"
                  className="room-location-button"
                  onClick={() => {
                    selectRoom(room);
                    setMapDetailId(null);
                    setShowMap(true);
                  }}
                  aria-label={`${room.name} location`}
                >
                  <PinIcon />
                  <span>{"\uC704\uCE58 \uBCF4\uAE30"}</span>
                </button>
                </div>
              );
            })}
            {filteredRooms.length === 0 && <div className="empty-search">조건에 맞는 회의실이 없어요.</div>}
          </div>
          <div className="legend"><span><i className="available" />사용 가능</span><span><i className="occupied" />사용 중</span><span><i className="soon" />곧 예약</span></div>
        </aside>

        <section className="map-panel">
          <div className="map-week-split">
            {showMap && <div className="map-zone map-zone-compact">
              <div className="section-heading map-heading">
                <div className="map-heading-title">
                  <div className="map-window-floor-switch" aria-label="층 선택">
                    {floors.map((item) => (
                      <button key={item} type="button" className={floor === item ? "active" : ""} onClick={() => selectFloor(item)}>{item}층</button>
                    ))}
                  </div>
                </div>
                <div className="map-window-actions">
                  {/* 안내 문구는 뺐다. 회의실 칸이 눌리게 생겼으면 그것으로 족하다. */}
                  <button type="button" className="map-window-close" onClick={() => setShowMap(false)} aria-label="배치도 닫기"><CloseIcon /></button>
                </div>
              </div>
              <div className={`floor-map floor-${floor}`}>
                <div className="map-entrance">출입구</div>
                {floorRooms.map((room) => {
                  const status = statusOf(room);
                  return (
                    <button
                      type="button"
                      key={room.id}
                      className={`map-room ${room.mapClass} ${status.status} ${selected.id === room.id ? "selected" : ""}`}
                      // 배치도는 '어디에 있는 방인지' 보는 곳이다. 누르면 그 방을
                      // 고르기만 하고, 설명창은 띄우지 않는다.
                      onClick={() => selectRoom(room)}
                      aria-label={`${room.name}, ${status.statusLabel}, ${formatCapacity(room.capacity)}`}
                      aria-pressed={selected.id === room.id}
                    >
                      <strong>{room.name}</strong>
                      <span className="map-status"><i />{status.statusLabel}</span>
                      <small className="map-capacity">{formatCapacity(room.capacity)}</small>
                      <small className="map-equipment">{room.equipment.slice(0, 2).join(" · ")}</small>
                      {selected.id === room.id && <b className="selected-check">✓</b>}
                    </button>
                  );
                })}
                {/* 회의실 설명창은 뺐다. 배치도에서 알아야 할 것은 '어디에 있나'
                    하나뿐이고, 정원·장비는 오른쪽 예약창이 이미 보여 준다. */}
              </div>
            </div>}
            <section className="weekly-board schedule-design-cards" aria-label={scheduleView === "week" ? `${selected.name} 주간 예약 현황` : `${floor}층 일간 예약 현황`}>
              {/* 날짜가 화면 제목이다. 층·날짜·보기 방식을 이 두 줄에 모아 두면
                  따로 있던 제어줄이 없어지고 그만큼 표가 커진다. */}
              <div className="weekly-heading schedule-hero">
                <div className="hero-date">
                  {/* 주간은 작은 줄을 두지 않는다. 날짜는 바로 아래 요일 줄
                      (월 17 · 화 18 …)에 이미 다 나와 있어 같은 말이 두 번이다. */}
                  {!weekView && <p className="hero-kicker">{formatWeekday(date)}요일</p>}
                  {/* 일간은 '8/19'처럼 숫자만 남겨 크게 쓴다. 위 줄에 요일이 이미
                      있으니 '월·일' 글자가 없어도 무슨 날인지 읽힌다 — 글자를 덜어낸
                      만큼 숫자를 키울 수 있어 이 영역의 제목이 날짜가 된다.
                      주간은 범위 대신 '8월 3주차'로 적는다(아래 요일 줄에 날짜가 다 있다). */}
                  <h3 className={weekView ? undefined : "hero-date-big"}>{weekView
                    ? weekOfMonthLabel(weekDays[0])
                    : slashDate(date)}
                  </h3>
                </div>
                {/* 시안대로 화살표 둘을 붙이고 '오늘'을 그 옆에 둔다.
                    주간에서는 그 주 월요일을 기준으로 옮긴다. 날짜에서 ±7일만 하면
                    주말에 걸린 날짜가 계속 주말로 남아 일간으로 바꿨을 때 어긋난다. */}
                {/* 날짜를 다루는 것들은 한 덩어리로 묶는다. 흩어져 있으면 덩어리 수만 늘어난다. */}
                <div className="schedule-date-switch">
                  <button type="button" className="nav-step" aria-label={weekView ? "이전 주" : "이전 날짜"} onClick={() => setDate(weekView ? moveDate(weekDays[0], -7) : moveDate(date, -1))}><ChevronIcon direction="prev" /></button>
                  <button type="button" className="nav-today" onClick={() => setDate(today)}>
                    {weekView ? "이번 주" : "오늘"}
                  </button>
                  <button type="button" className="nav-step" aria-label={weekView ? "다음 주" : "다음 날짜"} onClick={() => setDate(weekView ? moveDate(weekDays[0], 7) : moveDate(date, 1))}><ChevronIcon direction="next" /></button>
                  <DateField variant="icon" allowAnyDate value={date} onChange={setDate} />
                </div>

                {/* 층 선택. 밑줄 탭이라 옆의 일간/주간 스위치와 모양이 겹치지 않는다. */}
                <div className="schedule-floor-switch" aria-label="층 선택">
                  {floorAvailability.map(({ floor: item, free }) => (
                    <button key={item} type="button" className={floor === item ? "active" : ""} onClick={() => selectFloor(item)}>
                      {/* 오늘이면 '지금' 기준, 다른 날이면 그 날짜에 예약이
                          없는 방 수다. 같은 숫자라도 뜻이 다르므로 말도 달리한다. */}
                      {item}층<b>{free}개<em> 사용 가능</em></b>
                    </button>
                  ))}
                </div>

                <div className="schedule-heading-actions">
                  <div className="schedule-view-switch" aria-label="예약 현황 보기 방식">
                    <button type="button" className={scheduleView === "day" ? "active" : ""} onClick={() => setScheduleView("day")}>일간</button>
                    <button type="button" className={scheduleView === "week" ? "active" : ""} onClick={() => setScheduleView("week")}>주간</button>
                  </div>
                  {/* 배치도는 일정표 바로 옆에 둔다. 같이 보는 것이라 상단 바로 빼면 멀다.
                      글자 없이 핀 하나로 둔다 — 옆의 '일간/주간'과 성격이 달라
                      같은 글자 버튼으로 보이면 세 번째 보기 방식으로 읽힌다. */}
                  <button type="button" className={`map-toggle icon-only ${showMap ? "active" : ""}`} title={showMap ? "일정표 보기" : "회의실 위치 보기"} aria-label={showMap ? "일정표 보기" : "회의실 위치 보기"} onClick={() => { setTeamOpen(false); setMapDetailId(null); setShowMap((current) => !current); }}>
                    {showMap ? <CloseIcon /> : <PinIcon />}
                  </button>
                </div>

                {/* 드래그 안내는 빈 칸에 마우스를 올리면 그 자리에 뜨는 알약이
                    대신한다. 머리줄에 한 줄로 적어 두면 어디를 드래그하라는
                    말인지 알기 어려웠다. */}
              </div>

              {scheduleView === "day" && <div className="week-timeline daily-timeline" ref={dailyGridRef}>
                <div className="time-axis">
                  <span className="axis-corner">시간</span>
                  <div className="time-axis-body">
                    {timelineHours.map((hour) => <time key={hour} style={{ top: `${((hour * 60 - timelineStart) / (timelineEnd - timelineStart)) * 100}%` }}>{String(hour).padStart(2, "0")}:00</time>)}
                    {showCurrentTime && nowMinutes !== null && (
                      <strong className="current-time-label" style={{ top: `${currentTimePercent}%` }}>{formatMinutes(nowMinutes)}</strong>
                    )}
                  </div>
                </div>
                {/* 회의실마다 따로 선을 그으면 카드 사이 여백에서 끊겨 보인다.
                    모든 회의실 칸에 걸치는 선 하나만 그린다. 위치는 칸들의
                    실제 픽셀 크기(dailyGridMetrics)를 재서 계산한다. */}
                {showCurrentTime && currentTimePercent !== null && dailyGridMetrics && (
                  <span
                    className="current-time-line current-time-line-all"
                    style={{
                      left: dailyGridMetrics.left,
                      width: dailyGridMetrics.width,
                      top: dailyGridMetrics.bodyTop + (currentTimePercent / 100) * dailyGridMetrics.bodyHeight,
                    }}
                  />
                )}
                {floorRooms.map((room) => {
                  const dailyBookings = layoutOverlappingBookings(
                    bookings.filter((booking) => booking.roomId === room.id && booking.date === date),
                  );
                  const status = statusOf(room);
                  return (
                    <div className={`timeline-day daily-room ${selected.id === room.id ? "active" : ""}`} key={room.id}>
                      <button type="button" className="timeline-day-head daily-room-head" onClick={() => { setSelectedId(room.id); setMapDetailId(null); }}>
                        <strong>{room.name}</strong>
                        {/* 지금 쓸 수 있는지가 이 표에서 가장 먼저 봐야 할 정보다.
                            주간현황과도 같은 형식으로 맞춘다. */}
                        <span className={`daily-room-meta ${status.status}`}><i className={`room-status-dot ${status.status}`} /><b>{status.statusLabel}</b><em>·</em>{formatCapacity(room.capacity)}</span>
                      </button>
                      <div
                        className="timeline-day-body"
                        onPointerDown={(event) => startSlotDrag(room, date, event)}
                        onPointerMove={(event) => updateSlotDrag(room, date, event)}
                        onPointerUp={(event) => finishSlotDrag(room, date, event)}
                        onPointerCancel={() => setSlotDrag(null)}
                      >
                        {(() => {
                          const selection = slotDrag?.roomId === room.id && slotDrag.date === date
                            ? slotDrag
                            : slotConfirmation?.roomId === room.id && slotConfirmation.date === date
                              ? slotConfirmation
                              : null;
                          if (!selection) return null;
                          const top = ((minutesOf(selection.start) - timelineStart) / (timelineEnd - timelineStart)) * 100;
                          const height = ((minutesOf(selection.end) - minutesOf(selection.start)) / (timelineEnd - timelineStart)) * 100;
                          return <span className="timeline-drag-selection" style={{ top: `${top}%`, height: `${height}%` }} aria-hidden="true" />;
                        })()}
                        {/* 표에서 값을 가져왔지만 아직 예약하기를 누르지 않은 상태.
                            '표에 뭔가 생겼으니 됐겠지'라고 믿는 그 자리에 점선으로 남겨 둔다. */}
                        {draftActive && room.id === selected.id && date === slot.date && (() => {
                          const top = ((minutesOf(start) - timelineStart) / (timelineEnd - timelineStart)) * 100;
                          const height = Math.max(((minutesOf(end) - minutesOf(start)) / (timelineEnd - timelineStart)) * 100, 6.5);
                          return (
                            <span className="timeline-draft" style={{ top: `${top}%`, height: `${height}%` }}>
                              <b>작성 중</b>
                              <em>{start}–{end} · 오른쪽에서 이어서</em>
                            </span>
                          );
                        })()}
                        {dailyBookings.map((booking, index) => {
                          const bookingStart = Math.max(timelineStart, minutesOf(booking.start));
                          const bookingEnd = Math.min(timelineEnd, minutesOf(booking.end));
                          const top = ((bookingStart - timelineStart) / (timelineEnd - timelineStart)) * 100;
                          const height = Math.max(((bookingEnd - bookingStart) / (timelineEnd - timelineStart)) * 100, 6.5);
                          // 블록이 짧을수록 글자를 줄여 시간·제목·예약자가 모두 보이게 한다.
                          const spanMinutes = bookingEnd - bookingStart;
                          const sizeClass = spanMinutes >= 120 ? "ev-xl" : spanMinutes >= 75 ? "ev-lg" : spanMinutes >= 50 ? "ev-md" : "ev-sm";
                          const leftEdge = booking.lane === 0 ? 7 : 3;
                          const rightEdge = booking.lane === booking.laneCount - 1 ? 7 : 3;
                          const left = `calc(${(booking.lane / booking.laneCount) * 100}% + ${leftEdge}px)`;
                          const right = `calc(${((booking.laneCount - booking.lane - 1) / booking.laneCount) * 100}% + ${rightEdge}px)`;
                          return (
                            <button
                              type="button"
                              className={`timeline-event tone-${index % 3}${isMyBooking(booking) ? " is-mine" : ""} ${sizeClass}`}
                              key={booking.id}
                              style={{ top: `${top}%`, height: `${height}%`, left, right }}
                              aria-label={isMyBooking(booking)
                                ? `내 예약 ${booking.start}–${booking.end} ${booking.purpose} · 눌러서 수정하거나 삭제합니다`
                                : `${booking.start}–${booking.end} ${booking.purpose} / ${booking.owner} · ${teamOf(booking)}`}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => { event.stopPropagation(); setSelectedId(room.id); openEditor(booking); }}
                            >
                              <time>{booking.start}–{booking.end}</time>
                              <strong>{booking.purpose}</strong>
                              <small>{booking.owner} · {teamOf(booking)}</small>
                              {/* 지금 진행 중인 내 예약에만. 남은 시간을 바로 돌려줄 수 있다. */}
                              {isRunningNow(booking) && (
                                <span
                                  className="early-end"
                                  role="button"
                                  tabIndex={0}
                                  onClick={(event) => { event.stopPropagation(); setEarlyEnd(booking); }}
                                  onKeyDown={(event) => { if (event.key === "Enter") { event.stopPropagation(); setEarlyEnd(booking); } }}
                                >회의 일찍 끝내기</span>
                              )}
                              <ReservationHoverCard booking={booking} room={room} />
                            </button>
                          );
                        })}
                        {slotConfirmation?.roomId === room.id && slotConfirmation.date === date && (
                          <div className="slot-confirmation" role="dialog" aria-label="선택 시간 예약 확인" onPointerDown={(event) => event.stopPropagation()}>
                            {/* 눌러도 예약이 되는 게 아니라 오른쪽 칸이 채워질 뿐이다.
                                버튼 이름에 무슨 일이 일어나는지 담는다. */}
                            <span className="slot-step">1 / 2 단계</span>
                            {/* 고른 것은 '시간'만이 아니라 회의실·날짜·시간 셋이다.
                                라벨과 함께 적어 무엇이 정해졌는지 오해가 없게 한다. */}
                            <dl className="slot-facts">
                              <div><dt>회의실</dt><dd>{roomById(slotConfirmation.roomId)?.name}</dd></div>
                              <div><dt>날짜</dt><dd>{formatDateLabel(slotConfirmation.date)}</dd></div>
                              <div><dt>시간</dt><dd>{slotConfirmation.start} – {slotConfirmation.end}</dd></div>
                            </dl>
                            <div><button type="button" onClick={() => setSlotConfirmation(null)}>취소</button><button type="button" onClick={confirmSlotBooking}>다음</button></div>
                            <em className="slot-confirmation-note">오른쪽 빠른예약 창에서 이어서</em>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>}
              {scheduleView === "week" && <div className="weekly-room-board" aria-label={`${floor}층 회의실별 주간 예약 현황`}>
                <div className="weekly-room-head weekly-room-corner">회의실</div>
                {weekDays.map((day) => (
                  <button type="button" className={`weekly-room-head ${day === date ? "active" : ""}`} key={day} onClick={() => setDate(day)}><b>{formatWeekday(day)}</b><span>{dayOfMonth(day)}</span></button>
                ))}
                {floorRooms.map((room) => {
                  const status = statusOf(room);
                  return (
                    <div className="weekly-room-row" key={room.id}>
                      <button type="button" className={`weekly-room-name ${selected.id === room.id ? "selected" : ""}`} onClick={() => { setSelectedId(room.id); setMapDetailId(null); }}><span className="weekly-room-title">{room.name}</span><small className={status.status}><i className={`room-status-dot ${status.status}`} /><b>{status.statusLabel}</b><em>·</em>{formatCapacity(room.capacity)}</small></button>
                      {weekDays.map((day) => {
                        const dayBookings = layoutOverlappingBookings(
                          bookings.filter((booking) => booking.roomId === room.id && booking.date === day),
                        );
                        return <div className={`weekly-room-cell ${day === date ? "active" : ""}`} key={`${room.id}-${day}`}>
                          <button
                            type="button"
                            className="weekly-cell-add"
                            aria-label={`${room.name} ${formatDateLabel(day)} 빈 시간 예약하기 (두 번 클릭)`}
                            // 한 번 클릭으로는 열리지 않게 한다. 표를 훑다가 실수로 열리는 일이 잦았다.
                            onDoubleClick={(event) => askWeekdaySlot(room, day, { x: event.clientX, y: event.clientY })}
                          >
                            <span aria-hidden="true">＋</span>
                          </button>
                          {dayBookings.map((booking, index) => {
                            // 칸 전체를 예약 가능 시간(09:00~18:00)으로 보고 그만큼만 차지하게 한다.
                            // 그래야 종일 예약이 칸을 위아래로 꽉 채운다.
                            const dayStart = minutesOf(bookingDefaults.openingTime);
                            const dayEnd = minutesOf(bookingDefaults.closingTime);
                            const bookingStart = Math.max(dayStart, minutesOf(booking.start));
                            const bookingEnd = Math.min(dayEnd, minutesOf(booking.end));
                            const top = ((bookingStart - dayStart) / (dayEnd - dayStart)) * 100;
                            const height = Math.max(((bookingEnd - bookingStart) / (dayEnd - dayStart)) * 100, 12);
                            // 주간 칸은 일간보다 훨씬 낮아서 단계를 한 칸씩 더 내린다.
                            const spanMinutes = bookingEnd - bookingStart;
                            // 90분짜리는 칸이 26px밖에 안 돼 두 줄이 안 들어간다. 2시간부터 두 줄.
                            const sizeClass = spanMinutes >= 180 ? "wk-lg" : spanMinutes >= 120 ? "wk-md" : "wk-sm";
                            const width = 100 / booking.laneCount;
                            return (
                              <button
                                type="button"
                                className={`weekly-room-event tone-${index % 3}${isMyBooking(booking) ? " is-mine" : ""} ${sizeClass}`}
                                key={booking.id}
                                style={{ top: `${top}%`, height: `${height}%`, left: `${booking.lane * width}%`, width: `${width}%` }}
                                aria-label={isMyBooking(booking)
                                  ? `내 예약 ${booking.start}–${booking.end} ${booking.purpose} · 눌러서 수정하거나 삭제합니다`
                                  : `${booking.start}–${booking.end} ${booking.purpose} / ${booking.owner} · ${teamOf(booking)}`}
                                onClick={() => { setSelectedId(room.id); setDate(day); openEditor(booking); }}
                              >
                                {/* 좁은 칸에서는 끝 시간을 접어 회의명 자리를 벌어 준다.
                                    길이는 칸 높이가 이미 말해 주므로 시작 시각이면 충분하다. */}
                                <time>{booking.start}<span className="wk-end">–{booking.end}</span></time>
                                <b>{booking.purpose}</b>
                                <small>{booking.owner} · {teamOf(booking)}</small>
                                <ReservationHoverCard booking={booking} room={room} />
                              </button>
                            );
                          })}
                        </div>;
                      })}
                    </div>
                  );
                })}
                {/* 누른 칸 옆에 띄운다. 가운데에 뜨면 어느 칸을 눌렀는지 알기 어렵다.
                    더블클릭은 시간을 정한 적이 없으므로 회의실·날짜만 보여 준다.
                    시간은 다음 화면에서 직접 고른다. */}
                {weeklyPick && (
                  <div className="weekly-confirm-layer" role="presentation" onClick={() => setWeeklyPick(null)}>
                    <div
                      className={`slot-confirmation${confirmAt ? " at-pointer" : ""}`}
                      role="dialog"
                      aria-label="선택 날짜 예약 확인"
                      style={confirmAt ? { left: confirmAt.x, top: confirmAt.y } : undefined}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span className="slot-step">1 / 2 단계</span>
                      <dl className="slot-facts">
                        <div><dt>회의실</dt><dd>{roomById(weeklyPick.roomId)?.name}</dd></div>
                        <div><dt>날짜</dt><dd>{formatDateLabel(weeklyPick.date)}</dd></div>
                      </dl>
                      <div><button type="button" onClick={() => setWeeklyPick(null)}>취소</button><button type="button" onClick={confirmWeeklyPick}>다음</button></div>
                            <em className="slot-confirmation-note">오른쪽 빠른예약 창에서 시간을 골라 주세요</em>
                    </div>
                  </div>
                )}
              </div>}
            </section>
          </div>
        </section>

      </section>

      {/* 빠른 예약은 작업 영역 밖으로 뺀다. 화면 맨 위부터 아래까지 한 칸으로
          쓰려면 상단바·작업영역과 형제여야 격자에 자리를 잡을 수 있다. */}
      {bookingPanelOpen && <div className="booking-modal-backdrop" role="presentation" onMouseDown={() => setBookingPanelOpen(false)} />}
      <aside className={`booking-panel ${bookingPanelOpen ? "booking-panel-modal" : ""} ${filledNotice ? "just-filled" : ""}`} id="quick-booking">
        {/* 표·배치도에서 값을 가져오면 칸 위에 겹쳐 잠깐 뜬다. 자리를 차지하지
            않으므로 아래 입력칸이 밀리지 않는다. */}
        {/* 떠 있는 알림은 뺐다. 표의 점선 블록과 머리의 '작성 중' 딱지가
            사라지지 않고 남으므로, 3초짜리 알림까지 겹칠 필요가 없다.
            (채워진 칸의 초록 강조와 예약 버튼 맥박은 그대로 둔다) */}
        {filledNotice && <span className="sr-only" role="status" aria-live="polite">
          {filledNotice.title} {filledNotice.detail} · 아직 예약 전입니다
        </span>}
          <div className="booking-title">
            {/* 예약하기를 누를 때까지 내려가지 않는 딱지. 알림은 3초 뒤 사라지지만
                이건 남아서 '아직 안 끝났다'를 계속 말한다. */}
            <div><h2>빠른 예약</h2>{draftActive && <span className="draft-chip">작성 중</span>}</div>

            {bookingPanelOpen && <button type="button" className="booking-modal-close" aria-label="예약창 닫기" onClick={() => setBookingPanelOpen(false)}><CloseIcon /></button>}
          </div>
          <div className="selected-room-summary">
            {/* 위치 설명은 뺐다. 어디인지는 배치도로 보는 것이 정확하고,
                그 자리를 회의실 이름에 준다. */}
            <div className="summary-title"><span className={`status-dot ${selectedStatus.status}`} /><strong>{selected.name}</strong></div>
            <div className="spec-row"><span>{formatCapacity(selected.capacity)}</span>{selected.equipment.map((item) => <span key={item}>{item}</span>)}</div>
          </div>

          <form onSubmit={submitReservation}>
            {/* 입력칸만 스크롤시키고 '예약하기'는 그 아래에 늘 보이게 둔다.
                버튼을 sticky로 띄우면 밑에 있는 칸을 덮어 버린다. */}
            <label className="field-label" htmlFor="room-picker-select">회의실</label>
          <section className="room-picker-card" aria-label="room picker">
            <div className="room-picker-selected">
              <div className="room-picker-selected-top">
                <span className={`status-dot ${selectedStatus.status}`} />
                <strong>{selected.name}</strong>
                <span className="room-picker-floor">{selected.floor}F</span>
              </div>
              <p>{selected.location}</p>
              <div className="spec-row"><span>{formatCapacity(selected.capacity)}</span>{selected.equipment.slice(0, 3).map((item) => <span key={item}>{item}</span>)}</div>
            </div>
            <button type="button" className={`room-picker-toggle ${roomPickerOpen ? "open" : ""}`} aria-expanded={roomPickerOpen} onClick={() => setRoomPickerOpen((current) => !current)}>
              <span>{"\uD68C\uC758\uC2E4 \uC120\uD0DD"}</span><i aria-hidden="true" />
            </button>
            {roomPickerOpen && <div className="room-picker-options">
              {floors.map((item) => (
                <div className="room-picker-floor-group" key={item}>
                  <small>{item}F</small>
                  {rooms.filter((room) => room.floor === item).map((room) => {
                    const status = statusOf(room);
                    return <div className="room-picker-row" key={room.id}>
                      <button type="button" className={selected.id === room.id ? "selected" : ""} onClick={() => selectRoom(room)}>
                        {/* 점과 이름을 한 덩어리로 묶는다. 따로 두면 좁을 때 점만 남고
                            이름이 다음 줄로 떨어져 나갈 자리가 없다. */}
                        <span className="room-picker-name"><span className={`status-dot ${status.status}`} /><strong>{room.name}</strong></span>
                        <em>{formatCapacity(room.capacity)}</em>
                        <span className={`room-picker-status ${status.status}`}>{status.statusLabel}</span>
                      </button>
                      <button
                        type="button"
                        className="room-picker-row-map"
                        title={`${room.name} 배치도에서 위치 보기`}
                        aria-label={`${room.name} 배치도에서 위치 보기`}
                        onClick={() => { setTeamOpen(false); setMapDetailId(null); setMapPurpose("pick"); selectFloor(room.floor); setShowMap(true); }}
                      >
                        <PinIcon />위치
                      </button>
                    </div>;
                  })}
                </div>
              ))}
            </div>}
          </section>

            <select
              id="room-picker-select"
              value={selected.id}
              onChange={(event) => {
                const room = roomById(event.target.value);
                if (room) selectRoom(room);
              }}
            >
              {floors.map((item) => (
                <optgroup key={item} label={`${item}층`}>
                  {rooms
                    .filter((room) => room.floor === item)
                    .map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.name} · {formatCapacity(room.capacity)} · {statusOf(room).statusLabel}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>

            {/* 스크롤되는 영역은 여기서부터. 회의실 카드를 이 밖에 두어야
                스크롤 막대가 빨강 선을 가로지르지 않는다. */}
            <div className="booking-fields">
            {/* 날짜·시작·종료는 모두 '언제'를 정하는 것이라 한 줄로 묶는다.
                세로를 73px 아껴 필수 항목이 스크롤 없이 다 보이게 하는 핵심이다. */}
            <div className="form-row form-row-when">
              <div><span className="field-label">예약 날짜</span><DateField value={date} onChange={setDate} /></div>
              {/* 일간 표에서 드래그한 뒤 회의 목적 칸에 붙는 것과 같은 옅은 표시다.
                  '틀렸다'는 경고가 아니라 '다음에 할 일'을 가리키는 것이라
                  Field-missing(제출 시 빈 칸)과는 다르게, 값이 바뀌면 조용히 풀린다. */}
              {/* 고르고 나면 커서(포커스)를 놓아 준다. select는 값을 고른
                  뒤에도 포커스가 남아, 다른 칸과 달리 빨간 포커스 테두리가
                  할 일이 끝난 뒤에도 계속 떠 있는 것처럼 보였다. */}
              <label className={timeNeedsPick ? "needs-input" : undefined}><span className="field-label">시작 시간</span><select id="start-time-select" value={start} onChange={(event) => { changeStart(event.target.value); event.target.blur(); }}>{visibleStartTimeOptions.map((time) => <option key={time}>{time}</option>)}</select></label>
              <label className={timeNeedsPick ? "needs-input" : undefined}><span className="field-label">종료 시간</span><select value={end} onChange={(event) => { changeEnd(event.target.value); event.target.blur(); }}>{timeOptions.map((time) => <option key={time}>{time}</option>)}</select></label>
            </div>

            <label className="repeat-option">
              <input type="checkbox" checked={repeatWeekly} onChange={(event) => {
                setRepeatWeekly(event.target.checked);
                if (event.target.checked && !repeatEndTouched) {
                  setRepeatEnd(moveDate(date, bookingDefaults.defaultRepeatSpanDays));
                }
              }} />
              {/* 무엇에 쓰는 칸인지 옆에 한마디 붙인다. 체크박스 이름만으로는
                  '반복'이 무슨 뜻인지(같은 시간을 여러 날) 알기 어렵다. */}
              <span><b>반복 예약</b><em>평일마다 같은 시간</em></span>
            </label>
            {repeatWeekly && <div className="repeat-settings">
              <div>
                <span className="field-label">반복 종료 날짜</span>
                {/* '반복 예약'을 켜는 순간 이 칸이 생긴다. 그것 자체가 종료일을
                    고르라는 뜻이므로 달력을 한 번 더 누르게 하지 않는다. */}
                <DateField
                  openOnMount
                  skipWeekends={!repeatWeekends}
                  onSkipWeekendsChange={(skip) => setRepeatWeekends(!skip)}
                  value={repeatEnd}
                  rangeFrom={date}
                  onChange={(next) => { setRepeatEnd(next); setRepeatEndTouched(true); }}
                  onRangeChange={(start, endDate) => { setDate(start); setRepeatEnd(endDate); setRepeatEndTouched(true); }}
                  /* 달력이 열려 있는 동안 커서를 뺏지 않는다. 닫은 뒤에 회의 목적으로 넘긴다. */
                  onDone={handOffToPurpose}
                />
              </div>
              {/* 반복은 평일만 펼치므로, 고른 기간에 주말이 끼면 그 사실을 알려 준다. */}
              <p>
                {formatDateLabel(date)}부터 총 <b>{reservationDates.length}</b>회 예약됩니다.
                {REPEAT_CYCLE === "weekdays" && repeatEnd > date && <em className="repeat-note">주말 제외</em>}
              </p>
              {/* 어느 날이 잡히는지 날짜로 보여 준다. 숫자만으로는 주말이 어떻게
                  빠졌는지 확인할 방법이 없다. 많으면 앞 8개만 두고 나머지는 센다. */}
              <p className="repeat-days">
                {reservationDates.slice(0, 8).map((day) => <span key={day}>{formatDateLabel(day)}</span>)}
                {reservationDates.length > 8 && <span className="more">외 {reservationDates.length - 8}일</span>}
              </p>
            </div>}

            {/* 라벨을 칩 왼쪽에 눕혀 한 줄로 만든다. 세로를 30px 아낀다. */}
            <div className="form-row-duration">
            <span className="field-label">이용 시간</span>
            <div className="duration-switch">
              {bookingDefaults.durationPresetsMinutes.map((value) => <button key={value} type="button" className={duration === value ? "active" : ""} onClick={() => changeDuration(value)}>{value / 60}시간</button>)}
              <button type="button" className={allDay ? "active" : ""} onClick={selectAllDay}>종일</button>
            </div>
            </div>

            {/* 예약자와 본부는 한 줄에 둔다. 나중에 로그인 연동이 되면 한 칸으로 합칠 자리다. */}
            <div className="form-row form-row-owner">
            {currentUser
              ? <label><span className="field-label">예약자</span><input value={`${currentUser.name} (${currentUser.email})`} readOnly disabled /></label>
              : <label className={missingField === "owner" ? "field-missing" : undefined}>
                  <span className="field-label">예약자 이름<i className="req">*</i></span>
                  <input
                    id="owner-input"
                    value={owner}
                    onChange={(event) => { setOwner(event.target.value); if (event.target.value.trim()) setMissingField(null); }}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); focusNextRequired("owner"); } }}
                    placeholder="이름을 입력하세요"
                  />
                  {missingNote("owner")}
                </label>}
            <div className={`team-field ${teamOpen ? "open" : ""}`}>
              <label className={missingField === "team" ? "field-missing" : undefined}>
                <span className="field-label">본부명<i className="req">*</i></span>
                <input
                  id="team-input"
                  value={team}
                  role="combobox"
                  aria-expanded={teamOpen}
                  aria-controls="team-suggestions"
                  aria-autocomplete="list"
                  aria-activedescendant={teamOpen && filteredTeams[teamActiveIndex] ? `team-option-${teamActiveIndex}` : undefined}
                  autoComplete="off"
                  onFocus={() => setTeamOpen(true)}
                  onBlur={() => window.setTimeout(() => setTeamOpen(false), 120)}
                  onChange={(event) => {
                    setTeam(event.target.value);
                    setTeamActiveIndex(0);
                    setTeamOpen(true);
                    if (event.target.value.trim()) setMissingField(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && filteredTeams.length) {
                      event.preventDefault();
                      setTeamOpen(true);
                      setTeamActiveIndex((current) => (current + 1) % filteredTeams.length);
                    } else if (event.key === "ArrowUp" && filteredTeams.length) {
                      event.preventDefault();
                      setTeamOpen(true);
                      setTeamActiveIndex((current) => (current - 1 + filteredTeams.length) % filteredTeams.length);
                    } else if (event.key === "Enter" && teamOpen && filteredTeams[teamActiveIndex]) {
                      // 본부를 고르는 것으로 이 칸은 끝난다. 곧바로 다음 빈 칸으로.
                      event.preventDefault();
                      setTeam(filteredTeams[teamActiveIndex].name);
                      setTeamOpen(false);
                      setMissingField(null);
                      focusNextRequired("team");
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      focusNextRequired("team");
                    } else if (event.key === "Escape") {
                      setTeamOpen(false);
                    }
                  }}
                  placeholder="본부명을 검색하세요"
                />
                {missingNote("team")}
              </label>
              {teamOpen && (
                <div className="team-suggestions" id="team-suggestions" role="listbox">
                  {filteredTeams.length ? filteredTeams.map((item, index) => (
                    <button
                      type="button"
                      role="option"
                      id={`team-option-${index}`}
                      aria-selected={index === teamActiveIndex}
                      className={index === teamActiveIndex ? "active" : ""}
                      key={item.name}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setTeam(item.name);
                        setTeamOpen(false);
                        setMissingField(null);
                        focusNextRequired("team");
                      }}
                    >
                      <span>{item.name}</span>
                    </button>
                  )) : <p>검색 결과가 없습니다.</p>}
                </div>
              )}
            </div>
            </div>

            {/* 회의 목적도 필수라 예약자 바로 밑에 둔다. 필수끼리 모아야
                표에서 값을 가져왔을 때 스크롤 없이 다 보인다. */}
            {/* required를 쓰지 않는다. 브라우저가 그리는 흰 말풍선은 문구도 모양도
                바꿀 수 없고, 칸이 화면 밖이면 보이지도 않은 채 예약이 막힌다. */}
            {/* 시간을 아직 못 골랐으면(timeNeedsPick) 회의 목적까지 같이 밝히지
                않는다. 한 번에 두 곳을 가리키면 어디부터 할지 헷갈린다.
                시간을 고르고 나면 자연스럽게 다음 차례로 넘어와 밝혀진다. */}
            <label className={`${draftActive && !timeNeedsPick && !purpose.trim() ? "needs-input" : ""} ${missingField === "purpose" ? "field-missing" : ""}`.trim() || undefined}>
              <span className="field-label">회의 목적<i className="req">*</i></span>
              <input
                id="purpose-input"
                value={purpose}
                onChange={(event) => { setPurpose(event.target.value); if (event.target.value.trim()) setMissingField(null); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); focusNextRequired("purpose"); } }}
                placeholder="예: 주간회의"
              />
              {missingNote("purpose")}
            </label>

            {/* 참석자는 선택 항목이라 평소에는 접어 두고 누를 때만 펼친다. */}
            {attendeesOpen || attendees.length > 0 ? (
              <div className="attendee-field">
                {/* 정원을 넘어도 막지 않는다. 의자를 더 가져올 수 있으니 사실만 알린다. */}
                <label className={`field-label ${attendees.length > selected.capacity ? "over-capacity" : ""}`} htmlFor="attendee-input">참석자 <em>(선택)</em></label>
                <div className="attendee-box" onClick={() => document.getElementById("attendee-input")?.focus()}>
                  {attendees.map((name) => (
                    <span className="attendee-chip" key={name}>
                      {name}
                      <button type="button" aria-label={`${name} 참석자에서 빼기`} onClick={() => setAttendees((list) => list.filter((item) => item !== name))}>×</button>
                    </span>
                  ))}
                  <input
                    id="attendee-input"
                    value={attendeeDraft}
                    onChange={(event) => setAttendeeDraft(event.target.value)}
                    onKeyDown={addAttendee}
                    onBlur={addAttendee}
                    maxLength={bookingDefaults.maxAttendeeNameLength}
                    placeholder={attendees.length ? "" : "이름 입력 후 Enter"}
                  />
                </div>
                <p className="attendee-count">{attendees.length}명 · {formatCapacity(selected.capacity)}</p>
              </div>
            ) : (
              <button type="button" className="attendee-add" onClick={() => revealAfterExpand(".attendee-field", () => setAttendeesOpen(true))}>
                참석자 추가 <em>(선택)</em>
              </button>
            )}


            {/* 비품 요청. 재고는 사무실 전체가 함께 쓰므로 고른 시간대에 남은 수를 보여 준다. */}
            {equipmentOpen || equipmentCount > 0 ? (
              <div className="equipment-field">
                <div className="field-label">비품 요청 <em>(선택)</em>
                  {equipmentCount > 0 && <b className="equipment-count">{equipmentCount}개 요청</b>}
                </div>
                <div className="equipment-list">
                  {equipmentSlots.map((item) => {
                    const wanted = equipment[item.id] ?? 0;
                    const soldOut = item.left === 0 && wanted === 0;
                    return (
                      <div className={`equipment-row ${wanted > 0 ? "on" : ""} ${soldOut ? "sold-out" : ""}`} key={item.id}>
                        <span className="equipment-name">{item.name}</span>
                        {/* '남은'과 '재고'는 같은 말이라 하나만 둔다. */}
                        <span className="equipment-stock">
                          {soldOut ? "이 시간 모두 사용 중" : `재고 ${item.left - wanted}개`}
                        </span>
                        <span className="equipment-step">
                          <button type="button" aria-label={`${item.name} 하나 줄이기`} disabled={wanted === 0}
                            onClick={() => setEquipment((current) => {
                              const next = { ...current };
                              if (wanted <= 1) delete next[item.id]; else next[item.id] = wanted - 1;
                              return next;
                            })}>−</button>
                          <b>{wanted}</b>
                          <button type="button" aria-label={`${item.name} 하나 늘리기`} disabled={wanted >= item.left}
                            onClick={() => setEquipment((current) => ({ ...current, [item.id]: wanted + 1 }))}>＋</button>
                        </span>
                      </div>
                    );
                  })}
                </div>
                {/* '재고 N개'가 이미 그 시간에 남은 수를 뜻하므로 설명을 덧붙이지 않는다. */}
              </div>
            ) : (
              <button type="button" className="attendee-add equipment-add" onClick={() => revealAfterExpand(".equipment-field", () => setEquipmentOpen(true))}>
                비품 요청 <em>(선택)</em>
              </button>
            )}

            </div>

            {/* 넓은 화면에서만 보이는 회의실 설명. 예약 버튼 바로 위라 누르기
                직전에 '이 방이 맞나'를 마지막으로 확인하는 자리가 된다.
                (좁은 화면에서는 자리가 없어 CSS로 감춘다. 선 위의 카드를
                키우면 170px 기준선을 뚫으므로 여기에 둔다) */}
            <div className="selected-room-brief" aria-hidden="true">
              <div className="brief-top">
                <b>{selected.name}</b>
                <s>{formatCapacity(selected.capacity)} · {selected.floor}층 {selected.location}</s>
              </div>
              {selected.equipment.length > 0 && (
                <div className="brief-tags">{selected.equipment.map((item) => <em key={item}>{item}</em>)}</div>
              )}
              {(() => {
                const next = bookings
                  .filter((item) => item.roomId === selected.id && item.date === date && item.start >= end)
                  .sort((a, b) => a.start.localeCompare(b.start))[0];
                return next
                  ? <div className="brief-next">다음 예약 <b>{next.start} · {next.purpose}</b></div>
                  : <div className="brief-next">이 시간 뒤로 <b>예약 없음</b></div>;
              })()}
            </div>

            <div className="booking-submit">
            {notice && <div className={`notice ${notice.includes("완료") ? "success" : "error"}`}>{notice}</div>}
            {selectedTimeConflict && !notice && <div className="notice error">이미 예약된 시간입니다. 다른 시간을 선택해 주세요.</div>}
            <button id="reserve-button" className="reserve-button" type="submit" disabled={selectedTimeConflict || submitting}>
              <span>{selected.name}</span>
              {/* 반복 예약이면 몇 건이 만들어지는지 버튼이 직접 말해야 한다.
                  '예약하기'만 있으면 한 건인 줄 알고 누른다. */}
              <strong>{submitting ? "저장 중…" : selectedTimeConflict ? "이미 예약된 시간입니다"
                : reservationDates.length > 1 ? `${start}–${end} · ${reservationDates.length}건 예약하기`
                : `${start}–${end} 예약하기`}</strong>
            </button>
            </div>
          </form>
      </aside>
      {myBookingsOpen && <div className="my-bookings-backdrop" role="presentation" onMouseDown={() => { setMyBookingsOpen(false); setCancelSelection(null); }}>
        <section className="my-bookings-dialog" role="dialog" aria-modal="true" aria-labelledby="my-bookings-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="my-bookings-dialog-head"><div><h2 id="my-bookings-title">내 예약</h2></div><button type="button" onClick={() => { setMyBookingsOpen(false); setCancelSelection(null); }} aria-label="내 예약 닫기"><CloseIcon /></button></div>
          {!currentUser && <label className="my-bookings-search"><span>예약자 이름</span><input value={myBookingOwner} onChange={(event) => setMyBookingOwner(event.target.value)} placeholder="예약자 이름을 입력하세요" /></label>}
          <p className="my-bookings-summary">
            <span>예정 예약 <b>{upcomingMyBookings.length}</b></span>
            <span>지난 예약 <b>{pastMyBookings.length}</b></span>
          </p>
          <div className="my-bookings-table-wrap">
            <table className="my-bookings-table">
              <thead>
                <tr>
                  <th scope="col">날짜</th>
                  <th scope="col">시간</th>
                  <th scope="col">회의실</th>
                  <th scope="col">회의 목적 · 본부</th>
                  <th scope="col">상태</th>
                  <th scope="col">
                    {/* 고르는 중일 때만 전체선택을 띄운다. 예정 예약이 많으면 하나씩 누르기 번거롭다. */}
                    {cancelSelection !== null && upcomingMyBookings.length > 0 ? (
                      <label className="my-booking-pick my-booking-pick-all">
                        <input
                          type="checkbox"
                          checked={cancelSelection.length === upcomingMyBookings.length}
                          onChange={(event) => setCancelSelection(
                            event.target.checked ? upcomingMyBookings.map((booking) => booking.id) : [],
                          )}
                        />
                        <span>전체선택</span>
                      </label>
                    ) : upcomingMyBookings.length > 1 ? (
                      // 여러 건을 한 번에 취소하는 길. 예전에는 행의 '예약 취소'를
                      // 눌러야만 들어갈 수 있어, 그 버튼이 두 가지 일을 했다.
                      <button type="button" className="pick-many" onClick={() => setCancelSelection([])}>선택해서 취소</button>
                    ) : <span className="sr-only">예약 취소</span>}
                  </th>
                </tr>
              </thead>
              <tbody>
                {myBookingRows.length ? myBookingRows.map(({ booking, upcoming }) => {
                  const picking = cancelSelection !== null && upcoming;
                  const picked = picking && cancelSelection.includes(booking.id);
                  const toggle = () => setCancelSelection((current) => {
                    const list = current ?? [];
                    return list.includes(booking.id) ? list.filter((id) => id !== booking.id) : [...list, booking.id];
                  });
                  return (
                    <tr key={booking.id} className={`${upcoming ? "" : "is-past"} ${picked ? "is-picked" : ""}`.trim() || undefined}>
                      <td className="my-booking-date">{formatDateLabel(booking.date)}</td>
                      <td className="my-booking-time">{booking.start}–{booking.end}</td>
                      <td className="my-booking-room">{roomById(booking.roomId)?.name}</td>
                      <td className="my-booking-team">
                        {booking.purpose} · {teamOf(booking)}
                        {/* 비품을 요청한 예약에만 붙는다. 대부분은 요청이 없어
                            자리를 늘 차지하게 두면 빈 줄만 늘어난다.
                            딱지로 만들어 목적·본부 글자와 섞이지 않게 한다. */}
                        {equipmentSummary(booking) && (
                          <><br /><span className="my-booking-equipment"><b>비품</b>{equipmentSummary(booking)}</span></>
                        )}
                      </td>
                      <td><span className={`my-booking-badge ${isRunningNow(booking) ? "running" : ""}`}>
                        {isRunningNow(booking) ? "진행 중" : upcoming ? "예정" : "지난 예약"}
                      </span></td>
                      <td>
                        {upcoming && (
                          <div className="my-booking-actions">
                            {picking ? (
                              <label className="my-booking-pick">
                                <input type="checkbox" checked={picked} onChange={toggle} />
                                {/* '취소함'은 이미 취소된 것처럼 읽힌다. 아직 고르기만 한 상태이므로
                                    머리의 '전체선택'과 같은 말로 맞춘다. */}
                                <span>{picked ? "선택됨" : "선택"}</span>
                              </label>
                            ) : isRunningNow(booking) ? (
                              // 진행 중인 회의는 취소가 아니라 '지금 끝내기'가 필요한 동작이다.
                              <button type="button" className="end-now" onClick={() => setEarlyEnd(booking)}>지금 끝내기</button>
                            ) : (
                              // '예약 취소'는 곧바로 확인창을 연다. 예전에는 고르기 모드로
                              // 들어가 아무 일도 안 일어난 것처럼 보였고, 같은 글자가
                              // '고르기 시작'과 '실행' 두 뜻으로 쓰였다.
                              <button type="button" onClick={() => setCancelAsk([booking.id])}>예약 취소</button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                }) : <tr><td colSpan={6} className="my-bookings-empty">예약이 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
          {cancelSelection !== null && (() => {
            const first = upcomingMyBookings.find((booking) => booking.id === cancelSelection[0]);
            const series = first ? sameSeriesIds(first) : [];
            const seriesLeft = series.filter((id) => !cancelSelection.includes(id));
            return (
              <div className="my-bookings-cancelbar" role="group" aria-label="예약 취소">
                <p><b>{cancelSelection.length}건</b> 선택했습니다. 취소할 예약을 더 고를 수 있어요.</p>
                <div>
                  {seriesLeft.length > 0 && (
                    <button type="button" className="pick-series" onClick={() => setCancelSelection([...new Set([...cancelSelection, ...series])])}>
                      같은 반복 예약 {series.length}건 모두
                    </button>
                  )}
                  {/* 표 머리의 '전체선택' 체크박스가 같은 일을 하므로 여기서는 뺀다. */}
                  <button type="button" onClick={() => setCancelSelection(null)}>선택 해제</button>
                  <button
                    type="button"
                    className="cancel-confirm"
                    disabled={cancelSelection.length === 0 || cancelBusy}
                    onClick={() => setCancelAsk(cancelSelection)}
                  >
                    {cancelBusy ? "취소하는 중…" : `${cancelSelection.length}건 취소하기`}
                  </button>
                </div>
              </div>
            );
          })()}
        </section>
      </div>}
      {editDraft && <div className="edit-backdrop" role="presentation" onMouseDown={() => setEditDraft(null)}>
        <section className="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="edit-dialog-head">
            <div><h2 id="edit-dialog-title">예약 수정</h2></div>
            <button type="button" onClick={() => setEditDraft(null)} aria-label="예약 수정 닫기"><CloseIcon /></button>
          </div>
          <div className="edit-dialog-body">
            <label>
              <span className="field-label">회의실</span>
              <select value={editDraft.roomId} onChange={(event) => setEditDraft({ ...editDraft, roomId: event.target.value })}>
                {rooms.map((room) => <option key={room.id} value={room.id}>{room.floor}층 · {room.name}</option>)}
              </select>
            </label>
            <label>
              <span className="field-label">날짜</span>
              <DateField value={editDraft.date} onChange={(next) => setEditDraft({ ...editDraft, date: next })} />
            </label>
            <div className="edit-time-row">
              <label>
                <span className="field-label">시작</span>
                <select value={editDraft.start} onChange={(event) => setEditDraft({ ...editDraft, start: event.target.value })}>
                  {timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}
                </select>
              </label>
              <label>
                <span className="field-label">종료</span>
                <select value={editDraft.end} onChange={(event) => setEditDraft({ ...editDraft, end: event.target.value })}>
                  {timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}
                </select>
              </label>
            </div>
            <label>
              <span className="field-label">회의 목적</span>
              <input value={editDraft.purpose} onChange={(event) => setEditDraft({ ...editDraft, purpose: event.target.value })} placeholder="예: 주간회의" />
            </label>
            <label>
              <span className="field-label">본부</span>
              <input value={editDraft.team} onChange={(event) => setEditDraft({ ...editDraft, team: event.target.value })} placeholder="본부를 입력하세요" />
            </label>
          </div>
          {editNotice && <p className="edit-dialog-notice">{editNotice}</p>}
          <div className="edit-dialog-foot">
            {editConfirmDelete ? (
              <>
                <p>이 예약을 삭제할까요?</p>
                <button type="button" onClick={() => setEditConfirmDelete(false)}>유지</button>
                <button type="button" className="edit-delete" disabled={editBusy} onClick={deleteEditing}>삭제하기</button>
              </>
            ) : (
              <>
                <button type="button" className="edit-delete" onClick={() => setEditConfirmDelete(true)}>예약 삭제</button>
                <button type="button" onClick={() => setEditDraft(null)}>닫기</button>
                <button type="button" className="edit-save" disabled={editBusy} onClick={saveEdit}>{editBusy ? "저장 중…" : "수정 저장"}</button>
              </>
            )}
          </div>
        </section>
      </div>}
      {earlyEnd && <div className="edit-backdrop" role="presentation" onMouseDown={() => setEarlyEnd(null)}>
        <section className="early-dialog" role="dialog" aria-modal="true" aria-labelledby="early-end-title" onMouseDown={(event) => event.stopPropagation()}>
          <h2 id="early-end-title">지금 끝낼까요?</h2>
          <p>남은 시간이 바로 풀려서 다른 사람이 예약할 수 있게 됩니다.</p>
          <div className="early-summary">
            <b>{roomById(earlyEnd.roomId)?.name} · {earlyEnd.purpose}</b>
            <span>{earlyEnd.start}–{earlyEnd.end} → <em>{earlyEnd.start}–{earlyEndTime(earlyEnd)}</em></span>
            <span className="early-free">{spokenDuration(minutesOf(earlyEnd.end) - minutesOf(earlyEndTime(earlyEnd)))} 다시 열립니다</span>
          </div>
          <div className="early-foot">
            <button type="button" onClick={() => setEarlyEnd(null)}>그대로 두기</button>
            <button type="button" className="early-go" disabled={earlyEndBusy} onClick={confirmEarlyEnd}>
              {earlyEndBusy ? "끝내는 중…" : "끝내기"}
            </button>
          </div>
        </section>
      </div>}
      {repeatAsk && <div className="edit-backdrop" role="presentation" onMouseDown={() => setRepeatAsk(null)}>
        <section className="early-dialog" role="dialog" aria-modal="true" aria-labelledby="repeat-ask-title" onMouseDown={(event) => event.stopPropagation()}>
          <h2 id="repeat-ask-title">{repeatAsk.conflicts.length}일은 이미 차 있어요</h2>
          <p>그 날만 빼고 나머지를 예약할 수 있습니다.</p>
          <div className="early-summary">
            <b>{selected.name} · {start}–{end}</b>
            <span className="repeat-ask-list">
              {repeatAsk.conflicts.map((day) => {
                const taken = bookings.find(
                  (item) => item.date === day && item.roomId === selected.id
                    && item.start < end && item.end > start,
                );
                return (
                  <em key={day}>
                    {formatDateLabel(day)}{taken ? ` · ${taken.owner}` : ""}
                  </em>
                );
              })}
            </span>
            <span className="early-free">{repeatAsk.free.length}일은 지금 예약할 수 있습니다</span>
          </div>
          <div className="early-foot">
            <button type="button" onClick={() => setRepeatAsk(null)}>그만두기</button>
            <button type="button" className="early-go" disabled={submitting} onClick={() => sendBooking(repeatAsk.free)}>
              {submitting ? "예약하는 중…" : `${repeatAsk.free.length}일만 예약하기`}
            </button>
          </div>
        </section>
      </div>}
      {/* 취소 확인. 취소는 되돌릴 수 없으므로 무엇이 사라지는지 한 건씩 보여 주고,
          같은 반복 예약 중 몇 건을 지우는지도 함께 말한다. */}
      {cancelAsk && (() => {
        const picked = upcomingMyBookings.filter((booking) => cancelAsk.includes(booking.id));
        if (picked.length === 0) return null;
        // 고른 예약이 모두 같은 반복 묶음일 때만 '반복 중 몇 건' 이야기를 한다.
        // 서로 다른 예약을 섞어 골랐다면 그 문장은 거짓이 된다.
        const series = sameSeriesIds(picked[0]);
        const oneSeries = picked.every((booking) => series.includes(booking.id));
        const partOfSeries = oneSeries && series.length > 1;
        const wholeSeries = partOfSeries && series.every((id) => cancelAsk.includes(id));
        return (
          <div className="edit-backdrop cancel-backdrop" role="presentation" onMouseDown={() => setCancelAsk(null)}>
            <section className="early-dialog cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-ask-title" onMouseDown={(event) => event.stopPropagation()}>
              <h2 id="cancel-ask-title">예약 {picked.length}건을 취소할까요?</h2>
              <p>취소한 예약은 되돌릴 수 없습니다.</p>
              <div className="early-summary">
                <span className="cancel-ask-list">
                  {picked.map((booking) => (
                    <em key={booking.id}>
                      <b>{roomById(booking.roomId)?.name ?? booking.roomId}</b>
                      {formatDateLabel(booking.date)} · {booking.start}–{booking.end}
                      <i>{booking.purpose}</i>
                    </em>
                  ))}
                </span>
                {partOfSeries && (
                  <span className="cancel-ask-series">
                    {wholeSeries
                      ? `같은 반복 예약 ${series.length}건을 모두 취소합니다.`
                      : `같은 반복 예약 ${series.length}건 중 ${picked.length}건만 취소합니다. 나머지 ${series.length - picked.length}건은 그대로 남습니다.`}
                  </span>
                )}
              </div>
              <div className="early-foot">
                {/* '그만두기'는 «예약을 그만둔다»로도 읽혀 취소 창에서 뜻이 뒤집힌다. */}
                <button type="button" onClick={() => setCancelAsk(null)}>닫기</button>
                <button
                  type="button"
                  className="cancel-go"
                  disabled={cancelBusy}
                  onClick={() => { setCancelAsk(null); cancelBookings(cancelAsk); }}
                >
                  {cancelBusy ? "취소하는 중…" : `${picked.length}건 취소하기`}
                </button>
              </div>
            </section>
          </div>
        );
      })()}
      {/* 예전에는 3.5초 뒤 저절로 사라졌다. 내용을 다 읽기 전에 닫히는
          경우가 있어, 이제는 닫기를 눌러야 사라진다. */}
      {toast && <div className="booking-toast" role="status" aria-live="polite">
        <span className="booking-toast-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" focusable="false">
            <path d="M5 12.5 10 17.5 19 7.5" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <b>{toast.text}</b>
        <span className="booking-toast-detail">{toast.detail} <em>{toast.time}</em></span>
        <button type="button" className="booking-toast-close" aria-label="알림 닫기" onClick={() => setToast(null)}><CloseIcon /></button>
      </div>}
      <footer><span>※ 수용 인원과 장비 정보는 시제품용이며 관리자 설정에서 수정할 수 있습니다.</span><strong>사내 회의실 예약 시스템 · Prototype</strong></footer>
    </main>
  );
}
