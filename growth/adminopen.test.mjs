// THE ADMIN DOOR — /o/<token>, and the preview session it grants.
//
// The failure this guards against is not a logic bug. It is the shortcut: an
// admin page that opens a venue's console by putting that venue's PERMANENT
// console_key in a URL. That key never expires, it is owner-level on every
// endpoint guarded by bizAuth, and a URL carrying it lands in history, in
// referrers and in screenshots. These tests read the shipped source, because
// the thing that must not come back is a line of code, not a return value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(join(HERE, 'worker.js'), 'utf8');
const wrangler = readFileSync(join(HERE, 'wrangler.jsonc'), 'utf8');
const adminconsoles = readFileSync(join(HERE, '..', 'worker', 'adminconsoles.mjs'), 'utf8');
const ops = readFileSync(join(HERE, '..', 'app-public', 'ops', 'index.html'), 'utf8');

const fn = (name) => {
  const i = worker.indexOf(`async function ${name}(`);
  if (i < 0) return '';
  let depth = 0, started = false, j = i;
  for (; j < worker.length; j++) {
    if (worker[j] === '{') { depth++; started = true; }
    else if (worker[j] === '}') { depth--; if (started && depth === 0) break; }
  }
  return worker.slice(i, j + 1);
};

test('a handler is not a route — /o/* is registered in wrangler', () => {
  assert.match(wrangler, /"pattern":\s*"itsnum\.com\/o\/\*"/,
    'the open-link handler would 404 behind the asset worker');
  assert.match(worker, /p\.startsWith\("\/o\/"\)/, 'nothing sends /o/ to the handler');
});

test('the open link is single use — burned before anything is granted', () => {
  const src = fn('adminConsoleOpen');
  assert.ok(src, 'adminConsoleOpen is gone');
  const burn = src.indexOf('used_at IS NULL');
  const grant = Math.min(
    ...[src.indexOf('set-cookie'), src.indexOf('console_key')].filter((i) => i > 0),
  );
  assert.ok(burn > 0, 'the token is never burned — a link would work twice');
  assert.ok(burn < grant, 'access is granted before the token is burned');
});

test('used, expired and unknown each get their own sentence', () => {
  const src = fn('adminConsoleOpen');
  for (const phrase of ['not one we issued', 'already been used', 'has expired']) {
    assert.ok(src.includes(phrase), `"${phrase}" is gone — "that didn't work" is the least useful answer`);
  }
});

test('only the hash of a token is ever stored', () => {
  assert.ok(!/INSERT INTO num_admin_console_opens[\s\S]{0,400}\btoken\b\s*,/.test(adminconsoles),
    'a raw token column appeared — a database backup could mint an open link');
  assert.match(adminconsoles, /sha256hex\(token\)/, 'the token is not hashed on the way in');
  assert.match(fn('adminConsoleOpen'), /sha256hex\(token\)/, 'the token is not hashed on the way out');
});

test('the business door never hands over a console_key', () => {
  const src = fn('adminConsoleOpen');
  const bizHalf = src.slice(src.indexOf('SELECT id,status FROM businesses'));
  assert.ok(!bizHalf.includes('console_key'),
    'the business branch touches console_key — that is the permanent credential this exists to avoid');
  assert.match(bizHalf, /set-cookie/, 'the business branch grants no session');
});

test('the preview cookie is signed, scoped and short', () => {
  assert.match(worker, /ADMIN_PREVIEW_TTL_S\s*=\s*3600\b/, 'the preview session is not one hour');
  const sign = fn('adminPreviewSign');
  assert.match(sign, /ADMIN_KEY/, 'the cookie is not signed with the admin key');
  assert.match(sign, /bizId \+ "\." \+ exp/, 'the signature does not cover both the business and the expiry');
});

test('the preview fails closed with no ADMIN_KEY set', () => {
  const src = fn('adminPreviewBiz');
  assert.match(src, /!env\.ADMIN_KEY/, 'an unset key would make the cookie a business id anyone can type');
  assert.match(src, /exp < Math\.floor/, 'an expired cookie is accepted');
  assert.match(src, /sameSecret\(/, 'the signature is compared without a constant-time check');
});

test('bizAuth logs an admin preview as its own reason', () => {
  const src = fn('bizAuth');
  assert.match(src, /via=admin_preview/,
    'an operator and the venue itself would be one story in num_key_events');
  assert.ok(src.indexOf('adminPreviewBiz') > 0, 'bizAuth does not consult the preview cookie');
});

test('a suspended venue does not open for an admin either', () => {
  assert.match(adminconsoles, /row\.status !== 'active'/, 'a suspended console opens for admins');
  assert.match(fn('adminConsoleOpen'), /biz\.status !== "active"/, 'the redeem side does not re-check status');
});

test('the ops page never handles a console key or the admin key', () => {
  // Comments are stripped first: this is about what the page DOES, and the
  // comments in it exist precisely to explain why it does not do this.
  const code = ops
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/console_key/.test(code),
    'the ops page touches a console_key — the permanent credential it exists to avoid');
  assert.ok(!/X-Admin-Key/.test(code),
    'the ops page holds the real admin key; it is only ever given a minted session');
  assert.match(code, /consolesOpen/, 'the Consoles tab is gone');
});

test('the open tab is created inside the click, not after the await', () => {
  const i = ops.indexOf('window.consolesOpen');
  const src = ops.slice(i, i + 900);
  assert.ok(src.indexOf("window.open('', '_blank')") < src.indexOf('await consolesApi'),
    'a popup blocker would make this look like a broken link');
});
