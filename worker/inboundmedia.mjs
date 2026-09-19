// Photos texted in.
//
// A supplier who keeps three boats does not open a console to upload pictures.
// They take a photo on the dock and text it to the number already printed on
// everything we give them. This module is what turns that text into something
// a booker can see.
//
// It hangs off the EXISTING inbound SMS webhook — the one Twilio is already
// configured for and whose signature is already verified in sms.mjs. A second
// webhook would have meant a second URL to configure, a second signature
// implementation, and a second open mailbox to defend. There is one.
//
// WHAT THIS DELIBERATELY DOES NOT STORE: the sending phone number. A supplier's
// mobile is their personal number, and a photo queue is not a place that needs
// it. We keep an HMAC of it (so repeat texts from the same person group
// together) and the last four digits (so a human looking at the queue can say
// "that's Marco"). Resolving WHO they are happens once, at the moment the text
// arrives, against numbers we already hold — and then we keep the supplier id,
// not the number.

// Twilio's own ceiling is 10 media per message. Matching it means a malformed
// NumMedia can never make us issue 400 fetches.
export const MAX_MEDIA = 10;

// 12MB. A modern phone photo is 2-5MB; a short video is the thing that blows
// past this. Above the cap we keep the row and skip the bytes, so the supplier
// gets told rather than silently ignored.
export const MAX_BYTES = 12 * 1024 * 1024;

// An allowlist, not a blocklist, and checked against what we FETCHED rather
// than what the webhook claimed.
//
// This is a security boundary, not tidiness. These files get served back from
// our own domain. An attacker who can get text/html into this bucket and then
// served from itsnum.com owns every session cookie scoped to it. Twilio's
// ContentType param is attacker-influenced data — the sender chooses the file.
export const ALLOWED = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/heic', 'image/heif', 'image/gif',
  'video/mp4', 'video/quicktime',
]);

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
};

export const nid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Last four digits, for a human reading the queue. Never more than four. */
export function last4(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}

/**
 * HMAC of the sending number, so two texts from one person group together
 * without us keeping the number.
 *
 * Keyed with MEDIA_SALT when it is set, and with the Twilio auth token when it
 * is not. The fallback is deliberate: a missing secret must not mean storing
 * the raw number, and it must not mean dropping the photo. It does mean the
 * hashes change if the token is rotated — which only costs us the grouping of
 * already-queued unknown senders, never a stored photo.
 */
export async function senderHash(env, phone) {
  const secret = env.MEDIA_SALT || env.TWILIO_TOKEN || 'num-unsalted';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(phone)));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Where the bytes live. Supplier-scoped so a listing is a prefix scan. */
export function mediaKey(supplierId, id, contentType) {
  const ext = EXT[contentType] || 'bin';
  return `inbound/${supplierId || 'unknown'}/${id}.${ext}`;
}

/**
 * Which supplier texted this? Phone to member to supplier, using numbers we
 * already hold. Returns null rather than throwing — an unresolved sender is a
 * queue item for a human, not an error.
 */
export async function resolveSupplier(env, phone) {
  // Selects s.phone (0022) and deliberately NOT accepts_mms (0021).
  //
  // The column is not used here, and naming it would make this query fail on
  // any database where that ALTER had not run. The failure would not look like
  // a failure: the catch below turns it into null, null means "we do not know
  // this sender", and every supplier in the world quietly becomes an unknown
  // number whose photos pile up in a queue nobody can file. That is the same
  // silent-empty shape that hid the broken requests endpoint for weeks. Do not
  // add a column to this SELECT for the sake of completeness.
  // TWO WAYS TO BE RECOGNISED, and the first one is the one that matters.
  //
  // num_suppliers.phone (0022) is checked first, because a supplier is usually
  // NOT a NUM member. A marina manager who preps three boats has no reason to
  // sign up, and for as long as resolution depended only on membership every
  // photo he sent queued as "unknown sender" forever — the feature not working.
  //
  // The member join is the fallback, for a supplier who IS a member and whose
  // record predates 0022 or was created without a number.
  //
  // Ordered so a direct phone match beats a member match: the direct row is the
  // one the host typed in, for the person they actually work with.
  const row = await env.DB.prepare(
    `SELECT s.id AS supplier_id, s.display_name, s.member_id,
            CASE WHEN s.phone IS NOT NULL AND s.phone = ?1 THEN 0 ELSE 1 END AS rank
       FROM num_suppliers s
       LEFT JOIN num_members m ON m.id = s.member_id
      WHERE s.status <> 'closed'
        AND (s.phone = ?1 OR m.phone = ?1 OR m.phone = ?2)
      ORDER BY rank ASC, s.created_at DESC
      LIMIT 1`,
  ).bind(phone, String(phone).replace(/^\+1/, '')).first().catch((e) => {
    // Loud, because the only way this throws is a schema problem, and a schema
    // problem that presents as "we do not recognise you" is unfindable.
    console.warn('[media] supplier lookup FAILED (schema?):', e?.message ?? e);
    return null;
  });
  return row || null;
}

/**
 * The reply. This is the whole user experience of the feature, so it is worth
 * being exact about.
 *
 * A supplier who texts a photo and hears nothing assumes it did not work and
 * texts it again. So we always answer, and the answer always says what to do
 * next in one line they can act on without leaving Messages.
 *
 * Never lists another supplier's assets — `assets` is already scoped to the
 * sender by the caller, and an empty list gets the sign-up line instead of a
 * bare "which one?".
 */
export function askWhichAsset({ stored, skipped, assets, supplier }, { member = null } = {}) {
  if (!stored && skipped) {
    return `We could not keep that one — ${skipped === 1 ? 'it was' : 'they were'} too large or not a photo or video. Try a single photo under 12MB.`;
  }
  if (!stored) return null;
  const n = stored === 1 ? 'Photo' : `${stored} photos`;
  if (!supplier) {
    // A KNOWN MEMBER who is not a supplier gets no fleet reply at all.
    //
    // They are a guest photographing a menu and asking the concierge what it
    // says. Answering "we do not recognise this number" to somebody whose
    // number we plainly do recognise is both wrong and unsettling, and it would
    // land in place of the answer they actually asked for. Returning null hands
    // the message back to the concierge, which is whose message it is.
    if (member) return null;
    return `${n} received, thank you. We do not recognise this number yet — ask your NUM host to add you as a supplier and we will file it against your listing.`;
  }
  if (!assets.length) {
    return `${n} received. You have nothing listed yet, so we are holding ${stored === 1 ? 'it' : 'them'} for you. Add the yacht, boat or car in your NUM console and ${stored === 1 ? 'it' : 'they'} will be waiting.`;
  }
  if (assets.length === 1) {
    return `${n} received and filed against ${assets[0].name}. It will show to bookers once approved.`;
  }
  const list = assets.slice(0, 6).map((a, i) => `${i + 1}. ${a.name}`).join('  ');
  return `${n} received. Reply with a number to say which one: ${list}`;
}

/**
 * Fetch one media item and put it in R2.
 *
 * Twilio media URLs are fetched WITH basic auth always. MMS media is publicly
 * readable by default on most accounts, but an account can be switched to
 * require auth — and if that ever happens, an unauthenticated fetch returns
 * 401 and every photo silently stops arriving. Sending credentials works in
 * both configurations, so there is no day where this quietly breaks.
 */
export async function fetchOne(env, mediaUrl, claimedType) {
  const headers = {};
  if (env.TWILIO_SID && env.TWILIO_TOKEN) {
    headers.Authorization = 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`);
  }
  const res = await fetch(mediaUrl, { headers, redirect: 'follow' });
  if (!res.ok) return { ok: false, why: `fetch ${res.status}` };

  // The SERVED type wins over the claimed one. See ALLOWED above.
  const served = (res.headers.get('content-type') || claimedType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED.has(served)) return { ok: false, why: `type ${served || 'unknown'}` };

  const buf = await res.arrayBuffer();
  if (!buf.byteLength) return { ok: false, why: 'empty' };
  if (buf.byteLength > MAX_BYTES) return { ok: false, why: `bytes ${buf.byteLength}` };
  return { ok: true, buf, contentType: served, bytes: buf.byteLength };
}

/**
 * The whole ingest, for one inbound message.
 *
 * Returns { stored, skipped, assets, supplier, rows } so the caller can decide
 * what to say. Swallows nothing silently: every skip is counted and every
 * failure is logged with the reason, because "the photo never showed up" is
 * unanswerable without it.
 *
 * Ordering matters. The bytes go to R2 BEFORE the row goes to D1, so a row can
 * never point at an object that does not exist. The reverse would leave the
 * moderation queue full of broken images with no way to tell which are real.
 */
export async function ingestMedia(env, { params, from, bucket, provider = 'twilio' }) {
  const count = Math.min(Number(params.get('NumMedia') || 0) || 0, MAX_MEDIA);
  if (count <= 0) return { stored: 0, skipped: 0, assets: [], supplier: null, rows: [] };

  const supplier = await resolveSupplier(env, from);
  const hash = await senderHash(env, from);
  const l4 = last4(from);
  const body = (params.get('Body') || '').slice(0, 500) || null;
  const sid = params.get('MessageSid') || params.get('SmsSid') || null;

  let stored = 0; let skipped = 0;
  const rows = [];

  for (let i = 0; i < count; i++) {
    const url = params.get(`MediaUrl${i}`);
    if (!url) { skipped++; continue; }
    let got;
    try {
      got = await fetchOne(env, url, params.get(`MediaContentType${i}`));
    } catch (e) {
      console.warn(`[media] fetch threw for item ${i}:`, e?.message ?? e);
      skipped++; continue;
    }
    if (!got.ok) {
      console.warn(`[media] skipped item ${i}: ${got.why}`);
      skipped++; continue;
    }

    const id = nid('med_');
    const digest = await sha256Hex(got.buf);
    const key = mediaKey(supplier?.supplier_id, id, got.contentType);

    // A re-send of the same photo is the commonest thing that happens when a
    // supplier is unsure it worked. Counting it as stored (so they get a
    // reassuring reply) without making a second row or a second object.
    const dupe = await env.DB.prepare(
      'SELECT id FROM num_inbound_media WHERE from_hash = ?1 AND sha256 = ?2 LIMIT 1',
    ).bind(hash, digest).first().catch(() => null);
    if (dupe) { stored++; rows.push({ id: dupe.id, duplicate: true }); continue; }

    if (!bucket) {
      console.warn('[media] NO BUCKET BOUND — photo discarded. Bind PHOTOS in wrangler.');
      skipped++; continue;
    }

    try {
      await bucket.put(key, got.buf, { httpMetadata: { contentType: got.contentType } });
    } catch (e) {
      console.warn('[media] R2 put failed:', e?.message ?? e);
      skipped++; continue;
    }

    try {
      await env.DB.prepare(
        `INSERT INTO num_inbound_media
           (id, from_hash, from_last4, supplier_id, r2_key, content_type, bytes,
            sha256, provider, provider_sid, body, status, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
      ).bind(
        id, hash, l4, supplier?.supplier_id ?? null, key, got.contentType,
        got.bytes, digest, provider, sid, body,
        supplier ? 'new' : 'unknown_sender', now(),
      ).run();
      stored++;
      rows.push({ id, key, bytes: got.bytes, contentType: got.contentType });
    } catch (e) {
      // The object is already in R2 and the row is not. Logged loudly rather
      // than deleting the object: an orphaned object costs fractions of a cent
      // and can be reconciled; a deleted photo is gone.
      console.warn(`[media] row write failed for ${key} (object kept):`, e?.message ?? e);
      skipped++;
    }
  }

  // What the sender can choose from. Scoped to THEIR supplier record — the
  // reply must never name another supplier's boat.
  let assets = [];
  if (supplier && stored) {
    assets = (await env.DB.prepare(
      `SELECT id, name FROM num_assets
        WHERE owner_kind = 'supplier' AND owner_id = ?1 AND status = 'active'
        ORDER BY created_at DESC LIMIT 6`,
    ).bind(supplier.supplier_id).all().catch(() => ({ results: [] }))).results || [];
  }

  // One asset and one supplier is the unambiguous case, so file it there and
  // then rather than asking a question with one possible answer.
  if (supplier && assets.length === 1 && rows.length) {
    for (const r of rows) {
      if (r.duplicate) continue;
      await attachToAsset(env, { mediaId: r.id, assetId: assets[0].id, by: 'auto:sole-asset' })
        .catch((e) => console.warn('[media] auto-attach failed', e?.message ?? e));
    }
  }

  return { stored, skipped, assets, supplier, rows };
}

/**
 * Promote a queued inbound photo into an asset's gallery.
 *
 * Copies the R2 key rather than moving the object: the inbound row stays as the
 * audit trail of what arrived and when, and the photo row is what gets served.
 * `moderation` starts at 'new' — nothing texted in reaches a booker before a
 * human has looked at it. That is the point of the column.
 */
/* `source` and `moderation` default to the texted-in case this function was
 * written for, so every existing caller behaves exactly as before.
 *
 * A HOST'S OWN UPLOAD IS DIFFERENT, and the difference is not a shortcut. The
 * moderation queue exists because a supplier texts in a photograph nobody at
 * NUM or at the host has looked at yet — "nothing reaches a booker unseen". A
 * host dragging files off their own camera roll HAS seen them; they chose them
 * one by one, three seconds ago. Holding those in a queue for the same host to
 * approve teaches people to click approve without looking, which is how the
 * queue stops working for the photographs that actually need it.
 *
 * The CHECK in 0021 says an approved photo must carry who decided and when, so
 * an approving caller supplies both or the insert is refused — which is the
 * constraint doing its job. */
export async function attachToAsset(env, {
  mediaId, assetId, by, caption, source = 'mms', moderation = 'new',
}) {
  const src = ['mms', 'upload', 'console', 'whatsapp'].includes(source) ? source : 'mms';
  const mod = ['new', 'ok'].includes(moderation) ? moderation : 'new';
  const med = await env.DB.prepare(
    'SELECT * FROM num_inbound_media WHERE id = ?1',
  ).bind(mediaId).first();
  if (!med) return { ok: false, error: 'no such media' };
  if (med.status === 'attached') return { ok: false, error: 'already attached' };

  const asset = await env.DB.prepare('SELECT id FROM num_assets WHERE id = ?1').bind(assetId).first();
  if (!asset) return { ok: false, error: 'no such asset' };

  const photoId = nid('aph_');
  const pos = (await env.DB.prepare(
    'SELECT COALESCE(MAX(position), 0) + 1 AS n FROM num_asset_photos WHERE asset_id = ?1',
  ).bind(assetId).first().catch(() => null))?.n ?? 1;

  try {
    await env.DB.prepare(
      `INSERT INTO num_asset_photos
         (id, asset_id, r2_key, content_type, bytes, source, caption, sha256,
          moderation, position, created_at, decided_at, decided_by)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
    ).bind(
      photoId, assetId, med.r2_key, med.content_type, med.bytes,
      src, caption ?? null, med.sha256, mod, pos, now(),
      mod === 'new' ? null : now(),
      mod === 'new' ? null : (by || 'host'),
    ).run();
  } catch (e) {
    // The dedupe index on (asset_id, sha256) is the expected failure here: the
    // same photo filed against the same asset twice. Not an error worth
    // showing anybody — the photo is already there, which is what they wanted.
    if (String(e?.message || '').includes('UNIQUE')) {
      await env.DB.prepare(
        "UPDATE num_inbound_media SET status='attached', asset_id=?1, decided_at=?2 WHERE id=?3",
      ).bind(assetId, now(), mediaId).run().catch(() => {});
      return { ok: true, photoId: null, duplicate: true };
    }
    return { ok: false, error: e?.message || 'photo write failed' };
  }

  await env.DB.prepare(
    "UPDATE num_inbound_media SET status='attached', asset_id=?1, decided_at=?2, note=COALESCE(note,?3) WHERE id=?4",
  ).bind(assetId, now(), by ? `attached by ${by}` : null, mediaId).run().catch(() => {});

  return { ok: true, photoId, position: pos };
}
