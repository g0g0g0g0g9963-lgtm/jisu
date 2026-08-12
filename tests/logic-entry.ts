// booking-logic.test.mjs 가 쓰는 진입점. esbuild가 이 파일을 묶어
// tests/.bundle/logic.mjs 를 만든다(JSON 설정을 함께 포함하기 위해서다).
export {
  createSeedBookings,
  expandRepeatDates,
  findConflictingDates,
  layoutOverlappingBookings,
  nearestAvailableSlot,
  timeOptions,
} from "../app/lib/bookings";
export { getWorkWeek, minutesOf, moveDate, todayKey } from "../app/lib/datetime";
export { describeRoomStatus, floors, rooms } from "../app/lib/rooms";
