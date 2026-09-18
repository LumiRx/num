// Every feature has a door on TODAY, every door opens onto something real,
// and nothing on a tile says more than NUM can stand behind.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

// The smallest browser the module graph will accept (same shim as signup.test.mjs).
globalThis.window = globalThis;
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
globalThis.location = { search: '', pathname: '/', href: 'https://app.itsnum.com/', protocol: 'https:', hostname: 'app.itsnum.com', origin: 'https://app.itsnum.com' };
globalThis.history = { replaceState() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {}, dataset: {} }, documentElement: { style: { setProperty() {} } } };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true }, configurable: true }); } catch { /* fine */ }

let FEATURES, featureById, openFeature, store, saveOffer, forgetSaved, isSaved, researchAsk;
before(async () => {
  ({ FEATURES, featureById, openFeature } = await import('./features.ts'));
  ({ store } = await import('./store.ts'));
  ({ saveOffer, forgetSaved, isSaved, researchAsk } = await import('./savedflights.ts'));
});

const COVERS = new URL('../../app-public/covers/', import.meta.url);

describe('the registry', () => {
  test('ids are unique and every feature has a kicker, title, promise, cover and button', () => {
    const ids = new Set();
    for (const f of FEATURES) {
      assert.ok(!ids.has(f.id), `${f.id} twice`); ids.add(f.id);
      for (const k of ['kicker', 'title', 'promise', 'cover', 'cta']) assert.ok(f[k]?.length > 1, `${f.id}.${k}`);
      assert.ok(f.compose || f.opens, `${f.id}: a tile must lead somewhere — a page that asks NUM, or a sheet`);
    }
    assert.ok(FEATURES.length >= 12);
  });

  test('every cover exists on disk and is credited', () => {
    const credits = readFileSync(new URL('CREDITS.md', COVERS), 'utf8');
    for (const f of FEATURES) {
      const file = f.cover.replace('/covers/', '');
      assert.ok(existsSync(new URL(file, COVERS)), `${f.id}: ${f.cover} is missing from app-public/covers`);
      assert.ok(credits.includes(file), `${f.id}: ${file} is not in CREDITS.md — every photograph names its licence`);
    }
    // And nothing sits in the folder uncredited.
    for (const file of readdirSync(COVERS).filter((n) => n.endsWith('.jpg'))) assert.ok(credits.includes(file), `${file} is uncredited`);
  });

  test('no tile claims what NUM cannot stand behind', () => {
    const banned = /cheapest|guarantee|best price|vetted|checked by a person|no commission|free flights|lowest/i;
    for (const f of FEATURES) {
      for (const s of [f.promise, f.honest ?? '', f.title]) assert.doesNotMatch(s, banned, `${f.id}: "${s}"`);
    }
  });

  test('a page composes the guest’s words into the ask, and the lane when there is one', () => {
    const charter = featureById('charter');
    const ask = charter.compose({ route: 'Phuket → Bangkok', when: 'Saturday 10am', people: '4' }, 'plane');
    assert.match(ask, /private plane/);
    assert.match(ask, /Phuket → Bangkok/);
    assert.match(ask, /Saturday 10am/);
    assert.match(ask, /for 4/);
    const hire = featureById('hire');
    assert.match(hire.compose({ what: 'collect a parcel', where: 'Sathorn', when: 'by 5pm' }, null), /collect a parcel in Sathorn, by 5pm/);
    const pickup = featureById('pickup');
    assert.match(pickup.compose({ what: 'two lattes', from: '', when: '20 minutes' }, null), /somewhere good nearby/);
    assert.match(pickup.compose({ what: 'two lattes', from: 'the café on Soi 11', when: '' }, null), /from the café on Soi 11/);
  });

  test('required fields are the ones a person would have to say anyway; the rest are marked optional', () => {
    for (const f of FEATURES) {
      const req = (f.fields ?? []).filter((x) => !x.optional);
      if (f.fields) assert.ok(req.length >= 1 && req.length <= 3, `${f.id}: ${req.length} required fields — two or three is the promise`);
    }
  });

  // 18 Sep 2026: the audit sent "Find me a massage near Sukhumvit at this
  // afternoon" to the model. It answered anyway, which is how a sentence like
  // that survives — a person reading it would have caught it at once.
  test('every composed ask is a sentence a person would have written', () => {
    const FILL = {
      flights: { from: 'BKK', to: 'NRT', date: '2026-10-03', ret: '' },
      stays: { where: 'Sukhumvit', checkin: '2026-10-03', nights: '3' },
      tables: { what: 'quiet Thai', when: 'tomorrow 8pm', people: '2' },
      charter: { route: 'Bangkok to Phuket', when: 'Saturday 10am', people: '4' },
      rides: { to: 'the airport', when: '6:30am tomorrow' },
      pickup: { what: 'two coffees', from: '', when: '20 minutes' },
      hire: { what: 'collect a parcel', where: 'Sathorn', when: 'before 5pm' },
      wellness: { where: 'Sukhumvit', when: 'this afternoon', notes: '' },
    };
    for (const f of FEATURES.filter((x) => x.compose)) {
      for (const lane of f.lanes ? f.lanes.map((l) => l.id) : [null]) {
        const ask = f.compose(FILL[f.id] ?? {}, lane);
        assert.doesNotMatch(ask, / at (this|that|tomorrow|tonight|today|next|Saturday|Sunday|Monday)\b/i,
          `${f.id}: "${ask}" — "at" belongs before a clock time, not before a phrase`);
        assert.doesNotMatch(ask, /  |\s[.,]|\.\./, `${f.id}: "${ask}" — spacing or punctuation`);
        assert.doesNotMatch(ask, /undefined|null|NaN/, `${f.id}: "${ask}" — a missing value reached the ask`);
        assert.match(ask, /[.?]$/, `${f.id}: "${ask}" — asks end in a full stop or a question mark`);
      }
    }
  });

  // Checked live 18 Sep 2026: /api/host/offerable answers, num_assets is empty,
  // and the concierge says charter "is outside what I can touch right now" —
  // correctly. So the tile may promise a RELAY, never inventory or a price.
  test('charter promises a relay, not a plane and not a price', () => {
    const f = featureById('charter');
    const words = `${f.promise} ${f.honest ?? ''} ${f.compose({ route: 'A to B', when: '', people: '' }, 'plane')}`;
    assert.match(f.promise + ' ' + f.honest, /host network/i, 'say where the request goes');
    assert.doesNotMatch(words, /you see the price|we'll price|price before/i, 'no price is promised');
    assert.doesNotMatch(words, /\bour (fleet|jets|boats|cars)\b|available now|in stock/i, 'no inventory is implied');
    assert.doesNotMatch(f.compose({ route: 'A to B', when: '', people: '' }, 'plane'), /what would it cost/i,
      'asking the model for a cost invites a number nothing backs');
  });

  // 18 Sep 2026: the EVENTS tile promised concerts and matches and opened the
  // host-an-event form. A tile's words and its door have to agree.
  test('events asks what is on, and keeps hosting as its own door', () => {
    const f = featureById('events');
    assert.ok(f.compose, 'tapping Events must ask NUM what is on, not open the host form');
    assert.equal(f.opens, undefined, 'the tile itself must not open EventSheet');
    assert.match(f.compose({ when: 'this weekend', what: 'live music' }, null), /what\u2019s on this weekend/i);
    assert.match(f.secondary?.label ?? '', /host/i, 'hosting keeps a door on the page');
  });

  test('a feature with its own sheet opens that sheet; the rest open their page', () => {
    openFeature('wallet');
    assert.equal(store.get().walletOpen, true);
    assert.equal(store.get().featureOpen, null);
    openFeature('charter');
    assert.equal(store.get().featureOpen, 'charter');
    store.set({ featureOpen: null, walletOpen: false });
  });
});

describe('saved flights', () => {
  const q = { fromCode: 'BKK', toCode: 'NRT', depart: '2026-10-03', adults: 2 };
  const offer = (id, price) => ({
    id, price, currency: 'THB', tax: null, validatingCarrier: 'TG', validUntil: null, totalDurationInMinutes: 370,
    legs: [{ stops: 0, segments: [{ from: 'BKK', to: 'NRT', departs: '2026-10-03T07:35:00', arrives: '2026-10-03T15:45:00', marketing: 'TG640', operating: 'TG640', codeshare: false }] }],
  });

  test('save, see it saved, forget it', () => {
    store.set({ savedFlights: [] });
    assert.equal(isSaved(offer('o1', '12900'), q), false);
    saveOffer(offer('o1', '12900'), q);
    assert.equal(isSaved(offer('o1', '12900'), q), true);
    const s = store.get().savedFlights[0];
    assert.equal(s.route, 'BKK → NRT');
    assert.equal(s.day, '2026-10-03');
    assert.equal(s.price, '12900');
    forgetSaved(s.id);
    assert.equal(store.get().savedFlights.length, 0);
  });

  test('the same flight seen again at a new price replaces the old row — one flight, one card', () => {
    store.set({ savedFlights: [] });
    saveOffer(offer('o1', '12900'), q);
    saveOffer(offer('o2', '11400'), q);
    assert.equal(store.get().savedFlights.length, 1);
    assert.equal(store.get().savedFlights[0].price, '11400');
  });

  test('"check price again" is an ask NUM can act on, with the route, the day and what was saved', () => {
    store.set({ savedFlights: [] });
    saveOffer(offer('o1', '12900'), q);
    const ask = researchAsk(store.get().savedFlights[0]);
    assert.match(ask, /BKK → NRT on 2026-10-03/);
    assert.match(ask, /for 2 people/);
    assert.match(ask, /TG at THB 12900/);
    assert.match(ask, /still the one/);
  });

  test('saved fares survive the app closing; the open page and the first line do not', async () => {
    const { persistable } = await import('./data.ts');
    store.set({ savedFlights: [], featureOpen: 'flights', thinkingLine: 'On it…' });
    saveOffer(offer('o1', '12900'), q);
    const kept = persistable(store.get());
    assert.equal(kept.savedFlights.length, 1);
    assert.equal('featureOpen' in kept, false);
    assert.equal('thinkingLine' in kept, false);
    store.set({ savedFlights: [], featureOpen: null, thinkingLine: null });
  });
});

describe('wired, not just written', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  test('TODAY renders the grid between the day and the rest', () => {
    const dash = read('../components/app/DashView.tsx');
    assert.match(dash, /<FeatureGrid \/>/);
    // Anchored on the CONTENT of the strip, not its exact order: the order is
    // a product decision that has already changed once (the calendar moved to
    // the front on 18 Sep) and pinning the literal made a deliberate change
    // read as a regression.
    const now = /const NOW: WidgetId\[\] = \[([^\]]*)\]/.exec(dash);
    assert.ok(now, 'the Now strip is gone');
    for (const id of ["'next'", "'tonight'", "'tripcheck'"]) assert.ok(now[1].includes(id), `${id} left the day strip`);
  });

  test('the day starts with what is already booked in', () => {
    // The calendar answers "what am I committed to", which is the question
    // NEXT UP is read against; it spent a week two screens below the grid.
    const dash = read('../components/app/DashView.tsx');
    const now = /const NOW: WidgetId\[\] = \[([^\]]*)\]/.exec(dash)[1];
    assert.match(now.trim(), /^'calendar'/, 'the calendar must come first on TODAY');
  });

  test('CONNECT YOUR WORLD is in Settings, and only there', () => {
    // Six permission switches are a set-once screen, not a daily one. The
    // widget id stays mapped in DashView because the server still sends it.
    const dash = read('../components/app/DashView.tsx');
    const profile = read('../components/app/ProfileView.tsx');
    // The rendered string, not the file text — DashView still NAMES the card
    // in a comment saying where it went, which is the point of the comment.
    assert.doesNotMatch(dash, /t\('CONNECT YOUR WORLD'\)/);
    assert.match(dash, /connections: \(\) => null/);
    assert.match(profile, /<ConnectionsCard \/>/);
    assert.match(read('../components/app/ConnectionsCard.tsx'), /CONNECT YOUR WORLD/);
  });
  test('the page is a sheet the shell knows how to close', () => {
    const app = read('../components/app/ConciergeApp.tsx');
    assert.match(app, /<FeaturePage \/>/);
    assert.equal((app.match(/featureOpen/g) ?? []).length >= 5, true, 'featureOpen must be in sheetOpen, closeSheets (twice), overlayOpen and the back handler');
  });
  test('the fare tray can be closed, and a fare can be saved', () => {
    const thread = read('../components/app/ThreadView.tsx');
    assert.match(thread, /store\.set\(\{ flightOffers: null \}\)/);
    assert.match(thread, /saveOffer\(o, state\.query\)/);
  });
});
