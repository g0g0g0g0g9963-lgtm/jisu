import { type DateKey } from "./datetime";

export type PublicHoliday = {
  name: string;
  calendarLabel: string;
};

/**
 * 2026년 대한민국 관공서 공휴일.
 * 한국천문연구원 「2026년 월력요항」을 기준으로 관리한다.
 */
const PUBLIC_HOLIDAYS_2026: Record<DateKey, PublicHoliday> = {
  "2026-01-01": { name: "신정", calendarLabel: "신정" },
  "2026-02-16": { name: "설날 연휴", calendarLabel: "설연휴" },
  "2026-02-17": { name: "설날", calendarLabel: "설날" },
  "2026-02-18": { name: "설날 연휴", calendarLabel: "설연휴" },
  "2026-03-01": { name: "3·1절", calendarLabel: "3·1절" },
  "2026-03-02": { name: "3·1절 대체공휴일", calendarLabel: "대체휴일" },
  "2026-05-05": { name: "어린이날", calendarLabel: "어린이날" },
  "2026-05-24": { name: "부처님오신날", calendarLabel: "부처님날" },
  "2026-05-25": { name: "부처님오신날 대체공휴일", calendarLabel: "대체휴일" },
  "2026-06-03": { name: "전국동시지방선거", calendarLabel: "지방선거" },
  "2026-06-06": { name: "현충일", calendarLabel: "현충일" },
  "2026-08-15": { name: "광복절", calendarLabel: "광복절" },
  "2026-08-17": { name: "광복절 대체공휴일", calendarLabel: "대체휴일" },
  "2026-09-24": { name: "추석 연휴", calendarLabel: "추석연휴" },
  "2026-09-25": { name: "추석", calendarLabel: "추석" },
  "2026-09-26": { name: "추석 연휴", calendarLabel: "추석연휴" },
  "2026-10-03": { name: "개천절", calendarLabel: "개천절" },
  "2026-10-05": { name: "개천절 대체공휴일", calendarLabel: "대체휴일" },
  "2026-10-09": { name: "한글날", calendarLabel: "한글날" },
  "2026-12-25": { name: "기독탄신일", calendarLabel: "성탄절" },
};

export const publicHolidayOf = (date: DateKey): PublicHoliday | undefined =>
  PUBLIC_HOLIDAYS_2026[date];
