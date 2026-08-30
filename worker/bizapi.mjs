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
import {
  generateCode, hashCode, safeEqual, sendCode, uid, maskEmail, maskPhone, CODE_TTL_MIN,
} from '../claim/verify.mjs';
// The same promotion every claim door on Num runs once a code checks out:
// create the business, initialise its commerce profile and settings. Without
// it a business is verified but inert — no commission rate, no timezone, no
// feature flags (see claim/onboard.mjs's own doc comment). Reused here rather
// than reimplemented so a claim made through the API ends up in exactly the
// state a claim made through the public form does.
import { onboardStatements } from '../claim/onboard.mjs';
// Circular by design and safe: bizmcp imports handleBizApi and only calls it
// inside a function, and this only reads the tool array inside bizApiIndex().
// Neither reference is evaluated at module scope, so there is no TDZ hazard in
// either import order. The alternative — retyping six tool names here — is the
// exact duplication this index exists to make checkable.
import { TOOLS_FOR_TEST as BIZ_MCP_TOOLS } from './bizmcp.mjs';

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

// num_claims, num_place_owners, businesses and num_business_profiles are
// owned by claim/schema.sql and worker/num_business_schema.sql respectively —
// already applied, so this worker does not create them. num_biz_keys is the
// one table that belongs to this API alone.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_biz_keys (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bizkeys_business ON num_biz_keys(business_id);
`;
let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

const now = () => Math.floor(Date.now() / 1000);

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
  // num_biz_keys is created lazily (ensure(), same as startClaim/verifyClaim) —
  // without this call here, the very first hit to any auth'd route before
  // any claim had ever completed queried a table that did not exist yet and
  // threw an unhandled D1 error (surfaced to the caller as a bare Cloudflare
  // 1101, not the JSON 'unauthorized' this function exists to return).
  // Confirmed live in production 2026-08-30 — a bogus key crashed instead of
  // 401ing, because ensure() had never run: no claim had ever verified.
  await ensure(env);
  const raw = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return { error: err('unauthorized', 'Send your key as: Authorization: Bearer numbiz_…', 401) };
  const row = await env.DB.prepare(
    'SELECT id, business_id, revoked_at FROM num_biz_keys WHERE key_hash=?1',
  ).bind(await sha256(raw)).first();
  if (!row) return { error: err('unauthorized', 'That key is not recognised.', 401) };
  if (row.revoked_at) return { error: err('key_revoked', 'That key has been revoked.', 401) };
  // Best-effort: a failed timestamp write must never block a legitimate call.
  env.DB.prepare('UPDATE num_biz_keys SET last_used_at=?2 WHERE id=?1').bind(row.id, now()).run().catch(() => {});

  const owner = await env.DB.prepare(
    `SELECT place_id FROM num_place_owners
      WHERE business_id=?1 AND revoked_at IS NULL
      ORDER BY verified_at DESC LIMIT 1`,
  ).bind(row.business_id).first().catch(() => null);

  return { businessId: row.business_id, placeId: owner?.place_id ?? null, keyId: row.id };
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
  // places has no claimed_at column, and never did — this read undefined
  // and reported every listing as unclaimed. status/business_id are what
  // actually record it.
  claimed: p.status === 'claimed' || !!p.business_id,
});

/* ─────────────────────────────── endpoints ─────────────────────────────── */

/** GET /v1/places?q=&dest= — find your listing before claiming it. */
async function findPlaces(env, url) {
  const q = clip(url.searchParams.get('q'), 80);
  const dest = clip(url.searchParams.get('dest'), 40);
  if (!q && !dest) return err('bad_request', 'Give me q= (a name) and/or dest= (a destination slug).', 400);
  const like = `%${(q || '').toLowerCase()}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, name, category, dest, area, country, address, phone, website, hours, cuisine, status, business_id
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
    'SELECT id, name, category, dest, country, area, address, lat, lng, email, phone, website FROM places WHERE id=?1',
  ).bind(placeId).first();
  if (!place) return err('not_found', 'No listing with that place_id.', 404);

  // The same ownership record every claim door checks — num_place_owners,
  // not a table scoped to this API alone. A listing claimed through the
  // public form or the app is exactly as "taken" here as one claimed
  // through this API.
  const taken = await env.DB.prepare(
    'SELECT place_id FROM num_place_owners WHERE place_id=?1 AND revoked_at IS NULL',
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

  // Written to num_claims - the table the ops console's claims queue, the
  // public /claim/ form and the in-app claim flow all already write to. Its
  // channel column has a CHECK constraint limited to a fixed taxonomy
  // ('sms','voice','email_domain','manual') — confirmed against production
  // 2026-08-29 — so an email claim is recorded as 'email_domain' there too,
  // same as growth's. The two doors still run genuinely different policies
  // (this one sends only to the address already published on the listing;
  // growth also accepts any mailbox at the listed website's domain) — that
  // distinction lives in application logic (this function never asks the
  // caller for an address), not in a channel value the schema can't hold.
  const dbChannel = channel === 'email' ? 'email_domain' : channel;
  const id = uid('claim');
  const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60000).toISOString();
  const maskedTarget = channel === 'email' ? maskEmail(target) : maskPhone(target);
  await env.DB.prepare(
    `INSERT INTO num_claims
       (id, place_id, channel, channel_value, code_hash, code_salt, attempts, max_attempts,
        sent_at, expires_at, state, ip, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,0,?7,datetime('now'),?8,'pending',?9,datetime('now'))`,
  ).bind(
    id, placeId, dbChannel, maskedTarget, await hashCode(code, salt), salt,
    // num_claims itself defaults max_attempts to 5; carried explicitly here
    // so this stays correct even if that default ever changes.
    5, expiresAt, req.headers.get('CF-Connecting-IP') ?? null,
  ).run();

  return json({
    claim_id: id,
    sent_to: maskedTarget,
    channel,
    expires_in_minutes: CODE_TTL_MIN,
    next: 'POST /v1/verify with {claim_id, code}',
  });
}

/** POST /v1/verify {claim_id, code} → the API key. Shown once. */
async function verifyClaim(env, req) {
  await ensure(env);
  const b = await req.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT * FROM num_claims WHERE id=?1').bind(clip(b.claim_id, 60) ?? '').first();
  if (!row) return err('not_found', 'Unknown claim_id.', 404);
  if (row.state === 'verified') return err('already_verified', 'That claim was already used.', 409);
  if (row.state !== 'pending' || !row.code_hash) {
    return err('no_code_pending', 'No code is pending for this claim. Start again with POST /v1/claim.', 409);
  }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    await env.DB.prepare("UPDATE num_claims SET state='expired' WHERE id=?1").bind(row.id).run();
    return err('expired', 'That code expired. Start again with POST /v1/claim.', 410);
  }
  if (row.attempts >= row.max_attempts) {
    await env.DB.prepare("UPDATE num_claims SET state='failed' WHERE id=?1").bind(row.id).run();
    return err('too_many_attempts', 'Too many attempts. Start again with POST /v1/claim.', 429);
  }

  const supplied = String(b.code || '').replace(/\D/g, '');
  if (!safeEqual(await hashCode(supplied, row.code_salt), row.code_hash)) {
    const left = row.max_attempts - (row.attempts + 1);
    await env.DB.prepare('UPDATE num_claims SET attempts=attempts+1 WHERE id=?1').bind(row.id).run();
    return json({ error: 'wrong_code', attempts_left: Math.max(0, left) }, 400);
  }

  // Verified. From here this is the exact promotion every other claim door on
  // Num runs: create the business, take ownership, initialise the commerce
  // profile (claim/onboard.mjs's onboardStatements - commission rate,
  // timezone, locale; without it a business is verified but inert). Only
  // then is a key issued - that part IS unique to this door, because an API
  // key is what an agent needs and a human clicking a web dashboard does not.
  const place = await env.DB.prepare(
    'SELECT id, name, category, dest, country, area, address, lat, lng, phone, email, website FROM places WHERE id=?1',
  ).bind(row.place_id).first();
  const businessId = uid('biz');
  const key = `numbiz_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const keyId = uid('bizkey');

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO businesses (id, name, kind, category, territory, status, onboarded_by, notes)
       VALUES (?1,?2,'merchant',?3,?4,'active','biz-api',?5)`,
    ).bind(businessId, place.name, place.category ?? null, place.dest ?? null, `claim ${row.id}`),
    env.DB.prepare(
      `INSERT INTO num_place_owners (place_id, business_id, claim_id, method, phone)
       VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT(place_id) DO UPDATE SET business_id=excluded.business_id,
             claim_id=excluded.claim_id, method=excluded.method, phone=excluded.phone,
             verified_at=datetime('now'), revoked_at=NULL`,
    ).bind(row.place_id, businessId, row.id, row.channel, row.channel === 'sms' ? place.phone : null),
    env.DB.prepare(
      `UPDATE num_claims SET state='verified', business_id=?2, code_hash=NULL, code_salt=NULL,
              decided_at=datetime('now'), decided_by='biz-api' WHERE id=?1`,
    ).bind(row.id, businessId),
    env.DB.prepare("UPDATE places SET status='claimed', business_id=?2 WHERE id=?1")
      .bind(row.place_id, businessId),
    ...(await onboardStatements(env, businessId, place, 'biz-api:' + row.channel)),
    env.DB.prepare(
      `INSERT INTO num_biz_keys (id, business_id, key_hash, key_prefix, label, created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    ).bind(keyId, businessId, await sha256(key), key.slice(0, 14), clip(b.label, 60) ?? 'default', now()),
  ]);

  return json({
    ok: true,
    api_key: key,
    key_id: keyId,
    business_id: businessId,
    place_id: row.place_id,
    warning: 'This key is shown once and cannot be recovered. Store it now.',
    next: 'GET /v1/profile with Authorization: Bearer <key>',
  });
}

/** GET /v1/profile — what Num currently knows about you. */
async function getProfile(env, businessId, placeId) {
  const p = await env.DB.prepare(
    `SELECT id, name, category, dest, area, country, address, phone, website, hours, cuisine, status, business_id
       FROM places WHERE id=?1`,
  ).bind(placeId).first();
  if (!p) return err('not_found', 'Listing not found.', 404);
  // num_business_profiles carries the commerce-layer fields the claim/onboard
  // flow initialises (vertical, commerce_status, notify_channel, ...) — merged
  // in here so one profile response reflects the now-unified data model rather
  // than making a caller learn to fetch two things.
  const biz = await env.DB.prepare(
    `SELECT vertical, commerce_status, notify_channel, default_locale, timezone
       FROM num_business_profiles WHERE business_id=?1`,
  ).bind(businessId).first().catch(() => null);
  return json({ profile: { ...publicPlace(p), business_id: businessId, ...(biz ?? {}) } });
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

async function patchProfile(env, businessId, placeId, req) {
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
  return getProfile(env, businessId, placeId);
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
  // A key can be valid (the business is verified and onboarded) while still
  // having no place_id — num_place_owners rows are revocable, and a business
  // could in principle exist without ever having owned a listing. Every route
  // below reads/writes `places` by placeId, so fail clearly instead of a
  // confusing 404/undefined further down.
  if (!auth.placeId) {
    return err('no_listing', 'This key is valid but is not attached to a listing yet.', 409);
  }

  if (path === '/v1/profile' && request.method === 'GET') return getProfile(env, auth.businessId, auth.placeId);
  if (path === '/v1/profile' && request.method === 'PATCH') return patchProfile(env, auth.businessId, auth.placeId, request);
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
    // The MCP surface publishes six tools and, until today, this index — the
    // only machine-readable description of /api/biz that exists — listed none
    // of them. That is a listing nothing can be diffed against, which is how a
    // tool gets added, removed or renamed without any check noticing.
    // Generated from bizmcp.mjs rather than retyped: a hand-maintained second
    // copy of a tool list is a copy that goes stale.
    mcp_tools: BIZ_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description.split('.')[0] + '.' })),
    not_editable: ['category', 'rating', 'position in recommendations'],
    why: 'A business controls how it is described. It does not control where it ranks — that belongs to the guest.',
  });
}
