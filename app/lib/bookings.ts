/** 예약 데이터의 규칙: 겹침 판정, 반복 일정 전개, 겹친 예약의 배치. */
import siteConfig from "../config/site.json";
import seedBookings from "../config/seed-bookings.json";
import {
  addMinutes,
  type DateKey,
  formatMinutes,
  getWorkWeek,
  isWeekend,
  minutesOf,
  moveDate,
  officeMinutesOfDay,
  todayKey,
} from "./datetime";

export type Booking = {
  id: string;
  roomId: string;
  date: DateKey;
  start: string;
  end: string;
  owner: string;
  team?: string;
  purpose: string;
  /** 예약자 외 참석자. 옛 예약에는 없을 수 있다. */
  attendees?: string[];
  /** 비품 요청 { id: 수량 }. 옛 예약에는 없을 수 있다. */
  equipment?: Record<string, number>;
};

/** "everyday"는 토·일까지 포함해 하루도 빠짐없이 잡는다. */
export type RepeatCycle = "weekly" | "weekdays" | "everyday";

export const teamOf = (booking: Booking) => booking.team || "소속 미입력";

/** 두 시간 구간이 겹치는지. 끝시각과 시작시각이 같은 것은 겹침이 아니다. */
export const overlaps = (
  startA: string,
  endA: string,
  startB: string,
  endB: string,
) => minutesOf(startA) < minutesOf(endB) && minutesOf(endA) > minutesOf(startB);

/**
 * 반복 예약이 실제로 만들 날짜들.
 * "weekdays"는 이름 그대로 주말을 건너뛴다. 규칙에 맞는 날짜가 하나도 없으면
 * 사용자가 직접 고른 시작일만 남긴다.
 */
export function expandRepeatDates(
  startDate: DateKey,
  endDate: DateKey,
  cycle: RepeatCycle,
): DateKey[] {
  if (endDate < startDate) return [startDate];

  const dates: DateKey[] = [];
  const step = cycle === "weekly" ? 7 : 1;
  for (let date = startDate; date <= endDate; date = moveDate(date, step)) {
    if (cycle === "weekdays" && isWeekend(date)) continue;
    dates.push(date);
  }
  return dates.length ? dates : [startDate];
}

/**
 * 주어진 날짜들 가운데 이미 예약이 걸려 있는 날짜.
 * 반복 예약도 전체 회차를 함께 검사하기 위한 함수다.
 */
export function findConflictingDates(
  bookings: Booking[],
  roomId: string,
  dates: DateKey[],
  start: string,
  end: string,
  ignoreBookingId?: string,
): DateKey[] {
  if (minutesOf(end) <= minutesOf(start)) return [];
  const wanted = new Set(dates);
  const hit = new Set<DateKey>();

  for (const booking of bookings) {
    if (booking.roomId !== roomId) continue;
    if (booking.id === ignoreBookingId) continue;
    if (!wanted.has(booking.date)) continue;
    if (overlaps(start, end, booking.start, booking.end)) hit.add(booking.date);
  }

  return dates.filter((date) => hit.has(date));
}

export type PlacedBooking = Booking & { lane: number; laneCount: number };

/** 겹치는 예약을 나란히 놓기 위해 각 예약의 열(lane)을 정한다. */
export function layoutOverlappingBookings(items: Booking[]): PlacedBooking[] {
  const sorted = [...items].sort((a, b) => a.start.localeCompare(b.start));
  const groups: Booking[][] = [];
  let currentGroup: Booking[] = [];
  let groupEnd = -1;

  for (const booking of sorted) {
    if (currentGroup.length && minutesOf(booking.start) >= groupEnd) {
      groups.push(currentGroup);
      currentGroup = [];
      groupEnd = -1;
    }
    currentGroup.push(booking);
    groupEnd = Math.max(groupEnd, minutesOf(booking.end));
  }
  if (currentGroup.length) groups.push(currentGroup);

  return groups.flatMap((group) => {
    const laneEnds: number[] = [];
    const placed = group.map((booking) => {
      const start = minutesOf(booking.start);
      let lane = laneEnds.findIndex((end) => end <= start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = minutesOf(booking.end);
      return { booking, lane };
    });
    return placed.map(({ booking, lane }) => ({
      ...booking,
      lane,
      laneCount: laneEnds.length,
    }));
  });
}

/* --- 시연용 예약 ------------------------------------------------------- */

type SeedWhen = { type: "today" } | { type: "weekday"; index: number };
type SeedBooking = Omit<Booking, "id" | "date"> & { when: SeedWhen };

/**
 * config/seed-bookings.json을 오늘 기준의 실제 날짜로 옮긴다.
 * 백엔드가 붙기 전까지 화면을 채우는 예시 데이터이며, 서버가 생기면 이 함수
 * 대신 서버에서 받아온 예약을 쓰면 된다.
 */
export function createSeedBookings(today: DateKey = todayKey()): Booking[] {
  const workWeek = getWorkWeek(today);

  return (seedBookings as SeedBooking[]).map((seed, index) => {
    const { when, ...rest } = seed;
    const date =
      when.type === "today" ? today : workWeek[when.index] ?? today;
    return { ...rest, id: `seed-${index + 1}`, date };
  });
}

/** 겹치지 않는 예약 식별자. 같은 밀리초에 여러 건을 만들어도 안전하다. */
export function createBookingId(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto?.randomUUID) return `bk-${globalCrypto.randomUUID()}`;
  return `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const bookingDefaults = siteConfig.booking;

/** 예약 가능한 시각 목록. 운영 시간과 단위 시간에서 만든다. */
export const timeOptions: string[] = (() => {
  const options: string[] = [];
  const closing = minutesOf(bookingDefaults.closingTime);
  for (
    let minutes = minutesOf(bookingDefaults.openingTime);
    minutes <= closing;
    minutes += bookingDefaults.slotMinutes
  ) {
    options.push(formatMinutes(minutes));
  }
  return options;
})();

/**
 * 지금 기준으로 가장 가까운 예약 시작 시각.
 * now가 null이면(서버 렌더링) 운영 시작 시각을 쓴다.
 */
export function nearestAvailableSlot(now: Date | null, durationMinutes: number) {
  const opening = minutesOf(bookingDefaults.openingTime);
  const latestStart = minutesOf(bookingDefaults.closingTime) - durationMinutes;

  const date = todayKey(now ?? undefined);
  let startMinutes = opening;

  if (now) {
    const { slotMinutes } = bookingDefaults;
    const rounded = Math.ceil(officeMinutesOfDay(now) / slotMinutes) * slotMinutes;
    startMinutes = Math.max(opening, rounded);
  }

  // 오늘 예약 가능한 시간이 지났어도 날짜는 오늘로 둔다.
  // 화면을 열었을 때 보이는 날짜가 오늘이 아니면 그것부터 헷갈린다.
  // 다음 날로 넘기는 대신 시작 시각만 그날 고를 수 있는 마지막 값으로 당긴다.
  if (startMinutes > latestStart) startMinutes = Math.max(opening, latestStart);

  const start = formatMinutes(startMinutes);
  return { date, start, end: addMinutes(start, durationMinutes) };
}
