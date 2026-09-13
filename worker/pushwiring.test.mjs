// The chain, walked in source, from a notification to a phone and back again.
//
// This feature's failure mode is not a crash. It is 117 notifications written,
// one delivered, nothing marked read, and every call returning ok. Each link
// looked correct next to its neighbours; the chain dead-ended. So this test does
// not check behaviour — it checks that the links EXIST and point at each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PUSH = read('./push.mjs');
const APNS = read('./apns.mjs');
const NATIVE = read('../src/lib/native.ts');
const SW = read('../app-public/sw.js');
const INDEX = read('./index.mjs');
const MIG = read('./migrations/0024_notifications.sql');

/* ── the token the app sends reaches a handler that stores it ───────────── */

test('the path the app POSTs to is the path the worker serves', () => {
  // This is the break. The client has POSTed to /api/push/native since the
  // native shell shipped and there was no handler, so every granted iOS
  // permission was thrown away into a 404 the client then swallowed.
  assert.match(NATIVE, /apiUrl\('\/api\/push\/native'\)/);
  assert.match(INDEX, /url\.pathname\.slice\('\/api\/push'\.length\)/,
    'the router strips the prefix, so the handler sees /native');
  assert.match(PUSH, /if \(path === '\/native' && post\)/,
    'without this the client is posting into a void');
});

test('the fields the client sends are the fields the handler reads', () => {
  const body = NATIVE.slice(NATIVE.indexOf("apiUrl('/api/push/native')"));
  const sent = [...body.slice(0, 400).matchAll(/\b(token|platform|me)\b:/g)].map((m) => m[1]);
  for (const f of ['token', 'platform', 'me']) {
    assert.ok(sent.includes(f), `the client must send ${f}`);
    assert.ok(PUSH.includes(`b.${f}`), `the handler must read b.${f}`);
  }
});

test('the token table exists in a migration and is registered', () => {
  assert.match(MIG, /CREATE TABLE IF NOT EXISTS num_push_tokens/);
  assert.match(read('../scripts/apply-host-migrations.mjs'), /0024_notifications\.sql/,
    'an unregistered migration reaches nothing');
});

test('every column the native handler writes exists in the migration', () => {
  const ins = PUSH.slice(PUSH.indexOf('INSERT INTO num_push_tokens'));
  const cols = ins.slice(0, 400).match(/\(([^)]*)\)/)[1]
    .split(',').map((c) => c.trim()).filter((c) => /^[a-z_]+$/.test(c));
  const table = MIG.slice(MIG.indexOf('CREATE TABLE IF NOT EXISTS num_push_tokens'));
  const declared = table.slice(0, table.indexOf('\n);')).match(/^\s{2}([a-z_]+)\s+(TEXT|INTEGER|REAL)/gm)
    .map((l) => l.trim().split(/\s+/)[0]);
  assert.ok(cols.length >= 8);
  for (const c of cols) assert.ok(declared.includes(c), `writes ${c}, which num_push_tokens does not have`);
});

/* ── the send path actually reaches Apple ──────────────────────────────── */

test('notifyAll fans out to native, and pushNative calls the APNs sender', () => {
  assert.match(PUSH, /export async function notifyAll/);
  assert.match(PUSH, /await pushNative\(env, opts\)/);
  assert.match(PUSH, /const \{ apnsReady, sendApns, apnsMissing \} = await import\('\.\/apns\.mjs'\)/);
  assert.match(APNS, /export async function sendApns/);
});

test('reaching nobody is logged as nobody — the failure this whole file is about', () => {
  const block = PUSH.slice(PUSH.indexOf('const reached ='));
  assert.match(block.slice(0, 600), /NOBODY REACHED/,
    'a send that reaches zero devices must say so, or 116 of 117 look fine again');
});

test('only live tokens are dialled', () => {
  const q = PUSH.slice(PUSH.indexOf('FROM num_push_tokens'));
  assert.match(q.slice(0, 200), /disabled_at IS NULL/);
  assert.match(q.slice(0, 200), /fails < 5/);
});

test('a dead token is disabled with Apple own reason, and a busy server is not', () => {
  const fn = PUSH.slice(PUSH.indexOf('export async function pushNative'));
  assert.match(fn, /if \(r\.dead\)/);
  assert.match(fn, /disabled_at = datetime\('now'\), disabled_reason = \?1/);
  assert.match(fn, /fails = fails \+ 1/);
  // And the schema refuses a disabled row with no reason on it.
  assert.match(MIG, /CHECK \(disabled_at IS NULL OR disabled_reason IS NOT NULL\)/);
});

/* ── reading is measurable on BOTH clients ─────────────────────────────── */

test('read_at finally has a writer', () => {
  assert.match(PUSH, /if \(path === '\/read' && post\)/);
  assert.match(PUSH, /SET read_at = COALESCE\(read_at, datetime\('now'\)\)/);
});

test('a tap is recorded as acted, and acted implies read', () => {
  const block = PUSH.slice(PUSH.indexOf("if (path === '/read' && post)"));
  assert.match(block.slice(0, 1600), /acted_at/);
  assert.match(block.slice(0, 1600), /setCol/,
    'setting only acted_at would leave a tapped notification looking unseen');
  assert.match(MIG, /ALTER TABLE num_notifications ADD COLUMN acted_at TEXT;/);
});

test('one member cannot mark another member notifications', () => {
  const block = PUSH.slice(PUSH.indexOf("if (path === '/read' && post)"));
  assert.match(block.slice(0, 1600), /WHERE member_id = \?1/);
});

test('the web service worker reports what it showed and what was tapped', () => {
  assert.ok((SW.match(/\/api\/push\/read/g) || []).length >= 2,
    'one call for shown, one for tapped');
  assert.match(SW, /shown\.push\(n\.id\)/);
  assert.match(SW, /acted: true/);
  // And the shown report must come AFTER the notifications are on screen: the
  // measurement is the thing that may be lost, never the notification.
  assert.ok(SW.indexOf('shown.push(n.id)') < SW.indexOf("body: JSON.stringify({ me, ids: shown })"));
});

test('the native app navigates on a tap and records it', () => {
  assert.match(NATIVE, /pushNotificationActionPerformed/,
    'without this a tap opens the home screen and the suggestion is lost');
  assert.match(NATIVE, /acted: true/);
  assert.match(NATIVE, /window\.location\.assign/);
});

test('a url arriving in a push cannot send the app off-origin', () => {
  const block = NATIVE.slice(NATIVE.indexOf('pushNotificationActionPerformed'));
  assert.match(block.slice(0, 1400), /startsWith\('\/'\)/,
    'a push payload is data from outside the app; following an absolute url would let the send path choose where a tap lands');
});

test('the payload carries the id and url the clients read back', () => {
  // The contract between buildPayload and both tap handlers. If either key is
  // renamed on one side only, a tap stops navigating and stops recording, and
  // nothing throws.
  assert.match(APNS, /u: url \|\| '\/'/);
  assert.match(APNS, /n: notifId \|\| null/);
  assert.match(NATIVE, /\{ u\?: string; n\?: string \}/);
  assert.match(NATIVE, /data\.u/);
  assert.match(NATIVE, /data\.n/);
});

test('a failed native registration is no longer silent', () => {
  assert.match(NATIVE, /registrationError/,
    'on iOS permission is close to one-shot, so a wasted yes must be visible');
});

/* ── the limits that protect the member exist in the schema ─────────────── */

test('the member controls are real columns with real defaults', () => {
  assert.match(MIG, /CREATE TABLE IF NOT EXISTS num_notify_prefs/);
  for (const c of ['enabled', 'quiet_from', 'quiet_to', 'tz', 'weekly_cap', 'paused_until']) {
    assert.ok(MIG.includes(c), `${c} must be a column, not a constant in code`);
  }
});

test('the default weekly ceiling is low, and it is a single number', () => {
  const m = MIG.match(/weekly_cap\s+INTEGER NOT NULL DEFAULT (\d+)/);
  assert.ok(m, 'there must be a ceiling');
  assert.ok(Number(m[1]) <= 5,
    `default cap is ${m[1]} a week — the difference between a concierge and a marketing list is this number`);
});

test('a suppressed notification has to say why', () => {
  assert.match(MIG, /CREATE TABLE IF NOT EXISTS num_notify_log/);
  assert.match(MIG, /CHECK \(decision <> 'suppressed' OR reason IS NOT NULL\)/,
    '"why did NUM not tell me about that" is a question a real member asks');
});

test('a guessed preference is stored as a guess, not as a fact', () => {
  assert.match(MIG, /CREATE TABLE IF NOT EXISTS num_taste/);
  assert.match(MIG, /CHECK \(source IN \('stated','observed'\)\)/);
  assert.match(MIG, /CHECK \(source <> 'observed' OR confidence IS NOT NULL\)/,
    'a suggestion built on a guess should be phrased less confidently than one built on their own words');
});
