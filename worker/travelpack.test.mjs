import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PACK_PRICE_USD, PACK_RULES, KIND, assertSellable, buildPack, handlePack,
} from './travelpack.mjs';
import { isOfficial, isPublicHealth } from './traveldocs.mjs';

const PACK = buildPack({ to: 'TH', nationality: 'US', tripDate: '2026-12-01', from: ['BR'] });

describe('the line Num must never cross', () => {
  test('a government link cannot be sold, and the attempt throws', () => {
    assert.throws(
      () => assertSellable([{ kind: KIND.OFFICIAL_LINK.id, paid: true, title: 'Thailand arrival card' }]),
      /cannot be sold/,
    );
  });

  test('nor can a government form', () => {
    assert.throws(
      () => assertSellable([{ kind: KIND.OFFICIAL_FORM.id, paid: true, title: 'e-visa form' }]),
      /cannot be sold/,
    );
  });

  test('nor a requirement, an emergency number, or a consulate', () => {
    for (const k of [KIND.REQUIREMENT, KIND.EMERGENCY, KIND.CONSULATE]) {
      assert.throws(() => assertSellable([{ kind: k.id, paid: true, title: 'x' }]), /cannot be sold/);
    }
  });

  test('the refusal is not negotiable and the message says so', () => {
    try {
      assertSellable([{ kind: KIND.OFFICIAL_LINK.id, paid: true, title: 'x' }]);
      assert.fail('should have thrown');
    } catch (e) {
      assert.match(e.message, /If this needs to change, it does not/);
    }
  });

  test('an unknown item kind throws rather than defaulting to sellable', () => {
    assert.throws(() => assertSellable([{ kind: 'bundle', paid: true, title: 'x' }]), /unknown item kind/);
  });

  test('in every real pack, every free-kind item is actually free', () => {
    for (const cc of ['TH', 'FR', 'GH', 'JP', 'CO', 'SA', 'QA']) {
      const p = buildPack({ to: cc, nationality: 'GB', tripDate: '2026-12-01' });
      for (const it of p.items) {
        const kind = Object.values(KIND).find((k) => k.id === it.kind);
        if (kind.free) assert.equal(it.paid, false, `${cc}: ${it.title}`);
      }
    }
  });

  test('only Num’s own work is ever behind the price', () => {
    const paidKinds = new Set(PACK.paid.map((i) => i.kind));
    assert.deepEqual([...paidKinds].sort(), ['checklist', 'printable', 'timeline']);
  });
});

describe('where the links go', () => {
  test('a link to a host on neither allowlist throws', () => {
    assert.throws(
      () => assertSellable([{ kind: KIND.REQUIREMENT.id, paid: false, title: 'x', url: 'https://ivisa.com/thailand' }]),
      /neither verified allowlist/,
    );
  });

  test('http is refused even on an allowlisted host', () => {
    assert.throws(
      () => assertSellable([{ kind: KIND.REQUIREMENT.id, paid: false, title: 'x', url: 'http://www.gov.uk/x' }]),
      /neither verified allowlist/,
    );
  });

  test('a health authority may never appear as an entry document', () => {
    // WHO does not issue visas. A health source under a document heading is
    // Num blurring the exact line it protects people at.
    assert.throws(
      () => assertSellable([{ kind: KIND.OFFICIAL_LINK.id, paid: false, title: 'x', url: 'https://www.who.int/travel-advice' }]),
      /citing a health authority/,
    );
  });

  test('every link in a real pack is on one of the two lists, and is labelled which', () => {
    for (const cc of ['TH', 'FR', 'GH', 'SA', 'QA', 'CO']) {
      const p = buildPack({ to: cc, nationality: 'GB', tripDate: '2026-12-01' });
      for (const it of p.items) {
        if (!it.url) continue;
        assert.ok(isOfficial(it.url) || isPublicHealth(it.url), `${cc}: ${it.url}`);
        assert.ok(['government', 'public health authority'].includes(it.sourceKind), `${cc}: ${it.title}`);
      }
    }
  });

  test('a scheme operator is carried separately and always labelled', () => {
    // longstay.tgia.org runs Thailand's long-stay insurance scheme. It is not
    // a government, and a traveller who cannot tell the difference is the
    // traveller a copycat site catches.
    const p = buildPack({ to: 'TH', nationality: 'GB', tripDate: '2026-12-01' });
    const ins = p.items.find((i) => i.schemeOperator);
    assert.ok(ins, 'the Thai scheme operator vanished from the pack');
    assert.match(ins.schemeOperatorLabel, /not a government site/);
    assert.notEqual(ins.url, ins.schemeOperator);
  });
});

describe('what the page has to say', () => {
  test('the promise says the documents are free', () => {
    assert.match(PACK.promise, /free and comes straight from the government/);
  });

  test('and says what the dollar is actually for', () => {
    assert.match(PACK.promise, /for putting it together, checking it and dating it/);
  });

  test('and says the free route needs no account', () => {
    assert.match(PACK.promise, /free, any time — no account/);
  });

  test('and denies being a visa service, in the promise itself', () => {
    // Not in a footer. Where the price is.
    assert.match(PACK.promise, /not a visa service/);
    assert.match(PACK.promise, /cannot apply for anything on your behalf/);
  });

  test('the price is one dollar and lives in exactly one place', () => {
    assert.equal(PACK_PRICE_USD, 1);
    assert.equal(PACK.priceUsd, 1);
    const src = readFileSync(new URL('./travelpack.mjs', import.meta.url), 'utf8');
    assert.equal((src.match(/PACK_PRICE_USD = /g) ?? []).length, 1);
  });

  test('the rules travel with the pack rather than living in a wiki', () => {
    assert.ok(PACK.rules.length >= 5);
    assert.ok(PACK.rules.some((r) => /never slower or harder to find/.test(r)));
    assert.ok(PACK.rules.some((r) => /never describes itself as a visa service/.test(r)));
  });
});

describe('the pack itself', () => {
  test('a destination with real requirements produces real items', () => {
    assert.equal(PACK.ok, true);
    assert.ok(PACK.free.length >= 3);
    assert.equal(PACK.paid.length, 3);
  });

  test('no destination, no pack', () => {
    assert.equal(buildPack({}).ok, false);
    assert.equal(buildPack({ to: 'THA' }).ok, false);
  });

  test('a country with nothing to report still offers the assembled pack honestly', () => {
    const p = buildPack({ to: 'JP', nationality: 'US', tripDate: '2027-03-01' });
    assert.equal(p.ok, true);
    assert.equal(p.paid.length, 3);
  });

  test('the days-out count reaches the timeline, because the order is the product', () => {
    const p = buildPack({ to: 'TH', tripDate: '2026-12-01', now: new Date('2026-09-14T00:00:00Z') });
    assert.equal(p.daysOut, 78);
    assert.match(p.paid.find((i) => i.kind === 'timeline').title, /78 days out/);
  });

  test('no date is not a crash, and the timeline says nothing it cannot know', () => {
    const p = buildPack({ to: 'TH' });
    assert.equal(p.daysOut, null);
    assert.equal(p.paid.find((i) => i.kind === 'timeline').title, 'Your timeline');
  });

  test('a garbled date is null, not a negative countdown', () => {
    for (const d of ['soon', '2026-13-45', '01/12/2026', '']) {
      assert.equal(buildPack({ to: 'TH', tripDate: d }).daysOut, null, d);
    }
  });

  test('entry documents are never resolved to "you need this"', () => {
    // Whether THIS traveller needs THIS document depends on their passport,
    // their purpose and their length of stay. Num sees at most one of those.
    const p = buildPack({ to: 'TH', nationality: 'US', tripDate: '2026-12-01' });
    for (const it of p.items.filter((i) => i.kind === 'official_link')) {
      assert.match(it.appliesTo, /the official page decides/);
    }
  });

  test('what could not be verified is in the pack, not hidden', () => {
    const p = buildPack({ to: 'TH', nationality: 'US', tripDate: '2026-12-01', from: ['BR'] });
    assert.ok(p.unverified.length);
    assert.ok(p.unverified.some((u) => /36%/.test(u)));
  });

  test('a country whose insurance rule Num could not confirm says so instead of asserting it', () => {
    const p = buildPack({ to: 'CU', nationality: 'GB', tripDate: '2026-12-01' });
    assert.ok(p.unverified.some((u) => /Cuba/.test(u)));
    assert.equal(p.items.some((i) => /insurance is a condition/i.test(i.title)), false);
  });

  test('the lifetime-certificate fact rides along wherever yellow fever appears', () => {
    for (const cc of ['GH', 'TH', 'CO']) {
      const p = buildPack({ to: cc, nationality: 'GB', tripDate: '2026-12-01' });
      assert.ok(p.items.some((i) => /valid for life/i.test(i.title)), cc);
    }
  });

  test('a consulate item only appears when Num knows the passport', () => {
    const with_ = buildPack({ to: 'TH', nationality: 'US', tripDate: '2026-12-01' });
    const without = buildPack({ to: 'TH', tripDate: '2026-12-01' });
    assert.ok(with_.items.some((i) => i.kind === 'consulate'));
    assert.equal(without.items.some((i) => i.kind === 'consulate'), false);
  });
});

describe('the route', () => {
  const call = (qs) => handlePack(new Request(`https://app.itsnum.com/api/travel/pack${qs}`));

  test('a bad destination is a 400', async () => {
    assert.equal((await call('')).status, 400);
    assert.equal((await call('?to=x')).status, 400);
  });

  test('a real one returns the pack with its price and its promise', async () => {
    const b = await (await call('?to=TH&nationality=US&date=2026-12-01')).json();
    assert.equal(b.ok, true);
    assert.equal(b.priceUsd, 1);
    assert.match(b.promise, /not a visa service/);
  });

  test('a refused pack is a 500 and is loud about it', async () => {
    // assertSellable throwing is a bug in Num, not a bad request — and a pack
    // that silently dropped the offending item would be the exact failure the
    // guard exists to prevent.
    const src = readFileSync(new URL('./travelpack.mjs', import.meta.url), 'utf8');
    assert.match(src, /status: 500/);
    assert.match(src, /pack refused/);
    assert.match(src, /must be loud/);
  });

  test('the free list and the paid list are both returned, separately', async () => {
    const b = await (await call('?to=GH&nationality=GB&date=2026-10-20')).json();
    assert.ok(Array.isArray(b.free));
    assert.ok(Array.isArray(b.paid));
    assert.equal(b.free.length + b.paid.length, b.items.length);
  });
});

describe('the turn is actually wired', () => {
  const read = (f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
  const IDX = read('index.mjs');
  const PROMPT = read('prompt.mjs');

  test('vaccinations and insurance reach the context together', () => {
    // Split across turns, a traveller hears about the visa on Monday and the
    // yellow fever certificate on Thursday — ten days after the deadline.
    assert.match(PROMPT, /contextBlock\(\{[\s\S]{0,700}?\bhealth = null\b/);
    assert.match(PROMPT, /if \(health\) lines\.push\(health\)/);
    assert.match(IDX, /vaccinesFor, vaccineBlock/);
    assert.match(IDX, /insuranceFor, insuranceBlock/);
    assert.match(IDX, /health,/);
  });

  test('they ride with the entry documents rather than on their own trigger', () => {
    assert.match(IDX, /if \(entryDocs && grounding\?\.place\?\.country_code\)/);
  });

  test('a failure in either one cannot take the turn down', () => {
    const slice = IDX.slice(IDX.indexOf('let health = null;'), IDX.indexOf('const groundingBlock'));
    assert.match(slice, /\} catch \{/);
  });

  test('all three routes exist', () => {
    for (const r of ['vaccines', 'insurance', 'pack']) {
      assert.match(IDX, new RegExp(`url\\.pathname === '/api/travel/${r}'`), r);
    }
  });

  test('the persona is told what Num sells and what it does not', () => {
    assert.match(PROMPT, /NUM SELLS ASSEMBLY, NEVER PAPERWORK/);
    assert.match(PROMPT, /Never describe Num as a visa service/);
    assert.match(PROMPT, /the free version is never slower or harder to find/);
  });

  test('the persona is told not to resolve a route it cannot see', () => {
    assert.match(PROMPT, /NEVER as "you do not need it"/);
    assert.match(PROMPT, /valid for life/);
    assert.match(PROMPT, /never present any of this as medical advice/i);
  });
});
