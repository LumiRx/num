// Suppliers. The people who actually prep and deliver the thing.
//
// A host who charters boats does not wash them. Someone fuels the tender, meets
// the guests on the pontoon, drives the car to the hotel. That person may be a
// NUM member and very often is not — a marina manager in Phuket has no reason
// to sign up for a concierge app — and the whole point of this layer is that
// they need no app at all. A phone number is the entire onboarding.
//
// 0019 shipped eight tables for this and zero endpoints, so until now a host
// could only own every asset themselves. This is the missing half.
//
// THE MONEY RULE, decided by Dre: the host pays the supplier DIRECTLY. NUM
// tracks it and never stands between them. Nothing here moves money.

import { e164 } from '../worker/bizowner.mjs';
import { numSmsNumber } from '../worker/twiliosender.mjs';
import { rows, readFailedResponse, isReadFailed } from './readfail.mjs';

export const SUPPLIER_KINDS = ['marina', 'driver', 'crew', 'concierge', 'caterer', 'agency', 'other'];

const nid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const pick = (v, allowed, fallback) => (allowed.includes(String(v ?? '')) ? String(v) : fallback);

/**
 * GET  /api/host/suppliers — who you work with, and what each of them holds
 * POST /api/host/suppliers — add, label, end
 */
export async function hostSuppliers(req, env, url, D) {
  const { J, clean, readJSON, badOrigin, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);

  const list = async () => {
    const q = env.DB.prepare(
      `SELECT s.id, s.display_name, s.business_name, s.kind, s.about, s.phone, s.email,
              s.status, s.notified_at, s.created_at,
              l.id AS link_id, l.status AS link_status, l.host_label, l.decided_at, l.ended_at,
              (SELECT COUNT(*) FROM num_assets a
                WHERE a.owner_kind = 'supplier' AND a.owner_id = s.id AND a.status <> 'retired') AS assets,
              (SELECT COUNT(*) FROM num_inbound_media m
                WHERE m.supplier_id = s.id AND m.status = 'new') AS photos_waiting
         FROM num_supplier_links l
         JOIN num_suppliers s ON s.id = l.supplier_id
        WHERE l.host_id = ?1 AND l.ended_at IS NULL
        ORDER BY s.display_name ASC
        LIMIT 200`
    ).bind(host.id);

    // NOT swallowed into an empty array. This exact read shipped ahead of 0022
    // and answered "no such column: phone" — which, caught and turned into [],
    // became a live card reporting success that could never show a supplier.
    const list_ = await rows(q.all(), 'the supplier list');

    return J({
      ok: true,
      suppliers: list_,
      vocabulary: { kinds: SUPPLIER_KINDS },
      rules: [
        'You pay your supplier directly. NUM records the job and the receipt and never sits between you.',
        'A supplier needs no app. Once their number is here they can text photos of the boat or the car straight in.',
        'Adding someone tells them, by email where you give one. They can reply STOP to any message to come off it.',
      ],
    });
  };

  // Every exit that calls list() goes through here, so one try covers the GET and
  // every POST action that repaints.
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
  try { b = await readJSON(req, 32768); } catch { return J({ ok: false, error: 'bad_body' }, 400); }
  const action = String(b.action || 'add');

  /* ── end the relationship ───────────────────────────────────────────── */
  if (action === 'end') {
    const id = clean(b.id, 40);
    if (!id) return J({ ok: false, error: 'no_id' }, 400);
    // ended_at AND ended_by are both required by a CHECK — a relationship that
    // ended with nobody accountable is one nobody can explain later.
    //
    // ended_by is a ROLE and not an identifier: the column is constrained to
    // ('host','supplier','num'), because what matters six months later is which
    // SIDE walked away, not which row id did it. Writing `host:h1` here failed
    // the CHECK outright — caught by a test, and it would have failed in
    // production identically. Which host it was is already the host_id on the
    // same row; the note carries anything a human typed.
    try {
      const r = await env.DB.prepare(
        `UPDATE num_supplier_links
            SET status='ended', ended_at=?1, ended_by='host', ended_note=?2
          WHERE id=?3 AND host_id=?4 AND ended_at IS NULL`
      ).bind(now(), clean(b.note, 300) || null, id, host.id).run();
      if (r?.meta?.changes === 0) {
        return J({ ok: false, error: 'not_found', says: 'Nothing of yours has that id, or it has already ended.' }, 404);
      }
    } catch (e) {
      console.warn('[suppliers] end failed', e?.message ?? e);
      return J({ ok: false, error: 'write_failed', detail: String(e?.message || '').slice(0, 200) }, 500);
    }
    return safely(list);
  }

  /* ── the host's private name for them ───────────────────────────────── */
  if (action === 'label') {
    const id = clean(b.id, 40);
    if (!id) return J({ ok: false, error: 'no_id' }, 400);
    await env.DB.prepare(
      'UPDATE num_supplier_links SET host_label=?1 WHERE id=?2 AND host_id=?3'
    ).bind(clean(b.host_label, 80) || null, id, host.id).run().catch((e) => {
      console.warn('[suppliers] label failed', e?.message ?? e);
    });
    return safely(list);
  }

  /* ── add somebody ───────────────────────────────────────────────────── */
  const name = clean(b.display_name || b.name, 120);
  if (!name) return J({ ok: false, error: 'no_name', says: 'Give them a name you will recognise in a list.' }, 400);

  const rawPhone = clean(b.phone, 32);
  const phone = rawPhone ? e164(rawPhone) : null;

  // A number that will not normalise is refused rather than stored loosely.
  //
  // `e164` insists on a country code on purpose: "0812345678" is a different
  // person in Thailand than in the UK, and guessing makes a photo from one of
  // them resolve to the other. Refusing with a sentence costs the host four
  // keystrokes; guessing costs somebody else's boat.
  if (rawPhone && !phone) {
    return J({
      ok: false,
      error: 'bad_phone',
      says: 'That number needs its country code, starting with a plus — +66 for Thailand, +44 for the UK, +1 for the US. Without it we cannot tell which country it belongs to.',
    }, 400);
  }

  const email = clean(b.email, 160);
  if (!phone && !email) {
    return J({
      ok: false,
      error: 'no_contact',
      says: 'A supplier needs a phone number or an email. Without one, nothing you send them arrives and they cannot text photos in.',
    }, 400);
  }

  // Already here? Adding Marco twice means a photo resolves to whichever row
  // sorted first and half his fleet vanishes from the other. There is a unique
  // index on (phone, added_by_host) behind this; the check is so the host gets a
  // sentence instead of a constraint error.
  if (phone) {
    const existing = await env.DB.prepare(
      `SELECT s.id, s.display_name, l.id AS link_id, l.ended_at
         FROM num_suppliers s
         LEFT JOIN num_supplier_links l ON l.supplier_id = s.id AND l.host_id = ?2
        WHERE s.phone = ?1 AND s.added_by_host = ?2
        LIMIT 1`
    ).bind(phone, host.id).first().catch(() => null);

    if (existing) {
      // A previously ended relationship is revived rather than duplicated.
      if (existing.link_id && existing.ended_at) {
        await env.DB.prepare(
          `UPDATE num_supplier_links
              SET status='accepted', ended_at=NULL, ended_by=NULL, ended_note=NULL, decided_at=?1
            WHERE id=?2 AND host_id=?3`
        ).bind(now(), existing.link_id, host.id).run().catch(() => {});
        return safely(list);
      }
      return J({
        ok: false,
        error: 'already_added',
        says: `${existing.display_name} is already on your list with that number.`,
      }, 409);
    }
  }

  const supplierId = nid('sup_');
  const linkId = nid('slk_');

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO num_suppliers
           (id, member_id, display_name, business_name, kind, about, currency, status,
            open_to_hosts, phone, email, invited_at, added_by_host, accepts_mms, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,'active',0,?8,?9,?10,?11,?12,?13)`
      ).bind(
        supplierId,
        // member_id is NOT NULL in 0019. A supplier who is not a NUM member has
        // no member row, and the honest value is their own supplier id — it says
        // "this person exists only as a supplier" rather than pointing at a
        // member row that is not theirs. Linking a real member comes later, when
        // they sign up and verify the same number.
        clean(b.member_id, 40) || supplierId,
        name,
        clean(b.business_name, 160) || null,
        pick(b.kind, SUPPLIER_KINDS, 'other'),
        clean(b.about, 600) || null,
        (clean(b.currency, 3) || host.currency || 'GBP').toUpperCase().slice(0, 3),
        phone, email || null, now(), host.id,
        // Texting photos in is the point of this record, so it is on by default.
        1, now(),
      ),
      env.DB.prepare(
        `INSERT INTO num_supplier_links
           (id, host_id, supplier_id, asked_by, status, host_label, note, created_at, decided_at)
         VALUES (?1,?2,?3,'host','accepted',?4,?5,?6,?7)`
      ).bind(
        linkId, host.id, supplierId,
        clean(b.host_label, 80) || null, clean(b.note, 300) || null, now(), now(),
      ),
    ]);
  } catch (e) {
    console.warn('[suppliers] add failed', e?.message ?? e);
    return J({ ok: false, error: 'write_failed', detail: String(e?.message || '').slice(0, 200) }, 500);
  }

  // Tell them. This is the consent step and it is not optional.
  //
  // The host says "accepted" because they are the one with the relationship, so
  // the supplier finds out by being told immediately and by being able to stop
  // it in one word. A record created quietly about somebody who never hears
  // about it is not a working relationship, it is a list.
  if (email && D.sendBatch) {
    const site = env.SITE || 'https://itsnum.com';
    const smsNumber = numSmsNumber(env);
    D.sendBatch(env, [{
      to: email,
      subject: `${host.name} has added you as a supplier on NUM`,
      text: [
        `${host.name} works with NUM, and has added you as a supplier.`,
        '',
        'What that means in practice: when they need a boat prepped, a car delivered or',
        'guests met, the job reaches you with the full instructions on it. They pay you',
        'directly, exactly as now — NUM records the job and never sits between you.',
        '',
        /* THE DESTINATION, WHICH WAS MISSING EVERYWHERE.
         *
         * This line already named a number and named it correctly — `phone` is
         * the supplier's own, and "from ${phone}" is the number they send FROM,
         * which is how we know whose photograph it is. What it never said, and
         * what nothing else in the product said either, was the number to send
         * it TO. Found 19 Sep 2026; see numSmsNumber() in worker/twiliosender.
         *
         * Two things must be true to make the promise: a number we hold for
         * them, and a number for them to reach. With only the first, we say so
         * and still confirm the mobile we have — a supplier who was told their
         * number is on file will not go hunting for the setting. */
        (phone && smsNumber
          ? `You can also text photographs of anything you look after to NUM on ${smsNumber}, from ${phone} — the mobile ${host.name} gave us, so we know they are yours. They appear in ${host.name}'s listing once they approve them. No app, no login.`
          : (phone
            ? `${host.name} gave us ${phone} as your mobile. Texting photographs in is not switched on just yet; when it is, we will send you the number to use.`
            : 'Ask them to add your mobile number and you will be able to text photographs straight in.')),
        '',
        'If this is not right, reply to this email and we will take you off. You can reply',
        'STOP to any text to stop those.',
        '',
        site,
      ].join('\n'),
    }])
      .then(() => env.DB.prepare('UPDATE num_suppliers SET notified_at=?1 WHERE id=?2')
        .bind(now(), supplierId).run())
      .catch((e) => console.warn('[suppliers] notify failed', e?.message ?? e));
  }

  return safely(list);
}

/**
 * A supplier's own assets, for the host to see what they actually hold.
 *
 * Separate from /api/host/assets because that one answers "what can I let out"
 * and this one answers "what does Marco look after" — the same rows, asked a
 * different way, and a host reads the second one when deciding who to dispatch.
 */
export async function supplierAssets(req, env, url, D) {
  const { J, clean, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);

  const supplierId = clean(url.searchParams.get('id'), 40);
  if (!supplierId) return J({ ok: false, error: 'no_id' }, 400);

  // The host may only look at a supplier they are actually linked to, and the
  // check is in the WHERE clause rather than applied afterwards: a filter you
  // forget is a data leak, a WHERE clause you forget is an empty list.
  const linked = await env.DB.prepare(
    `SELECT 1 FROM num_supplier_links
      WHERE host_id=?1 AND supplier_id=?2 AND status='accepted' AND ended_at IS NULL LIMIT 1`
  ).bind(host.id, supplierId).first().catch(() => null);
  if (!linked) return J({ ok: false, error: 'not_your_supplier' }, 403);

  const q = env.DB.prepare(
    `SELECT a.id, a.kind, a.name, a.make, a.model, a.year, a.home_port, a.home_city,
            a.currency, a.rate_minor, a.rate_unit, a.listable, a.status,
            (SELECT COUNT(*) FROM num_asset_photos p
              WHERE p.asset_id = a.id AND p.moderation = 'ok') AS photos_ok
       FROM num_assets a
      WHERE a.owner_kind='supplier' AND a.owner_id=?1 AND a.status <> 'retired'
      ORDER BY a.kind ASC, a.name ASC LIMIT 200`
  ).bind(supplierId);

  try {
    return J({ ok: true, assets: await rows(q.all(), "a supplier's assets") });
  } catch (e) {
    if (isReadFailed(e)) return readFailedResponse(J, e);
    throw e;
  }
}
