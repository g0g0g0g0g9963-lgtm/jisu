// Test only: fixed office time and a synthetic ongoing meeting in an isolated DB.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (process.env.NODE_ENV !== 'test' || !process.env.DATA_DIR?.includes('data-qa-recovery-')) throw Error('Requires isolated recovery QA data directory');
const NativeDate = Date, now = NativeDate.parse('2026-10-08T02:10:00Z');
globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
const site = JSON.parse(readFileSync(resolve('app/config/site.json'), 'utf8'));
const rooms = JSON.parse(readFileSync(resolve('app/config/rooms.json'), 'utf8'));
const { createBookings } = await import(pathToFileURL(resolve('server/db.mjs')).href);
createBookings({ roomId: rooms[0].id, dates: ['2026-10-08'], start: '10:00', end: '13:00', owner: site.testUser.name, team: site.testUser.team, purpose: 'QA synthetic ongoing' });
