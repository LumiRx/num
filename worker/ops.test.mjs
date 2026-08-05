// A dashboard that invents its numbers is worse than no dashboard.
//
// The console this replaces rendered hand-typed arrays — 12,930 QR scans,
// ฿418,200 from a yacht partner, seven measures green, "improving for 8
// straight weeks" — while the database held 80 members, 0 verified and 6
// bookings. Nobody lied on purpose; a demo page was never rewired to the
// live API, and then people started reading it as truth.
//
// These tests make the honesty structural: the ops page may not contain
// plausible-looking data, and the series it charts must come from SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ops = readFileSync(join(ROOT, 'app-public', 'ops', 'index.html'), 'utf8');
const console_ = readFileSync(join(HERE, 'console.mjs'), 'utf8');

// Only the <script> body — CSS carries hex colours and pixel sizes that are
// not data, and flagging those would train everyone to ignore this test.
const script = ops.slice(ops.lastIndexOf('<script>'), ops.lastIndexOf('</script>'));

test('the ops page contains no seeded metric arrays', () => {
  // The exact shape of the old fiction: a bare array of 3+ numbers, which is
  // what a hand-typed "trend" looks like in source.
  const arrays = script.match(/\[\s*\d[\d.]*\s*(,\s*\d[\d.]*\s*){2,}\]/g) || [];
  assert.deepEqual(arrays, [], `hard-coded number series found: ${arrays.join(' ')}`);
});

test('no invented business names or currency figures', () => {
  // Real partner names and baht amounts in a UI file mean someone illustrated
  // a screen instead of querying for it.
  assert.ok(!/฿\s?[\d,]{3,}/.test(script), 'a baht figure is hard-coded in the page');
  for (const ghost of ['Patong', 'Serenity Spa', 'Yacht Co', 'Bang Tao']) {
    assert.ok(!ops.includes(ghost), `demo business "${ghost}" is still in the page`);
  }
});

test('every displayed number comes from the API payload', () => {
  // The page must read its data from the admin endpoint and nowhere else.
  assert.match(script, /fetch\(`\/api\/admin\/overview/, 'the page does not call the admin API');
  assert.match(script, /X-Admin-Session/, 'the page calls the API without an admin session header');
});

test('rates are never shown without their denominator', () => {
  // "13%" off 6 bookings swings 16 points on one more booking. The
  // denominator is the part that stops the number lying at small n.
  const fn = script.slice(script.indexOf('function rate('), script.indexOf('const ago'));
  assert.match(fn, /of \$\{n\(den\)\}/, 'rate() renders a percentage without saying what it is a percentage of');
});

test('a chart of all zeros says so instead of drawing a flat line', () => {
  // A straight line at the axis looks like a working chart reporting nothing.
  // Words are honest where a line is ambiguous.
  const fn = script.slice(script.indexOf('function spark('), script.indexOf('const card'));
  assert.match(fn, /max === 0/, 'an all-zero series still renders as a line');
});

test('the series the charts draw are built by SQL, per day, zero-filled', () => {
  assert.match(console_, /async function dayseries/, 'no day-series helper exists');
  assert.match(console_, /GROUP BY 1 ORDER BY 1/, 'the series is not grouped by day in SQL');
  assert.match(console_, /byDay\.get\(d\) \?\? 0/,
    'missing days are dropped rather than zero-filled — a gap would render as continuity');
  assert.match(console_, /series:\s*\{/, 'adminOverview does not return a series block');
});

test('the action queues exist and are scoped to things a human must do', () => {
  const todo = console_.slice(console_.indexOf('todo: {'), console_.indexOf('async function dayseries'));
  assert.match(todo, /COALESCE\(phone_verified,0\)=0/, 'the unverified queue is not filtered to unverified people');
  assert.match(todo, /state='new'/, 'the claims queue includes businesses already contacted');
  assert.match(todo, /state='requested'/, 'the bookings queue includes requests already answered');
});

test('the admin key is never persisted past the tab', () => {
  // A shared laptop must not inherit an admin session.
  // Match the API call, not the word — the file mentions localStorage in a
  // comment explaining why it is not used, and a test that fails on its own
  // documentation is a test people learn to ignore.
  assert.ok(!/localStorage\s*\.\s*(set|get)Item/.test(script), 'the admin key is written to localStorage');
  assert.match(script, /sessionStorage/, 'the key is not kept in sessionStorage');
});
