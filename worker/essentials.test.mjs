/**
 * THE ESSENTIALS, AND THE TWO WAYS THIS LAYER CAN HURT SOMEBODY.
 *
 * Dre, 14 Sep 2026: "lets connect the embassy's hospitals and all essentials
 * are also connected. easy to find."
 *
 * Counting the directory first changed the design twice.
 *
 * ── ONE: AN EMBASSY IS NOT A NEARBY PLACE ────────────────────────────────
 *
 * The places table holds ZERO embassies, and it should. Which mission
 * somebody needs depends on THEIR PASSPORT, not on what is nearest — a
 * Canadian in Bangkok needs the Canadian embassy, and the nearest embassy to
 * them is almost certainly some other country's. A geographic index answers
 * the wrong question however many rows it holds.
 *
 * So Num links the traveller's own ministry's directory, and an unknown
 * nationality is ASKED rather than guessed. The person asking this question
 * has usually just lost a passport, and is the least equipped person alive
 * to tell a ministry from a paid service that looks like one.
 *
 * ── TWO: "OPEN NOW" IS A CLAIM NUM MOSTLY CANNOT MAKE ────────────────────
 *
 * Opening hours, counted 14 Sep 2026:
 *   Hospital 22,026 rows → 20 with hours (0.09%)
 *   Pharmacy 37,301 rows → 4,978 with hours (13.3%)
 *
 * For a hospital that barely matters — an emergency department does not
 * close. For a pharmacy it matters enormously, because "is it open" IS the
 * question at midnight, and Num knows for one in eight. Somebody ill walking
 * across a city to a shut chemist is the worst thing this layer can do, and
 * these tests exist to keep the block saying so.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ESSENTIALS, MISSIONS, THIN, essentialByKey, essentialsBlock,
  handleEssentials, missionFor, missionUrlsAreOfficial,
} from './essentials.mjs';
import { isOfficial } from './traveldocs.mjs';

describe('an embassy is found by passport, never by proximity', () => {
  test('every mission directory is an official government address', () => {
    assert.equal(missionUrlsAreOfficial(), true);
    for (const [cc, m] of Object.entries(MISSIONS)) {
      assert.ok(isOfficial(m.url), `${cc} → ${m.url}`);
    }
  });

  test('a known passport gets its own ministry, not the nearest building', () => {
    const ca = missionFor('CA');
    assert.equal(ca.known, true);
    assert.match(ca.url, /travel\.gc\.ca/);
    assert.match(missionFor('gb').url, /gov\.uk\/world\/embassies/);
  });

  test('an unknown passport is admitted, never approximated', () => {
    // The search results for consular help are thick with paid services
    // dressed as ministries. A plausible guess here is the harm.
    for (const cc of ['BR', 'ZZ', '', null, 'CANADA']) {
      assert.equal(missionFor(cc).known, false, String(cc));
      assert.equal(missionFor(cc).url, undefined, String(cc));
    }
  });

  test('the block tells the model to ASK rather than search', () => {
    const b = essentialsBlock({ nationality: null, place: 'Bangkok' });
    assert.match(b, /ASK which passport they hold rather than guessing or searching/);
    assert.match(b, /police report comes FIRST/, 'every mission asks for it');
  });

  test('with a passport, the link is handed over exactly and the trap is named', () => {
    const b = essentialsBlock({ nationality: 'CA', place: 'Bangkok' });
    assert.match(b, /travel\.gc\.ca/);
    assert.match(b, /give that link EXACTLY|give\nthat link EXACTLY|give `?that link EXACTLY/);
    assert.match(b, /Never a search result and never a "visa service"/);
    assert.match(b, /least\s+equipped person alive/);
  });

  test('it says out loud that holding no embassies is deliberate', () => {
    assert.match(essentialsBlock({ nationality: 'US' }), /Num holds NO embassy or consulate listings, and that is deliberate/);
  });
});

describe('"open now" is never said about something Num does not know', () => {
  test('the categories where hours decide the answer are flagged', () => {
    const b = essentialsBlock({ place: 'Bangkok' });
    assert.match(b, /READ THIS BEFORE YOU SAY "OPEN NOW"/);
    assert.match(b, /pharmacy about 13%/, 'the real number, not a vague hedge');
    assert.match(b, /you DO NOT KNOW whether it is open/);
  });

  test('it offers the thing Num DOES have instead — the phone number', () => {
    const b = essentialsBlock({ place: 'Bangkok' });
    assert.match(b, /PHONE NUMBER/);
    assert.match(b, /ringing first is worth the thirty seconds/);
  });

  test('it names the failure it exists to prevent', () => {
    assert.match(essentialsBlock({}), /walking across a city to a shut chemist at midnight/);
  });

  test('a hospital is explicitly NOT hedged, because A&E does not close', () => {
    // Hedging here would be noise on the one turn where somebody is
    // frightened and needs the shortest possible answer.
    const b = essentialsBlock({ place: 'Bangkok' });
    assert.match(b, /A HOSPITAL IS DIFFERENT/);
    assert.match(b, /emergency department does not close/);
    assert.equal(essentialByKey('hospital').hoursMatter, false);
    assert.equal(essentialByKey('police').hoursMatter, false);
    assert.equal(essentialByKey('pharmacy').hoursMatter, true);
  });

  test('the recorded coverage is the measured one, not an optimistic one', () => {
    assert.ok(essentialByKey('pharmacy').hours <= 0.15, 'pharmacy hours coverage was 13.3%');
    assert.ok(essentialByKey('hospital').hours < 0.01, 'twenty hospitals out of 22,026');
  });
});

describe('thin coverage is admitted rather than implied away', () => {
  test('categories under the threshold are named as incomplete', () => {
    const b = essentialsBlock({ place: 'Bangkok' });
    assert.match(b, /THINLY COVERED/);
    assert.match(b, /not a complete list/);
    for (const e of ESSENTIALS.filter((x) => x.rows < THIN)) {
      assert.ok(b.includes(e.category.toLowerCase()), e.category);
    }
  });

  test('the well-covered ones are offered plainly', () => {
    const b = essentialsBlock({ place: 'Bangkok' });
    for (const e of ESSENTIALS.filter((x) => x.rows >= THIN)) {
      assert.ok(b.includes(e.category), e.category);
    }
  });

  test('every row carries what somebody would actually say', () => {
    // "when they say: a chemist, medicine, a prescription" — the model has
    // to map a person's words to a category, not the other way round.
    for (const e of ESSENTIALS) {
      assert.ok(e.ask && e.ask.length > 5, e.key);
      assert.ok(Number.isInteger(e.rows) && e.rows > 0, e.key);
    }
  });
});

describe('the route', () => {
  const get = (qs = '') => handleEssentials(new Request(`https://app.itsnum.com/api/travel/essentials${qs}`));

  test('it publishes what Num knows AND how well it knows it', async () => {
    const body = await (await get()).json();
    const ph = body.finds.find((f) => f.key === 'pharmacy');
    assert.equal(ph.hours_known, 13);
    assert.equal(ph.hours_matter, true);
    // An app that renders "open now" on a category Num knows one in eight of
    // is lying in its own interface, not only in the model's reply.
    assert.equal(body.finds.find((f) => f.key === 'police').thin, true);
  });

  test('a known passport gets its ministry', async () => {
    const body = await (await get('?me=AU')).json();
    assert.match(body.embassy.official_url, /dfat\.gov\.au/);
    assert.ok(isOfficial(body.embassy.official_url));
  });

  test('an unknown passport gets an honest no and the list of what is known', async () => {
    const body = await (await get('?me=BR')).json();
    assert.equal(body.embassy.known, false);
    assert.ok(Array.isArray(body.embassy.nationalities));
    assert.equal(body.embassy.official_url, undefined, 'no plausible URL may escape');
  });

  test('every URL the route can emit is a government one', async () => {
    for (const cc of Object.keys(MISSIONS)) {
      const body = await (await get(`?me=${cc}`)).json();
      assert.ok(isOfficial(body.embassy.official_url), cc);
    }
  });

  test('it states the reason there are no embassy listings', async () => {
    const body = await (await get()).json();
    assert.match(body.note, /depends on your passport, not on what is nearest/);
  });
});

describe('it only fires when somebody actually needs it', () => {
  const IDX = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const PROMPT = readFileSync(new URL('./prompt.mjs', import.meta.url), 'utf8');

  test('the block is gated on the ask, not pushed every turn', () => {
    // The emergency line next door learned this: a burst of hospital numbers
    // on top of a dinner recommendation reads as alarm.
    assert.match(IDX, /if \(needsEssentials\(lastUser\)\)/);
    assert.match(IDX, /let essentials = null;/);
    assert.match(PROMPT, /if \(essentials\) lines\.push\(essentials\)/);
  });

  test('the trigger covers the words people really use', () => {
    const at = IDX.indexOf('const ESSENTIAL_ASK');
    const re = IDX.slice(at, IDX.indexOf("].join('|')", at));
    for (const w of ['pharmac', 'chemist', 'embassy', 'consulate', 'lost my (?:passport', 'dentist', 'stolen']) {
      assert.ok(re.includes(w), w);
    }
  });

  test('the route is mounted', () => {
    assert.match(IDX, /url\.pathname === '\/api\/travel\/essentials'/);
  });
});
