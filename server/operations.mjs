import { chmodSync, closeSync, openSync, mkdirSync, readdirSync, statSync, statfsSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { backupDatabase, countBookings, dataDirectory, getMetaValue, setMetaValue } from "./db.mjs";

const positive = (name, fallback, min = 1, max = 1e9) => {
  const n = Number(process.env[name] || fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
};
const windowMs = positive("OPS_WINDOW_SECONDS",300) * 1000;
const sampleLimit = positive("OPS_MAX_SAMPLES",5000);
const slowMs = positive("OPS_SLOW_REQUEST_MS",2000);
const diskWarning = positive("OPS_DISK_WARNING_PERCENT",20,1,99);
const backupInterval = positive("BACKUP_INTERVAL_MINUTES",0,0,10080);
const backupLimit = positive("BACKUP_MAX_FILES",168,1,10000);
const configuredBackupDir = (process.env.BACKUP_DIR || "").trim();
const backupDir = configuredBackupDir ? resolve(configuredBackupDir) : null;
const backupPattern = /^bookings-\d{13}-[a-f0-9-]{36}\.sqlite$/;
let activeJob = null;
let lastAttempt = null;
const samples = [];
const locks = [];
let timer;
const readMeta = (name) => { try {return JSON.parse(getMetaValue(name) || "null");} catch {return null;} };
const storeMeta = (name,value) => setMetaValue(name,JSON.stringify(value));
const inside = (parent, child) => {const r=relative(parent,child);return r==="" || (!r.startsWith("..") && !isAbsolute(r));};

export function initializeOperations(clientDir) {
  const previousJob=readMeta("ops:last-job");
  if(previousJob?.state==="running")storeMeta("ops:last-job",{...previousJob,state:"failed",finishedAt:new Date().toISOString(),error:"이전 작업이 서버 재시작으로 중단되었습니다. 백업 파일을 다시 확인해 주세요."});
  if (backupDir) {
    // Never put database copies in a web-served location, including via symlinks.
    const webRoots=[clientDir,resolve("public"),resolve("dist")];
    if (webRoots.some(root=>inside(resolve(root),backupDir))) throw new Error("BACKUP_DIR cannot be web-accessible.");
    mkdirSync(backupDir,{recursive:true,mode:0o700});
    if (webRoots.some(root=>existsSync(root)&&inside(realpathSync(root),realpathSync(backupDir)))) throw new Error("BACKUP_DIR resolves into a web-accessible directory.");
  }
  if (backupInterval && !backupDir) throw new Error("Scheduled backups require BACKUP_DIR.");
  if (backupInterval) {
    timer=setInterval(()=>{
      const last=readMeta("ops:last-backup");
      const since=Math.max(Date.parse(last?.at || "")||0,lastAttempt||0);
      if (!activeJob && Date.now()-since>=backupInterval*60000) startBackup();
    },Math.min(60000,backupInterval*60000));
    timer.unref();
  }
}

export function monitorRequests(req,res,next) {
  if (!/^\/api\/(?:kiosk\/)?bookings(?:\/|$)/.test(req.path)) {next();return;}
  const started=performance.now();
  res.once("finish",()=>{
    samples.push({at:Date.now(),ms:performance.now()-started,write:req.method!=="GET",status:res.statusCode});
    while(samples.length>sampleLimit || samples[0]?.at<Date.now()-windowMs) samples.shift();
  });
  next();
}
export function recordDatabaseError(error) {
  if ([5,6].includes(error?.errcode) || /SQLITE_(BUSY|LOCKED)|database is locked/i.test(String(error?.message||""))) {
    locks.push(Date.now()); if(locks.length>sampleLimit)locks.shift();
  }
}
function backupFiles() {
  if(!backupDir) return [];
  return readdirSync(backupDir,{withFileTypes:true}).filter(entry=>entry.isFile()&&backupPattern.test(entry.name))
    .map(entry=>({name:entry.name,bytes:statSync(join(backupDir,entry.name)).size,at:new Date(Number(entry.name.slice(9,22))).toISOString()}))
    .sort((a,b)=>b.at.localeCompare(a.at));
}
function verifyBackupFile(name) {
  return new Promise((resolveResult,reject)=>{
    const worker=new Worker(new URL("./verify-backup-worker.mjs",import.meta.url),{workerData:{path:join(backupDir,name)},execArgv:[]});
    const timeout=setTimeout(()=>{void worker.terminate();reject(new Error("검증 제한 시간 초과"));},60000);
    worker.once("message",result=>{clearTimeout(timeout);result.ok?resolveResult(result):reject(new Error("백업 검증 실패"));});
    worker.once("error",error=>{clearTimeout(timeout);reject(error);});
    worker.once("exit",code=>{clearTimeout(timeout);if(code!==0)reject(new Error("백업 검증 중단"));});
  });
}
function startJob(kind, task) {
  if(activeJob) return {ok:false,status:409,error:"이미 진행 중인 작업이 있습니다. 완료 후 확인해 주세요."};
  const job={id:randomUUID(),kind,state:"running",at:new Date().toISOString()};
  storeMeta("ops:last-job",job);
  activeJob=job;
  Promise.resolve().then(task).then(result=>{
    Object.assign(job,{state:"success",finishedAt:new Date().toISOString(),...result});
  }).catch(error=>{
    const message=error?.code==="BACKUP_LIMIT"?"백업 파일 수 한도에 도달했습니다. 별도 보관과 정리 후 다시 실행해 주세요.":"작업에 실패했습니다. 저장 공간·폴더 권한과 서버 로그를 확인해 주세요.";
    Object.assign(job,{state:"failed",finishedAt:new Date().toISOString(),error:message});
    console.error(`[operations] ${kind} failed; no secrets or database contents logged`);
  }).finally(()=>{
    try {storeMeta("ops:last-job",job);} catch {console.error("[operations] Could not persist job status");}
    activeJob=null;
  });
  return {ok:true,job:{...job}};
}
export function startBackup() {
  if(!backupDir)return {ok:false,status:409,error:"백업 보관 위치를 먼저 설정해 주세요."};
  return startJob("backup",async()=>{
    lastAttempt=Date.now();
    // Never silently delete old backups. An operator must move/archive them first.
    if(backupFiles().length>=backupLimit){const error=new Error("Backup file limit reached");error.code="BACKUP_LIMIT";throw error;}
    const name=`bookings-${Date.now()}-${randomUUID()}.sqlite`;
    const destination=join(backupDir,name);
    // Establish private file permissions before any sensitive bytes are written.
    closeSync(openSync(destination,"wx",0o600));
    await backupDatabase(destination);
    chmodSync(destination,0o600);
    const checked=await verifyBackupFile(name);
    const result={name,at:new Date().toISOString(),bytes:statSync(destination).size,bookings:checked.bookings};
    storeMeta("ops:last-backup",result);
    storeMeta("ops:last-verification",{...result,scope:"integrity-schema-count"});
    return {file:name};
  });
}
export function startVerification() {
  if(!backupDir)return {ok:false,status:409,error:"백업 보관 위치를 먼저 설정해 주세요."};
  const last=readMeta("ops:last-backup");
  if(!last?.name || !backupPattern.test(last.name) || !backupFiles().some(file=>file.name===last.name))return {ok:false,status:409,error:"검증할 정상 백업이 없습니다."};
  return startJob("verify",async()=>{
    const checked=await verifyBackupFile(last.name);
    storeMeta("ops:last-verification",{at:new Date().toISOString(),name:last.name,bookings:checked.bookings,scope:"integrity-schema-count"});
    return {file:last.name};
  });
}
export function operationsStatus() {
  const now=Date.now();
  const recent=samples.filter(sample=>sample.at>=now-windowMs);
  const reads=recent.filter(sample=>!sample.write).map(sample=>sample.ms).sort((a,b)=>a-b);
  const p95=reads.length?Math.round(reads[Math.ceil(reads.length*.95)-1]):null;
  const failures=recent.filter(sample=>sample.write&&sample.status>=500).length;
  const lockCount=locks.filter(at=>at>=now-windowMs).length;
  let disk=null; let count=null; let databaseOk=true; let files=[];let backupReadable=true;
  try {const d=statfsSync(dataDirectory);disk={freeBytes:d.bavail*d.bsize,freePercent:Math.round(d.bavail/d.blocks*100)};}catch{}
  try {count=countBookings();}catch(error){databaseOk=false;recordDatabaseError(error);}
  try {files=backupFiles();}catch{backupReadable=false;}
  const lastBackup=readMeta("ops:last-backup");
  const lastJob=activeJob || readMeta("ops:last-job");
  const lastExists=!!lastBackup && files.some(file=>file.name===lastBackup.name);
  const overdue=backupInterval>0&&(!lastExists||now-Date.parse(lastBackup.at)>backupInterval*60000*2);
  const alerts=[];
  if(!databaseOk)alerts.push({level:"danger",text:"예약 데이터베이스 조회에 실패했습니다."});
  if(failures)alerts.push({level:"danger",text:`최근 ${Math.round(windowMs/60000)}분간 저장 서버 오류 ${failures}건`});
  if(p95!==null&&p95>slowMs)alerts.push({level:"warning",text:"예약 조회 응답이 설정 기준보다 느립니다."});
  if(lockCount)alerts.push({level:"warning",text:`DB 잠금 오류 ${lockCount}건`});
  if(disk&&disk.freePercent<diskWarning)alerts.push({level:"warning",text:"저장 공간이 부족해지고 있습니다."});
  if(!backupDir)alerts.push({level:"setup",text:"백업 보관 위치가 설정되지 않았습니다."});
  if(!backupReadable||overdue||lastJob?.state==="failed")alerts.push({level:"warning",text:"백업·검증 작업 상태를 확인해 주세요."});
  return {at:new Date().toISOString(),startedAt:new Date(Date.now()-process.uptime()*1000).toISOString(),bookings:count,
    databaseOk,metrics:{windowMinutes:windowMs/60000,samples:recent.length,p95Ms:p95,writeFailures:failures,lockErrors:lockCount,disk},
    backup:{configured:!!backupDir,readable:backupReadable,intervalMinutes:backupInterval,maxFiles:backupLimit,fileCount:files.length,last:lastBackup,lastFilePresent:lastExists,verification:readMeta("ops:last-verification"),job:lastJob,files:files.slice(0,10)},
    alerts,externalMonitoring:{connected:false},offsiteCopy:{connected:false},rollback:{connected:false},
    response:{primary:(process.env.OPS_PRIMARY_CONTACT||"").trim(),secondary:(process.env.OPS_SECONDARY_CONTACT||"").trim()},
  };
}
