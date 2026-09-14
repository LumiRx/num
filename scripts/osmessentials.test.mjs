import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ESSENTIALS_QUERY, ESSENTIAL_CATMAP, LIFE_CRITICAL, CATMAP,
  essentialRaw, normalise, isBusiness,
} from './osmplace.mjs';

const DEST = { slug: 'bangkok', country: 'TH', region: 'Asia' };
const el = (tags) => ({ tags, lat: 13.7563, lon: 100.5018 });
const norm = (tags, opts = { essentials: true }) => normalise(el(tags), DEST, () => null, opts);

describe('the selector asks for what the old one never did', () => {
  const q = ESSENTIALS_QUERY('1,2,3,4');

  test('every category the directory was missing is in the query', () => {
    // These are exactly the amenities CORE_QUERY does not mention, which is
    // why the directory holds 22,026 hospitals with hours on 20 of them.
    for (const a of ['hospital', 'clinic', 'doctors', 'police', 'bank', 'atm', 'post_office', 'pharmacy']) {
      assert.ok(q.includes(a), `${a} is not in the essentials query`);
    }
  });

  test('the bbox is interpolated into every clause', () => {
    const clauses = q.split('\n').filter((l) => l.trim().startsWith('nwr'));
    assert.ok(clauses.length >= 5);
    for (const c of clauses) assert.ok(c.includes('(1,2,3,4)'), c);
  });

  test('the query has no negated regex in it', () => {
    // A negation makes Overpass walk every amenity in the tile and public
    // mirrors answer a country-sized run of that with 504s. The junk filter
    // lives in isBusiness, in JavaScript, where it can be tested.
    assert.equal(/!~/.test(q), false);
  });

  test('it is narrower than the full selector, which is the whole point', () => {
    const src = readFileSync(new URL('./osmplace.mjs', import.meta.url), 'utf8');
    const full = src.slice(src.indexOf('export const FULL_QUERY'));
    // FULL_QUERY asks for bare tag families; essentials never does.
    assert.match(full, /nwr\["amenity"\]\["name"\]/);
    assert.equal(/nwr\["amenity"\]\[/.test(q), false);
  });

  test('a hospital is not required to have a name', () => {
    // Every other selector in this file demands ["name"]. An unnamed clinic
    // is still a clinic, and this is the one place that matters.
    const line = q.split('\n').find((l) => l.includes('hospital'));
    assert.equal(line.includes('["name"]'), false);
  });

  test('a station and an aerodrome still are, because an unnamed one is useless', () => {
    assert.match(q, /railway"="station"\]\["name"\]/);
    assert.match(q, /aeroway"="aerodrome"\]\["name"\]/);
  });

  test('the timeout is generous, because these run over whole countries', () => {
    assert.match(q, /\[timeout:300\]/);
  });
});

describe('naming what comes back', () => {
  test('the categories a traveller would ask for', () => {
    assert.equal(norm({ amenity: 'hospital', name: 'Bumrungrad' }).category, 'Hospital');
    assert.equal(norm({ amenity: 'police', name: 'Lumpini' }).category, 'Police');
    assert.equal(norm({ amenity: 'atm', name: 'SCB' }).category, 'ATM');
    assert.equal(norm({ amenity: 'bureau_de_change', name: 'SuperRich' }).category, 'Currency exchange');
    assert.equal(norm({ shop: 'chemist', name: 'Watsons' }).category, 'Pharmacy');
    assert.equal(norm({ healthcare: 'laboratory', name: 'Lab' }).category, 'Medical lab');
  });

  test('an embassy is an embassy and not "Diplomatic"', () => {
    // office=diplomatic used to go through titled() and arrive as the string
    // 'Diplomatic', matching nothing in either map. Named so it stays fixed.
    assert.equal(norm({ office: 'diplomatic', name: 'Embassy of France' }).category, 'Embassy or consulate');
  });

  test('a station is a station and not the literal word "business"', () => {
    // railway=station matched no branch of the raw chain and fell all the way
    // through to the fallback string.
    const r = norm({ railway: 'station', name: 'Hua Lamphong' });
    assert.equal(r.category, 'Transport');
    assert.notEqual(r.category, 'Business');
  });

  test('an unnamed essential is named for what it is', () => {
    assert.equal(norm({ amenity: 'hospital' }).name, 'Hospital');
    assert.equal(norm({ amenity: 'atm' }).name, 'ATM');
  });

  test('an unnamed anything-else is still dropped', () => {
    // The fallback is for essentials only. An unnamed restaurant is noise.
    assert.equal(norm({ amenity: 'restaurant' }), null);
    assert.equal(norm({ amenity: 'hospital' }, { essentials: false }), null);
  });

  test('a real name always beats the category fallback', () => {
    assert.equal(norm({ amenity: 'hospital', name: 'Siriraj' }).name, 'Siriraj');
  });

  test('opening hours survive the trip, which is the reason for all of this', () => {
    const r = norm({ amenity: 'pharmacy', name: 'Boots', opening_hours: 'Mo-Su 09:00-22:00' });
    assert.equal(r.hours, 'Mo-Su 09:00-22:00');
  });

  test('24/7 is carried through exactly, not reworded', () => {
    assert.equal(norm({ amenity: 'hospital', name: 'X', opening_hours: '24/7' }).hours, '24/7');
  });

  test('a phone comes through from either tag', () => {
    assert.equal(norm({ amenity: 'clinic', name: 'A', phone: '+66 2 000 0000' }).phone, '+66 2 000 0000');
    assert.equal(norm({ amenity: 'clinic', name: 'B', 'contact:phone': '+66 2 111 1111' }).phone, '+66 2 111 1111');
  });
});

describe('the two maps do not fight', () => {
  test('no key means two different categories depending on the path', () => {
    for (const k of Object.keys(ESSENTIAL_CATMAP)) {
      if (k in CATMAP) {
        assert.equal(CATMAP[k], ESSENTIAL_CATMAP[k],
          `${k} is '${CATMAP[k]}' on one ingest path and '${ESSENTIAL_CATMAP[k]}' on another`);
      }
    }
  });

  test('a hospital is a Hospital even on the full selector', () => {
    // ESSENTIAL_CATMAP is consulted unconditionally. Without that, the same
    // building gets a different category depending on which run found it.
    assert.equal(norm({ amenity: 'hospital', name: 'X' }, { essentials: false }).category, 'Hospital');
    assert.equal(norm({ amenity: 'police', name: 'Y' }, { essentials: false }).category, 'Police');
  });

  test('essentialRaw follows the same precedence normalise does', () => {
    assert.equal(essentialRaw({ amenity: 'pharmacy', shop: 'chemist' }), 'pharmacy');
    assert.equal(essentialRaw({ healthcare: 'clinic', shop: 'chemist' }), 'clinic');
    assert.equal(essentialRaw({ shop: 'chemist' }), 'chemist');
    assert.equal(essentialRaw({ amenity: 'restaurant' }), null);
    assert.equal(essentialRaw(null), null);
  });

  test('the life-critical list is a subset of what the ingest collects', () => {
    const produced = new Set(Object.values(ESSENTIAL_CATMAP));
    for (const c of LIFE_CRITICAL) {
      assert.ok(produced.has(c), `${c} is called life-critical but no ingest path produces it`);
    }
  });
});

describe('the junk filter still holds', () => {
  test('a bench does not become a place because the selector widened', () => {
    assert.equal(isBusiness({ amenity: 'bench', name: 'A bench' }), false);
    assert.equal(isBusiness({ amenity: 'toilets' }), false);
  });

  test('a station and an aerodrome are allowed through it', () => {
    assert.equal(isBusiness({ railway: 'station' }), true);
    assert.equal(isBusiness({ aeroway: 'aerodrome' }), true);
  });

  test('a railway halt is not a station', () => {
    assert.equal(isBusiness({ railway: 'halt' }), false);
    assert.equal(isBusiness({ railway: 'level_crossing' }), false);
  });
});

describe('the runner cannot silently do nothing', () => {
  const RUN = readFileSync(new URL('./ingest_cover.mjs', import.meta.url), 'utf8');

  test('the tile state is keyed by selector, not only by country', () => {
    // Keyed by country alone, an --essentials run over a country already
    // walked by --core reads the old state, sees every tile done, and exits
    // in seconds having collected no hospitals.
    assert.match(RUN, /const SELECTOR = ESSENTIALS \? 'essentials'/);
    assert.match(RUN, /\.ingest_cover_\$\{COUNTRY \|\| 'none'\}_\$\{SELECTOR\}\.json/);
  });

  test('essentials wins over core rather than quietly running the wrong query', () => {
    assert.match(RUN, /ESSENTIALS \? ESSENTIALS_QUERY : CORE \? CORE_QUERY : FULL_QUERY/);
  });

  test('the essentials flag reaches normalise, or the name fallback never fires', () => {
    assert.match(RUN, /normalise\(el, d, pickLocalName, \{ essentials: ESSENTIALS \}\)/);
  });

  test('the run says which selector it used', () => {
    assert.match(RUN, /ESSENTIALS \? 'essentials' : CORE \? 'core' : 'full'/);
  });
});
