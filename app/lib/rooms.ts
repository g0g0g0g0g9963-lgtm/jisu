/** 회의실 목록과, 실제 예약에서 계산하는 사용 현황. */
import roomsConfig from "../config/rooms.json";
import siteConfig from "../config/site.json";
import type { Booking } from "./bookings";
import { minutesOf, type DateKey } from "./datetime";

export type Room = {
  id: string;
  floor: number;
  name: string;
  capacity: number;
  location: string;
  equipment: string[];
  mapClass: string;
};

export const rooms: Room[] = roomsConfig;

export const floors: number[] = [...new Set(rooms.map((room) => room.floor))].sort(
  (a, b) => a - b,
);

export const roomById = (id: string) => rooms.find((room) => room.id === id);

export const formatCapacity = (capacity: number) => `최대 ${capacity}명`;

/** "unknown"은 아직 현재 시각을 모르는 첫 렌더 시점에만 쓴다. */
export type RoomStatus = "available" | "occupied" | "soon" | "reserved" | "closed" | "unknown";

export type RoomStatusInfo = {
  status: RoomStatus;
  statusLabel: string;
  nextLabel: string;
};

const { openingTime, closingTime, slotMinutes, soonThresholdMinutes } = siteConfig.booking;

/**
 * 예약과 현재 시각으로 회의실 상태를 계산한다.
 * nowMinutes가 null이면(브라우저에서 시계를 읽기 전) 아직 모른다고 표시한다.
 * 추측해서 "사용 가능"으로 보여주면 실제와 다를 수 있기 때문이다.
 *
 * 오늘이 아닌 날짜는 실시간 점유가 아니라 예약 건수를 표시한다.
 * reserved는 일부 예약이 있다는 뜻이며, 그날 전체 또는 선택 시간이
 * 예약 불가라는 뜻이 아니다. 선택 시간의 가능 여부는 별도로 계산한다.
 */
export function describeRoomStatus(
  todaysBookings: Booking[],
  nowMinutes: number | null,
  options?: { isToday?: boolean; isPast?: boolean },
): RoomStatusInfo {
  if (options?.isPast) {
    return { status: "closed", statusLabel: "지난 날짜", nextLabel: "지난 날짜에는 새로 예약할 수 없습니다." };
  }
  if (options && options.isToday === false) {
    const count = todaysBookings.length;
    return count === 0
      ? { status: "available", statusLabel: "예약 없음", nextLabel: "하루 종일 예약이 없습니다" }
      : {
        status: "reserved",
        statusLabel: `예약 ${count}건`,
        nextLabel: [...todaysBookings]
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((booking) => `${booking.start}–${booking.end}`)
          .slice(0, 2)
          .join(", "),
      };
  }

  if (nowMinutes === null) {
    return { status: "unknown", statusLabel: "확인 중", nextLabel: "현황 불러오는 중" };
  }

  if (nowMinutes < minutesOf(openingTime)) {
    return { status: "closed", statusLabel: "운영 전", nextLabel: `${openingTime}부터 이용할 수 있습니다.` };
  }

  if (nowMinutes >= minutesOf(closingTime)) {
    return { status: "closed", statusLabel: "오늘 마감", nextLabel: "오늘 예약 마감" };
  }

  const sorted = [...todaysBookings].sort((a, b) => a.start.localeCompare(b.start));
  const current = sorted.find(
    (booking) =>
      minutesOf(booking.start) <= nowMinutes && nowMinutes < minutesOf(booking.end),
  );

  if (current) {
    // 뒤에 바로 이어지는 예약이 있으면 그 끝까지가 실제로 비는 시각이다.
    let freeFrom = current.end;
    for (const booking of sorted) {
      if (booking.start === freeFrom) freeFrom = booking.end;
    }
    return {
      status: "occupied",
      statusLabel: "사용 중",
      nextLabel: `${freeFrom}부터 사용 가능`,
    };
  }

  const upcoming = sorted.find((booking) => minutesOf(booking.start) > nowMinutes);

  if (upcoming) {
    const minutesUntil = minutesOf(upcoming.start) - nowMinutes;
    if (minutesUntil <= soonThresholdMinutes) {
      return {
        status: "soon",
        statusLabel: "곧 예약",
        nextLabel: `${minutesUntil}분 후 예약 시작`,
      };
    }
    return {
      status: "available",
      statusLabel: "지금 사용 가능",
      nextLabel: `${upcoming.start}부터 예약`,
    };
  }

  return {
    status: "available",
    statusLabel: "지금 사용 가능",
    nextLabel: `오늘 ${closingTime}까지 가능`,
  };
}

export type RoomSlotAvailability = "available" | "conflict" | "past" | "outside-hours" | "invalid" | "unknown";

export type RoomSlotAvailabilityInfo = {
  status: RoomSlotAvailability;
  available: boolean;
  statusLabel: string;
  nextLabel: string;
};

/** 현재 점유와 독립적으로, 해당 회의실의 선택 날짜·시간만 판단한다. */
export function describeRoomSlotAvailability(
  bookingsForRoom: Booking[],
  date: DateKey,
  start: string,
  end: string,
  options: { today: DateKey; nowMinutes: number | null },
): RoomSlotAvailabilityInfo {
  const startMinutes = minutesOf(start);
  const endMinutes = minutesOf(end);
  const validTime = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  const dateValue = new Date(`${date}T00:00:00Z`);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(dateValue.getTime()) && dateValue.toISOString().slice(0, 10) === date;
  if (!validDate || !validTime(start) || !(validTime(end) || end === "24:00") || endMinutes <= startMinutes) {
    return { status: "invalid", available: false, statusLabel: "날짜·시간 확인 필요", nextLabel: "예약 날짜와 시작·종료 시간을 확인해 주세요." };
  }
  if (date < options.today || (date === options.today && options.nowMinutes !== null && startMinutes < options.nowMinutes)) {
    return { status: "past", available: false, statusLabel: "지난 날짜·시간", nextLabel: "앞으로의 날짜와 시간을 선택해 주세요." };
  }
  if (startMinutes < minutesOf(openingTime) || endMinutes > minutesOf(closingTime)) {
    return { status: "outside-hours", available: false, statusLabel: "운영 시간 밖", nextLabel: `${openingTime}–${closingTime} 사이에서 선택해 주세요.` };
  }
  if ((startMinutes - minutesOf(openingTime)) % slotMinutes !== 0 || (endMinutes - minutesOf(openingTime)) % slotMinutes !== 0) {
    return { status: "invalid", available: false, statusLabel: "시간 단위 확인 필요", nextLabel: `${slotMinutes}분 단위로 시간을 선택해 주세요.` };
  }
  if (date === options.today && options.nowMinutes === null) {
    return { status: "unknown", available: false, statusLabel: "확인 중", nextLabel: "현재 시간을 확인하고 있습니다." };
  }
  if (bookingsForRoom.some((booking) => booking.date === date && minutesOf(booking.start) < endMinutes && minutesOf(booking.end) > startMinutes)) {
    return { status: "conflict", available: false, statusLabel: "선택 시간 예약 겹침", nextLabel: "다른 시간이나 회의실을 선택해 주세요." };
  }
  return { status: "available", available: true, statusLabel: "선택 시간 예약 가능", nextLabel: `${start}–${end}에 예약할 수 있습니다.` };
}

export function equipmentIcon(item: string) {
  if (item.includes("화상")) return "CAM";
  if (item.includes("빔") || item.includes("프로젝터")) return "BEAM";
  if (item.includes("스크린")) return "SCREEN";
  if (item.includes("보드")) return "BOARD";
  if (item.includes("TV") || item.includes("모니터")) return "DISPLAY";
  return "EQ";
}
