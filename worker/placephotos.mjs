/**
 * PLACE PHOTOS — NUM's own pictures, taken by members who were standing there.
 *
 * ── THE RULES, IN ONE PLACE ──────────────────────────────────────────────
 *
 *   · A photo is accepted from a member NUM can reach (hasVerifiedContact),
 *     for a place that exists, up to 8 MB, as JPEG / PNG / WebP / HEIC.
 *   · How we know they were there is recorded on the row, never inferred
 *     later: 'scan' if they scanned the venue's own NUM code in the last
 *     hour (num_connections, via 'scan'), 'fix' if the phone's fix at capture
 *     is within 150 m of the place, else 'none'.
 *   · Nothing reaches a shelf until a human approves it (state 'approved').
 *   · THE REWARD IS ONE CENT, PAID AS STARS. The offer is "$0.01 per verified
 *     image" and a Star is a dollar, so cents accrue in num_photo_credit and
 *     every 100 becomes ★1 as kind 'reward' — cashable, like a bounty. Paid
 *     only when the photo is approved AND proof is scan/fix AND the member's
 *     identity is 5arz-verified: proof says they were there, 5arz says who
 *     they are, and the cent needs both.
 *   · CAP: 3 photos per member per place per 30 days, pending or approved.
 *     A place needs a handful of current pictures, not a hundred of one
 *     person's Tuesday.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * It is not a scraper. Yelp's and Google's photos are theirs, under terms that
 * forbid caching them into our own table. Every picture here has a member id
 * and a proof column under it, which is the only kind of photo library NUM
 * should own.
 *
 * Failed reads throw and 503 — no `.catch(() => ({ results: [] }))` on a list.
 */
import { hasVerifiedContact } from './membercontact.mjs';
import { adminOk } from './adminkey.mjs';
import { isAdmin } from './console.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export const MAX_BYTES = 8 * 1024 * 1024;
export const TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' });
export const NEAR_KM = 0.15;
export const SCAN_WINDOW_MIN = 60;
export const CAP_PER_PLACE_30D = 3;
export const REWARD_CENTS = 1;
export const CENTS_PER_STAR = 100;

const R = 6371;
export function haversineKm(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180;
  const x = Math.sin(aLat * rad) * Math.sin(bLat * rad)
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.cos((bLng - aLng) * rad);
  return R * Math.acos(Math.min(1, Math.max(-1, x)));
}

const nid = (p) => p + [...crypto.getRandomValues(new Uint8Array(10))].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * How we know they were there. Pure, so it is testable without a database:
 * the caller passes what it looked up.
 */
export function proofOf({ scannedAgoMin = null, fixKm = null } = {}) {
  if (scannedAgoMin != null && scannedAgoMin >= 0 && scannedAgoMin <= SCAN_WINDOW_MIN) return { proof: 'scan', proof_km: fixKm };
  if (fixKm != null && fixKm <= NEAR_KM) return { proof: 'fix', proof_km: fixKm };
  return { proof: 'none', proof_km: fixKm };
}

/** The payment rule, stated once. */
export const earns = (row) => row.state === 'approved' && (row.proof === 'scan' || row.proof === 'fix') && Number(row.identity_verified) === 1;

/** Accept one photo. Returns the row the app shows, or a refusal with the reason in plain words. */
export async function upload(env, request, url) {
  if (!env?.DB) return json({ error: 'no database' }, 503);
  if (!env.PHOTOS) return json({ error: 'Photos aren’t switched on yet.' }, 503);

  const me = String(url.searchParams.get('me') ?? '').trim();
  // The rail prefixes place ids `pl_`; the table does not.
  const placeId = String(url.searchParams.get('place') ?? '').trim().replace(/^pl_/, '');
  if (!me || !placeId) return json({ error: 'who and where are required' }, 400);

  const member = await env.DB.prepare('SELECT id, phone_verified, email_verified FROM num_members WHERE id = ?1').bind(me).first();
  if (!member) return json({ error: 'unknown member' }, 404);
  if (!hasVerifiedContact(member)) return json({ error: 'verify_to_send', message: 'Verify a number or an email first — NUM has to know who took it.' }, 403);
  // identity_verified is added to num_members lazily by the first 5arz link
  // (social.mjs), so on a fresh database the column may not exist yet. A
  // single-row probe; absent column means nobody is verified, which is true.
  const idRow = await env.DB.prepare('SELECT identity_verified FROM num_members WHERE id = ?1').bind(me).first().catch(() => null);
  member.identity_verified = Number(idRow?.identity_verified ?? 0) === 1 ? 1 : 0;

  const place = await env.DB.prepare('SELECT id, name, lat, lng FROM places WHERE id = ?1').bind(placeId).first();
  if (!place) return json({ error: 'unknown place' }, 404);

  const type = String(request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (!TYPES[type]) return json({ error: 'That isn’t a photo NUM can take — JPEG, PNG, WebP or HEIC.' }, 415);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: 'empty' }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ error: 'That one is over 8 MB — most phones can send a smaller copy.' }, 413);

  // The cap, before anything is stored.
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) n FROM num_place_photos WHERE member_id = ?1 AND place_id = ?2 AND state != 'rejected' AND created_at > datetime('now', '-30 days')",
  ).bind(me, placeId).first();
  if (Number(recent?.n ?? 0) >= CAP_PER_PLACE_30D) {
    return json({ error: 'capped', message: `You’ve added ${CAP_PER_PLACE_30D} photos of this place this month — thank you. Come back next month.` }, 429);
  }

  // Proof: a scan of the venue's code in the last hour, or the fix at capture.
  const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
  const fixKm = Number.isFinite(lat) && Number.isFinite(lng) && place.lat != null && place.lng != null
    ? haversineKm(lat, lng, Number(place.lat), Number(place.lng)) : null;
  const scan = await env.DB.prepare(
    "SELECT (julianday('now') - julianday(last_met_at)) * 1440 AS ago FROM num_connections WHERE from_type = 'member' AND from_id = ?1 AND to_type = 'business' AND via = 'scan' AND place = ?2 ORDER BY last_met_at DESC LIMIT 1",
  ).bind(me, place.name ?? '').first().catch(() => null);
  const { proof, proof_km } = proofOf({ scannedAgoMin: scan?.ago ?? null, fixKm });

  const digest = await sha256Hex(buf);
  const dupe = await env.DB.prepare('SELECT id, state FROM num_place_photos WHERE member_id = ?1 AND sha256 = ?2').bind(me, digest).first();
  if (dupe) return json({ ok: true, id: dupe.id, state: dupe.state, duplicate: true });

  const id = nid('ph_');
  const key = `place-photos/${placeId}/${id}.${TYPES[type]}`;
  await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  await env.DB.prepare(
    `INSERT INTO num_place_photos (id, place_id, member_id, r2_key, content_type, bytes, sha256, proof, proof_km, identity_verified)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
  ).bind(id, placeId, me, key, type, buf.byteLength, digest, proof, proof_km == null ? null : Math.round(proof_km * 1000) / 1000, Number(member.identity_verified) === 1 ? 1 : 0).run();

  // Said plainly at the moment it matters: what happens next, and whether a
  // cent is coming. Never "you earned" before a human has looked.
  const paid = (proof === 'scan' || proof === 'fix') && Number(member.identity_verified) === 1;
  const note = paid
    ? 'Thanks — it goes up once it’s been checked, and the cent is yours then.'
    : proof === 'none'
      ? 'Thanks — it goes up once it’s been checked. Photos taken at the place, with your location on, earn a cent each.'
      : 'Thanks — it goes up once it’s been checked. Verify with 5arz in your profile and photos like this earn a cent each.';
  return json({ ok: true, id, state: 'pending', proof, earns_when_approved: paid, note });
}

/** Approved photos of one place, newest first — what a shelf or a card shows. */
export async function forPlace(env, placeId, origin, limit = 12) {
  const { results } = await env.DB.prepare(
    "SELECT id, member_id, created_at FROM num_place_photos WHERE place_id = ?1 AND state = 'approved' ORDER BY created_at DESC LIMIT ?2",
  ).bind(placeId, Math.min(50, Math.max(1, limit | 0))).all();
  return (results ?? []).map((r) => ({ id: r.id, url: `${origin}/api/photos/img/${r.id}`, taken: r.created_at }));
}

/** Stream one image from R2. Approved to anyone; pending/rejected only to a reviewer. */
export async function image(env, id, { admin = false } = {}) {
  const row = await env.DB.prepare('SELECT r2_key, content_type, state FROM num_place_photos WHERE id = ?1').bind(id).first();
  if (!row) return new Response('not found', { status: 404 });
  if (row.state !== 'approved' && !admin) return new Response('not found', { status: 404 });
  const obj = await env.PHOTOS.get(row.r2_key);
  if (!obj) return new Response('gone', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.content_type,
      'Cache-Control': row.state === 'approved' ? 'public, max-age=604800, stale-while-revalidate=86400' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** The review queue. Oldest first, because the person who waited longest is owed first. */
export async function pending(env, origin, limit = 50) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.place_id, pl.name AS place, p.member_id, m.name AS member, p.proof, p.proof_km, p.identity_verified, p.bytes, p.created_at
       FROM num_place_photos p LEFT JOIN places pl ON pl.id = p.place_id LEFT JOIN num_members m ON m.id = p.member_id
      WHERE p.state = 'pending' ORDER BY p.created_at ASC LIMIT ?1`,
  ).bind(Math.min(200, Math.max(1, limit | 0))).all();
  return (results ?? []).map((r) => ({ ...r, url: `${origin}/api/photos/img/${r.id}`, would_earn: earns({ ...r, state: 'approved' }) }));
}

/**
 * Approve or reject. Approval pays the cent when the rule says so, and turns
 * a hundred cents into ★1. Idempotent: a second approval of the same photo
 * changes nothing and pays nothing.
 */
export async function review(env, { id, state, reason = null, by = 'console' }) {
  if (!['approved', 'rejected'].includes(state)) return json({ error: 'state must be approved or rejected' }, 400);
  const row = await env.DB.prepare('SELECT * FROM num_place_photos WHERE id = ?1').bind(id).first();
  if (!row) return json({ error: 'unknown photo' }, 404);
  if (row.state !== 'pending') return json({ ok: true, id, state: row.state, already: true });

  const cents = state === 'approved' && earns({ ...row, state }) ? REWARD_CENTS : 0;
  const flip = await env.DB.prepare(
    "UPDATE num_place_photos SET state = ?2, reviewed_at = datetime('now'), reviewed_by = ?3, reject_reason = ?4, reward_cents = ?5 WHERE id = ?1 AND state = 'pending'",
  ).bind(id, state, String(by).slice(0, 60), reason ? String(reason).slice(0, 200) : null, cents).run();
  // Two reviewers, one photo, same second: only the UPDATE that actually
  // flipped the row pays. The other sees zero changes and pays nothing.
  if (Number(flip?.meta?.changes ?? 1) === 0) return json({ ok: true, id, state: 'pending', already: true });

  let starred = 0;
  if (cents > 0) {
    await env.DB.prepare('INSERT OR IGNORE INTO num_photo_credit (member_id, cents) VALUES (?1, 0)').bind(row.member_id).run();
    await env.DB.prepare("UPDATE num_photo_credit SET cents = cents + ?2, updated_at = datetime('now') WHERE member_id = ?1").bind(row.member_id, cents).run();
    const credit = await env.DB.prepare('SELECT cents FROM num_photo_credit WHERE member_id = ?1').bind(row.member_id).first();
    const whole = Math.floor(Number(credit?.cents ?? 0) / CENTS_PER_STAR);
    if (whole >= 1) {
      // A hundred cents is a Star. Move id keyed on the photo that tipped it,
      // so a retried review cannot mint twice.
      // The MOVE goes in first, OR IGNORE, and the balance only grows when
      // that insert changed a row — the move is the lock, as in the welcome
      // grant. The amount is whole hundreds of cents this module itself
      // accrued (REWARD_CENTS per approval), never a client value.
      const moveId = `photo:${id}`;
      const minted = await env.DB.prepare(
        "INSERT OR IGNORE INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'reward',?4,?5)",
      ).bind(moveId, row.member_id, whole, `${whole * CENTS_PER_STAR} photo cents became ★${whole}`, row.place_id).run();
      if (Number(minted?.meta?.changes ?? 1) > 0) {
        await env.DB.prepare('INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?1, 0)').bind(row.member_id).run();
        await env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(row.member_id, whole).run();
        await env.DB.prepare("UPDATE num_photo_credit SET cents = cents - ?2, updated_at = datetime('now') WHERE member_id = ?1").bind(row.member_id, whole * CENTS_PER_STAR).run();
        starred = whole;
      }
    }
  }
  return json({ ok: true, id, state, cents, starred });
}

/**
 * Routes under /api/photos. The review routes take the raw admin key
 * (adminkey.mjs, for scripts) or a signed-in console session (console.mjs,
 * for the person in the app). Both fail closed when ADMIN_KEY is unset.
 */
export async function handlePlacePhotos(request, env, path, url) {
  const origin = url.origin;
  const admin = adminOk(request, env) || (await isAdmin(env, request));
  if (request.method === 'POST' && path === '/upload') return upload(env, request, url);
  if (request.method === 'GET' && path.startsWith('/place/')) {
    return json({ ok: true, photos: await forPlace(env, decodeURIComponent(path.slice('/place/'.length)), origin, Number(url.searchParams.get('limit') || 12)) });
  }
  if (request.method === 'GET' && path.startsWith('/img/')) return image(env, path.slice('/img/'.length), { admin });
  if (path === '/pending' && request.method === 'GET') {
    if (!admin) return json({ error: 'forbidden' }, 403);
    return json({ ok: true, pending: await pending(env, origin, Number(url.searchParams.get('limit') || 50)) });
  }
  if (path === '/review' && request.method === 'POST') {
    if (!admin) return json({ error: 'forbidden' }, 403);
    const b = await request.json().catch(() => ({}));
    return review(env, { id: String(b.id ?? ''), state: String(b.state ?? ''), reason: b.reason ?? null, by: b.by ?? 'console' });
  }
  return json({ error: 'not found' }, 404);
}
