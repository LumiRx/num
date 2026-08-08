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
  //
  // Every chart-drawing function must carry the check, not just the one that
  // happened to exist when this was written. The original pinned the name
  // `spark(` and slice()d to it; when the dashboard was rebuilt and the
  // function became `area()`, indexOf returned -1, the slice silently produced
  // a nonsense window, and the assertion stopped testing anything real. A
  // guard that a rename can quietly switch off is not a guard.
  const drawers = [...script.matchAll(/function (area|mini|spark)\s*\(/g)].map((m) => m[1]);
  assert.ok(drawers.length, 'no chart-drawing function found — did one get renamed again?');
  for (const name of drawers) {
    const start = script.indexOf(`function ${name}(`);
    const body = script.slice(start, start + 1200);
    assert.match(body, /max === 0/,
      `${name}() draws an all-zero series as a line instead of saying it is empty`);
  }
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

test('the dashboard shows real money, chain health, and keeps itself current', () => {
  const page = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');
  const api = readFileSync(join(HERE, 'console.mjs'), 'utf8');
  // Revenue is Stripe truth, not the Stars loop — and it must come from
  // num_payments, whose state only a signed webhook changes.
  assert.match(api, /FROM num_payments WHERE state='paid'/, 'revenue is no longer computed from paid payments');
  assert.match(api, /revenue: \{/, 'the overview stopped reporting revenue');
  assert.match(api, /brain_fails_24h/, 'brain health left the overview — the next quiet outage is invisible again');
  for (const marker of ['Revenue (USD)', 'Revenue (THB)', 'Recent payments', 'Brain failures']) {
    assert.ok(page.includes(marker), `the dashboard no longer shows "${marker}"`);
  }
  // The auto-refresh: an ops page that shows yesterday until someone reloads
  // is a screenshot, not a dashboard.
  assert.match(page, /setInterval\(refresh, 3600_000\)/, 'the hourly refresh is gone — the dashboard goes stale silently');
  assert.match(page, /\.catch\(\(\) => \{\}\)/, 'a failed refresh can throw — one blip logs the operator out of a working view');
});

test('the sign-in gate can never do nothing', () => {
  // "I typed my password and nothing happened." The handler returned silently
  // on an empty field, and Chrome's autofill overlay can make an empty field
  // look filled — so pressing Enter did literally nothing, which reads as a
  // broken console and cost a debugging session. Every path must speak.
  const page = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');
  assert.ok(!/if \(!key\) return;/.test(page),
    'the silent empty-field return is back — Enter on an empty field will do nothing again');
  assert.match(page, /The key field is empty/, 'an empty submit no longer explains itself');
  assert.match(page, /Wrong password\./, 'a 401 no longer says plainly that the password is wrong');
  assert.match(page, /autocomplete="new-password"/,
    'the input invites saved-credential autofill again — Chrome will keep stuffing a stale key into it');
  assert.match(page, /shake/, 'the failure state lost its visual punch — small red text was missable once already');
});

test('the first sign-in after a deploy survives the service-worker swap', () => {
  // Each deploy replaces the SW under the open page, aborting the in-flight
  // POST — so the first attempt died with "Failed to fetch" and the second
  // worked. Observed live, both halves, minutes apart. One silent retry
  // makes the difference invisible.
  const page = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');
  assert.match(page, /catch \{ await new Promise/, 'the sign-in retry is gone — the first attempt after every deploy fails again');
});

test('typing works the instant the gate opens — no click required', () => {
  // The last silent path: no autofocus and an Enter listener bound only to
  // the input. Open page → type into nothing → Enter into nothing → silence.
  // Seen in a screenshot: empty field, no focus ring, "it does nothing".
  const page = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');
  assert.match(page, /<form id="gateform">/, 'the gate lost its form — Enter only works when the input has focus');
  assert.match(page, /autofocus/, 'the key input no longer autofocuses — typing before clicking goes nowhere');
  assert.match(page, /document\.addEventListener\('keydown'/, 'stray typing is no longer pulled into the field');
});
