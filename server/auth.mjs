import crypto from "node:crypto";
import {
  createSession,
  deleteSession,
  getSession,
  getMetaValue,
  setMetaValue,
} from "./db.mjs";

/**
 * Microsoft Entra ID(구 Azure AD) SSO — OIDC 인증 코드 + PKCE.
 *
 * 필요한 환경변수 4개가 모두 있어야 켜진다:
 *   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, APP_BASE_URL
 * 없으면 익명 모드(이름 직접 입력)로 동작한다.
 *
 * 토큰은 서버가 Microsoft와 직접 교환하며 브라우저에는 세션 쿠키만 남는다.
 */

const tenant = process.env.MS_TENANT_ID ?? "";
const clientId = process.env.MS_CLIENT_ID ?? "";
const clientSecret = process.env.MS_CLIENT_SECRET ?? "";
const baseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");

export const ssoEnabled = Boolean(tenant && clientId && clientSecret && baseUrl);

const AUTHORIZE_URL = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const REDIRECT_PATH = "/auth/callback";
const STATE_COOKIE = "bdo-auth-state";
const SESSION_COOKIE = "bdo-session";
const SESSION_DAYS = 30;

const secureCookies = baseUrl.startsWith("https://");

/** 상태 쿠키 서명 키. 지정이 없으면 한 번 만들어 DB에 보관해 재시작에도 유지한다. */
const signingSecret = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let stored = getMetaValue("session-secret");
  if (!stored) {
    stored = crypto.randomBytes(32).toString("hex");
    setMetaValue("session-secret", stored);
  }
  return stored;
})();

const sign = (value) =>
  crypto.createHmac("sha256", signingSecret).update(value).digest("base64url");

const b64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

const parseCookies = (req) => {
  const header = req.headers.cookie ?? "";
  const jar = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
};

const cookieAttrs = (maxAgeSeconds) =>
  `Path=/; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}${
    maxAgeSeconds !== undefined ? `; Max-Age=${maxAgeSeconds}` : ""
  }`;

const setCookie = (res, name, value, maxAgeSeconds) => {
  const existing = res.getHeader("Set-Cookie");
  const cookie = `${name}=${encodeURIComponent(value)}; ${cookieAttrs(maxAgeSeconds)}`;
  res.setHeader("Set-Cookie", existing ? [].concat(existing, cookie) : cookie);
};

const clearCookie = (res, name) => setCookie(res, name, "", 0);

/** 같은 사이트 안에서만 도는 안전한 returnTo 경로인지. */
const safeReturnTo = (value) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";

/** id_token은 Microsoft 토큰 엔드포인트에서 TLS로 직접 받으므로 페이로드 검증만 한다. */
function decodeIdToken(idToken) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token 형식이 올바르지 않습니다.");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== clientId) throw new Error("id_token 대상(aud)이 다릅니다.");
  if (payload.tid !== tenant) throw new Error("id_token 테넌트(tid)가 다릅니다.");
  if (typeof payload.exp !== "number" || payload.exp < now - 60) {
    throw new Error("id_token이 만료되었습니다.");
  }

  const email = String(payload.preferred_username ?? payload.email ?? "").toLowerCase();
  const name = String(payload.name ?? email.split("@")[0] ?? "");
  if (!email) throw new Error("계정 이메일을 확인할 수 없습니다.");
  return { name, email, oid: payload.oid ?? "" };
}

/** 현재 요청의 로그인 사용자. 없으면 null. */
export function currentUser(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  return getSession(sid);
}

export function registerAuthRoutes(app) {
  if (!ssoEnabled) return;

  app.get("/auth/login", (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const returnTo = safeReturnTo(req.query.returnTo);

    const box = b64urlJson({ state, verifier, returnTo });
    setCookie(res, STATE_COOKIE, `${box}.${sign(box)}`, 600);

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", `${baseUrl}${REDIRECT_PATH}`);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    res.redirect(url.href);
  });

  app.get(REDIRECT_PATH, async (req, res) => {
    try {
      const raw = parseCookies(req)[STATE_COOKIE] ?? "";
      const [box, signature] = raw.split(".");
      if (!box || sign(box) !== signature) throw new Error("로그인 상태 쿠키가 유효하지 않습니다.");
      const { state, verifier, returnTo } = JSON.parse(Buffer.from(box, "base64url").toString("utf8"));
      clearCookie(res, STATE_COOKIE);

      if (req.query.error) {
        throw new Error(`Microsoft 로그인 실패: ${req.query.error_description ?? req.query.error}`);
      }
      if (!req.query.code || req.query.state !== state) {
        throw new Error("로그인 응답이 올바르지 않습니다. 다시 시도해 주세요.");
      }

      const tokenResponse = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code: String(req.query.code),
          redirect_uri: `${baseUrl}${REDIRECT_PATH}`,
          code_verifier: verifier,
        }),
      });
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok || !tokens.id_token) {
        throw new Error(`토큰 교환 실패: ${tokens.error_description ?? tokenResponse.status}`);
      }

      const user = decodeIdToken(tokens.id_token);
      const sid = createSession(user, SESSION_DAYS);
      setCookie(res, SESSION_COOKIE, sid, SESSION_DAYS * 86_400);
      res.redirect(safeReturnTo(returnTo));
    } catch (error) {
      console.error("[auth]", error);
      res
        .status(401)
        .send(
          `<!doctype html><meta charset="utf-8"><title>로그인 실패</title><body style="font-family:sans-serif;padding:40px"><h2>로그인에 실패했습니다</h2><p>${String(error.message ?? error)}</p><p><a href="/auth/login">다시 로그인</a></p></body>`,
        );
    }
  });

  app.get("/auth/logout", (req, res) => {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) deleteSession(sid);
    clearCookie(res, SESSION_COOKIE);
    res.redirect("/");
  });

  // /auth/*, /api/health를 뺀 모든 요청은 로그인 필수.
  app.use((req, res, next) => {
    if (req.path.startsWith("/auth/") || req.path === "/api/health") {
      next();
      return;
    }
    const user = currentUser(req);
    if (user) {
      req.user = user;
      next();
      return;
    }
    if (req.path.startsWith("/api/")) {
      res.status(401).json({ error: "로그인이 필요합니다." });
      return;
    }
    // 화면 요청이면 로그인으로 보냈다가 원래 주소로 돌려보낸다.
    res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
  });
}
