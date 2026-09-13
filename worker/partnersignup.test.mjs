// Self-serve partner signup — identity now, billing later, keys never stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePartnerSignup, slugify, TIERS } from './partnersignup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function db() {
  const keys = new Map(); // hash → row
  const byEmail = new Map();
  return {
    keys, byEmail,
    prepare(q) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        first: async () => {
          if (/WHERE key_hash/.test(q)) return keys.get(args[0]) ?? null;
          if (/WHERE email/.test(q)) return byEmail.get(args[0]) ?? null;
          return null;
        },
        run: async () => {
          if (/INSERT INTO num_partner_keys/.test(q)) {
            const row = { id: args[0], company: args[1], email: args[2], key_hash: args[4], tier: 'free', monthly_limit: 1000 };
            keys.set(args[4], row); byEmail.set(args[2], row);
          }
          if (/UPDATE num_partner_keys SET key_hash/.test(q)) {
            const row = [...byEmail.values()].find((r) => r.id === args[0]);
            if (row) { keys.delete(row.key_hash); row.key_hash = args[1]; row.company = args[2]; keys.set(args[1], row); }
          }
          return {};
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    batch: async () => [],
  };
}
const post = (body) => new Request('https://app.itsnum.com/api/partner/signup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('signup issues a key whose prefix is the attribution id', async () => {
  const env = { DB: db() };
  const j = await (await handlePartnerSignup(post({ company: 'LetsGo2Trip', email: 'anna@lg2t.com' }), env)).json();
  assert.ok(j.ok);
  // partnerFrom() reads everything before the first underscore as the id —
  // the key format IS the attribution scheme, and rev-share hangs off it.
  assert.equal(j.key.split('_')[0], j.partner_id.split('_')[0]);
  assert.match(j.key, /^[a-z0-9]+_[0-9a-f]{32}$/);
});

test('only the hash is stored — the table cannot leak bearer keys', async () => {
  const env = { DB: db() };
  const j = await (await handlePartnerSignup(post({ company: 'AgentCo', email: 'a@agent.co' }), env)).json();
  for (const row of env.DB.keys.values()) {
    assert.ok(!JSON.stringify(row).includes(j.key), 'the raw key reached the database');
  }
  const src = readFileSync(join(HERE, 'partnersignup.mjs'), 'utf8');
  assert.ok(!/INSERT INTO num_partner_keys[^;]*\bkey\b[^_]/.test(src), 'a raw key column crept into the insert');
});

/* ROTATION ON RE-SIGNUP WAS REMOVED ON 13 SEP 2026, DELIBERATELY.
 *
 * This test used to assert that posting the same email twice rotated the key,
 * described as "the self-serve answer to a leaked key". The trouble is what it
 * takes to trigger it: a partner's email address, which is on their website.
 * So anyone could rotate a live integrator's key on demand, from a browser
 * console, as often as they liked — a denial of service against a paying
 * partner, and a worse outcome than the problem rotation was solving.
 *
 * The half that was right is kept: one email, one identity, never two. */
test('re-signup with the same email never multiplies identities', async () => {
  const env = { DB: db() };
  const a = await (await handlePartnerSignup(post({ company: 'TripCo', email: 'x@trip.co' }), env)).json();
  const b = await (await handlePartnerSignup(post({ company: 'TripCo', email: 'x@trip.co' }), env)).json();
  assert.ok(a.key, 'the first signup gets a key');
  assert.equal(env.DB.byEmail.size, 1, 'the same email produced two identities');
  assert.equal(b.existing, true, 'the second is told an account already exists');
  assert.equal(b.key, undefined, 'and is shown no key — knowing an address is not proof of owning it');
});

test('a stranger cannot rotate a live partner key by posting their address', () => {
  const src = readFileSync(join(HERE, 'partnersignup.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /UPDATE num_partner_keys SET key_hash/,
    'an unauthenticated form must not be able to replace a working key');
  assert.match(code, /existing: true/, 'it should say the account exists');
  assert.match(src, /reply to this email and a person\s*\n?will rotate it/i,
    'and offer a real route to a rotation, done by a human');
});

test('one network cannot mint partner keys all day', () => {
  const src = readFileSync(join(HERE, 'partnersignup.mjs'), 'utf8');
  assert.match(src, /const PARTNER_SIGNUPS_PER_NETWORK_PER_DAY = \d+;/);
  assert.match(src, /FROM num_partner_keys\s*\n\s*WHERE signup_ip = \?1/,
    'counted in D1 — the reply and the email both carry a live credential');
});

test('junk is refused with instructions, not stored', async () => {
  const env = { DB: db() };
  assert.equal((await handlePartnerSignup(post({ company: 'X', email: 'a@b.co' }), env)).status, 400);
  assert.equal((await handlePartnerSignup(post({ company: 'Real Co', email: 'not-an-email' }), env)).status, 400);
  assert.equal(env.DB.byEmail.size, 0);
});

test('two companies that slugify identically cannot share a bucket', () => {
  // "Trip Co" and "TripCo" both slug to tripco; the id carries random extra
  // characters so their call logs — and rev-share — stay separate.
  assert.equal(slugify('Trip Co'), slugify('TripCo'));
  const src = readFileSync(join(HERE, 'partnersignup.mjs'), 'utf8');
  assert.match(src, /\$\{slug\}_\$\{rand\.slice\(0, 6\)\}/,
    'the id is the bare slug again — two same-named companies now share one attribution bucket');
});

test('the pricing quoted is the pricing decided', () => {
  // COMMERCIAL-TERMS.md, agreed 15 Aug. If these change, change them there too.
  assert.equal(TIERS.free.monthly_limit, 1000);
  assert.equal(TIERS.directory.usd_per_call, 0.02);
  assert.equal(TIERS.concierge.usd_per_call, 0.10);
  assert.equal(TIERS.platform.usd_month, 1500);
  assert.equal(TIERS.platform.rev_share_pct, 20);
});

test('usage requires the key and email failure cannot cost a signup', () => {
  const src = readFileSync(join(HERE, 'partnersignup.mjs'), 'utf8');
  assert.match(src, /Send your key in the X-Partner-Key header/, 'usage went unauthenticated');
  // Still fire-and-forget — an email outage must not cost a signup — but the
  // reason is no longer discarded. A swallowed failure here means a partner who
  // saw a key on screen, closed the tab, and has no copy, with nobody the wiser.
  assert.match(src, /\.catch\(\(e\) => console\.warn\('\[partner\] key email failed'/,
    'a failed key email must leave a trace');
  assert.match(src, /api\.resend\.com/, 'email moved off Resend — never Gmail');
  // Routed above the /api/partner index, not shadowed by it.
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.ok(index.indexOf("'/api/partner/signup'") < index.indexOf("url.pathname === '/api/partner'"),
    'the signup route is shadowed by the partner index — same bug as /api/book/link');
});
