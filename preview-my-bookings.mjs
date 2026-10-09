// Local, disposable preview of the actual application with seven synthetic bookings.
// Run after npm run build. Never opens the normal data directory or Microsoft services.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = dirname(fileURLToPath(import.meta.url));
const site = JSON.parse(readFileSync(resolve(root, 'app/config/site.json'), 'utf8'));
const rooms = JSON.parse(readFileSync(resolve(root, 'app/config/rooms.json'), 'utf8'));
const directory = resolve(root, 'data-preview-my-bookings', String(Date.now()));
mkdirSync(directory, { recursive: true });
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
Object.assign(process.env, {
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory,
  CLIENT_DIR: resolve(root, 'dist'), ALLOW_ANONYMOUS: '1', SEED_DEMO: '0',
  MS_TENANT_ID: '', MS_CLIENT_ID: '', MS_CLIENT_SECRET: '', APP_BASE_URL: '', MICROSOFT_TOKEN_KEY: '',
  ADMIN_MS_EMAIL: '', ADMIN_MS_OBJECT_ID: '', BACKUP_DIR: '', BACKUP_INTERVAL_MINUTES: '0',
});
globalThis.fetch = async () => { throw Error('External requests are disabled in the isolated booking preview.'); };
const { createBookings } = await import('./server/db.mjs');
const now = new Date();
const today = new Intl.DateTimeFormat('sv-SE', {timeZone:site.timeZone}).format(now);
const [hour, minute] = new Intl.DateTimeFormat('en-GB', {timeZone:site.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now).split(':').map(Number);
const shiftDate = offset => {
  const date = new Date(`${today}T00:00:00Z`); date.setUTCDate(date.getUTCDate()+offset);
  return date.toISOString().slice(0,10);
};
const time = minutes => `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
const step = site.booking.slotMinutes;
const start = Math.floor((hour*60+minute)/step)*step;
const common = { owner:site.testUser.name, team:'시연용 본부', attendees:[] };
const fixtures = [
  {...common,roomId:rooms[0].id,dates:[today],start:time(start),end:time(Math.min(24*60,start+step*4)),purpose:'[시연] 진행 중인 회의'},
  ...['프로젝트 진행 점검','팀 주간 회의','신규 업무 협의','자료 검토 회의','다음 주 일정 조율'].map((purpose,index)=>({
    ...common,roomId:rooms[(index+1)%rooms.length].id,dates:[shiftDate(index+1)],
    start:time(site.timeline.defaultFocusHour*60+index*step),
    end:time(site.timeline.defaultFocusHour*60+index*step+site.booking.defaultDurationMinutes),
    purpose:`[시연] ${purpose}`,
  })),
  {...common,roomId:rooms[0].id,dates:[shiftDate(-1)],start:time(site.timeline.defaultFocusHour*60),end:time(site.timeline.defaultFocusHour*60+site.booking.defaultDurationMinutes),purpose:'[시연] 지난 회의 기록'},
];
for(const fixture of fixtures) {
  const result = createBookings(fixture);
  if(!result.ok) throw Error('Synthetic booking collision.');
}
console.log(`[preview] Isolated synthetic bookings: ${fixtures.length}; owner: ${common.owner}`);
console.log(`[preview] URL: http://127.0.0.1:${port}/`);
console.log('[preview] Open My bookings. Editing/deleting here affects only this disposable preview.');
console.log(`[preview] Data directory: ${directory}`);
await import('./server/index.mjs');
