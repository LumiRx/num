/**
 * THE DOOR THAT USED TO BE A NAME.
 *
 * 16 Sep 2026: `GET /api/scouts/me?code=FARMER` returned an Expert's whole
 * record — name, country, rate card, paperwork status, earnings — to anybody
 * who sent that query string. Verified against production, not inferred.
 *
 * The code is a REFERRAL identifier. It is printed on an NFC card, spelled
 * aloud across counters, and public at `itsnum.com/s/FARMER`. It is also short
 * and human-readable (ADAM, FARMER), so it is guessable by a person and
 * enumerable by a script. It authenticated nobody; it only looked as though it
 * did.
 *
 * The first test below is the one that matters. Everything else protects the
 * replacement.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  startExpertMagic, redeemExpertMagic, mintExpertSession, expertClaims,
  expertCookie, expertFromRequest, __resetMagicTable, EXPERT_MAGIC_TTL_S,
} from './scoutmagic.mjs';
import { handleScouts } from './scouts.mjs';
import { handleExpertDocs } from './expertdocs.mjs';

let db; let env;
const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text, args: order.map((n) => st.binds[n]) };
    };
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.run = async () => {
      const { text, args } = run();
      const r = database.prepare(text).run(...args);
      return { meta: { changes: r.changes } };
    };
    return st;
  },
  batch: async (sts) => { for (const s of sts) await s.run(); return []; },
});

const req = (url, { cookie = null, method = 'GET', body = null } = {}) => new Request(url, {
  method,
  headers: cookie ? { Cookie: cookie } : {},
  ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } } : {}),
});

beforeEach(() => {
  __resetMagicTable();
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_scouts (
    id TEXT PRIMARY KEY, member_id TEXT, name TEXT, email TEXT, email_lc TEXT UNIQUE,
    phone TEXT, country TEXT, code TEXT UNIQUE, status TEXT DEFAULT 'active',
    terms_version TEXT, agreed_at TEXT, agreed_ip TEXT,
    finder_cents INTEGER DEFAULT 500, finder_gate_minor INTEGER DEFAULT 500,
    share_bps INTEGER DEFAULT 2000, sub_share_bps INTEGER DEFAULT 2000,
    term_months INTEGER DEFAULT 24, monthly_claim_cap INTEGER, notes TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
  db.exec(`CREATE TABLE num_scout_places (id TEXT PRIMARY KEY, scout_id TEXT, place_id TEXT,
    claim_id INTEGER, biz_name TEXT, dest TEXT, country TEXT, lat REAL, lng REAL,
    state TEXT DEFAULT 'introduced', void_reason TEXT, revenue_minor INTEGER DEFAULT 0,
    finder_gate_minor INTEGER DEFAULT 500, finder_cents INTEGER DEFAULT 500,
    share_bps INTEGER DEFAULT 2000, sub_share_bps INTEGER DEFAULT 2000, term_ends_at TEXT,
    introduced_at TEXT DEFAULT (datetime('now')), verified_at TEXT, activated_at TEXT)`);
  db.exec(`CREATE TABLE num_scout_earnings (id TEXT PRIMARY KEY, scout_id TEXT, scout_place_id TEXT,
    kind TEXT, currency TEXT DEFAULT 'USD', gross_minor INTEGER DEFAULT 0, amount_minor INTEGER,
    period TEXT, state TEXT DEFAULT 'accrued', void_reason TEXT, payout_ref TEXT,
    accrued_at TEXT DEFAULT (datetime('now')), payable_at TEXT, paid_at TEXT)`);
  db.exec(`INSERT INTO num_scouts (id,name,email,email_lc,code,status,terms_version,agreed_at)
    VALUES ('sc_farmer','Isaiah Farmer','isaiah@example.com','isaiah@example.com','FARMER','active','v1',datetime('now'))`);
  db.exec(`INSERT INTO num_scouts (id,name,email,email_lc,code,status,terms_version,agreed_at)
    VALUES ('sc_paused','Paused Person','paused@example.com','paused@example.com','PAUSED','paused','v1',datetime('now'))`);
  env = { DB: d1(db), ADMIN_KEY: 'test-admin-key-not-a-real-one' };
});

/**
 * The token row, or undefined.
 *
 * Tolerates the table not existing, which is not a quirk of the test — for an
 * address that belongs to nobody, `startExpertMagic` returns before it touches
 * the database at all, so the table is never even created. Asking "was a token
 * minted?" must not itself be what creates the table.
 */
const tokenRow = () => {
  try { return db.prepare('SELECT * FROM num_scout_magic LIMIT 1').get(); }
  catch { return undefined; }
};

/* ── the hole ───────────────────────────────────────────────────────────── */

describe('THE HOLE THIS CLOSES', () => {
  test('a bare referral code no longer opens the dashboard', async () => {
    const res = await handleScouts(req('https://app.itsnum.com/api/scouts/me?code=FARMER'), env, '/me', 'https://app.itsnum.com');
    assert.equal(res.status, 401, 'the code still authenticates — this is the original bug');
    const body = await res.json();
    assert.equal(body.need_login, true);
    assert.ok(!JSON.stringify(body).includes('Isaiah'), 'the refusal leaked the Expert anyway');
  });

  test('no code, no cookie, no member id is also refused', async () => {
    const res = await handleScouts(req('https://app.itsnum.com/api/scouts/me'), env, '/me', 'https://app.itsnum.com');
    assert.equal(res.status, 401);
  });

  test('a real session DOES open it', async () => {
    const token = await mintExpertSession(env, 'sc_farmer');
    const res = await handleScouts(
      req('https://app.itsnum.com/api/scouts/me', { cookie: `num_expert_session=${encodeURIComponent(token)}` }),
      env, '/me', 'https://app.itsnum.com',
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.scout.code, 'FARMER');
  });
});

/* ── the paperwork endpoints ────────────────────────────────────────────── */

describe('THE WORSE HOLE: paperwork was reachable by code', () => {
  // `/nda` is a POST that captures an electronic signature under the ESIGN
  // Act; `/w9` files a tax form. Both used to resolve the Expert from
  // `?code=FARMER` — a value printed on an NFC card and public in a URL. That
  // is not a disclosure bug, it is a forgery surface: a signature captured
  // that way carries the contractor's name on a document they never saw.
  beforeEach(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS num_expert_docs (
      id TEXT PRIMARY KEY, scout_id TEXT, kind TEXT, state TEXT,
      doc_version TEXT, body_sha256 TEXT, signed_name TEXT, signed_at TEXT,
      object_key TEXT, uploaded_at TEXT, reviewed_by TEXT, reviewed_at TEXT,
      reject_reason TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  });

  test('the pack is refused to a bare code', async () => {
    const res = await handleExpertDocs(
      req('https://app.itsnum.com/api/expert-docs/pack?code=FARMER'), env, '/pack',
    );
    assert.equal(res.status, 404, 'a referral code still opens the paperwork');
  });

  test('SIGNING THE NDA is refused to a bare code', async () => {
    const res = await handleExpertDocs(
      req('https://app.itsnum.com/api/expert-docs/nda?code=FARMER', {
        method: 'POST', body: { name: 'Isaiah Farmer' },
      }),
      env, '/nda',
    );
    assert.ok(res.status >= 400, 'a card code can still sign a legal document in someone else’s name');
  });

  test('a real session opens the pack', async () => {
    const token = await mintExpertSession(env, 'sc_farmer');
    const res = await handleExpertDocs(
      req('https://app.itsnum.com/api/expert-docs/pack', {
        cookie: `num_expert_session=${encodeURIComponent(token)}`,
      }),
      env, '/pack',
    );
    assert.equal(res.status, 200);
  });
});

/* ── asking for a link ──────────────────────────────────────────────────── */

describe('asking for a link', () => {
  test('an active Expert gets a token minted', async () => {
    await startExpertMagic(env, { email: 'isaiah@example.com', origin: 'https://app.itsnum.com' });
    const row = tokenRow();
    assert.ok(row, 'no token was stored');
    assert.equal(row.scout_id, 'sc_farmer');
    assert.ok(row.expires_at - row.created_at === EXPERT_MAGIC_TTL_S);
  });

  test('THE REPLY NEVER SAYS WHETHER THE ADDRESS EXISTS', async () => {
    // Otherwise this endpoint answers "is this person one of Num's
    // contractors?" for anyone who asks, which is a list worth harvesting.
    const real = await startExpertMagic(env, { email: 'isaiah@example.com', origin: 'https://x' });
    const fake = await startExpertMagic(env, { email: 'nobody@example.com', origin: 'https://x' });
    const paused = await startExpertMagic(env, { email: 'paused@example.com', origin: 'https://x' });
    assert.deepEqual({ ok: real.ok, sent: real.sent }, { ok: true, sent: true });
    assert.deepEqual({ ok: fake.ok, sent: fake.sent }, { ok: true, sent: true });
    assert.deepEqual({ ok: paused.ok, sent: paused.sent }, { ok: true, sent: true });
  });

  test('an unknown address mints nothing at all', async () => {
    await startExpertMagic(env, { email: 'nobody@example.com', origin: 'https://x' });
    assert.equal(tokenRow(), undefined);
  });

  test('a paused Expert mints nothing', async () => {
    await startExpertMagic(env, { email: 'paused@example.com', origin: 'https://x' });
    assert.equal(tokenRow(), undefined);
  });

  test('the address is matched case-insensitively', async () => {
    await startExpertMagic(env, { email: '  ISAIAH@Example.COM ', origin: 'https://x' });
    assert.ok(tokenRow(), 'a capitalised address failed to match its own row');
  });

  test('the raw token is never stored — only its hash', async () => {
    await startExpertMagic(env, { email: 'isaiah@example.com', origin: 'https://x' });
    const row = tokenRow();
    assert.match(row.token_hash, /^[0-9a-f]{64}$/, 'that is not a sha-256 hex digest');
  });
});

/* ── redeeming ──────────────────────────────────────────────────────────── */

describe('redeeming', () => {
  async function mint() {
    await startExpertMagic(env, { email: 'isaiah@example.com', origin: 'https://x' });
    // The plaintext token is never persisted, so a test has to make its own.
    __resetMagicTable();
    db.exec('DELETE FROM num_scout_magic');
    const tok = 'a-known-test-token';
    const enc = new TextEncoder().encode(tok);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO num_scout_magic (token_hash,scout_id,email,expires_at,created_at)
                VALUES (?,?,?,?,?)`).run(hash, 'sc_farmer', 'isaiah@example.com', now + 1200, now);
    return tok;
  }

  test('a fresh link works once', async () => {
    const tok = await mint();
    const out = await redeemExpertMagic(env, tok);
    assert.equal(out.ok, true);
    assert.equal(out.scoutId, 'sc_farmer');
  });

  test('THE SAME LINK TWICE IS REFUSED', async () => {
    // A mail client that prefetches links would otherwise burn the token and
    // leave the person holding a dead one, or worse, let two people in.
    const tok = await mint();
    await redeemExpertMagic(env, tok);
    const again = await redeemExpertMagic(env, tok);
    assert.equal(again.ok, false);
    assert.match(again.reason, /already been used/);
  });

  test('an expired link is refused, and says so distinctly', async () => {
    const tok = await mint();
    db.exec(`UPDATE num_scout_magic SET expires_at = ${Math.floor(Date.now() / 1000) - 1}`);
    const out = await redeemExpertMagic(env, tok);
    assert.equal(out.ok, false);
    assert.match(out.reason, /expired/);
    // Three different sentences on purpose: only one of them means "ask for
    // another link", and a person at a dead link deserves to know which.
    assert.ok(!/already been used|not one we issued/.test(out.reason));
  });

  test('a token we never issued is refused', async () => {
    const out = await redeemExpertMagic(env, 'completely-made-up');
    assert.equal(out.ok, false);
    assert.match(out.reason, /not one we issued/);
  });

  test('PAUSED AFTER THE LINK WAS SENT still cannot get in', async () => {
    const tok = await mint();
    db.exec(`UPDATE num_scouts SET status='paused' WHERE id='sc_farmer'`);
    const out = await redeemExpertMagic(env, tok);
    assert.equal(out.ok, false);
    assert.match(out.reason, /no longer active/);
  });
});

/* ── the session ────────────────────────────────────────────────────────── */

describe('the session', () => {
  test('it round-trips', async () => {
    const t = await mintExpertSession(env, 'sc_farmer');
    const c = await expertClaims(env, t);
    assert.equal(c.sid, 'sc_farmer');
    assert.equal(c.kind, 'expert');
  });

  test('a tampered payload does not verify', async () => {
    const t = await mintExpertSession(env, 'sc_farmer');
    const [payload, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ kind: 'expert', sid: 'sc_paused', exp: Date.now() + 1e6 }))
      .toString('base64url');
    assert.equal(await expertClaims(env, `${forged}.${sig}`), null);
    assert.ok(payload);
  });

  test('DOMAIN SEPARATION: an Expert token is not an admin token', async () => {
    // Both are signed with ADMIN_KEY, which is what saved Dre a
    // `wrangler secret put`. It is only safe because the two signatures are
    // taken over DIFFERENT strings — an admin session over `payload`, an
    // Expert session over `expert.v1|payload`. If that label is ever dropped,
    // an Expert session becomes a valid admin session and this whole file
    // stops being about contractors.
    const expertTok = await mintExpertSession(env, 'sc_farmer');
    const [payload, sig] = expertTok.split('.');

    // Reproduce exactly what console.mjs mintSession does: HMAC over the bare
    // payload, no label.
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.ADMIN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const adminSig = Buffer.from(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
    ).toString('base64url');

    assert.notEqual(sig, adminSig,
      'an Expert session signature equals an admin session signature — the label is gone');
  });

  test('a token without kind=expert is refused', async () => {
    // The label is checked, not merely carried. A claim nobody reads is
    // decoration.
    const payload = Buffer.from(JSON.stringify({ kind: 'admin', sid: 'sc_farmer', exp: Date.now() + 1e6 }))
      .toString('base64url');
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.ADMIN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = Buffer.from(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`expert.v1|${payload}`)),
    ).toString('base64url');
    assert.equal(await expertClaims(env, `${payload}.${sig}`), null);
  });

  test('an expired session is refused', async () => {
    const payload = Buffer.from(JSON.stringify({ kind: 'expert', sid: 'sc_farmer', exp: Date.now() - 1 }))
      .toString('base64url');
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.ADMIN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = Buffer.from(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`expert.v1|${payload}`)),
    ).toString('base64url');
    assert.equal(await expertClaims(env, `${payload}.${sig}`), null);
  });

  test('with no signing key nothing is minted, rather than something unverifiable', async () => {
    assert.equal(await mintExpertSession({ DB: env.DB }, 'sc_farmer'), null);
  });

  test('the cookie is read out of a real Cookie header', () => {
    assert.equal(expertCookie('a=1; num_expert_session=abc.def; b=2'), 'abc.def');
    assert.equal(expertCookie('nothing=here'), null);
    assert.equal(expertCookie(null), null);
  });

  test('expertFromRequest returns the scout id, or null', async () => {
    const t = await mintExpertSession(env, 'sc_farmer');
    assert.equal(await expertFromRequest(env, req('https://x', { cookie: `num_expert_session=${encodeURIComponent(t)}` })), 'sc_farmer');
    assert.equal(await expertFromRequest(env, req('https://x')), null);
  });
});

/* ── signing out ────────────────────────────────────────────────────────── */

describe('signing out', () => {
  test('the cookie is actually cleared, not just redirected away from', async () => {
    const res = await handleScouts(req('https://app.itsnum.com/api/scouts/logout'), env, '/logout', 'https://app.itsnum.com');
    assert.equal(res.status, 303);
    assert.match(res.headers.get('Set-Cookie'), /num_expert_session=;/);
    assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
  });
});
