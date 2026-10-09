// Focused full-day regressions. No app server, network, or booking database is used.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ts = createRequire(import.meta.url)('typescript');
const cache = new Map();
const results = [];
function check(id, title, pass, details = {}) {
  const result = { id, title, status: pass ? 'PASS' : 'FAIL', ...details };
  results.push(result);
  console.log(JSON.stringify(result));
}
function load(file) {
  const resolved = path.resolve(file);
  if (resolved.endsWith('.json')) return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (cache.has(resolved)) return cache.get(resolved).exports;
  const module = { exports: {} };
  cache.set(resolved, module);
  const source = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
    fileName: resolved,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const require = (specifier) => {
    if (!specifier.startsWith('.')) throw Error('Unexpected module: ' + specifier);
    const base = path.resolve(path.dirname(resolved), specifier);
    return load([base, base + '.ts', base + '.json'].find((candidate) => fs.existsSync(candidate)));
  };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', { console }, { filename: resolved })(require, module, module.exports);
  return module.exports;
}
const config = load(path.join(root, 'app/config/site.json'));
const dt = load(path.join(root, 'app/lib/datetime.ts'));
const bookings = load(path.join(root, 'app/lib/bookings.ts'));
const rooms = load(path.join(root, 'app/lib/rooms.ts'));
const page = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8');
const ast = ts.createSourceFile('page.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const initializers = new Map();
let initialScrollEffect;
function walk(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) initializers.set(node.name.text, node.initializer.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect' && node.arguments[0]?.getText(ast).includes('dailyInitialScrollKey.current')) initialScrollEffect = node.arguments[0].getText(ast);
  ts.forEachChild(node, walk);
}
walk(ast);
function evaluate(source, context) {
  if (!source) throw Error('Missing expected source function');
  vm.runInContext(ts.transpileModule('globalThis.actual = ' + source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.actual;
}
const context = (values) => vm.createContext({ Math, Object, ...values });
const near = (a, b) => Math.abs(a - b) < 0.001;
const roomId = 'synthetic-room';
const futureDate = '2026-10-12';
const options = { today: '2026-10-08', nowMinutes: 720 };
const availability = (start, end, rows = [], overrides = {}) => rooms.describeRoomSlotAvailability(rows, futureDate, start, end, { ...options, ...overrides });

try {
  check('DAY-BOUNDS', 'Booking and timeline cover the entire selected day', config.booking.openingTime === '00:00' && config.booking.closingTime === '24:00' && config.timeline.startHour === 0 && config.timeline.endHour === 24);
  check('OPTION-COUNT', '30-minute full day has 49 boundary labels and 48 start slots', bookings.timeOptions.length === 49 && bookings.timeOptions[0] === '00:00' && bookings.timeOptions.at(-1) === '24:00' && bookings.timeOptions.slice(0, -1).length === 48);
  check('OPTION-SPACING', 'Every selectable boundary is exactly 30 minutes apart', bookings.timeOptions.every((time, index) => dt.minutesOf(time) === index * config.booking.slotMinutes));
  const constants = context({ siteConfig: config, timeOptions: bookings.timeOptions });
  const hours = evaluate(initializers.get('timelineHours'), constants);
  check('HOUR-LABELS', 'Hourly scale includes 00:00 and the 24:00 closing boundary', hours.length === 25 && hours[0] === 0 && hours.at(-1) === 24);
  check('ALL-SLOTS-VALID', 'Every one of the 48 same-day half-hour intervals is bookable', bookings.timeOptions.slice(0, -1).every((start, index) => availability(start, bookings.timeOptions[index + 1]).available));
  check('ALL-DAY-VALID', 'Configured all-day range is a valid 24-hour reservation', availability(config.booking.allDayStart, config.booking.allDayEnd).available);
  for (const [start, end] of [['24:00', '24:30'], ['24:00', '24:00'], ['23:30', '24:30'], ['23:30', '00:00'], ['23:30', '24:01'], ['0:00', '01:00']]) {
    check('INVALID-' + start + '-' + end, 'Reject invalid start/end boundary ' + start + '-' + end, !availability(start, end).available);
  }
  check('ALIGNMENT', 'Expanded day preserves slot alignment validation', !availability('00:10', '00:30').available && !availability('23:30', '23:59').available);
  const lateBooking = { id: 'synthetic', roomId, date: futureDate, start: '23:30', end: '24:00', owner: 'QA', purpose: 'QA' };
  check('MIDNIGHT-CONFLICT', 'Midnight endpoint participates in overlapping reservation checks', availability('23:00', '24:00', [lateBooking]).status === 'conflict');
  check('MIDNIGHT-ADJACENT', 'A reservation ending at the next reservation start does not overlap', availability('23:00', '23:30', [lateBooking]).available);
  check('DATE-ISOLATION', 'Previous date midnight endpoint does not block the next date', availability('00:00', '00:30', [{ ...lateBooking, date: '2026-10-11' }]).available);
  check('ROOM-LATE-STATUS', 'A late reservation remains occupied until the midnight endpoint', rooms.describeRoomStatus([lateBooking], 1439).status === 'occupied');
  check('ROOM-EARLY-STATUS', 'Unbooked room is available at midnight', rooms.describeRoomStatus([], 0).status === 'available');
  check('MIDNIGHT-FORMAT', 'Midnight endpoint retains 24:00 and an explicit spoken next-day label', dt.formatMinutes(1440) === '24:00' && dt.addMinutes('23:30', 30) === '24:00' && dt.formatSpokenTime('24:00').includes('다음 날'));
  for (const [instant, minute, date] of [['2026-10-07T15:00:00Z', 0, '2026-10-08'], ['2026-10-08T03:00:00Z', 720, '2026-10-08'], ['2026-10-08T14:59:00Z', 1439, '2026-10-08'], ['2026-10-08T15:00:00Z', 0, '2026-10-09']]) {
    const now = new Date(instant);
    check('CLOCK-' + instant, 'Office date/minutes are correct across the Korean midnight boundary', dt.officeMinutesOfDay(now) === minute && dt.todayKey(now) === date);
  }
  const lateDefault = bookings.nearestAvailableSlot(new Date('2026-10-08T14:15:00Z'), 30);
  check('LATEST-HALF-HOUR', 'Late-day 30-minute default ends at midnight', lateDefault.start === '23:30' && lateDefault.end === '24:00');

  const metrics = { left: 64, width: 880, bodyTop: 114, bodyHeight: 2304, headerHeight: 72 };
  const grid = { clientHeight: 700, scrollHeight: 2442, scrollTop: 0, scrollTo(value) { this.lastScroll = value; this.scrollTop = value.top; } };
  const scrollContext = context({ dailyGridRef: { current: grid }, dailyGridMetrics: metrics, timelineStart: 0, timelineEnd: 1440, siteConfig: config, useCallback: (callback) => callback, window: { matchMedia: () => ({ matches: false }) } });
  const scroll = evaluate(initializers.get('scrollDailyToMinute'), scrollContext);
  scroll(0);
  check('SCROLL-00', 'Midnight remains visible below the sticky header without negative scrolling', grid.scrollTop >= 0 && metrics.bodyTop - grid.scrollTop > metrics.headerHeight && metrics.bodyTop - grid.scrollTop <= metrics.headerHeight + 42);
  scroll(720);
  check('SCROLL-12', 'Midday current time lands near the top, leaving the viewport for future slots', near((metrics.bodyTop + metrics.bodyHeight / 2 - grid.scrollTop - metrics.headerHeight) / (grid.clientHeight - metrics.headerHeight), config.timeline.initialViewportRatio) && config.timeline.initialViewportRatio > 0 && config.timeline.initialViewportRatio <= 0.05);
  scroll(1439);
  check('SCROLL-2359', 'Late-night scroll clamps at the bottom while keeping the time visible', grid.scrollTop === grid.scrollHeight - grid.clientHeight && metrics.bodyTop + 1439 / 1440 * metrics.bodyHeight <= grid.scrollTop + grid.clientHeight);
  scrollContext.window.matchMedia = () => ({ matches: true });
  scroll(720, 'smooth');
  check('REDUCED-MOTION', 'Current-time navigation respects reduced motion preference', grid.lastScroll.behavior === 'auto');

  const initialCalls = [];
  const initialContext = context({ scheduleView: 'day', dailyInitialScrollKey: { current: null }, dailyGridMetrics: metrics, nowMinutes: 720, date: options.today, today: options.today, floor: 9, siteConfig: config, scrollDailyToMinute: (minute) => initialCalls.push(minute) });
  const initial = evaluate(initialScrollEffect, initialContext);
  initial(); initialContext.nowMinutes = 721; initial();
  check('INITIAL-ONCE', 'Clock updates preserve the manual scroll after first entry', initialCalls.length === 1 && initialCalls[0] === 720);
  initialContext.floor = 12; initial();
  check('FLOOR-RECENTER', 'Floor change repositions the full-day timeline once', initialCalls.length === 2 && initialCalls[1] === 721);
  initialContext.date = futureDate; initial();
  check('OTHER-DATE-FOCUS', 'Other dates use the configured focus hour', initialCalls.at(-1) === config.timeline.defaultFocusHour * 60);
  initialContext.scheduleView = 'week'; initial(); initialContext.scheduleView = 'day'; initial();
  check('RETURN-DAY', 'Returning from weekly view reinitializes daily scroll', initialCalls.length === 4);
  const jumpCalls = [];
  const jumpContext = context({ date: options.today, today: options.today, nowMinutes: 720, setDate: (date) => jumpCalls.push(['date', date]), scrollDailyToMinute: (...args) => jumpCalls.push(args) });
  const jump = evaluate(initializers.get('jumpToCurrentTime'), jumpContext);
  jump(); jump();
  check('JUMP-TODAY-REPEAT', 'Repeated current-time action works when already on today', jumpCalls.length === 2 && jumpCalls.every((call) => call[0] === 720 && call[1] === 'smooth'));
  jumpContext.date = futureDate; jump();
  check('JUMP-FROM-OTHER-DATE', 'Current-time action selects today from another date', jumpCalls.at(-1)[0] === 'date' && jumpCalls.at(-1)[1] === options.today);

  const tapCalls = [];
  const tapGrid = { scrollTop: 700, scrollLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
  const tapContext = context({ dailyPastTap: { current: null }, date: options.today, today: options.today, nowMinutes: 720, dailyGridMetrics: metrics, timelineStart: 0, timelineEnd: 1440, setSelectionFeedback: () => {}, scrollDailyToMinute: (...args) => tapCalls.push(args) });
  const startTap = evaluate(initializers.get('startDailyPastTap'), tapContext);
  const moveTap = evaluate(initializers.get('moveDailyPastTap'), tapContext);
  const finishTap = evaluate(initializers.get('finishDailyPastTap'), tapContext);
  const tapEvent = { isPrimary: true, button: 0, pointerId: 1, clientX: 100, clientY: 100, currentTarget: tapGrid, target: { closest: selector => selector.includes('.time-axis-body') ? {} : null } };
  startTap(tapEvent); finishTap(tapEvent);
  check('PAST-TAP', 'Past blank slot click returns to the current time', tapCalls.length === 1 && tapCalls[0][0] === 720 && tapCalls[0][1] === 'smooth');
  startTap(tapEvent); moveTap({ ...tapEvent, clientX: 120 }); moveTap(tapEvent); finishTap(tapEvent);
  check('PAST-DRAG', 'Movement out and back is not mistaken for a click', tapCalls.length === 1);
  startTap(tapEvent); tapGrid.scrollTop += 25; finishTap(tapEvent);
  check('PAST-PAN', 'Scroll while pressed does not return to the current time', tapCalls.length === 1);
  startTap(tapEvent); finishTap({ ...tapEvent, clientY: 120 });
  check('PAST-UP-DISTANCE', 'Pointer release movement is checked even without a move event', tapCalls.length === 1);
  startTap({ ...tapEvent, target: { closest: () => ({}) } }); finishTap(tapEvent);
  check('PAST-BOOKING', 'Booking buttons are excluded from current-time navigation', tapCalls.length === 1);
  startTap({ ...tapEvent, clientY: 650 }); finishTap({ ...tapEvent, clientY: 650 });
  check('FUTURE-TAP', 'Future slots keep their existing reservation behavior', tapCalls.length === 1);
  tapContext.date = futureDate; startTap(tapEvent); finishTap(tapEvent);
  check('OTHER-DATE-TAP', 'Viewing another date never switches to today on a slot click', tapCalls.length === 1);
  tapContext.date = options.today; startTap({ ...tapEvent, isPrimary: false }); finishTap(tapEvent);
  check('SECONDARY-TOUCH', 'Secondary touches cannot trigger navigation', tapCalls.length === 1);

  let measured;
  const measuringGrid = { scrollLeft: 0, scrollTop: 0, clientLeft: 1, clientTop: 1, getBoundingClientRect: () => ({ left: 10, top: 20 }) };
  const bodyAt = (left, right) => ({ getBoundingClientRect: () => ({ left: left - measuringGrid.scrollLeft, right: right - measuringGrid.scrollLeft, top: 135 - measuringGrid.scrollTop, height: 2304 }) });
  const bodies = [bodyAt(75, 251), bodyAt(779, 955)];
  measuringGrid.querySelectorAll = () => bodies;
  measuringGrid.querySelector = () => ({ offsetHeight: 72 });
  const measure = evaluate(initializers.get('measure'), context({ grid: measuringGrid, setDailyGridMetrics: (next) => { measured = typeof next === 'function' ? next(measured) : next; } }));
  measure();
  const firstMetrics = JSON.stringify(measured);
  measuringGrid.scrollLeft = 250; measuringGrid.scrollTop = 1200; measure();
  check('METRICS-SCROLLED', 'Measured content geometry is stable after horizontal and vertical scroll', firstMetrics === JSON.stringify(measured) && measured.left === 64 && measured.bodyTop === 114 && measured.width === 880);
} catch (error) {
  check('TIMETABLE-HARNESS', 'Focused timetable harness completion', false, { error: String(error), stack: error.stack });
}
const summary = { testedAt: new Date().toISOString(), method: 'Actual TypeScript utilities and AST-extracted page callbacks executed in isolated VM; synthetic geometry, no browser rendering or database', counts: { total: results.length, pass: results.filter((result) => result.status === 'PASS').length, fail: results.filter((result) => result.status === 'FAIL').length }, results };
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(root, 'evidence', 'timetable-24h-results.json'), JSON.stringify(summary, null, 2));
console.log('SUMMARY ' + JSON.stringify(summary.counts));
process.exitCode = summary.counts.fail ? 1 : 0;
