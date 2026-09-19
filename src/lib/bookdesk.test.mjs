// A venue's answer lands where the guest looks — once.
//
// 19 Sep 2026. A confirmed table lived only in the booking sheet's request
// list, polled while that sheet was open. It never became a booking on MY
// DIARY, never a card in the thread, and the push saying "It's in your plan"
// was false. landing() is what carries the answer; this pins it.
// Run: node --test src/lib/bookdesk.test.mjs
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

// The smallest browser the module graph will accept (same shim as eventview.test.mjs).
globalThis.window = globalThis;
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
globalThis.location = { search: '', pathname: '/', href: 'https://app.itsnum.com/', protocol: 'https:', hostname: 'app.itsnum.com', origin: 'https://app.itsnum.com' };
globalThis.history = { replaceState() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {}, dataset: {} }, documentElement: { style: { setProperty() {} } } };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true }, configurable: true }); } catch { /* fine */ }

let landing, tableBooking, TABLE_BOOKING_PREFIX;
before(async () => {
  ({ landing, tableBooking, TABLE_BOOKING_PREFIX } = await import('./bookdesk.ts'));
});

const NOW = Date.parse('2026-09-19T01:00:00Z');
const req = (over = {}) => ({
  id: 'req_1', venue_name: 'Cervejaria Ramiro', party_size: 4, on_date: '2026-10-02', at_time: '20:00',
  note: null, plan_id: null, place_id: null, state: 'requested', created_at: '2026-09-18 22:00:00', answered_at: null, ...over,
});

test('a confirmed table is a booking on the diary: venue, party, the venue’s hour, two hours held', () => {
  const b = tableBooking(req({ state: 'confirmed' }));
  assert.equal(b.id, `${TABLE_BOOKING_PREFIX}req_1`);
  assert.deepEqual([b.mo, b.day, b.time, b.dur], [10, 2, '20:00', 120]);
  assert.equal(b.place, 'Cervejaria Ramiro');
  assert.equal(b.title, 'Table for 4 · Cervejaria Ramiro');
  assert.equal(b.status, 'confirmed');
  assert.match(b.note, /Confirmed by the venue through NUM/);
});

test('"tonight" with no date lands on today; no time means 7pm', () => {
  const b = tableBooking(req({ on_date: null, at_time: null }), new Date('2026-09-19T12:00:00'));
  assert.deepEqual([b.mo, b.day, b.time], [9, 19, '19:00']);
});

test('requested → nothing announced, but remembered; confirmed → one booking + one BOOKED card, once', () => {
  const s0 = { bookings: [], bookSeen: {} };
  const p1 = landing(s0, [req()], NOW);
  assert.ok(p1, 'the requested state is recorded');
  assert.equal(p1.msgs.length, 0);
  assert.equal(p1.bookings.length, 0);
  assert.deepEqual(p1.bookSeen, { req_1: 'requested' });

  const s1 = { bookings: p1.bookings, bookSeen: p1.bookSeen };
  const p2 = landing(s1, [req({ state: 'confirmed', answered_at: '2026-09-19 00:58:00' })], NOW);
  assert.equal(p2.bookings.length, 1);
  assert.equal(p2.msgs.length, 1);
  assert.equal(p2.msgs[0].card.tag, 'confirmed', 'the card is a BOOKED card — the nudge lives under it');
  assert.match(p2.msgs[0].text, /confirmed your table for 4 on 2026-10-02 at 20:00\. It’s on your PLAN tab\./);
  assert.equal(p2.unread, 1);

  const s2 = { bookings: p2.bookings, bookSeen: p2.bookSeen };
  assert.equal(landing(s2, [req({ state: 'confirmed', answered_at: '2026-09-19 00:58:00' })], NOW), null, 'the same answer is never carried twice');
});

test('a table asked for from a plan says so', () => {
  const p = landing({ bookings: [], bookSeen: { req_1: 'requested' } }, [req({ state: 'confirmed', plan_id: 'pl_1', answered_at: '2026-09-19 00:58:00' })], NOW);
  assert.match(p.msgs[0].text, /and the group’s board\./);
});

test('declined and expired are one line each, offering another place — no booking', () => {
  const p = landing({ bookings: [], bookSeen: { req_1: 'requested', req_2: 'requested' } }, [
    req({ state: 'declined', answered_at: '2026-09-19 00:58:00' }),
    req({ id: 'req_2', venue_name: 'Belcanto', state: 'expired', answered_at: null }),
  ], NOW);
  assert.equal(p.bookings.length, 0);
  assert.equal(p.msgs.length, 2);
  assert.match(p.msgs[0].text, /couldn’t take your table for 4 at 20:00\. Want me to find you somewhere just as good\?/);
  assert.match(p.msgs[1].text, /Belcanto never answered/);
  assert.equal(p.msgs.every((m) => !m.card), true);
});

test('first run on a device: old confirmed tables become bookings quietly; only fresh answers are announced', () => {
  const p = landing({ bookings: [], bookSeen: {} }, [
    req({ id: 'old', state: 'confirmed', answered_at: '2026-09-10 20:00:00' }),
    req({ id: 'new', state: 'confirmed', answered_at: '2026-09-19 00:30:00' }),
    req({ id: 'olddecl', state: 'declined', answered_at: '2026-09-01 20:00:00' }),
  ], NOW);
  assert.equal(p.bookings.length, 2, 'the diary is truthful about both tables');
  assert.equal(p.msgs.length, 1, 'only the fresh one is said');
  assert.equal(p.unread, 1);
  assert.deepEqual(p.bookSeen, { old: 'confirmed', new: 'confirmed', olddecl: 'declined' });
});

test('the app polls for answers everywhere, not only inside the booking sheet', () => {
  const app = readFileSync(new URL('../components/app/ConciergeApp.tsx', import.meta.url), 'utf8');
  assert.match(app, /const stopBook = startBookSync\(45_000\);/);
  assert.match(app, /stopBook\(\);/);
  const desk = readFileSync(new URL('./bookdesk.ts', import.meta.url), 'utf8');
  assert.match(desk, /store\.set\(\{ bookRequests: out\.requests \}\);\s*landAnswers\(out\.requests\);/, 'every read of the requests carries the answers');
});
