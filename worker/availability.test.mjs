/**
 * The availability oracle, tested where it can actually be wrong.
 *
 * Deliberately NOT an HTTP test. Everything interesting in availability.mjs is
 * the verdict logic — when a clash is real, when it only looks real, and when
 * we genuinely cannot tell — and that logic is worth exercising without a
 * Worker, a D1, or a wrangler that stays up. (The permission door is covered
 * end to end in agent-invites.test.mjs, which needs the real thing.)
 *
 * The case this file exists for is the third verdict. Two states are easy to
 * get right; it is 'unclear' that a later refactor will quietly collapse into
 * 'clear' or 'busy', and either collapse is a bug that only shows up as
 * somebody double-booked or somebody wrongly told a friend was busy.
 *
 *   node worker/availability.test.mjs
 */
import { availabilityFor } from './availability.mjs';

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * A D1 stand-in that answers every query with the same rows.
 *
 * The three queries in commitments() differ only in which table they read;
 * they all come back as {day, time}, and the verdict logic cannot tell them
 * apart by design. So one row set covers all three sources, and a test for
 * "hosting counts as a commitment" is a test of the SQL rather than of this.
 */
const fakeDb = (rows) => ({
  DB: {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
      }),
    }),
  },
});

const ask = (rows, windows) => availabilityFor(fakeDb(rows), 'mem_test', windows);

console.log('\nAvailability verdicts\n');

// ── nothing known ─────────────────────────────────────────────────────────
{
  const [w] = await ask([], [{ day: '2026-08-14', time: '20:00', minutes: 120 }]);
  check('empty diary reads clear', w.verdict === 'clear', w.verdict);
  check('clear says nothing about what they are doing', !/dinner|event|plan item/i.test(w.reason), w.reason);
}

// ── a real clash ──────────────────────────────────────────────────────────
{
  // Their 20:00 runs to 22:00; ours starts at 21:00 and lands inside it.
  const [w] = await ask(
    [{ day: '2026-08-14', time: '20:00' }],
    [{ day: '2026-08-14', time: '21:00', minutes: 120 }],
  );
  check('overlapping evening reads busy', w.verdict === 'busy', w.verdict);
}

// ── same day, no clash ────────────────────────────────────────────────────
{
  // Lunch at noon does not make the evening unavailable. Getting this wrong is
  // how "find a night that works" returns no nights at all.
  const [w] = await ask(
    [{ day: '2026-08-14', time: '12:00' }],
    [{ day: '2026-08-14', time: '20:00', minutes: 120 }],
  );
  check('a lunch does not block the evening', w.verdict === 'clear', w.verdict);
}

// ── the one that matters: we cannot tell ──────────────────────────────────
{
  const [noTheirs] = await ask(
    [{ day: '2026-08-14', time: null }],
    [{ day: '2026-08-14', time: '20:00', minutes: 120 }],
  );
  check('their all-day commitment reads unclear, not busy', noTheirs.verdict === 'unclear', noTheirs.verdict);

  const [noOurs] = await ask(
    [{ day: '2026-08-14', time: '20:00' }],
    [{ day: '2026-08-14', time: null, minutes: 120 }],
  );
  check('our undated window reads unclear, not clear', noOurs.verdict === 'unclear', noOurs.verdict);
}

// ── a clash anywhere beats an unknown ─────────────────────────────────────
{
  // Two commitments that day: one we cannot time, one that definitely clashes.
  // The definite answer has to win, or a real conflict hides behind a vague one.
  const [w] = await ask(
    [{ day: '2026-08-14', time: null }, { day: '2026-08-14', time: '20:30' }],
    [{ day: '2026-08-14', time: '20:00', minutes: 120 }],
  );
  check('a real clash outranks an unknown on the same day', w.verdict === 'busy', w.verdict);
}

// ── other days are not this day ───────────────────────────────────────────
{
  const out = await ask(
    [{ day: '2026-08-14', time: '20:00' }],
    [
      { day: '2026-08-14', time: '20:00', minutes: 120 },
      { day: '2026-08-15', time: '20:00', minutes: 120 },
    ],
  );
  check('Thursday busy, Friday clear', out[0].verdict === 'busy' && out[1].verdict === 'clear',
    out.map((w) => `${w.day}=${w.verdict}`).join(' '));
}

// ── the privacy line ──────────────────────────────────────────────────────
{
  // The whole feature is only shippable if this holds. If a future change
  // starts selecting titles to make the reason friendlier, this fails.
  const out = await ask(
    [{ day: '2026-08-14', time: '20:00', title: 'Dinner at Mama Dolores', place: 'Sathorn' }],
    [{ day: '2026-08-14', time: '20:00', minutes: 120 }],
  );
  const leaked = JSON.stringify(out);
  check('no title leaks into the answer', !leaked.includes('Mama Dolores'), leaked);
  check('no place leaks into the answer', !leaked.includes('Sathorn'), leaked);
  check('the answer carries only day, time, verdict, reason',
    Object.keys(out[0]).sort().join(',') === 'day,reason,time,verdict', Object.keys(out[0]).join(','));
}

console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass}/${pass + failures.length} availability assertions`);
if (failures.length) console.log(`  failed: ${failures.join(', ')}`);
process.exit(failures.length ? 1 : 0);
