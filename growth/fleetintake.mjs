// A fleet, from a camera roll.
//
// THE PROBLEM THIS SOLVES. Listing a boat took eleven fields before anything
// existed to look at. num_assets holds zero rows, one host has signed up, and
// the CHARTER tile on TODAY had to be rewritten to promise a relay instead of
// inventory — not because the code was missing but because nobody was going to
// type eleven fields ten times. A host has the photographs already.
//
// THE SHAPE. Three endpoints, and each does one thing:
//
//   POST /api/host/fleet-upload    one photograph, into R2 and the media table
//   POST /api/host/fleet-intake    a batch of them → identified DRAFT assets
//   POST /api/host/fleet-draft     confirm one, discard one, or list it as a product
//
// WHY UPLOAD IS ITS OWN CALL. A Worker request has a body limit and a CPU
// budget; twelve 4MB photographs in one multipart body is how this breaks on
// the first host with a good camera. One photograph per request also means a
// failed upload costs that photograph and not the batch, and the console can
// show a row going green as each one lands.
//
// WHAT NEVER HAPPENS HERE:
//   · Nothing becomes listable. Everything this file writes is draft = 1,
//     listable = 0. A member cannot be shown any of it until a human says so.
//   · No price is set. `rate_unit` is 'quote' and `rate_minor` is 0 until the
//     host types a number, because a rate nobody agreed to is a rate a client
//     will hold them to.
//   · A registration never reaches client copy. fleetvision.scrub() takes it
//     out of the name and the listing, and it is stored in the private column
//     the client view does not select.

import { identify, MAX_IMAGES, VISION_TYPES, visionReady } from './fleetvision.mjs';
import { rows, readFailedResponse, isReadFailed } from './readfail.mjs';

// Matches inboundmedia's ceiling. A phone photograph is 2-5MB.
export const MAX_BYTES = 12 * 1024 * 1024;

/* The `identify` reasons that mean we genuinely could not look, as opposed to
 * looked and could not tell. The difference matters to a host: one is ours to
 * fix and worth their trying again later, the other is a real answer about
 * their photograph. Telling them the first when it was the second is how a
 * working feature gets written off. 'http_*' is variable, so it is matched
 * separately where this set is used. */
export const READ_FAILED = new Set(['no_images', 'unreachable', 'bad_json', 'workers_ai_silent']);

export const UPLOAD_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif',
]);

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif',
};

const nid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Bytes → base64, in chunks. A 4MB photograph spread over one
 *  String.fromCharCode(...bytes) call blows the argument limit and throws. */
export function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

/**
 * POST /api/host/fleet-upload?k=KEY
 * Body: the raw image. Content-Type is the image type.
 * Optional header: x-num-filename
 *
 * Idempotent on the bytes: uploading the same photograph twice returns the
 * first media id rather than a second copy, because a host who drags a folder
 * in twice has not changed their mind about anything.
 */
export async function fleetUpload(req, env, url, D) {
  const { J, clean, badOrigin, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== 'active') return J({ ok: false, error: 'host_not_active' }, 403);

  const type = String(req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!UPLOAD_TYPES.has(type)) {
    return J({
      ok: false, error: 'bad_type',
      says: 'That file is not a photograph we can use. JPEG, PNG, WebP or HEIC.',
    }, 415);
  }

  // Declared length first, so an oversized file is refused before it is read.
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) {
    return J({ ok: false, error: 'too_big', says: 'That photograph is over 12MB.' }, 413);
  }

  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return J({ ok: false, error: 'empty' }, 400);
  if (buf.byteLength > MAX_BYTES) {
    return J({ ok: false, error: 'too_big', says: 'That photograph is over 12MB.' }, 413);
  }

  if (!env.PHOTOS) {
    // Loud, and honest to the host: the row would point at bytes that are not
    // there, which is the one failure mode inboundmedia.mjs is built to avoid.
    console.warn('[fleet] PHOTOS bucket not bound — upload refused');
    return J({ ok: false, error: 'storage_unavailable' }, 503);
  }

  const sha = await sha256Hex(buf);
  const sid = host.id + ':' + sha;

  const already = await env.DB.prepare(
    "SELECT id, status, asset_id FROM num_inbound_media WHERE provider='upload' AND provider_sid=?1"
  ).bind(sid).first().catch(() => null);
  if (already) {
    return J({ ok: true, media_id: already.id, sha256: sha, bytes: buf.byteLength, already: true,
      attached: !!already.asset_id });
  }

  const id = nid('med_');
  const key = `uploads/${host.id}/${id}.${EXT[type] || 'bin'}`;
  try {
    await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
  } catch (e) {
    console.warn('[fleet] r2 put failed', e?.message ?? e);
    return J({ ok: false, error: 'storage_failed' }, 502);
  }

  await env.DB.prepare(
    `INSERT INTO num_inbound_media
       (id, from_hash, from_last4, supplier_id, r2_key, content_type, bytes, sha256,
        provider, provider_sid, body, status, created_at)
     VALUES (?1,?2,NULL,?3,?4,?5,?6,?7,'upload',?8,?9,'new',?10)`
  ).bind(
    id,
    // Not a phone number and not pretending to be one. The column groups a
    // sender's photographs together; for an upload the sender is the host.
    'host:' + host.id,
    null,
    key, type, buf.byteLength, sha, sid,
    clean(req.headers.get('x-num-filename'), 200) || null,
    now()
  ).run();

  return J({ ok: true, media_id: id, sha256: sha, bytes: buf.byteLength, type });
}

/**
 * POST /api/host/fleet-intake?k=KEY
 * { media_ids: [...], owner_id?, hint? }
 *
 * Looks at them together, groups the ones showing the same thing, and writes
 * one draft asset per group with the photographs attached to it.
 */
export async function fleetIntake(req, env, url, D) {
  const { J, clean, readJSON, badOrigin, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== 'active') return J({ ok: false, error: 'host_not_active' }, 403);

  let b;
  try { b = await readJSON(req, 16384); } catch { return J({ ok: false, error: 'bad_body' }, 400); }

  const ids = (Array.isArray(b.media_ids) ? b.media_ids : [])
    .map((x) => clean(x, 40)).filter(Boolean).slice(0, MAX_IMAGES);
  if (!ids.length) return J({ ok: false, error: 'no_media' }, 400);

  // Only this host's own uploads, only ones not already filed. The media table
  // holds every supplier's texted-in photographs too, and a media id in a
  // request body is not a claim we take on trust.
  const ph = ids.map((_, i) => '?' + (i + 2)).join(',');
  const mine = await env.DB.prepare(
    `SELECT id, r2_key, content_type, bytes FROM num_inbound_media
      WHERE from_hash = ?1 AND status = 'new' AND id IN (${ph})`
  ).bind('host:' + host.id, ...ids).all().catch(() => null);
  const media = (mine && mine.results) || [];
  if (!media.length) return J({ ok: false, error: 'nothing_to_read' }, 404);

  // An owner other than the host must be a supplier they actually have.
  let ownerId = clean(b.owner_id, 40) || host.id;
  if (ownerId !== host.id) {
    const linked = await env.DB.prepare(
      `SELECT 1 FROM num_supplier_links
        WHERE host_id = ?1 AND supplier_id = ?2 AND status = 'accepted' AND ended_at IS NULL LIMIT 1`
    ).bind(host.id, ownerId).first().catch(() => null);
    if (!linked) return J({ ok: false, error: 'not_your_supplier' }, 403);
  }

  // Read the bytes back for the ones the vision API can actually take. A HEIC
  // is stored and attached like any other photograph; it is simply not sent to
  // be looked at, and the host is told which ones that applies to.
  const images = [];
  const unreadable = [];
  for (const m of media) {
    const t = String(m.content_type || '').toLowerCase();
    if (!VISION_TYPES.has(t)) { unreadable.push(m.id); continue; }
    const obj = env.PHOTOS ? await env.PHOTOS.get(m.r2_key).catch(() => null) : null;
    if (!obj) { unreadable.push(m.id); continue; }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    images.push({ id: m.id, media_type: t === 'image/jpg' ? 'image/jpeg' : t, data: toBase64(bytes) });
  }

  const seen = await identify(env, images, {});
  const groups = seen.groups.slice();

  // Photographs the model could not be shown are not thrown away: each gets a
  // draft of its own for the host to name.
  for (const id of unreadable) {
    groups.push({
      photos: [], mediaIds: [id], kind: 'other', name: 'Not yet identified',
      make: null, model: null, year: null, guests: null, crew: null, spec: null,
      registration: null, listing: '', confidence: 'low', identified: false,
      unsure: 'We could not open this one to look at it. Tell us what it is.',
    });
  }

  const batchId = nid('bat_');
  const { attachToAsset } = await import('../worker/inboundmedia.mjs');
  const made = [];

  for (const g of groups) {
    const mediaIds = g.mediaIds || g.photos.map((i) => images[i] && images[i].id).filter(Boolean);
    if (!mediaIds.length) continue;

    const assetId = nid('ast_');
    const identified = {
      // Which reader actually answered, not which one we hoped for. A host
      // whose photographs were read by the smaller model should be able to
      // see that rather than conclude the feature is simply bad.
      by: g.by || (env.ANTHROPIC_API_KEY ? (env.NUM_VISION_MODEL || 'claude-haiku-4-5') : null),
      at: now(),
      confidence: g.confidence,
      unsure: g.unsure || null,
      colour: g.colour || null,
      reason: seen.reason,
    };

    try {
      await env.DB.prepare(
        `INSERT INTO num_assets
           (id, owner_kind, owner_id, host_id, kind, name, make, model, year, registration,
            spec, home_city, home_country, guests, crew, currency, rate_minor, rate_unit,
            notes, settle_mode, listable, status, draft, identified_json, created_at)
         VALUES (?1,'supplier',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,0,'quote',?16,
                 'host_direct',0,'active',1,?17,?18)`
      ).bind(
        assetId, ownerId, host.id, g.kind, g.name,
        g.make, g.model, g.year, g.registration,
        g.spec ? JSON.stringify(g.spec).slice(0, 4000) : null,
        clean(b.home_city, 120) || null, clean(b.home_country, 80) || null,
        g.guests, g.crew, (host.currency || 'GBP').toUpperCase().slice(0, 3),
        g.listing || null, JSON.stringify(identified).slice(0, 2000), now()
      ).run();
    } catch (e) {
      console.warn('[fleet] draft insert failed', e?.message ?? e);
      continue;
    }

    const photos = [];
    for (const mid of mediaIds) {
      // source 'upload' and moderation 'ok': the host chose these files off
      // their own device thirty seconds ago. See the note in attachToAsset.
      const r = await attachToAsset(env, {
        mediaId: mid, assetId, by: `host:${host.id}`, source: 'upload', moderation: 'ok',
      });
      if (r.ok && r.photoId) {
        photos.push(r.photoId);
        await env.DB.prepare('UPDATE num_asset_photos SET batch_id = ?1 WHERE id = ?2')
          .bind(batchId, r.photoId).run().catch(() => {});
      }
    }

    made.push({
      id: assetId, kind: g.kind, name: g.name, make: g.make, model: g.model, year: g.year,
      guests: g.guests, crew: g.crew, notes: g.listing || '', registration: g.registration,
      confidence: g.confidence, unsure: g.unsure || null, identified: !!g.identified,
      photos, photo_count: photos.length,
    });
  }

  return J({
    ok: true,
    batch_id: batchId,
    drafts: made,
    identified: seen.identified,
    // Said plainly rather than left for the host to infer from empty fields.
    says: seen.identified
      ? `${made.length} draft${made.length === 1 ? '' : 's'} from ${media.length} photograph${media.length === 1 ? '' : 's'}. Check what we read off them, add your price, then say go.`
        // Said plainly when the smaller reader answered. It works one picture
        // at a time, so it cannot tell that four photographs are one boat the
        // way the other one can — and a host who is told that will merge two
        // drafts rather than assume the feature is broken.
        + (seen.reason === 'workers_ai'
          ? ' These were read one picture at a time, so pictures of the same thing may have landed in separate drafts \u2014 merge them by deleting one and adding its photographs to the other.'
          : '')
      /* THREE THINGS, NOT TWO. `identified === false` covers two completely
       * different events, and the copy here told a host the same wrong story
       * for both — plus one outright falsehood.
       *
       * Found 19 Sep 2026 by dropping a photograph in and reading the banner.
       * Workers AI HAD looked at it and answered "No vehicle in this one",
       * which was correct; that answer was printed on the draft card, and the
       * banner directly above it called the read a failure. A host reads that
       * and concludes the feature is broken when it had just worked.
       *
       * The dangerous half was "Fill the names in and they are live." Nothing
       * this file writes is live: every row is draft = 1, listable = 0, and
       * Go live refuses again without an approved photograph. Two gates exist
       * so that a model never gets the last word, and one sentence telling a
       * host it is already done defeats both. It is gone. */
      : (seen.reason === 'no_brain'
        ? 'Your photographs are saved. Reading them automatically is not switched on yet, so the names are yours '
          + 'to fill in — then say go on each one.'
        : (READ_FAILED.has(seen.reason) || /^http_/.test(String(seen.reason))
          ? 'Your photographs are saved and grouped, but we could not read them just now. Name each one yourself '
            + 'and say go — or come back later and we will try again.'
          : 'Your photographs are saved and grouped. We looked and could not tell what we were looking at — each '
            + 'draft says why. Name them yourself and say go.')),
  });
}

/**
 * POST /api/host/fleet-draft?k=KEY
 * { action: 'confirm' | 'discard' | 'product', id, ... }
 *
 * Confirm is the human saying yes. It is deliberately a separate call from the
 * one that created the draft: a thing that listed itself because a model was
 * confident would be a thing nobody checked.
 */
export async function fleetDraft(req, env, url, D) {
  const { J, clean, readJSON, badOrigin, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);

  let b;
  try { b = await readJSON(req, 16384); } catch { return J({ ok: false, error: 'bad_body' }, 400); }
  const action = String(b.action || '');
  const id = clean(b.id, 40);
  if (!id) return J({ ok: false, error: 'no_id' }, 400);

  const asset = await env.DB.prepare(
    'SELECT * FROM num_assets WHERE id = ?1 AND host_id = ?2'
  ).bind(id, host.id).first().catch(() => null);
  if (!asset) return J({ ok: false, error: 'not_your_asset' }, 403);

  if (action === 'confirm') {
    await env.DB.prepare('UPDATE num_assets SET draft = 0, updated_at = ?1 WHERE id = ?2')
      .bind(now(), id).run();
    return J({ ok: true, id, draft: false });
  }

  if (action === 'discard') {
    // Retired, not deleted. A photograph that was filed against it, a hold, or
    // a job that mentioned it all still have something to point at — and 0021
    // requires a retired row to carry the time it happened.
    await env.DB.prepare(
      "UPDATE num_assets SET status='retired', retired_at=?1, updated_at=?1 WHERE id=?2"
    ).bind(now(), id).run();
    return J({ ok: true, id, discarded: true });
  }

  /* LIST IT AS A PRODUCT.
   *
   * A product is the host's shelf — the thing a client can be sent, and what
   * the concierge quotes from. An asset and a product are not the same record
   * and should not become one: an asset is a hull with a calendar, a product
   * is an offer with a price. `asset_id` is the link, so a fleet of six is six
   * products that each still know which boat they are.
   *
   * A product made this way is NOT active. Same rule as everywhere else here:
   * the host turns it on. */
  if (action === 'product') {
    if (asset.draft) {
      return J({ ok: false, error: 'still_a_draft',
        says: 'Check this one over and say go first — then it can go on your shelf.' }, 409);
    }

    const price = Math.max(0, Math.round(Number(b.price_minor ?? asset.rate_minor) || 0));
    const unitMap = { hour: 'hour', day: 'day', week: 'day', trip: 'item', quote: 'quote' };
    const unit = unitMap[asset.rate_unit] || 'quote';

    // The first approved photograph, served from our own domain by the public
    // route that only ever serves approved ones.
    const photo = await env.DB.prepare(
      `SELECT id FROM num_asset_photos WHERE asset_id = ?1 AND moderation = 'ok'
        ORDER BY position ASC, created_at ASC LIMIT 1`
    ).bind(id).first().catch(() => null);

    const existing = await env.DB.prepare(
      'SELECT id FROM num_host_products WHERE host_id = ?1 AND asset_id = ?2 LIMIT 1'
    ).bind(host.id, id).first().catch(() => null);

    // Client copy, so it goes through the same scrub as everything else: an
    // asset saved by hand could carry its plate in the notes field.
    const { scrub } = await import('./fleetvision.mjs');
    const description = scrub(asset.notes || '', asset.registration) || null;
    const name = scrub(asset.name || 'Charter', asset.registration).slice(0, 120);

    const pid = existing ? existing.id : nid('hp_');
    if (existing) {
      await env.DB.prepare(
        `UPDATE num_host_products
            SET name=?1, description=?2, category=?3, price_minor=?4, currency=?5,
                unit=?6, photo_url=?7, updated_at=?8
          WHERE id=?9 AND host_id=?10`
      ).bind(name, description, asset.kind, price, asset.currency, unit,
        photo ? `/p/asset/${photo.id}` : null, now(), pid, host.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO num_host_products
           (id, host_id, kind, name, description, category, price_minor, currency, unit,
            photo_url, asset_id, moderation, active, created_at)
         VALUES (?1,?2,'own',?3,?4,?5,?6,?7,?8,?9,?10,'pending',0,?11)`
      ).bind(pid, host.id, name, description, asset.kind, price, asset.currency, unit,
        photo ? `/p/asset/${photo.id}` : null, id, now()).run();
    }

    return J({
      ok: true, product_id: pid, asset_id: id, active: false,
      says: 'On your shelf, switched off. Set the price and turn it on under Products.',
    });
  }

  return J({ ok: false, error: 'unknown_action' }, 400);
}

/**
 * GET /api/host/fleet-drafts?k=KEY — what is waiting to be checked.
 * Its own endpoint rather than a flag on /api/host/assets, so an older console
 * build cannot show drafts as though they were listed inventory.
 */
export async function fleetDrafts(req, env, url, D) {
  const { J, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);
  try {
    const drafts = await rows(env.DB.prepare(
      `SELECT a.id, a.kind, a.name, a.make, a.model, a.year, a.guests, a.crew,
              a.notes, a.registration, a.identified_json, a.created_at,
              (SELECT COUNT(*) FROM num_asset_photos p WHERE p.asset_id = a.id) AS photos
         FROM num_assets a
        WHERE a.host_id = ?1 AND a.draft = 1 AND a.status = 'active'
        ORDER BY a.created_at DESC LIMIT 60`
    ).bind(host.id).all(), 'your drafts');
    return J({
      ok: true,
      vision: visionReady(env),
      drafts: drafts.map((d) => ({
        ...d,
        identified: d.identified_json ? safeJson(d.identified_json) : null,
        identified_json: undefined,
      })),
    });
  } catch (e) {
    if (isReadFailed(e)) return readFailedResponse(J, e);
    throw e;
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
