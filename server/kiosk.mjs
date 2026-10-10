import crypto from "node:crypto";
import { createBookings, listBookings, getKioskRequest, createKioskDevice, kioskDeviceActive, revokeKioskDevice } from "./db.mjs";

const COOKIE = "bdo-kiosk-device";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const equal = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const minimal = ({ id, roomId, date, start, end, owner }) => ({ id, roomId, date, start, end, owner });
const fail = (res, status, code, error) => res.status(status).json({ code, error });

function dateValue(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const at = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? at : NaN;
}

/** Separate, least-privilege device access. This never creates a personal SSO session. */
export function registerKioskRoutes(app, { validateCreate }) {
  const requested = process.env.KIOSK_ENABLED === "1";
  const pairingCode = (process.env.KIOSK_PAIRING_CODE || "").trim();
  const production = process.env.NODE_ENV === "production";
  const configuredBase = (process.env.APP_BASE_URL || "").trim();
  let base = null;
  if (configuredBase) {
    try {
      const parsed = new URL(configuredBase);
      if (["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash) base = parsed;
    } catch { /* Invalid configuration fails closed. */ }
  }
  const enabled = requested && pairingCode.length >= 32 && pairingCode.length <= 256 &&
    (!configuredBase || Boolean(base)) && (!production || base?.protocol === "https:");
  const secure = base?.protocol === "https:" || production;
  const sign = value => crypto.createHmac("sha256", pairingCode).update("kiosk-v1:" + value).digest("base64url");
  const csrf = token => sign("csrf:" + token);
  const cookie = (res, value, age = SESSION_MS / 1000) => res.append("Set-Cookie",
    `${COOKIE}=${value}; Path=/api/kiosk; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`);

  const expectedOrigin = req => {
    if (base) return base.origin;
    // Development convenience is deliberately limited to loopback hosts.
    if (production || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(req.get("host") || "")) return null;
    return "http://" + req.get("host");
  };
  const sameOrigin = req => req.get("origin") === expectedOrigin(req) &&
    !["cross-site", "same-site"].includes(req.get("sec-fetch-site"));
  const readSession = req => {
    const token = (req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
    if (!token || token.length > 1024) return null;
    const [encoded, signature, extra] = token.split(".");
    if (extra !== undefined || !encoded || !equal(signature, sign(encoded))) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (!UUID.test(payload.id) || !Number.isSafeInteger(payload.exp) || payload.exp <= Date.now() ||
        payload.exp > Date.now() + SESSION_MS + 60_000 || !kioskDeviceActive(payload.id, payload.exp, Date.now())) return null;
      return { ...payload, token };
    } catch { return null; }
  };
  const attempts = new Map();
  const limited = (key, maximum, windowMs) => {
    const now = Date.now();
    for (const [entry, value] of attempts) if (value.until <= now) attempts.delete(entry);
    let value = attempts.get(key);
    if (!value) {
      // Fail closed rather than discard live attacker buckets when the map fills.
      if (attempts.size >= 2000) return true;
      value = { count: 0, until: now + windowMs }; attempts.set(key, value);
    }
    value.count += 1;
    return value.count > maximum;
  };
  const requireEnabled = (_req, res, next) => enabled ? next() : fail(res, 503, "kiosk-disabled", "공용 모니터가 아직 설정되지 않았습니다. 전산 담당자에게 문의해 주세요.");
  const requireDevice = (req, res, next) => {
    if (["cross-site", "same-site"].includes(req.get("sec-fetch-site"))) return fail(res, 403, "kiosk-origin", "공용 모니터 화면에서 다시 요청해 주세요.");
    req.kioskDevice = readSession(req);
    return req.kioskDevice ? next() : fail(res, 401, "kiosk-session-required", "공용 모니터 연결이 필요합니다.");
  };
  const requireMutation = (req, res, next) => sameOrigin(req) && equal(req.get("x-kiosk-csrf"), csrf(req.kioskDevice.token))
    ? next() : fail(res, 403, "kiosk-csrf", "공용 모니터 화면을 새로 열고 다시 시도해 주세요.");

  app.use("/api/kiosk", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.get("/api/kiosk/session", (req, res) => {
    const session = enabled ? readSession(req) : null;
    res.json({ enabled, authorized: Boolean(session), ...(session ? { csrfToken: csrf(session.token) } : {}) });
  });
  app.post("/api/kiosk/session", requireEnabled, (req, res) => {
    if (!sameOrigin(req) || req.get("x-kiosk-action") !== "pair" || !req.is("application/json")) {
      return fail(res, 403, "kiosk-origin", "공용 모니터 화면에서 연결해 주세요.");
    }
    if (limited("pair:" + (req.ip || "unknown"), 5, 15 * 60_000)) {
      res.setHeader("Retry-After", "900");
      return fail(res, 429, "pairing-rate-limit", "연결 시도가 많습니다. 15분 뒤 다시 시도해 주세요.");
    }
    if (typeof req.body?.code !== "string" || req.body.code.length > 256 || !equal(digest(req.body.code.trim()), digest(pairingCode))) {
      return fail(res, 401, "pairing-failed", "연결 코드를 확인해 주세요.");
    }
    const payload = { id: crypto.randomUUID(), exp: Date.now() + SESSION_MS };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const token = encoded + "." + sign(encoded);
    createKioskDevice(payload.id, payload.exp);
    cookie(res, token);
    return res.json({ enabled: true, authorized: true, csrfToken: csrf(token) });
  });
  app.use("/api/kiosk", requireEnabled, requireDevice);
  app.delete("/api/kiosk/session", requireMutation, (req, res) => {
    revokeKioskDevice(req.kioskDevice.id);
    cookie(res, "", 0);
    res.json({ enabled: true, authorized: false });
  });
  app.get("/api/kiosk/bookings", (req, res) => {
    const from = dateValue(req.query.from), to = dateValue(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 6 * 86400_000) {
      return fail(res, 400, "invalid-range", "조회 기간은 올바른 날짜로 최대 7일까지 선택해 주세요.");
    }
    res.json({ bookings: listBookings({ from: req.query.from, to: req.query.to }).map(minimal), at: new Date().toISOString() });
  });
  app.post("/api/kiosk/bookings", requireMutation, (req, res) => {
    if (!req.is("application/json") || !req.body || Array.isArray(req.body)) return fail(res, 400, "invalid-request", "예약 내용을 확인해 주세요.");
    const allowed = ["roomId", "date", "start", "end", "owner", "purpose"];
    if (Object.keys(req.body).some(key => !allowed.includes(key)) || allowed.slice(0, 5).some(key => typeof req.body[key] !== "string") ||
      (req.body.purpose !== undefined && typeof req.body.purpose !== "string")) return fail(res, 400, "invalid-request", "예약 내용을 확인해 주세요.");
    const key = req.get("idempotency-key");
    if (!UUID.test(key || "")) return fail(res, 400, "request-key-required", "예약 화면을 다시 열어 주세요.");
    const body = Object.fromEntries(allowed.map(key => [key, typeof req.body[key] === "string" ? req.body[key].trim() : ""]));
    const hash = digest(JSON.stringify(body));
    const prior = getKioskRequest(req.kioskDevice.id, key);
    if (prior) {
      if (prior.hash !== hash) return fail(res, 409, "idempotency-conflict", "이미 처리한 예약 요청입니다. 새 예약 화면에서 다시 선택해 주세요.");
      return res.json({ created: prior.result.created.map(minimal), replayed: true });
    }
    if (limited("create:" + req.kioskDevice.id, 30, 5 * 60_000)) {
      res.setHeader("Retry-After", "300");
      return fail(res, 429, "booking-rate-limit", "예약 요청이 많습니다. 잠시 후 다시 시도해 주세요.");
    }
    const { value, error } = validateCreate(body);
    if (error) return fail(res, 400, "invalid-booking", error);
    const result = createBookings({ ...value, ownerId: "", ownerEmail: "", team: "", attendees: [], attendeeAccounts: [],
      identity: { kiosk: true, deviceId: req.kioskDevice.id }, kioskRequest: { deviceId: req.kioskDevice.id, key, hash } });
    if (!result.ok) return result.reason === "idempotency-conflict"
      ? fail(res, 409, "idempotency-conflict", "이미 처리한 예약 요청입니다. 새 예약 화면을 열어 주세요.")
      : fail(res, 409, "booking-conflict", "다른 예약이 먼저 등록됐습니다. 다른 시간을 선택해 주세요.");
    res.status(result.replayed ? 200 : 201).json({ created: result.created.map(minimal), replayed: Boolean(result.replayed) });
  });
  // Never fall through to personal-account or administrator routes.
  app.use("/api/kiosk", (_req, res) => fail(res, 405, "kiosk-operation-not-allowed", "공용 모니터에서는 예약 조회와 생성만 가능합니다."));
}
