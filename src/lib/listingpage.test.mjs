// A WIDGET THAT OPENS INTO ITS RESULTS.
//
// Dre, 20 Sep 2026: "in the widget we should let it open into a custom page
// with all the related listing — if it's flights it'll be flights, if it's
// hotels it's hotels or clubs, etc."
//
// Every feature page used to compose a sentence and post it to the
// concierge. Right for "collect a package from the post office on Sathorn";
// wrong for "flights BKK→NRT on the 4th", which is a search and has a list
// for an answer.
//
// The thing this turned up on the way: searchStays() had no caller anywhere
// in the app. A complete hotel search — nightly and total, refundability,
// cancel-by, pay-at-hotel, check-in windows, loyalty warning — written,
// typed, and unreachable from the product.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
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

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

let SOURCE, sourceFor, placeQuery, FEATURES;
before(async () => {
  ({ SOURCE, sourceFor, placeQuery } = await import('./listing.ts'));
  ({ FEATURES } = await import('./features.ts'));
});

test('every feature named as having a source is a real feature', () => {
  const ids = new Set(FEATURES.map((f) => f.id));
  for (const id of Object.keys(SOURCE)) {
    assert.ok(ids.has(id), `${id} has a listing source and is not a feature`);
  }
});

test('flights go to flights and hotels go to hotels — which was the ask', () => {
  assert.equal(sourceFor('flights'), 'flights');
  assert.equal(sourceFor('stays'), 'stays');
  assert.equal(sourceFor('nightlife'), 'places');
  assert.equal(sourceFor('tables'), 'places');
});

test('a request for a person is still a sentence, not a search', () => {
  // "Collect a package from the post office on Sathorn" has no list of
  // results. A page of them would be a worse answer than asking NUM.
  for (const id of ['hire', 'pickup', 'move', 'charter', 'rides']) {
    assert.equal(sourceFor(id), null, `${id} was turned into a search`);
  }
});

test('a feature with no source behaves exactly as it did before', () => {
  const page = read('../components/app/FeaturePage.tsx');
  assert.match(page, /const source = sourceFor\(f\.id\);\s*\n\s*if \(source\) \{ openListing\(/);
  assert.match(page, /store\.set\(\{ featureOpen: null, threadOpen: true, unread: 0 \}\);\s*\n\s*\/\/ A widget search is a lookup[\s\S]{0,120}?askNum\(ask, \{ browse: true \}\)/,
    'the old path is gone, so every feature without a source is broken');
});

test('the composed sentence is carried, so ASK NUM TO PICK still sends it', () => {
  const page = read('../components/app/FeaturePage.tsx');
  assert.match(page, /openListing\(\{ feature: f\.id, source, values: clean, lane, ask \}\)/);
  const sheet = read('../components/app/ListingSheet.tsx');
  assert.match(sheet, /void askNum\(draft\.ask, \{ browse: true \}\)/);
});

test('the lane narrows a places search, and free text narrows it further', () => {
  const q = placeQuery({ feature: 'tables', source: 'places', lane: 'late bars', values: { what: 'quiet, near the river' }, ask: '' }, 'Book a table');
  assert.equal(q, 'late bars — quiet, near the river');
  const bare = placeQuery({ feature: 'tables', source: 'places', lane: null, values: {}, ask: '' }, 'Book a table');
  assert.equal(bare, 'Book a table', 'with no lane the feature itself is the subject');
});

/* ── what the list must not invent ─────────────────────────────────────── */

test('a rating is shown only when there is one', () => {
  // 581 of 2,715,565 places carry a rating. A placeholder star would be a
  // fiction on 99.98% of rows.
  const sheet = read('../components/app/ListingSheet.tsx');
  assert.match(sheet, /i\.rating != null \? /);
  assert.doesNotMatch(sheet, /rating \?\? 3\.9|rating \|\| 4/, 'a default rating was invented');
});

test('cancellation terms are stated, including when they are not known', () => {
  const sheet = read('../components/app/ListingSheet.tsx');
  assert.match(sheet, /Non-refundable/);
  assert.match(sheet, /Cancellation terms not stated/,
    'an unknown refund policy renders as nothing, which reads as refundable');
});

/* ── one booking flow, not two ─────────────────────────────────────────── */

test('flights reuse the thread’s own fare tray rather than a second copy', () => {
  // BOOK IT is two taps on purpose: the first mints the referral and shows
  // the fee sentence, the second opens it. A copy of that in another file is
  // a copy that drifts, and what it drifts away from is a disclosure.
  const sheet = read('../components/app/ListingSheet.tsx');
  assert.match(sheet, /import FlightTray from '\.\/FlightTray'/);
  const thread = read('../components/app/ThreadView.tsx');
  assert.match(thread, /import FlightTray from '\.\/FlightTray'/);
  assert.doesNotMatch(thread, /^function FlightTray\(\)/m, 'the tray is defined in two places');
  const tray = read('../components/app/FlightTray.tsx');
  assert.match(tray, /export default function FlightTray\(\)/);
  assert.match(tray, /bookHandoff/, 'the extracted tray lost the booking flow');
});

test('searchStays finally has a caller', () => {
  const sheet = read('../components/app/ListingSheet.tsx');
  assert.match(sheet, /searchStays\(me, q\)/);
});

/* ── the sheet is a sheet like the others ──────────────────────────────── */

test('it closes with the rest and is not restored on launch', () => {
  const app = read('../components/app/ConciergeApp.tsx');
  assert.match(app, /import ListingSheet from '\.\/ListingSheet'/);
  assert.match(app, /<ListingSheet \/>/);
  assert.match(app, /listingOpen: null/, 'closing the sheets leaves the listing up');
  const data = read('./data.ts');
  assert.doesNotMatch(data, /'listingOpen'/,
    'a search is about a moment — restoring yesterday’s prices would show fares that have moved');
  assert.match(data, /listingOpen: null,/, 'no default, so the first read throws');
});
