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
  free: { monthly_limit: 1000, note: 'Evaluation. Attribution required on every rendered result.' },
  directory: { usd_per_call: 0.02, note: 'search_places, open_places, place_details.' },
  concierge: { usd_per_call: 0.10, note: 'concierge_answer — the whole product in one call.' },
  platform: { usd_month: 1500, monthly_limit: 100000, rev_share_pct: 20, note: 'Flat to 100k calls + 20% rev-share on bookings originated.' },
});

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

  // ── POST /api/partner/signup ───────────────────────────────────────────
  if (request.method !== 'POST') return json({ error: 'POST { company, email, use? }' }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }
  const company = String(b?.company ?? '').trim().slice(0, 80);
  const email = String(b?.email ?? '').trim().toLowerCase().slice(0, 120);
  const use = String(b?.use ?? '').trim().slice(0, 300) || null;
  if (company.length < 2) return json({ error: 'Company or agent name, at least 2 characters.' }, 400);
  if (!EMAIL.test(email)) return json({ error: 'A real contact email — it is how we reach you before we ever throttle you.' }, 400);

  // One live key per email. Signup is instant, so without this one script
  // loop mints ten thousand identities and the per-partner meter means
  // nothing. Re-signup with the same email rotates the key instead — which
  // is also the self-serve answer to "I leaked my key".
  const existing = await env.DB.prepare(
    "SELECT id FROM num_partner_keys WHERE email = ?1 AND state = 'active'",
  ).bind(email).first();

  const slug = existing?.id?.split('_')[0] ?? slugify(company);
  const rand = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
  // The id must be unique even when two companies slugify identically —
  // "Trip Co" and "TripCo" must not share an attribution bucket, because the
  // bucket is what a rev-share is computed from.
  const id = existing?.id ?? `${slug}_${rand.slice(0, 6)}`;
  const key = `${id.split('_')[0]}_${rand}`;
  const hash = await sha256(key);

  if (existing) {
    await env.DB.prepare('UPDATE num_partner_keys SET key_hash = ?2, company = ?3 WHERE id = ?1')
      .bind(existing.id, hash, company).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO num_partner_keys (id, company, email, use_case, key_hash) VALUES (?1,?2,?3,?4,?5)',
    ).bind(id, company, email, use, hash).run();
  }

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
    }).catch(() => {});
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
