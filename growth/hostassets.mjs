// The fleet. Yachts, boats, jets, helicopters, cars, villas.
//
// A host who charters a 24-metre boat is not running a different product from a
// host who books a restaurant table — they are the same host with a bigger
// thing to let. So this lives behind the same console key as every other host
// endpoint, and obeys the same rule: the host owns the relationship, NUM tracks
// it, and nothing reaches a booker that a human has not looked at.
//
// Injected with the worker's own helpers rather than importing them, for the
// same reason claimDeps does it: growth/worker.js is 9,400 lines and two
// sessions edit it. A module that takes its dependencies can be added with
// eight lines of diff there instead of four hundred.

import { rows, readFailedResponse, isReadFailed } from './readfail.mjs';

export const KINDS = ['yacht', 'boat', 'jet', 'helicopter', 'car', 'villa', 'other'];
export const RATE_UNITS = ['hour', 'day', 'week', 'trip', 'quote'];
export const SETTLE = ['host_direct', 'num_collects'];
export const STATUSES = ['active', 'paused', 'retired'];
export const MODERATION = ['new', 'ok', 'rejected'];
export const HOLD_KINDS = ['booked', 'provisional', 'blocked', 'maintenance'];

const nid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Money in from a form is the single most common place a silent wrong number
// gets stored. "1,250" and "1250.00" and "£1250" all mean the same thing to a
// host typing quickly and three different things to parseInt.
export function rateMinor(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).replace(/[^\d.]/g, '');
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  // The form always collects MAJOR units, because that is what a host types:
  // they think "1250 a day", not "125000 a day". So this is always a x100, and
  // "1,250", "1250" and "1250.00" all land on the same integer.
  return Math.round(n * 100);
}

const pick = (v, allowed, fallback) =>
  allowed.includes(String(v ?? '')) ? String(v) : fallback;

const num = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i >= lo && i <= hi ? i : null;
};

/**
 * The rule we will not break: a registration number never travels to a client.
 *
 * A yacht or aircraft registration identifies the hull to anyone who looks it
 * up — owner, insurer, past sales, current mortgage. A booker needs to know
 * it is a 24-metre Sunseeker that sleeps eight. They do not need the hull's
 * identity, and giving it to them hands over the owner's business.
 *
 * assetintegrity.mjs raises `registration_in_client_copy` as a BREACH when a
 * registration leaks into a field a client sees. This function is the thing
 * that stops it happening in the first place — every client-facing shape goes
 * through here, and the column is simply not in the select.
 */
export function clientView(a) {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    make: a.make,
    model: a.model,
    year: a.year,
    spec: a.spec ? safeJson(a.spec) : null,
    home_port: a.home_port,
    home_city: a.home_city,
    home_country: a.home_country,
    guests: a.guests,
    crew: a.crew,
    currency: a.currency,
    rate_minor: a.rate_minor,
    rate_unit: a.rate_unit,
    extras_note: a.extras_note,
    photos: a.photos || [],
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/* ------------------------------------------------------------- the fleet */

/**
 * GET  /api/host/assets        — everything this host can let out
 * POST /api/host/assets        — create, update, retire
 *
 * A host sees their OWN fleet and the fleet of suppliers they are linked to,
 * and nothing else. That is enforced in the WHERE clause rather than filtered
 * afterwards, because a filter you forget is a data leak and a WHERE clause you
 * forget is an empty list.
 */
export async function hostAssets(req, env, url, D) {
  const { J, clean, readJSON, badOrigin, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);

  const list = async () => {
    const fleetQ = env.DB.prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM num_asset_photos p
                WHERE p.asset_id = a.id AND p.moderation = 'ok') AS photos_ok,
              (SELECT COUNT(*) FROM num_asset_photos p
                WHERE p.asset_id = a.id AND p.moderation = 'new') AS photos_pending
         FROM num_assets a
        WHERE a.host_id = ?1 AND a.status <> 'retired'
        ORDER BY a.kind ASC, a.name ASC
        LIMIT 300`
    ).bind(host.id);

    // The photo queue: texted-in pictures with no home yet. Shown with the
    // fleet rather than on its own page, because a photo waiting for a decision
    // is part of the fleet's state, not a separate chore.
    const queueQ = env.DB.prepare(
      `SELECT m.id, m.from_last4, m.content_type, m.bytes, m.body, m.status,
              m.created_at, s.display_name AS supplier_name
         FROM num_inbound_media m
         LEFT JOIN num_suppliers s ON s.id = m.supplier_id
        WHERE m.status IN ('new','unknown_sender')
          AND (
            -- Photographs from suppliers THIS host actually has.
            m.supplier_id IN (
              SELECT supplier_id FROM num_supplier_links
               WHERE host_id = ?1 AND status = 'accepted' AND ended_at IS NULL)
            -- Or ones this host uploaded themselves and that never got filed.
            OR m.from_hash = ?2
            /* Or a text from a number we could not place. THE provider TEST
             * IS LOAD-BEARING and was added 18 Sep 2026 to close a leak.
             *
             * This arm used to read m.supplier_id IS NULL, which was narrow
             * while the only way in was a text message from a stranger. Then
             * console uploads started arriving with supplier_id NULL too — so
             * every host's unfiled uploads appeared in every other host's
             * queue, and since attaching only checks that the ASSET is yours,
             * one host could have put another's photograph on their own boat.
             *
             * Restricted to what it always meant: a text nobody could place. */
            OR (m.supplier_id IS NULL AND m.provider <> 'upload')
          )
        ORDER BY m.created_at DESC
        LIMIT 60`
    ).bind(host.id, 'host:' + host.id);

    // Neither read is swallowed into an empty array. A fleet card that says
    // "nothing here yet" when the truth is "this query cannot run" is the exact
    // failure that cost us the requests endpoint for weeks.
    const fleet = await rows(fleetQ.all(), 'the fleet');
    const queue = await rows(queueQ.all(), 'the photo queue');

    return J({
      ok: true,
      assets: fleet.map((a) => ({ ...a, spec: a.spec ? safeJson(a.spec) : null })),
      queue,
      vocabulary: { kinds: KINDS, rate_units: RATE_UNITS, settle: SETTLE },
      // Said out loud, because both of these have bitten us as silent empties.
      rules: [
        'A photo texted in is held until you approve it. Nothing reaches a booker unseen.',
        'An asset goes live to bookers only once it has an approved photo and a home port we can place on a map.',
      ],
    });
  };

  // One try covers the GET and every POST action that repaints from list().
  const safely = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (isReadFailed(e)) return readFailedResponse(J, e);
      throw e;
    }
  };

  if (req.method === 'GET') return safely(list);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== 'active') return J({ ok: false, error: 'host_not_active' }, 403);

  let b;
  try { b = await readJSON(req, 65536); } catch { return J({ ok: false, error: 'bad_body' }, 400); }
  const action = String(b.action || 'save');

  if (action === 'retire') {
    const id = clean(b.id, 40);
    if (!id) return J({ ok: false, error: 'no_id' }, 400);
    // retired_at is NOT optional — there is a CHECK that refuses a retired row
    // without one, so setting status alone fails the whole statement.
    // NOT swallowed. A retire that silently does nothing leaves a boat on the
    // shelf that the host believes is gone — and the next booking request for it
    // is a conversation nobody can explain. If the write fails, say so.
    try {
      const r = await env.DB.prepare(
        `UPDATE num_assets SET status='retired', retired_at=?1, listable=0, updated_at=?2
          WHERE id=?3 AND host_id=?4`
      ).bind(now(), now(), id, host.id).run();
      if (r && r.meta && r.meta.changes === 0) {
        return J({ ok: false, error: 'not_found', says: 'Nothing of yours has that id.' }, 404);
      }
    } catch (e) {
      console.warn('[assets] retire failed', e?.message ?? e);
      return J({ ok: false, error: 'write_failed', detail: String(e?.message || '').slice(0, 200) }, 500);
    }
    return safely(list);
  }

  const kind = pick(b.kind, KINDS, null);
  const name = clean(b.name, 120);
  if (!kind) return J({ ok: false, error: 'bad_kind', allowed: KINDS }, 400);
  if (!name) return J({ ok: false, error: 'no_name' }, 400);

  const rate_unit = pick(b.rate_unit, RATE_UNITS, 'quote');
  let rate_minor = rateMinor(b.rate_minor ?? b.rate);

  // The CHECK says a priced unit must carry a price. Rather than hand back a
  // constraint error nobody can read, say what is missing in words.
  if (rate_unit !== 'quote' && rate_minor <= 0) {
    return J({
      ok: false,
      error: 'no_rate',
      says: `A ${rate_unit} rate needs a number. Leave the unit as "quote" if the price depends on the trip.`,
    }, 400);
  }

  const row = {
    owner_kind: 'supplier',
    owner_id: clean(b.owner_id, 40) || null,
    host_id: host.id,
    kind,
    name,
    make: clean(b.make, 80) || null,
    model: clean(b.model, 80) || null,
    year: num(b.year, 1900, 2100),
    registration: clean(b.registration, 40) || null,
    spec: b.spec && typeof b.spec === 'object' ? JSON.stringify(b.spec).slice(0, 4000) : null,
    home_port: clean(b.home_port, 120) || null,
    home_city: clean(b.home_city, 120) || null,
    home_country: clean(b.home_country, 80) || null,
    guests: num(b.guests, 0, 500),
    crew: num(b.crew, 0, 200),
    currency: (clean(b.currency, 3) || host.currency || 'GBP').toUpperCase().slice(0, 3),
    rate_minor,
    rate_unit,
    extras_note: clean(b.extras_note, 600) || null,
    settle_mode: pick(b.settle_mode, SETTLE, 'host_direct'),
    notes: clean(b.notes, 1000) || null,
    status: pick(b.status, ['active', 'paused'], 'active'),
  };

  // An asset with no supplier belongs to the host themselves. The column is NOT
  // NULL, so 'supplier' with the host's own id is how a host who owns the boat
  // is represented — and owner_kind stays 'supplier' so the member-verification
  // CHECK (which exists to stop an unvetted member listing a yacht) is not
  // accidentally bypassed by calling a host a member.
  if (!row.owner_id) row.owner_id = host.id;

  // THE OWNER ID IS CHECKED, not taken on trust.
  //
  // owner_id arrives in the request body, so without this a host could name any
  // supplier id at all — including one belonging to a competitor — and the
  // supplier's own fleet view would then show a boat they have never seen, with
  // that host's rate and notes on it. Worse, a photo that supplier texted in
  // could auto-file against it, because the sole-asset path in inboundmedia.mjs
  // trusts ownership rather than re-deriving it.
  //
  // The host's own id always passes. Anything else must be a supplier this host
  // has a live, accepted link to.
  if (row.owner_id !== host.id) {
    const linked = await env.DB.prepare(
      `SELECT 1 FROM num_supplier_links
        WHERE host_id = ?1 AND supplier_id = ?2 AND status = 'accepted' AND ended_at IS NULL
        LIMIT 1`
    ).bind(host.id, row.owner_id).first().catch(() => null);
    if (!linked) {
      return J({
        ok: false,
        error: 'not_your_supplier',
        says: 'That supplier is not on your list. Add them under Your suppliers first, then you can put something in their hands.',
      }, 403);
    }
  }

  const id = clean(b.id, 40);
  try {
    if (id) {
      await env.DB.prepare(
        `UPDATE num_assets SET
           owner_id=?1, kind=?2, name=?3, make=?4, model=?5, year=?6, registration=?7,
           spec=?8, home_port=?9, home_city=?10, home_country=?11, guests=?12, crew=?13,
           currency=?14, rate_minor=?15, rate_unit=?16, extras_note=?17, settle_mode=?18,
           notes=?19, status=?20, updated_at=?21
         WHERE id=?22 AND host_id=?23`
      ).bind(
        row.owner_id, row.kind, row.name, row.make, row.model, row.year, row.registration,
        row.spec, row.home_port, row.home_city, row.home_country, row.guests, row.crew,
        row.currency, row.rate_minor, row.rate_unit, row.extras_note, row.settle_mode,
        row.notes, row.status, now(), id, host.id
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO num_assets
           (id, owner_kind, owner_id, host_id, kind, name, make, model, year, registration,
            spec, home_port, home_city, home_country, guests, crew, currency, rate_minor,
            rate_unit, extras_note, settle_mode, notes, listable, status, created_at)
         VALUES (?1,'supplier',?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,
                 ?18,?19,?20,?21,0,?22,?23)`
      ).bind(
        nid('ast_'), row.owner_id, row.host_id, row.kind, row.name, row.make, row.model,
        row.year, row.registration, row.spec, row.home_port, row.home_city, row.home_country,
        row.guests, row.crew, row.currency, row.rate_minor, row.rate_unit, row.extras_note,
        row.settle_mode, row.notes, row.status, now()
      ).run();
    }
  } catch (e) {
    console.warn('[assets] write failed', e?.message ?? e);
    return J({ ok: false, error: 'write_failed', detail: String(e?.message || '').slice(0, 200) }, 500);
  }
  return safely(list);
}

/* ------------------------------------------------------------- the photos */

/**
 * POST /api/host/asset-photo
 *
 * Three actions, one endpoint, because they are three answers to the same
 * question a host is asking while looking at a photo: where does this go, is it
 * good enough to show, and which one leads.
 *
 *   attach   — a texted-in photo becomes an asset's photo (moderation 'new')
 *   moderate — ok or rejected. Only 'ok' is ever served to a booker.
 *   order    — which photo leads the listing
 */
export async function hostAssetPhoto(req, env, url, D) {
  const { J, clean, readJSON, badOrigin, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);

  let b;
  try { b = await readJSON(req, 16384); } catch { return J({ ok: false, error: 'bad_body' }, 400); }
  const action = String(b.action || '');

  // Ownership is checked on the ASSET for every action, every time. A host may
  // only touch photos of assets they host — passing somebody else's asset id
  // finds nothing and changes nothing.
  const ownsAsset = async (assetId) =>
    !!(await env.DB.prepare('SELECT id FROM num_assets WHERE id=?1 AND host_id=?2')
      .bind(assetId, host.id).first().catch(() => null));

  if (action === 'attach') {
    const mediaId = clean(b.media_id, 40);
    const assetId = clean(b.asset_id, 40);
    if (!mediaId || !assetId) return J({ ok: false, error: 'need_media_and_asset' }, 400);
    if (!(await ownsAsset(assetId))) return J({ ok: false, error: 'not_your_asset' }, 403);

    const { attachToAsset } = await import('../worker/inboundmedia.mjs');
    const r = await attachToAsset(env, {
      mediaId, assetId, by: `host:${host.id}`, caption: clean(b.caption, 200) || null,
    });
    if (!r.ok) return J({ ok: false, error: r.error }, 400);
    return J({ ok: true, photo_id: r.photoId, duplicate: !!r.duplicate });
  }

  if (action === 'discard') {
    const mediaId = clean(b.media_id, 40);
    if (!mediaId) return J({ ok: false, error: 'no_media' }, 400);
    await env.DB.prepare(
      `UPDATE num_inbound_media SET status='discarded', decided_at=?1, note=?2
        WHERE id=?3 AND status IN ('new','unknown_sender')`
    ).bind(now(), `discarded by host:${host.id}`, mediaId).run().catch(() => {});
    return J({ ok: true });
  }

  if (action === 'moderate') {
    const photoId = clean(b.photo_id, 40);
    const decision = pick(b.moderation, ['ok', 'rejected'], null);
    if (!photoId || !decision) return J({ ok: false, error: 'need_photo_and_decision' }, 400);

    const ph = await env.DB.prepare(
      `SELECT p.id FROM num_asset_photos p JOIN num_assets a ON a.id = p.asset_id
        WHERE p.id=?1 AND a.host_id=?2`
    ).bind(photoId, host.id).first().catch(() => null);
    if (!ph) return J({ ok: false, error: 'not_your_photo' }, 403);

    await env.DB.prepare(
      `UPDATE num_asset_photos SET moderation=?1, reject_note=?2, decided_at=?3, decided_by=?4
        WHERE id=?5`
    ).bind(decision, decision === 'rejected' ? (clean(b.note, 200) || 'not suitable') : null,
      now(), `host:${host.id}`, photoId).run();
    return J({ ok: true, moderation: decision });
  }

  if (action === 'order') {
    const photoId = clean(b.photo_id, 40);
    const pos = num(b.position, 1, 999);
    if (!photoId || pos === null) return J({ ok: false, error: 'need_photo_and_position' }, 400);
    const ph = await env.DB.prepare(
      `SELECT p.id FROM num_asset_photos p JOIN num_assets a ON a.id = p.asset_id
        WHERE p.id=?1 AND a.host_id=?2`
    ).bind(photoId, host.id).first().catch(() => null);
    if (!ph) return J({ ok: false, error: 'not_your_photo' }, 403);
    await env.DB.prepare('UPDATE num_asset_photos SET position=?1 WHERE id=?2')
      .bind(pos, photoId).run();
    return J({ ok: true });
  }

  if (action === 'list') {
    const assetId = clean(b.asset_id, 40);
    if (!assetId) return J({ ok: false, error: 'no_asset' }, 400);
    if (!(await ownsAsset(assetId))) return J({ ok: false, error: 'not_your_asset' }, 403);
    // Not swallowed: "this asset has no photos" and "we cannot read its photos"
    // lead a host to do completely different things.
    try {
      const photos = await rows(env.DB.prepare(
        `SELECT id, content_type, bytes, source, caption, moderation, reject_note, position, created_at
           FROM num_asset_photos WHERE asset_id=?1 ORDER BY position ASC, created_at ASC LIMIT 100`
      ).bind(assetId).all(), "this asset's photos");
      return J({ ok: true, photos });
    } catch (e) {
      if (isReadFailed(e)) return readFailedResponse(J, e);
      throw e;
    }
  }

  // Making an asset live is a photo decision as much as a listing decision, so
  // it lives here: you cannot sensibly publish something with nothing to show.
  if (action === 'listable') {
    const assetId = clean(b.asset_id, 40);
    const on = b.listable ? 1 : 0;
    if (!assetId) return J({ ok: false, error: 'no_asset' }, 400);
    if (!(await ownsAsset(assetId))) return J({ ok: false, error: 'not_your_asset' }, 403);

    if (on) {
      /* A DRAFT CANNOT GO LIVE. This is the gate that makes "a model never
       * gets the last word" true rather than merely intended.
       *
       * It was missing for a few hours on 18 Sep 2026 and the hole was exact:
       * fleet intake writes a draft whose name, make, model and listing line
       * were written by a model, and attaches the host's own uploads already
       * approved (they chose the files, so the moderation queue would have
       * been theatre). The photo check below was therefore satisfied the
       * instant the upload finished — so "Go live" would have put a machine's
       * guess about somebody's boat in front of a booker with no human having
       * read a word of it.
       *
       * Two gates, two questions, and both are needed. `draft` asks whether a
       * person has checked what we wrote down. `listable` asks whether a
       * member may be shown it. Confirming is free and takes one click, which
       * is the point — it is the click where someone reads the name. */
      const d = await env.DB.prepare('SELECT draft FROM num_assets WHERE id=?1')
        .bind(assetId).first().catch(() => null);
      if (d && d.draft) {
        return J({
          ok: false,
          error: 'still_a_draft',
          says: 'Read this one back first and say it is right. We wrote it off your photographs, and nobody has checked it yet.',
        }, 409);
      }

      const ok = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM num_asset_photos WHERE asset_id=?1 AND moderation='ok'"
      ).bind(assetId).first().catch(() => ({ n: 0 }));
      if (!ok || !ok.n) {
        return J({
          ok: false,
          error: 'no_approved_photo',
          says: 'This needs at least one approved photo before a booker can see it. Nobody charters a boat they cannot look at.',
        }, 400);
      }
    }
    await env.DB.prepare('UPDATE num_assets SET listable=?1, updated_at=?2 WHERE id=?3 AND host_id=?4')
      .bind(on, now(), assetId, host.id).run();
    return J({ ok: true, listable: on });
  }

  return J({ ok: false, error: 'unknown_action' }, 400);
}

/* -------------------------------------------------------------- serving */

/**
 * GET /api/host/asset-image?k=KEY&id=PHOTO_ID
 * GET /p/asset/PHOTO_ID                        (public, approved only)
 *
 * R2 objects are never public. Serving them through a handler is what lets the
 * moderation state actually mean something: a rejected photo returns 404 no
 * matter who has the URL, and a pending one is visible to the host who must
 * decide on it and to nobody else.
 *
 * Content-Type is set from the stored value, which was checked against an
 * allowlist at ingest. X-Content-Type-Options stops a browser second-guessing
 * it — belt and braces on the same hole.
 */
export async function assetImage(req, env, url, D, { publicOnly = false } = {}) {
  const { J, clean, hostAuth } = D;

  // WHERE THE ID COMES FROM, said explicitly per route.
  //
  // The first version read `searchParams.get('id') || url.pathname.split('/').pop()`
  // for both routes, and that was wrong twice over. On /api/host/asset-image with
  // no id, the pathname fallback yields the string "asset-image" — so we ran a
  // database lookup for a photograph by that name and answered 404. Nothing broke,
  // but the route became indistinguishable from a route that does not exist, and
  // that is not academic: scripts/console-api-agree.mjs reported this very
  // endpoint as MISSING on a deploy where it was live and working.
  //
  // /p/asset/<id> carries the id in the path. /api/host/asset-image carries it in
  // the query. Each route reads its own place and neither borrows the other's.
  const fromPath = url.pathname.startsWith('/p/asset/');
  const id = clean(fromPath ? url.pathname.split('/').pop() : url.searchParams.get('id'), 40);

  // 400, NOT 404. "You did not say which photograph" and "there is no such
  // photograph" are different answers and must not share a status code — a
  // caller cannot act on the first if it looks like the second, and neither can
  // a deploy check.
  if (!id) {
    return new Response('which photo? pass ?id=', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const row = await env.DB.prepare(
    `SELECT p.r2_key, p.content_type, p.moderation, a.host_id
       FROM num_asset_photos p JOIN num_assets a ON a.id = p.asset_id
      WHERE p.id = ?1`
  ).bind(id).first().catch(() => null);
  if (!row) return new Response('no', { status: 404 });

  if (row.moderation !== 'ok') {
    if (publicOnly) return new Response('no', { status: 404 });
    const host = await hostAuth(env, url);
    if (!host || host.id !== row.host_id) return new Response('no', { status: 404 });
  }

  if (!env.PHOTOS) {
    console.warn('[assets] PHOTOS bucket not bound — cannot serve images');
    return new Response('storage unavailable', { status: 503 });
  }
  const obj = await env.PHOTOS.get(row.r2_key).catch(() => null);
  if (!obj) {
    // A row pointing at a missing object. Logged because it means ingest wrote
    // a row after an R2 failure, which ingestMedia is built not to do.
    console.warn(`[assets] MISSING OBJECT for photo ${id} key=${row.r2_key}`);
    return new Response('no', { status: 404 });
  }

  return new Response(obj.body, {
    headers: {
      'content-type': row.content_type || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': row.moderation === 'ok'
        ? 'public, max-age=86400'
        : 'private, no-store',
    },
  });
}

/* ---------------------------------------------------------- the calendar */

/**
 * GET  /api/host/asset-holds   — what is booked, blocked or pencilled in
 * POST /api/host/asset-holds   — hold, release
 *
 * A double booking is the worst thing this system can do. A guest standing on a
 * quay watching somebody else board their boat is not a bug report, it is the
 * end of a relationship. So the overlap check runs on the WRITE, against the
 * same `overlaps` function assetintegrity.mjs uses to audit after the fact —
 * one definition of "clash", used to prevent and to detect.
 */
export async function hostAssetHolds(req, env, url, D) {
  const { J, clean, readJSON, badOrigin, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);

  const list = async () => {
    const holdsQ = env.DB.prepare(
      `SELECT h.*, a.name AS asset_name, a.kind AS asset_kind
         FROM num_asset_holds h JOIN num_assets a ON a.id = h.asset_id
        WHERE a.host_id = ?1 AND h.released_at IS NULL
          AND h.ends_at >= datetime('now','-1 day')
        ORDER BY h.starts_at ASC LIMIT 400`
    ).bind(host.id);
    return J({ ok: true, holds: await rows(holdsQ.all(), 'the calendar'), kinds: HOLD_KINDS });
  };

  const safelyHolds = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (isReadFailed(e)) return readFailedResponse(J, e);
      throw e;
    }
  };

  if (req.method === 'GET') return safelyHolds(list);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);

  let b;
  try { b = await readJSON(req, 16384); } catch { return J({ ok: false, error: 'bad_body' }, 400); }

  if (String(b.action || '') === 'release') {
    const id = clean(b.id, 40);
    if (!id) return J({ ok: false, error: 'no_id' }, 400);
    await env.DB.prepare(
      `UPDATE num_asset_holds SET released_at=?1, release_reason=?2
         WHERE id=?3 AND asset_id IN (SELECT id FROM num_assets WHERE host_id=?4)`
    ).bind(now(), clean(b.reason, 200) || 'released by host', id, host.id).run().catch(() => {});
    return safelyHolds(list);
  }

  const assetId = clean(b.asset_id, 40);
  const kind = pick(b.kind, HOLD_KINDS, null);
  const starts = sqlTime(b.starts_at);
  const ends = sqlTime(b.ends_at);
  if (!assetId || !kind) return J({ ok: false, error: 'need_asset_and_kind' }, 400);
  if (!starts || !ends) return J({ ok: false, error: 'bad_dates' }, 400);
  if (!(ends > starts)) {
    return J({ ok: false, error: 'ends_before_starts', says: 'The end has to come after the start.' }, 400);
  }

  const mine = await env.DB.prepare('SELECT id,name FROM num_assets WHERE id=?1 AND host_id=?2')
    .bind(assetId, host.id).first().catch(() => null);
  if (!mine) return J({ ok: false, error: 'not_your_asset' }, 403);

  // The clash check. Only 'booked' and 'provisional' occupy the boat —
  // 'blocked' and 'maintenance' are the owner's own business and may overlap
  // with each other, which is why OCCUPYING is a set and not a boolean.
  const { OCCUPYING, overlaps } = await import('../worker/assetintegrity.mjs');
  if (OCCUPYING.has(kind)) {
    // THIS READ FAILS CLOSED, and it is the most important line in the file.
    //
    // With `.catch(() => ({ results: [] }))` a failed query produced an empty
    // list, the overlap loop below found nothing to clash with, and THE DOUBLE
    // BOOKING WENT THROUGH. A guest standing on a quay watching somebody else
    // board their boat is the worst thing this system can do, and it was one
    // dropped query away.
    //
    // If we cannot read the calendar we do not know whether the hull is free, and
    // "I do not know" must never be answered as "yes".
    let existing;
    try {
      existing = await rows(env.DB.prepare(
        `SELECT id, kind, starts_at, ends_at FROM num_asset_holds
          WHERE asset_id=?1 AND released_at IS NULL`
      ).bind(assetId).all(), 'the existing holds on this asset');
    } catch (e) {
      if (isReadFailed(e)) {
        return J({
          ok: false,
          error: 'cannot_check_clash',
          says: 'We cannot read this boat\'s calendar just now, so we will not take a booking we cannot check for a clash. Try again in a moment.',
          detail: String(e?.cause?.message ?? '').slice(0, 200),
        }, 503);
      }
      throw e;
    }
    for (const h of existing) {
      if (!OCCUPYING.has(h.kind)) continue;
      if (overlaps(starts, ends, h.starts_at, h.ends_at)) {
        return J({
          ok: false,
          error: 'clash',
          says: `${mine.name} is already ${h.kind} from ${h.starts_at} to ${h.ends_at}. Two bookings on one hull is the one mistake we do not make.`,
          clashes_with: h.id,
        }, 409);
      }
    }
  }

  // A provisional hold with no expiry never expires, which is how a boat ends
  // up unavailable forever because of an enquiry nobody followed up. The CHECK
  // refuses it; this picks a sane default rather than erroring.
  const expires = kind === 'provisional'
    ? (sqlTime(b.expires_at) || new Date(Date.now() + 48 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19))
    : sqlTime(b.expires_at);

  try {
    await env.DB.prepare(
      `INSERT INTO num_asset_holds
         (id, asset_id, job_id, kind, starts_at, ends_at, expires_at, note, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
    ).bind(
      nid('hld_'), assetId, clean(b.job_id, 40) || null, kind,
      starts, ends, expires, clean(b.note, 300) || null, now()
    ).run();
  } catch (e) {
    console.warn('[assets] hold write failed', e?.message ?? e);
    return J({ ok: false, error: 'write_failed', detail: String(e?.message || '').slice(0, 200) }, 500);
  }
  return safelyHolds(list);
}

/**
 * Dates from a form, in one shape.
 *
 * Accepts "2026-09-20", "2026-09-20T14:00", "2026-09-20 14:00:00" and returns
 * "YYYY-MM-DD HH:MM:SS" — the shape every other timestamp in this database
 * uses, and the shape SQLite compares correctly as a string. Mixing "T" and " "
 * in one column makes `starts_at < ends_at` quietly wrong, because "T" sorts
 * after " ".
 */
export function sqlTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + ' 00:00:00';
  const m = s.replace('T', ' ').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?/);
  if (!m) return null;
  return `${m[1]} ${m[2]}${m[3] || ':00'}`;
}

/* ----------------------------------------------------------- the booker */

/**
 * GET /api/host/offerable?near=CITY — what a member could actually charter.
 *
 * Listable, active, with an approved photo. The three conditions are in the
 * query together on purpose: each one alone produces a list that looks right
 * and contains something we should not be selling.
 */
export async function offerableAssets(req, env, url, D) {
  const { J, clean } = D;
  const city = clean(url.searchParams.get('near'), 80);
  const kind = pick(url.searchParams.get('kind'), KINDS, null);

  const where = [
    'a.listable = 1', "a.status = 'active'",
    "EXISTS (SELECT 1 FROM num_asset_photos p WHERE p.asset_id = a.id AND p.moderation = 'ok')",
  ];
  const binds = [];
  if (city) { where.push('(a.home_city LIKE ?' + (binds.length + 1) + ' OR a.home_port LIKE ?' + (binds.length + 1) + ')'); binds.push(`%${city}%`); }
  if (kind) { where.push('a.kind = ?' + (binds.length + 1)); binds.push(kind); }

  // A member browsing charters must not be told "nothing near you" when the truth
  // is that the query failed. That sentence ends the search; an honest error lets
  // them try again, and lets us see it in the logs.
  const out = [];
  try {
    const found = await rows(env.DB.prepare(
      `SELECT a.* FROM num_assets a WHERE ${where.join(' AND ')}
        ORDER BY a.kind ASC, a.rate_minor ASC LIMIT 60`
    ).bind(...binds).all(), 'what is offerable near there');

    for (const a of found) {
      const ph = await rows(env.DB.prepare(
        `SELECT id, caption FROM num_asset_photos
          WHERE asset_id=?1 AND moderation='ok' ORDER BY position ASC LIMIT 6`
      ).bind(a.id).all(), "an asset's approved photos");
      out.push(clientView({
        ...a,
        photos: ph.map((p) => ({ url: `/p/asset/${p.id}`, caption: p.caption })),
      }));
    }
  } catch (e) {
    if (isReadFailed(e)) return readFailedResponse(J, e);
    throw e;
  }
  return J({
    ok: true,
    assets: out,
    note: out.length ? null : 'Nothing listed near there yet. Ask your host what they can reach.',
  });
}
