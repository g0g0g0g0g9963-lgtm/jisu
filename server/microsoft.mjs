import crypto from "node:crypto";
import { database as db } from "./db.mjs";
import { roomsConfig, ROOM_IDS, siteConfig } from "./config.mjs";

export const microsoftScopes = "openid profile email offline_access User.ReadBasic.All Calendars.ReadWrite";
const rawKey = (process.env.MICROSOFT_TOKEN_KEY || "").trim();
const key = rawKey ? Buffer.from(rawKey, "base64") : null;
if (key && (key.length !== 32 || key.toString("base64") !== rawKey)) throw Error("MICROSOFT_TOKEN_KEY must be a base64 encoded 32-byte key.");
export const microsoftConfigured = Boolean(key && process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.APP_BASE_URL);
const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(process.env.MS_TENANT_ID || "")}/oauth2/v2.0/token`;
const graphBase = "https://graph.microsoft.com/v1.0";
const reminderMinutes = Number(process.env.OUTLOOK_REMINDER_MINUTES ?? 10);
if (!Number.isInteger(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > 10080) throw Error("Invalid OUTLOOK_REMINDER_MINUTES");
const failure = (code, status = 503, retryAfter = 0) => Object.assign(new Error(code), { code, status, retryAfter });

function seal(ownerId, value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(ownerId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString("base64url")).join(".");
}
function readTokens(ownerId) {
  if (!microsoftConfigured) return null;
  const row = db.prepare("SELECT encrypted_tokens FROM microsoft_connections WHERE owner_id=?").get(ownerId);
  if (!row) return null;
  try {
    const [iv, tag, data] = row.encrypted_tokens.split(".").map(s => Buffer.from(s, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(ownerId)); decipher.setAuthTag(tag);
    return {...JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")),sealed:row.encrypted_tokens};
  } catch { return null; }
}
function writeTokens(ownerId, tokens) {
  db.prepare("INSERT INTO microsoft_connections VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens")
    .run(ownerId, seal(ownerId,tokens));
}
export function saveMicrosoftConnection(ownerId, tokens) {
  if (!microsoftConfigured) throw failure("not_configured");
  const scopes = new Set(String(tokens.scope || "").split(" ").map(s => s.split("/").at(-1).toLowerCase()));
  if (!scopes.has("user.readbasic.all") || !scopes.has("calendars.readwrite") ||
      typeof tokens.access_token !== "string" || !tokens.access_token || typeof tokens.refresh_token !== "string" || !tokens.refresh_token ||
      !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0) throw failure("consent_required",403);
  writeTokens(ownerId,{accessToken:tokens.access_token,refreshToken:tokens.refresh_token,expiresAt:Date.now()+Number(tokens.expires_in)*1000});
  db.prepare("UPDATE calendar_jobs SET status='pending',next_attempt=0,attempts=0,error_code='' WHERE owner_id=? AND status<>'synced'").run(ownerId);
}
const refreshes = new Map();
async function accessToken(ownerId) {
  const tokens = readTokens(ownerId);
  if (!tokens) throw failure("connect_required",409);
  if (tokens.expiresAt > Date.now()+60_000) return tokens.accessToken;
  if (!refreshes.has(ownerId)) refreshes.set(ownerId,(async()=>{
    const response = await fetch(tokenUrl,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({client_id:process.env.MS_CLIENT_ID,client_secret:process.env.MS_CLIENT_SECRET,
        grant_type:"refresh_token",refresh_token:tokens.refreshToken}),signal:AbortSignal.timeout(12_000)});
    const result = await response.json();
    if (!response.ok) {
      if (result.error === "invalid_grant" || result.error === "interaction_required") {
        db.prepare("DELETE FROM microsoft_connections WHERE owner_id=? AND encrypted_tokens=?").run(ownerId,tokens.sealed);
        throw failure("connect_required",409);
      }
      throw failure("microsoft_unavailable");
    }
    if (typeof result.access_token !== "string" || !result.access_token || !Number.isFinite(Number(result.expires_in))) throw failure("microsoft_unavailable");
    const next = {accessToken:result.access_token,refreshToken:result.refresh_token || tokens.refreshToken,expiresAt:Date.now()+Number(result.expires_in)*1000};
    // A concurrent disconnect/reconnect must not be undone by an older refresh response.
    if (!db.prepare("UPDATE microsoft_connections SET encrypted_tokens=? WHERE owner_id=? AND encrypted_tokens=?")
      .run(seal(ownerId,next),ownerId,tokens.sealed).changes) throw failure("connect_required",409);
    return next.accessToken;
  })().finally(()=>refreshes.delete(ownerId)));
  return refreshes.get(ownerId);
}
async function graph(ownerId,path,init={}) {
  const token = await accessToken(ownerId);
  const response = await fetch(graphBase+path,{...init,headers:{authorization:`Bearer ${token}`,"content-type":"application/json",Prefer:'IdType="ImmutableId"',...init.headers},signal:AbortSignal.timeout(12_000)});
  if (!response.ok) {
    if (response.status === 401 && readTokens(ownerId)?.accessToken===token) db.prepare("DELETE FROM microsoft_connections WHERE owner_id=?").run(ownerId);
    const code = response.status === 401 ? "connect_required" : response.status === 403 ? "permission_required" : response.status === 404 ? "event_missing" : "microsoft_unavailable";
    const retryAfter = Math.min(3600,Math.max(0,Number(response.headers.get("retry-after")) || 0));
    throw failure(code,response.status,retryAfter);
  }
  if (response.status === 204) return null;
  return response.json();
}

export function rememberEmployee(user) {
  const id = user.oid || user.id, name = user.name || user.displayName, email = user.email || user.mail || user.userPrincipalName;
  if (typeof id!=="string" || typeof name!=="string" || typeof email!=="string" || !id || !name || !email || id.length>128 || name.length>200 || email.length>320) return null;
  const employee = {id,name,email:email.toLowerCase()};
  db.prepare("INSERT INTO employees VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email").run(id,name,employee.email);
  return employee;
}
export function selectedEmployees(ids) {
  if (!Array.isArray(ids) || ids.length > siteConfig.booking.maxAttendees || ids.some(id=>typeof id!=="string" || id.length>128)) return null;
  const result = [...new Set(ids)].map(id=>db.prepare("SELECT * FROM employees WHERE id=?").get(id));
  return result.some(row=>!row) ? null : result;
}
async function searchEmployees(ownerId,query) {
  if (!readTokens(ownerId)) {
    const q = query.toLowerCase();
    return {source:"site",employees:db.prepare("SELECT * FROM employees ORDER BY name,email").all().filter(e=>e.name.toLowerCase().startsWith(q)||e.email.startsWith(q)).slice(0,20)};
  }
  const literal = query.replaceAll("'","''");
  const params = new URLSearchParams({$select:"id,displayName,mail,userPrincipalName",$top:"20",
    $filter:`startswith(displayName,'${literal}') or startswith(mail,'${literal}') or startswith(userPrincipalName,'${literal}')`});
  const result = await graph(ownerId,`/users?${params}`);
  if (!Array.isArray(result?.value)) throw failure("microsoft_unavailable");
  return {source:"microsoft",employees:result.value.map(rememberEmployee).filter(Boolean)};
}

export function calendarEvent(booking) {
  const room = roomsConfig.find(r=>r.id===booking.roomId);
  const dateTime = (time) => time === "24:00"
    ? new Date(Date.parse(booking.date+"T00:00:00Z")+86_400_000).toISOString().slice(0,10)+"T00:00:00"
    : booking.date+"T"+time+":00";
  return {subject:`${booking.purpose} · ${room?.name || "회의실"}`,body:{contentType:"text",content:"회의실 예약 사이트에서 관리하는 개인 일정입니다. 변경·취소는 예약 사이트에서 진행해 주세요. 참석자 초대 메일은 발송하지 않습니다."},
    start:{dateTime:dateTime(booking.start),timeZone:siteConfig.timeZone},end:{dateTime:dateTime(booking.end),timeZone:siteConfig.timeZone},
    location:{displayName:room ? `${room.floor}층 ${room.name}` : "회의실"},showAs:"busy",isReminderOn:true,reminderMinutesBeforeStart:reminderMinutes};
}
function claimJob() {
  const now = Date.now();
  const row = db.prepare("SELECT * FROM calendar_jobs WHERE status IN ('pending','retrying') AND next_attempt<=? AND lease_until<? ORDER BY next_attempt,updated_at LIMIT 1").get(now,now);
  if (!row) return null;
  const lease = crypto.randomUUID();
  if (!db.prepare("UPDATE calendar_jobs SET lease_token=?,lease_until=? WHERE booking_id=? AND lease_until<?").run(lease,now+60_000,row.booking_id,now).changes) return null;
  return {...row,lease_token:lease};
}
function finish(job,eventId,created=false) {
  // Retain an in-flight created event ID even if the booking was concurrently changed/deleted.
  db.prepare(`UPDATE calendar_jobs SET event_id=?,synced_version=?,
    status=CASE WHEN version=? AND ?=0 THEN 'synced' ELSE 'pending' END,
    lease_token=NULL,lease_until=0,error_code='',attempts=0,next_attempt=0,updated_at=? WHERE booking_id=? AND lease_token=?`)
    .run(eventId,created?0:job.version,job.version,Number(created),new Date().toISOString(),job.booking_id,job.lease_token);
}
let working = false;
export async function runCalendarBatch() {
  if (!microsoftConfigured || working) return;
  working = true;
  try {
    // Bounded batches, one external mutation per booking at a time, durable across restart.
    for (let i=0;i<20;i++) {
      const job = claimJob(); if (!job) break;
      try {
        if (!job.desired_json && !job.event_id && !job.first_payload) { finish(job,null); continue; }
        if (!job.event_id) {
          const payload = job.first_payload || JSON.stringify({...calendarEvent(JSON.parse(job.desired_json)),transactionId:job.transaction_id});
          // Persist the exact first request BEFORE sending; uncertain retries use identical payload/transactionId.
          db.prepare("UPDATE calendar_jobs SET first_payload=? WHERE booking_id=? AND lease_token=?").run(payload,job.booking_id,job.lease_token);
          const event = await graph(job.owner_id,"/me/events",{method:"POST",body:payload});
          if (typeof event?.id !== "string" || !event.id) throw failure("microsoft_unavailable");
          finish(job,event.id,true);
        } else {
          try {
            await graph(job.owner_id,`/me/events/${encodeURIComponent(job.event_id)}`,job.desired_json
              ? {method:"PATCH",body:JSON.stringify(calendarEvent(JSON.parse(job.desired_json)))} : {method:"DELETE"});
          } catch (error) { if (error.status!==404 || job.desired_json) throw error; }
          finish(job,job.desired_json ? job.event_id : null);
        }
      } catch (error) {
        const code = ["connect_required","permission_required","event_missing"].includes(error.code) ? error.code : "microsoft_unavailable";
        const attempts = job.attempts+1, retryable = code==="microsoft_unavailable" && attempts<8;
        const delay = Math.max((error.retryAfter || 0)*1000,Math.min(30*60_000,15_000*2**Math.min(attempts-1,7)));
        db.prepare(`UPDATE calendar_jobs SET status=CASE WHEN version<>? THEN 'pending' ELSE ? END,
          attempts=?,next_attempt=?,error_code=?,lease_token=NULL,lease_until=0 WHERE booking_id=? AND lease_token=?`)
          .run(job.version,retryable?"retrying":"attention",attempts,Date.now()+delay,code,job.booking_id,job.lease_token);
      }
    }
  } finally { working = false; }
}

export function registerConvenienceRoutes(app) {
  const signedIn = (req,res,next) => req.user?.oid ? next() : res.status(403).json({error:"회사 계정 로그인이 필요합니다."});
  const jsonAction = (req,res,next) => {
    const origin = req.get("origin");
    if (!req.is("application/json") || req.get("x-booking-action")!=="1" || (origin && origin!==new URL(process.env.APP_BASE_URL).origin)) {
      res.status(403).json({error:"예약 사이트에서 다시 요청해 주세요."}); return;
    }
    next();
  };
  app.get("/api/favorites",signedIn,(req,res)=>res.json({roomIds:db.prepare("SELECT room_id FROM room_favorites WHERE owner_id=? ORDER BY room_id").all(req.user.oid).map(r=>r.room_id).filter(id=>ROOM_IDS.has(id))}));
  app.put("/api/favorites/:roomId",signedIn,jsonAction,(req,res)=>{
    if (!ROOM_IDS.has(req.params.roomId) || typeof req.body?.favorite!=="boolean") { res.status(400).json({error:"회의실을 확인해 주세요."}); return; }
    if (req.body.favorite) db.prepare("INSERT OR IGNORE INTO room_favorites VALUES(?,?)").run(req.user.oid,req.params.roomId);
    else db.prepare("DELETE FROM room_favorites WHERE owner_id=? AND room_id=?").run(req.user.oid,req.params.roomId);
    res.json({ok:true});
  });
  app.get("/api/employees",signedIn,async(req,res)=>{
    const q = typeof req.query.q==="string" ? req.query.q.trim() : "";
    if (q.length<1 || q.length>100) { res.status(400).json({error:"이름 또는 이메일을 입력해 주세요."}); return; }
    try { res.json(await searchEmployees(req.user.oid,q)); }
    catch { res.status(503).json({error:"직원 검색을 불러오지 못했습니다. Microsoft 연결·권한을 확인한 뒤 다시 검색해 주세요."}); }
  });
  app.get("/api/microsoft/status",signedIn,(req,res)=>{
    const jobs = db.prepare("SELECT booking_id,desired_json,status,error_code FROM calendar_jobs WHERE owner_id=? ORDER BY (status<>'synced') DESC,updated_at DESC LIMIT 100").all(req.user.oid);
    res.json({configured:microsoftConfigured,connected:Boolean(readTokens(req.user.oid)),reminderMinutes,
      pendingCount:db.prepare("SELECT count(*) AS n FROM calendar_jobs WHERE owner_id=? AND status<>'synced'").get(req.user.oid).n,
      jobs:jobs.map(j=>({bookingId:j.booking_id,cancelled:!j.desired_json,status:j.status,error:j.error_code}))});
  });
  app.post("/api/microsoft/retry",signedIn,jsonAction,(req,res)=>{
    if (!readTokens(req.user.oid)) { res.status(409).json({error:"Microsoft 연결이 필요합니다."}); return; }
    // Does not replay bookings and does not recreate events deleted directly in Outlook.
    db.prepare("UPDATE calendar_jobs SET status='pending',next_attempt=0,attempts=0 WHERE owner_id=? AND status='attention' AND error_code<>'event_missing'").run(req.user.oid);
    res.status(202).json({ok:true});
  });
  app.post("/api/microsoft/disconnect",signedIn,jsonAction,(req,res)=>{
    db.prepare("DELETE FROM microsoft_connections WHERE owner_id=?").run(req.user.oid);
    res.json({ok:true});
  });
  const timer = setInterval(()=>{ runCalendarBatch().catch(()=>console.error("[calendar] worker unavailable")); },2000);
  timer.unref();
}
