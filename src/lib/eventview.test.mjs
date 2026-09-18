// An event opens inside NUM, and says only what the listing said.
//
// Two kinds of test here. The first runs the real helpers from
// lib/eventview.ts, because the price line and the ticket button are
// judgements about honesty, not formatting. The second reads the sheet and
// the rail as source, for the promises that are facts about the files: the
// tap does not eject you to another site, and nothing in the sheet claims a
// booking NUM cannot make.
import { test, describe, before } from 'node:test';
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

// The smallest browser the module graph will accept (same shim as features.test.mjs).
globalThis.window = globalThis;
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
globalThis.location = { search: '', pathname: '/', href: 'https://app.itsnum.com/', protocol: 'https:', hostname: 'app.itsnum.com', origin: 'https://app.itsnum.com' };
globalThis.history = { replaceState() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {}, dataset: {} }, documentElement: { style: { setProperty() {} } } };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true }, configurable: true }); } catch { /* fine */ }

let costOf, factsOf, ticketLabel, sellerNote, planAsk, getInAsk, shareOf, openEventCard, closeEventCard, store;
before(async () => {
  ({ costOf, factsOf, ticketLabel, sellerNote, planAsk, getInAsk, shareOf, openEventCard, closeEventCard } = await import('./eventview.ts'));
  ({ store } = await import('./store.ts'));
});

const tm = (over = {}) => ({
  source: 'ticketmaster', id: 'tm_1', title: 'Rosalía', sub: 'O2 Academy · 18 Sep',
  image: 'https://img/x.jpg', label: 'Listed on Ticketmaster', when: 'Doors in 1h 42m',
  starts_on: '2026-09-18', venue: 'O2 Academy', distance_km: 0.4, cost: null, why: null,
  url: 'https://www.ticketmaster.co.uk/event/1', ...over,
});
const ours = (over = {}) => ({
  source: 'num', id: 'ce_1', title: 'Full moon drums', sub: 'Haad Rin', image: null,
  label: 'Checked by NUM', when: 'Tomorrow', starts_on: '2026-09-19', venue: 'Haad Rin',
  distance_km: null, cost: null, why: 'Nobody in your plan has been.', url: null, ...over,
});

describe('what it costs, honestly', () => {
  test('a price we were given is the price shown', () => {
    assert.equal(costOf(tm({ cost: 'GBP 45' })), 'GBP 45');
  });

  test('no price and a ticket page → we say where the price is, never a number', () => {
    const line = costOf(tm());
    assert.equal(line, 'Price is on the ticket page');
    assert.doesNotMatch(line, /\d/);
  });

  test('no price and nowhere to look → the sheet says nothing rather than “free”', () => {
    assert.equal(costOf(ours()), null);
    assert.equal(costOf(ours({ cost: '   ' })), null);
  });
});

describe('the facts line carries only facts it has', () => {
  test('when, where and how far, in that order', () => {
    assert.deepEqual(factsOf(tm()), ['Doors in 1h 42m', 'O2 Academy', '400 m']);
  });

  test('nothing is padded in — an event with no venue and no fix shows what is left', () => {
    assert.deepEqual(factsOf(ours({ venue: null, sub: null })), ['Tomorrow']);
  });

  test('an empty listing produces an empty line, not a row of dots', () => {
    assert.deepEqual(factsOf({ source: 'num', id: 'x', title: 'x', sub: '', image: null, label: 'Checked by NUM', when: null }), []);
  });
});

describe('leaving NUM is labelled with whose page it is', () => {
  test('Ticketmaster is named on the button', () => {
    assert.equal(ticketLabel(tm()), 'GET TICKETS ON TICKETMASTER');
  });

  test('no ticket page → no button at all, so nothing dead-ends', () => {
    assert.equal(ticketLabel(ours()), null);
  });

  test('the seller is named once, and NUM does not claim the money', () => {
    assert.match(sellerNote(tm()), /sold by Ticketmaster/);
    assert.match(sellerNote(tm()), /NUM holds nothing and charges nothing/);
    assert.equal(sellerNote(ours()), null);
  });
});

describe('the asks it sends to the thread', () => {
  test('planning the evening names the event, the venue and the timing it knows', () => {
    const line = planAsk(tm());
    assert.match(line, /Rosalía/);
    assert.match(line, /O2 Academy/);
    assert.match(line, /Doors in 1h 42m/);
    assert.match(line, /a way home/);
  });

  test('an event with no venue does not ask about “at null”', () => {
    const line = planAsk(ours({ venue: null, sub: null, when: null }));
    assert.doesNotMatch(line, /null|undefined|\bat\b\s*\(/);
  });

  test('getting in asks what it costs instead of asserting a price', () => {
    assert.match(getInAsk(ours()), /what it costs and what you need from me/);
  });
});

describe('the share card repeats the listing and promises nothing', () => {
  test('it is an idea, with the facts and the link', () => {
    const card = shareOf(tm());
    assert.equal(card.kind, 'idea');
    assert.equal(card.title, 'Rosalía');
    assert.match(card.summary, /Rosalía · Doors in 1h 42m · O2 Academy · 400 m/);
    assert.equal(card.link, 'https://www.ticketmaster.co.uk/event/1');
    assert.equal(card.cost, null);
  });
});

describe('opening one is state, not navigation', () => {
  test('the card goes into state whole and comes back out', () => {
    openEventCard(tm());
    assert.equal(store.get().eventView?.id, 'tm_1');
    closeEventCard();
    assert.equal(store.get().eventView, null);
  });
});

describe('the sheet and the rail, as source', () => {
  const SHEET = readFileSync(new URL('../components/app/EventDetailSheet.tsx', import.meta.url), 'utf8');
  const RAIL = readFileSync(new URL('../components/app/TonightStrip.tsx', import.meta.url), 'utf8');
  const bare = (s) => s.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  test('tapping an event no longer throws the traveller out of the app', () => {
    // This is the whole point of the change: window.open on a tap was the
    // flights-tab trap again, one surface over.
    assert.doesNotMatch(bare(RAIL), /window\.open/);
    assert.match(bare(RAIL), /openEventCard\(/);
  });

  test('the sheet fetches nothing — it renders the listing it was handed', () => {
    assert.doesNotMatch(bare(SHEET), /fetch\(|apiUrl\(/);
  });

  test('every link out of the sheet is safe to open', () => {
    for (const tag of bare(SHEET).match(/<a\s[^>]*>/g) ?? []) {
      assert.match(tag, /rel="noopener noreferrer"/, tag);
      assert.match(tag, /target="_blank"/, tag);
    }
  });

  test('nothing in the sheet says booked, held or reserved', () => {
    assert.doesNotMatch(bare(SHEET), /\b(booked|reserved|held for you|confirmed)\b/i);
  });

  test('the price, the button and the seller note all come from the tested module', () => {
    const s = bare(SHEET);
    for (const fn of ['costOf(', 'ticketLabel(', 'sellerNote(', 'factsOf(']) assert.ok(s.includes(fn), fn);
    // No second opinion about money or attribution inside the component.
    assert.doesNotMatch(s, /['"]Free['"]|from \$|Price:/);
  });
});
