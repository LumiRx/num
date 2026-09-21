// Nightlife: which night is it, and is it a night at all.
//
// Every fixture below is a row PRODUCTION actually returned on 20 Sep 2026,
// copied from the Ticketmaster rail and from num_event_search_cache — not
// invented. The London rows are the defect this file exists for: a nightlife
// rail full of the London Eye.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUCKETS, BUCKET_IDS, OTHER, labelOf, actsOf, isNight, bucketOf,
  weekendWindow, inWindow, score, topNights, bucketCounts, genresSeen, whyEmpty,
} from './nightlife.mjs';

/* ── what production returned, verbatim ─────────────────────────────────── */

// Amsterdam, near_52.38_4.90 — the rail that already worked.
const AMS_CLUB = {
  id: 'Z698xZbpZ1kropeao', name: 'Cheeky Monday: ANAÏS!', date: '2026-09-21', time: '23:00:00',
  venue: 'Melkweg', genre: 'Dance/Electronic', segment: 'Music', subGenre: null, acts: ['ANAÏS'],
  url: 'https://www.ticketmaster.nl/event/cheeky-monday-anais-tickets/791582251', image: 'x',
};
const AMS_RAP = {
  id: 'a2', name: "Pi'erre Bourne", date: '2026-09-25', time: '20:00:00',
  venue: 'Melkweg', genre: 'Hip-Hop/Rap', segment: 'Music', subGenre: null, acts: ["Pi'erre Bourne"],
  url: 'u', image: 'x',
};

// London, near_51.50_-0.12 — six rows, not one of them a night.
const LDN = [
  { id: 'G5vHZ_CUXBesH', name: 'The Paddington Bear Experience', date: '2026-09-21', time: '10:00:00', venue: 'County Hall', genre: 'Family', segment: 'Miscellaneous', subGenre: null, acts: [], url: 'u' },
  { id: 'l2', name: 'Sea Life London - Standard Entry', date: '2026-09-21', time: '10:00:00', venue: 'County Hall', genre: 'Family', segment: 'Miscellaneous', subGenre: null, acts: [], url: 'u' },
  { id: 'l3', name: 'London Eye - Standard Experience', date: '2026-09-21', time: '10:00:00', venue: 'The London Eye', genre: 'Family', segment: 'Miscellaneous', subGenre: null, acts: [], url: 'u' },
  { id: 'l4', name: 'London Dungeon - Standard Entry', date: '2026-09-21', time: '10:00:00', venue: 'The London Dungeon', genre: 'Family', segment: 'Miscellaneous', subGenre: null, acts: [], url: 'u' },
  { id: 'l5', name: "Twist Museum - London's Home of Illusions STANDARD", date: '2026-09-21', time: '10:00:00', venue: 'Twist Museum', genre: 'Family', segment: 'Miscellaneous', subGenre: null, acts: [], url: 'u' },
  { id: 'l6', name: 'FRAMELESS', date: '2026-09-21', time: '10:00:00', venue: 'Marble Arch Place', genre: 'Miscellaneous', segment: 'Miscellaneous', subGenre: null, acts: [], url: 'u' },
];

// Berlin, near_52.52_13.40 — two nulls and a festival aggregate.
const BER = [
  { id: 'b1', name: 'overpass - Elsewhere, Always Album Tour Europe', date: '2026-09-21', time: '20:00:00', venue: null, genre: 'Rock', segment: 'Music', subGenre: null, acts: ['overpass'], url: 'u' },
  { id: 'b2', name: 'WIR ARBEITEN DRAN - Stand-up Comedy Berlin', date: '2026-09-21', time: '20:00:00', venue: 'Oblomov Kreuzkoelln', genre: 'Comedy', segment: 'Arts & Theatre', subGenre: null, acts: [], url: 'u' },
  { id: 'b3', name: 'Festival Industriekultur Berlin 2026', date: '2026-09-21', time: null, venue: '151 events across Tempelhof', genre: null, segment: null, subGenre: null, acts: [], url: 'u' },
];

// The row that is a real Ticketmaster listing and not a gig.
const PARKING = { id: 'p1', name: 'Parking permit Evanescence', date: '2026-09-22', time: null, venue: null, genre: 'Family', segment: 'Music', subGenre: null, acts: ['Parking'], url: 'u' };

/* ── THE DEFECT ─────────────────────────────────────────────────────────── */

describe('a nightlife rail is never a rail of daytime attractions', () => {
  test('EVERY row London returned is refused', () => {
    for (const e of LDN) {
      assert.equal(isNight(e), false, `${e.name} was let through`);
    }
    assert.deepEqual(topNights(LDN), [], 'the London Eye reached a nightlife shelf');
  });

  test('and the screen says WHY it is empty, not just that it is', () => {
    // Six rows came back and none survived. That is a different sentence from
    // "nothing is listed", and a very different one from "no coverage".
    const w = whyEmpty({ ready: true, covered: true, fetched: LDN.length, kept: 0 });
    assert.equal(w.code, 'nothing_at_night');
    assert.match(w.says, /daytime/);
  });

  test('a parking permit is not a night out even under the Music segment', () => {
    assert.equal(isNight(PARKING), false);
    assert.deepEqual(actsOf(PARKING), [], 'Parking is not a billed act');
  });
});

/* ── THE SPLIT DRE ASKED FOR ────────────────────────────────────────────── */

describe('hip hop, EDM and techno are told apart', () => {
  test('hip-hop comes straight off the genre tier', () => {
    const b = bucketOf(AMS_RAP);
    assert.equal(b.id, 'hiphop');
    assert.equal(b.from, 'genre');
  });

  test('Dance/Electronic with nothing finer is EDM, and is LABELLED as EDM', () => {
    const b = bucketOf(AMS_CLUB);
    assert.equal(b.id, 'house');
    assert.equal(b.from, 'genre');
    // The bucket must not claim to be "House" when all the source said was
    // Dance/Electronic — a trance night under a House chip is a small lie.
    assert.match(labelOf('house'), /EDM/);
  });

  test('techno is NEVER assumed from Dance/Electronic', () => {
    // This is the whole reason subGenre is read. Without evidence, a techno
    // chip would be a guess, and the techno crowd is the one that notices.
    assert.notEqual(bucketOf(AMS_CLUB).id, 'techno');
  });

  test('techno IS taken when the source says so', () => {
    const b = bucketOf({ ...AMS_CLUB, subGenre: 'Techno' });
    assert.equal(b.id, 'techno');
    assert.equal(b.from, 'subgenre');
  });

  test('...and when the billing says so, because club listings usually do', () => {
    const b = bucketOf({ ...AMS_CLUB, name: 'Bassiani presents: Hard Techno All Night', subGenre: null });
    assert.equal(b.id, 'techno');
    assert.equal(b.from, 'words');
  });

  test('subGenre outranks genre — that is the point of reading it', () => {
    const b = bucketOf({ ...AMS_CLUB, genre: 'Dance/Electronic', subGenre: 'Drum & Bass' });
    assert.equal(b.id, 'house');
    assert.equal(b.from, 'subgenre');
  });

  test('a rock tour is live music, comedy and theatre are not nights', () => {
    assert.equal(bucketOf(BER[0]).id, 'live');
    // Comedy is a fine evening and it is not what this screen is for; it is
    // under the Arts & Theatre segment and TONIGHT already carries it.
    assert.equal(isNight(BER[1]), false);
  });

  test('A GIG WITH "TOUR" IN ITS TITLE IS STILL A GIG', () => {
    // The first run of this file refused `overpass - Elsewhere, Always Album
    // Tour Europe` — a real Berlin rock listing — because the attraction
    // blacklist held a bare `\btour\b` to catch sightseeing tours. Half the gig
    // titles on Ticketmaster contain the word. Whole phrases, never bare words.
    for (const name of [
      'overpass - Elsewhere, Always Album Tour Europe',
      'Charli XCX — BRAT World Tour',
      'Peggy Gou Live Tour 2026',
    ]) {
      assert.equal(isNight({ ...AMS_CLUB, name }), true, `${name} was refused`);
    }
    // …while the things the bare word was there for are still refused.
    for (const name of ['Thames Sightseeing Cruise', 'London Walking Tour', 'Hop-On Hop-Off Bus Tour']) {
      assert.equal(isNight({ ...AMS_CLUB, name, genre: 'Music', segment: 'Music' }), false, `${name} got through`);
    }
  });

  test('"The Jimi Hendrix Experience" is a band, not an attraction', () => {
    assert.equal(isNight({ ...AMS_CLUB, name: 'The Jimi Hendrix Experience — A Celebration', genre: 'Rock' }), true);
    // And the attraction that shares the word is still refused.
    assert.equal(isNight({ id: 'x', name: 'Sea Life London - Standard Entry', genre: 'Family', segment: 'Miscellaneous' }), false);
  });

  test('the words pass does not fire on words that merely contain a genre', () => {
    for (const name of ['Housewarming Party', 'Technology Summit Afterparty', 'Latin Mass Choral Evening']) {
      const b = bucketOf({ ...AMS_CLUB, name, genre: null, segment: null, subGenre: null, acts: [] });
      assert.notEqual(b.id, 'techno', `${name} was called techno`);
    }
    // "Housewarming" must not read as house…
    assert.notEqual(bucketOf({ ...AMS_CLUB, name: 'Housewarming Party', genre: null, subGenre: null, acts: [] }).id, 'house');
  });

  test('every bucket id has a label and OTHER is one of them', () => {
    for (const id of BUCKET_IDS) assert.ok(labelOf(id), `${id} has no label`);
    assert.equal(BUCKETS.length, 5);
    assert.ok(BUCKET_IDS.includes(OTHER.id));
  });
});

/* ── WHAT DJs ARE PLAYING ───────────────────────────────────────────────── */

describe('the billing', () => {
  test('acts are deduped, trimmed, and never a parking line', () => {
    const e = { ...AMS_CLUB, acts: ['ANAÏS', ' anaïs ', 'Parking permit', 'Mala', ''] };
    assert.deepEqual(actsOf(e), ['ANAÏS', 'Mala']);
  });

  test('a listing with a billed act outranks one without', () => {
    const billed = { ...AMS_CLUB, acts: ['ANAÏS'] };
    const anon = { ...AMS_CLUB, id: 'z', acts: [] };
    assert.ok(score(billed) > score(anon));
  });

  test('a night with a door time outranks one with none', () => {
    assert.ok(score(AMS_CLUB) > score({ ...AMS_CLUB, time: null }));
  });
});

/* ── THE WEEKEND, AS A CLUB MEANS IT ────────────────────────────────────── */

describe('the weekend window', () => {
  // 2026-09-23 is a Wednesday; 25th Fri, 26th Sat, 27th Sun, 28th Mon.
  test('from midweek it points at the coming Friday', () => {
    const w = weekendWindow(new Date(2026, 8, 23, 12, 0));
    assert.equal(w.friday, '2026-09-25');
    assert.equal(w.saturday, '2026-09-26');
    assert.equal(w.sunday, '2026-09-27');
    assert.equal(w.toDate, '2026-09-28');
  });

  test('on Saturday afternoon it means TONIGHT, not next week', () => {
    const w = weekendWindow(new Date(2026, 8, 26, 15, 0));
    assert.equal(w.friday, '2026-09-25');
  });

  test('on Sunday it is still this weekend — Saturday night is Sunday 02:00', () => {
    const w = weekendWindow(new Date(2026, 8, 27, 2, 0));
    assert.equal(w.friday, '2026-09-25');
  });

  test('a 02:00 Sunday set is INSIDE the weekend, which a calendar week would cut', () => {
    const w = weekendWindow(new Date(2026, 8, 23, 12, 0));
    assert.equal(inWindow({ date: '2026-09-28', time: '02:00:00' }, w), true, 'Sunday night into Monday');
    assert.equal(inWindow({ date: '2026-09-28', time: '14:00:00' }, w), false, 'Monday afternoon is not the weekend');
    assert.equal(inWindow({ date: '2026-09-25', time: '12:00:00' }, w), false, 'Friday lunchtime is not the weekend');
    assert.equal(inWindow({ date: '2026-09-25', time: '23:00:00' }, w), true);
  });

  test('a listing with no date is never assumed to be in the window', () => {
    const w = weekendWindow(new Date(2026, 8, 23, 12, 0));
    assert.equal(inWindow({ date: null, time: '23:00:00' }, w), false);
  });
});

/* ── THE SHELF ──────────────────────────────────────────────────────────── */

describe('topNights', () => {
  const all = [AMS_CLUB, AMS_RAP, ...LDN, ...BER, PARKING];

  test('it carries the nights and none of the attractions', () => {
    const out = topNights(all);
    const names = out.map((e) => e.name);
    assert.ok(names.includes('Cheeky Monday: ANAÏS!'));
    assert.ok(names.includes("Pi'erre Bourne"));
    for (const bad of ['London Eye - Standard Experience', 'Parking permit Evanescence', 'WIR ARBEITEN DRAN - Stand-up Comedy Berlin']) {
      assert.equal(names.includes(bad), false, `${bad} is on the shelf`);
    }
  });

  test('every row carries its bucket, its label and how we decided', () => {
    for (const e of topNights(all)) {
      assert.ok(BUCKET_IDS.includes(e.bucket));
      assert.ok(e.bucket_label);
      assert.ok(['subgenre', 'genre', 'words', null].includes(e.bucket_from));
      assert.ok(Array.isArray(e.acts));
    }
  });

  test('filtering by a bucket returns only that bucket', () => {
    for (const e of topNights(all, { bucket: 'hiphop' })) assert.equal(e.bucket, 'hiphop');
    assert.deepEqual(topNights(all, { bucket: 'techno' }), [], 'nothing here is evidenced techno');
  });

  test('the chips only offer buckets that have something in them', () => {
    const chips = bucketCounts(all);
    const ids = chips.map((c) => c.id);
    assert.ok(ids.includes('house'));
    assert.ok(ids.includes('hiphop'));
    assert.equal(ids.includes('techno'), false, 'an empty chip is a dead end');
    for (const c of chips) assert.ok(c.n > 0 && c.label);
  });

  test('limit is honoured and a bad input does not throw', () => {
    assert.equal(topNights(all, { limit: 1 }).length, 1);
    assert.deepEqual(topNights(null), []);
    assert.deepEqual(topNights(undefined), []);
    assert.deepEqual(topNights([null, undefined, {}]), []);
  });
});

/* ── THE INSTRUMENT ─────────────────────────────────────────────────────── */

describe('genresSeen', () => {
  test('it reports the real classifications and how each was decided', () => {
    const seen = genresSeen([AMS_CLUB, AMS_RAP, ...LDN]);
    const family = seen.find((r) => r.key.includes('Family'));
    assert.ok(family, 'the Family rows must be visible, not silently dropped');
    assert.equal(family.night, false);
    assert.equal(family.n, 5, 'five Family rows came back from London');
    const dance = seen.find((r) => r.key.includes('Dance/Electronic'));
    assert.equal(dance.bucket, 'house');
    assert.equal(dance.from, 'genre');
  });

  test('it is sorted commonest first, so the biggest gap is the first line', () => {
    const seen = genresSeen([AMS_CLUB, AMS_RAP, ...LDN]);
    for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i - 1].n >= seen[i].n);
  });
});

/* ── EMPTY IS THREE DIFFERENT SENTENCES ─────────────────────────────────── */

describe('whyEmpty', () => {
  test('Bangkok and Tokyo are NO COVERAGE, and never "nothing on"', () => {
    // Both cached as [] in num_event_search_cache on 20 Sep 2026. Telling
    // somebody in Bangkok that nothing is on tonight would be a lie about
    // one of the busiest nightlife cities on earth.
    const w = whyEmpty({ ready: true, covered: false, fetched: 0, kept: 0 });
    assert.equal(w.code, 'no_coverage');
    assert.match(w.says, /does not cover it/);
    assert.equal(/nothing is on/i.test(w.says), false);
    // And it still points at what we DO know there.
    assert.match(w.says, /checked by NUM/);
  });

  test('not connected, nothing listed, and a full house each read differently', () => {
    assert.equal(whyEmpty({ ready: false, covered: true, fetched: 0, kept: 0 }).code, 'not_connected');
    assert.equal(whyEmpty({ ready: true, covered: true, fetched: 0, kept: 0 }).code, 'nothing_listed');
    assert.equal(whyEmpty({ ready: true, covered: true, fetched: 9, kept: 3 }), null);
  });
});

/* ── THE FIELDS THIS ALL DEPENDS ON ─────────────────────────────────────── */

describe('events.tm.mjs carries the tiers', () => {
  const SRC = readFileSync(new URL('./events.tm.mjs', import.meta.url), 'utf8');

  test('shape() reads subGenre, segment and the billed acts', () => {
    assert.match(SRC, /subGenre: named\(cls\.subGenre\)/, 'subGenre is the field that separates techno from house');
    assert.match(SRC, /segment: named\(cls\.segment\)/);
    assert.match(SRC, /_embedded\?\.attractions/, 'the acts are the answer to "what DJs are playing"');
  });

  test('search() can ask for a classification rather than filter afterwards', () => {
    assert.match(SRC, /classificationName = null/);
    assert.match(SRC, /qs\.set\('classificationName'/);
    // Twenty rows is the ceiling, so the filter has to be in the QUESTION.
    assert.match(SRC, /size: String\(Math\.min\(Math\.max\(1, size\), 20\)\)/);
  });

  test('and a weekend can be asked for directly', () => {
    assert.match(SRC, /startAt \? tmTime\(startAt\)/);
    assert.match(SRC, /endAt \? tmTime\(endAt\)/);
  });
});
