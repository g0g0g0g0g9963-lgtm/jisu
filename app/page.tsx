"use client";

import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useState } from "react";

type Floor = 9 | 12;
type Status = "available" | "occupied" | "soon";

type Booking = {
  id: string;
  roomId: string;
  date: string;
  start: string;
  end: string;
  owner: string;
  team?: string;
  purpose: string;
};

type SlotSelection = {
  roomId: string;
  date: string;
  start: string;
  end: string;
};

type SlotDrag = SlotSelection & {
  anchorY: number;
};

type Room = {
  id: string;
  floor: Floor;
  name: string;
  capacity: string;
  location: string;
  equipment: string[];
  status: Status;
  statusLabel: string;
  nextLabel: string;
  mapClass: string;
};

const rooms: Room[] = [
  {
    id: "9-c1",
    floor: 9,
    name: "Conference Room 1",
    capacity: "최대 10명",
    location: "출입구 오른쪽, 중앙",
    equipment: ["프로젝터", "스크린", "화이트보드"],
    status: "available",
    statusLabel: "사용 가능",
    nextLabel: "15:30부터 예약",
    mapClass: "map-9-c1",
  },
  {
    id: "9-c2",
    floor: 9,
    name: "Conference Room 2",
    capacity: "최대 4명",
    location: "출입구 오른쪽, 창가 쪽",
    equipment: ["화이트보드"],
    status: "occupied",
    statusLabel: "사용 중",
    nextLabel: "14:30부터 사용 가능",
    mapClass: "map-9-c2",
  },
  {
    id: "9-c3",
    floor: 9,
    name: "Conference Room 3",
    capacity: "최대 6명",
    location: "Conference Room 2 위쪽",
    equipment: ["프로젝터", "스크린", "화이트보드"],
    status: "soon",
    statusLabel: "곧 예약",
    nextLabel: "10분 후 예약 시작",
    mapClass: "map-9-c3",
  },
  {
    id: "9-c4",
    floor: 9,
    name: "Conference Room 4",
    capacity: "최대 12명",
    location: "북동쪽 창가",
    equipment: ["프로젝터", "스크린"],
    status: "available",
    statusLabel: "사용 가능",
    nextLabel: "오늘 17:00까지 가능",
    mapClass: "map-9-c4",
  },
  {
    id: "12-r1",
    floor: 12,
    name: "회의실 1",
    capacity: "최대 6명",
    location: "출입구 왼쪽, 창가 쪽",
    equipment: ["모니터", "화이트보드"],
    status: "available",
    statusLabel: "사용 가능",
    nextLabel: "16:00부터 예약",
    mapClass: "map-12-r1",
  },
  {
    id: "12-r2",
    floor: 12,
    name: "회의실 2",
    capacity: "최대 4명",
    location: "회의실 1 왼쪽",
    equipment: ["화이트보드"],
    status: "occupied",
    statusLabel: "사용 중",
    nextLabel: "15:00부터 사용 가능",
    mapClass: "map-12-r2",
  },
  {
    id: "12-r3",
    floor: 12,
    name: "회의실 3",
    capacity: "최대 4명",
    location: "서쪽 휴게실 옆",
    equipment: ["TV"],
    status: "available",
    statusLabel: "사용 가능",
    nextLabel: "오늘 18:00까지 가능",
    mapClass: "map-12-r3",
  },
  {
    id: "12-big",
    floor: 12,
    name: "대회의실",
    capacity: "최대 16명",
    location: "서쪽 하단, 문서보관실 옆",
    equipment: ["글라스보드", "대형 모니터"],
    status: "soon",
    statusLabel: "곧 예약",
    nextLabel: "20분 후 예약 시작",
    mapClass: "map-12-big",
  },
];

const todayKey = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
};

const sampleWeek = getWorkWeek(todayKey());

const officeTeams = [
  { name: "법인 대표실", count: 2 },
  { name: "법인 품질관리팀", count: 7 },
  { name: "법인 품질관리(DA)", count: 7 },
  { name: "법인 포렌식", count: 2 },
  { name: "법인 금융본부1", count: 6 },
  { name: "법인 금융본부2", count: 3 },
  { name: "법인 Valuation", count: 2 },
  { name: "법인 국제조세", count: 1 },
  { name: "법인 재무", count: 9 },
  { name: "서울1감사1", count: 17 },
  { name: "서울1FAS1", count: 1 },
  { name: "서울1BSO1", count: 10 },
  { name: "서울1공통1", count: 2 },
  { name: "서울1감사2", count: 4 },
  { name: "서울1기업금융4", count: 7 },
  { name: "서울2세무", count: 15 },
  { name: "서울2GR", count: 9 },
  { name: "서울2공통", count: 2 },
  { name: "서울2회계", count: 11 },
  { name: "서울2PS", count: 2 },
  { name: "서울4감사1-1", count: 12 },
  { name: "서울4감사1-2", count: 8 },
  { name: "서울4감사1-3", count: 14 },
  { name: "서울4공통1", count: 4 },
  { name: "서울4세무2", count: 8 },
  { name: "서울4감사3", count: 11 },
  { name: "서울4감사4", count: 3 },
  { name: "서울4감사5", count: 1 },
  { name: "서울6감사1", count: 19 },
  { name: "서울6감사2", count: 4 },
  { name: "해성BSO", count: 6 },
  { name: "서울 경영기획본부", count: 13 },
];

const sampleTeams: Record<string, string> = {
  김지수: "서울1감사1", 박현우: "서울2세무", 이서연: "서울1BSO1", 정우진: "법인 금융본부1",
  최유진: "서울4감사1-1", 김태호: "서울4감사1-2", 한지민: "법인 재무", 윤서진: "서울 경영기획본부",
  김민정: "서울1감사2", 박서준: "서울4세무2", 이지연: "해성BSO", 최현우: "법인 금융본부2",
  한유진: "서울6감사1", 김다은: "서울2회계", 윤서연: "서울1FAS1", 강지훈: "서울2PS",
  서지민: "서울4감사3", 박지혜: "서울4감사4", 문지호: "법인 Valuation", 이준호: "법인 국제조세",
};

const teamOf = (booking: Booking) => booking.team || sampleTeams[booking.owner] || "소속 미입력";

const initialBookings: Booking[] = [
  { id: "b1", roomId: "9-c1", date: todayKey(), start: "09:30", end: "10:30", owner: "김지수", purpose: "프로젝트 킥오프" },
  { id: "b2", roomId: "9-c1", date: todayKey(), start: "15:30", end: "16:30", owner: "박현우", purpose: "고객 미팅" },
  { id: "b3", roomId: "9-c2", date: todayKey(), start: "13:30", end: "14:30", owner: "이서연", purpose: "주간 회의" },
  { id: "b4", roomId: "9-c3", date: todayKey(), start: "14:00", end: "15:00", owner: "정우진", purpose: "업무 협의" },
  { id: "b5", roomId: "12-r1", date: todayKey(), start: "10:00", end: "11:00", owner: "최유진", purpose: "팀 회의" },
  { id: "b6", roomId: "12-r1", date: todayKey(), start: "16:00", end: "17:00", owner: "김태호", purpose: "교육" },
  { id: "b7", roomId: "12-r2", date: todayKey(), start: "13:00", end: "15:00", owner: "한지민", purpose: "정기 회의" },
  { id: "b8", roomId: "12-big", date: todayKey(), start: "14:30", end: "16:00", owner: "윤서진", purpose: "전사 설명회" },
  { id: "w01", roomId: "9-c1", date: sampleWeek[0], start: "11:00", end: "12:00", owner: "김민정", purpose: "팀 주간회의" },
  { id: "w02", roomId: "9-c1", date: sampleWeek[1], start: "13:00", end: "15:00", owner: "박서준", purpose: "고객 미팅" },
  { id: "w03", roomId: "9-c1", date: sampleWeek[3], start: "09:30", end: "10:30", owner: "이지연", purpose: "프로젝트 점검" },
  { id: "w04", roomId: "9-c1", date: sampleWeek[4], start: "15:00", end: "17:00", owner: "최현우", purpose: "제안서 리뷰" },
  { id: "w05", roomId: "9-c2", date: sampleWeek[0], start: "15:00", end: "17:00", owner: "한유진", purpose: "업무 협의" },
  { id: "w06", roomId: "9-c2", date: sampleWeek[2], start: "10:30", end: "12:00", owner: "김다은", purpose: "신규 고객 검토" },
  { id: "w07", roomId: "9-c3", date: sampleWeek[1], start: "09:00", end: "10:00", owner: "정우진", purpose: "파트 미팅" },
  { id: "w08", roomId: "9-c3", date: sampleWeek[4], start: "13:30", end: "15:30", owner: "윤서연", purpose: "교육 준비" },
  { id: "w09", roomId: "9-c4", date: sampleWeek[2], start: "15:00", end: "16:00", owner: "강지훈", purpose: "1:1 미팅" },
  { id: "w10", roomId: "12-r1", date: sampleWeek[0], start: "11:30", end: "13:30", owner: "최유진", purpose: "본부 운영회의" },
  { id: "w11", roomId: "12-r1", date: sampleWeek[3], start: "14:00", end: "16:00", owner: "김태호", purpose: "외부 미팅" },
  { id: "w12", roomId: "12-r2", date: sampleWeek[1], start: "11:00", end: "12:00", owner: "서지민", purpose: "정기 회의" },
  { id: "w13", roomId: "12-r2", date: sampleWeek[4], start: "15:30", end: "17:30", owner: "박지혜", purpose: "워크숍 준비" },
  { id: "w14", roomId: "12-r3", date: sampleWeek[2], start: "13:00", end: "14:30", owner: "문지호", purpose: "자료 검토" },
  { id: "w15", roomId: "12-big", date: sampleWeek[0], start: "12:00", end: "14:00", owner: "윤서진", purpose: "전사 교육" },
  { id: "w16", roomId: "12-big", date: sampleWeek[3], start: "10:00", end: "12:00", owner: "이준호", purpose: "타운홀 준비" },
];

const timeOptions = Array.from({ length: 23 }, (_, index) => {
  const total = 9 * 60 + index * 30;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
});
const startTimeOptions = timeOptions.slice(0, -1);
const timelineStart = 8 * 60;
const timelineEnd = 18 * 60;
const timelineHours = Array.from({ length: 11 }, (_, index) => 8 + index);

function addMinutes(time: string, minutes: number) {
  const [hour, minute] = time.split(":").map(Number);
  const total = hour * 60 + minute + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function minutesOf(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function layoutOverlappingBookings(items: Booking[]) {
  const sorted = [...items].sort((a, b) => a.start.localeCompare(b.start));
  const groups: Booking[][] = [];
  let currentGroup: Booking[] = [];
  let groupEnd = -1;

  sorted.forEach((booking) => {
    const start = minutesOf(booking.start);
    if (currentGroup.length && start >= groupEnd) {
      groups.push(currentGroup);
      currentGroup = [];
      groupEnd = -1;
    }
    currentGroup.push(booking);
    groupEnd = Math.max(groupEnd, minutesOf(booking.end));
  });
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
    const laneCount = laneEnds.length;
    return placed.map(({ booking, lane }) => ({ ...booking, lane, laneCount }));
  });
}

function equipmentIcon(item: string) {
  if (item.includes("화상")) return "CAM";
  if (item.includes("빔") || item.includes("프로젝터")) return "BEAM";
  if (item.includes("스크린")) return "SCREEN";
  if (item.includes("보드")) return "BOARD";
  if (item.includes("TV") || item.includes("모니터")) return "DISPLAY";
  return "EQ";
}

function formatDate(value: string) {
  if (!value) return "오늘";
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(new Date(`${value}T00:00:00`));
}

function moveDate(value: string, amount: number) {
  const date = new Date(`${value || todayKey()}T00:00:00`);
  date.setDate(date.getDate() + amount);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function getClosestReservationSlot(duration = 60) {
  const now = new Date();
  const openingMinutes = minutesOf(timeOptions[0]);
  const closingMinutes = minutesOf(timeOptions[timeOptions.length - 1]);
  const latestStartMinutes = closingMinutes - duration;
  const roundedMinutes = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30;
  let reservationDate = todayKey();
  let startMinutes = Math.max(openingMinutes, roundedMinutes);

  if (startMinutes > latestStartMinutes) {
    reservationDate = moveDate(reservationDate, 1);
    startMinutes = openingMinutes;
  }

  const start = addMinutes("00:00", startMinutes);
  return { date: reservationDate, start, end: addMinutes(start, duration) };
}

function getWorkWeek(value: string) {
  const selectedDate = new Date(`${value || todayKey()}T00:00:00`);
  const day = selectedDate.getDay();
  if (day !== 0 && day !== 6) selectedDate.setDate(selectedDate.getDate() - day + 1);
  return Array.from({ length: 5 }, (_, index) => {
    const current = new Date(selectedDate);
    current.setDate(selectedDate.getDate() + index);
    const offset = current.getTimezoneOffset() * 60_000;
    return new Date(current.getTime() - offset).toISOString().slice(0, 10);
  });
}

function RoomDetailPopover({
  room,
  date,
  bookings,
  onClose,
  onChoose,
}: {
  room: Room;
  date: string;
  bookings: Booking[];
  onClose: () => void;
  onChoose: () => void;
}) {
  return (
    <section className="room-popover" role="dialog" aria-labelledby="room-popover-title">
      <button className="room-modal-close" type="button" aria-label="회의실 상세 창 닫기" onClick={onClose}>×</button>
      <p className="room-modal-kicker">선택된 회의실</p>
      <div className="modal-room-overview">
        <div className="modal-room-copy">
          <span className={`modal-status ${room.status}`}><i />{room.statusLabel}</span>
          <h3 id="room-popover-title">{room.name} <small>({room.floor}층)</small></h3>
          <p>{room.location}</p>
        </div>
      </div>
      <div className="popover-facts">
        <span><b>수용 인원</b>{room.capacity}</span>
        <span><b>예약 일정</b>{formatDate(date)}</span>
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
      <button className="choose-room-button compact-choose" type="button" onClick={onChoose}>이 회의실 예약하기</button>
    </section>
  );
}

function ReservationHoverCard({ booking, room }: { booking: Booking; room: Room }) {
  return <span className="reservation-hover-card" role="tooltip">
    <strong>{booking.purpose}</strong>
    <span><b>일시</b>{formatDate(booking.date)} · {booking.start}–{booking.end}</span>
    <span><b>회의실</b>{room.name}</span>
    <span><b>예약자</b>{booking.owner} · {teamOf(booking)}</span>
  </span>;
}

export default function Home() {
  const [floor, setFloor] = useState<Floor>(9);
  const [selectedId, setSelectedId] = useState("9-c1");
  const [date, setDate] = useState(todayKey());
  const [scheduleView, setScheduleView] = useState<"week" | "day">("day");
  const [clock, setClock] = useState<Date | null>(null);
  const [query, setQuery] = useState("");
  const [duration, setDuration] = useState(60);
  const [start, setStart] = useState("14:30");
  const [endTime, setEndTime] = useState("15:30");
  const [owner, setOwner] = useState("김지수");
  const [team, setTeam] = useState("서울 경영기획본부");
  const [teamOpen, setTeamOpen] = useState(false);
  const [teamActiveIndex, setTeamActiveIndex] = useState(0);
  const [purpose, setPurpose] = useState("");
  const [bookings, setBookings] = useState(initialBookings);
  const [notice, setNotice] = useState("");
  const [mapDetailId, setMapDetailId] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [allDay, setAllDay] = useState(false);
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [repeatCycle, setRepeatCycle] = useState<"weekly" | "daily">("weekly");
  const [repeatEnd, setRepeatEnd] = useState(() => moveDate(todayKey(), 28));
  const [myBookingsOpen, setMyBookingsOpen] = useState(false);
  const [myBookingOwner, setMyBookingOwner] = useState("");
  const [bookingPanelOpen, setBookingPanelOpen] = useState(false);
  const [slotDrag, setSlotDrag] = useState<SlotDrag | null>(null);
  const [slotConfirmation, setSlotConfirmation] = useState<SlotSelection | null>(null);

  useEffect(() => {
    const now = new Date();
    const closestSlot = getClosestReservationSlot(60);
    setClock(now);
    setDate(closestSlot.date);
    setStart(closestSlot.start);
    setEndTime(closestSlot.end);
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setMyBookingOwner(window.localStorage.getItem("bdo-meeting-owner") || "");
  }, []);

  useEffect(() => {
    if (!mapDetailId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMapDetailId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mapDetailId]);

  const floorRooms = rooms
    .filter((room) => room.floor === floor)
    .sort((a, b) => Number(b.id === "12-big") - Number(a.id === "12-big"));
  const filteredRooms = floorRooms.filter((room) => {
    const haystack = `${room.name} ${room.capacity} ${room.location} ${room.equipment.join(" ")}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });
  const selected = rooms.find((room) => room.id === selectedId) ?? rooms[0];
  const roomBookings = useMemo(
    () => bookings.filter((booking) => booking.roomId === selected.id && booking.date === date).sort((a, b) => a.start.localeCompare(b.start)),
    [bookings, date, selected.id],
  );
  const end = endTime;
  const selectedTimeConflict = minutesOf(end) > minutesOf(start) && roomBookings.some(
    (booking) => minutesOf(start) < minutesOf(booking.end) && minutesOf(end) > minutesOf(booking.start),
  );
  const visibleStartTimeOptions = duration
    ? startTimeOptions.filter((time) => minutesOf(time) + duration <= minutesOf(timeOptions[timeOptions.length - 1]))
    : startTimeOptions;
  const availableCount = floorRooms.filter((room) => room.status === "available").length;
  const occupiedCount = floorRooms.filter((room) => room.status === "occupied").length;
  const weekDays = useMemo(() => getWorkWeek(date), [date]);
  const weekdayFormatter = useMemo(() => new Intl.DateTimeFormat("ko-KR", { weekday: "short" }), []);
  const mapDetail = mapDetailId ? rooms.find((room) => room.id === mapDetailId) ?? null : null;
  const filteredTeams = officeTeams
    .filter((item) => item.name.toLowerCase().includes(team.trim().toLowerCase()))
    .slice(0, 8);
  const mapDetailBookings = mapDetail
    ? bookings.filter((booking) => booking.roomId === mapDetail.id && booking.date === date).sort((a, b) => a.start.localeCompare(b.start))
    : [];
  const currentMinutes = clock ? clock.getHours() * 60 + clock.getMinutes() : null;
  const currentTimePercent = currentMinutes !== null && currentMinutes >= timelineStart && currentMinutes <= timelineEnd
    ? ((currentMinutes - timelineStart) / (timelineEnd - timelineStart)) * 100
    : null;
  const showCurrentTime = currentTimePercent !== null && (scheduleView === "week" ? weekDays.includes(todayKey()) : date === todayKey());
  const repeatCount = useMemo(() => {
    if (!repeatWeekly || repeatEnd < date) return 0;
    const interval = repeatCycle === "weekly" ? 7 : 1;
    const from = new Date(`${date}T00:00:00`).getTime();
    const until = new Date(`${repeatEnd}T00:00:00`).getTime();
    return Math.floor((until - from) / (interval * 86_400_000)) + 1;
  }, [date, repeatCycle, repeatEnd, repeatWeekly]);
  const myBookings = useMemo(() => bookings
    .filter((booking) => myBookingOwner.trim() && booking.owner === myBookingOwner.trim())
    .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)), [bookings, myBookingOwner]);
  const upcomingMyBookings = myBookings.filter((booking) => booking.date >= todayKey());
  const pastMyBookings = myBookings.filter((booking) => booking.date < todayKey()).reverse();

  const selectFloor = (nextFloor: Floor) => {
    setFloor(nextFloor);
    setSelectedId(rooms.find((room) => room.floor === nextFloor)?.id ?? selectedId);
    setMapDetailId(null);
    setNotice("");
  };

  const selectRoom = (room: Room, showMapDetail = false) => {
    setSelectedId(room.id);
    setMapDetailId(showMapDetail ? room.id : null);
    setNotice("");
  };

  const getSlotMinutes = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.999, (event.clientY - bounds.top) / bounds.height));
    return Math.min(Math.max(minutesOf(timeOptions[0]), timelineStart + Math.floor((ratio * (timelineEnd - timelineStart)) / 30) * 30), timelineEnd - 30);
  };

  const slotTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const formatSlotTime = (time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    const meridiem = hour < 12 ? "오전" : "오후";
    const labelHour = hour % 12 || 12;
    return `${meridiem} ${labelHour}시${minute ? ` ${minute}분` : ""}`;
  };

  const startSlotDrag = (room: Room, reservationDate: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const startMinutes = getSlotMinutes(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setSlotConfirmation(null);
    setSlotDrag({ roomId: room.id, date: reservationDate, start: slotTime(startMinutes), end: slotTime(startMinutes + 30), anchorY: event.clientY });
  };

  const updateSlotDrag = (room: Room, reservationDate: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!slotDrag || slotDrag.roomId !== room.id || slotDrag.date !== reservationDate) return;
    const anchorMinutes = minutesOf(slotDrag.start);
    const currentMinutes = getSlotMinutes(event);
    const nextStart = Math.min(anchorMinutes, currentMinutes);
    const nextEnd = Math.max(anchorMinutes, currentMinutes) + 30;
    setSlotDrag({ ...slotDrag, start: slotTime(nextStart), end: slotTime(nextEnd) });
  };

  const finishSlotDrag = (room: Room, reservationDate: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!slotDrag || slotDrag.roomId !== room.id || slotDrag.date !== reservationDate) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const moved = Math.abs(event.clientY - slotDrag.anchorY) >= 8;
    if (moved) setSlotConfirmation({ roomId: room.id, date: reservationDate, start: slotDrag.start, end: slotDrag.end });
    setSlotDrag(null);
  };

  const confirmSlotBooking = () => {
    if (!slotConfirmation) return;
    const minutes = minutesOf(slotConfirmation.end) - minutesOf(slotConfirmation.start);
    setSelectedId(slotConfirmation.roomId);
    setDate(slotConfirmation.date);
    setAllDay(false);
    setDuration([60, 120, 240].includes(minutes) ? minutes : 0);
    setStart(slotConfirmation.start);
    setEndTime(slotConfirmation.end);
    setNotice("");
    setSlotConfirmation(null);
    setBookingPanelOpen(true);
  };

  const changeStart = (nextStart: string) => {
    setAllDay(false);
    setStart(nextStart);
    setEndTime(addMinutes(nextStart, duration || 60));
    setNotice("");
  };

  const changeDuration = (minutes: number) => {
    setAllDay(false);
    const latestStartMinutes = minutesOf(timeOptions[timeOptions.length - 1]) - minutes;
    const nextStart = minutesOf(start) > latestStartMinutes ? addMinutes("00:00", latestStartMinutes) : start;
    setDuration(minutes);
    setStart(nextStart);
    setEndTime(addMinutes(nextStart, minutes));
    setNotice("");
  };

  const changeEnd = (nextEnd: string) => {
    setAllDay(false);
    setEndTime(nextEnd);
    const minutes = minutesOf(nextEnd) - minutesOf(start);
    setDuration([60, 120, 240].includes(minutes) ? minutes : 0);
    setNotice("");
  };

  const submitReservation = (event: FormEvent) => {
    event.preventDefault();
    if (!owner.trim() || !team.trim()) {
      setNotice("예약자 이름과 본부명을 입력해 주세요.");
      return;
    }
    if (!officeTeams.some((item) => item.name === team.trim())) {
      setNotice("검색 목록에서 본부명을 선택해 주세요.");
      setTeamOpen(true);
      return;
    }
    if (minutesOf(end) <= minutesOf(start)) {
      setNotice("종료 시간은 시작 시간보다 늦게 선택해 주세요.");
      return;
    }
    if (selectedTimeConflict) {
      setNotice("선택한 시간에 다른 예약이 있어요. 다른 시간을 선택해 주세요.");
      return;
    }
    const interval = repeatCycle === "weekly" ? 7 : 1;
    const reservationDates = repeatWeekly ? Array.from({ length: Math.max(repeatCount, 1) }, (_, index) => moveDate(date, interval * index)) : [date];
    setBookings((current) => [
      ...current,
      ...reservationDates.map((reservationDate, index) => ({
        id: `booking-${Date.now()}-${index}`,
        roomId: selected.id,
        date: reservationDate,
        start,
        end,
        owner: owner.trim(),
        team: team.trim(),
        purpose: purpose.trim() || "회의",
      })),
    ]);
    setOwner("");
    setMyBookingOwner(owner.trim());
    window.localStorage.setItem("bdo-meeting-owner", owner.trim());
    setTeam("");
    setPurpose("");
    setNotice(repeatWeekly ? `${selected.name} 반복 예약 ${reservationDates.length}회가 완료됐어요.` : `${selected.name} 예약이 완료됐어요. · ${start}–${end}`);
  };

  return (
    <main className={`app-shell ${showMap ? "map-open" : ""}`}>
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand-lockup">
            <img className="bdo-logo" src="/bdo-logo.png" alt="BDO" />
          </div>
          <div className="product-name">
            <p className="eyebrow">SEOUL OFFICE</p>
            <h1>회의실 예약</h1>
          </div>
        </div>
        <div className="header-account">
          <span className="header-user">김지수님</span>
          <button type="button" className="header-my-bookings" onClick={() => setMyBookingsOpen(true)}>내 예약</button>
          <div className="clock-block">
            <strong>{clock ? clock.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: true }) : "--:--"}</strong>
            <span>{clock ? clock.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" }) : "시간 불러오는 중"}</span>
          </div>
        </div>
      </header>

      <section className="toolbar" aria-label="예약 조건 선택">
        <div className="floor-switch" aria-label="층 선택">
          {([9, 12] as Floor[]).map((item) => (
            <button key={item} type="button" className={floor === item ? "active" : ""} onClick={() => selectFloor(item)}>
              {item}층
              <small>{rooms.filter((room) => room.floor === item && room.status === "available").length}개 사용 가능</small>
            </button>
          ))}
        </div>
        <div className="date-switch">
          <button type="button" aria-label="이전 날짜" onClick={() => setDate(moveDate(date, -1))}>‹</button>
          <button type="button" className="date-main" onClick={() => setDate(todayKey())}>
            <span>{date === todayKey() ? "오늘" : "선택 날짜"}</span>
            <strong>{formatDate(date)}</strong>
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
          <em>/ 4개 사용 가능</em>
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
              <i className={room.status} />
              <b>{room.name}</b>
              <span>· 최대 {room.capacity}</span>
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
            {filteredRooms.map((room) => (
              <button
                type="button"
                key={room.id}
                className={`room-card ${selected.id === room.id ? "selected" : ""}`}
                onClick={() => selectRoom(room)}
                aria-pressed={selected.id === room.id}
              >
                <div className="room-card-top">
                  <span className={`status-dot ${room.status}`} />
                  <span className={`status-text ${room.status}`}>{room.statusLabel}</span>
                  <span className="floor-pill">{room.floor}F</span>
                </div>
                <strong>{room.name}</strong>
                <div className="room-meta"><span>{room.capacity}</span><span>{room.equipment[0]}</span></div>
                <p>{room.nextLabel}</p>
              </button>
            ))}
            {filteredRooms.length === 0 && <div className="empty-search">조건에 맞는 회의실이 없어요.</div>}
          </div>
          <div className="legend"><span><i className="available" />사용 가능</span><span><i className="occupied" />사용 중</span><span><i className="soon" />곧 예약</span></div>
        </aside>

        <section className="map-panel">
          <div className="map-week-split">
            {showMap && <div className="map-zone">
              <div className="section-heading map-heading">
                <div><p>FLOOR MAP</p><h2>{floor}층 배치도</h2></div>
                <div className="map-window-actions">
                  <span className="map-tip">회의실을 눌러 설명 보기</span>
                  <button type="button" className="map-window-close" onClick={() => setShowMap(false)} aria-label="배치도 닫기">×</button>
                </div>
              </div>
              <div className={`floor-map floor-${floor}`}>
                <div className="map-entrance">출입구</div>
                {floorRooms.map((room) => (
                  <button
                    type="button"
                    key={room.id}
                    className={`map-room ${room.mapClass} ${room.status} ${selected.id === room.id ? "selected" : ""}`}
                    onClick={() => selectRoom(room, true)}
                    aria-label={`${room.name}, ${room.statusLabel}, ${room.capacity}`}
                    aria-pressed={selected.id === room.id}
                  >
                    <strong>{room.name}</strong>
                    <span className="map-status"><i />{room.statusLabel}</span>
                    <small className="map-capacity">{room.capacity}</small>
                    <small className="map-equipment">{room.equipment.slice(0, 2).join(" · ")}</small>
                    {selected.id === room.id && <b className="selected-check">✓</b>}
                  </button>
                ))}
                {mapDetail && (
                  <RoomDetailPopover
                    room={mapDetail}
                    date={date}
                    bookings={mapDetailBookings}
                    onClose={() => setMapDetailId(null)}
                    onChoose={() => {
                      setMapDetailId(null);
                      setShowMap(false);
                      setBookingPanelOpen(true);
                    }}
                  />
                )}
              </div>
            </div>}
            <section className="weekly-board schedule-design-cards" aria-label={scheduleView === "week" ? `${selected.name} 주간 예약 현황` : `${floor}층 일간 예약 현황`}>
              <div className="weekly-heading">
                <div><p>{scheduleView === "week" ? "WEEKLY SCHEDULE" : "DAILY SCHEDULE"}</p><h3>{scheduleView === "week" ? "주간 예약 현황" : "일간 예약 현황"}</h3></div>
                <div className="schedule-heading-actions">
                  <div className="schedule-view-switch" aria-label="예약 현황 보기 방식">
                    <button type="button" className={scheduleView === "day" ? "active" : ""} onClick={() => setScheduleView("day")}>일간</button>
                    <button type="button" className={scheduleView === "week" ? "active" : ""} onClick={() => setScheduleView("week")}>주간</button>
                  </div>
                  <button type="button" className={`map-toggle ${showMap ? "active" : ""}`} onClick={() => { setTeamOpen(false); setShowMap((current) => !current); }}>
                    {showMap ? "일정 보기" : "배치도 확인"}
                  </button>
                </div>
              </div>
              <div className="schedule-control-bar" aria-label="예약 현황 제어">
                <div className="schedule-floor-switch" aria-label="층 선택">
                  {([9, 12] as Floor[]).map((item) => (
                    <button key={item} type="button" className={floor === item ? "active" : ""} onClick={() => selectFloor(item)}>
                      {item}층
                    </button>
                  ))}
                </div>
                <div className="schedule-date-switch">
                  <button type="button" aria-label="이전 날짜" onClick={() => setDate(moveDate(date, -1))}>‹</button>
                  <button type="button" className={date === todayKey() ? "today" : ""} onClick={() => setDate(todayKey())}>
                    <span>{date === todayKey() ? "오늘" : "선택 날짜"}</span><strong>{formatDate(date)}</strong>
                  </button>
                  <button type="button" aria-label="다음 날짜" onClick={() => setDate(moveDate(date, 1))}>›</button>
                  <label className="schedule-calendar-picker" aria-label="날짜 선택">
                    <span className="calendar-mark" aria-hidden="true" />
                    <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
                  </label>
                </div>
                <div className="schedule-availability-group">
                  <span className="schedule-availability"><i />현재 사용 중 {occupiedCount} / {floorRooms.length}</span>
                </div>
                {scheduleView === "day" && <span className="schedule-drag-hint">↕ 빈 시간대 드래그 예약</span>}
              </div>
              {false && <div className="schedule-room-strip" aria-label={`${floor}층 회의실 선택`}>
                <div className="schedule-room-buttons">
                  {floorRooms.map((room) => (
                    <button
                      key={room.id}
                      type="button"
                      className={`schedule-room-button ${room.status} ${selected.id === room.id ? "selected" : ""}`}
                      onClick={() => selectRoom(room)}
                      aria-pressed={selected.id === room.id}
                    >
                      <i aria-hidden="true" />
                      <span className={`schedule-room-status ${room.status}`}>{room.statusLabel}</span>
                      <b>{room.name}</b>
                      <span className="schedule-room-capacity">{room.capacity}</span>
                    </button>
                  ))}
                </div>
              </div>}
              {false && scheduleView === "day" && (
                <div className="daily-date-nav">
                  <button type="button" aria-label="이전 날짜" onClick={() => setDate(moveDate(date, -1))}>‹</button>
                  <button type="button" className={date === todayKey() ? "today" : ""} onClick={() => setDate(todayKey())}>
                    <span>{date === todayKey() ? "오늘" : "오늘로 이동"}</span><strong>{formatDate(date)}</strong>
                  </button>
                  <button type="button" aria-label="다음 날짜" onClick={() => setDate(moveDate(date, 1))}>›</button>
                </div>
              )}
              {scheduleView === "day" && <div className="week-timeline daily-timeline">
                <div className="time-axis">
                  <span className="axis-corner">시간</span>
                  <div className="time-axis-body">
                    {timelineHours.map((hour) => <time key={hour} style={{ top: `${((hour * 60 - timelineStart) / (timelineEnd - timelineStart)) * 100}%` }}>{String(hour).padStart(2, "0")}:00</time>)}
                    {showCurrentTime && clock && (
                      <strong className="current-time-label" style={{ top: `${currentTimePercent}%` }}>{clock.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}</strong>
                    )}
                  </div>
                </div>
                {scheduleView === "week" ? weekDays.map((day) => {
                  const dailyBookings = bookings
                    .filter((booking) => booking.roomId === selected.id && booking.date === day)
                    .sort((a, b) => a.start.localeCompare(b.start));
                  const dayDate = new Date(`${day}T00:00:00`);
                  const isToday = todayKey() === day;
                  return (
                    <div className={`timeline-day ${date === day ? "active" : ""} ${isToday ? "today" : ""}`} key={day}>
                      <button type="button" className={`timeline-day-head ${isToday ? "today" : ""}`} onClick={() => setDate(day)}>
                        <b>{weekdayFormatter.format(dayDate)}</b><strong>{dayDate.getDate()}</strong>
                      </button>
                      <div className="timeline-day-body" onClick={() => setDate(day)}>
                        {showCurrentTime && <span className="current-time-line" style={{ top: `${currentTimePercent}%` }} />}
                        {dailyBookings.map((booking, index) => {
                          const bookingStart = Math.max(timelineStart, minutesOf(booking.start));
                          const bookingEnd = Math.min(timelineEnd, minutesOf(booking.end));
                          const top = ((bookingStart - timelineStart) / (timelineEnd - timelineStart)) * 100;
                          const height = Math.max(((bookingEnd - bookingStart) / (timelineEnd - timelineStart)) * 100, 6.5);
                          return (
                            <button
                              type="button"
                              className={`timeline-event tone-${index % 3}`}
                              key={booking.id}
                              style={{ top: `${top}%`, height: `${height}%` }}
                              title={`${booking.start}–${booking.end} ${booking.purpose} / ${booking.owner} · ${teamOf(booking)}`}
                              onClick={(event) => { event.stopPropagation(); setDate(day); }}
                            >
                              <time>{booking.start}–{booking.end}</time>
                              <strong>{booking.purpose}</strong>
                              <small>{booking.owner} · {teamOf(booking)}</small>
                              <ReservationHoverCard booking={booking} room={selected} />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                }) : floorRooms.map((room) => {
                  const dailyBookings = layoutOverlappingBookings(
                    bookings.filter((booking) => booking.roomId === room.id && booking.date === date),
                  );
                  return (
                    <div className={`timeline-day daily-room ${selected.id === room.id ? "active" : ""}`} key={room.id}>
                      <button type="button" className="timeline-day-head daily-room-head" onClick={() => { setSelectedId(room.id); setMapDetailId(null); }}>
                        <strong>{room.name}</strong>
                        <span className={`daily-room-meta ${room.status}`}><i className={`room-status-dot ${room.status}`} /><b>{room.statusLabel}</b><em>·</em>{room.capacity}</span>
                      </button>
                      <div
                        className="timeline-day-body"
                        onPointerDown={(event) => startSlotDrag(room, date, event)}
                        onPointerMove={(event) => updateSlotDrag(room, date, event)}
                        onPointerUp={(event) => finishSlotDrag(room, date, event)}
                        onPointerCancel={() => setSlotDrag(null)}
                      >
                        {showCurrentTime && <span className="current-time-line" style={{ top: `${currentTimePercent}%` }} />}
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
                        {dailyBookings.map((booking, index) => {
                          const bookingStart = Math.max(timelineStart, minutesOf(booking.start));
                          const bookingEnd = Math.min(timelineEnd, minutesOf(booking.end));
                          const top = ((bookingStart - timelineStart) / (timelineEnd - timelineStart)) * 100;
                          const height = Math.max(((bookingEnd - bookingStart) / (timelineEnd - timelineStart)) * 100, 6.5);
                          const leftEdge = booking.lane === 0 ? 7 : 3;
                          const rightEdge = booking.lane === booking.laneCount - 1 ? 7 : 3;
                          const left = `calc(${(booking.lane / booking.laneCount) * 100}% + ${leftEdge}px)`;
                          const right = `calc(${((booking.laneCount - booking.lane - 1) / booking.laneCount) * 100}% + ${rightEdge}px)`;
                          return (
                            <button
                              type="button"
                              className={`timeline-event tone-${index % 3}`}
                              key={booking.id}
                              style={{ top: `${top}%`, height: `${height}%`, left, right }}
                              title={`${booking.start}–${booking.end} ${booking.purpose} / ${booking.owner} · ${teamOf(booking)}`}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => { event.stopPropagation(); setSelectedId(room.id); }}
                            >
                              <time>{booking.start}–{booking.end}</time>
                              <strong>{booking.purpose}</strong>
                              <small>{booking.owner} · {teamOf(booking)}</small>
                              <ReservationHoverCard booking={booking} room={room} />
                            </button>
                          );
                        })}
                        {slotConfirmation?.roomId === room.id && slotConfirmation.date === date && (
                          <div className="slot-confirmation" role="dialog" aria-label="선택 시간 예약 확인" onPointerDown={(event) => event.stopPropagation()}>
                            <strong>{formatSlotTime(slotConfirmation.start)}~{formatSlotTime(slotConfirmation.end)}</strong>
                            <span>까지 예약할까요?</span>
                            <div><button type="button" onClick={() => setSlotConfirmation(null)}>취소</button><button type="button" onClick={confirmSlotBooking}>예약하기</button></div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>}
              {scheduleView === "week" && <div className="weekly-room-board" aria-label={`${floor}층 회의실별 주간 예약 현황`}>
                <div className="weekly-room-head weekly-room-corner">회의실</div>
                {weekDays.map((day) => {
                  const dayDate = new Date(`${day}T00:00:00`);
                  return <button type="button" className={`weekly-room-head ${day === date ? "active" : ""}`} key={day} onClick={() => setDate(day)}><b>{weekdayFormatter.format(dayDate)}</b><span>{dayDate.getDate()}</span></button>;
                })}
                {floorRooms.map((room) => <div className="weekly-room-row" key={room.id}>
                  <button type="button" className={`weekly-room-name ${selected.id === room.id ? "selected" : ""}`} onClick={() => { setSelectedId(room.id); setMapDetailId(null); }}><span className="weekly-room-title">{room.name}</span><small className={room.status}><i className={`room-status-dot ${room.status}`} /><b>{room.statusLabel}</b><em>·</em>{room.capacity}</small></button>
                  {weekDays.map((day) => {
                    const roomBookings = bookings.filter((booking) => booking.roomId === room.id && booking.date === day).sort((a, b) => a.start.localeCompare(b.start));
                    return <div className={`weekly-room-cell ${day === date ? "active" : ""}`} key={`${room.id}-${day}`}>
                      {roomBookings.map((booking, index) => <button type="button" className={`weekly-room-event tone-${index % 3}`} key={booking.id} onClick={() => { setSelectedId(room.id); setDate(day); }}><time>{booking.start}–{booking.end}</time><b>{booking.purpose}</b><ReservationHoverCard booking={booking} room={room} /></button>)}
                    </div>;
                  })}
                </div>)}
              </div>}
            </section>
          </div>
        </section>

        {bookingPanelOpen && <div className="booking-modal-backdrop" role="presentation" onMouseDown={() => setBookingPanelOpen(false)} />}
        <aside className={`booking-panel ${bookingPanelOpen ? "booking-panel-modal" : ""}`} id="quick-booking">
          <div className="booking-title">
            <div><p>QUICK BOOKING</p><h2>빠른 예약</h2></div>
            <span>{selected.floor}F</span>
            {bookingPanelOpen && <button type="button" className="booking-modal-close" aria-label="예약창 닫기" onClick={() => setBookingPanelOpen(false)}>×</button>}
          </div>
          <div className="selected-room-summary">
            <div className="summary-title"><span className={`status-dot ${selected.status}`} /><strong>{selected.name}</strong></div>
            <p>{selected.location}</p>
            <div className="spec-row"><span>{selected.capacity}</span>{selected.equipment.map((item) => <span key={item}>{item}</span>)}</div>
          </div>

          <form onSubmit={submitReservation}>
            <label className="field-label">예약 날짜</label>
            <input className="date-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />

            <div className="form-row">
              <label><span className="field-label">시작 시간</span><select value={start} onChange={(event) => changeStart(event.target.value)}>{visibleStartTimeOptions.map((time) => <option key={time}>{time}</option>)}</select></label>
              <label><span className="field-label">종료 시간</span><select value={end} onChange={(event) => changeEnd(event.target.value)}>{timeOptions.map((time) => <option key={time}>{time}</option>)}</select></label>
            </div>

            <span className="field-label">이용 시간</span>
            <div className="duration-switch">
              {[60, 120, 240].map((value) => <button key={value} type="button" className={duration === value ? "active" : ""} onClick={() => changeDuration(value)}>{value / 60}시간</button>)}
              <button type="button" className={allDay ? "active" : ""} onClick={() => {
                setAllDay(true);
                setDuration(0);
                setStart("09:00");
                setEndTime("18:00");
                setNotice("");
              }}>종일</button>
            </div>

            <label className="repeat-option">
              <input type="checkbox" checked={repeatWeekly} onChange={(event) => {
                setRepeatWeekly(event.target.checked);
                if (repeatEnd < date) setRepeatEnd(moveDate(date, 28));
              }} />
              <span><b>반복 예약</b><small>매주 같은 요일과 시간</small></span>
            </label>
            {repeatWeekly && <div className="repeat-settings">
              <span className="field-label">반복 주기</span>
              <div className="repeat-cycle-switch">
                <button type="button" className={repeatCycle === "weekly" ? "active" : ""} onClick={() => setRepeatCycle("weekly")}>매주</button>
                <button type="button" className={repeatCycle === "daily" ? "active" : ""} onClick={() => setRepeatCycle("daily")}>매일 (평일)</button>
              </div>
              <label><span className="field-label">반복 종료 날짜</span><input type="date" value={repeatEnd} min={date} onChange={(event) => setRepeatEnd(event.target.value)} /></label>
              <p>총 <b>{repeatCount}</b>회 예약됩니다.</p>
            </div>}

            <label><span className="field-label">예약자 이름</span><input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="이름을 입력하세요" /></label>
            <div className={`team-field ${teamOpen ? "open" : ""}`}>
              <label>
                <span className="field-label">본부명</span>
                <input
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
                      event.preventDefault();
                      setTeam(filteredTeams[teamActiveIndex].name);
                      setTeamOpen(false);
                    } else if (event.key === "Escape") {
                      setTeamOpen(false);
                    }
                  }}
                  placeholder="본부명을 검색하세요"
                />
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
                      }}
                    >
                      <span>{item.name}</span>
                    </button>
                  )) : <p>검색 결과가 없습니다.</p>}
                </div>
              )}
            </div>
            <label><span className="field-label">회의 목적 <em>(선택)</em></span><input value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="예: 주간회의" /></label>

            {notice && <div className={`notice ${notice.includes("완료") ? "success" : "error"}`}>{notice}</div>}
            {selectedTimeConflict && !notice && <div className="notice error">이미 예약된 시간입니다. 다른 시간을 선택해 주세요.</div>}
            <button className="reserve-button" type="submit" disabled={selectedTimeConflict}>
              <span>{selected.name}</span>
              <strong>{selectedTimeConflict ? "이미 예약된 시간입니다" : `${start}–${end} 예약하기`}</strong>
            </button>
          </form>
        </aside>
      </section>
      {myBookingsOpen && <div className="my-bookings-backdrop" role="presentation" onMouseDown={() => setMyBookingsOpen(false)}>
        <section className="my-bookings-dialog" role="dialog" aria-modal="true" aria-labelledby="my-bookings-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="my-bookings-dialog-head"><div><p>MY RESERVATIONS</p><h2 id="my-bookings-title">내 예약</h2></div><button type="button" onClick={() => setMyBookingsOpen(false)} aria-label="내 예약 닫기">×</button></div>
          <label className="my-bookings-search"><span>예약자 이름</span><input value={myBookingOwner} onChange={(event) => setMyBookingOwner(event.target.value)} placeholder="예약자 이름을 입력하세요" /></label>
          <div className="my-bookings-columns">
            <div><h3>예정 예약 <b>{upcomingMyBookings.length}</b></h3>{upcomingMyBookings.length ? upcomingMyBookings.map((booking) => <article key={booking.id}><time>{formatDate(booking.date)} · {booking.start}–{booking.end}</time><strong>{rooms.find((room) => room.id === booking.roomId)?.name}</strong><span>{booking.purpose} · {booking.team}</span></article>) : <p>예정된 예약이 없습니다.</p>}</div>
            <div><h3>지난 예약 <b>{pastMyBookings.length}</b></h3>{pastMyBookings.length ? pastMyBookings.map((booking) => <article key={booking.id}><time>{formatDate(booking.date)} · {booking.start}–{booking.end}</time><strong>{rooms.find((room) => room.id === booking.roomId)?.name}</strong><span>{booking.purpose} · {booking.team}</span></article>) : <p>지난 예약이 없습니다.</p>}</div>
          </div>
        </section>
      </div>}
      <footer><span>※ 수용 인원과 장비 정보는 시제품용이며 관리자 설정에서 수정할 수 있습니다.</span><strong>사내 회의실 예약 시스템 · Prototype</strong></footer>
    </main>
  );
}
