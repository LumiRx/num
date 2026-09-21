// THE WEB: every door leads somewhere, and everything built has a door.
//
// ── WHY THIS FILE EXISTS (21 Sep 2026, Dre's call) ───────────────────────
//
// "Let's lay out all of this and make sure they are all connected in a web
// and they all work."
//
// Three times in two days the same shape turned up: something complete,
// tested, deployed — and unreachable from the product.
//
//   · `searchStays()`      a whole hotel search with no caller anywhere
//   · `insuranceBlock()`   built, verified against government pages, and
//                          gated behind an unrelated dataset's coverage
//   · the travel pack      five datasets, five live routes, no door at all
//
// None of those is a bug a test would catch, because each half works. What
// fails is the JOIN, and nothing was ever looking at the joins. This file
// looks at them.
//
// It asserts on structure rather than behaviour on purpose: the behaviour of
// each half already has its own suite. What is unguarded is whether the two
// halves know about each other.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
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

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const has = (p) => existsSync(new URL(p, root));

let FEATURES, SOURCE, sourceFor;
before(async () => {
  ({ FEATURES } = await import('../src/lib/features.ts'));
  ({ SOURCE, sourceFor } = await import('../src/lib/listing.ts'));
});

/* ── 1. every door leads somewhere ──────────────────────────────────────── */

describe('every door leads somewhere', () => {
  test('a tile either asks NUM, opens a sheet, or opens a listing — never nothing', () => {
    for (const f of FEATURES) {
      const dest = !!f.compose || !!f.opens || !!sourceFor(f.id);
      assert.ok(dest, `the ${f.id} tile is on the home screen and does nothing when tapped`);
    }
  });

  test('a tile with fields can compose an ask from them', () => {
    // A feature with inputs and no compose collects an answer and drops it.
    for (const f of FEATURES) {
      if (!f.fields?.length) continue;
      assert.ok(f.compose || f.opens, `${f.id} asks for ${f.fields.length} field(s) and has nowhere to send them`);
    }
  });

  test('every tile has a cover that exists on disk, at both sizes', () => {
    // A missing cover is a dark rectangle in a grid of photographs, and it
    // reads as the app being broken rather than as one absent file.
    for (const f of FEATURES) {
      const file = f.cover.replace(/^\//, '');
      const small = file.replace(/\.webp$/, '-sm.webp');
      assert.ok(has(`app-public/${file}`), `${f.id}: ${f.cover} is not in app-public/`);
      assert.ok(has(`app-public/${small}`), `${f.id}: the grid-sized ${small} is missing, so the tile upscales`);
    }
  });

  test('every tile says what it does NOT do, where that is not obvious', () => {
    // `honest` is where a handoff is admitted. Not every tile needs one, but
    // the ones that route somewhere else always do.
    const routesAway = ['transit', 'paperwork', 'errands'];
    for (const id of routesAway) {
      const f = FEATURES.find((x) => x.id === id);
      assert.ok(f?.honest, `${id} hands off to somebody else and does not say so`);
    }
  });
});

/* ── 2. every listing source can actually render ────────────────────────── */

describe('a listing source is a promise the sheet has to keep', () => {
  test('every source named in SOURCE has a branch in ListingSheet', () => {
    const sheet = read('src/components/app/ListingSheet.tsx');
    for (const source of new Set(Object.values(SOURCE))) {
      assert.match(sheet, new RegExp(`draft\\.source === '${source}'`),
        `features route to '${source}' and the sheet has no branch for it — the page opens blank`);
    }
  });

  test('every source fetches something', () => {
    const sheet = read('src/components/app/ListingSheet.tsx');
    for (const [call, why] of [
      ['runFlightSearch', 'flights'], ['searchStays', 'stays'],
      ['discover(', 'places'], ['fetchPack(', 'paperwork'],
    ]) {
      assert.ok(sheet.includes(call), `the ${why} listing renders without ever asking for data`);
    }
  });

  test('a feature with a source is one the sheet can name', () => {
    const ids = new Set(FEATURES.map((f) => f.id));
    for (const id of Object.keys(SOURCE)) {
      assert.ok(ids.has(id), `${id} has a listing source and is not a feature`);
    }
  });
});

/* ── 3. everything built has a door ─────────────────────────────────────── */

describe('nothing complete is left unreachable', () => {
  const app = () => [
    read('src/lib/paperwork.ts'), read('src/lib/stays.ts'), read('src/lib/flights.ts'),
    read('src/lib/discover.ts'), read('src/components/app/ListingSheet.tsx'),
    read('src/lib/features.ts'), read('src/lib/concierge.ts'),
  ].join('\n');

  test('the travel routes the worker serves are reachable from the app', () => {
    // `/api/travel/pack` is the assembled one — entry documents, vaccination
    // rules and insurance-as-a-condition-of-entry in one call — so the door
    // onto it is the door onto all three. The individual routes stay for the
    // concierge's own grounding and for anyone integrating.
    const idx = read('worker/index.mjs');
    assert.match(idx, /url\.pathname === '\/api\/travel\/pack'/, 'the pack route has gone');
    assert.match(app(), /\/api\/travel\/pack/, 'the travel pack is built, served, and has no door in the app');
  });

  test('the hotel search has a caller', () => {
    // It had none at all until 20 Sep: a complete search — nightly and total,
    // refundability, cancel-by, pay-at-hotel, check-in windows — written,
    // typed, and unreachable from the product.
    assert.match(app(), /searchStays\(/, 'searchStays has no caller again');
  });

  test('insurance is asked on a country code alone, not on another dataset’s coverage', () => {
    // Gating it on the entry-documents block silently lost Belarus, Qatar,
    // Ecuador and Aruba — all four of which require insurance to enter.
    const idx = read('worker/index.mjs');
    assert.doesNotMatch(idx, /if \(entryDocs && grounding\?\.place\?\.country_code\)/);
    assert.match(idx, /insuranceFor, insuranceBlock/);
  });
});

/* ── 4. the paperwork door keeps its promises ───────────────────────────── */

describe('paperwork is assembly, never a visa service', () => {
  test('the tile says Num cannot apply for anything', () => {
    const f = FEATURES.find((x) => x.id === 'paperwork');
    assert.ok(f, 'the paperwork tile has gone');
    assert.match(f.honest, /not a visa service/i);
    assert.match(f.honest, /free/i, 'the tile does not say the documents themselves are free');
  });

  test('the sheet prints the server’s own promise rather than its own words', () => {
    // travelpack.mjs writes that sentence next to the price on purpose. A
    // second copy in the UI is a copy that drifts away from the offer.
    const sheet = read('src/components/app/ListingSheet.tsx');
    assert.match(sheet, /\{pack\.promise\}/);
  });

  test('what is widely repeated and not officially stated is shown as such', () => {
    // Half the internet says Cuba requires insurance; neither the Cuban
    // foreign ministry nor the FCDO says so. Somebody reading a rule deserves
    // to know which of the two kinds they are reading.
    const sheet = read('src/components/app/ListingSheet.tsx');
    assert.match(sheet, /pack\.unverified/);
  });

  test('a link out of the paperwork page is an official one', () => {
    // traveldocs.mjs allows government hosts and nothing else, because
    // searching for any of these returns copycat sites built to be mistaken
    // for the government and to charge several times the real fee.
    const docs = read('worker/traveldocs.mjs');
    assert.match(docs, /export const OFFICIAL_HOSTS/);
    assert.match(docs, /export function isOfficial/);
  });
});
