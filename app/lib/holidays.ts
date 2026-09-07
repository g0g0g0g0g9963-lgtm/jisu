import publicHolidaysByYear from "../config/public-holidays.json";
import { type DateKey } from "./datetime";

export type PublicHoliday = {
  name: string;
  calendarLabel: string;
};

type YearlyHolidays = Record<DateKey, PublicHoliday>;

const HOLIDAYS_BY_YEAR = publicHolidaysByYear as Record<string, YearlyHolidays>;

// 데이터가 없는 연도를 조용히 "공휴일 없음"으로 넘기면, 새해가 와도 아무도 모르고
// 지나간다. 개발자 콘솔에 한 번만 경고해 새 연도 데이터를 넣어야 한다는 걸 알린다.
const warnedYears = new Set<string>();

export const publicHolidayOf = (date: DateKey): PublicHoliday | undefined => {
  const year = date.slice(0, 4);
  const yearData = HOLIDAYS_BY_YEAR[year];
  if (!yearData) {
    if (!warnedYears.has(year)) {
      warnedYears.add(year);
      // eslint-disable-next-line no-console
      console.warn(`[holidays] ${year}년 공휴일 데이터가 없습니다. app/config/public-holidays.json에 추가해 주세요.`);
    }
    return undefined;
  }
  return yearData[date];
};
