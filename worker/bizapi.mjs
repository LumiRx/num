/**
 * Num for Business — public API, v1.
 *
 * The surface a business (or an agent acting for one) uses to claim its listing
 * and control what Num says about it. Mounted at /api/biz/v1/* on num-app for
 * now; it is written to be liftable to its own Worker at api.itsnum.com without
 * changing a route name.
 *
 * WHY THIS EXISTS IN THIS SHAPE
 *
 * A restaurant will not log into a dashboard every week. Increasingly it will
 * not log in at all — it will have an assistant that does. So every capability
 * here is reachable by a machine holding a key, and the same endpoints back the
 * MCP server in bizmcp.mjs. There is no "web-only" action and no step that
 * requires reading a screen.
 *
 * THE ONE THING THAT IS NOT AUTOMATABLE, ON PURPOSE
 *
 * Proving you own a business. `/claim` sends a code to contact details already
 * published on the listing — the number or address the business itself put into
 * the world — and only that code issues a key. An agent can drive the whole
 * flow, but it cannot conjure the proof, because whoever controls that mailbox
 * or phone is the only person who should be able to speak for the business.
 * Making that step easier would make Num's recommendations worthless: anything
 * that lets a stranger edit a restaurant's listing lets a competitor do it too.
 */
import { generateCode, hashCode, safeEqual, sendCode, CODE_TTL_MIN, MAX_ATTEMPTS } from '../claim/verify.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // Third-party sites and agents call this from anywhere. Reads and writes
      // are authorised by key, not by origin, so an origin check would add no
      // security while breaking every legitimate browser-based integration.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    },
  });

const err = (code, message, status) => json({ error: code, message }, status);
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_biz_keys (
  id TEXT PRIMARY KEY,
  place_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bizkeys_place ON num_biz_keys(place_id);
CREATE TABLE IF NOT EXISTS num_biz_claims (
  id TEXT PRIMARY KEY,
  place_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  code_hash TEXT,
  code_salt TEXT,
  expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bizclaims_place ON num_biz_claims(place_id);
`;
let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

const now = () => Math.floor(Date.now() / 1000);
const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve the caller's business from a bearer key.
 *
 * The key is stored hashed, never in the clear — a leaked database read should
 * not hand somebody the ability to rewrite every listing on Num. `key_prefix`
 * exists so an owner can tell two keys apart in a UI without us keeping the
 * secret to do it.
 */
async function authed(env, req) {
  const raw = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return { error: err('unauthorized', 'Send your key as: Authorization: Bearer numbiz_…', 401) };
  const row = await env.DB.prepare(
    'SELECT id, place_id, revoked_at FROM num_biz_keys WHERE key_hash=?1',
  ).bind(await sha256(raw)).first();
  if (!row) return { error: err('unauthorized', 'That key is not recognised.', 401) };
  if (row.revoked_at) return { error: err('key_revoked', 'That key has been revoked.', 401) };
  // Best-effort: a failed timestamp write must never block a legitimate call.
  env.DB.prepare('UPDATE num_biz_keys SET last_used_at=?2 WHERE id=?1').bind(row.id, now()).run().catch(() => {});
  return { placeId: row.place_id, keyId: row.id };
}

/** The public shape of a listing. Deliberately small and stable. */
const publicPlace = (p) => ({
  place_id: p.id,
  name: p.name,
  category: p.category,
  destination: p.dest,
  area: p.area,
  country: p.country,
  address: p.address,
  phone: p.phone,
  website: p.website,
  hours: p.hours,
  cuisine: p.cuisine,
  claimed: !!p.claimed_at,
});

/* ─────────────────────────────── endpoints ─────────────────────────────── */

/** GET /v1/places?q=&dest= — find your listing before claiming it. */
async function findPlaces(env, url) {
  const q = clip(url.searchParams.get('q'), 80);
  const dest = clip(url.searchParams.get('dest'), 40);
  if (!q && !dest) return err('bad_request', 'Give me q= (a name) and/or dest= (a destination slug).', 400);
  const like = `%${(q || '').toLowerCase()}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, name, category, dest, area, country, address, phone, website, hours, cuisine
       FROM places
      WHERE (?1 = '' OR lower(name) LIKE ?2)
        AND (?3 = '' OR dest = ?3)
      LIMIT 20`,
  ).bind(q || '', like, dest || '').all().catch(() => ({ results: [] }));
  return json({ places: (results ?? []).map(publicPlace), count: (results ?? []).length });
}

/**
 * POST /v1/claim {place_id} — begin proving ownership.
 *
 * The code goes to contact details ALREADY ON THE LISTING. The caller does not
 * choose the destination, because a caller who could choose where the proof is
 * sent would not be proving anything.
 */
async function startClaim(env, req) {
  await ensure(env);
  const b = await req.json().catch(() => ({}));
  const placeId = clip(b.place_id, 60);
  if (!placeId) return err('bad_request', 'place_id is required. Find it with GET /v1/places?q=', 400);

  const place = await env.DB.prepare(
    'SELECT id, name, email, phone, website FROM places WHERE id=?1',
  ).bind(placeId).first();
  if (!place) return err('not_found', 'No listing with that place_id.', 404);

  const taken = await env.DB.prepare(
    'SELECT id FROM num_biz_keys WHERE place_id=?1 AND revoked_at IS NULL',
  ).bind(placeId).first();
  if (taken) {
    return err('already_claimed',
      'This listing is already claimed. If it is yours and you have lost access, email info@5arz.com.', 409);
  }

  // Preference order is strength of proof, not convenience: a mailbox published
  // on the listing beats a phone number that a directory may have copied wrong.
  const channel = place.email ? 'email' : place.phone ? 'sms' : null;
  if (!channel) {
    return err('no_proof_channel',
      'That listing has no published email or phone to send a code to. Email info@5arz.com and a person will verify you.', 422);
  }
  const target = channel === 'email' ? place.email : place.phone;

  const code = generateCode();
  const salt = crypto.randomUUID();
  const out = await sendCode(env, {
    channel: channel === 'email' ? 'email_domain' : 'sms',
    to: target,
    code,
    businessName: place.name,
  });
  if (!out.ok) {
    // Say what actually happened. A business told "something went wrong" has
    // nowhere to go; one told the code could not be delivered can act.
    return err('send_failed', `Could not send the code: ${out.error}. Email info@5arz.com and a person will verify you.`, 502);
  }

  const id = uid('bizclaim');
  await env.DB.prepare(
    `INSERT INTO num_biz_claims (id, place_id, channel, target, code_hash, code_salt, expires_at, attempts, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8)`,
  ).bind(id, placeId, channel, target, await hashCode(code, salt), salt, now() + CODE_TTL_MIN * 60, now()).run();

  return json({
    claim_id: id,
    sent_to: channel === 'email' ? maskEmail(target) : maskPhone(target),
    channel,
    expires_in_minutes: CODE_TTL_MIN,
    next: 'POST /v1/verify with {claim_id, code}',
  });
}

const maskEmail = (e) => String(e).replace(/^(.).*(@.*)$/, (_, a, b) => `${a}${'•'.repeat(4)}${b}`);
const maskPhone = (p) => String(p).replace(/.(?=.{3})/g, '•');

/** POST /v1/verify {claim_id, code} → the API key. Shown once. */
async function verifyClaim(env, req) {
  await ensure(env);
  const b = await req.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT * FROM num_biz_claims WHERE id=?1').bind(clip(b.claim_id, 60) ?? '').first();
  if (!row) return err('not_found', 'Unknown claim_id.', 404);
  if (row.verified_at) return err('already_verified', 'That claim was already used.', 409);
  if (row.expires_at < now()) return err('expired', 'That code expired. Start again with POST /v1/claim.', 410);
  if (row.attempts >= MAX_ATTEMPTS) return err('too_many_attempts', 'Too many attempts. Start again with POST /v1/claim.', 429);

  const supplied = String(b.code || '').replace(/\D/g, '');
  if (!safeEqual(await hashCode(supplied, row.code_salt), row.code_hash)) {
    await env.DB.prepare('UPDATE num_biz_claims SET attempts=attempts+1 WHERE id=?1').bind(row.id).run();
    return json({ error: 'wrong_code', attempts_left: MAX_ATTEMPTS - (row.attempts + 1) }, 400);
  }

  // Shown exactly once. We store only the hash, so we genuinely cannot return
  // it again later — which is the property that makes the key worth trusting.
  const key = `numbiz_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const keyId = uid('bizkey');
  await env.DB.batch([
    env.DB.prepare('UPDATE num_biz_claims SET verified_at=?2, code_hash=NULL, code_salt=NULL WHERE id=?1').bind(row.id, now()),
    env.DB.prepare(
      `INSERT INTO num_biz_keys (id, place_id, key_hash, key_prefix, label, created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    ).bind(keyId, row.place_id, await sha256(key), key.slice(0, 14), clip(b.label, 60) ?? 'default', now()),
  ]);

  return json({
    ok: true,
    api_key: key,
    key_id: keyId,
    place_id: row.place_id,
    warning: 'This key is shown once and cannot be recovered. Store it now.',
    next: 'GET /v1/profile with Authorization: Bearer <key>',
  });
}

/** GET /v1/profile — what Num currently knows about you. */
async function getProfile(env, placeId) {
  const p = await env.DB.prepare(
    `SELECT id, name, category, dest, area, country, address, phone, website, hours, cuisine
       FROM places WHERE id=?1`,
  ).bind(placeId).first();
  if (!p) return err('not_found', 'Listing not found.', 404);
  return json({ profile: publicPlace(p) });
}

/**
 * PATCH /v1/profile — change what Num says.
 *
 * The allowlist is the point. A business controls how it is described; it does
 * not control where it appears in a recommendation, and it cannot edit its own
 * category, rating or location. Those belong to the guest's trust in Num, and
 * the moment they are for sale the recommendations stop being worth reading.
 */
const EDITABLE = new Set(['name', 'phone', 'website', 'hours', 'cuisine', 'address']);

async function patchProfile(env, placeId, req) {
  const b = await req.json().catch(() => ({}));
  const sets = [], binds = [];
  for (const [k, v] of Object.entries(b)) {
    if (!EDITABLE.has(k)) continue;
    binds.push(clip(v, 400));
    sets.push(`${k}=?${binds.length + 1}`);
  }
  if (!sets.length) {
    return err('nothing_editable',
      `Send at least one of: ${[...EDITABLE].join(', ')}. Category, rating and position are not editable — they belong to the guest's trust in Num.`, 400);
  }
  await env.DB.prepare(`UPDATE places SET ${sets.join(', ')} WHERE id=?1`).bind(placeId, ...binds).run();
  return getProfile(env, placeId);
}

/**
 * GET /v1/insights — how often Num put you in front of a guest.
 *
 * Honest about its own gap. Impressions are not recorded yet (see
 * BUSINESS_SIDE_AUDIT), and rather than return zeros that read as "nobody wants
 * you", this says plainly that the measurement does not exist. Inventing a
 * number here would be the most damaging possible lie: it is the one figure a
 * merchant would make decisions on.
 */
async function getInsights(env, placeId, url) {
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') || 7)));
  const has = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='num_place_impressions'",
  ).first().catch(() => null);
  if (!has) {
    return json({
      available: false,
      reason: 'Num does not yet record which listings it surfaces to guests, so we cannot tell you. We will not estimate it.',
      place_id: placeId,
    }, 200);
  }
  const { results } = await env.DB.prepare(
    `SELECT date(ts,'unixepoch') day, COUNT(*) impressions
       FROM num_place_impressions
      WHERE place_id=?1 AND ts > unixepoch('now', ?2)
      GROUP BY 1 ORDER BY 1`,
  ).bind(placeId, `-${days} day`).all().catch(() => ({ results: [] }));
  const total = (results ?? []).reduce((n, r) => n + r.impressions, 0);
  return json({ available: true, place_id: placeId, days, impressions: total, by_day: results ?? [] });
}

/* ──────────────────────────────── router ───────────────────────────────── */

export async function handleBizApi(request, env, path) {
  if (request.method === 'OPTIONS') return json({}, 204);
  if (!env.DB) return err('unavailable', 'Database binding missing.', 503);

  const url = new URL(request.url);
  const post = request.method === 'POST';

  // Open: discovery and claiming. You cannot present a key before you have one.
  if (path === '/v1/places' && request.method === 'GET') return findPlaces(env, url);
  if (path === '/v1/claim' && post) return startClaim(env, request);
  if (path === '/v1/verify' && post) return verifyClaim(env, request);

  // Everything else needs a key.
  const auth = await authed(env, request);
  if (auth.error) return auth.error;

  if (path === '/v1/profile' && request.method === 'GET') return getProfile(env, auth.placeId);
  if (path === '/v1/profile' && request.method === 'PATCH') return patchProfile(env, auth.placeId, request);
  if (path === '/v1/insights' && request.method === 'GET') return getInsights(env, auth.placeId, url);

  return err('not_found', `No such endpoint: ${request.method} ${path}. See GET /api/biz/v1 for the index.`, 404);
}

/** The index. A developer or an agent should be able to start from one URL. */
export function bizApiIndex() {
  return json({
    name: 'Num for Business API',
    version: '1',
    base: 'https://app.itsnum.com/api/biz',
    mcp: 'https://app.itsnum.com/api/biz/mcp',
    auth: 'Authorization: Bearer numbiz_…  (issued by /v1/verify)',
    endpoints: [
      { method: 'GET', path: '/v1/places?q=&dest=', auth: false, does: 'Find your listing.' },
      { method: 'POST', path: '/v1/claim', auth: false, body: { place_id: 'string' }, does: 'Send a code to the contact details published on the listing.' },
      { method: 'POST', path: '/v1/verify', auth: false, body: { claim_id: 'string', code: 'string' }, does: 'Exchange the code for an API key. Shown once.' },
      { method: 'GET', path: '/v1/profile', auth: true, does: 'What Num currently says about you.' },
      { method: 'PATCH', path: '/v1/profile', auth: true, body: { hours: 'string', website: 'string', phone: 'string', cuisine: 'string', address: 'string', name: 'string' }, does: 'Change it.' },
      { method: 'GET', path: '/v1/insights?days=7', auth: true, does: 'How often Num surfaced you.' },
    ],
    not_editable: ['category', 'rating', 'position in recommendations'],
    why: 'A business controls how it is described. It does not control where it ranks — that belongs to the guest.',
  });
}
