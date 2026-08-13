"use client";

import { FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useState } from "react";
import siteConfig from "./config/site.json";
import officeTeams from "./config/teams.json";
import { type CurrentUser, deleteBookingRequest, fetchBookings, fetchMe, postBookings } from "./lib/api";
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
  formatFullDate,
  formatMinutes,
  formatSpokenTime,
  formatWallClock,
  formatWeekday,
  getWorkWeek,
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

function RoomDetailPopover({
  room,
  status,
  date,
  bookings,
  onClose,
  onChoose,
}: {
  room: Room;
  status: RoomStatusInfo;
  date: DateKey;
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
      <button className="choose-room-button compact-choose" type="button" onClick={onChoose}>이 회의실 예약하기</button>
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
  const [owner, setOwner] = useState("");
  const [team, setTeam] = useState("");
  const [teamOpen, setTeamOpen] = useState(false);
  const [teamActiveIndex, setTeamActiveIndex] = useState(0);
  const [purpose, setPurpose] = useState("");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [notice, setNotice] = useState("");
  const [syncError, setSyncError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // SSO 모드에서는 로그인 계정이 예약자다. null이면 익명 모드(이름 직접 입력).
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [mapDetailId, setMapDetailId] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [allDay, setAllDay] = useState(false);
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [repeatCycle, setRepeatCycle] = useState<RepeatCycle>("weekly");
  const [repeatEnd, setRepeatEnd] = useState(() =>
    moveDate(todayKey(clock ?? undefined), bookingDefaults.defaultRepeatSpanDays),
  );
  const [myBookingsOpen, setMyBookingsOpen] = useState(false);
  const [myBookingOwner, setMyBookingOwner] = useStoredText(OWNER_STORAGE_KEY);
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null);
  const [bookingPanelOpen, setBookingPanelOpen] = useState(false);
  const [slotDrag, setSlotDrag] = useState<SlotDrag | null>(null);
  const [slotConfirmation, setSlotConfirmation] = useState<SlotSelection | null>(null);

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
  const roomStatuses = useMemo(() => {
    const todaysByRoom = new Map<string, Booking[]>();
    for (const booking of bookings) {
      if (booking.date !== today) continue;
      const list = todaysByRoom.get(booking.roomId);
      if (list) list.push(booking);
      else todaysByRoom.set(booking.roomId, [booking]);
    }
    return new Map(
      rooms.map((room) => [
        room.id,
        describeRoomStatus(todaysByRoom.get(room.id) ?? [], nowMinutes),
      ]),
    );
  }, [bookings, today, nowMinutes]);

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
  const occupiedCount = floorRooms.filter((room) => statusOf(room).status === "occupied").length;
  const weekDays = useMemo(() => getWorkWeek(date), [date]);
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
  const myBookings = useMemo(() => bookings
    .filter((booking) => myBookingOwner.trim() && booking.owner === myBookingOwner.trim())
    .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)), [bookings, myBookingOwner]);
  const upcomingMyBookings = myBookings.filter((booking) => booking.date >= today);
  const pastMyBookings = myBookings.filter((booking) => booking.date < today).reverse();

  const selectFloor = (nextFloor: number) => {
    setFloor(nextFloor);
    setSelectedId(rooms.find((room) => room.floor === nextFloor)?.id ?? selectedId);
    setMapDetailId(null);
    setNotice("");
  };

  const selectRoom = (room: Room, showMapDetail = false) => {
    setSelectedId(room.id);
    // 다른 층 회의실을 고르면 일정표도 그 층으로 따라간다.
    setFloor(room.floor);
    setMapDetailId(showMapDetail ? room.id : null);
    setNotice("");
  };

  const cancelBooking = async (bookingId: string) => {
    const result = await deleteBookingRequest(bookingId, myBookingOwner.trim());
    setPendingCancelId(null);
    await refreshBookings();
    // 새로고침이 성공하면 syncError가 비워지므로, 취소 실패 메시지는 그 뒤에 얹는다.
    if (!result.ok) setSyncError(result.message);
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

  const confirmSlotBooking = () => {
    if (!slotConfirmation) return;
    const minutes = minutesOf(slotConfirmation.end) - minutesOf(slotConfirmation.start);
    setSelectedId(slotConfirmation.roomId);
    setAllDay(false);
    setDuration(bookingDefaults.durationPresetsMinutes.includes(minutes) ? minutes : 0);
    setSlot({ date: slotConfirmation.date, start: slotConfirmation.start, end: slotConfirmation.end });
    setNotice("");
    setSlotConfirmation(null);
    setBookingPanelOpen(true);
  };

  const changeStart = (nextStart: string) => {
    setAllDay(false);
    setSlot((current) => ({
      ...current,
      start: nextStart,
      end: addMinutes(nextStart, duration || bookingDefaults.defaultDurationMinutes),
    }));
    setNotice("");
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
  };

  const changeEnd = (nextEnd: string) => {
    setAllDay(false);
    setSlot((current) => ({ ...current, end: nextEnd }));
    const minutes = minutesOf(nextEnd) - minutesOf(start);
    setDuration(bookingDefaults.durationPresetsMinutes.includes(minutes) ? minutes : 0);
    setNotice("");
  };

  const selectAllDay = () => {
    setAllDay(true);
    setDuration(0);
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
    if (conflictDates.length) {
      setNotice(
        conflictDates.length === 1
          ? `${formatDateLabel(conflictDates[0])}에 이미 예약이 있어요. 다른 시간을 선택해 주세요.`
          : `${conflictDates.length}개 날짜(${formatDateLabel(conflictDates[0])} 외)에 이미 예약이 있어요. 다른 시간을 선택해 주세요.`,
      );
      return;
    }

    const ownerName = owner.trim();
    const teamName = team.trim();
    setSubmitting(true);
    const result = await postBookings({
      roomId: selected.id,
      dates: reservationDates,
      start,
      end,
      owner: ownerName,
      team: teamName,
      purpose: purpose.trim() || "회의",
    });
    setSubmitting(false);

    if (!result.ok) {
      // 동시에 다른 사람이 먼저 잡았을 수 있다. 서버 판정을 보여주고 최신 상태로 맞춘다.
      setNotice(result.message);
      await refreshBookings();
      return;
    }

    setMyBookingOwner(ownerName);
    setPurpose("");
    setNotice(
      reservationDates.length > 1
        ? `${selected.name} 반복 예약 ${reservationDates.length}회가 완료됐어요.`
        : `${selected.name} 예약이 완료됐어요. · ${start}–${end}`,
    );
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
          <button type="button" className="header-my-bookings" onClick={() => setMyBookingsOpen(true)}>내 예약</button>
          <div className="clock-block">
            <strong>{clock ? formatWallClock(clock) : "--:--"}</strong>
            <span>{clock ? formatFullDate(clock) : "시간 불러오는 중"}</span>
          </div>
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
                <button
                  type="button"
                  key={room.id}
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
              );
            })}
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
                {floorRooms.map((room) => {
                  const status = statusOf(room);
                  return (
                    <button
                      type="button"
                      key={room.id}
                      className={`map-room ${room.mapClass} ${status.status} ${selected.id === room.id ? "selected" : ""}`}
                      onClick={() => selectRoom(room, true)}
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
                {mapDetail && (
                  <RoomDetailPopover
                    room={mapDetail}
                    status={statusOf(mapDetail)}
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
                  {floors.map((item) => (
                    <button key={item} type="button" className={floor === item ? "active" : ""} onClick={() => selectFloor(item)}>
                      {item}층
                    </button>
                  ))}
                </div>
                <div className="schedule-date-switch">
                  <button type="button" aria-label="이전 날짜" onClick={() => setDate(moveDate(date, -1))}>‹</button>
                  <button type="button" className={date === today ? "today" : ""} onClick={() => setDate(today)}>
                    <span>{date === today ? "오늘" : "선택 날짜"}</span><strong>{formatDateLabel(date)}</strong>
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
              {scheduleView === "day" && <div className="week-timeline daily-timeline">
                <div className="time-axis">
                  <span className="axis-corner">시간</span>
                  <div className="time-axis-body">
                    {timelineHours.map((hour) => <time key={hour} style={{ top: `${((hour * 60 - timelineStart) / (timelineEnd - timelineStart)) * 100}%` }}>{String(hour).padStart(2, "0")}:00</time>)}
                    {showCurrentTime && nowMinutes !== null && (
                      <strong className="current-time-label" style={{ top: `${currentTimePercent}%` }}>{formatMinutes(nowMinutes)}</strong>
                    )}
                  </div>
                </div>
                {floorRooms.map((room) => {
                  const dailyBookings = layoutOverlappingBookings(
                    bookings.filter((booking) => booking.roomId === room.id && booking.date === date),
                  );
                  const status = statusOf(room);
                  return (
                    <div className={`timeline-day daily-room ${selected.id === room.id ? "active" : ""}`} key={room.id}>
                      <button type="button" className="timeline-day-head daily-room-head" onClick={() => { setSelectedId(room.id); setMapDetailId(null); }}>
                        <strong>{room.name}</strong>
                        <span className={`daily-room-meta ${status.status}`}><i className={`room-status-dot ${status.status}`} /><b>{status.statusLabel}</b><em>·</em>{formatCapacity(room.capacity)}</span>
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
                            <strong>{formatSpokenTime(slotConfirmation.start)}~{formatSpokenTime(slotConfirmation.end)}</strong>
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
                {weekDays.map((day) => (
                  <button type="button" className={`weekly-room-head ${day === date ? "active" : ""}`} key={day} onClick={() => setDate(day)}><b>{formatWeekday(day)}</b><span>{dayOfMonth(day)}</span></button>
                ))}
                {floorRooms.map((room) => {
                  const status = statusOf(room);
                  return (
                    <div className="weekly-room-row" key={room.id}>
                      <button type="button" className={`weekly-room-name ${selected.id === room.id ? "selected" : ""}`} onClick={() => { setSelectedId(room.id); setMapDetailId(null); }}><span className="weekly-room-title">{room.name}</span><small className={status.status}><i className={`room-status-dot ${status.status}`} /><b>{status.statusLabel}</b><em>·</em>{formatCapacity(room.capacity)}</small></button>
                      {weekDays.map((day) => {
                        const dayBookings = bookings.filter((booking) => booking.roomId === room.id && booking.date === day).sort((a, b) => a.start.localeCompare(b.start));
                        return <div className={`weekly-room-cell ${day === date ? "active" : ""}`} key={`${room.id}-${day}`}>
                          {dayBookings.map((booking, index) => <button type="button" className={`weekly-room-event tone-${index % 3}`} key={booking.id} onClick={() => { setSelectedId(room.id); setDate(day); }}><time>{booking.start}–{booking.end}</time><b>{booking.purpose}</b><ReservationHoverCard booking={booking} room={room} /></button>)}
                        </div>;
                      })}
                    </div>
                  );
                })}
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
            <div className="summary-title"><span className={`status-dot ${selectedStatus.status}`} /><strong>{selected.name}</strong></div>
            <p>{selected.location}</p>
            <div className="spec-row"><span>{formatCapacity(selected.capacity)}</span>{selected.equipment.map((item) => <span key={item}>{item}</span>)}</div>
          </div>

          <form onSubmit={submitReservation}>
            <label className="field-label" htmlFor="room-picker-select">회의실</label>
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

            <label className="field-label">예약 날짜</label>
            <input className="date-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />

            <div className="form-row">
              <label><span className="field-label">시작 시간</span><select value={start} onChange={(event) => changeStart(event.target.value)}>{visibleStartTimeOptions.map((time) => <option key={time}>{time}</option>)}</select></label>
              <label><span className="field-label">종료 시간</span><select value={end} onChange={(event) => changeEnd(event.target.value)}>{timeOptions.map((time) => <option key={time}>{time}</option>)}</select></label>
            </div>

            <span className="field-label">이용 시간</span>
            <div className="duration-switch">
              {bookingDefaults.durationPresetsMinutes.map((value) => <button key={value} type="button" className={duration === value ? "active" : ""} onClick={() => changeDuration(value)}>{value / 60}시간</button>)}
              <button type="button" className={allDay ? "active" : ""} onClick={selectAllDay}>종일</button>
            </div>

            <label className="repeat-option">
              <input type="checkbox" checked={repeatWeekly} onChange={(event) => {
                setRepeatWeekly(event.target.checked);
                if (repeatEnd < date) setRepeatEnd(moveDate(date, bookingDefaults.defaultRepeatSpanDays));
              }} />
              <span><b>반복 예약</b><small>매주 같은 요일과 시간</small></span>
            </label>
            {repeatWeekly && <div className="repeat-settings">
              <span className="field-label">반복 주기</span>
              <div className="repeat-cycle-switch">
                <button type="button" className={repeatCycle === "weekly" ? "active" : ""} onClick={() => setRepeatCycle("weekly")}>매주</button>
                <button type="button" className={repeatCycle === "weekdays" ? "active" : ""} onClick={() => setRepeatCycle("weekdays")}>매일 (평일)</button>
              </div>
              <label><span className="field-label">반복 종료 날짜</span><input type="date" value={repeatEnd} min={date} onChange={(event) => setRepeatEnd(event.target.value)} /></label>
              <p>총 <b>{reservationDates.length}</b>회 예약됩니다.</p>
            </div>}

            {currentUser
              ? <label><span className="field-label">예약자</span><input value={`${currentUser.name} (${currentUser.email})`} readOnly disabled /></label>
              : <label><span className="field-label">예약자 이름</span><input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="이름을 입력하세요" /></label>}
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

            <div className="booking-submit">
            {notice && <div className={`notice ${notice.includes("완료") ? "success" : "error"}`}>{notice}</div>}
            {selectedTimeConflict && !notice && <div className="notice error">이미 예약된 시간입니다. 다른 시간을 선택해 주세요.</div>}
            <button className="reserve-button" type="submit" disabled={selectedTimeConflict || submitting}>
              <span>{selected.name}</span>
              <strong>{submitting ? "저장 중…" : selectedTimeConflict ? "이미 예약된 시간입니다" : `${start}–${end} 예약하기`}</strong>
            </button>
            </div>
          </form>
        </aside>
      </section>
      {myBookingsOpen && <div className="my-bookings-backdrop" role="presentation" onMouseDown={() => { setMyBookingsOpen(false); setPendingCancelId(null); }}>
        <section className="my-bookings-dialog" role="dialog" aria-modal="true" aria-labelledby="my-bookings-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="my-bookings-dialog-head"><div><p>MY RESERVATIONS</p><h2 id="my-bookings-title">내 예약</h2></div><button type="button" onClick={() => { setMyBookingsOpen(false); setPendingCancelId(null); }} aria-label="내 예약 닫기">×</button></div>
          {!currentUser && <label className="my-bookings-search"><span>예약자 이름</span><input value={myBookingOwner} onChange={(event) => setMyBookingOwner(event.target.value)} placeholder="예약자 이름을 입력하세요" /></label>}
          <div className="my-bookings-columns">
            <div>
              <h3>예정 예약 <b>{upcomingMyBookings.length}</b></h3>
              {upcomingMyBookings.length ? upcomingMyBookings.map((booking) => (
                <article key={booking.id}>
                  <time>{formatDateLabel(booking.date)} · {booking.start}–{booking.end}</time>
                  <strong>{roomById(booking.roomId)?.name}</strong>
                  <span>{booking.purpose} · {teamOf(booking)}</span>
                  <div className="my-booking-actions">
                    {pendingCancelId === booking.id ? (
                      <>
                        <p>예약을 취소할까요?</p>
                        <button type="button" className="cancel-confirm" onClick={() => cancelBooking(booking.id)}>취소하기</button>
                        <button type="button" onClick={() => setPendingCancelId(null)}>유지</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setPendingCancelId(booking.id)}>예약 취소</button>
                    )}
                  </div>
                </article>
              )) : <p>예정된 예약이 없습니다.</p>}
            </div>
            <div>
              <h3>지난 예약 <b>{pastMyBookings.length}</b></h3>
              {pastMyBookings.length ? pastMyBookings.map((booking) => (
                <article key={booking.id}>
                  <time>{formatDateLabel(booking.date)} · {booking.start}–{booking.end}</time>
                  <strong>{roomById(booking.roomId)?.name}</strong>
                  <span>{booking.purpose} · {teamOf(booking)}</span>
                </article>
              )) : <p>지난 예약이 없습니다.</p>}
            </div>
          </div>
        </section>
      </div>}
      <footer><span>※ 수용 인원과 장비 정보는 시제품용이며 관리자 설정에서 수정할 수 있습니다.</span><strong>사내 회의실 예약 시스템 · Prototype</strong></footer>
    </main>
  );
}
