import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { registerAuthRoutes, ssoEnabled } from "./auth.mjs";
import { ROOM_IDS, siteConfig } from "./config.mjs";
import { countBookings, createBookings, deleteBooking, listBookings } from "./db.mjs";
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
const { openingTime, closingTime } = siteConfig.booking;

const isRealDate = (value) => {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");

function validateCreate(body) {
  const roomId = trimmed(body?.roomId);
  if (!ROOM_IDS.has(roomId)) return { error: "알 수 없는 회의실입니다." };

  const rawDates = Array.isArray(body?.dates) ? body.dates : [body?.date];
  const dates = [...new Set(rawDates.map(trimmed))].filter(Boolean);
  if (dates.length === 0) return { error: "예약 날짜가 없습니다." };
  if (dates.length > MAX_REPEAT) return { error: `반복 예약은 한 번에 ${MAX_REPEAT}건까지 가능합니다.` };
  if (!dates.every(isRealDate)) return { error: "날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)" };

  const start = trimmed(body?.start);
  const end = trimmed(body?.end);
  if (!TIME.test(start) || !TIME.test(end)) return { error: "시간 형식이 올바르지 않습니다. (HH:MM)" };
  if (end <= start) return { error: "종료 시간은 시작 시간보다 늦어야 합니다." };
  if (start < openingTime || end > closingTime) {
    return { error: `예약은 ${openingTime}–${closingTime} 사이만 가능합니다.` };
  }

  const owner = trimmed(body?.owner);
  if (owner.length === 0 || owner.length > 40) return { error: "예약자 이름을 확인해 주세요." };

  const team = trimmed(body?.team).slice(0, 60);
  const purpose = trimmed(body?.purpose).slice(0, 100) || "회의";

  return { value: { roomId, dates: dates.sort(), start, end, owner, team, purpose } };
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

  const result = createBookings(value);
  if (!result.ok) {
    res.status(409).json({
      error: "선택한 시간에 이미 예약이 있습니다.",
      conflict: result.conflict,
    });
    return;
  }
  res.status(201).json({ created: result.created });
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
  );
  if (result.ok) {
    res.status(204).end();
    return;
  }
  if (result.reason === "not-found") {
    res.status(404).json({ error: "예약을 찾을 수 없습니다." });
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
