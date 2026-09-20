// The plan board's arithmetic, and the wiring that makes PLAN a planner.
// Run: node --test src/lib/planboard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOURS, addDays, dayLabel, fmtMinor, hourLabel, hourOf, inOrder, landing, spanDays } from './planboard.ts';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('days: a span is inclusive, capped, and never crosses a DST night wrong', () => {
  assert.deepEqual(spanDays('2026-10-02', '2026-10-04'), ['2026-10-02', '2026-10-03', '2026-10-04']);
  assert.deepEqual(spanDays('2026-10-02', null), ['2026-10-02']);
  assert.deepEqual(spanDays(null, '2026-10-04'), []);
  assert.equal(spanDays('2026-01-01', '2027-01-01').length, 21, 'a typo cannot draw a year');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30', 'the European DST switch is still two days');
  assert.equal(dayLabel('2026-10-02'), 'Fri 2 Oct');
  assert.equal(dayLabel('2026-09-18'), 'Fri 18 Sep', 'Sep, never Sept');
});

test('hours: 7am through 1am, labels people say, minutes stay inside their hour', () => {
  assert.equal(HOURS[0], '07'); assert.equal(HOURS.at(-1), '01'); assert.equal(HOURS.length, 19);
  assert.equal(hourLabel('07'), '7am'); assert.equal(hourLabel('12'), '12pm'); assert.equal(hourLabel('00'), '12am'); assert.equal(hourLabel('23'), '11pm');
  assert.equal(hourOf('19:30'), '19'); assert.equal(hourOf(null), null); assert.equal(hourOf('7pm'), null);
});

test('money: whole units when there are no cents, the plan currency, never a crash on a bad code', () => {
  assert.equal(fmtMinor(1800, 'USD'), '$18');
  assert.equal(fmtMinor(1850, 'USD'), '$18.50');
  assert.match(fmtMinor(900, 'EUR'), /€9|9\s?€/);
  assert.match(fmtMinor(1234, 'XXX'), /12\.34/);
});

const items = [
  { id: 'a', title: 'Coffee', day: '2026-10-02', time: '10:00', sort: 0, status: 'idea' },
  { id: 'b', title: 'Tram', day: '2026-10-02', time: '10:30', sort: 0, status: 'idea' },
  { id: 'c', title: 'Lunch', day: '2026-10-02', time: '13:00', sort: 0, status: 'idea' },
  { id: 'd', title: 'Dropped', day: '2026-10-02', time: '13:00', sort: 1, status: 'cancelled' },
  { id: 'e', title: 'Sintra', day: '2026-10-03', time: null, sort: 0, status: 'idea' },
];

test('order inside an hour: by time, then saved order, then title', () => {
  const sorted = [...items].filter((i) => i.time?.startsWith('10')).sort(inOrder).map((i) => i.id);
  assert.deepEqual(sorted, ['a', 'b']);
});

test('landing: a card dropped on another hour lands on :00 and takes the last place', () => {
  const { moves, changed } = landing(items, 'a', '2026-10-02|13', null);
  assert.equal(changed, true);
  assert.deepEqual(moves, [{ id: 'c', sort: 0 }, { id: 'a', sort: 1, day: '2026-10-02', time: '13:00' }], 'the dropped card is not in the slot it came from, and the cancelled one is ignored');
});

test('landing: dropped ON a card goes before it; inside its own hour it keeps its minutes', () => {
  const { moves } = landing(items, 'b', '2026-10-02|10', 'a');
  assert.deepEqual(moves, [{ id: 'b', sort: 0, day: '2026-10-02', time: '10:30' }, { id: 'a', sort: 1 }]);
});

test('landing: a drop that changes nothing is not a write', () => {
  const { changed } = landing(items, 'c', '2026-10-02|13', null);
  assert.equal(changed, false);
});

test('landing: another day, and "anytime" (no time) on that day', () => {
  const day = landing(items, 'a', '2026-10-03|', null);
  assert.deepEqual(day.moves, [{ id: 'e', sort: 0 }, { id: 'a', sort: 1, day: '2026-10-03', time: null }]);
  const any = landing(items, 'e', 'any|', null);
  assert.deepEqual(any.moves, [{ id: 'e', sort: 0, day: null, time: null }]);
});

test('PLAN is a planner: a tab per plan, the board inline, the sheet one tap away', () => {
  const view = read('../components/app/PlanView.tsx');
  assert.match(view, /import PlanBoard from '\.\/PlanBoard'/);
  assert.match(view, /role="tablist" aria-label=\{t\('Your plans'\)\}/);
  assert.match(view, /\{plans\.map\(\(p\) => \(\s*<div key=\{p\.id\} \{\.\.\.pressable\(\(\) => setTab\(p\.id\), 'tab'\)\}/);
  assert.match(view, /<PlanBoard plan=\{plan\} scrollRef=\{scrollRef\} \/>/);
  assert.match(view, /if \(next !== 'diary' && next !== planId\) void openPlan\(next\);/, 'picking a tab opens that plan so the sheet agrees');
});

test('the board: every promise wired — drag, lock, comments, money, add people, add a day, settle', () => {
  const b = read('../components/app/PlanBoard.tsx');
  assert.match(b, /onPointerDown=\{p\.onDrag\}/, 'the handle starts a drag');
  assert.match(b, /landing\(itemsRef\.current, d\.id, d\.over, d\.before\)/, 'a drop is computed by landing()');
  assert.match(b, /if \(changed\) await reorderPlanItems\(moves\);/);
  assert.match(b, /const canEdit = !!me && \(!locked \|\| owner\);/, 'a locked plan is read-only for everyone but the owner');
  assert.match(b, /pressable\(\(\) => void flipLock\(\)\)/);
  assert.match(b, /commentOnItem\(it\.id, say\)/);
  assert.match(b, /patchPlanItem\(it\.id, \{ cost_minor: n, cost:/);
  assert.match(b, /patchPlanItem\(it\.id, \{ paid_by: e\.target\.value \|\| '' \}\)/);
  assert.match(b, /split_with: next\.length === members\.length \? null : next/, 'everyone selected = no list, so a new member joins the split automatically');
  assert.match(b, /startInvite\(\{ planId: plan\.id, intent: 'plan', returnTo: \{ view: 'plan' \} \}\)/, 'ADD PEOPLE comes back to the board');
  assert.match(b, /setPlanSpan\(\{ ends_on: next \}\)/, '+ DAY extends the plan');
  assert.match(b, /settlePlan\(to, minor, via\)/);
  assert.match(b, /const usd = currency === 'USD';/, 'Stars only on a USD plan');
  assert.match(b, /\{usd && <div \{\.\.\.pressable\(\(\) => setConfirm\(key\)\)\}/, 'a Stars payment asks once before it moves money');
  assert.doesNotMatch(b, /\bfees?\b|\bwaiv/i, 'no fee talk on the board');
});


/* ── ADDING AND REMOVING A DAY (20 Sep 2026) ─────────────────────────────
 *
 * Dre: "when adding a day in plans i cant delete it or add a new day."
 *
 * Two different faults wearing one sentence. ADD worked and was invisible:
 * the new chip is appended to the end of a horizontally scrolling row whose
 * rightmost chip is "+ DAY", so on a plan already a few days long it arrived
 * off-screen and the board changed to a day nobody could see. A state change
 * nobody can see is a broken button. DELETE did not exist at all.
 */

test('a new day is scrolled into view, because a selection nobody can see is a dead button', () => {
  const b = read('../components/app/PlanBoard.tsx');
  assert.match(b, /const selectedChip = useRef<HTMLDivElement \| null>\(null\);/);
  assert.match(b, /selectedChip\.current\?\.scrollIntoView\?\.\(\{ behavior: 'smooth', inline: 'center', block: 'nearest' \}\);/);
  assert.match(b, /\}, \[day\]\);/, 'it watches the selected day, so every route to a new day is covered');
  assert.match(b, /ref=\{day === d \? selectedChip : undefined\}/);
});

test('a day can be taken off — and never takes what was on it with it', () => {
  // A booking is a real table at a real restaurant. Losing one because
  // somebody tidied their itinerary is not a trade-off.
  const b = read('../components/app/PlanBoard.tsx');
  assert.match(b, /for \(const it of dayItems\(d\)\) await patchPlanItem\(it\.id, \{ day: '' \}\);/,
    'items on a removed day are not moved to ANYTIME');
  assert.doesNotMatch(b, /removeDay[\s\S]{0,600}?status: 'cancelled'/,
    'removing a day cancels the things on it');
  const body = b.slice(b.indexOf('const removeDay'), b.indexOf('const flipLock'));
  const items = body.indexOf('patchPlanItem');
  const span = body.indexOf('setPlanSpan');
  assert.ok(items > 0 && items < span,
    'the span shrinks before the items move — an item would be stranded on a day the plan no longer has');
});

test('only the two ends, because the middle of a contiguous range has no honest delete', () => {
  // Deleting a Wednesday out of the middle would have to shift every later
  // day back one, silently moving bookings pinned to real dates.
  const b = read('../components/app/PlanBoard.tsx');
  assert.match(b, /if \(d !== first && d !== last\) return;/);
  assert.match(b, /d === days\[0\] \|\| d === days\[days\.length - 1\]/, 'the × is offered on a middle day');
  assert.match(b, /starts_on: addDays\(d, 1\)/, 'removing the first day does not move the start');
  assert.match(b, /ends_on: days\.length === 2 \? null : addDays\(d, -1\)/,
    'shrinking to a single day leaves ends_on pointing at a day that is gone');
});

test('the last remaining day is not removable, and says why', () => {
  const b = read('../components/app/PlanBoard.tsx');
  assert.match(b, /if \(days\.length < 2\) \{ setNote\(/, 'the only day can be removed, leaving a plan with no span');
  assert.match(b, /days\.length > 1 && \(d === days\[0\]/, 'the × shows on a one-day plan');
});
