/**
 * 예약 규칙 테스트.
 *
 * app/lib 의 TypeScript 모듈은 JSON 설정을 불러오기 때문에 Node가 바로 실행할 수
 * 없다. `pnpm test`가 esbuild로 tests/.bundle/logic.mjs 를 먼저 만들고 이 파일이
 * 그것을 불러온다.
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  createSeedBookings,
  describeRoomStatus,
  expandRepeatDates,
  findConflictingDates,
  getWorkWeek,
  layoutOverlappingBookings,
  nearestAvailableSlot,
  rooms,
  timeOptions,
} = await import("./.bundle/logic.mjs");

const weekdayOf = (key) => "일월화수목금토"[new Date(`${key}T00:00:00Z`).getUTCDay()];
const booking = (fields) => ({
  id: fields.id ?? "x",
  roomId: fields.roomId ?? "9-c1",
  date: fields.date ?? "2026-08-12",
  start: fields.start,
  end: fields.end,
  owner: fields.owner ?? "테스터",
  purpose: fields.purpose ?? "회의",
});

test("주말을 선택해도 그 주의 월~금이 나온다", () => {
  const weekdays = ["월", "화", "수", "목", "금"];
  // 2026-08-10(월) ~ 08-16(일) 은 모두 같은 주다.
  for (const day of ["2026-08-10", "2026-08-12", "2026-08-14", "2026-08-15", "2026-08-16"]) {
    const week = getWorkWeek(day);
    assert.deepEqual(week, ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"]);
    assert.deepEqual(week.map(weekdayOf), weekdays);
  }
});

test("'매일 (평일)' 반복은 주말을 건너뛴다", () => {
  const dates = expandRepeatDates("2026-08-13", "2026-08-19", "weekdays");
  assert.deepEqual(dates, ["2026-08-13", "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19"]);
  assert.equal(dates.filter((d) => ["토", "일"].includes(weekdayOf(d))).length, 0);
});

test("'매주' 반복은 7일 간격으로 같은 요일에만 잡힌다", () => {
  const dates = expandRepeatDates("2026-08-12", "2026-09-02", "weekly");
  assert.deepEqual(dates, ["2026-08-12", "2026-08-19", "2026-08-26", "2026-09-02"]);
  assert.deepEqual(new Set(dates.map(weekdayOf)), new Set(["수"]));
});

test("반복 예약은 첫날뿐 아니라 모든 회차의 충돌을 찾아낸다", () => {
  const existing = [booking({ id: "a", date: "2026-08-26", start: "14:00", end: "15:00" })];
  const dates = expandRepeatDates("2026-08-12", "2026-09-02", "weekly");

  const conflicts = findConflictingDates(existing, "9-c1", dates, "14:30", "15:30");
  assert.deepEqual(conflicts, ["2026-08-26"], "3회차의 충돌을 잡아야 한다");

  // 다른 회의실이거나 시간이 겹치지 않으면 충돌이 아니다.
  assert.deepEqual(findConflictingDates(existing, "9-c2", dates, "14:30", "15:30"), []);
  assert.deepEqual(findConflictingDates(existing, "9-c1", dates, "15:00", "16:00"), []);
});

test("회의실 상태는 오늘 예약과 현재 시각에서 계산된다", () => {
  const todays = [
    booking({ id: "m", start: "09:30", end: "10:30" }),
    booking({ id: "n", start: "10:30", end: "11:00" }),
  ];

  // 09:50 → 사용 중이고, 뒤에 이어지는 예약까지 끝나는 11:00부터 빈다.
  const during = describeRoomStatus(todays, 9 * 60 + 50);
  assert.equal(during.status, "occupied");
  assert.equal(during.nextLabel, "11:00부터 사용 가능");

  // 09:10 → 20분 뒤 시작이므로 "곧 예약".
  assert.equal(describeRoomStatus(todays, 9 * 60 + 10).status, "soon");

  // 08:30 → 60분 뒤라 아직 여유가 있다.
  const early = describeRoomStatus(todays, 8 * 60 + 30);
  assert.equal(early.status, "available");
  assert.equal(early.nextLabel, "09:30부터 예약");

  // 예약이 없으면 사용 가능.
  assert.equal(describeRoomStatus([], 13 * 60).status, "available");

  // 현재 시각을 모르면 넘겨짚지 않는다.
  assert.equal(describeRoomStatus(todays, null).status, "unknown");
});

test("가장 가까운 예약 시간은 30분 단위로 올림된다", () => {
  // 한국시간 10:05 → 10:30 시작
  const slot = nearestAvailableSlot(new Date("2026-08-12T01:05:00Z"), 60);
  assert.deepEqual(slot, { date: "2026-08-12", start: "10:30", end: "11:30" });

  // 운영 시간이 끝난 뒤에는 다음 날 첫 시각으로 넘어간다.
  const tomorrow = nearestAvailableSlot(new Date("2026-08-12T11:00:00Z"), 60);
  assert.deepEqual(tomorrow, { date: "2026-08-13", start: "09:00", end: "10:00" });

  // 서버 렌더링(시각 모름) 에서도 유효한 값을 준다.
  assert.equal(nearestAvailableSlot(null, 60).start, "09:00");
});

test("운영 시간이 설정대로 만들어진다", () => {
  assert.equal(timeOptions[0], "09:00");
  assert.equal(timeOptions.at(-1), "20:00");
  assert.equal(timeOptions.length, 23);
});

test("겹치는 예약은 서로 다른 열에 배치된다", () => {
  const placed = layoutOverlappingBookings([
    booking({ id: "a", start: "09:00", end: "11:00" }),
    booking({ id: "b", start: "10:00", end: "12:00" }),
    booking({ id: "c", start: "13:00", end: "14:00" }),
  ]);
  const byId = Object.fromEntries(placed.map((item) => [item.id, item]));
  assert.notEqual(byId.a.lane, byId.b.lane, "겹치면 다른 열");
  assert.equal(byId.a.laneCount, 2);
  assert.equal(byId.c.laneCount, 1, "겹치지 않는 예약은 한 칸을 다 쓴다");
});

test("시연용 예약은 오늘 기준으로 만들어지고 식별자가 겹치지 않는다", () => {
  const seeded = createSeedBookings("2026-08-12");
  assert.ok(seeded.length > 0);
  assert.equal(new Set(seeded.map((item) => item.id)).size, seeded.length);

  const roomIds = new Set(rooms.map((room) => room.id));
  for (const item of seeded) {
    assert.ok(roomIds.has(item.roomId), `${item.roomId} 는 회의실 목록에 있어야 한다`);
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(item.start < item.end, "시작이 종료보다 빨라야 한다");
  }
});
