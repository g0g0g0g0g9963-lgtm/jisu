/** 회의실 목록과, 실제 예약에서 계산하는 사용 현황. */
import roomsConfig from "../config/rooms.json";
import siteConfig from "../config/site.json";
import type { Booking } from "./bookings";
import { minutesOf } from "./datetime";

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
export type RoomStatus = "available" | "occupied" | "soon" | "unknown";

export type RoomStatusInfo = {
  status: RoomStatus;
  statusLabel: string;
  nextLabel: string;
};

const { closingTime, soonThresholdMinutes } = siteConfig.booking;

/**
 * 예약과 현재 시각으로 회의실 상태를 계산한다.
 * nowMinutes가 null이면(브라우저에서 시계를 읽기 전) 아직 모른다고 표시한다.
 * 추측해서 "사용 가능"으로 보여주면 실제와 다를 수 있기 때문이다.
 *
 * nowMinutes를 넘기지 않으면(=오늘이 아닌 날을 보고 있으면) '지금'이라는
 * 개념이 없다. 그때 "사용 가능"이라고 하면 오늘 기준 상태를 다른 날짜
 * 화면에 붙여 놓는 셈이라 틀린 정보가 된다. 그 날짜의 예약 건수를 말한다.
 */
export function describeRoomStatus(
  todaysBookings: Booking[],
  nowMinutes: number | null,
  options?: { isToday?: boolean },
): RoomStatusInfo {
  if (options && options.isToday === false) {
    const count = todaysBookings.length;
    return count === 0
      ? { status: "available", statusLabel: "사용 가능", nextLabel: "하루 종일 예약이 없습니다" }
      : {
        status: "occupied",
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
    // '언제 기준인지'를 문구에 넣는다. 그냥 "사용 가능"이면 지금인지
    // 오늘 하루인지 알 수 없어 정보가 아니라 장식이 된다.
    statusLabel: nowMinutes >= minutesOf(closingTime) ? "오늘 마감" : "지금 사용 가능",
    nextLabel:
      nowMinutes >= minutesOf(closingTime)
        ? "오늘 예약 마감"
        : `오늘 ${closingTime}까지 가능`,
  };
}

export function equipmentIcon(item: string) {
  if (item.includes("화상")) return "CAM";
  if (item.includes("빔") || item.includes("프로젝터")) return "BEAM";
  if (item.includes("스크린")) return "SCREEN";
  if (item.includes("보드")) return "BOARD";
  if (item.includes("TV") || item.includes("모니터")) return "DISPLAY";
  return "EQ";
}
