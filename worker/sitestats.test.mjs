import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATS, assertLabelled, friendly, collect, handleSiteStats, SHOW_FROM, showFloor } from './sitestats.mjs';

const fakeDb = (counts) => ({
  DB: {
    prepare(sql) {
      return {
        first: async () => {
          for (const [key, def] of Object.entries(STATS)) {
            if (def.sql === sql) return { n: counts[key] ?? 0 };
          }
          return null;
        },
      };
    },
  },
});

const REAL = { places: 2701320, countries: 38, destinations: 104, members: 151, businesses: 6, claimed: 3 };

describe('a number cannot travel without what it counts', () => {
  test('a stat labelled as something else throws', () => {
    // The whole point. "2.7 million businesses" and "2.7 million places in a
    // directory" describe the same table and only one may be published.
    assert.throws(
      () => assertLabelled({ places: { n: 2701320, label: 'businesses with an account' } }),
      /counts places in the directory/,
    );
  });

  test('and the error says what it must never be published as', () => {
    try {
      assertLabelled({ places: { n: 2701320, label: 'businesses with an account' } });
      assert.fail('should have thrown');
    } catch (e) {
      assert.match(e.message, /a directory listing is not a relationship/);
    }
  });

  test('an undefined stat throws rather than passing through', () => {
    assert.throws(() => assertLabelled({ partners: { n: 900, label: 'partners' } }), /not a defined stat/);
  });

  test('a missing or non-finite count throws', () => {
    for (const bad of [undefined, null, NaN, Infinity, '2701320']) {
      assert.throws(() => assertLabelled({ places: { n: bad, label: 'places in the directory' } }), /no finite count/);
    }
  });

  test('every defined stat says what it must never be called', () => {
    for (const [k, def] of Object.entries(STATS)) {
      assert.ok(def.label, `${k} has no label`);
      assert.ok(def.claim, `${k} has no claim`);
      assert.ok(def.never && def.never.length > 20, `${k} has no written-down wrong version`);
    }
  });

  test('the places stat names the businesses confusion specifically', () => {
    assert.match(STATS.places.never, /businesses on Num/);
  });

  test('the businesses stat forbids borrowing from the places table', () => {
    assert.match(STATS.businesses.never, /four orders of magnitude/);
  });

  test('claimed is not allowed to be called verified', () => {
    assert.match(STATS.claimed.never, /Claimed means somebody said it is theirs/);
  });

  test('members is not allowed to be called active users', () => {
    assert.match(STATS.members.never, /active users/);
  });

  test('entry countries may not be read as a visa service', () => {
    assert.match(STATS.entry_countries.never, /not a visa service/);
  });
});

describe('rounding only ever goes down', () => {
  test('2,701,320 is 2.7M+, never 3M', () => {
    assert.equal(friendly(2701320), '2.7M+');
  });

  test('a number just under a round one does not get promoted', () => {
    // 2,999,999 rounding to "3M" would be inventing 1 place. Small, and the
    // exact habit that ends with a headline nobody can defend.
    assert.equal(friendly(2999999), '2.9M+');
    assert.equal(friendly(1999999), '1.9M+');
    assert.equal(friendly(9999), '9.9k+');
  });

  test('small numbers are given exactly, not dressed up', () => {
    assert.equal(friendly(104), '104');
    assert.equal(friendly(6), '6');
    assert.equal(friendly(0), '0');
  });

  test('rubbish is null rather than a friendly lie', () => {
    for (const bad of [null, undefined, NaN, -5, 'lots']) assert.equal(friendly(bad), null);
  });
});

describe('a number too small to be a proof point', () => {
  test('six businesses is returned, but flagged not to show', async () => {
    // Putting "6 businesses" in a stat strip is worse than showing no
    // business tile. Flagged rather than quietly inflated.
    const r = await collect(fakeDb(REAL));
    assert.equal(r.stats.businesses.n, 6);
    assert.equal(r.stats.businesses.show, false);
    assert.equal(r.stats.claimed.show, false);
  });

  test('the big ones are cleared to show', async () => {
    const r = await collect(fakeDb(REAL));
    for (const k of ['places', 'countries', 'destinations', 'members']) {
      assert.equal(r.stats[k].show, true, k);
    }
  });

  test('the threshold is a named constant, not a magic number', () => {
    assert.equal(typeof SHOW_FROM, 'number');
    assert.ok(SHOW_FROM >= 100);
  });

  test('the floor is per stat, because impressive is not one magnitude', () => {
    // 38 countries is a strong number; 6 businesses is not; they would sit
    // three tiles apart on the same strip. One global cut-off either hides
    // the countries or shows the businesses.
    assert.ok(showFloor('countries') < showFloor('businesses'));
    assert.equal(showFloor('businesses'), SHOW_FROM);
  });

  test('38 countries shows and 6 businesses does not', async () => {
    const r = await collect(fakeDb(REAL));
    assert.equal(r.stats.countries.show, true);
    assert.equal(r.stats.businesses.show, false);
  });
});

describe('the real numbers', () => {
  test('the site was understating places by a factor of five', async () => {
    // The homepage said "more than half a million". Counted: 2,701,320.
    const r = await collect(fakeDb(REAL));
    assert.equal(r.stats.places.friendly, '2.7M+');
    assert.ok(r.stats.places.n > 500000 * 5);
  });

  test('destinations is 104, not the 77 still on some pages', async () => {
    const r = await collect(fakeDb(REAL));
    assert.equal(r.stats.destinations.n, 104);
  });

  test('the two code-counted stats come from the checked tables', async () => {
    const r = await collect(fakeDb(REAL));
    assert.ok(r.stats.emergency_countries.n >= 30);
    assert.ok(r.stats.entry_countries.n >= 30);
    assert.match(r.stats.emergency_countries.claim, /checked emergency number rather than a guess/);
  });

  test('a query that fails drops its tile instead of showing zero', async () => {
    const broken = { DB: { prepare() { return { first: async () => { throw new Error('no table'); } }; } } };
    const r = await collect(broken);
    assert.equal(r.ok, true);
    assert.equal(r.stats.places, undefined);
    // The code-counted ones still arrive.
    assert.ok(r.stats.emergency_countries.n >= 30);
  });

  test('no database is an honest failure, not zeros', async () => {
    const r = await collect({});
    assert.equal(r.ok, false);
    assert.deepEqual(r.stats, {});
  });
});

describe('the route', () => {
  const call = (env) => handleSiteStats(new Request('https://itsnum.com/api/site/stats'), env);

  test('it answers with labelled stats', async () => {
    const body = await (await call(fakeDb(REAL))).json();
    assert.equal(body.ok, true);
    assert.equal(body.stats.places.label, 'places in the directory');
    assert.equal(body.stats.places.friendly, '2.7M+');
  });

  test('it is cached, because a homepage must not count 2.7m rows per visit', async () => {
    const res = await call(fakeDb(REAL));
    assert.match(res.headers.get('cache-control'), /s-maxage=3600/);
  });

  test('a failure is 503 and uncached, never a cached page of zeros', async () => {
    const res = await call({});
    assert.equal(res.status, 503);
    assert.match(res.headers.get('cache-control'), /no-store/);
  });

  test('it is readable from the marketing site on another origin', async () => {
    const res = await call(fakeDb(REAL));
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  test('every claim in the file is a sentence somebody could check', () => {
    const src = readFileSync(new URL('./sitestats.mjs', import.meta.url), 'utf8');
    assert.match(src, /telling the truth\s+\* here RAISES every number/);
  });
});

describe('the pages cannot go stale again', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const PAGES = [
    'public/index.html', 'public/app/index.html', 'public/ask/index.html',
    'public/faq/index.html', 'public/list-your-business/index.html',
    'public/agents/index.html', 'app-public/install/index.html',
  ];

  test('no page still carries a number we have outgrown', () => {
    // "more than half a million" was on six pages while the directory held
    // 2,701,320 — Num undersold itself fivefold for months because a number
    // was typed into HTML once and never counted again.
    for (const f of PAGES) {
      const src = read(f);
      for (const stale of ['half a million', '2.5 million', '2.5M+', '77 destinations']) {
        assert.equal(src.includes(stale), false, `${f} still says "${stale}"`);
      }
    }
  });

  test('every page with a live number loads the script that updates it', () => {
    for (const f of PAGES) {
      const src = read(f);
      if (!src.includes('data-stat=')) continue;
      assert.match(src, /assets\/sitestats\.js/, `${f} has live stats but never fetches them`);
    }
  });

  test('every data-stat name is a real stat', () => {
    for (const f of PAGES) {
      for (const m of read(f).matchAll(/data-stat="([a-z_]+)"/g)) {
        assert.ok(STATS[m[1]], `${f} asks for "${m[1]}", which is not a defined stat`);
      }
    }
  });

  test('the fallback written in the HTML is never larger than the truth', () => {
    // The script refuses to shrink a number, so a fallback bigger than the
    // real count would stick forever. 2.7M+ against 2,701,320 is correct.
    for (const f of PAGES) {
      for (const m of read(f).matchAll(/data-stat="places"[^>]*>([^<]+)</g)) {
        assert.equal(m[1].trim(), '2.7M+', `${f} has a places fallback of "${m[1]}"`);
      }
    }
  });

  test('the homepage no longer calls all 2.7 million places verified', () => {
    // NUM's own FAQ says: "Unclaimed listings are mapped, not verified."
    // Three places are claimed. The hero used to apply "verified" to every
    // one of them, contradicting the definition on its own site.
    const home = read('public/index.html');
    assert.equal(/real, verified<\/b> local places/.test(home), false);
    assert.match(home, /Claimed places are marked verified; the rest are mapped/);
  });

  test('the FAQ definition of verified is intact, because the hero now matches it', () => {
    const faq = read('public/faq/index.html');
    assert.match(faq, /Unclaimed listings are mapped, not verified/);
  });

  test('the route is wired', () => {
    assert.match(read('worker/index.mjs'), /url\.pathname === '\/api\/site\/stats'/);
  });

  test('the updater keeps working when the API does not', () => {
    const js = read('public/assets/sitestats.js');
    assert.match(js, /catch/);
    assert.match(js, /the fallback in the HTML stands/);
  });

  test('a stat that comes back smaller is refused, not applied', () => {
    const js = read('public/assets/sitestats.js');
    assert.match(js, /came back smaller than the page says/);
  });
});
