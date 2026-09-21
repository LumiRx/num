/**
 * SHARING IS PROPOSING, NOT BOOKING.
 *
 * Dre, 13 Sep 2026: "you can share flight etc with your friends in the chat.
 * if you are looking at ideas in the main chat you can share it into you
 * group plans."
 *
 * The dangerous half of that sentence is the second one. A group plan has a
 * status column, and one of its values is BOOKED. If forwarding a fare into
 * a plan ever produced a confirmed row, the rest of the group would stop
 * looking for flights on the strength of a price somebody merely liked —
 * and find out at the airport, or by not going.
 *
 * So: everything shared lands as an IDEA. Only confirmPlanItem may say
 * otherwise, and it is not reachable from a share.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { messageFor, planItemFor } from './sharepayload.mjs';

const SHEET = readFileSync(new URL('../components/app/ShareToSheet.tsx', import.meta.url), 'utf8');
// Comments explain what the code must not do, using the words it must not
// use — so a regex over the raw file matches the explanation and fails. This
// is the fourth time that has happened in this repo; strip them first.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CARD = code(readFileSync(new URL('./sharecard.ts', import.meta.url), 'utf8'));
const PICKS = readFileSync(new URL('../components/app/PickCards.tsx', import.meta.url), 'utf8');

const FARE = {
  kind: 'flight',
  title: 'LAX → JFK · USD 224.20',
  summary: 'LAX → JFK 2026-10-04 · 17:59 → 05:40 +1 · B6 non-stop 8h 41m · USD 224.20',
  day: '2026-10-04',
  cost: 'USD 224.20',
};

const IDEA = {
  kind: 'idea',
  title: 'Gjelina',
  summary: 'Gjelina — the one everyone means when they say Abbot Kinney — 1429 Abbot Kinney Blvd',
  place: '1429 Abbot Kinney Blvd',
  link: 'https://gjelina.com',
};

describe('nothing shared is ever a booking', () => {
  test('a fare lands on the plan as an idea', () => {
    assert.equal(planItemFor(FARE).kind, 'idea');
  });

  test('a place lands on the plan as an idea', () => {
    assert.equal(planItemFor(IDEA).kind, 'idea');
  });

  test('no share path can name a status at all', () => {
    // Not "does not say confirmed" — does not say status. A payload that can
    // set the field is one refactor away from setting it to the wrong value.
    assert.doesNotMatch(JSON.stringify(planItemFor(FARE)), /status/i);
    assert.doesNotMatch(CARD, /status:\s*'confirmed'/);
    assert.doesNotMatch(CARD, /confirmPlanItem/, 'a share must not be able to reach the confirm path');
  });
});

describe('what the other side actually receives', () => {
  test('the message reads cold, days later', () => {
    const m = messageFor(FARE);
    assert.match(m, /Look at this fare/);
    assert.match(m, /LAX → JFK/, 'the route has to survive the trip');
    assert.match(m, /2026-10-04/, 'so does the date');
    assert.match(m, /224\.20/, 'and the price it was when it was sent');
  });

  test('a place carries its link on its own line', () => {
    const m = messageFor(IDEA);
    assert.equal(m.split('\n').length, 2);
    assert.equal(m.split('\n')[1], 'https://gjelina.com');
  });

  test('no link, no empty second line', () => {
    assert.equal(messageFor({ kind: 'idea', summary: 'Somewhere' }).split('\n').length, 1);
  });

  test('a fare and a place are worded differently', () => {
    assert.notEqual(messageFor(FARE).split('—')[0], messageFor(IDEA).split('—')[0]);
  });

  test('the plan item keeps the price and the date it was for', () => {
    const item = planItemFor(FARE);
    assert.equal(item.cost, 'USD 224.20');
    assert.equal(item.day, '2026-10-04');
    assert.match(String(item.note), /17:59 → 05:40 \+1/, 'the +1 has to survive the share too');
  });

  test('absent fields are absent, not empty strings on the row', () => {
    const item = planItemFor({ kind: 'idea', title: 'X', summary: 'y' });
    assert.equal('place' in item, false);
    assert.equal('cost' in item, false);
    assert.equal('day' in item, false);
  });
});

describe('the picker shows what is being sent', () => {
  test('the message is on screen before any destination is tapped', () => {
    // A share sheet that hides the text is how the wrong thing reaches the
    // wrong person, and there is no unsend.
    assert.match(SHEET, /\{card\.summary\}/);
    assert.match(SHEET, /\{card\.title\}/);
  });

  test('both destinations are offered from the one sheet', () => {
    assert.match(SHEET, /shareToPlan/);
    assert.match(SHEET, /shareToFriend/);
  });

  test('a failed send says so instead of silently doing nothing', () => {
    assert.match(SHEET, /didn’t send/);
  });

  test('someone with no friends and no plans is given a way out', () => {
    assert.match(SHEET, /Nowhere to send this yet/);
    assert.match(SHEET, /INVITE SOMEONE/);
  });
});

describe('the two places a share can start', () => {
  test('a fare card can be shared', () => {
    // The fare tray moved to its own component on 20 Sep 2026 so the
    // listing page could reuse it; both files are read for that reason.
    const THREAD = readFileSync(new URL('../components/app/ThreadView.tsx', import.meta.url), 'utf8')
      + readFileSync(new URL('../components/app/FlightTray.tsx', import.meta.url), 'utf8');
    assert.match(THREAD, /openShareCard\(\{[\s\S]{0,120}kind: 'flight'/);
  });

  test('a place Num suggested can be shared', () => {
    assert.match(PICKS, /openShareCard\(\{[\s\S]{0,120}kind: 'idea'/);
  });
});
