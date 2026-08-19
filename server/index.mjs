import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { registerAuthRoutes, ssoEnabled } from "./auth.mjs";
import { EQUIPMENT_STOCK, equipmentConfig, ROOM_IDS, siteConfig } from "./config.mjs";
import { countBookings, createBookings, deleteBooking, equipmentUsedInSlot, listBookings, updateBooking } from "./db.mjs";
import { seedDemoBookings } from "./seed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(process.env.CLIENT_DIR ?? join(here, "..", "dist"));
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

if (process.env.SEED_DEMO === "1") {
  const inserted = seedDemoBookings();
  console.log(inserted > 0 ? `[seed] 예시 예약 ${inserted}건을 넣었습니다.` : "[seed] 이미 데이터가 있어 건너뜁니다.");
}

const app = express();
app.disable("x-powered-by");
// DSM 역방향 프록시(https) 뒤에서 동작할 때 프록시 헤더를 신뢰한다.
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));

// SSO가 켜져 있으면 /auth/* 라우트 + 로그인 강제 미들웨어가 여기서 걸린다.
registerAuthRoutes(app);
console.log(ssoEnabled ? "[auth] Microsoft SSO 사용" : "[auth] 익명 모드 (MS_* 환경변수 없음)");

// ── 입력 검증 (운영 시간 규칙은 app/config/site.json에서 온다) ──
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPEAT = 60;
const { openingTime, closingTime, maxAttendees, maxAttendeeNameLength, allowWeekends, defaultPurpose } = siteConfig.booking;

const isRealDate = (value) => {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");

/** 서버가 있는 곳의 오늘 날짜(YYYY-MM-DD). 지난 날짜 예약을 막는 기준. */
const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** 토·일 여부. 화면에서 막더라도 최종 판정은 서버가 한다. */
const isWeekend = (value) => {
  const weekday = new Date(`${value}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
};

/** 생성·수정이 함께 쓰는 검사(회의실·시간대·목적). 날짜와 예약자는 각각 따로 본다. */
function validateCommon(body) {
  const roomId = trimmed(body?.roomId);
  if (!ROOM_IDS.has(roomId)) return { error: "알 수 없는 회의실입니다." };

  const start = trimmed(body?.start);
  const end = trimmed(body?.end);
  if (!TIME.test(start) || !TIME.test(end)) return { error: "시간 형식이 올바르지 않습니다. (HH:MM)" };
  if (end <= start) return { error: "종료 시간은 시작 시간보다 늦어야 합니다." };
  if (start < openingTime || end > closingTime) {
    return { error: `예약은 ${openingTime}–${closingTime} 사이만 가능합니다.` };
  }

  const team = trimmed(body?.team).slice(0, 60);
  // 회의 목적은 선택 항목이다. 다만 표의 칸에 적히는 이름이라 비워 두면
  // 무슨 예약인지 알 수 없는 빈 칸이 된다. 비면 기본 이름(site.json)을 넣는다.
  const purpose = trimmed(body?.purpose).slice(0, 100) || defaultPurpose;

  // 참석자는 선택 항목이다. 배열이 아니면 무시하고, 길이·개수는 설정값으로 자른다.
  const rawAttendees = Array.isArray(body?.attendees) ? body.attendees : [];
  const attendees = [...new Set(rawAttendees.map((name) => trimmed(name).slice(0, maxAttendeeNameLength)))]
    .filter(Boolean)
    .slice(0, maxAttendees);

  // 비품 요청은 { id: 수량 } 형태. 없는 품목·0 이하·보유 수량 초과는 여기서 걸러 낸다.
  const rawEquipment = body?.equipment && typeof body.equipment === "object" && !Array.isArray(body.equipment)
    ? body.equipment
    : {};
  const equipment = {};
  for (const [id, count] of Object.entries(rawEquipment)) {
    if (!EQUIPMENT_STOCK.has(id)) return { error: "알 수 없는 비품입니다." };
    const amount = Number(count);
    if (!Number.isInteger(amount) || amount < 0) return { error: "비품 수량을 확인해 주세요." };
    if (amount > EQUIPMENT_STOCK.get(id)) return { error: "보유 수량보다 많이 요청했습니다." };
    if (amount > 0) equipment[id] = amount;
  }

  return { value: { roomId, start, end, team, purpose, attendees, equipment } };
}

/** 비품 이름을 오류 문구에 쓰기 위한 표. */
const EQUIPMENT_NAME = new Map(equipmentConfig.items.map((item) => [item.id, item.name]));

function validateCreate(body) {
  const { error, value } = validateCommon(body);
  if (error) return { error };

  const rawDates = Array.isArray(body?.dates) ? body.dates : [body?.date];
  const dates = [...new Set(rawDates.map(trimmed))].filter(Boolean);
  if (dates.length === 0) return { error: "예약 날짜가 없습니다." };
  if (dates.length > MAX_REPEAT) return { error: `반복 예약은 한 번에 ${MAX_REPEAT}건까지 가능합니다.` };
  if (!dates.every(isRealDate)) return { error: "날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)" };
  if (!allowWeekends && dates.some(isWeekend)) return { error: "주말에는 예약할 수 없습니다." };
  if (dates.some((date) => date < todayKey())) return { error: "지난 날짜에는 예약할 수 없습니다." };

  const owner = trimmed(body?.owner);
  if (owner.length === 0 || owner.length > 40) return { error: "예약자 이름을 확인해 주세요." };

  return { value: { ...value, dates: dates.sort(), owner } };
}

/** 수정은 예약 한 건이 대상이라 날짜도 하나다. 예약자는 바꿀 수 없다. */
function validatePatch(body) {
  const { error, value } = validateCommon(body);
  if (error) return { error };

  const date = trimmed(body?.date);
  if (!isRealDate(date)) return { error: "날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)" };
  if (!allowWeekends && isWeekend(date)) return { error: "주말에는 예약할 수 없습니다." };

  // 참석자·비품을 아예 보내지 않았으면 기존 값을 유지하도록 undefined로 넘긴다.
  // (그냥 두면 validateCommon이 만든 빈 값이 기존 요청을 지워 버린다)
  const attendees = Array.isArray(body?.attendees) ? value.attendees : undefined;
  const equipment = body?.equipment && typeof body.equipment === "object" ? value.equipment : undefined;
  return { value: { ...value, date, attendees, equipment } };
}

// ── API ────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, bookings: countBookings(), sso: ssoEnabled, now: new Date().toISOString() });
});

/** 현재 로그인 사용자. SSO가 꺼져 있으면 user: null → 프런트는 익명 모드로 동작. */
app.get("/api/me", (req, res) => {
  res.json({ user: ssoEnabled ? { name: req.user.name, email: req.user.email } : null });
});

app.get("/api/bookings", (req, res) => {
  const from = trimmed(req.query.from);
  const to = trimmed(req.query.to);
  if (from && to) {
    if (!isRealDate(from) || !isRealDate(to)) {
      res.status(400).json({ error: "from/to 날짜 형식이 올바르지 않습니다." });
      return;
    }
    res.json({ bookings: listBookings({ from, to }) });
    return;
  }
  res.json({ bookings: listBookings() });
});

app.post("/api/bookings", (req, res) => {
  // SSO 모드에서는 예약자 신원을 서버가 강제한다. 화면이 보낸 owner는 무시.
  const body = ssoEnabled ? { ...req.body, owner: req.user.name } : req.body;
  const { error, value } = validateCreate(body);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  if (ssoEnabled) value.ownerEmail = req.user.email;

  const result = createBookings({ ...value, equipmentStock: EQUIPMENT_STOCK });
  if (!result.ok) {
    // 반복 예약이면 안 되는 날이 여러 개일 수 있다. 전부 돌려주어 화면이
    // "이 날들만 빼고 예약할까요?"를 물어볼 수 있게 한다.
    const { blocked } = result;
    const first = blocked[0];
    const shortage = blocked.find((item) => item.kind === "shortage")?.shortage;
    const many = value.dates.length > 1;

    let error;
    if (first.kind === "shortage") {
      const { id, wanted, left } = first.shortage;
      error = `${EQUIPMENT_NAME.get(id) ?? id}는 이 시간에 ${left}개만 남았습니다. (${wanted}개 요청)`;
    } else {
      error = "선택한 시간에 이미 예약이 있습니다.";
    }
    if (many) error = `${value.dates.length}일 중 ${blocked.length}일은 예약할 수 없습니다. (${error})`;

    res.status(409).json({
      error,
      conflict: first.conflict,
      shortage,
      blocked: blocked.map(({ date, kind }) => ({ date, kind })),
    });
    return;
  }
  res.status(201).json({ created: result.created });
});

/**
 * 그 시간대에 남은 비품 수. 예약 창에서 "화상카메라 1개 남음"을 띄우는 데 쓴다.
 * exclude에 예약 id를 주면 그 예약이 쓰는 수량은 빼고 센다(수정할 때).
 */
app.get("/api/equipment", (req, res) => {
  const date = trimmed(req.query.date);
  const start = trimmed(req.query.start);
  const end = trimmed(req.query.end);
  if (!isRealDate(date) || !TIME.test(start) || !TIME.test(end) || end <= start) {
    res.status(400).json({ error: "날짜와 시간을 확인해 주세요." });
    return;
  }
  const used = equipmentUsedInSlot({ date, start, end, exceptId: trimmed(req.query.exclude) || null });
  res.json({
    items: equipmentConfig.items.map((item) => ({
      ...item,
      left: Math.max(0, item.stock - (used[item.id] ?? 0)),
    })),
  });
});

app.patch("/api/bookings/:id", (req, res) => {
  const owner = trimmed(req.body?.owner);
  if (!ssoEnabled && !owner) {
    res.status(400).json({ error: "예약자 이름이 필요합니다." });
    return;
  }
  const { error, value } = validatePatch(req.body);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const result = updateBooking(
    req.params.id,
    ssoEnabled ? { owner: req.user.name, ownerEmail: req.user.email } : { owner },
    value,
    { equipmentStock: EQUIPMENT_STOCK, today: todayKey() },
  );
  if (result.ok) {
    res.json({ booking: result.booking });
    return;
  }
  if (result.reason === "not-found") {
    res.status(404).json({ error: "예약을 찾을 수 없습니다." });
    return;
  }
  if (result.reason === "past") {
    res.status(400).json({ error: "지난 예약은 수정할 수 없습니다." });
    return;
  }
  if (result.reason === "shortage") {
    const { id, wanted, left } = result.shortage;
    res.status(409).json({
      error: `${EQUIPMENT_NAME.get(id) ?? id}는 이 시간에 ${left}개만 남았습니다. (${wanted}개 요청)`,
      shortage: result.shortage,
    });
    return;
  }
  if (result.reason === "conflict") {
    res.status(409).json({ error: "선택한 시간에 이미 예약이 있습니다.", conflict: result.conflict });
    return;
  }
  res.status(403).json({ error: "본인이 등록한 예약만 수정할 수 있습니다." });
});

app.delete("/api/bookings/:id", (req, res) => {
  const owner = trimmed(req.body?.owner) || trimmed(req.query.owner);
  if (!ssoEnabled && !owner) {
    res.status(400).json({ error: "예약자 이름이 필요합니다." });
    return;
  }
  const result = deleteBooking(
    req.params.id,
    ssoEnabled ? { owner: req.user.name, ownerEmail: req.user.email } : { owner },
    { today: todayKey() },
  );
  if (result.ok) {
    res.status(204).end();
    return;
  }
  if (result.reason === "not-found") {
    res.status(404).json({ error: "예약을 찾을 수 없습니다." });
    return;
  }
  if (result.reason === "past") {
    res.status(400).json({ error: "지난 예약은 취소할 수 없습니다." });
    return;
  }
  res.status(403).json({ error: "본인이 등록한 예약만 취소할 수 있습니다." });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "없는 API 경로입니다." });
});

// ── 정적 파일 + SPA 폴백 ────────────────────────────────────
if (!existsSync(join(clientDir, "index.html"))) {
  console.warn(`[warn] 빌드 결과가 없습니다: ${clientDir} — 먼저 'npm run build'를 실행하세요.`);
}

app.use(
  express.static(clientDir, {
    setHeaders(res, filePath) {
      // 해시가 붙은 asset은 영구 캐시, index.html은 항상 새로 받게 한다.
      res.setHeader("Cache-Control", filePath.includes(join("assets")) ? "public, max-age=31536000, immutable" : "no-cache");
    },
  }),
);

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(join(clientDir, "index.html"), (error) => {
    if (error) next(error);
  });
});

app.use((error, _req, res, _next) => {
  console.error("[error]", error);
  res.status(500).json({ error: "서버 내부 오류가 발생했습니다." });
});

app.listen(port, host, () => {
  console.log(`회의실 예약 서버 실행 중 → http://${host}:${port}`);
});
