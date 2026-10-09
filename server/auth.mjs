import crypto from "node:crypto";
import { createSession, deleteSession, getSession, getMetaValue, setMetaValue } from "./db.mjs";
import { microsoftConfigured, microsoftScopes, rememberEmployee, saveMicrosoftConnection } from "./microsoft.mjs";

// Anonymous name-based access is an explicit, non-production development mode.
const tenant = (process.env.MS_TENANT_ID ?? "").trim();
const clientId = (process.env.MS_CLIENT_ID ?? "").trim();
const clientSecret = (process.env.MS_CLIENT_SECRET ?? "").trim();
const configuredBaseUrl = (process.env.APP_BASE_URL ?? "").trim();
const configured = [tenant, clientId, clientSecret, configuredBaseUrl];
export const ssoEnabled = configured.every(Boolean);

if (configured.some(Boolean) && !ssoEnabled) {
  throw new Error("SSO configuration is incomplete: set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and APP_BASE_URL.");
}
if (!ssoEnabled && (process.env.ALLOW_ANONYMOUS !== "1" || process.env.NODE_ENV === "production")) {
  throw new Error("Microsoft SSO is required. Local development only: explicitly set ALLOW_ANONYMOUS=1 outside production.");
}

const baseUrl = (() => {
  if (!ssoEnabled) return "";
  let parsed;
  try { parsed = new URL(configuredBaseUrl); } catch { throw new Error("APP_BASE_URL must be a valid HTTP(S) origin."); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("APP_BASE_URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("Production SSO requires an HTTPS APP_BASE_URL.");
  }
  return parsed.origin;
})();

const AUTHORIZE_URL = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
const REDIRECT_PATH = "/auth/callback";
const STATE_COOKIE = "bdo-auth-state";
const SESSION_COOKIE = "bdo-session";
const SESSION_DAYS = 30;
const secureCookies = baseUrl.startsWith("https://");

const signingSecret = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let stored = getMetaValue("session-secret");
  if (!stored) {
    stored = crypto.randomBytes(32).toString("hex");
    setMetaValue("session-secret", stored);
  }
  return stored;
})();
const sign = (value) => crypto.createHmac("sha256", signingSecret).update(value).digest("base64url");
const b64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const equalSignature = (actual, expected) => typeof actual === "string" &&
  Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
  crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

const parseCookies = (req) => {
  const header = req.headers.cookie ?? "";
  const jar = Object.create(null);
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    try {
      jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore a malformed cookie rather than failing the whole request.
    }
  }
  return jar;
};
const cookieAttrs = (maxAgeSeconds) =>
  `Path=/; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}${maxAgeSeconds !== undefined ? `; Max-Age=${maxAgeSeconds}` : ""}`;
const setCookie = (res, name, value, maxAgeSeconds) => {
  const existing = res.getHeader("Set-Cookie");
  const cookie = `${name}=${encodeURIComponent(value)}; ${cookieAttrs(maxAgeSeconds)}`;
  res.setHeader("Set-Cookie", existing ? [].concat(existing, cookie) : cookie);
};
const clearCookie = (res, name) => setCookie(res, name, "", 0);

// Reject browser-normalized network paths, backslashes and control characters.
const safeReturnTo = (value) => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") ||
      /[\\\u0000-\u0020\u007f]/.test(value)) return "/";
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decoded)) return "/";
    const origin = baseUrl || "http://localhost";
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin || parsed.pathname.startsWith("//")) return "/";
    return parsed.pathname + parsed.search + parsed.hash;
  } catch { return "/"; }
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

// This token is received directly from the fixed Microsoft token endpoint over TLS.
function decodeIdToken(idToken) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token 형식이 올바르지 않습니다.");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== clientId) throw new Error("id_token 대상(aud)이 다릅니다.");
  if (payload.tid !== tenant) throw new Error("id_token 테넌트(tid)가 다릅니다.");
  if (typeof payload.exp !== "number" || payload.exp < now - 60) throw new Error("id_token이 만료되었습니다.");
  const email = String(payload.preferred_username ?? payload.email ?? "").trim().toLowerCase();
  const name = String(payload.name ?? email.split("@")[0] ?? "").trim();
  const oid = typeof payload.oid === "string" ? payload.oid.trim() : "";
  if (!email || !oid) throw new Error("로그인 계정의 이메일 또는 고유 ID를 확인할 수 없습니다.");
  return { name, email, oid };
}

export function currentUser(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const user = getSession(sid);
  // Sessions created before this check must authenticate again if identity is incomplete.
  if (!user || typeof user.oid !== "string" || !user.oid.trim() ||
      typeof user.email !== "string" || !user.email.trim() ||
      typeof user.name !== "string" || !user.name.trim()) return null;
  return { name: user.name, email: user.email.trim().toLowerCase(), oid: user.oid.trim() };
}

export function registerAuthRoutes(app) {
  if (!ssoEnabled) return;
  app.get(["/auth/login", "/auth/microsoft/connect"], (req, res) => {
    const connecting = req.path === "/auth/microsoft/connect";
    const existingUser = connecting ? currentUser(req) : null;
    if (connecting && (!existingUser || !microsoftConfigured)) {
      res.status(403).type("text").send("회사 계정 로그인과 Microsoft 연동 설정이 필요합니다."); return;
    }
    const state = crypto.randomBytes(16).toString("hex");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const returnTo = safeReturnTo(req.query.returnTo);
    const box = b64urlJson({ state, verifier, returnTo, connectOid: existingUser?.oid, expiresAt: Date.now() + 600_000 });
    setCookie(res, STATE_COOKIE, `${box}.${sign(box)}`, 600);
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", `${baseUrl}${REDIRECT_PATH}`);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", connecting ? microsoftScopes : "openid profile email");
    if (connecting) url.searchParams.set("login_hint", existingUser.email);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    res.redirect(url.href);
  });

  app.get(REDIRECT_PATH, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    clearCookie(res, STATE_COOKIE);
    try {
      const raw = parseCookies(req)[STATE_COOKIE] ?? "";
      const [box, signature, extra] = raw.split(".");
      if (!box || extra !== undefined || !equalSignature(signature, sign(box))) {
        throw new Error("로그인 상태 쿠키가 유효하지 않습니다.");
      }
      const { state, verifier, returnTo, connectOid, expiresAt } = JSON.parse(Buffer.from(box, "base64url").toString("utf8"));
      // Validate state on both success and error callbacks before reading provider errors.
      if (typeof state !== "string" || !state || req.query.state !== state ||
          typeof verifier !== "string" || !verifier ||
          typeof expiresAt !== "number" || expiresAt <= Date.now()) {
        throw new Error("로그인 상태가 올바르지 않거나 만료되었습니다. 다시 시도해 주세요.");
      }
      if (req.query.error) {
        throw new Error(`Microsoft 로그인 실패: ${req.query.error_description ?? req.query.error}`);
      }
      if (typeof req.query.code !== "string" || !req.query.code) throw new Error("로그인 코드가 없습니다.");
      const tokenResponse = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code",
          code: req.query.code, redirect_uri: `${baseUrl}${REDIRECT_PATH}`, code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok || typeof tokens.id_token !== "string") {
        throw new Error(`토큰 교환 실패: ${tokens.error_description ?? tokenResponse.status}`);
      }
      const user = decodeIdToken(tokens.id_token);
      if (connectOid) {
        if (currentUser(req)?.oid !== connectOid || user.oid !== connectOid) throw Error("로그인한 본인의 Microsoft 계정으로 연결해 주세요.");
        try { saveMicrosoftConnection(user.oid,tokens); }
        catch { throw Error("직원 기본 정보 조회 및 본인 일정 권한 승인이 필요합니다. 전산 담당자에게 확인해 주세요."); }
      }
      rememberEmployee(user);
      const previousSid = parseCookies(req)[SESSION_COOKIE];
      if (previousSid) deleteSession(previousSid);
      const sid = createSession(user, SESSION_DAYS);
      setCookie(res, SESSION_COOKIE, sid, SESSION_DAYS * 86_400);
      res.redirect(safeReturnTo(returnTo));
    } catch (error) {
      console.error("[auth]", error);
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.status(401).type("html").send(
        `<!doctype html><meta charset="utf-8"><title>로그인 실패</title><body style="font-family:sans-serif;padding:40px"><h2>로그인에 실패했습니다</h2><p>${escapeHtml(error.message ?? error)}</p><p><a href="/auth/login">다시 로그인</a></p></body>`,
      );
    }
  });

  app.get("/auth/logout", (req, res) => {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) deleteSession(sid);
    clearCookie(res, SESSION_COOKIE);
    res.setHeader("Cache-Control", "no-store");
    res.redirect("/");
  });
  app.use((req, res, next) => {
    if (req.path.startsWith("/auth/") || req.path === "/api/health") { next(); return; }
    const user = currentUser(req);
    if (user) { req.user = user; next(); return; }
    if (req.path.startsWith("/api/")) { res.status(401).json({ error: "로그인이 필요합니다." }); return; }
    res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
  });
}
