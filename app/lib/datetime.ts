/**
 * 날짜·시간 유틸리티.
 *
 * 규칙 두 가지로 서버(UTC)와 사용자(한국) 사이의 날짜 어긋남을 막는다.
 *  1. "오늘"은 항상 사무실 표준시(site.json의 timeZone)로 판단한다.
 *  2. "YYYY-MM-DD" 날짜 키 계산은 UTC 기준으로만 한다. 실행 환경의 표준시에
 *     영향을 받지 않아 서버와 브라우저가 언제나 같은 값을 낸다.
 */
import siteConfig from "../config/site.json";

export const TIME_ZONE = siteConfig.timeZone;

/** "YYYY-MM-DD" 형식의 날짜 키. */
export type DateKey = string;

const dateKeyFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const officeClockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateLabelFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "UTC",
  month: "long",
  day: "numeric",
  weekday: "short",
});
const weekdayLabelFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "UTC",
  weekday: "short",
});
const fullDateLabelFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});
const wallClockLabelFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

const atUtcMidnight = (key: DateKey) => new Date(`${key}T00:00:00Z`);
const keyOfUtc = (value: Date) => value.toISOString().slice(0, 10);

/** 사무실 표준시 기준의 오늘 날짜 키. */
export const todayKey = (now: Date = new Date()): DateKey =>
  dateKeyFormatter.format(now);

/** 사무실 표준시 기준으로 자정부터 흐른 분. */
export const officeMinutesOfDay = (now: Date): number => {
  const [hour, minute] = officeClockFormatter.format(now).split(":").map(Number);
  return hour * 60 + minute;
};

export const moveDate = (key: DateKey, days: number): DateKey => {
  const value = atUtcMidnight(key);
  value.setUTCDate(value.getUTCDate() + days);
  return keyOfUtc(value);
};

/** 0=일요일 … 6=토요일. */
export const weekdayOf = (key: DateKey): number => atUtcMidnight(key).getUTCDay();

export const isWeekend = (key: DateKey): boolean => {
  const weekday = weekdayOf(key);
  return weekday === 0 || weekday === 6;
};

/**
 * 해당 날짜가 속한 주의 월~금.
 * 토·일을 선택해도 그 주의 평일이 나온다(일요일은 직전 월요일이 기준).
 */
export const getWorkWeek = (key: DateKey): DateKey[] => {
  const weekday = weekdayOf(key);
  const monday = moveDate(key, weekday === 0 ? -6 : 1 - weekday);
  return Array.from({ length: 5 }, (_, index) => moveDate(monday, index));
};

export const formatDateLabel = (key: DateKey): string =>
  key ? dateLabelFormatter.format(atUtcMidnight(key)) : "오늘";

export const formatWeekday = (key: DateKey): string =>
  weekdayLabelFormatter.format(atUtcMidnight(key));

export const dayOfMonth = (key: DateKey): number =>
  atUtcMidnight(key).getUTCDate();

export const formatFullDate = (instant: Date): string =>
  fullDateLabelFormatter.format(instant);

export const formatWallClock = (instant: Date): string =>
  wallClockLabelFormatter.format(instant);

/* --- 시각 문자열("HH:MM") --------------------------------------------- */

export const minutesOf = (time: string): number => {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
};

export const formatMinutes = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

export const addMinutes = (time: string, minutes: number): string =>
  formatMinutes(minutesOf(time) + minutes);

/** "오후 2시 30분" 형태의 읽기 쉬운 시각. */
export const formatSpokenTime = (time: string): string => {
  const [hour, minute] = time.split(":").map(Number);
  const meridiem = hour < 12 ? "오전" : "오후";
  return `${meridiem} ${hour % 12 || 12}시${minute ? ` ${minute}분` : ""}`;
};
