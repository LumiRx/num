// THE DETAILS A CONCIERGE ACTUALLY SAYS.
//
// 3 Sep 2026: a guest asking for dinner in Bangkok got three verified places
// back — a map link, a phone number, "0.07 km", `open_now: null`. Honest, and
// almost useless to a person in a street. This is the difference between a
// directory lookup and a concierge, and every line of it comes from the row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkMinutes, distanceLabel, openState, openLabel, detail, enrichPicks } from './pickdetail.mjs';
import { parseHours, toHex } from './hours.mjs';

const BKK = 'Asia/Bangkok';
/** A Date at a given local Bangkok weekday/hour (0 = Monday). */
function at(day, hour, minute = 0) {
  // 2026-08-31 is a Monday. Bangkok is UTC+7 with no DST.
  const base = Date.UTC(2026, 7, 31, hour - 7, minute);
  return new Date(base + day * 86400000);
}

test('distance is said the way a person hears it', () => {
  assert.equal(distanceLabel(0.07), '1 min walk');
  assert.equal(distanceLabel(0.35), '4 min walk');
  assert.equal(distanceLabel(1.2), '15 min walk');
  assert.equal(distanceLabel(3.2), '3.2 km', 'past twenty minutes on foot it is a taxi, and the number is the kilometres');
  assert.equal(distanceLabel(14.6), '15 km');
  assert.equal(distanceLabel(null), null);
  assert.equal(walkMinutes(0), 1, 'a place you are standing in is still one minute, not zero');
});

test('open now, and until when', () => {
  const hex = toHex(parseHours('Mo-Su 11:00-23:00'));
  const s = openState(hex, BKK, at(2, 20, 20));         // Wednesday 20:20
  assert.equal(s.state, 'open');
  assert.equal(s.closes, '23:00');
  assert.equal(s.closes_in_min, 160);
  assert.equal(s.soon, false);
  assert.equal(openLabel(s), 'Open · closes 23:00');
});

test('closing within the hour is the one thing worth flagging', () => {
  const hex = toHex(parseHours('Mo-Su 11:00-23:00'));
  const s = openState(hex, BKK, at(2, 22, 20));         // 22:20
  assert.equal(s.soon, true);
  assert.equal(s.closes_in_min, 40);
  assert.equal(openLabel(s), 'Open · closes 23:00 (40 min)');
});

test('closed, and when it opens', () => {
  const hex = toHex(parseHours('Mo-Su 11:00-23:00'));
  const s = openState(hex, BKK, at(2, 8));              // 08:00
  assert.equal(s.state, 'closed');
  assert.equal(s.opens, '11:00');
  assert.equal(s.day, 'today');
  assert.equal(openLabel(s), 'Closed · opens 11:00');
  const late = openState(hex, BKK, at(2, 23, 30));      // 23:30, after close
  assert.equal(late.day, 'tomorrow');
  assert.equal(openLabel(late), 'Closed · opens 11:00 tomorrow');
});

test('a place with no verified hours says NOTHING about being open', () => {
  // Not "closed". Not "probably open". A concierge who fills a gap with a
  // guess is the one the guest stops trusting the first time it is wrong.
  assert.equal(openState(null, BKK), null);
  assert.equal(openState('', BKK), null);
  assert.equal(openLabel(null), null);
  const out = detail({ id: 'x', name: 'A' }, { id: 'x', km: 0.2 }, BKK);
  assert.equal('open' in out, false);
  assert.equal('open_label' in out, false);
});

test('24 hours is said as such', () => {
  const hex = toHex(parseHours('24/7'));
  assert.equal(openLabel(openState(hex, BKK, at(4, 3))), 'Open 24 hours');
});

test('a rating is only a rating with the count that earned it', () => {
  const one = detail({ id: 'x' }, { id: 'x', rating: 4.8, reviews: 1 }, BKK);
  assert.equal('rating' in one, false, 'a 4.8 from one review is a coin toss, not a fact');
  const many = detail({ id: 'x' }, { id: 'x', rating: 4.63, reviews: 2100 }, BKK);
  assert.equal(many.rating, 4.6);
  assert.equal(many.reviews, 2100);
});

test('what NUM guests said is kept apart from what the web said', () => {
  const out = detail({ id: 'x' }, { id: 'x', rating: 4.5, reviews: 900, num_rating: 3.2, num_rating_n: 4 }, BKK);
  assert.equal(out.rating, 4.5);
  assert.deepEqual(out.guest_rating, { score: 3.2, n: 4 });
});

test('the local-script name rides along, so a taxi driver can read it', () => {
  const out = detail({ id: 'x', name: 'Yayoi' }, { id: 'x', name: 'Yayoi', name_local: 'ยาโยอิ' }, BKK);
  assert.equal(out.name_local, 'ยาโยอิ');
  const same = detail({ id: 'x', name: 'Ciccio' }, { id: 'x', name: 'Ciccio', name_local: 'Ciccio' }, BKK);
  assert.equal('name_local' in same, false, 'the same name twice is noise');
});

test('a photo is shown only with its licence', () => {
  const no = detail({ id: 'x' }, { id: 'x', photo_url: 'https://a/b.jpg' }, BKK);
  assert.equal('photo' in no, false);
  const yes = detail({ id: 'x' }, { id: 'x', photo_url: 'https://a/b.jpg', photo_license: 'CC BY-SA 4.0', photo_attr: 'Somchai' }, BKK);
  assert.deepEqual(yes.photo, { url: 'https://a/b.jpg', attribution: 'Somchai', license: 'CC BY-SA 4.0' });
});

test('the old boolean never disagrees with the new state', () => {
  const hex = toHex(parseHours('Mo-Su 11:00-23:00'));
  const open = detail({ id: 'x', open_now: null }, { id: 'x', hours_mask: hex }, BKK, at(2, 20));
  assert.equal(open.open_now, true);
  const closed = detail({ id: 'x', open_now: null }, { id: 'x', hours_mask: hex }, BKK, at(2, 8));
  assert.equal(closed.open_now, false);
});

test('enrichPicks matches by id and survives a bad row', () => {
  const picks = [{ id: '1', name: 'A', km: 0.3 }, { id: '2', name: 'B' }, { id: '3', name: 'C' }];
  const rows = [{ id: '1', km: 0.3, cuisine: 'Thai' }, { id: '2', km: 'not a number' }];
  const out = enrichPicks(picks, rows, BKK);
  assert.equal(out[0].distance, '4 min walk');
  assert.equal(out[0].cuisine, 'Thai');
  assert.equal('distance' in out[1], false, 'a broken row must not produce a broken label');
  assert.equal(out[2].name, 'C', 'a pick with no row passes through untouched');
});

test('the handler enriches picks after resolving them, on both paths', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(src, /enrichPicks\(resolved\.picks, grounding\?\.partners \?\? \[\], grounding\?\.place\?\.tz\)/);
  assert.match(src, /enrichAgain\(reFixedRaw\.picks/, 'the quality-retry path ships picks without the details');
});

// ── the response path around the picks ──────────────────────────────────
test('a first answer with places always offers a next tap', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  // The bulk lane returns picks and no chips (measured live, 3 Sep 2026), so
  // a guest's very first answer ended in a bare text box.
  assert.match(src, /const firstTurn = !history\.some\(\(m\) => m\?\.role === 'assistant'\)/);
  assert.match(src, /if \(firstTurn && !\(result\.chips\?\.length\) && result\.picks\?\.length\)/,
    'default chips fire on later turns too — that breaks the "null keeps the current chips" contract');
});

test('a retry keeps the reason it happened', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(src, /map\(\(f\) => `was:\$\{f\}`\)/,
    '60% of bulk-lane turns read "retried" with no trace of the flag that earned it');
});
