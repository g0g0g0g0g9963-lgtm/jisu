"use client";

import { CSSProperties, FocusEvent as ReactFocusEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import siteConfig from "./config/site.json";
import officeTeams from "./config/teams.json";
import { RoomEquipment } from "./room-equipment";
import { BookingConflictDialog, editDraftOf, type EditDraft } from "./booking-conflict";
import { EmployeePicker, FavoriteButton, FavoriteIcon, MicrosoftPanel, useFavorites } from "./convenience";
import { type CurrentUser, deleteBookingRequest, fetchBookings, fetchMe, patchBookingRequest, postBookings } from "./lib/api";
import {
  type Booking,
  type Employee,
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
  formatWeekdayEnglish,
  getWorkWeek,
  isWeekend,
  minutesOf,
  moveDate,
  officeMinutesOfDay,
  todayKey,
  weekdayOf,
} from "./lib/datetime";
import { useDialogFocus, useNow, useStoredText } from "./lib/hooks";
import { publicHolidayOf } from "./lib/holidays";
import {
  describeRoomStatus,
  describeRoomSlotAvailability,
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
  /** 처음 누른 지점(분). 방향을 바꿔 끌어도 이 값은 그대로 고정된다. */
  anchorMinutes: number;
  pointerType: "mouse" | "touch";
};

type PendingTouchDrag = {
  pointerId: number;
  roomId: string;
  date: DateKey;
  anchorY: number;
  timer: number;
};

const TOUCH_DRAG_HOLD_MS = 360;
const TOUCH_DRAG_CANCEL_DISTANCE = 10;

type BookingAlternative = SlotSelection & {
  label: string;
  reason: string;
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
type Toast = {
  text: string;
  /** 회의실과 날짜. 시간은 색을 달리 주려고 따로 둔다. */
  detail: string;
  time: string;
  /** 예약 완료만 상단 알림으로 이동한다. 수정·취소 안내는 제자리에 남긴다. */
  kind?: "booking" | "notice";
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

/** 오늘과 같은 일자를 기준으로 한 달 전 날짜를 구한다. 월말은 해당 달의 마지막 날로 맞춘다. */
const oneCalendarMonthAgo = (key: DateKey): DateKey => {
  const current = new Date(`${key}T00:00:00Z`);
  const target = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(current.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
};

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

function ClockIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.6" />
    <path d="M12 7.5v4.8l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/** 빠른예약 패널 전용 이중 꺾쇠. */
function DoubleChevronIcon({ direction }: { direction: "prev" | "next" }) {
  const transform = direction === "next" ? "translate(20 0) scale(-1 1)" : undefined;
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false" style={{ width: 20 }}>
      <g transform={transform}>
        <path d="M9 5 5 10l4 5M15 5l-4 5 4 5" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
      </g>
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

/** 선택된 회의실을 글자 대신 표시하는 작은 체크. */
function SelectedRoomIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="m4.25 8.25 2.35 2.35 5.15-5.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
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

/** 상단 내 예약 진입점. 알림과 구분되는 얇은 선형 종 아이콘을 쓴다. */
function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M6.75 9.5a5.25 5.25 0 0 1 10.5 0c0 6 2.25 6.25 2.25 7.75H4.5c0-1.5 2.25-1.75 2.25-7.75Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.75 20a2.55 2.55 0 0 0 4.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

/** "8/19". 일간 제목은 숫자만 크게 쓰므로 '월·일' 글자를 덜어낸다. */
const slashDate = (key: DateKey): string => `${Number(key.slice(5, 7))}/${dayOfMonth(key)}`;

/**
 * 주간 제목의 날짜 범위. "8/17 ~ 8/21"처럼 양쪽에 월을 다 적고 물결로
 * 이으면, 달·일이 둘 다 두 자리인 주(예: 10/26~10/30)는 66px 글자로
 * 304px을 넘어 옆 조작부와 겹쳤다. 영문 표기 관례대로 en dash(–)를
 * 쓰고, 같은 달 안이면 뒤쪽 월을 생략한다("8/17–21"). 달이 걸치면
 * (예: 8/31–9/4) 양쪽 다 적는다. 이 압축만으로 실제 있을 수 있는 104주
 * 전체의 최댓값이 379px→304px로 줄어, 옆 조작부를 밀어내지 않고도
 * 66px 그대로 일간과 같은 크기를 쓸 수 있다.
 */
const weekRangeLabel = (start: DateKey, end: DateKey): string => {
  const startMonth = Number(start.slice(5, 7));
  const endMonth = Number(end.slice(5, 7));
  return startMonth === endMonth
    ? `${startMonth}/${dayOfMonth(start)}–${dayOfMonth(end)}`
    : `${startMonth}/${dayOfMonth(start)}–${endMonth}/${dayOfMonth(end)}`;
};

/** 100분 → "1시간 40분". 시각(01:40)과 헷갈리지 않게 말로 적는다. */
const spokenDuration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}분`;
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
};

/** 동명 회의실을 구분하는 위치 표기. */
const roomIdentity = (room: Room | undefined): string => room ? `${room.floor}층 · ${room.name}` : "회의실 정보 확인 중";


const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * "AUG · WEEK 3". 몇 월의 몇 번째 주인지. 일간의 영문 요일(WEDNESDAY)과 같은
 * 자리에 같은 모양으로 놓이는 머리표라 영문 대문자로 쓴다.
 * 기준은 그 주 월요일이 속한 달이다 — 달을 앞에 적어야 아래 큰 글자(날짜
 * 범위)를 보지 않고도 몇 월인지 바로 안다.
 */
const weekNumberLabel = (key: DateKey): string => {
  const [, month, day] = key.split("-").map(Number);
  return `${MONTH_ABBR[month - 1]} · WEEK ${Math.floor((day - 1) / 7) + 1}`;
};
const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * 날짜 입력칸. 브라우저 기본 달력은 위치와 모양을 바꿀 수 없어 직접 그린다.
 * 달력은 입력칸 오른쪽 끝선에 맞춰 열린다.
 */
function DateField({ value, min, onChange, rangeFrom, onRangeChange, variant = "field", allowAnyDate = false, controlledOpen, onOpenChange, inlineWhenOpen = false, skipWeekends = true, onSkipWeekendsChange, onDone }: {
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
  /** 반복 종료 달력처럼 바깥 체크 상태와 열림을 직접 연결할 때 사용한다. */
  controlledOpen?: boolean;
  onOpenChange?: (next: boolean) => void;
  /** 반복 종료 달력은 팝업 위치 계산 없이 입력칸 바로 아래에 펼친다. */
  inlineWhenOpen?: boolean;
  /**
   * 기간 안의 주말·공휴일을 건너뛸지. 끄면 모든 날짜를 포함한다.
   * 달력 아래 '주말·공휴일 포함' 체크로 바꾼다.
   */
  skipWeekends?: boolean;
  onSkipWeekendsChange?: (skip: boolean) => void;
  /** 기간 고르기에서 '완료'를 눌러 달력을 닫았을 때. */
  onDone?: () => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(open) : next;
    if (controlledOpen === undefined) setInternalOpen(resolved);
    onOpenChange?.(resolved);
  }, [controlledOpen, onOpenChange, open]);
  const [viewMonth, setViewMonth] = useState(() => value.slice(0, 7));
  const [dragFrom, setDragFrom] = useState<DateKey | null>(null);
  const [dragTo, setDragTo] = useState<DateKey | null>(null);
  const rangeDraggedRef = useRef(false);
  const draggingRef = useRef(false);
  const dragPointerRef = useRef<number | null>(null);
  const suppressRangeClickRef = useRef(false);
  const dragFromRef = useRef<DateKey | null>(null);
  const dragToRef = useRef<DateKey | null>(null);
  const onRangeChangeRef = useRef(onRangeChange);
  // 기간 고르기에서 지금 무엇을 고르는 중인지. 위의 시작일·종료일 상자로 바꾼다.
  const [pickTarget, setPickTarget] = useState<"start" | "end">("start");
  // 기간을 다 골랐는지. 다 골랐어도 창은 닫지 않고 '완료'를 기다린다.
  const [rangeSettled, setRangeSettled] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { onRangeChangeRef.current = onRangeChange; }, [onRangeChange]);

  // 달력을 새로 열 때는 언제나 시작일부터 고른다.
  useEffect(() => { if (open) { setPickTarget("start"); setRangeSettled(false); } }, [open]);

  // 값이 바깥에서 바뀌면(예: 빈 시간 자동 선택) 그 달을 보여 준다.
  useEffect(() => { setViewMonth(value.slice(0, 7)); }, [value]);

  /**
   * 예약 폼은 입력칸 영역만 스크롤되는데, 달력이 그보다 커서 위아래 어느 쪽으로
   * 펼쳐도 잘린다. 그 안에서 열릴 때는 화면 기준(fixed)으로 띄워 잘리지 않게 한다.
   */
  const [floatAt, setFloatAt] = useState<{ left: number; top: number; width?: number } | null>(null);
  useEffect(() => {
    if (!open || inlineWhenOpen) {
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
      // 반복 기간 달력은 종료일 입력칸과 정확히 같은 폭으로 열어 하나의 컨트롤처럼 보이게 한다.
      const width = rangeFrom ? box.width : undefined;
      const panelWidth = width ?? panel.offsetWidth;
      // 끝까지 굴려도 모자라면 화면 아래에 붙여 둔다. 그래도 위로는 열지 않는다.
      const top = Math.min(box.bottom + 6, Math.max(8, window.innerHeight - 8 - height));
      const left = Math.max(8, box.right - panelWidth);
      // 값이 그대로면 다시 그리지 않는다. 스크롤마다 상태를 바꾸면 끌기가 끊긴다.
      setFloatAt((current) =>
        current && Math.abs(current.left - left) < 1 && Math.abs(current.top - top) < 1 && Math.abs((current.width ?? 0) - (width ?? 0)) < 1
          ? current
          : { left, top, width });
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
  }, [inlineWhenOpen, open]);

  /* 인라인 달력이 생기면 스크롤 영역 안에서 달력 전체가 보이는 위치로 옮긴다. */
  useEffect(() => {
    if (!open || !inlineWhenOpen) return;
    const frame = window.requestAnimationFrame(() => {
      wrapRef.current?.querySelector<HTMLElement>(".date-panel")?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inlineWhenOpen, open]);

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

  const selectRangeDay = useCallback((key: DateKey) => {
    if (!rangeFrom || !onRangeChange) return;
    if (pickTarget === "start") {
      // 한 번 누르면 시작일을 확정하고 곧바로 종료일 선택으로 넘어간다.
      onRangeChange(key, value >= key ? value : key);
      setPickTarget("end");
      setRangeSettled(false);
      return;
    }

    // 종료일이 시작일보다 앞이면 두 날짜를 자연스럽게 뒤집는다.
    const [first, last] = key >= rangeFrom ? [rangeFrom, key] : [key, rangeFrom];
    onRangeChange(first, last);
    setPickTarget("end");
    setRangeSettled(true);
  }, [onRangeChange, pickTarget, rangeFrom, value]);

  /**
   * 반복 날짜 끌기는 버튼마다 이벤트를 나누지 않고, 다시 그려져도 사라지지 않는
   * 달력 격자가 처음부터 끝까지 맡는다. 포인터를 격자에 캡처해 버튼 사이의 여백이나
   * 빠른 움직임을 지나도 pointerup을 놓치지 않는다.
   */
  const dateKeyAtPoint = useCallback((clientX: number, clientY: number) => {
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLButtonElement>(".date-panel-grid button[data-date-key]");
    if (!target || target.getAttribute("aria-disabled") === "true") return null;
    return (target.dataset.dateKey as DateKey | undefined) ?? null;
  }, []);

  const clearRangeDrag = useCallback(() => {
    draggingRef.current = false;
    dragPointerRef.current = null;
    dragFromRef.current = null;
    dragToRef.current = null;
    setDragFrom(null);
    setDragTo(null);
  }, []);

  const commitRangeDrag = useCallback(() => {
    const firstDate = dragFromRef.current;
    const lastDate = dragToRef.current;
    if (firstDate && lastDate && onRangeChangeRef.current && rangeDraggedRef.current) {
      const [first, last] = firstDate <= lastDate ? [firstDate, lastDate] : [lastDate, firstDate];
      onRangeChangeRef.current(first, last);
      setPickTarget("end");
      setRangeSettled(true);
    }
    clearRangeDrag();
  }, [clearRangeDrag]);

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
          className={`date-panel${floatAt ? " date-panel-float" : ""}${inlineWhenOpen ? " date-panel-inline" : ""}`}
          style={floatAt ? { position: "fixed", left: floatAt.left, top: floatAt.top, right: "auto", width: floatAt.width } : undefined}
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
          <div
            className={`date-panel-grid${rangeFrom ? " range-enabled" : ""}`}
            onDragStart={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (!rangeFrom || (event.pointerType === "mouse" && event.button !== 0)) return;
              const key = dateKeyAtPoint(event.clientX, event.clientY);
              if (!key) return;
              suppressRangeClickRef.current = false;
              rangeDraggedRef.current = false;
              draggingRef.current = true;
              dragPointerRef.current = event.pointerId;
              dragFromRef.current = key;
              dragToRef.current = key;
              setDragFrom(key);
              setDragTo(key);
              try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 구형 터치 브라우저는 격자 버블링으로 계속 처리한다. */ }
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              if (!rangeFrom || !draggingRef.current || dragPointerRef.current !== event.pointerId) return;
              const key = dateKeyAtPoint(event.clientX, event.clientY);
              if (!key || key === dragToRef.current) return;
              rangeDraggedRef.current = true;
              dragToRef.current = key;
              setDragTo(key);
              event.preventDefault();
            }}
            onPointerUp={(event) => {
              if (!rangeFrom || !draggingRef.current || dragPointerRef.current !== event.pointerId) return;
              const firstDate = dragFromRef.current;
              suppressRangeClickRef.current = true;
              window.setTimeout(() => { suppressRangeClickRef.current = false; }, 0);
              try {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              } catch { /* 캡처를 지원하지 않는 환경 */ }
              if (rangeDraggedRef.current) commitRangeDrag();
              else {
                clearRangeDrag();
                if (firstDate) selectRangeDay(firstDate);
              }
              event.preventDefault();
            }}
            onPointerCancel={(event) => {
              if (dragPointerRef.current !== event.pointerId) return;
              try {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              } catch { /* 캡처를 지원하지 않는 환경 */ }
              clearRangeDrag();
            }}
          >
            {Array.from({ length: firstWeekday }, (_, index) => <span key={`blank-${index}`} />)}
            {Array.from({ length: lastDay }, (_, index) => {
              const day = index + 1;
              const key = `${year}-${pad2(month)}-${pad2(day)}`;
              // 주말 예약을 막아 둔 설정에서만 토·일을 고를 수 없다.
              const disabled = !allowAnyDate && (key < earliest || (!bookingDefaults.allowWeekends && isWeekend(key)));
              const isToday = key === todayValue;
              const isPast = key < todayValue;
              const holiday = publicHolidayOf(key);
              // 고를 수 있더라도 주말은 한눈에 구분되도록 색을 달리한다.
              const weekdayIndex = (firstWeekday + index) % 7;
              const weekendClass = weekdayIndex === 0 ? "is-sun" : weekdayIndex === 6 ? "is-sat" : "";
              const inRange = Boolean(previewFrom && previewTo && key > previewFrom && key < previewTo);
              // 기간 고르기는 반복 예약에만 쓰고 반복은 평일만 잡히므로,
              // 범위 안의 주말·공휴일은 칠하지 않고 빠지는 날로 보여 준다.
              const skipped = Boolean(rangeFrom) && skipWeekends && (weekendClass !== "" || Boolean(holiday))
                && Boolean(previewFrom && previewTo && key >= previewFrom && key <= previewTo);
              const isEdge = rangeFrom
                ? !skipped && (key === previewFrom || key === previewTo)
                : key === value;
              return (
                <button
                  type="button"
                  key={key}
                  data-date-key={key}
                  // 고를 수 없는 날도 disabled 대신 표시만 막는다.
                  // disabled면 마우스 이벤트가 오지 않아 그 위를 지나는 순간 끌기가 끊긴다.
                  aria-disabled={disabled}
                  aria-label={`${formatDateLabel(key)}${holiday ? `, ${holiday.name}` : ""}${isToday ? ", 오늘" : ""}`}
                  title={holiday?.name}
                  className={`${isEdge ? "selected" : ""} ${inRange && !skipped ? "in-range" : ""} ${skipped ? "range-skip" : ""} ${disabled ? "disabled" : ""} ${isPast ? "is-past" : ""} ${isToday ? "is-today" : ""} ${holiday ? "is-holiday" : ""} ${weekendClass}`}
                  onClick={(event) => {
                    if (disabled) return;
                    if (rangeFrom) {
                      // 포인터 입력은 격자의 pointerup이 처리한다. Enter/Space로 생긴
                      // 키보드 click만 여기서 처리한다.
                      if (suppressRangeClickRef.current) {
                        suppressRangeClickRef.current = false;
                        return;
                      }
                      selectRangeDay(key);
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    onChange(key);
                    setOpen(false);
                  }}
                >
                  {day}
                  {(holiday || isToday) && <em>{holiday?.calendarLabel ?? "오늘"}</em>}
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
                  <span>주말·공휴일 포함</span>
                  <em>{skipWeekends ? "주말·공휴일은 건너뜁니다" : "주말·공휴일도 예약합니다"}</em>
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
            <span><small>{booking.owner} · {teamOf(booking)}</small></span>
          </div>
        )) : <p>선택한 날짜에는 예약이 없습니다.</p>}
      </div>
      {/* 배치도에서는 예약하지 않는다. 어디에 있는 방인지 보는 곳이고,
          예약은 오른쪽 '빠른 예약' 한 곳에서만 끝낸다. */}
    </section>
  );
}

function ReservationHoverCard() {
  return <span className="reservation-hover-card" role="tooltip">
    <em className="reservation-detail-hint">눌러서 수정·삭제</em>
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
  const [attendeeAccounts, setAttendeeAccounts] = useState<Employee[]>([]);
  const [attendeeDraft, setAttendeeDraft] = useState("");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [toastFlight, setToastFlight] = useState<{ x: number; y: number } | null>(null);
  const [bellArrival, setBellArrival] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [bookingRecovery, setBookingRecovery] = useState<{ owner: string; roomId: string; dates: string[]; start: string; end: string; timedOut: boolean } | null>(null);
  const [checkingBookingResult, setCheckingBookingResult] = useState(false);
  // SSO 모드에서는 로그인 계정이 예약자다. null이면 익명 모드(이름 직접 입력).
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const favorites = useFavorites(currentUser, authReady);
  const [authError, setAuthError] = useState("");
  const [showMap, setShowMap] = useState(false);
  const [allDay, setAllDay] = useState(false);
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  const [roomPickerFavoritesOnly, setRoomPickerFavoritesOnly] = useState(false);
  const [timePickerOpen, setTimePickerOpen] = useState<"start" | "end" | null>(null);
  const [bookingDateCalendarOpen, setBookingDateCalendarOpen] = useState(false);
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [repeatEndCalendarOpen, setRepeatEndCalendarOpen] = useState(false);
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
  /** 상단바에 쓸 이름. SSO로 들어왔으면 계정 이름, 아니면 예약할 때 쓴 이름. */
  const headerName = currentUser?.name ?? myBookingOwner;
  // 선택 삭제할 ID. null/빈 배열이면 선택된 예약이 없다.
  const [cancelSelection, setCancelSelection] = useState<string[] | null>(null);
  // 예정 삭제 / 진행 중 남은 시간 해제의 결과를 먼저 확인한다.
  const [cancelAsk, setCancelAsk] = useState<string[] | null>(null);
  // 비어 있는 필수 칸. 브라우저가 그리는 흰 말풍선(required) 대신 우리가 표시한다.
  // 말풍선은 모양·문구를 바꿀 수 없고 화면 밖이면 보이지도 않는다.
  const [missingField, setMissingField] = useState<"owner" | "team" | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  // 참석자 칸은 선택 항목이라 접어 둔다.
  const [attendeesOpen, setAttendeesOpen] = useState(false);
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
  const [editConflict, setEditConflict] = useState(false);
  const [editNotice, setEditNotice] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editConfirmDelete, setEditConfirmDelete] = useState(false);
  // 일정표를 최대한 넓게 볼 수 있도록 빠른 예약은 항상 접힌 상태로 시작한다.
  // 사용자가 펼친 뒤 입력한 값은 패널을 다시 접어도 그대로 남는다.
  const [bookingPanelOpen, setBookingPanelOpen] = useState(false);
  const [slotDrag, setSlotDrag] = useState<SlotDrag | null>(null);
  const [keyboardSelection, setKeyboardSelection] = useState<SlotSelection | null>(null);
  const [selectionFeedback, setSelectionFeedback] = useState("");
  const [extraDetailsOpen, setExtraDetailsOpen] = useState(false);
  const pendingTouchDrag = useRef<PendingTouchDrag | null>(null);
  // 주간 화면 더블클릭은 일간 드래그와 달리 시간을 정한 적이 없다.
  // 회의실·날짜만 고르고, 시간은 빠른 예약 창에서 직접 고르게 한다.
  const [alternativesExpanded, setAlternativesExpanded] = useState(false);
  // 주간 더블클릭으로 넘어온 뒤, 시간을 아직 스스로 고르지 않았다는 표시.
  // 시작·종료 시간 중 하나라도 바꾸면 풀린다.
  const [timeNeedsPick, setTimeNeedsPick] = useState(false);
  const [submitPreviewDates, setSubmitPreviewDates] = useState<string[] | null>(null);

  // 모달 여러 개가 겹칠 수 있어(예: 내 예약 위에 삭제 확인), 가장 위에 뜬
  // 것 하나만 Escape·Tab을 갖도록 우선순위를 매긴다. 겹칠 수 있는 목록이
  // 위에, 늘 단독으로 뜨는 것들이 아래에 온다.
  const topmostDialog = editConflict && editDraft ? "editConflict"
    : cancelAsk ? "cancelAsk"
    : repeatAsk ? "repeatAsk"
    : submitPreviewDates ? "submitPreviewDates"
    : editDraft ? "editDraft"
    : myBookingsOpen ? "myBookingsOpen"
    : null;

  const cancelAskDialogRef = useRef<HTMLElement | null>(null);
  const repeatAskDialogRef = useRef<HTMLElement | null>(null);
  const submitPreviewDialogRef = useRef<HTMLElement | null>(null);
  const editDraftDialogRef = useRef<HTMLElement | null>(null);
  const myBookingsDialogRef = useRef<HTMLElement | null>(null);

  useDialogFocus(cancelAskDialogRef, Boolean(cancelAsk), topmostDialog === "cancelAsk", () => setCancelAsk(null));
  useDialogFocus(repeatAskDialogRef, Boolean(repeatAsk), topmostDialog === "repeatAsk", () => setRepeatAsk(null));
  useDialogFocus(submitPreviewDialogRef, Boolean(submitPreviewDates), topmostDialog === "submitPreviewDates", () => setSubmitPreviewDates(null));
  useDialogFocus(editDraftDialogRef, Boolean(editDraft), topmostDialog === "editDraft", () => { if (!editBusy) setEditDraft(null); });
  useDialogFocus(myBookingsDialogRef, myBookingsOpen, topmostDialog === "myBookingsOpen", () => { setMyBookingsOpen(false); setCancelSelection(null); });

  const [monitorMode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("mode") === "monitor" || params.get("display") === "monitor";
  });

  const { date, start, end } = slot;
  const mutationBusy = submitting || editBusy || cancelBusy;
  // 응답을 기다리며 다음 예약을 작성했다면 완료 처리가 새 입력을 지우지 않는다.
  const draftKey = JSON.stringify([selectedId, slot, owner, team, purpose, attendees, attendeeAccounts, attendeeDraft,
    repeatWeekly, repeatEnd, repeatWeekends, allDay, timeNeedsPick]);
  const latestDraftKey = useRef(draftKey);
  latestDraftKey.current = draftKey;
  const setDate = (next: DateKey) => setSlot((current) => ({ ...current, date: next }));

  // 예약 완료 카드는 충분히 읽을 시간을 둔 뒤 상단 알림 종으로 들어간다.
  // 위치를 고정값으로 두지 않고 실제 종의 좌표를 재서 노트북·모니터 폭 모두 맞춘다.
  useEffect(() => {
    if (!toast || toast.kind !== "booking") {
      setToastFlight(null);
      return;
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const flyTimer = window.setTimeout(() => {
      const bell = document.querySelector<HTMLElement>(".header-bookings-bell");
      const card = document.querySelector<HTMLElement>(".booking-complete-dialog");
      if (!bell || !card || reduceMotion) return;
      const bellBounds = bell.getBoundingClientRect();
      const cardBounds = card.getBoundingClientRect();
      setToastFlight({
        x: bellBounds.left + bellBounds.width / 2 - (cardBounds.left + cardBounds.width / 2),
        y: bellBounds.top + bellBounds.height / 2 - (cardBounds.top + cardBounds.height / 2),
      });
    }, 1800);
    const finishTimer = window.setTimeout(() => {
      setToast(null);
      setToastFlight(null);
      setBellArrival(true);
    }, reduceMotion ? 2200 : 2500);

    return () => {
      window.clearTimeout(flyTimer);
      window.clearTimeout(finishTimer);
    };
  }, [toast]);

  useEffect(() => {
    if (!bellArrival) return;
    const timer = window.setTimeout(() => setBellArrival(false), 850);
    return () => window.clearTimeout(timer);
  }, [bellArrival]);

  // 예약의 진실의 원천은 서버 DB다. 30초 주기 + 창 포커스 시 다시 읽어
  // 다른 사람이 잡은 예약을 화면에 반영한다.
  const refreshSeq = useRef(0);
  // 서버가 아직 안 켜졌거나 잠깐 끊긴 경우, 30초 주기를 그냥 기다리게 두면
  // 화면이 한참 동안 오류만 보여 준다. 실패하면 곧 다시 시도하고, 시도할수록
  // 간격을 늘려(최대 8초) 서버에 부담을 주지 않는다. 성공하면 원래 30초
  // 주기로 돌아간다.
  const retryTimer = useRef<number | null>(null);
  const retryDelay = useRef(1000);
  const refreshBookings = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const data = await fetchBookings();
      if (seq !== refreshSeq.current) return; // 그 사이 더 최신 요청이 있었다면 늦게 도착한 이 응답은 버린다
      setBookings(data);
      setSyncError("");
      retryDelay.current = 1000;
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    } catch (error) {
      if (seq !== refreshSeq.current) return;
      setSyncError(error instanceof Error ? error.message : "서버와 통신할 수 없습니다.");
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      retryTimer.current = window.setTimeout(() => { void refreshBookings(); }, retryDelay.current);
      retryDelay.current = Math.min(retryDelay.current * 2, 8000);
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
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    };
  }, [refreshBookings]);

  // 아직 직접 고르지 않았다면 반복 종료일을 예약 날짜 기준으로 다시 잡는다.
  useEffect(() => {
    if (repeatEndTouched) return;
    setRepeatEnd(moveDate(date, bookingDefaults.defaultRepeatSpanDays));
  }, [date, repeatEndTouched]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let delay = 1000;
    const checkUser = async () => {
      try {
        const user = await fetchMe();
        if (!active) return;
        setCurrentUser(user);
        setAuthReady(true);
        setAuthError("");
        if (user) {
          setOwner(user.name);
          setMyBookingOwner(user.name);
        }
      } catch {
        if (!active) return;
        setAuthError("로그인 상태를 확인하지 못했습니다. 연결을 확인하며 다시 시도하고 있습니다.");
        timer = window.setTimeout(() => { void checkUser(); }, delay);
        delay = Math.min(delay * 2, 8000);
      }
    };
    void checkUser();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [setMyBookingOwner]);

  useEffect(() => {
    const closePickers = (event: MouseEvent) => {
      const target = event.target as Node | null;
      const insideRoomPicker = Boolean(target && document.querySelector(".room-picker-card")?.contains(target));
      const insideTimePicker = Boolean(target && document.querySelector(".booking-time-section")?.contains(target));
      if (!insideRoomPicker) setRoomPickerOpen(false);
      if (!insideTimePicker) setTimePickerOpen(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // submitPreviewDates 등 다이얼로그는 useDialogFocus가 각자
      // Escape를 처리한다(겹쳤을 때 가장 위의 것 하나만 닫히게 하기 위함).
      // 여기서는 다이얼로그가 아닌 가벼운 팝오버만 정리한다.
      setRoomPickerOpen(false);
      setTimePickerOpen(null);
    };
    document.addEventListener("click", closePickers);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closePickers);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

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
        describeRoomStatus(byRoom.get(room.id) ?? [], nowMinutes, { isToday: viewingToday, isPast: date < today }),
      ]),
    );
  }, [bookings, date, today, nowMinutes]);

  const statusOf = (room: Room) => roomStatuses.get(room.id) ?? UNKNOWN_STATUS;

  const floorRooms = rooms.filter((room) => room.floor === floor);
  const selected = roomById(selectedId) ?? rooms[0];
  const selectedStatus = statusOf(selected);

  // 달력의 '주말·공휴일 포함'을 켜면 모든 날짜를 빠짐없이 잡는다.
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
  const selectionAvailability = describeRoomSlotAvailability(
    bookings.filter((booking) => booking.roomId === selected.id), date, start, end, { today, nowMinutes },
  );
  // 부분 반복 충돌은 예약 가능한 날짜만 확인하는 기존 흐름을 유지한다.
  const bookingBlockReason = syncError ? "예약 현황 연결을 확인한 뒤 다시 시도해 주세요."
    : reservationDates.length === 0 ? "예약할 날짜가 없습니다. 반복 기간을 확인해 주세요."
    : reservationDates.some((day) => day < today) ? "지난 날짜에는 예약할 수 없습니다."
    : selectionAvailability.status !== "available" && selectionAvailability.status !== "conflict" ? selectionAvailability.nextLabel
    : selectedTimeConflict && conflictDates.length === reservationDates.length ? "선택 시간과 기존 예약이 겹칩니다. 다른 시간을 선택해 주세요."
    : "";

  const slotIsFree = useCallback((roomId: string, targetDate: DateKey, slotStart: string, slotEnd: string, ignoreId?: string) => (
    !bookings.some((booking) => booking.id !== ignoreId && booking.roomId === roomId && booking.date === targetDate
      && booking.start < slotEnd && booking.end > slotStart)
  ), [bookings]);

  const slotIsBookable = useCallback((roomId: string, slotStart: string, slotEnd: string) => (
    reservationDates.length > 0
    && minutesOf(slotStart) >= minutesOf(bookingDefaults.openingTime)
    && minutesOf(slotEnd) <= minutesOf(bookingDefaults.closingTime)
    && minutesOf(slotEnd) > minutesOf(slotStart)
    && reservationDates.every((day) => day >= today
      && (day !== today || (nowMinutes !== null && minutesOf(slotStart) >= nowMinutes))
      && slotIsFree(roomId, day, slotStart, slotEnd))
  ), [reservationDates, today, nowMinutes, slotIsFree]);

  const roomChoices = useMemo(() => rooms.map((room) => {
    const availableForSlot = slotIsBookable(room.id, start, end);
    const next = bookings
      .filter((booking) => booking.roomId === room.id && booking.date === date && booking.start >= end)
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    return { room, availableForSlot, next };
  }).sort((a, b) => Number(b.availableForSlot) - Number(a.availableForSlot)
    || Number(b.room.floor === floor) - Number(a.room.floor === floor)
    || a.room.capacity - b.room.capacity), [bookings, date, end, floor, slotIsBookable, start]);

  // 선택 팝업은 상태가 바뀌어도 위치가 움직이지 않게 설정 파일의 고정 순서를 쓴다.
  // 층별 회의실 순서는 rooms.json에서 관리한다. 예약 ID와 표시 순서는 독립적이다.
  const roomPickerChoices = useMemo(() => [...roomChoices].sort((a, b) => (
    rooms.findIndex((room) => room.id === a.room.id) - rooms.findIndex((room) => room.id === b.room.id)
  )), [roomChoices]);
  const visibleRoomPickerChoices = roomPickerFavoritesOnly
    ? roomPickerChoices.filter(({ room }) => favorites.ids.includes(room.id)) : roomPickerChoices;

  const availableStartOptions = useMemo(() => {
    // 프리셋(1/2/4시간)에 없는 길이(드래그로 잡은 30분·90분 등)도 실제 길이 그대로 써야 한다.
    // duration은 프리셋 버튼 강조 표시용이라, 프리셋이 아니면 0이 되어 실제 길이와 다르다.
    const currentDuration = minutesOf(end) - minutesOf(start);
    const length = currentDuration > 0 ? currentDuration : bookingDefaults.defaultDurationMinutes;
    return startTimeOptions.filter((candidate) => {
      if (date === today && nowMinutes !== null && minutesOf(candidate) < nowMinutes) return false;
      const candidateEnd = addMinutes(candidate, length);
      return minutesOf(candidateEnd) <= minutesOf(lastSelectableTime)
        && slotIsBookable(selected.id, candidate, candidateEnd);
    });
  }, [date, end, nowMinutes, selected.id, slotIsBookable, start, today]);

  const availableEndOptions = useMemo(() => timeOptions.filter((candidate) => (
    minutesOf(candidate) > minutesOf(start) && slotIsBookable(selected.id, start, candidate)
  )), [selected.id, slotIsBookable, start]);

  const bookingAlternatives = useMemo<BookingAlternative[]>(() => {
    if (!selectedTimeConflict) return [];
    const suggestions: BookingAlternative[] = [];
    const seen = new Set<string>();
    const add = (item: BookingAlternative) => {
      const key = `${item.roomId}-${item.date}-${item.start}-${item.end}`;
      if (!seen.has(key)) { seen.add(key); suggestions.push(item); }
    };

    roomChoices.filter((item) => item.room.id !== selected.id && item.availableForSlot).slice(0, 2).forEach(({ room }) => add({
      roomId: room.id, date, start, end, label: `${room.name} · ${start}–${end}`, reason: "같은 시간에 이용 가능",
    }));

    const length = minutesOf(end) - minutesOf(start);
    for (const offset of [30, -30, 60, -60]) {
      const nextStartMinutes = minutesOf(start) + offset;
      const nextEndMinutes = nextStartMinutes + length;
      if (nextStartMinutes < minutesOf(bookingDefaults.openingTime) || nextEndMinutes > minutesOf(bookingDefaults.closingTime)) continue;
      const nextStart = formatMinutes(nextStartMinutes);
      const nextEnd = formatMinutes(nextEndMinutes);
      if (slotIsBookable(selected.id, nextStart, nextEnd)) add({
        roomId: selected.id, date, start: nextStart, end: nextEnd,
        label: `${selected.name} · ${nextStart}–${nextEnd}`, reason: offset > 0 ? `${offset}분 뒤 이용 가능` : `${Math.abs(offset)}분 앞 이용 가능`,
      });
    }

    if (length > bookingDefaults.slotMinutes) {
      const shorterEnd = formatMinutes(minutesOf(end) - bookingDefaults.slotMinutes);
      if (slotIsBookable(selected.id, start, shorterEnd)) add({
        roomId: selected.id, date, start, end: shorterEnd,
        label: `${selected.name} · ${start}–${shorterEnd}`, reason: `${bookingDefaults.slotMinutes}분 짧게 이용 가능`,
      });
    }
    return suggestions.slice(0, 4);
  }, [date, end, roomChoices, selected, selectedTimeConflict, slotIsBookable, start]);

  useEffect(() => {
    setAlternativesExpanded(false);
  }, [selectedId, date, start, end]);

  const availableCount = syncError ? 0 : floorRooms.filter((room) => slotIsBookable(room.id, start, end)).length;
  const weekDays = useMemo(() => getWorkWeek(date), [date]);
  // 주간 화면에서는 날짜 칸이 한 주를 통째로 가리키고 화살표도 일주일씩 움직인다.
  const weekView = scheduleView === "week";
  const selectedDateHoliday = weekView ? undefined : publicHolidayOf(date);
  const selectedDateWeekday = weekView ? undefined : weekdayOf(date);
  // 같은 주인지는 월요일끼리 비교한다. 오늘이 토·일이면 월~금 목록에 없어서
  // 목록 포함 여부로 보면 '이번 주'가 표시되지 않는다.
  const thisWeek = weekDays[0] === getWorkWeek(today)[0];
  const filteredTeams = officeTeams
    .filter((item) => item.name.toLowerCase().includes(team.trim().toLowerCase()))
    .slice(0, 8);
  const currentTimePercent = nowMinutes !== null && nowMinutes >= timelineStart && nowMinutes <= timelineEnd
    ? ((nowMinutes - timelineStart) / (timelineEnd - timelineStart)) * 100
    : null;
  const showCurrentTime = currentTimePercent !== null && (scheduleView === "week" ? weekDays.includes(today) : date === today);

  // 현재 시각 안내선을 시간표 좌표에 맞춘다. 스크롤한 상태에서도
  // 재측정 값이 흔들리지 않도록 뷰포트 좌표를 스크롤 콘텐츠 좌표로 바꾼다.
  const dailyGridRef = useRef<HTMLDivElement | null>(null);
  const dailyInitialScrollKey = useRef<string | null>(null);
  const dailyPastDrag = useRef<{
    pointerId: number; x: number; y: number; scrollTop: number; scrollLeft: number;
    grid: HTMLDivElement; returned: boolean;
  } | null>(null);
  const [dailyVisibleRange, setDailyVisibleRange] = useState("");
  const [dailyGridMetrics, setDailyGridMetrics] = useState<{
    left: number; width: number; bodyTop: number; bodyHeight: number; headerHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    const grid = dailyGridRef.current;
    if (!grid) { setDailyGridMetrics(null); return; }

    const measure = () => {
      const bodies = grid.querySelectorAll<HTMLElement>(".timeline-day-body");
      const heading = grid.querySelector<HTMLElement>(".daily-room-head");
      if (!bodies.length || !heading) { setDailyGridMetrics(null); return; }
      const gridRect = grid.getBoundingClientRect();
      const first = bodies[0].getBoundingClientRect();
      const last = bodies[bodies.length - 1].getBoundingClientRect();
      const nextMetrics = {
        left: first.left - gridRect.left + grid.scrollLeft - grid.clientLeft,
        width: last.right - first.left,
        bodyTop: first.top - gridRect.top + grid.scrollTop - grid.clientTop,
        bodyHeight: first.height,
        headerHeight: heading.offsetHeight,
      };
      setDailyGridMetrics((previous) => previous &&
        Object.entries(nextMetrics).every(([key, value]) => Math.abs(previous[key as keyof typeof nextMetrics] - value) < 0.5)
        ? previous : nextMetrics);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    const body = grid.querySelector<HTMLElement>(".timeline-day-body");
    if (body) observer.observe(body);
    return () => observer.disconnect();
  }, [scheduleView, floor, floorRooms.length]);

  const scrollDailyToMinute = useCallback((minute: number, behavior: ScrollBehavior = "auto") => {
    const grid = dailyGridRef.current;
    if (!grid || !dailyGridMetrics) return;
    const { bodyTop, bodyHeight, headerHeight } = dailyGridMetrics;
    const position = bodyTop + ((minute - timelineStart) / (timelineEnd - timelineStart)) * bodyHeight;
    const markerHeight = grid.querySelector<HTMLElement>(".current-time-pointer")?.offsetHeight ?? 0;
    const topInset = Math.max(markerHeight / 2 + 4, Math.max(0, grid.clientHeight - headerHeight) * siteConfig.timeline.initialViewportRatio);
    const target = position - headerHeight - topInset;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : behavior;
    grid.scrollTo({ top: Math.max(0, Math.min(grid.scrollHeight - grid.clientHeight, target)), behavior: motion });
  }, [dailyGridMetrics]);

  // 첫 진입·날짜/층/보기 전환에만 이동한다. 시계 갱신이나 폭 변경은 수동 스크롤을 유지한다.
  useLayoutEffect(() => {
    if (scheduleView !== "day") { dailyInitialScrollKey.current = null; return; }
    if (!dailyGridMetrics || nowMinutes === null) return;
    const key = `${date}:${floor}`;
    if (dailyInitialScrollKey.current === key) return;
    scrollDailyToMinute(date === today ? nowMinutes : siteConfig.timeline.defaultFocusHour * 60);
    dailyInitialScrollKey.current = key;
  }, [date, floor, scheduleView, today, nowMinutes, dailyGridMetrics, scrollDailyToMinute]);

  const jumpToCurrentTime = () => {
    if (date !== today) setDate(today);
    else if (nowMinutes !== null) scrollDailyToMinute(nowMinutes, "smooth");
  };

  const cancelDailyPastDrag = useCallback(() => {
    const drag = dailyPastDrag.current;
    dailyPastDrag.current = null;
    if (drag?.grid.hasPointerCapture(drag.pointerId)) drag.grid.releasePointerCapture(drag.pointerId);
  }, []);

  // 시안처럼 과거의 빈 칸에서 실제로 드래그할 때만 현재로 복귀한다.
  // 클릭·휠·스크롤바·터치 쓸기는 조회 동작이므로 이동시키지 않는다.
  const startDailyPastDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return;
    cancelDailyPastDrag();
    if (event.button !== 0 || event.pointerType === "touch" || date !== today || nowMinutes === null || !dailyGridMetrics) return;
    const target = event.target as HTMLElement;
    if (!target.closest(".timeline-day-body") || target.closest("button, a, input, select, textarea, .timeline-draft")) return;
    const grid = event.currentTarget;
    const y = event.clientY - grid.getBoundingClientRect().top + grid.scrollTop - grid.clientTop;
    const minute = timelineStart + (y - dailyGridMetrics.bodyTop) / dailyGridMetrics.bodyHeight * (timelineEnd - timelineStart);
    if (minute >= nowMinutes) return;
    dailyPastDrag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollTop: grid.scrollTop, scrollLeft: grid.scrollLeft, grid, returned: false };
    // 자동 스크롤 뒤 손을 떼어도 새 위치에 예약 선택이 생기지 않도록 끝까지 받는다.
    grid.setPointerCapture(event.pointerId);
  };

  const moveDailyPastDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dailyPastDrag.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.returned) return;
    if (!(event.buttons & 1) || date !== today || nowMinutes === null ||
      Math.abs(drag.grid.scrollTop - drag.scrollTop) > 1 || Math.abs(drag.grid.scrollLeft - drag.scrollLeft) > 1) {
      cancelDailyPastDrag();
      return;
    }
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
    drag.returned = true;
    event.preventDefault();
    setSelectionFeedback("");
    setKeyboardSelection(null);
    scrollDailyToMinute(nowMinutes, "smooth");
  };

  const finishDailyPastDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dailyPastDrag.current?.pointerId === event.pointerId) cancelDailyPastDrag();
  };

  useEffect(() => cancelDailyPastDrag, [date, floor, scheduleView, cancelDailyPastDrag]);

  useEffect(() => {
    const grid = dailyGridRef.current;
    if (!grid || !dailyGridMetrics) return;
    const updateRange = () => {
      const { bodyTop, bodyHeight, headerHeight } = dailyGridMetrics;
      const minuteAt = (y: number) => timelineStart + (y - bodyTop) / bodyHeight * (timelineEnd - timelineStart);
      const first = Math.max(timelineStart, Math.floor(minuteAt(grid.scrollTop + headerHeight) / 60) * 60);
      const last = Math.min(timelineEnd, Math.ceil(minuteAt(grid.scrollTop + grid.clientHeight) / 60) * 60);
      setDailyVisibleRange(`${formatMinutes(first)}–${formatMinutes(last)}`);
    };
    updateRange();
    grid.addEventListener("scroll", updateRange, { passive: true });
    const observer = new ResizeObserver(updateRange);
    observer.observe(grid);
    return () => { grid.removeEventListener("scroll", updateRange); observer.disconnect(); };
  }, [dailyGridMetrics, scheduleView]);

  useEffect(() => {
    const grid = dailyGridRef.current;
    if (!grid || !dailyGridMetrics || !keyboardSelection) return;
    const { bodyTop, bodyHeight, headerHeight } = dailyGridMetrics;
    const y = (time: string) => bodyTop + (minutesOf(time) - timelineStart) / (timelineEnd - timelineStart) * bodyHeight;
    if (y(keyboardSelection.start) < grid.scrollTop + headerHeight) grid.scrollTop = Math.max(0, y(keyboardSelection.start) - headerHeight);
    else if (y(keyboardSelection.end) > grid.scrollTop + grid.clientHeight) grid.scrollTop = y(keyboardSelection.end) - grid.clientHeight;
  }, [keyboardSelection, dailyGridMetrics]);

  useEffect(() => { setKeyboardSelection(null); setSelectionFeedback(""); }, [date, floor, scheduleView]);

  useEffect(() => {
    if (!timePickerOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const popover = document.querySelector<HTMLElement>(".time-picker-popover");
      const option = popover?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
        ?? popover?.querySelector<HTMLButtonElement>('[role="option"]');
      (option ?? popover)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [timePickerOpen]);

  /** SSO 소유권은 서버 판정만 사용하고, 확인된 익명 모드에서만 이름을 비교한다. */
  const isMyBooking = useCallback((booking: Booking) => authReady && (
    typeof booking.isMine === "boolean" ? booking.isMine
      : currentUser === null && Boolean(myBookingOwner.trim()) && booking.owner === myBookingOwner.trim()
  ), [authReady, currentUser, myBookingOwner]);
  const hasEnded = (booking: Booking) => Boolean(booking.endedAt) || booking.date < today
    || (booking.date === today && nowMinutes !== null && minutesOf(booking.end) <= nowMinutes);
  const myBookings = useMemo(() => bookings
    .filter(isMyBooking)
    .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)), [bookings, isMyBooking]);
  const upcomingMyBookings = myBookings.filter((booking) => !hasEnded(booking));
  const selectedBookingIds = (cancelSelection ?? []).filter((id) => upcomingMyBookings.some((booking) => booking.id === id));
  const pastBookingCutoff = oneCalendarMonthAgo(today);
  const pastMyBookings = myBookings
    .filter((booking) => hasEnded(booking) && booking.date >= pastBookingCutoff)
    .reverse();
  /** 예정 예약을 위, 지난 예약을 아래에 둔 한 벌의 목록 데이터. */
  const myBookingRows = [
    ...upcomingMyBookings.map((booking) => ({ booking, upcoming: true })),
    ...pastMyBookings.map((booking) => ({ booking, upcoming: false })),
  ];

  const selectFloor = (nextFloor: number) => {
    setFloor(nextFloor);
    // 이미 그 층 회의실을 고른 상태라면 그대로 둔다. 안 그러면 같은 층 탭을
    // 다시 누르기만 해도 고른 회의실이 그 층 첫 번째로 조용히 바뀐다.
    if (roomById(selectedId)?.floor !== nextFloor) {
      setSelectedId(rooms.find((room) => room.floor === nextFloor)?.id ?? selectedId);
    }
    setNotice("");
  };

  const selectRoom = (room: Room) => {
    setSelectedId(room.id);
    // 다른 층 회의실을 고르면 일정표도 그 층으로 따라간다.
    setRoomPickerOpen(false);
    setFloor(room.floor);
    setNotice("");
  };

  /** 같은 요청에서 생성된 반복 예약만 함께 선택한다. 과거 데이터는 개별 예약이다. */
  const sameSeriesIds = (booking: Booking) => upcomingMyBookings
    .filter((item) => booking.seriesId ? item.seriesId === booking.seriesId : item.id === booking.id)
    .map((item) => item.id);

  const cancelBookings = async (ids: string[]) => {
    if (ids.length === 0 || mutationBusy || !authReady) return;
    const requestedIds = [...new Set(ids)];
    setCancelBusy(true);
    try {
      const results = await Promise.allSettled(requestedIds.map((id) =>
        deleteBookingRequest(id, currentUser?.name ?? myBookingOwner.trim())));
      const succeeded = requestedIds.filter((_, index) => {
        const result = results[index];
        return result.status === "fulfilled" && result.value.ok;
      });
      const failed = requestedIds.filter((id) => !succeeded.includes(id));
      setCancelSelection(failed.length ? failed : null);
      await refreshBookings();
      if (failed.length) {
        const firstError = results.find((result) => result.status === "fulfilled" && !result.value.ok);
        const detail = firstError?.status === "fulfilled" && !firstError.value.ok
          ? firstError.value.message : "연결이 끊겨 일부 삭제 결과를 확인하지 못했습니다. 예약 목록을 확인해 주세요.";
        setSyncError(`처리 확인 ${succeeded.length}건, 실패 또는 결과 미확인 ${failed.length}건. ${detail}`);
      } else {
        const ended = results.flatMap((result) => result.status === "fulfilled" && result.value.ok && result.value.booking?.endedAt ? [result.value.booking] : []);
        const deletedCount = succeeded.length - ended.length;
        setToast({
          text: ended.length ? `삭제 ${deletedCount}건 · 사용 기록 보존 ${ended.length}건` : `예약 ${deletedCount}건을 삭제했습니다.`,
          detail: ended.length ? "종료한 예약은 지난 내역에서 확인할 수 있습니다." : "내 예약",
          time: ended.length === 1 ? `${ended[0].end}부터 예약 가능` : "",
        });
      }
    } catch {
      setSyncError("삭제 결과를 확인하지 못했습니다. 예약 목록을 확인한 뒤 다시 시도해 주세요.");
    } finally {
      setCancelBusy(false);
    }
  };

  const openEditor = (booking: Booking) => {
    if (!isMyBooking(booking)) return;
    // 지난 예약은 기록으로 남아야 한다. "내 예약" 목록에서는 지난 항목에
    // 버튼을 두지 않는 것과 같은 규칙을, 일정표에서 블록을 눌렀을 때도
    // 적용한다. 서버도 같은 검사를 하지만(past 응답) 열어놓고 저장 시점에
    // 막는 것보다, 열리지 않는 쪽이 헷갈리지 않는다.
    if (hasEnded(booking) || mutationBusy) return;
    // 예약 수정창과 새 예약용 빠른예약 패널이 동시에 열리면 서로 다른
    // 날짜·시간이 한 화면에 겹쳐 보여 오류처럼 보인다. 수정할 때는 패널만
    // 접고 입력값은 유지해, 닫은 뒤 다시 펼치면 작성 내용을 이어갈 수 있게 한다.
    setBookingPanelOpen(false);
    setRoomPickerOpen(false);
    setEditDraft(editDraftOf(booking));
    setEditConflict(false);
    setEditNotice("");
    setEditConfirmDelete(false);
  };

  const saveEdit = async () => {
    if (!editDraft || mutationBusy || !authReady) return;
    if (editDraft.end <= editDraft.start) {
      setEditNotice("종료 시간은 시작 시간보다 늦어야 합니다.");
      return;
    }
    setEditBusy(true);
    setEditNotice("");
    try {
      const result = await patchBookingRequest(editDraft.id, {
        expectedRevision: editDraft.revision,
        roomId: editDraft.roomId,
        date: editDraft.date,
        start: editDraft.start,
        end: editDraft.end,
        owner: currentUser?.name ?? myBookingOwner.trim(),
        team: editDraft.team,
        purpose: editDraft.purpose,
      });
      if (!result.ok) {
        if (result.code === "booking-changed") {
          setEditConflict(true);
          return;
        }
        setEditNotice(result.message);
        return;
      }
      await refreshBookings();
      setEditDraft(null);
      setToast({
        text: "예약을 수정했습니다.",
        detail: roomIdentity(roomById(editDraft.roomId)),
        time: `${formatDateLabel(editDraft.date)} ${editDraft.start}–${editDraft.end}`,
      });
    } catch {
      setEditNotice("수정 결과를 확인하지 못했습니다. 예약 목록을 확인한 뒤 다시 시도해 주세요.");
      await refreshBookings();
    } finally {
      setEditBusy(false);
    }
  };

  /** 삭제 시 해제 예상 시각. 확정 시각은 서버 응답으로 안내한다. */
  const deletionReleaseTime = (booking: Booking, at = new Date()): string => {
    const elapsed = officeMinutesOfDay(at) + at.getUTCSeconds() / 60 + at.getUTCMilliseconds() / 60000;
    const first = minutesOf(bookingDefaults.openingTime);
    const rounded = first + Math.ceil((elapsed - first) / bookingDefaults.slotMinutes) * bookingDefaults.slotMinutes;
    return formatMinutes(Math.min(rounded, minutesOf(booking.end)));
  };

  /** 종료 처리한 기록은 해제 경계 전에도 다시 수정/삭제할 수 없다. */
  const isRunningNow = (booking: Booking): boolean =>
    !booking.endedAt && isMyBooking(booking) && booking.date === today && nowMinutes !== null
    && minutesOf(booking.start) <= nowMinutes && nowMinutes < minutesOf(booking.end);

  const editingBooking = editDraft ? bookings.find((booking) => booking.id === editDraft.id) ?? null : null;

  const deleteEditing = async () => {
    if (!editDraft || mutationBusy || !authReady) return;
    setEditBusy(true);
    setEditNotice("");
    try {
      const result = await deleteBookingRequest(editDraft.id, currentUser?.name ?? myBookingOwner.trim());
      if (!result.ok) {
        setEditNotice(result.message);
        return;
      }
      await refreshBookings();
      setEditDraft(null);
      setToast({
        text: result.booking?.endedAt ? "남은 시간을 해제하고 사용 기록을 남겼습니다." : "예약을 삭제했습니다.",
        detail: roomIdentity(roomById(editDraft.roomId)),
        time: result.booking?.endedAt ? `${result.booking.end}부터 예약 가능` : formatDateLabel(editDraft.date),
      });
    } catch {
      setEditNotice("삭제 결과를 확인하지 못했습니다. 예약 목록을 확인한 뒤 다시 시도해 주세요.");
      await refreshBookings();
    } finally {
      setEditBusy(false);
    }
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

  const cancelPendingTouchDrag = () => {
    if (!pendingTouchDrag.current) return;
    window.clearTimeout(pendingTouchDrag.current.timer);
    pendingTouchDrag.current = null;
  };

  useEffect(() => () => cancelPendingTouchDrag(), []);

  const startSlotDrag = (room: Room, reservationDate: DateKey, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 과거에서 시작한 제스처는 현재로 돌아온 뒤에도 예약 입력으로 처리하지 않는다.
    if (dailyPastDrag.current?.pointerId === event.pointerId) return;
    const startMinutes = getSlotMinutes(event);
    const availability = describeRoomSlotAvailability(
      bookings.filter((booking) => booking.roomId === room.id), reservationDate,
      formatMinutes(startMinutes), formatMinutes(startMinutes + bookingDefaults.slotMinutes), { today, nowMinutes },
    );
    if (!availability.available) {
      // 과거 시간은 예약할 수 없지만, 시간표 위의 반복 안내는 표시하지 않는다.
      setSelectionFeedback(availability.status === "past" ? "" : availability.nextLabel);
      return;
    }
    setSelectionFeedback("");
    setKeyboardSelection(null);

    if (event.pointerType === "touch") {
      cancelPendingTouchDrag();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const anchorY = event.clientY;
      const timer = window.setTimeout(() => {
        const pending = pendingTouchDrag.current;
        if (!pending || pending.pointerId !== pointerId) return;
        pendingTouchDrag.current = null;
        target.setPointerCapture(pointerId);
        setSlotDrag({
          roomId: room.id,
          date: reservationDate,
          start: formatMinutes(startMinutes),
          end: formatMinutes(startMinutes + bookingDefaults.slotMinutes),
          anchorY,
          anchorMinutes: startMinutes,
          pointerType: "touch",
        });
      }, TOUCH_DRAG_HOLD_MS);
      pendingTouchDrag.current = { pointerId, roomId: room.id, date: reservationDate, anchorY, timer };
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setSlotDrag({
      roomId: room.id,
      date: reservationDate,
      start: formatMinutes(startMinutes),
      end: formatMinutes(startMinutes + bookingDefaults.slotMinutes),
      anchorY: event.clientY,
      anchorMinutes: startMinutes,
      pointerType: "mouse",
    });
  };

  const updateSlotDrag = (room: Room, reservationDate: DateKey, event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = pendingTouchDrag.current;
    if (pending?.pointerId === event.pointerId) {
      if (Math.abs(event.clientY - pending.anchorY) >= TOUCH_DRAG_CANCEL_DISTANCE) cancelPendingTouchDrag();
      return;
    }
    if (!slotDrag || slotDrag.roomId !== room.id || slotDrag.date !== reservationDate) return;
    if (slotDrag.pointerType === "touch") event.preventDefault();
    // 처음 누른 지점(anchorMinutes)은 고정값이라, 방향을 바꿔 끌어도 그 지점이 사라지지 않는다.
    // (여기서 매번 slotDrag.start를 다시 읽으면, start 자체가 이전 갱신으로 바뀐 값이라 어긋난다)
    const pointerMinutes = getSlotMinutes(event);
    const nextStart = Math.min(slotDrag.anchorMinutes, pointerMinutes);
    const nextEnd = Math.max(slotDrag.anchorMinutes, pointerMinutes) + bookingDefaults.slotMinutes;
    setSlotDrag({ ...slotDrag, start: formatMinutes(nextStart), end: formatMinutes(nextEnd) });
  };

  const finishSlotDrag = (room: Room, reservationDate: DateKey, event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = pendingTouchDrag.current;
    if (pending?.pointerId === event.pointerId) {
      cancelPendingTouchDrag();
      return;
    }
    if (!slotDrag || slotDrag.roomId !== room.id || slotDrag.date !== reservationDate) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const moved = Math.abs(event.clientY - slotDrag.anchorY) >= 8;
    const selection = { roomId: room.id, date: reservationDate, start: slotDrag.start, end: slotDrag.end };
    if (moved) applySlotSelection(selection);
    setSlotDrag(null);
  };

  const cancelSlotDrag = () => {
    cancelPendingTouchDrag();
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
      list.includes(name) || list.length + attendeeAccounts.length >= bookingDefaults.maxAttendees ? list : [...list, name]
    ));
  };

  /**
   * 주간 화면에서 빈칸을 더블클릭했을 때. 회의실·날짜만 정하고 시간은 비워 둔다.
   * 예전에는 비어 있는 가장 이른 시간을 대신 골라 줬는데, 그게 원하는 시간이
   * 아닌 경우가 많아 결국 다시 고쳐야 했다. 시간은 빠른 예약 창에서
   * 사람이 직접 고른다 — 겹치는 시간이면 그 자리에서 바로 알려 준다.
   */
  const askWeekdaySlot = (room: Room, day: DateKey) => {
    if (day < today || (day === today && nowMinutes !== null && nowMinutes >= minutesOf(bookingDefaults.closingTime))) {
      setSelectionFeedback(day < today ? "지난 날짜는 현황만 확인할 수 있습니다. 예약할 날짜를 선택해 주세요." : "오늘 운영 시간이 마감되었습니다. 다음 날짜를 선택해 주세요.");
      return;
    }
    setSelectionFeedback("");
    setSelectedId(room.id);
    setDate(day);
    setDraftActive(true);
    setBookingPanelOpen(true);
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
      // 누르는 동안에는 안내 알약을 감춰 드래그 선택선과 겹치지 않게 한다.
      if (pressing) return hide();
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
      // 입력 전에 날짜와 시간을 확인한다. 선택 항목으로 포커스를 강제로 보내지 않는다.
      document.getElementById("start-time-select")?.focus({ preventScroll: true });
    });
  };

  /** 필수 칸 순서. 넘김·검사·안내 문구가 모두 이 한 벌을 따른다. */
  const REQUIRED_FIELDS = [
    { key: "owner", id: "owner-input", value: owner, message: "예약자 이름을 적어 주세요" },
    { key: "team", id: "team-input", value: team, message: "본부명을 골라 주세요" },
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
  const focusNextRequired = (afterKey: string | null, reveal = false) => {
    // null이면 필수 칸 처음부터 본다. 회의 목적처럼 필수 목록에 없는 칸에서
    // 넘어올 때 쓴다 — 아직 빈 필수 칸이 있으면 거기로, 없으면 예약 버튼으로.
    const from = afterKey === null ? -1 : REQUIRED_FIELDS.findIndex((field) => field.key === afterKey);
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

  const applySlotSelection = (selection: SlotSelection) => {
    const availability = describeRoomSlotAvailability(
      bookings.filter((booking) => booking.roomId === selection.roomId), selection.date, selection.start, selection.end, { today, nowMinutes },
    );
    if (!availability.available) {
      setSelectionFeedback(availability.status === "past" ? "" : availability.nextLabel);
      return;
    }
    setSelectionFeedback("");
    setKeyboardSelection(null);
    const minutes = minutesOf(selection.end) - minutesOf(selection.start);
    setSelectedId(selection.roomId);
    setAllDay(false);
    setDuration(bookingDefaults.durationPresetsMinutes.includes(minutes) ? minutes : 0);
    setSlot({ date: selection.date, start: selection.start, end: selection.end });
    setNotice("");
    setDraftActive(true);
    setBookingPanelOpen(true);
    setTimeNeedsPick(false);
    flashFilled(
      roomIdentity(roomById(selection.roomId)),
      `${formatDateLabel(selection.date)} · ${selection.start}–${selection.end}`,
    );
  };

  const applyAlternative = (alternative: BookingAlternative) => {
    applySlotSelection(alternative);
    const room = roomById(alternative.roomId);
    if (room) setFloor(room.floor);
  };

  const handleTimelineKey = (room: Room, reservationDate: DateKey, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setKeyboardSelection(null);
      setSelectionFeedback("");
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Enter") return;
    event.preventDefault();
    const preview = keyboardSelection?.roomId === room.id && keyboardSelection.date === reservationDate ? keyboardSelection : null;
    const length = Math.min(minutesOf(bookingDefaults.closingTime) - minutesOf(bookingDefaults.openingTime), Math.max(bookingDefaults.slotMinutes, minutesOf(end) - minutesOf(start)));
    let nextStartMinutes = minutesOf(preview?.start ?? start);
    if (event.key === "ArrowUp") nextStartMinutes -= bookingDefaults.slotMinutes;
    if (event.key === "ArrowDown") nextStartMinutes += bookingDefaults.slotMinutes;
    nextStartMinutes = Math.max(minutesOf(bookingDefaults.openingTime), Math.min(nextStartMinutes, minutesOf(bookingDefaults.closingTime) - length));
    const next = { roomId: room.id, date: reservationDate, start: formatMinutes(nextStartMinutes), end: formatMinutes(nextStartMinutes + length) };
    if (event.key === "Enter") { applySlotSelection(next); return; }
    setKeyboardSelection(next);
    const availability = describeRoomSlotAvailability(bookings.filter((booking) => booking.roomId === room.id), reservationDate, next.start, next.end, { today, nowMinutes });
    setSelectionFeedback(`${roomIdentity(room)} · ${next.start}–${next.end} · 총 ${spokenDuration(length)}. ${availability.available ? "Enter로 선택하세요." : availability.nextLabel}`);
  };

  const closeTimePicker = () => {
    const picker = timePickerOpen;
    setTimePickerOpen(null);
    window.requestAnimationFrame(() => document.getElementById(picker === "end" ? "end-time-select" : "start-time-select")?.focus({ preventScroll: true }));
  };
  const handleTimePickerKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault(); event.stopPropagation(); closeTimePicker(); return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[index]?.focus({ preventScroll: true });
    options[index]?.scrollIntoView({ block: "nearest" });
  };

  const changeStart = (nextStart: string) => {
    setAllDay(false);
    setSlot((current) => {
      // 지금 보이는 실제 길이를 그대로 옮긴다. duration(프리셋 강조용)은 30분·90분처럼
      // 프리셋에 없는 길이일 때 0이 되어 있어, 그걸 쓰면 기본값(1시간)으로 되돌아간다.
      const currentDuration = minutesOf(current.end) - minutesOf(current.start);
      const length = currentDuration > 0 ? currentDuration : bookingDefaults.defaultDurationMinutes;
      return { ...current, start: nextStart, end: addMinutes(nextStart, length) };
    });
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
    if (mutationBusy || !authReady) return;
    if (bookingRecovery) { void checkBookingResult(); return; }
    if (timeNeedsPick) {
      setNotice("시작 또는 종료 시간을 직접 선택해 주세요.");
      document.getElementById("start-time-select")?.focus({ preventScroll: true });
      return;
    }
    if (bookingBlockReason) { setNotice(bookingBlockReason); return; }
    if (reservationDates.length === 0) {
      setNotice("예약할 날짜가 없습니다. 반복 기간과 주말·공휴일 포함 여부를 확인해 주세요.");
      return;
    }
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
    if (reservationDates.some((day) => day === today && nowMinutes !== null && minutesOf(start) < nowMinutes)) {
      setNotice("이미 지난 시간에는 예약할 수 없습니다.");
      return;
    }
    if (reservationDates.some((day) => day < today)) {
      setNotice("지난 날짜에는 예약할 수 없습니다.");
      return;
    }
    if (reservationDates.length > bookingDefaults.maxRepeatCount) {
      setNotice(`반복 예약은 한 번에 ${bookingDefaults.maxRepeatCount}건까지 가능합니다. 종료일을 앞당겨 주세요.`);
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
    setSubmitPreviewDates(reservationDates);
  };

  /** 실제로 서버에 보내는 부분. '겹치는 날만 빼고' 보낼 때도 같은 길을 쓴다. */
  const sendBooking = async (dates: string[]) => {
    if (mutationBusy || !authReady || dates.length === 0 || timeNeedsPick || bookingRecovery) return;
    // 확인 중 시간 경과·새 예약도 재검증한다. 최종 동시 예약 판정은 서버가 수행한다.
    const invalidSlot = dates.map((day) => describeRoomSlotAvailability(bookings.filter((booking) => booking.roomId === selected.id), day, start, end, { today, nowMinutes })).find((item) => !item.available);
    if (invalidSlot || syncError) { setSubmitPreviewDates(null); setNotice(syncError || invalidSlot?.nextLabel || "예약 상태를 확인해 다시 선택해 주세요."); return; }
    const submittedDraftKey = draftKey;
    const ownerName = currentUser?.name ?? owner.trim();
    const teamName = team.trim();
    setRepeatAsk(null);
    setSubmitPreviewDates(null);
    setSubmitting(true);
    try {
      const result = await postBookings({
        roomId: selected.id,
        dates,
        start,
        end,
        owner: ownerName,
        team: teamName,
        purpose: purpose.trim(),
        attendees,
        attendeeIds: attendeeAccounts.map(employee => employee.id),
      });

      if (!result.ok) {
        // 동시에 다른 사람이 먼저 잡았을 수 있다. 서버 판정을 보여주고 최신 상태로 맞춘다.
        setNotice(result.message);
        void refreshBookings();
        return;
      }

      const draftUnchanged = latestDraftKey.current === submittedDraftKey;
      if (draftUnchanged) {
        setDraftActive(false);
        setTimeNeedsPick(false);
        setPurpose("");
        setAttendees([]);
        setAttendeeAccounts([]);
        setAttendeeDraft("");
      }
      setMyBookingOwner(ownerName);
      setNotice("예약이 완료되었습니다.");
      setToast({
        text: "예약이 완료되었습니다",
        detail: dates.length > 1
          ? `${roomIdentity(selected)} · 반복 ${dates.length}회`
          : `${roomIdentity(selected)} · ${formatDateLabel(dates[0])}`,
        time: `${start}–${end}`,
        kind: "booking",
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
        if (dates.some((day) => day < today || (day === today && nowMinutes !== null && minutesOf(candidate) < nowMinutes))) return false;
        return findConflictingDates(pool, selected.id, dates, candidate, candidateEnd).length === 0;
      });
      // 방금 예약한 시간 뒤쪽을 먼저 보고, 없으면 그날 가장 이른 빈 시간으로 간다.
      const nextStart = freeStarts.find((candidate) => minutesOf(candidate) >= minutesOf(end)) ?? freeStarts[0];
      if (draftUnchanged && !allDay && nextStart) {
        setSlot((current) => ({ ...current, start: nextStart, end: addMinutes(nextStart, durationMinutes) }));
      }
      void refreshBookings();
    } catch (error) {
      setBookingRecovery({ owner: ownerName, roomId: selected.id, dates: [...dates], start, end, timedOut: error instanceof Error && error.name === "TimeoutError" });
      setNotice("예약 결과를 확인하지 못했습니다. 이미 저장됐을 수 있으니 예약 결과 확인을 눌러 주세요. 입력 내용은 유지했습니다.");
      // 목록 갱신이 늦어져도 저장 버튼의 대기 시간을 더 늘리지 않는다.
      void refreshBookings();
    } finally {
      setSubmitting(false);
    }
  };

  /** 조회만 수행한다. 응답 유실을 실패로 단정하거나 예약을 자동 재전송하지 않는다. */
  const checkBookingResult = async () => {
    if (!bookingRecovery || checkingBookingResult || !authReady) return;
    const snapshot = bookingRecovery;
    const dates = [...snapshot.dates].sort();
    const range = { from: dates[0], to: dates[dates.length - 1] };
    const seq = ++refreshSeq.current;
    setCheckingBookingResult(true);
    setNotice("");
    try {
      const data = await fetchBookings(range);
      if (seq !== refreshSeq.current) {
        setNotice("최신 예약 내역을 동기화하고 있어요. 잠시 후 예약 결과를 다시 확인해 주세요.");
        return;
      }
      setBookings((current) => [...current.filter((booking) => booking.date < range.from || booking.date > range.to), ...data]);
      setSyncError("");
      const matched = data.filter((booking) => booking.roomId === snapshot.roomId && snapshot.dates.includes(booking.date)
        && booking.start === snapshot.start && booking.end === snapshot.end
        && (currentUser ? booking.isMine === true : booking.owner === snapshot.owner));
      setMyBookingOwner(snapshot.owner);
      setMyBookingsOpen(true);
      setBookingRecovery(null);
      setNotice(matched.length
        ? `선택한 시간의 내 예약 ${matched.length}건을 찾았습니다. 내 예약에서 내용을 확인해 주세요.`
        : "조회 시점에는 선택한 시간의 내 예약이 없습니다. 늦게 반영될 수 있으니 다시 예약하기 전 내 예약을 확인해 주세요.");
    } catch {
      setNotice("아직 예약 내역을 불러오지 못했습니다. 입력 내용은 보관 중이며, 예약은 다시 전송하지 않았습니다.");
    } finally {
      setCheckingBookingResult(false);
    }
  };

  return (
    <main className={`app-shell ${showMap ? "map-open" : ""} ${bookingPanelOpen ? "" : "booking-panel-collapsed"} ${monitorMode ? "monitor-mode" : ""}`}>
      {(authError || syncError) && <div className="sync-error-banner" role="alert">{authError || syncError}</div>}
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
            <h1>MEETING ROOMS</h1>
          </div>
        </div>
        {/* 메뉴는 글자만 두고, 사람은 오른쪽 끝에 이니셜 원 하나로 묶는다.
            원형 아이콘·구분선·빨강 버튼을 걷어 내면 빨강은 '예약하기' 하나에만
            남아, 상단바에서 같은 무게로 경쟁하지 않는다. */}
        <div className="header-account">
          {/* 시계와 날짜는 뺐다. 보고 있는 날짜가 왼쪽에 크게 있고,
              현재 시각은 일정표의 빨간 선이 알려 준다. */}
          <nav className="header-nav" aria-label="사용자 메뉴">
            {currentUser?.isAdmin === true && <a className="header-nav-item" href="/admin">관리자</a>}
            <a className="header-nav-item" href="/회의실예약_매뉴얼.pdf" target="_blank" rel="noopener noreferrer">이용가이드</a>
            <span className="header-bookings-wrap">
              <button
                type="button"
                className={`header-nav-item header-bookings-bell${bellArrival ? " booking-arrival" : ""}`}
                aria-label={`내 예약 열기${upcomingMyBookings.length > 0 ? `, 예정 예약 ${upcomingMyBookings.length}건` : ""}`}
                aria-haspopup="dialog"
                title="내 예약"
                onClick={() => { setCancelSelection(null); setMyBookingsOpen(true); }}
              >
                <BellIcon />
                <span>내 예약</span>
                {upcomingMyBookings.length > 0 && <span className="header-bookings-dot" aria-hidden="true" />}
              </button>
            </span>
          </nav>
          {/* 이니셜은 이름에서 뽑는다. 원은 장식이라 낭독기에서는 건너뛰고
              이름만 읽히게 한다. */}
          {headerName && <span className="header-me">
            <i className="header-me-face" aria-hidden="true">{headerName.slice(0, 2)}</i>
            <span className="header-user">{headerName}님
              {currentUser && <a className="header-logout" href="/auth/logout">로그아웃</a>}
            </span>
          </span>}
        </div>
      </header>

      <section className="toolbar" aria-label="예약 조건 선택">
        <div className="floor-switch" aria-label="층 선택">
          {floors.map((item) => (
            <button key={item} type="button" className={floor === item ? "active" : ""} onClick={() => selectFloor(item)}>
              {item}층
              <small>{rooms.filter((room) => room.floor === item && slotIsBookable(room.id, start, end)).length}개 선택 시간 가능</small>
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

      <section className="workspace">
        <aside className="room-list-panel">
          <div className="section-heading">
            <div><p>ROOMS</p><h2>{floor}층 회의실</h2></div>
            <span>{floorRooms.length}개</span>
          </div>
          <p className="section-help">이름 또는 오른쪽 배치도에서 회의실을 선택하세요.</p>
          <div className="room-list">
            {floorRooms.map((room) => {
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
                  {/* 머리표는 영문 대문자로 짧게 얹는다. 일간은 요일(WEDNESDAY),
                      주간은 몇 번째 주(WEEK 3). 두 화면이 같은 자리에 같은 모양의
                      두 줄을 쓰므로 보기를 바꿔도 같은 덩어리로 읽힌다. */}
                  <p className={`hero-kicker${selectedDateWeekday === 6 ? " is-sat" : ""}${selectedDateHoliday ? " has-holiday" : ""}`}>
                    <span>{weekView ? weekNumberLabel(weekDays[0]) : formatWeekdayEnglish(date)}</span>
                    {selectedDateHoliday && <><i aria-hidden="true" /><em>{selectedDateHoliday.name}</em></>}
                  </p>
                  {/* 숫자만 남겨 크게 쓴다. 머리표에 요일·주차가 이미 있으니
                      '월·일' 글자가 없어도 무슨 날인지 읽힌다 — 글자를 덜어낸
                      만큼 숫자를 키울 수 있어 이 영역의 제목이 날짜가 된다.
                      주간의 범위는 표에 실제로 그려지는 날(월~금)의 처음과 끝을
                      그대로 쓴다. 고정된 문구로 적으면 표와 어긋날 수 있다.
                      숫자만으로는 읽어 주는 기기에서 '8 나누기 19'로 들릴 수 있어
                      한글 날짜를 눈에 안 보이게 함께 둔다. */}
                  <h3 className={`hero-date-big${weekView ? " hero-date-range" : ""}`}>{weekView
                    ? <><span aria-hidden="true">{weekRangeLabel(weekDays[0], weekDays[weekDays.length - 1])}</span><span className="sr-only">{formatDateLabel(weekDays[0])} ~ {formatDateLabel(weekDays[weekDays.length - 1])}</span></>
                    : <><span aria-hidden="true">{slashDate(date)}</span><span className="sr-only">{formatDateLabel(date)}</span></>}
                  </h3>
                </div>
                {/* 시안대로 화살표 둘을 붙이고 '오늘'을 그 옆에 둔다.
                    주간에서는 그 주 월요일을 기준으로 옮긴다. 날짜에서 ±7일만 하면
                    주말에 걸린 날짜가 계속 주말로 남아 일간으로 바꿨을 때 어긋난다. */}
                {/* 날짜를 다루는 것들은 한 덩어리로 묶는다. 흩어져 있으면 덩어리 수만 늘어난다. */}
                <div className="schedule-date-switch">
                  <button type="button" className="nav-step" aria-label={weekView ? "이전 주" : "이전 날짜"} onClick={() => setDate(weekView ? moveDate(weekDays[0], -7) : moveDate(date, -1))}><ChevronIcon direction="prev" /></button>
                  <button type="button" className="nav-today" onClick={() => scheduleView === "day" ? jumpToCurrentTime() : setDate(today)}>
                    {weekView ? "이번 주" : "오늘"}
                  </button>
                  <button type="button" className="nav-step" aria-label={weekView ? "다음 주" : "다음 날짜"} onClick={() => setDate(weekView ? moveDate(weekDays[0], 7) : moveDate(date, 1))}><ChevronIcon direction="next" /></button>
                  <DateField variant="icon" allowAnyDate value={date} onChange={setDate} />
                </div>

                {/* 층 선택. 밑줄 탭이라 옆의 일간/주간 스위치와 모양이 겹치지 않는다. */}
                <div className="schedule-floor-switch" aria-label="층 선택">
                  {floors.map((item) => (
                    <button key={item} type="button" className={floor === item ? "active" : ""} aria-label={`${item}층`} aria-pressed={floor === item} onClick={() => selectFloor(item)}>
                      {item}F
                    </button>
                  ))}
                </div>

                <div className="schedule-heading-actions">
                  <div className="schedule-view-switch" aria-label="예약 현황 보기 방식">
                    <button type="button" className={scheduleView === "day" ? "active" : ""} onClick={() => setScheduleView("day")}>일간</button>
                    <button type="button" className={scheduleView === "week" ? "active" : ""} onClick={() => setScheduleView("week")}>주간</button>
                  </div>
                </div>

                {/* 드래그 안내는 빈 칸에 마우스를 올리면 그 자리에 뜨는 알약이
                    대신한다. 머리줄에 한 줄로 적어 두면 어디를 드래그하라는
                    말인지 알기 어려웠다. */}
              </div>

              {selectionFeedback && <p className="schedule-selection-feedback" role="status">{selectionFeedback}</p>}
              {scheduleView === "day" && floorRooms.length > 0 && <>
              <div className="week-timeline daily-timeline timeline-full-day" data-floor={floor} ref={dailyGridRef} role="region" aria-label="24시간 일간 시간표, 위아래로 스크롤. 오늘의 과거 빈 시간 칸을 마우스로 드래그하면 현재 시간으로 이동" tabIndex={0}
                onPointerDownCapture={startDailyPastDrag}
                onPointerMoveCapture={moveDailyPastDrag}
                onPointerUpCapture={finishDailyPastDrag}
                onPointerCancelCapture={finishDailyPastDrag}
                onLostPointerCapture={finishDailyPastDrag}
                onWheelCapture={cancelDailyPastDrag}
                onScroll={() => { if (!dailyPastDrag.current?.returned) cancelDailyPastDrag(); }}
                style={{ "--room-count": floorRooms.length, "--timeline-hour-height": `${siteConfig.timeline.hourHeightPx}px`, "--timeline-slot-height": `${siteConfig.timeline.hourHeightPx * bookingDefaults.slotMinutes / 60}px`, "--timeline-body-height": `${(timelineEnd - timelineStart) / 60 * siteConfig.timeline.hourHeightPx}px` } as CSSProperties}>
                <div className="time-axis">
                  <span className="axis-corner">TIME</span>
                  <div className="time-axis-body">
                    {timelineHours.map((hour) => {
                      // 포인터 라벨과 겹치는 정각 글자만 숨겨 두 시간이 섞여 보이지 않게 한다.
                      const coveredByCurrentTime = showCurrentTime && nowMinutes !== null &&
                        Math.abs(hour * 60 - nowMinutes) * siteConfig.timeline.hourHeightPx / 60 < 26;
                      return <time key={hour} aria-hidden={coveredByCurrentTime || undefined} style={{ top: `${((hour * 60 - timelineStart) / (timelineEnd - timelineStart)) * 100}%`, visibility: coveredByCurrentTime ? "hidden" : undefined }}>{String(hour).padStart(2, "0")}:00</time>;
                    })}
                  </div>
                  {showCurrentTime && currentTimePercent !== null && nowMinutes !== null && dailyGridMetrics && (
                    <span className="current-time-axis-marker" style={{
                      "--current-time-gutter": `${dailyGridMetrics.left}px`,
                      width: dailyGridMetrics.left,
                      top: dailyGridMetrics.bodyTop + (currentTimePercent / 100) * dailyGridMetrics.bodyHeight,
                    } as CSSProperties}>
                      <time className="current-time-pointer" dateTime={formatMinutes(nowMinutes)} aria-label={`현재 시간 ${formatMinutes(nowMinutes)}`}>
                        {formatMinutes(nowMinutes)}
                      </time>
                    </span>
                  )}
                </div>
                {/* 포인터 라벨은 왼쪽 시간 축에, 가는 안내선만 예약 영역에 둔다. */}
                {showCurrentTime && currentTimePercent !== null && nowMinutes !== null && dailyGridMetrics && (
                  <span
                    className="current-time-line current-time-line-all"
                    aria-hidden="true"
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
                      <div className="timeline-day-head daily-room-head">
                        <button
                          type="button"
                          className="daily-room-select"
                          aria-pressed={selected.id === room.id}
                          title={roomIdentity(room)}
                          onClick={() => setSelectedId(room.id)}
                        >
                          <span className="daily-room-title">
                            <strong>{room.name}</strong>
                            <i aria-hidden="true" />
                            <small>{room.floor}F</small>
                          </span>
                          <span className="daily-room-selected-icon"><SelectedRoomIcon /></span>
                          {/* 지금 쓸 수 있는지가 이 표에서 가장 먼저 봐야 할 정보다.
                              주간현황과도 같은 형식으로 맞춘다. */}
                          <span className={`daily-room-meta ${status.status}`}><i className={`room-status-dot ${status.status}`} /><b>{status.statusLabel}</b><em>·</em>{formatCapacity(room.capacity)}</span>
                        </button>
                        <RoomEquipment key={`${date}:${room.id}`} room={room} />
                      </div>
                      <div
                        className={`timeline-day-body${slotDrag?.pointerType === "touch" && slotDrag.roomId === room.id && slotDrag.date === date ? " touch-dragging" : ""}`}
                        role="group"
                        tabIndex={0}
                        aria-label={`${roomIdentity(room)} ${formatDateLabel(date)} 시간 선택. 위아래 방향키로 ${bookingDefaults.slotMinutes}분 이동, Enter로 선택, Escape로 미리보기 취소`}
                        onPointerDown={(event) => startSlotDrag(room, date, event)}
                        onPointerMove={(event) => updateSlotDrag(room, date, event)}
                        onPointerUp={(event) => finishSlotDrag(room, date, event)}
                        onPointerCancel={cancelSlotDrag}
                        onKeyDown={(event) => handleTimelineKey(room, date, event)}
                        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboardSelection(null); }}
                      >
                        {(() => {
                          const selection = slotDrag?.roomId === room.id && slotDrag.date === date ? slotDrag
                            : keyboardSelection?.roomId === room.id && keyboardSelection.date === date ? keyboardSelection : null;
                          if (!selection) return null;
                          const top = ((minutesOf(selection.start) - timelineStart) / (timelineEnd - timelineStart)) * 100;
                          const height = ((minutesOf(selection.end) - minutesOf(selection.start)) / (timelineEnd - timelineStart)) * 100;
                          return (
                            <span className="timeline-drag-selection" style={{ top: `${top}%`, height: `${height}%` }} aria-hidden="true">
                              <b className="timeline-drag-label">
                                <span>{selection.start}–{selection.end}</span>
                                <strong>총 {spokenDuration(minutesOf(selection.end) - minutesOf(selection.start))}</strong>
                              </b>
                            </span>
                          );
                        })()}
                        {/* 표에서 값을 가져왔지만 아직 예약하기를 누르지 않은 상태.
                            '표에 뭔가 생겼으니 됐겠지'라고 믿는 그 자리에 점선으로 남겨 둔다. */}
                        {draftActive && room.id === selected.id && date === slot.date && (() => {
                          const top = ((minutesOf(start) - timelineStart) / (timelineEnd - timelineStart)) * 100;
                          const height = ((minutesOf(end) - minutesOf(start)) / (timelineEnd - timelineStart)) * 100;
                          return (
                            <span className="timeline-draft" style={{ top: `${top}%`, height: `${height}%` }}>
                              <b>작성 중 <strong className="timeline-draft-duration">총 {spokenDuration(minutesOf(end) - minutesOf(start))}</strong></b>
                              <em>{start}–{end} · 오른쪽에서 이어서</em>
                            </span>
                          );
                        })()}
                        {dailyBookings.map((booking, index) => {
                          const bookingStart = Math.max(timelineStart, minutesOf(booking.start));
                          const bookingEnd = Math.min(timelineEnd, minutesOf(booking.end));
                          const top = ((bookingStart - timelineStart) / (timelineEnd - timelineStart)) * 100;
                          const height = ((bookingEnd - bookingStart) / (timelineEnd - timelineStart)) * 100;
                          // 실제 시간 길이를 유지해 연속된 예약끼리 시각적으로 겹치지 않게 한다.
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
                              aria-label={isMyBooking(booking) ? `내 예약 ${booking.start}–${booking.end} · 눌러서 수정하거나 삭제합니다`
                                : `${booking.start}–${booking.end} / ${booking.owner} · ${teamOf(booking)}`}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => { event.stopPropagation(); setSelectedId(room.id); openEditor(booking); }}
                            >
                              <strong>{booking.owner}</strong>
                              <time>{booking.start}–{booking.end}</time>
                              <small>{teamOf(booking)}</small>
                              {isMyBooking(booking) && <ReservationHoverCard />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="daily-timeline-footer"><span>{dailyVisibleRange} 보는 중</span><span>시간표 안에서 위아래로 스크롤 ↕</span></div>
              </>}
              {scheduleView === "week" && floorRooms.length > 0 && <div className="weekly-room-board" aria-label={`${floor}층 회의실별 주간 예약 현황, 예약은 시간 순서로 표시`} style={{ "--room-count": floorRooms.length } as CSSProperties}>
                <div className="weekly-room-head weekly-room-corner">회의실</div>
                {weekDays.map((day) => (
                  <button type="button" className={`weekly-room-head ${day === date ? "active" : ""}`} key={day} aria-pressed={day === date} onClick={() => setDate(day)}>
                    <b>{formatWeekday(day)}</b><span>{dayOfMonth(day)}</span>
                    {day === date && <span className="daily-room-selected-icon"><SelectedRoomIcon /></span>}
                  </button>
                ))}
                {floorRooms.map((room) => {
                  const status = statusOf(room);
                  return (
                    <div className="weekly-room-row" key={room.id}>
                      <div className={`weekly-room-name ${selected.id === room.id ? "selected" : ""}`}>
                        <button type="button" className="weekly-room-select" aria-pressed={selected.id === room.id} title={roomIdentity(room)} onClick={() => setSelectedId(room.id)}>
                          <span className="weekly-room-title">{room.name}</span><span className="weekly-room-floor">{room.floor}층</span><small className={status.status}><i className={`room-status-dot ${status.status}`} /><b>{status.statusLabel}</b><em>·</em>{formatCapacity(room.capacity)}</small>
                          {selected.id === room.id && <span className="daily-room-selected-icon"><SelectedRoomIcon /></span>}
                        </button>
                        <RoomEquipment key={`${date}:${room.id}`} room={room} />
                      </div>
                      {weekDays.map((day) => {
                        const dayBookings = layoutOverlappingBookings(
                          bookings.filter((booking) => booking.roomId === room.id && booking.date === day),
                        );
                        return <div className={`weekly-room-cell ${day === date ? "active" : ""}`} key={`${room.id}-${day}`}>
                          <button
                            type="button"
                            className="weekly-cell-add"
                            aria-label={`${roomIdentity(room)} ${formatDateLabel(day)} 빈 시간 예약하기`}
                            // 한 번 클릭으로는 열리지 않게 한다. 표를 훑다가 실수로 열리는 일이 잦았다.
                            // (키보드로 Tab해 와서 누르는 것은 실수로 볼 이유가 없어 Enter/Space는 바로 연다)
                            onDoubleClick={() => askWeekdaySlot(room, day)}
                            onPointerUp={(event) => {
                              if (event.pointerType !== "touch") return;
                              event.preventDefault();
                              askWeekdaySlot(room, day);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              event.preventDefault();
                              askWeekdaySlot(room, day);
                            }}
                          >
                            <span aria-hidden="true">＋</span>
                          </button>
                          <div className="weekly-booking-list">{dayBookings.map((booking, index) => {
                            return (
                              <button
                                type="button"
                                className={`weekly-room-event tone-${index % 3}${isMyBooking(booking) ? " is-mine" : ""}`}
                                key={booking.id}
                                aria-label={isMyBooking(booking) ? `내 예약 ${booking.start}–${booking.end} · 눌러서 수정하거나 삭제합니다`
                                  : `${booking.start}–${booking.end} / ${booking.owner} · ${teamOf(booking)}`}
                                onClick={() => { setSelectedId(room.id); setDate(day); openEditor(booking); }}
                              >
                                <b>{booking.owner}</b>
                                <time>{booking.start}<span className="wk-end">–{booking.end}</span></time>
                                <small title={teamOf(booking)}>{teamOf(booking)}</small>
                                {isMyBooking(booking) && <ReservationHoverCard />}
                              </button>
                            );
                          })}</div>
                        </div>;
                      })}
                    </div>
                  );
                })}
              </div>}
            </section>
          </div>
        </section>

      </section>

      {/* 빠른 예약은 작업 영역 밖으로 뺀다. 화면 맨 위부터 아래까지 한 칸으로
          쓰려면 상단바·작업영역과 형제여야 격자에 자리를 잡을 수 있다. */}
      <aside className={`booking-panel ${bookingPanelOpen ? "" : "is-collapsed"} ${filledNotice ? "just-filled" : ""}`} id="quick-booking">
        <button
          type="button"
          className="booking-panel-rail"
          aria-label="빠른 예약 펼치기"
          aria-expanded={bookingPanelOpen}
          aria-controls="quick-booking-content"
          onClick={() => setBookingPanelOpen(true)}
        >
          <span className="booking-panel-rail-main">
            <CalendarIcon />
            <i aria-hidden="true" />
            <span>빠른 예약</span>
          </span>
          <span className="booking-panel-rail-arrow" aria-hidden="true">
            <ChevronIcon direction="prev" />
          </span>
        </button>
        <div className="booking-panel-content" id="quick-booking-content" aria-hidden={!bookingPanelOpen}>
        {/* 표·배치도에서 값을 가져오면 칸 위에 겹쳐 잠깐 뜬다. 자리를 차지하지
            않으므로 아래 입력칸이 밀리지 않는다. */}
        {/* 떠 있는 알림은 뺐다. 표의 점선 블록과 머리의 '작성 중' 딱지가
            사라지지 않고 남으므로, 3초짜리 알림까지 겹칠 필요가 없다.
            (채워진 칸의 초록 강조와 예약 버튼 맥박은 그대로 둔다) */}
        {filledNotice && <span className="sr-only" role="status" aria-live="polite">
          {filledNotice.title} {filledNotice.detail} · 아직 예약 전입니다
        </span>}
          <div className="booking-title">
            <button
              type="button"
              className="booking-panel-toggle"
              aria-label="빠른 예약 접기"
              aria-expanded={bookingPanelOpen}
              aria-controls="quick-booking-content"
              onClick={() => {
                setBookingPanelOpen(false);
                setRoomPickerOpen(false);
                setTimePickerOpen(null);
                setBookingDateCalendarOpen(false);
                setRepeatEndCalendarOpen(false);
              }}
            ><DoubleChevronIcon direction="prev" /></button>

            <div className="booking-title-copy"><h2>빠른 예약</h2></div>

            {/* 예약하기를 누를 때까지 내려가지 않는 딱지. 알림은 3초 뒤 사라지지만
                이건 남아서 '아직 안 끝났다'를 계속 말한다. */}
            <div className="booking-title-state">{draftActive && <span className="draft-chip">작성 중</span>}</div>
          </div>
          <div className="booking-section-heading booking-room-heading">
            <span>1</span><b>회의실</b>
          </div>

          <form onSubmit={submitReservation}>
            {/* 입력칸만 스크롤시키고 '예약하기'는 그 아래에 늘 보이게 둔다.
                버튼을 sticky로 띄우면 밑에 있는 칸을 덮어 버린다. */}
            <label className="sr-only" htmlFor="room-picker-select">회의실</label>
            <div className="booking-room-section">
          <section className="room-picker-card" aria-label="room picker">
            <button
              type="button"
              className={`room-picker-toggle ${roomPickerOpen ? "open" : ""}`}
              aria-label={`회의실 선택: ${selected.name} ${selected.floor}층`}
              aria-expanded={roomPickerOpen}
              onClick={() => {
                setTimePickerOpen(null);
                setBookingDateCalendarOpen(false);
                setRepeatEndCalendarOpen(false);
                setRoomPickerOpen((current) => !current);
              }}
            >
              <span className="room-picker-field-copy">
                <span className="room-picker-field-title"><span className={`status-dot ${selectedStatus.status}`} /><strong>{selected.name}</strong><small className="room-picker-field-floor">{selected.floor}F</small></span>
                <span className="room-picker-field-specs"><em>{formatCapacity(selected.capacity)}</em>{selected.equipment.slice(0, 2).map((item) => <em key={item}>{item}</em>)}</span>
              </span>
              <i aria-hidden="true" />
            </button>
            {roomPickerOpen && <div className="room-picker-options room-picker-popover" role="dialog" aria-label="회의실 선택" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
              <div className="room-picker-filters" role="group" aria-label="회의실 목록 필터">
                <button type="button" aria-label="전체 회의실 보기" aria-pressed={!roomPickerFavoritesOnly} onClick={() => setRoomPickerFavoritesOnly(false)}>전체 회의실</button>
                <button type="button" aria-label="즐겨찾기만 보기" aria-pressed={roomPickerFavoritesOnly} aria-describedby="favorite-storage-hint" title={currentUser ? "즐겨찾기는 내 계정에 저장됩니다" : "즐겨찾기는 이 브라우저에 저장됩니다"} onClick={() => setRoomPickerFavoritesOnly(true)}><FavoriteIcon />즐겨찾기{!!favorites.ids.length && <span className="favorite-count">{favorites.ids.length}</span>}</button>
              </div>
              <p id="favorite-storage-hint" className="sr-only">{currentUser ? "즐겨찾기는 내 계정에 저장됩니다." : "즐겨찾기는 이 브라우저에 저장됩니다."}</p>
              {favorites.message && <p className="favorites-hint" role="status">{favorites.message}</p>}
              {roomPickerFavoritesOnly && !visibleRoomPickerChoices.length && <div className="room-picker-empty" role="status"><FavoriteIcon /><strong>{favorites.loaded ? "즐겨찾는 회의실이 없어요" : "즐겨찾기를 확인하고 있어요"}</strong><p>전체 목록에서 별을 눌러 추가하세요.</p><button type="button" onClick={() => setRoomPickerFavoritesOnly(false)}>전체 회의실 보기</button></div>}
              {floors.filter(item => visibleRoomPickerChoices.some(({ room }) => room.floor === item)).map((item) => (
                <div className="room-picker-floor-group" key={item}>
                  <small>{item}F</small>
                  {visibleRoomPickerChoices.filter(({ room }) => room.floor === item).map(({ room }) => {
                    const status = statusOf(room);
                    return <div className="room-picker-row" key={room.id}>
                      <button type="button" className={selected.id === room.id ? "selected" : ""} title={`${room.floor}층 · ${room.name} · ${formatCapacity(room.capacity)} · ${room.equipment.join(" · ")}`} onClick={() => selectRoom(room)}>
                        {/* 점과 이름을 한 덩어리로 묶는다. 따로 두면 좁을 때 점만 남고
                            이름이 다음 줄로 떨어져 나갈 자리가 없다. */}
                        <span className="room-picker-name"><span className={`status-dot ${status.status}`} /><strong>{room.name}</strong></span>
                        <em>{formatCapacity(room.capacity)} · {room.equipment.slice(0, 2).join(" · ")}</em>
                      </button>
                      <FavoriteButton roomId={room.id} active={favorites.ids.includes(room.id)} disabled={!favorites.loaded || favorites.pending.includes(room.id)} onClick={() => void favorites.toggle(room.id)} />
                      <button
                        type="button"
                        className="room-picker-row-map"
                        title={`${room.name} 배치도에서 위치 보기`}
                        aria-label={`${room.name} 배치도에서 위치 보기`}
                        onClick={() => { setTeamOpen(false); selectRoom(room); setShowMap(true); }}
                      >
                        <PinIcon />
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

            </div>

            {/* 스크롤되는 영역은 여기서부터. 회의실 카드를 이 밖에 두어야
                스크롤 막대가 빨강 선을 가로지르지 않는다. */}
            <div className="booking-fields">
            <section className="booking-form-section booking-date-section">
              <div className="booking-section-heading"><span>2</span><b>예약 날짜</b></div>
              <div className="booking-date-row"><DateField
                controlledOpen={bookingDateCalendarOpen}
                onOpenChange={(next) => {
                  setBookingDateCalendarOpen(next);
                  if (next) {
                    setRoomPickerOpen(false);
                    setTimePickerOpen(null);
                    setRepeatEndCalendarOpen(false);
                  }
                }}
                value={date}
                onChange={(next) => { setDate(next); setBookingDateCalendarOpen(false); }}
              /></div>
            </section>

            <section className="booking-form-section booking-time-section">
              <div className="booking-section-heading"><span>3</span><b>시간 선택</b></div>
              <div className="form-row form-row-time">
              {/* 일간 표에서 드래그한 뒤 회의 목적 칸에 붙는 것과 같은 옅은 표시다.
                  '틀렸다'는 경고가 아니라 '다음에 할 일'을 가리키는 것이라
                  Field-missing(제출 시 빈 칸)과는 다르게, 값이 바뀌면 조용히 풀린다. */}
              {/* 고르고 나면 커서(포커스)를 놓아 준다. select는 값을 고른
                  뒤에도 포커스가 남아, 다른 칸과 달리 빨간 포커스 테두리가
                  할 일이 끝난 뒤에도 계속 떠 있는 것처럼 보였다. */}
              <label className={timeNeedsPick ? "needs-input" : undefined}><span className="field-label">시작 시간</span><button id="start-time-select" className="time-picker-toggle" type="button" aria-haspopup="listbox" aria-controls={timePickerOpen === "start" ? "booking-time-options" : undefined} aria-expanded={timePickerOpen === "start"} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setTimePickerOpen("start"); } }} onClick={() => { setRoomPickerOpen(false); setBookingDateCalendarOpen(false); setRepeatEndCalendarOpen(false); setTimePickerOpen((current) => current === "start" ? null : "start"); }}>{start}</button></label>
              <label className={timeNeedsPick ? "needs-input" : undefined}><span className="field-label">종료 시간</span><button id="end-time-select" className="time-picker-toggle" type="button" aria-haspopup="listbox" aria-controls={timePickerOpen === "end" ? "booking-time-options" : undefined} aria-expanded={timePickerOpen === "end"} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setTimePickerOpen("end"); } }} onClick={() => { setRoomPickerOpen(false); setBookingDateCalendarOpen(false); setRepeatEndCalendarOpen(false); setTimePickerOpen((current) => current === "end" ? null : "end"); }}>{end}</button></label>
              </div>

              {timePickerOpen && <div id="booking-time-options" className="time-picker-popover" role="listbox" tabIndex={-1} aria-label={timePickerOpen === "start" ? "예약 가능한 시작 시간" : "예약 가능한 종료 시간"} onKeyDown={handleTimePickerKey} onPointerDown={(event) => event.stopPropagation()}>
                <div className="time-picker-popover-head"><b>{timePickerOpen === "start" ? "시작 시간" : "종료 시간"}</b><span>예약 가능한 시간만 표시</span></div>
                <div className="time-picker-slots">
                  {timePickerOpen === "start" && availableStartOptions.map((time) => (
                    <button
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={start === time}
                      className={start === time ? "selected" : ""}
                      key={time}
                      onClick={() => { changeStart(time); closeTimePicker(); }}
                    >{time}</button>
                  ))}
                  {timePickerOpen === "end" && availableEndOptions.map((time) => (
                    <button
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={end === time}
                      className={end === time ? "selected" : ""}
                      key={time}
                      onClick={() => { changeEnd(time); closeTimePicker(); }}
                    >{time}</button>
                  ))}
                </div>
                {(timePickerOpen === "start" ? availableStartOptions : availableEndOptions).length === 0 && <p>선택 가능한 시간이 없습니다.</p>}
              </div>}

            <label className="repeat-option">
              <input type="checkbox" checked={repeatWeekly} onChange={(event) => {
                const checked = event.target.checked;
                setRepeatWeekly(checked);
                setRepeatEndCalendarOpen(checked);
                setBookingDateCalendarOpen(false);
                setRoomPickerOpen(false);
                setTimePickerOpen(null);
                if (checked && !repeatEndTouched) {
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
                  controlledOpen={repeatEndCalendarOpen}
                  onOpenChange={(next) => {
                    setRepeatEndCalendarOpen(next);
                    if (next) {
                      setBookingDateCalendarOpen(false);
                      setRoomPickerOpen(false);
                      setTimePickerOpen(null);
                    }
                  }}
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
              {/* 반복은 평일만 펼치므로, 고른 기간에 주말·공휴일이 끼면 그 사실을 알려 준다. */}
              <p>
                {formatDateLabel(date)}부터 총 <b>{reservationDates.length}</b>회 예약됩니다.
                {REPEAT_CYCLE === "weekdays" && repeatEnd > date && (
                  <em className="repeat-note">
                    {repeatWeekends ? "주말·공휴일 포함" : "주말·공휴일 제외"}
                  </em>
                )}
              </p>
              {/* 서버는 한 번에 maxRepeatCount건까지만 받는다. 제출 전에 미리 알려야
                  "88회 예약됩니다"라고 보여 준 뒤 전량 실패하는 일이 없다. */}
              {reservationDates.length > bookingDefaults.maxRepeatCount && (
                <div className="notice error">
                  한 번에 반복 예약할 수 있는 건수({bookingDefaults.maxRepeatCount}건)를 넘었어요. 종료일을 앞당겨 주세요.
                </div>
              )}
              {/* 어느 날이 잡히는지 날짜로 보여 준다. 숫자만으로는 주말·공휴일이 어떻게
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
            </section>

            <section className="booking-form-section booking-info-section">
            <div className="booking-section-heading"><span>4</span><b>예약 정보</b></div>

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

            <details className="booking-extra-details" open={extraDetailsOpen} onToggle={(event) => setExtraDetailsOpen(event.currentTarget.open)}>
            <summary>추가 정보 <span>(선택){purpose.trim() || attendees.length || attendeeAccounts.length ? " · 입력됨" : ""}</span></summary>
            <label>
              <span className="field-label">회의 목적</span>
              <input
                id="purpose-input"
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); focusNextRequired(null); } }}
                placeholder="예: 주간회의"
              />
            </label>

            {/* 참석자는 선택 항목이라 평소에는 접어 두고 누를 때만 펼친다. */}
            {currentUser && <EmployeePicker value={attendeeAccounts} onChange={setAttendeeAccounts} limit={bookingDefaults.maxAttendees-attendees.length} />}
            {currentUser && <p className="convenience-hint">아래 이름 직접 입력은 외부 참석자용입니다. 직원은 위 검색 결과에서 선택해 주세요.</p>}
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
                <p className="attendee-count">총 {attendees.length + attendeeAccounts.length}명 · {formatCapacity(selected.capacity)}</p>
              </div>
            ) : (
              <button type="button" className="attendee-add" onClick={() => revealAfterExpand(".attendee-field", () => setAttendeesOpen(true))}>
                참석자 추가 <em>(선택)</em>
              </button>
            )}
            </details>
            {currentUser && <MicrosoftPanel bookings={bookings} />}

            </section>


            </div>

            <div className="booking-submit">
            {!bookingRecovery && <div className={`booking-selection-summary${selectedTimeConflict ? " is-conflict" : ""}`} data-availability={timeNeedsPick ? "unknown" : selectedTimeConflict ? "conflict" : bookingBlockReason ? "closed" : "available"}>
              <strong>{roomIdentity(selected)}</strong>
              <span>{formatDateLabel(date)} · {timeNeedsPick ? "시간을 선택해 주세요" : `${start}–${end} · 총 ${spokenDuration(minutesOf(end) - minutesOf(start))}`}</span>
              {repeatWeekly && <small>반복 {reservationDates.length}일{selectedTimeConflict ? ` · ${reservationDates.length - conflictDates.length}일 예약 가능` : ""}</small>}
              <small id="booking-selection-status" role="status">{timeNeedsPick ? "시작·종료 시간을 먼저 확인해 주세요." : bookingBlockReason || (selectedTimeConflict ? "일부 날짜에 예약이 겹칩니다. 가능한 날짜를 확인할 수 있습니다." : "선택 시간 예약 가능")}</small>
            </div>}
            {bookingRecovery && <section className="booking-recovery" role="status" aria-live="polite" aria-busy={checkingBookingResult}>
              <strong><ClockIcon />{bookingRecovery.timedOut ? "응답이 늦어지고 있어요" : "예약 결과를 확인해 주세요"}</strong>
              <span>{roomIdentity(roomById(bookingRecovery.roomId))} · {bookingRecovery.start}–{bookingRecovery.end}</span>
              {notice ? <p>{notice}</p> : <p>이미 저장됐을 수 있어요. 입력 내용은 그대로 보관했어요.</p>}
              <button type="button" disabled={checkingBookingResult || !authReady} onClick={() => void checkBookingResult()}>{checkingBookingResult ? "예약 결과 확인 중…" : "예약 결과 확인"}</button>
            </section>}
            {notice && !bookingRecovery && <div className={`notice ${notice.includes("완료") || notice.includes("찾았습니다") ? "success" : "error"}`} role="status">{notice}</div>}
            {!bookingRecovery && selectedTimeConflict && !notice && <div className="notice error booking-conflict-notice"><b>이미 예약된 시간입니다.</b><span>다른 시간을 선택해 주세요.</span></div>}
            {!bookingRecovery && selectedTimeConflict && bookingAlternatives.length > 0 && <section className="booking-alternatives" aria-label="예약 가능한 대안">
              <b>대신 예약할 수 있어요</b>
              {bookingAlternatives.slice(0, alternativesExpanded ? bookingAlternatives.length : 2).map((alternative) => (
                <button type="button" key={`${alternative.roomId}-${alternative.start}-${alternative.end}`} onClick={() => applyAlternative(alternative)}>
                  <span><strong>{roomById(alternative.roomId)?.name}</strong><i>{roomById(alternative.roomId)?.floor}층</i></span><em>{alternative.start}–{alternative.end} · {alternative.reason}</em>
                </button>
              ))}
              {bookingAlternatives.length > 2 && (
                <button type="button" className="booking-alternatives-more" aria-expanded={alternativesExpanded} onClick={() => setAlternativesExpanded((current) => !current)}>
                  {alternativesExpanded ? "대안 접기" : `대안 ${bookingAlternatives.length - 2}개 더 보기`}
                </button>
              )}
            </section>}
            {!bookingRecovery && <button id="reserve-button" className="reserve-button" type="submit" aria-describedby="booking-selection-status" disabled={mutationBusy || !authReady || Boolean(bookingBlockReason) || Boolean(bookingRecovery)}>
              <span className="reserve-button-meta">
                <span className="reserve-button-room">{roomIdentity(selected)}</span>
                {/* 반복 예약이면 몇 건이 만들어지는지 버튼이 직접 말해야 한다.
                    회의실과 시간을 한 줄에 묶고, 행동은 아래에서 크게 강조한다. */}
                <span className="reserve-button-time">
                  {start}–{end}{reservationDates.length > 1 ? ` · ${reservationDates.length}건` : ""}
                </span>
              </span>
              <strong className="reserve-button-action">
                {submitting ? "저장 중…" : bookingRecovery ? "예약 결과 확인 필요" : !authReady ? "로그인 확인 중…" : bookingBlockReason ? "예약 불가" : selectedTimeConflict && conflictDates.length < reservationDates.length ? "예약 가능한 날짜 확인" : "예약하기"}
              </strong>
            </button>}
            </div>
          </form>
        </div>
      </aside>
      {submitPreviewDates && <div className="edit-backdrop booking-confirm-backdrop" role="presentation" onMouseDown={() => setSubmitPreviewDates(null)}>
        <section ref={submitPreviewDialogRef} className="booking-confirm-dialog booking-confirm-clean" role="dialog" aria-modal="true" aria-labelledby="booking-confirm-title" aria-describedby="booking-confirm-description" onMouseDown={(event) => event.stopPropagation()}>
          <button type="button" className="booking-confirm-close" aria-label="예약 확인창 닫기" onClick={() => setSubmitPreviewDates(null)}><CloseIcon /></button>
          <h2 id="booking-confirm-title">이 내용으로 예약할까요?</h2>
          <p id="booking-confirm-description">회의실과 시간을 한 번 더 확인해 주세요.</p>
          <div className="booking-confirm-summary" role="group" aria-label={roomIdentity(selected)}>
            <div className="booking-confirm-room"><strong>{selected.name}</strong><span className="booking-confirm-floor">{selected.floor}F</span></div>
            <div className="booking-confirm-details">
              <div className="booking-confirm-detail"><CalendarIcon /><time dateTime={submitPreviewDates[0]}>{formatDateLabel(submitPreviewDates[0])}</time>{submitPreviewDates.length > 1 && <span className="booking-confirm-duration">총 {submitPreviewDates.length}회</span>}</div>
              <div className="booking-confirm-detail"><ClockIcon /><span className="booking-confirm-time"><time>{start}</time> — <time>{end}</time></span><span className="booking-confirm-duration">{spokenDuration(minutesOf(end) - minutesOf(start))}</span></div>
            </div>
            {purpose.trim() && <div className="booking-confirm-purpose"><span>회의 목적</span><p>{purpose.trim()}</p></div>}
            {submitPreviewDates.length > 1 && <details className="booking-confirm-dates"><summary>{submitPreviewDates.length}회 예약 날짜 확인</summary><ul>{submitPreviewDates.map((day) => <li key={day}>{formatDateLabel(day)}</li>)}</ul></details>}
          </div>
          <div className="booking-confirm-actions">
            <button type="button" onClick={() => setSubmitPreviewDates(null)}>수정하기</button>
            <button type="button" className="booking-confirm-submit" disabled={submitting} onClick={() => sendBooking(submitPreviewDates)}>{submitting ? "예약하는 중…" : "예약하기"}</button>
          </div>
        </section>
      </div>}
      {myBookingsOpen && <div className="my-bookings-backdrop my-bookings-clean-backdrop" role="presentation" inert={topmostDialog !== "myBookingsOpen"} aria-hidden={topmostDialog !== "myBookingsOpen" || undefined} onMouseDown={() => { setMyBookingsOpen(false); setCancelSelection(null); }}>
        <section ref={myBookingsDialogRef} className="my-bookings-dialog my-bookings-clean booking-confirm-clean" role="dialog" aria-modal="true" aria-labelledby="my-bookings-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="my-bookings-dialog-head"><div><h2 id="my-bookings-title">내 예약</h2><p>예약한 회의실과 시간을 한눈에 확인하세요.</p></div><button type="button" className="booking-confirm-close" onClick={() => { setMyBookingsOpen(false); setCancelSelection(null); }} aria-label="내 예약 닫기"><CloseIcon /></button></div>
          {authReady && !currentUser && <label className="my-bookings-search"><span>예약자 이름</span><input value={myBookingOwner} onChange={(event) => setMyBookingOwner(event.target.value)} placeholder="예약자 이름을 입력하세요" /></label>}
          <p className="my-bookings-summary">
            <span>진행·예정 예약 <b>{upcomingMyBookings.length}</b></span>
            <span>지난 예약 · 최근 1개월 <b>{pastMyBookings.length}</b></span>
            <span className="my-bookings-history-range">
              지난 예약 조회: {pastBookingCutoff.replaceAll("-", ".")}–{today.replaceAll("-", ".")}
            </span>
          </p>
          <div className="my-bookings-list-wrap">
            {myBookingRows.length ? <table className="my-bookings-list" aria-label="내 예약 목록">
              <colgroup><col className="pick-col" /><col className="date-col" /><col className="time-col" /><col className="room-col" /><col /><col className="status-col" /><col className="actions-col" /></colgroup>
              <thead><tr>
                <th scope="col"><label className="my-booking-pick my-booking-pick-all"><input type="checkbox" aria-label="전체선택"
                  disabled={!upcomingMyBookings.length || mutationBusy}
                  checked={upcomingMyBookings.length > 0 && selectedBookingIds.length === upcomingMyBookings.length}
                  ref={(input) => { if (input) input.indeterminate = selectedBookingIds.length > 0 && selectedBookingIds.length < upcomingMyBookings.length; }}
                  onChange={(event) => setCancelSelection(event.target.checked ? upcomingMyBookings.map((booking) => booking.id) : [])} /></label></th>
                <th scope="col">날짜</th><th scope="col">시간</th><th scope="col">회의실</th><th scope="col">회의 목적 · 본부</th><th scope="col">상태</th><th scope="col">관리</th>
              </tr></thead><tbody>
                {myBookingRows.map(({ booking, upcoming }) => {
                  const room = roomById(booking.roomId);
                  const picked = upcoming && selectedBookingIds.includes(booking.id);
                  const toggle = () => setCancelSelection((current) => {
                    const list = current ?? [];
                    return list.includes(booking.id) ? list.filter((id) => id !== booking.id) : [...list, booking.id];
                  });
                  return (
                    <tr key={booking.id} className={`my-booking-row${upcoming ? "" : " is-past"}${picked ? " is-picked" : ""}`}>
                      <td>{upcoming && <label className="my-booking-pick"><input type="checkbox" checked={picked} onChange={toggle} disabled={mutationBusy || !authReady}
                        aria-label={`${roomIdentity(room)} ${booking.date} ${booking.start} 예약 선택`} /></label>}</td>
                      <td className="my-booking-date"><time dateTime={booking.date}>{formatDateLabel(booking.date)}</time></td>
                      <td><span className="my-booking-time">{booking.start}–{booking.end}</span><small className="my-booking-duration">{spokenDuration(minutesOf(booking.end) - minutesOf(booking.start))}</small></td>
                      <td><div className="my-booking-room" aria-label={roomIdentity(roomById(booking.roomId))}>
                          <strong>{room?.name ?? "회의실"}</strong>{room && <span className="booking-confirm-floor">{room.floor}F</span>}
                        </div></td>
                      <td className="my-booking-team">
                        {booking.purpose && <p className="my-booking-purpose" title={booking.purpose}>{booking.purpose}</p>}
                        <p className="my-booking-department" title={teamOf(booking)}>{teamOf(booking)}</p>
                        {!!booking.attendeeAccounts?.length && <details className="booking-attendee-detail"><summary>직원 참석자 {booking.attendeeAccounts.length}명</summary>{booking.attendeeAccounts.map(employee => <div key={employee.id}>{employee.name} · {employee.email}</div>)}</details>}
                      </td>
                      <td><span className={`booking-status my-booking-badge ${isRunningNow(booking) ? "running" : ""}`}>
                        {isRunningNow(booking) ? "진행 중" : upcoming ? "예정" : booking.endedAt ? "종료" : "지난 예약"}
                      </span>{booking.endedAt && <small className="my-booking-retained">사용 기록 보존</small>}</td>
                      <td>
                        {upcoming && (
                          <div className="my-booking-actions">
                                <button type="button" className="edit-booking" disabled={mutationBusy || !authReady} onClick={() => openEditor(booking)}>수정</button>
                                <button type="button" className="delete-booking" disabled={mutationBusy || !authReady} onClick={() => setCancelAsk([booking.id])}>삭제</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody></table> : <p className="my-bookings-empty" role="status">예약이 없습니다.</p>}
          </div>
          {syncError && <p className="edit-dialog-notice" role="alert">{syncError}</p>}
          {upcomingMyBookings.length > 0 && (() => {
            const first = upcomingMyBookings.find((booking) => booking.id === selectedBookingIds[0]);
            const series = first ? sameSeriesIds(first) : [];
            const seriesLeft = series.filter((id) => !selectedBookingIds.includes(id));
            return (
              <div className="my-bookings-cancelbar" role="group" aria-label="선택 예약 삭제">
                <p>{selectedBookingIds.length ? <><b>{selectedBookingIds.length}건</b> 선택</> : "삭제할 예약을 왼쪽에서 선택하세요."}</p>
                <div>
                  {seriesLeft.length > 0 && (
                    <button type="button" className="pick-series" disabled={mutationBusy} onClick={() => setCancelSelection([...new Set([...selectedBookingIds, ...series])])}>
                      같은 반복 예약 {series.length}건 모두
                    </button>
                  )}
                  {/* 목록 위의 '전체선택' 체크박스가 같은 일을 하므로 여기서는 뺀다. */}
                  {selectedBookingIds.length > 0 && <button type="button" disabled={mutationBusy} onClick={() => setCancelSelection(null)}>선택 해제</button>}
                  <button
                    type="button"
                    className="cancel-confirm"
                    disabled={selectedBookingIds.length === 0 || mutationBusy || !authReady}
                    onClick={() => setCancelAsk(selectedBookingIds)}
                  >
                    {cancelBusy ? "삭제하는 중…" : selectedBookingIds.length ? `${selectedBookingIds.length}건 삭제` : "선택 삭제"}
                  </button>
                </div>
              </div>
            );
          })()}
        </section>
      </div>}
      {editDraft && <div className="edit-backdrop" role="presentation" inert={editConflict} aria-hidden={editConflict || undefined} onMouseDown={() => { if (!editBusy && !editConflict) setEditDraft(null); }}>
        <section ref={editDraftDialogRef} className="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="edit-dialog-head">
            <div><h2 id="edit-dialog-title">예약 수정</h2></div>
            <button type="button" onClick={() => { if (!editBusy) setEditDraft(null); }} aria-label="예약 수정 닫기"><CloseIcon /></button>
          </div>
          <div className="edit-dialog-body" inert={editBusy}>
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
                <p>{editingBooking && isRunningNow(editingBooking)
                  ? `남은 시간만 해제할까요? 사용 기록은 남고, ${deletionReleaseTime(editingBooking)}부터 예약 가능합니다. 처리 시각에 따라 달라질 수 있습니다.`
                  : "이 예약을 삭제할까요? 예정 예약은 삭제되고, 처리 시 이미 시작된 예약은 사용 기록을 남깁니다."}</p>
                <button type="button" disabled={editBusy} onClick={() => setEditConfirmDelete(false)}>유지</button>
                <button type="button" className="edit-delete" disabled={mutationBusy || !authReady} onClick={deleteEditing}>삭제하기</button>
              </>
            ) : (
              <>
                <button type="button" className="edit-delete" disabled={editBusy} onClick={() => setEditConfirmDelete(true)}>예약 삭제</button>
                <button type="button" onClick={() => { if (!editBusy) setEditDraft(null); }}>닫기</button>
                <button type="button" className="edit-save" disabled={mutationBusy || !authReady} onClick={saveEdit}>{editBusy ? "저장 중…" : "수정 저장"}</button>
              </>
            )}
          </div>
        </section>
      </div>}
      {editDraft && editConflict && <BookingConflictDialog draft={editDraft} onBack={() => setEditConflict(false)} onReload={(latest) => {
        setEditDraft(editDraftOf(latest));
        setEditConflict(false);
        setEditConfirmDelete(false);
        setEditNotice("최신 내용을 불러왔습니다. 확인 후 필요한 항목을 수정해 주세요.");
        void refreshBookings();
      }} />}
      {repeatAsk && <div className="edit-backdrop" role="presentation" onMouseDown={() => setRepeatAsk(null)}>
        <section ref={repeatAskDialogRef} className="early-dialog" role="dialog" aria-modal="true" aria-labelledby="repeat-ask-title" onMouseDown={(event) => event.stopPropagation()}>
          <h2 id="repeat-ask-title">{repeatAsk.conflicts.length}일은 이미 차 있어요</h2>
          <p>그 날만 빼고 나머지를 예약할 수 있습니다.</p>
          <div className="early-summary">
            <b>{roomIdentity(selected)} · {start}–{end}</b>
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
            <button type="button" className="early-go" disabled={submitting} onClick={() => { setSubmitPreviewDates(repeatAsk.free); setRepeatAsk(null); }}>
              {`${repeatAsk.free.length}일만 예약하기`}
            </button>
          </div>
        </section>
      </div>}
      {/* 취소 확인. 취소는 되돌릴 수 없으므로 무엇이 사라지는지 한 건씩 보여 주고,
          같은 반복 예약 중 몇 건을 지우는지도 함께 말한다. */}
      {cancelAsk && (() => {
        const picked = myBookings.filter((booking) => cancelAsk.includes(booking.id));
        // 고른 예약이 모두 같은 반복 묶음일 때만 '반복 중 몇 건' 이야기를 한다.
        // 서로 다른 예약을 섞어 골랐다면 그 문장은 거짓이 된다.
        const series = picked[0] ? sameSeriesIds(picked[0]) : [];
        const oneSeries = picked.every((booking) => series.includes(booking.id));
        const partOfSeries = oneSeries && series.length > 1;
        const wholeSeries = partOfSeries && series.every((id) => cancelAsk.includes(id));
        return (
          <div className="edit-backdrop cancel-backdrop" role="presentation" onMouseDown={() => setCancelAsk(null)}>
            <section ref={cancelAskDialogRef} className="early-dialog cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-ask-title" onMouseDown={(event) => event.stopPropagation()}>
              <h2 id="cancel-ask-title">예약 {picked.length}건을 삭제할까요?</h2>
              <p>예정 예약은 삭제되고, 진행 중 예약은 남은 시간만 해제됩니다. 사용 기록은 남습니다.</p>
              <div className="early-summary">
                <span className="cancel-ask-list">
                  {picked.map((booking) => (
                    <em key={booking.id}>
                      <b>{roomIdentity(roomById(booking.roomId))}</b>
                      {formatDateLabel(booking.date)} · {booking.start}–{booking.end}
                      <i>{booking.purpose}</i>
                      <strong className="cancel-effect">{hasEnded(booking) ? "이미 종료되어 사용 기록을 보존합니다."
                        : isRunningNow(booking) ? `사용 기록 보존 · ${deletionReleaseTime(booking)}부터 예약 가능` : "예정 예약 삭제"}</strong>
                    </em>
                  ))}
                </span>
                {partOfSeries && (
                  <span className="cancel-ask-series">
                    {wholeSeries
                      ? `같은 반복 예약 ${series.length}건을 모두 선택했습니다.`
                      : `같은 반복 예약 ${series.length}건 중 ${picked.length}건만 선택했습니다. 나머지 ${series.length - picked.length}건은 그대로 남습니다.`}
                  </span>
                )}
              </div>
              <p className="cancel-boundary-note">진행 중 예약은 {bookingDefaults.slotMinutes}분 단위로 해제됩니다. 실제 처리 시각에 따라 해제 시각이 달라질 수 있습니다.</p>
              {!picked.length && <p role="status">선택한 예약이 더 이상 없습니다. 목록을 다시 확인해 주세요.</p>}
              <div className="early-foot">
                {/* '그만두기'는 «예약을 그만둔다»로도 읽혀 취소 창에서 뜻이 뒤집힌다. */}
                <button type="button" onClick={() => setCancelAsk(null)}>닫기</button>
                <button
                  type="button"
                  className="cancel-go"
                  disabled={mutationBusy || !authReady || !picked.some((booking) => !hasEnded(booking))}
                  onClick={() => { setCancelAsk(null); cancelBookings(picked.filter((booking) => !hasEnded(booking)).map((booking) => booking.id)); }}
                >
                  {cancelBusy ? "삭제하는 중…" : `${picked.filter((booking) => !hasEnded(booking)).length}건 삭제하기`}
                </button>
              </div>
            </section>
          </div>
        );
      })()}
      {toast && <div className={`booking-toast-layer${toast.kind === "booking" ? " booking-complete-layer" : ""}${toastFlight ? " is-flying" : ""}`}>
        <section
          className="booking-toast early-dialog booking-complete-dialog"
          role="status"
          aria-live="polite"
          style={toastFlight ? {
            "--toast-shift-x": `${toastFlight.x}px`,
            "--toast-shift-y": `${toastFlight.y}px`,
          } as CSSProperties : undefined}
        >
          <h2>{toast.text}</h2>
          {toast.kind === "booking" && <p>내 예약에 저장됩니다.</p>}
          <div className="early-summary booking-complete-summary">
            <b>{toast.detail}</b>
            <span>{toast.time}</span>
          </div>
          <button type="button" className="booking-toast-close" aria-label="알림 닫기" onClick={() => setToast(null)}><CloseIcon /></button>
        </section>
      </div>}
      <footer><span>※ 수용 인원과 장비 정보는 시제품용이며 관리자 설정에서 수정할 수 있습니다.</span><strong>사내 회의실 예약 시스템 · Prototype</strong></footer>
    </main>
  );
}
