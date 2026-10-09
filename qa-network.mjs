// Isolated API client regression checks. No server, real data, or external network.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(root, 'app/lib/api.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const config = JSON.parse(readFileSync(resolve(root, 'app/config/site.json'), 'utf8'));
const results = [];
function check(name, good) { results.push({ name, pass: Boolean(good) }); console.log(JSON.stringify(results.at(-1))); }
function client(fetch) {
  const m = { exports: {} }, timers = new Set(); let calls = 0;
  const context = { module: m, exports: m.exports, require: name => { if (name.endsWith('site.json')) return config; throw Error(name); }, AbortController, URLSearchParams, Error, fetch: (...args) => { calls++; return fetch(...args); }, window: { setTimeout(fn, ms) { check('timeout uses configured duration', ms === config.network.requestTimeoutMs); const id = setTimeout(fn, 15); timers.add(id); return id; }, clearTimeout(id) { clearTimeout(id); timers.delete(id); }, location: { assign() {} } } };
  vm.runInNewContext(js, context);
  return { api: m.exports, count: () => calls, timers };
}
const request = { roomId: 'qa-room', dates: ['2026-10-12'], start: '10:00', end: '11:00', owner: 'QA', team: 'QA', purpose: 'QA', attendees: [] };
async function outcome(fn) { try { return { value: await fn() }; } catch (error) { return { error }; } }
let c = client((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
let r = await outcome(() => c.api.postBookings(request));
check('stalled headers time out without retry', r.error?.name === 'TimeoutError' && c.count() === 1 && c.timers.size === 0);
c = client(async (_url, { signal }) => ({ ok: true, status: 201, text: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('body aborted')))) }));
r = await outcome(() => c.api.postBookings(request));
check('stalled response body also times out', r.error?.name === 'TimeoutError' && c.count() === 1 && c.timers.size === 0);
c = client(async () => new Response(JSON.stringify({ created: [{ id: 'qa-booking' }] }), { status: 201 }));
r = await outcome(() => c.api.postBookings(request));
check('normal creation succeeds', r.value?.ok === true && c.timers.size === 0);
c = client(async () => new Response(JSON.stringify({ error: 'conflict', conflict: { date: '2026-10-12', start: '10:00', end: '11:00', owner: 'QA' } }), { status: 409 }));
r = await outcome(() => c.api.postBookings(request));
check('collision remains a definite refusal', r.value?.ok === false && r.value.message.includes('이미'));
c = client(async () => new Response('{}', { status: 201 }));
r = await outcome(() => c.api.postBookings(request));
check('malformed success is not reported as saved', !!r.error);
let url;
c = client(async value => { url = value; return new Response(JSON.stringify({ bookings: [] })); });
r = await outcome(() => c.api.fetchBookings({ from: '2026-10-12', to: '2026-10-13' }));
check('result check is a date-filtered read', Array.isArray(r.value) && url === '/api/bookings?from=2026-10-12&to=2026-10-13');
c = client(async () => new Response('{}'));
r = await outcome(() => c.api.fetchBookings());
check('invalid list is not mistaken for empty bookings', !!r.error);
c = client(async () => new Response(JSON.stringify({ booking: { id: 'qa-booking', end: '11:30' } })));
r = await outcome(() => c.api.patchBookingRequest('qa-booking', {}));
check('patch retains server-confirmed end time', r.value?.booking?.end === '11:30');
c = client(async () => new Response(null, { status: 204 }));
r = await outcome(() => c.api.deleteBookingRequest('qa-booking', 'QA'));
check('empty successful delete remains supported', r.value?.ok === true);
console.log('SUMMARY ' + JSON.stringify({ total: results.length, pass: results.filter(x => x.pass).length }));
process.exitCode = results.some(x => !x.pass) ? 1 : 0;
