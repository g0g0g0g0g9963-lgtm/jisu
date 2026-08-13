import { seedConfig, siteConfig } from "./config.mjs";
import { countBookings, createBookings } from "./db.mjs";

/**
 * SEED_DEMO=1 로 실행할 때만 쓰는 예시 데이터.
 * app/config/seed-bookings.json을 오늘 기준의 실제 날짜로 옮긴다
 * (app/lib/bookings.ts의 createSeedBookings와 같은 규칙).
 * 이미 예약이 하나라도 있으면 아무것도 하지 않는다.
 */

const dateKeyFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: siteConfig.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const todayKey = () => dateKeyFormatter.format(new Date());

const moveDate = (key, days) => {
  const value = new Date(`${key}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/** 해당 날짜가 속한 주의 월~금 (app/lib/datetime.ts의 getWorkWeek와 동일). */
const getWorkWeek = (key) => {
  const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  const monday = moveDate(key, weekday === 0 ? -6 : 1 - weekday);
  return Array.from({ length: 5 }, (_, index) => moveDate(monday, index));
};

export function seedDemoBookings() {
  if (countBookings() > 0) return 0;

  const today = todayKey();
  const workWeek = getWorkWeek(today);

  let inserted = 0;
  for (const seed of seedConfig) {
    const { when, ...rest } = seed;
    const date = when.type === "today" ? today : workWeek[when.index] ?? today;
    const result = createBookings({ ...rest, team: rest.team ?? "", dates: [date] });
    if (result.ok) inserted += result.created.length;
  }
  return inserted;
}
