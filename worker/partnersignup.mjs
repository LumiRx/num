/**
 * Self-serve partner signup — the front door for AI agents and companies.
 *
 * Dre, 16 Aug 2026: "an agentic ai dashboard so ai agents can sign up and use
 * our services. sign up companies and businesses."
 *
 * The partner MCP has been live and unmetered since 11 Aug; `num_partner_calls`
 * counts every call and `partnerFrom()` attributes keyed ones. What was
 * missing was any way to GET a key without emailing a human. This is that way:
 *
 *   POST /api/partner/signup   { company, email, use? }  → key, shown ONCE
 *   GET  /api/partner/usage    X-Partner-Key: …          → your calls + tier
 *
 * ── KEY DESIGN ───────────────────────────────────────────────────────────
 *
 * Format: `<slug>_<32 hex>` — because `partnerFrom()` already reads the id as
 * everything before the first underscore, and changing an id scheme that
 * rev-share attribution depends on is how two systems disagree about who is
 * owed money.
 *
 * Only a SHA-256 hash is stored. The key is displayed exactly once, in the
 * signup response. This table will one day gate paid tiers; a table of raw
 * bearer keys is a breach waiting for a reader, and the §8 posture — we hold
 * as little as possible — applies to credentials as much as to cards.
 *
 * ── WHY SIGNUP IS INSTANT AND UNGATED ────────────────────────────────────
 *
 * Friction belongs at the money, not at the demo (partnermcp.mjs says this
 * and it stays true here). The free tier is 1,000 calls/month; a key holder
 * on the free tier can evaluate everything. What signup buys US is identity:
 * every call attributes to a named company with a contact address, which is
 * what turns "someone is hammering the API" into "email Anna at LetsGo2Trip".
 * Paid tiers get enforced when billing lands; the meter is already running.
 */

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Partner-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: CORS });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_partner_keys (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  email TEXT NOT NULL,
  use_case TEXT,
  key_hash TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  monthly_limit INTEGER NOT NULL DEFAULT 1000,
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pkeys_hash ON num_partner_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_pkeys_email ON num_partner_keys(email);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

const sha256 = async (s) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Company name → the id that prefixes the key and shows up in the call log. */
export const slugify = (name) =>
  String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12) || 'partner';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** What each tier costs and allows. One table, quoted everywhere. */
export const TIERS = Object.freeze({
  free: { monthly_limit: 1000, per_min: 12, note: 'Evaluation. Attribution required on every rendered result.' },
  // ── WHY A PAID TIER EXISTS BEFORE BILLING DOES ───────────────────────
  //
  // LetsGo2Trip's term 8 asks for "a minimum rate limit of 120 req/min".
  // That is TEN TIMES the unkeyed ceiling, against a free tier of 1,000 calls
  // a MONTH — 120/min would exhaust a month's free quota in nine minutes. So
  // it is not a technical footnote inside an SLA clause, it is the commercial
  // ask, and it needs a tier with a name and a number rather than an
  // exception quietly made for one partner.
  //
  // The flat monthly fee in their term 10 is what this tier is. Billing is
  // not wired yet and the ceiling is enforced regardless: a limit that only
  // exists once someone can be charged is a limit that does not exist during
  // exactly the period when a partner is integrating against it.
  partner: { monthly_limit: 250_000, per_min: 120, note: 'Flat monthly tier. 120 calls/min. Attribution still required.' },
  // Every tier below carries a per_min too. Not decoration: perMinFor() falls
  // back to the FREE figure for a tier that omits it, so a metered tier with
  // no per_min silently sells a customer twelve calls a minute — the cheapest
  // possible way to make a paying integration look broken.
  directory: { usd_per_call: 0.02, per_min: 120, note: 'search_places, open_places, place_details.' },
  concierge: { usd_per_call: 0.10, per_min: 60, note: 'concierge_answer — the whole product in one call.' },
  platform: { usd_month: 1500, monthly_limit: 100000, per_min: 600, rev_share_pct: 20, note: 'Flat to 100k calls + 20% rev-share on bookings originated.' },
});

/**
 * Resolve an API key to its partner row, or null.
 *
 * Exported because the key is now the front door to more than the usage page:
 * the settlement feed in worker/handoff.mjs authenticates the same way, and a
 * second copy of "hash it and look it up" is a second place for the hashing to
 * drift.
 */
export async function partnerByKey(env, key) {
  if (!env?.DB || !key) return null;
  await ensure(env);
  return await env.DB.prepare('SELECT * FROM num_partner_keys WHERE key_hash = ?1')
    .bind(await sha256(String(key))).first().catch(() => null);
}

/** The per-minute ceiling this key is entitled to. Unkeyed callers are not here. */
export const perMinFor = (row) => TIERS[row?.tier]?.per_min ?? TIERS.free.per_min;

export async function handlePartnerSignup(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!env?.DB) return json({ error: 'Signups are momentarily unavailable.' }, 503);
  await ensure(env);
  const url = new URL(request.url);

  // ── GET /api/partner/usage — the dashboard, as JSON ────────────────────
  // An agent's dashboard IS an API response: agents don't read HTML, and the
  // humans who do can read this too. The page on the site renders exactly
  // this payload.
  if (url.pathname.endsWith('/usage')) {
    const key = request.headers.get('X-Partner-Key') || url.searchParams.get('key') || '';
    if (!key) return json({ error: 'Send your key in the X-Partner-Key header.' }, 401);
    const row = await env.DB.prepare('SELECT * FROM num_partner_keys WHERE key_hash = ?1')
      .bind(await sha256(key)).first();
    if (!row) return json({ error: 'Unknown key.' }, 401);
    const month = new Date().toISOString().slice(0, 7);
    const calls = await env.DB.prepare(
      `SELECT tool, COUNT(*) n, SUM(ok) ok FROM num_partner_calls
        WHERE partner = ?1 AND ts >= ?2 GROUP BY tool ORDER BY n DESC`,
    ).bind(row.id, `${month}-01`).all().catch(() => ({ results: [] }));
    const used = (calls.results ?? []).reduce((n, r) => n + r.n, 0);
    return json({
      company: row.company,
      partner_id: row.id,
      tier: row.tier,
      month,
      used,
      monthly_limit: row.monthly_limit,
      remaining: Math.max(0, row.monthly_limit - used),
      by_tool: calls.results ?? [],
      tiers: TIERS,
      docs: 'https://app.itsnum.com/api/partner',
      mcp: 'POST https://app.itsnum.com/api/partner/mcp (JSON-RPC 2.0)',
    });
  }

  /** Partner keys one network may mint in a day. A real integrator signs up once. */
const PARTNER_SIGNUPS_PER_NETWORK_PER_DAY = 3;

/** Same per-IP hash shape used across the rest of the product: enough to cap a
 *  script, not a log of who visited. */
async function ipHashOf(request) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!ip) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('num-partner:' + ip));
  return [...new Uint8Array(buf)].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ── POST /api/partner/signup ───────────────────────────────────────────
  if (request.method !== 'POST') return json({ error: 'POST { company, email, use? }' }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }
  const company = String(b?.company ?? '').trim().slice(0, 80);
  const email = String(b?.email ?? '').trim().toLowerCase().slice(0, 120);
  const use = String(b?.use ?? '').trim().slice(0, 300) || null;
  if (company.length < 2) return json({ error: 'Company or agent name, at least 2 characters.' }, 400);
  if (!EMAIL.test(email)) return json({ error: 'A real contact email — it is how we reach you before we ever throttle you.' }, 400);

  // ── HOW MANY KEYS ONE NETWORK MAY MINT IN A DAY ─────────────────────────
  //
  // This endpoint is unauthenticated, instant, and its reply and its EMAIL both
  // contain a live credential. The per-email guard below stops one address
  // minting ten thousand identities; it does nothing at all about one script
  // using ten thousand addresses, each of which sends a working API key from
  // partners@itsnum.com to an inbox of the attacker's choosing. That spends the
  // sending reputation the booking confirmations depend on, which
  // maildelivery.mjs names as the thing to protect.
  const iph = await ipHashOf(request);
  const mintedToday = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM num_partner_keys
      WHERE signup_ip = ?1 AND created_at > datetime('now','-1 day')`,
  ).bind(iph).first().catch(() => null);
  if ((mintedToday?.n ?? 0) >= PARTNER_SIGNUPS_PER_NETWORK_PER_DAY) {
    return json({ error: 'Too many signups from here today. Email partners@itsnum.com and a person will sort it.' }, 429);
  }

  // One live key per email. Signup is instant, so without this one script
  // loop mints ten thousand identities and the per-partner meter means
  // nothing.
  const existing = await env.DB.prepare(
    "SELECT id FROM num_partner_keys WHERE email = ?1 AND state = 'active'",
  ).bind(email).first();

  // ── RE-SIGNUP NO LONGER ROTATES THE KEY ─────────────────────────────────
  //
  // It used to, described as "the self-serve answer to I leaked my key". But
  // the only thing you need to trigger it is the partner's email address, which
  // is on their website. So anyone could rotate a live partner's key on demand
  // and break their integration, repeatedly, from a browser console. That is a
  // denial of service against a paying integrator, and it is a worse outcome
  // than the problem the rotation was there to solve.
  //
  // We cannot re-send the existing key — only its hash is stored, which is
  // correct. So the honest answer is to tell the address on file that somebody
  // asked, and make a real rotation go through a person.
  if (existing) {
    if (env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Num Partners <partners@itsnum.com>',
          reply_to: ['partners@itsnum.com'],
          to: [email],
          subject: 'Somebody asked for a new Num partner key',
          text: `Someone just submitted the partner signup form with this address.

Your existing key has NOT been changed and your integration is unaffected.
Nobody was shown it — we only keep a hash, so we could not display it even
if we wanted to.

If that was you and you need a new key, reply to this email and a person
will rotate it. We do it by hand on purpose: an address on a website is not
proof of anything, and a form that rotated keys on request would let anyone
break your integration whenever they liked.

— Num`,
        }),
      }).catch((e) => console.warn('[partner] notice failed', String(e).slice(0, 160)));
    }
    return json({
      ok: true,
      existing: true,
      message: 'That address already has a key. We have emailed it — your existing key is unchanged.',
    }, 200);
  }

  const slug = slugify(company);
  const rand = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
  // The id must be unique even when two companies slugify identically —
  // "Trip Co" and "TripCo" must not share an attribution bucket, because the
  // bucket is what a rev-share is computed from.
  const id = `${slug}_${rand.slice(0, 6)}`;
  const key = `${id.split('_')[0]}_${rand}`;
  const hash = await sha256(key);

  await env.DB.prepare(
    'INSERT INTO num_partner_keys (id, company, email, use_case, key_hash, signup_ip) VALUES (?1,?2,?3,?4,?5,?6)',
  ).bind(id, company, email, use, hash, iph).run();

  // The key goes to the inbox as well as the response — the response gets
  // lost to a closed tab; the email is the durable copy. Resend, never Gmail.
  // Fire-and-forget: an email failure must not cost the signup.
  if (env.RESEND_API_KEY) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Num Partners <partners@itsnum.com>',
        to: [email],
        subject: 'Your Num partner API key',
        text: `Welcome, ${company}.\n\nYour API key (keep it secret):\n${key}\n\nStart here: https://app.itsnum.com/api/partner\nMCP endpoint: POST https://app.itsnum.com/api/partner/mcp\nUsage: GET https://app.itsnum.com/api/partner/usage with header X-Partner-Key\n\nFree tier: 1,000 calls/month. Attribution must be displayed wherever results are shown (ODbL).\n— Num`,
      }),
      // A swallowed failure here means a partner who signed up, saw a key on
      // screen, closed the tab, and has no copy — and nobody knows.
    }).catch((e) => console.warn('[partner] key email failed', email, String(e).slice(0, 160)));
  }

  return json({
    ok: true,
    partner_id: id,
    // Shown once. Only the hash survives on our side — if this is lost,
    // re-signup with the same email rotates it.
    key,
    key_note: 'Shown once and never stored in the clear. Losing it is fine: sign up again with the same email to rotate.',
    tier: 'free',
    monthly_limit: 1000,
    send_as: 'X-Partner-Key header on /api/partner/mcp calls',
    endpoints: {
      docs: 'https://app.itsnum.com/api/partner',
      mcp: 'POST https://app.itsnum.com/api/partner/mcp',
      usage: 'GET https://app.itsnum.com/api/partner/usage',
    },
    terms: 'Attribution must be displayed wherever results are shown. No booking is confirmed unless the response says so. Paid tiers: ' +
      'directory $0.02/call, concierge $0.10/call, platform $1,500/mo + 20% rev-share.',
  });
}
