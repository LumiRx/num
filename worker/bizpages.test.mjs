// What a plan opens, what the website says a plan opens, and the sign-in link
// that gets a business to either of them.
//
// The drift test at the bottom is the one that matters. On 3 Sep 2026 the two
// pages a business reads before paying sold "API keys and AI agent access" as
// the $50 tier — which nothing gates and never could — and put promotions one
// tier above where the code grants them. Nobody wrote those on purpose; they
// are what a hand-typed marketing table does when DEFAULT_BIZ_TIERS moves
// underneath it. This file is the thing that notices next time.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PAGES, pageFor, opens, cheapestTierFor, tierMatrix } from './bizpages.mjs';
import { DEFAULT_BIZ_TIERS } from './bizbilling.mjs';
import { tiersTable, blockIn } from '../scripts/biz-tiers-table.mjs';
import { mintSigninLink, spendSigninLink, hashToken, signinUrl, SIGNIN_MESSAGE } from './bizsignin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(HERE, ...p), 'utf8');

describe('the page catalogue', () => {
  test('every page says what it is — a nav entry with no explanation is a dead end', () => {
    for (const p of PAGES) {
      assert.ok(p.id && /^[a-z]+$/.test(p.id), `${p.id} is not a usable page id`);
      assert.ok(p.label && p.label.length > 2, `${p.id} has no label`);
      assert.ok(p.blurb && p.blurb.length > 20, `${p.id} does not say what it is`);
      // A gated page must ALSO say what buying it gets you, because that
      // sentence is the only thing on the locked panel worth reading.
      if (p.needs) assert.ok(p.unlock && p.unlock.length > 20, `${p.id} is gated and does not say why`);
    }
  });

  test('an unknown page is the overview, never a 404 and never a crash', () => {
    for (const bad of [undefined, null, '', 'nope', '../../etc/passwd', 'PLAN', 42, {}]) {
      assert.equal(typeof pageFor(bad)?.id, 'string');
    }
    assert.equal(pageFor('PLAN').id, 'plan', 'page ids should not be case-sensitive');
    assert.equal(pageFor('nope').id, 'overview');
  });

  test('the free plan opens almost everything — a listing is not a trial', () => {
    const free = DEFAULT_BIZ_TIERS.free.entitlements;
    const closed = PAGES.filter((p) => !opens(p, free)).map((p) => p.id);
    // Exactly three things are behind a card, and none of them is needed to
    // run a listing, take a booking, or use the API.
    assert.deepEqual(closed.sort(), ['beta', 'locations', 'promotions']);
  });

  test('API access is not gated on any plan — the website has been selling it as $50', () => {
    const api = PAGES.find((p) => p.id === 'api');
    assert.notEqual(typeof api.needs, 'function', 'the API page acquired a gate');
    for (const [id, t] of Object.entries(DEFAULT_BIZ_TIERS)) {
      assert.ok(opens(api, t.entitlements), `API access closed on ${id}`);
    }
    // And the page has to SAY so, on the free plan, in words an owner reads —
    // a correction that lives only in a commit message corrects nobody.
    assert.match(read('bizpages.mjs'), /every plan, including free/i);
  });

  test('a locked page names the cheapest plan that opens it, not just "upgrade"', () => {
    assert.equal(cheapestTierFor('promotions', DEFAULT_BIZ_TIERS).name, 'Small Business');
    assert.equal(cheapestTierFor('locations', DEFAULT_BIZ_TIERS).name, 'Small Business');
    assert.equal(cheapestTierFor('beta', DEFAULT_BIZ_TIERS).name, 'Full');
    assert.equal(cheapestTierFor('listing', DEFAULT_BIZ_TIERS), null, 'an ungated page has no upsell');
  });

  test('the matrix is ordered by price and never sells a downgrade', () => {
    const m = tierMatrix(DEFAULT_BIZ_TIERS);
    for (let i = 1; i < m.length; i++) {
      assert.ok(m[i].price_cents >= m[i - 1].price_cents, 'tiers are out of price order');
      assert.ok(m[i].included.length >= m[i - 1].included.length,
        `${m[i].name} costs more than ${m[i - 1].name} and opens less`);
    }
  });
});

describe('the public pricing page', () => {
  test('it says exactly what the product enforces', () => {
    const html = readFileSync(join(HERE, '..', 'public', 'pricing', 'index.html'), 'utf8');
    const found = blockIn(html);
    assert.ok(found, 'the pricing page has no generated tier block');
    assert.equal(found, tiersTable(DEFAULT_BIZ_TIERS),
      'the pricing page has drifted — run: node scripts/biz-tiers-table.mjs');
  });

  test('neither public page still sells API access as a paid feature', () => {
    for (const page of [['..', 'public', 'pricing', 'index.html'], ['..', 'public', 'business', 'index.html']]) {
      const html = read(...page);
      // The exact claims that were there on 3 Sep. Pinned as strings rather
      // than as a fuzzy match, so this test fails on the sentence rather than
      // on any mention of the API at all.
      assert.ok(!/plus API keys and AI agent access/i.test(html), `${page.at(-2)} still sells API access`);
      assert.ok(!/\$50 a month for API and agent access/i.test(html), `${page.at(-2)} still sells API access`);
      assert.ok(!/adds promotions and multi-location/i.test(html),
        `${page.at(-2)} still puts promotions on the wrong tier`);
    }
  });
});

/* ── the sign-in link ───────────────────────────────────────────────────── */

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
      st.run(...args); return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = { DB: d1(db) };

before(() => {
  db.exec(`CREATE TABLE num_biz_signin_links (token_hash TEXT PRIMARY KEY, place_id TEXT NOT NULL,
    business_id TEXT, purpose TEXT NOT NULL DEFAULT 'welcome', expires_at TEXT NOT NULL,
    used_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
});
beforeEach(() => { db.exec('DELETE FROM num_biz_signin_links'); });

describe('the welcome sign-in link', () => {
  test('it works once, and the second click is refused', async () => {
    const t = await mintSigninLink(env, { placeId: 'pl_suay' });
    assert.equal((await spendSigninLink(env, t)).place_id, 'pl_suay');
    const again = await spendSigninLink(env, t);
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'used',
      'a forwarded welcome email would have signed a stranger in');
  });

  test('the database never holds a usable token', async () => {
    const t = await mintSigninLink(env, { placeId: 'pl_suay' });
    const row = db.prepare('SELECT token_hash FROM num_biz_signin_links').get();
    assert.notEqual(row.token_hash, t);
    assert.equal(row.token_hash, await hashToken(t));
    assert.equal(row.token_hash.length, 64, 'that is not a SHA-256');
  });

  test('an expired link is refused, and says which failure it was', async () => {
    const t = await mintSigninLink(env, { placeId: 'pl_suay', ttlDays: 1 });
    db.exec(`UPDATE num_biz_signin_links SET expires_at = datetime('now','-1 day')`);
    const out = await spendSigninLink(env, t);
    assert.equal(out.reason, 'expired');
    // Distinct reasons, because an expired link and a used one need different
    // next sentences and "that didn't work" is the least useful of the three.
    assert.notEqual(SIGNIN_MESSAGE.expired, SIGNIN_MESSAGE.used);
    assert.notEqual(SIGNIN_MESSAGE.used, SIGNIN_MESSAGE.missing);
  });

  test('a token nobody minted opens nothing', async () => {
    assert.equal((await spendSigninLink(env, 'f'.repeat(64))).ok, false);
    assert.equal((await spendSigninLink(env, '')).ok, false);
    assert.equal((await spendSigninLink(env, null)).ok, false);
  });

  test('two simultaneous clicks cannot both win', async () => {
    // The UPDATE carries `used_at IS NULL` in its WHERE clause, so the database
    // decides the race. Read-then-write would let both through, which is the
    // difference between single-use and single-use-most-of-the-time.
    const t = await mintSigninLink(env, { placeId: 'pl_suay' });
    const both = await Promise.all([spendSigninLink(env, t), spendSigninLink(env, t)]);
    assert.equal(both.filter((r) => r.ok).length, 1);
  });

  test('the link the email carries is a token, never the business key', () => {
    const url = signinUrl('https://app.itsnum.com', 'abc123');
    assert.match(url, /\/api\/biz\/console\?t=abc123$/);
    assert.ok(!url.includes('numbiz_'));
  });

  test('the welcome email carries it, and the console spends it', () => {
    const onboard = read('bizonboard.mjs');
    assert.match(onboard, /mintSigninLink/, 'the welcome email still links to a search box');
    assert.match(onboard, /works once/i, 'the email does not tell them the link is single-use');
    const console_ = read('bizconsole.mjs');
    assert.match(console_, /spendSigninLink/);
    // The redirect is what keeps the one-time token out of the address bar,
    // out of a referrer, and out of a bookmark. Without it the link is a
    // credential sitting in a URL, which is the thing bizonboard refused.
    assert.match(console_, /status: 302/);
    assert.match(console_, /'Referrer-Policy': 'no-referrer'/);
  });
});
