import { createHash } from "node:crypto";
import { getMetaValue, setMetaValue } from "./db.mjs";

// Server-only configuration. No display-name, browser storage or anonymous override.
const email = (process.env.ADMIN_MS_EMAIL ?? "").trim().toLowerCase();
const objectId = (process.env.ADMIN_MS_OBJECT_ID ?? "").trim().toLowerCase();
if (email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)) {
  throw new Error("ADMIN_MS_EMAIL must contain exactly one email address.");
}
const pinKey = "admin-identity:" + createHash("sha256").update(email).digest("hex");

export function isAdminUser(user) {
  if (!email || !user?.oid || user.email?.trim().toLowerCase() !== email) return false;
  const oid = user.oid.trim().toLowerCase();
  if (objectId) return oid === objectId;
  // Bind the configured email to the first authenticated Microsoft object ID.
  // A subsequently reused email never grants a different account administrator access.
  const pinned = getMetaValue(pinKey);
  if (pinned) return pinned === oid;
  setMetaValue(pinKey, oid);
  return true;
}

export function requireAdmin(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  if (isAdminUser(req.user)) { next(); return; }
  if (req.path.startsWith("/api/") || req.baseUrl.startsWith("/api/")) {
    res.status(403).json({ error: "관리자 계정만 접근할 수 있습니다." });
  } else {
    res.status(403).type("html").send('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>접근 제한</title><body><h1>관리자 전용 페이지입니다.</h1><p>허용된 Microsoft 계정으로 로그인해 주세요.</p><a href="/">예약 화면으로 돌아가기</a></body></html>');
  }
}
