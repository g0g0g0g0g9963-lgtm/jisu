// Local-only interactive preview. Never starts with an operational database or real MS credentials.
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, 'data-preview-kiosk', String(Date.now()));
mkdirSync(data, { recursive: true });
const socket = net.createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const upstream = `http://127.0.0.1:${port}`;
const code = randomBytes(32).toString('hex');
const env = { ...process.env, NODE_ENV: 'development', ALLOW_ANONYMOUS: '1',
  HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, CLIENT_DIR: resolve(root, 'dist'),
  MS_TENANT_ID: '', MS_CLIENT_ID: '', MS_CLIENT_SECRET: '', APP_BASE_URL: '',
  MICROSOFT_TOKEN_KEY: '', ADMIN_MS_EMAIL: '', ADMIN_MS_OBJECT_ID: '', SESSION_SECRET: '',
  KIOSK_ENABLED: '1', KIOSK_PAIRING_CODE: code, BACKUP_DIR: '', BACKUP_INTERVAL_MINUTES: '0',
  SEED_DEMO: '0' };

// The preview includes fictitious records so room/week grouping can be inspected immediately.
const seed = spawn(process.execPath, ['--input-type=module', '-e', `
  const {createBookings}=await import(${JSON.stringify(pathToFileURL(resolve(root, 'server/db.mjs')).href)});
  const rooms=${readFileSync(resolve(root, 'app/config/rooms.json'), 'utf8')};
  const key=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const at=new Date(key+'T00:00:00Z'); const weekday=at.getUTCDay(); at.setUTCDate(at.getUTCDate()+(weekday===0?-6:1-weekday));
  for(let week=0;week<2;week++) for(let r=0;r<rooms.length;r++) for(let day=0;day<7;day++) {
    if((r+day)%3===2) continue;
    const date=new Date(at);date.setUTCDate(date.getUTCDate()+day+week*7);
    const hour=9+(r+day)%7; const start=String(hour).padStart(2,'0')+':00';
    const end=String(hour+1).padStart(2,'0')+(r%2?':30':':00');
    createBookings({roomId:rooms[r].id,dates:[date.toISOString().slice(0,10)],start,end,
      owner:['예시 김하늘','예시 이지훈','예시 박서연'][day%3],team:'미리보기',purpose:'실제 예약이 아닌 예시'});
  }
`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolveDone, reject) => {
  seed.on('error', reject); seed.on('exit', status => status === 0 ? resolveDone() : reject(Error('Preview fixture failed')));
});
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false;
for (let n = 0; n < 100; n++) {
  if (child.exitCode !== null) throw Error('Preview server stopped');
  try { if ((await fetch(upstream + '/api/health')).ok) { ready = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 100));
}
if (!ready) { child.kill(); throw Error('Preview server not ready'); }
const pair = await fetch(upstream + '/api/kiosk/session', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: upstream, 'X-Kiosk-Action': 'pair' },
  body: JSON.stringify({code}) });
if (!pair.ok) { child.kill(); throw Error('Preview device pairing failed'); }
const cookie = pair.headers.getSetCookie().find(v => v.startsWith('bdo-kiosk-device='))?.split(';')[0];
if (!cookie) { child.kill(); throw Error('Preview session not received'); }

// The ephemeral proxy supplies only this isolated test device's cookie, never an employee session.
// It is loopback-only and exposes only the kiosk surface. It is not part of the production server.
const proxy = createServer((req, res) => {
  const previewHost = `127.0.0.1:${proxy.address().port}`;
  const previewOrigin = `http://${previewHost}`;
  const crossSite = ['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site'] || ''));
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET');
  if (req.headers.host !== previewHost || crossSite ||
    (req.headers.origin && req.headers.origin !== previewOrigin) ||
    (write && req.headers.origin !== previewOrigin)) {
    res.writeHead(403, {'Cache-Control':'no-store'}).end('Preview origin rejected'); return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/') { res.writeHead(302, {Location:'/kiosk?preview=1'}).end(); return; }
  const allowed = ['/kiosk','/kiosk/','/kiosk.html','/bdo-logo.png'].includes(url.pathname) ||
    /^\/(assets|fonts)\//.test(url.pathname) || /^\/api\/kiosk(?:\/|$)/.test(url.pathname);
  if (!allowed) { res.writeHead(404).end('Preview only'); return; }
  const headers = {...req.headers, host:`127.0.0.1:${port}`, cookie, origin:upstream, 'sec-fetch-site':'same-origin'};
  delete headers['forwarded']; delete headers['x-forwarded-host']; delete headers['x-forwarded-for'];
  const forward = httpRequest(upstream + req.url, {method:req.method,headers}, response => {
    const responseHeaders={...response.headers}; delete responseHeaders['set-cookie'];
    if (url.pathname === '/api/kiosk/session' && req.method === 'GET' && response.statusCode === 200) {
      const chunks=[];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body=Buffer.from(JSON.stringify({...JSON.parse(Buffer.concat(chunks).toString('utf8')), preview:true}));
          delete responseHeaders['transfer-encoding']; delete responseHeaders.etag;
          responseHeaders['content-length']=String(body.length);
          responseHeaders['cache-control']='no-store';
          res.writeHead(200,responseHeaders).end(body);
        } catch { res.writeHead(502).end('Preview session unavailable'); }
      });
      return;
    }
    res.writeHead(response.statusCode || 500, responseHeaders); response.pipe(res);
  });
  forward.on('error', () => { if(!res.headersSent)res.writeHead(502);res.end('Preview connection failed'); });
  req.pipe(forward);
});
await new Promise(r => proxy.listen(0, '127.0.0.1', r));
console.log(`KIOSK_PREVIEW_URL=http://127.0.0.1:${proxy.address().port}/kiosk?preview=1`);
console.log('Isolated fictitious reservations only. No production data or Microsoft calls.');
const stop = () => { proxy.close(); child.kill(); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('exit',()=>child.kill());
child.once('exit', ()=>{ proxy.close(); });
