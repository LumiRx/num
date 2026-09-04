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
  // Superseded by the native-form rebuild (see gate.test.mjs for the full
  // story): the browser now enforces the empty field (`required`), carries
  // the submission, and follows the server's redirect. What remains to guard
  // HERE is that the two client-side protections survived the rebuild.
  const page = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');
  assert.match(page, /required/, 'the empty field is submittable again — the browser bubble was the replacement for the silent return');
  assert.match(page, /'Wrong password\.'/, 'err=wrong is no longer translated into words');
  assert.match(page, /autocomplete="new-password"/,
    'the input invites saved-credential autofill again — Chrome will keep stuffing a stale key into it');
});

test('the first sign-in after a deploy survives the service-worker swap', () => {
  // The fetch-retry is superseded: a native form submission is a NAVIGATION,
  // and the service worker steps aside for navigations (and for all
  // non-GETs) by design. The guard flips: no script may reintroduce a fetch
  // into the login path, because the fetch was what the SW swap could kill.
  const page = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');
  assert.ok(!/fetch\('\/api\/admin\/session'/.test(page),
    'the login fetch is back — the first attempt after every deploy can die with it');
});

test('typing works the instant the gate opens — no click required', () => {
  // Autofocus puts the cursor in the field on load; a native form makes
  // Enter submit from the field without any listener. The document-level
  // keydown catcher went with the rest of the script — nothing left for it
  // to rescue.
  const page = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');
  assert.match(page, /autofocus/, 'the key input no longer autofocuses — typing before clicking goes nowhere');
  assert.match(page, /type="submit"/, 'the button is not a submit — Enter in the field stops working');
});

test('a post-login failure is never reported as a login failure', () => {
  // "The password is correct but it doesn't take me into the dashboard."
  // Sign-in succeeded; the overview fetch or the render failed; the catch
  // re-showed the gate with no message — success-then-crash was pixel-
  // identical to rejection, and the debugging went to the password for hours.
  const page = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');
  assert.match(page, /Sign-in was fine/, 'a load failure after login is silent again — it will be misread as a password problem');
  assert.match(page, /dashboard data failed to load \(HTTP/, 'the overview error hides its status and body again');
  assert.match(page, /the dashboard failed to draw/, 'a render crash is reported as a login failure again');
});

// ── the sign-in that accepted the password and said nothing ──────────────
//
// From 8 Aug to 31 Aug the login log recorded pairs of ACCEPTED admin keys
// seconds apart — 21:52:22 ok, 21:52:35 ok — on every date anyone tried. The
// password was never wrong. The session was rejected afterwards, and the gate
// redrew itself with an EMPTY error, because the fragment collector rewrote
// the address bar to a bare '/ops/' before boot() ran and so erased the
// `?in=1` marker that told boot() a sign-in had just happened. Without it
// every failure took the "first visit, show no error" branch. A form that
// silently redisplays itself is indistinguishable from one that did nothing,
// so the key got typed again — hence the pairs.

test('the fragment collector keeps the query string it needs later', () => {
  const collector = script.slice(script.indexOf("location.hash.slice(1)"));
  const upToClose = collector.slice(0, collector.indexOf('\n}'));
  assert.ok(
    !/replaceState\([^)]*['"]\/ops\/['"]\s*\)/.test(upToClose),
    'the collector rewrites the URL to a bare /ops/, erasing ?in=1 — boot() can then no longer tell a failed sign-in from a first visit, and shows no error at all',
  );
  assert.ok(
    upToClose.includes('location.search'),
    'the collector must preserve location.search when it strips the token',
  );
});

test('a rejected fresh session is always explained, never silent', () => {
  const catchBlock = script.slice(script.indexOf('const fresh401'));
  const branch = catchBlock.slice(0, catchBlock.indexOf('} else {'));
  assert.ok(
    branch.includes('/api/admin/why'),
    'a session rejected seconds after a correct password must be diagnosed against /api/admin/why, not guessed at',
  );
});

// ── the server must not hand out a session it cannot verify ──────────────
test('adminLogin verifies its own minted token before redirecting', () => {
  const fn = console_.slice(console_.indexOf('async function adminLogin'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(
    /sessionClaims\(env, token\)/.test(body),
    'adminLogin must verify the token it mints; a session that is dead on arrival looks exactly like a wrong password from the browser',
  );
  assert.ok(body.includes("'?err=mint'"), 'a token that fails its own check needs its own error code');
});

test('/admin/why is reachable without being signed in', () => {
  const why = console_.indexOf("path === '/admin/why'");
  const guard = console_.indexOf('if (!(await isAdmin(env, request)))');
  assert.ok(why > 0, '/admin/why is not routed');
  assert.ok(why < guard, '/admin/why sits behind the auth guard it exists to explain');
});

test('the diagnostic grades a token without echoing it', () => {
  const fn = console_.slice(console_.indexOf('export async function gradeSession'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const verdict of ['absent', 'malformed', 'bad-signature', 'expired', 'ok']) {
    assert.ok(body.includes(`'${verdict}'`), `gradeSession never reports "${verdict}"`);
  }
  assert.ok(!/return\s+t\b/.test(body), 'gradeSession must never return the token itself');
  assert.ok(!/ADMIN_KEY/.test(body), 'gradeSession must not touch ADMIN_KEY directly');
});
