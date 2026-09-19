// "Remind me at six to call the hotel" — read on the phone, deterministically.
// Run: node --test src/lib/reminders.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(spec)) {
      const base = ctx.parentURL ? dirname(fileURLToPath(ctx.parentURL)) : process.cwd();
      for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
        const p = resolvePath(base, spec + ext);
        if (existsSync(p)) return next(pathToFileURL(p).href, ctx);
      }
    }
    return next(spec, ctx);
  },
});
globalThis.window = globalThis;
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
globalThis.location = { search: '', pathname: '/', href: 'https://app.itsnum.com/', protocol: 'https:', hostname: 'app.itsnum.com', origin: 'https://app.itsnum.com' };
globalThis.history = { replaceState() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {}, dataset: {} }, documentElement: { style: { setProperty() {} } } };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true }, configurable: true }); } catch { /* fine */ }

let parseReminder, whenLine, parseTellGroup;
before(async () => { ({ parseReminder, whenLine, parseTellGroup } = await import('./reminders.ts')); });

// Friday 18 Sep 2026, 15:00 local.
const NOW = new Date(2026, 8, 18, 15, 0, 0);
const at = (r) => `${r.due.getFullYear()}-${String(r.due.getMonth() + 1).padStart(2, '0')}-${String(r.due.getDate()).padStart(2, '0')} ${String(r.due.getHours()).padStart(2, '0')}:${String(r.due.getMinutes()).padStart(2, '0')}`;

test('the plain case: "remind me at six to call the hotel" → today 18:00, "Call the hotel"', () => {
  const r = parseReminder('remind me at six to call the hotel', NOW);
  assert.equal(at(r), '2026-09-18 18:00');
  assert.equal(r.text, 'Call the hotel');
  assert.equal(r.heard, 'remind me at six to call the hotel');
});

test('a bare hour is the NEXT such hour; a time that has gone rolls to tomorrow', () => {
  assert.equal(at(parseReminder('remind me at 6 to leave', NOW)), '2026-09-18 18:00', '6 said at 15:00 is 6pm');
  assert.equal(at(parseReminder('remind me at 6 to leave', new Date(2026, 8, 18, 20, 0))), '2026-09-19 06:00', '6 said at 20:00 is 6am tomorrow');
  assert.equal(at(parseReminder('remind me at 2pm to call', NOW)), '2026-09-19 14:00', '2pm said at 15:00 is tomorrow');
  assert.equal(at(parseReminder('remind me at 18:30 to leave', NOW)), '2026-09-18 18:30', '24-hour written time is taken as written');
  assert.equal(at(parseReminder('remind me at 9:15am to check in', NOW)), '2026-09-19 09:15');
});

test('relative: in 20 minutes, in 2 hours, in half an hour, in an hour', () => {
  assert.equal(at(parseReminder('remind me in 20 minutes to move the car', NOW)), '2026-09-18 15:20');
  assert.equal(at(parseReminder('remind me in 2 hours to call mum', NOW)), '2026-09-18 17:00');
  assert.equal(at(parseReminder('remind me in half an hour to check the oven', NOW)), '2026-09-18 15:30');
  assert.equal(at(parseReminder('remind me in an hour to leave', NOW)), '2026-09-18 16:00');
  assert.equal(parseReminder('remind me in 20 minutes to move the car', NOW).text, 'Move the car');
});

test('day words: tomorrow, tonight, friday at 7, next friday', () => {
  assert.equal(at(parseReminder('remind me tomorrow at 9 to book the tram', NOW)), '2026-09-19 09:00');
  assert.equal(at(parseReminder('remind me tonight to pack', NOW)), '2026-09-18 20:00');
  assert.equal(at(parseReminder('remind me on saturday at 7pm to text Sam', NOW)), '2026-09-19 19:00');
  assert.equal(at(parseReminder('remind me friday at 7pm to text Sam', NOW)), '2026-09-18 19:00', 'friday at 7pm said on a Friday at 3 is today');
  assert.equal(at(parseReminder('remind me friday at 1pm to text Sam', NOW)), '2026-09-25 13:00', 'friday at 1pm said on a Friday at 3 is next week');
  assert.equal(at(parseReminder('remind me next friday at noon to text Sam', NOW)), '2026-09-25 12:00');
  assert.equal(at(parseReminder('remind me tomorrow morning to stretch', NOW)), '2026-09-19 09:00', 'tomorrow with no hour: the morning');
});

test('lead-ins: hey NUM, please, set a reminder; the message keeps its meaning', () => {
  assert.equal(parseReminder('Hey NUM, please remind me at 6pm to call the hotel.', NOW).text, 'Call the hotel');
  assert.equal(parseReminder('set a reminder for 8pm: passports', NOW)?.text, 'Passports');
  assert.equal(parseReminder('Remind me at 7 that the tram leaves', NOW).text, 'The tram leaves');
});

test('not a reminder, or no time → null, so NUM is asked like any other sentence', () => {
  assert.equal(parseReminder('book a table for four at Ramiro at 8', NOW), null);
  assert.equal(parseReminder('remind me to call the hotel', NOW), null, 'no time: NUM asks when');
  assert.equal(parseReminder('remind me', NOW), null);
});

test('whenLine reads the time back the way a person would', () => {
  assert.equal(whenLine(new Date(2026, 8, 18, 15, 20), NOW), 'in 20 min');
  assert.equal(whenLine(new Date(2026, 8, 18, 18, 0), NOW), 'today 6:00 pm');
  assert.equal(whenLine(new Date(2026, 8, 19, 9, 0), NOW), 'tomorrow 9:00 am');
  assert.equal(whenLine(new Date(2026, 8, 25, 12, 0), NOW), 'Fri 25 Sep 12:00 pm');
});

test('"tell the group I’m running late" → the line, or null', () => {
  assert.equal(parseTellGroup('tell the group I’m running late'), 'I’m running late');
  assert.equal(parseTellGroup('Hey NUM, let everyone know that dinner moved to 9.'), 'Dinner moved to 9');
  assert.equal(parseTellGroup('what time is dinner'), null);
});

test('wiring: a reminder or a group line is caught before the brain; the app polls; the day shows them', () => {
  const con = readFileSync(new URL('./concierge.ts', import.meta.url), 'utf8');
  assert.match(con, /const rem = parseReminder\(text\);/);
  assert.match(con, /const say = parseTellGroup\(text\);/);
  assert.match(con, /export async function openVoice\(onText/);
  const app = readFileSync(new URL('../components/app/ConciergeApp.tsx', import.meta.url), 'utf8');
  assert.match(app, /const stopRem = startReminderSync\(45_000\);/);
  const derive = readFileSync(new URL('./derive.ts', import.meta.url), 'utf8');
  assert.match(derive, /kind: 'reminder' as const/);
  const types = readFileSync(new URL('./types.ts', import.meta.url), 'utf8');
  assert.match(types, /'reminder'/);
});
