/**
 * WHAT A FARE CARD MUST NOT LET A TRAVELLER BELIEVE.
 *
 * 13 Sep 2026. The card showed the price, the carrier, the stop count, the
 * duration and each segment's DEPARTURE time. It did not show when the
 * aircraft lands.
 *
 * That is not a missing nicety. A live Sabre result for LAX→JFK on 4 Oct
 * came back as B6 3677, departing 17:59, arriving 05:40 — the next morning.
 * The card rendered "B63677 17:59" and stopped. Someone comparing it against
 * a 1-stop option that gets in the same evening has no way to see the
 * difference that actually matters, and finds out when they land.
 *
 * dayShift and legWindow exist to make that impossible to omit, and these
 * tests exist so the next person to tidy the card cannot quietly drop it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const THREAD = readFileSync(new URL('../components/app/ThreadView.tsx', import.meta.url), 'utf8');
const FLIGHTS = readFileSync(new URL('./flights.ts', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles/themes.css', import.meta.url), 'utf8');

import { dayShift, heldFor, legWindow } from './faredisplay.mjs';

describe('the day you land', () => {

  test('a red-eye that lands tomorrow says +1', () => {
    assert.equal(dayShift('2026-10-04T17:59', '2026-10-05T05:40'), 1);
  });

  test('the real LAX→JFK card renders the arrival and the day', () => {
    const w = legWindow({ segments: [{ departs: '2026-10-04T17:59', arrives: '2026-10-05T05:40' }] });
    assert.equal(w, '17:59 → 05:40 +1');
  });

  test('a same-day flight says nothing extra', () => {
    assert.equal(dayShift('2026-10-04T08:04', '2026-10-04T23:03'), 0);
    assert.equal(
      legWindow({ segments: [{ departs: '2026-10-04T08:04', arrives: '2026-10-04T23:03' }] }),
      '08:04 → 23:03',
    );
  });

  test('a connection is measured end to end, not leg by leg', () => {
    // Depart LAX Sunday morning, connect in Seattle, land JFK Monday night.
    // Neither individual segment crosses two days; the journey crosses two.
    const w = legWindow({
      segments: [
        { departs: '2026-10-04T22:04', arrives: '2026-10-05T01:02' },
        { departs: '2026-10-05T23:37', arrives: '2026-10-06T08:03' },
      ],
    });
    assert.equal(w, '22:04 → 08:03 +2');
  });

  test('an arrival BEFORE departure never prints a negative day', () => {
    // Timezone-naive strings can do this when a westbound flight lands at a
    // local time earlier than it left. "−1 day" on a card is nonsense; the
    // honest answer is to say nothing about the day.
    assert.equal(dayShift('2026-10-04T17:59', '2026-10-04T09:40'), 0);
    assert.equal(dayShift('2026-10-05T10:00', '2026-10-04T22:00'), 0);
  });

  test('missing times degrade to silence, never to a wrong number', () => {
    assert.equal(dayShift(null, '2026-10-05T05:40'), 0);
    assert.equal(dayShift('nonsense', 'also nonsense'), 0);
    assert.equal(legWindow(null), '');
    assert.equal(legWindow({ segments: [] }), '');
  });

  test('the card actually renders it', () => {
    const i = THREAD.indexOf('LIVE FARES');
    const card = THREAD.slice(i, i + 6000);
    assert.ok(card.includes('legWindow(leg)'), 'the arrival time is not on the card');
    assert.match(card, /\+\{?\d?\}?\s*day|day\{/, 'the day-shift marker is not rendered');
  });
});

describe('a price with a shelf life says so', () => {
  const NOW = Date.parse('2026-09-13T03:00:00Z');

  test('minutes while it is minutes', () => {
    assert.equal(heldFor('2026-09-13T03:43:00Z', NOW), '43 min');
  });

  test('hours and minutes once it is longer', () => {
    assert.equal(heldFor('2026-09-13T05:14:00Z', NOW), '2h 14m');
    assert.equal(heldFor('2026-09-13T05:00:00Z', NOW), '2h');
  });

  test('an expired offer says expired rather than a negative time', () => {
    assert.equal(heldFor('2026-09-13T02:00:00Z', NOW), 'expired');
  });

  test('no expiry means no claim about one', () => {
    assert.equal(heldFor(null, NOW), '');
    assert.equal(heldFor('', NOW), '');
  });

  test('a dead card explains itself instead of just going grey', () => {
    const i = THREAD.indexOf('LIVE FARES');
    const card = THREAD.slice(i, i + 6000);
    assert.match(card, /This price has expired/, 'a faded row with no reason reads as a broken app');
  });
});

describe('the price is the money colour, everywhere it can be', () => {
  test('the fare uses --money and not the body ink', () => {
    const i = THREAD.indexOf('LIVE FARES');
    const card = THREAD.slice(i, i + 3000);
    const price = card.indexOf('{o.currency} {o.price}');
    assert.ok(price > -1);
    assert.match(card.slice(Math.max(0, price - 400), price), /var\(--money\)/);
  });

  test('every theme defines it — a green that only exists on one is a bug', () => {
    // One brand in two lights since 17 Sep 2026 (the nine colour themes are retired).
    const themes = [...CSS.matchAll(/\[data-theme='([a-z-]+)'\]/g)].map((m) => m[1]);
    assert.ok(themes.length >= 2, `only found ${themes.length} themes`);
    for (const t of themes) {
      const block = CSS.slice(CSS.indexOf(`[data-theme='${t}']`));
      const body = block.slice(0, block.indexOf('}'));
      assert.match(body, /--money:/, `${t} has no --money, so a price there falls back to the light-mode green`);
    }
  });

  test('the dark themes get a light green, not the paper one', () => {
    // #0b6b45 on #14161c is unreadable. This is the check that a copy-paste
    // of the :root block into a dark theme does not sail through review.
    for (const t of ['verified-dark']) {
      const block = CSS.slice(CSS.indexOf(`[data-theme='${t}']`));
      const money = /--money:\s*#([0-9a-f]{6})/i.exec(block.slice(0, block.indexOf('}')));
      assert.ok(money, `${t} has no hex --money`);
      const [r, g, b] = [0, 2, 4].map((k) => parseInt(money[1].slice(k, k + 2), 16));
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      assert.ok(lum > 0.5, `${t}'s --money (#${money[1]}) is too dark for a dark background`);
    }
  });
});

describe('the money colour reaches the places a price actually appears', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  test('a shared fare shows its price on the group plan', () => {
    // The share carries a cost; before 13 Sep the plan row rendered the
    // title and the date and dropped the number — the one thing the group
    // is deciding on.
    const party = read('../components/app/PartySheet.tsx');
    assert.match(party, /\{i\.cost\}/, 'the plan row never shows the price');
    const at = party.indexOf('{i.cost}');
    assert.match(party.slice(at - 300, at), /var\(--money\)/);
  });

  test('a booking on the plan tab shows what it cost', () => {
    const plan = read('../components/app/PlanView.tsx');
    const at = plan.indexOf('{b.cost}');
    assert.ok(at > -1);
    assert.match(plan.slice(at - 300, at), /var\(--money\)/);
  });

  test('the colour is a token, so it is one decision and not fifty', () => {
    // If somebody types a hex green into a component, the next theme breaks
    // in a way nobody sees until a user in dark mode reports a blank price.
    for (const rel of ['../components/app/PartySheet.tsx', '../components/app/PlanView.tsx', '../components/app/ThreadView.tsx']) {
      const src = read(rel);
      const greens = src.match(/#(0[a-f0-9]{2}[6-9a-f][a-f0-9]{2}[0-9a-f])/gi) ?? [];
      assert.ok(greens.length <= 2, `${rel} has hard-coded greens: ${greens.join(', ')}`);
    }
  });
});
