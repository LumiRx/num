/**
 * Proving a business is yours — wired to the form people actually fill in.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────
 *
 * The public claim form at /claim/ wrote a row to `claims` and stopped. No
 * verification, no business record, no console. Nothing in the codebase ever
 * moved `claims.state` off the literal 'new' it was inserted with. A venue
 * that filled it in got a receipt email — which was itself never sent, because
 * RESEND_KEY was not set on this worker — and an alert to Andre. The intended
 * completion was a phone call.
 *
 * Meanwhile a complete, careful verification worker (claim/worker.js and
 * claim/verify.mjs, about a thousand lines with anti-fraud, contested-listing
 * review and domain proof) sat deployed with NO ROUTES. growth/wrangler.jsonc
 * even carried a note to itself about wiring it up. It never happened. The
 * result was four claim tables across four workers, an admin Claims queue
 * reading the one nothing populated, and 0 business logins.
 *
 * ── WHAT THIS DOES ────────────────────────────────────────────────────────
 *
 * It puts the verification behind the door people already walk through. The
 * routes live under /api/claims/*, which `itsnum.com/api/claims*` already
 * sends here, so nothing new has to be routed and no second worker has to
 * hold a second copy of the Resend key.
 *
 * The hard parts are NOT reimplemented. Every rule that decides whether
 * somebody owns a business — which channels are permissible, what counts as a
 * business domain, which mail providers are too free to prove anything, the
 * rate limits, the code hashing — is imported from claim/verify.mjs, the file
 * that was already written and already tested. This module is the wiring.
 *
 * ── THE RULE THAT MAKES IT PROOF ──────────────────────────────────────────
 *
 * The code goes to a contact ALREADY PUBLISHED ON THE LISTING — the phone or
 * email we crawled, or a mailbox on the listing's own website domain. Never
 * to an address typed into the form. That asymmetry is the whole mechanism:
 * anyone can type an address, only the owner can read the one on the door.
 *
 * A listing somebody has already proved is contested, not transferable. It
 * goes to human review and the incumbent is not silently replaced.
 */

import {
  CODE_TTL_MIN, MAX_ATTEMPTS,
  uid, generateCode, hashCode, safeEqual,
  normalisePhone, domainOf, sameDomain, isFreeMail,
  maskPhone, maskEmail, channelsFor, rateLimitOk, logEvent,
} from '../claim/verify.mjs';
import { onboardStatements } from '../claim/onboard.mjs';

/**
 * Columns the lead row gains so it can point at its own proof.
 *
 * Applied lazily rather than by a migration file, because this repo has no
 * migration runner — 0008 and 0009 are hand-applied, and a feature that only
 * works after somebody remembers to run some SQL is a feature that does not
 * work. Each ALTER is attempted once per isolate and its failure swallowed:
 * "duplicate column name" is the expected result on every run after the first.
 */
const LINK_COLUMNS = [
  'ALTER TABLE claims ADD COLUMN num_claim_id TEXT',
  'ALTER TABLE claims ADD COLUMN business_id TEXT',
  'ALTER TABLE claims ADD COLUMN verified_at TEXT',
];
let linked = false;
async function ensureLink(env) {
  if (linked || !env?.DB) return;
  for (const sql of LINK_COLUMNS) await env.DB.prepare(sql).run().catch(() => {});
  linked = true;
}
/** Test hook — a fresh in-memory database per suite needs the columns again. */
export const _resetLinkCache = () => { linked = false; };

/**
 * Everything this module borrows from the worker, passed in rather than
 * imported, because the worker imports this file and a cycle would be worse
 * than an argument.
 */
export const claimDeps = ({ J, clean, readJSON, sendBatch, legalLine }) =>
  Object.freeze({ J, clean, readJSON, sendBatch, legalLine });

/**
 * The channels that can prove this listing, including the one the shared
 * helper leaves out.
 *
 * `channelsFor` in claim/verify.mjs offers SMS, a mailbox on the listing's own
 * website domain, and manual review. It does not offer `places.email` — the
 * address we actually crawled off the listing — and that omission is
 * expensive: across Los Angeles, Bali, Phuket and Edinburgh, 12,760 venues
 * publish an email and have no website at all. With SMS unavailable on this
 * worker, those 12,760 would have no way to prove anything.
 *
 * A crawled address is proof by exactly the same logic as a crawled phone
 * number: it is the contact ALREADY PUBLISHED on the listing, and we send to
 * it rather than to anything the claimant typed. The isFreeMail guard is not
 * applied here, and that is deliberate — it exists on the domain channel
 * because there the CLAIMANT names the mailbox, so a free one proves nothing.
 * Nobody named this one. If a restaurant publishes a Gmail address on its own
 * door, reading that inbox is what owning the restaurant looks like.
 *
 * The shared helper is left untouched, because the unrouted claim worker and
 * its tests also depend on it.
 */
function channelsForClaim(place) {
  const base = channelsFor(place);
  const email = String(place?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return base;
  if (base.some((c) => c.channel === 'email')) return base;
  // Ahead of manual, behind the domain channel: a mailbox on the business's
  // own domain is the stronger of the two, so it should be offered first.
  const out = base.filter((c) => c.channel !== 'manual');
  out.push({
    channel: 'email',
    value: email,
    display: maskEmail(email),
    label: 'Email the address on your listing',
  });
  return out.concat(base.filter((c) => c.channel === 'manual'));
}

/**
 * Send a six-digit code to a destination taken from the DIRECTORY row.
 *
 * SMS is deliberately not attempted here. This worker has no Twilio binding,
 * and a channel that silently fails is worse than one that is not offered:
 * the claimant waits for a code that was never sent and concludes NUM is
 * broken. Email and domain-email are real; an SMS-only listing is routed to
 * review, which is honest and still ends with a verified business.
 */
async function sendCode(env, deps, { channel, to, code, businessName }) {
  if (channel === 'sms') return { ok: false, error: 'no_sms_provider' };
  if (!env.RESEND_KEY) return { ok: false, error: 'no_email_provider' };

  const lines = [
    `Your code for ${businessName} is ${code}`,
    '',
    `It is good for ${CODE_TTL_MIN} minutes and can be used once.`,
    '',
    'We sent it to the contact already published on your listing, not to an',
    'address typed into the form. That is what proves the listing is yours.',
    '',
    'If you did not ask for this, ignore it — nothing changes without the code.',
    '',
    'NUM · 5arz Inc.',
    deps.legalLine ?? '',
  ];

  try {
    const out = await deps.sendBatch(env, [{
      // One code per send, not per retry: a resend must actually resend.
      __idem: `claimcode-${code.slice(0, 2)}-${Date.now()}`,
      from: env.MAIL_FROM || 'NUM <info@itsnum.com>',
      to: [to],
      reply_to: 'info@itsnum.com',
      subject: `${code} is your NUM code for ${businessName}`,
      text: lines.join('\n'),
    }]);
    return out === false ? { ok: false, error: 'send_failed' } : { ok: true, via: 'resend' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 80) };
  }
}

/* ── POST /api/claims/start ─────────────────────────────────────────────── */

/**
 * Open a verification against a listing and say which channels can prove it.
 *
 * `lead_id` is the row the public form already wrote. Passing it links the
 * lead to its proof, so `claims.state` finally means something instead of
 * being write-once 'new'.
 */
export async function claimStart(req, env, deps) {
  const b = await deps.readJSON(req, 8192).catch(() => ({}));
  const ip = req.headers.get('cf-connecting-ip') || '0';
  const placeId = deps.clean(b.place_id, 64);
  if (!placeId) return deps.J({ ok: false, error: 'place_id required' }, 400);
  await ensureLink(env);

  const place = await env.DB.prepare(
    'SELECT id, name, phone, email, website, dest FROM places WHERE id = ?1',
  ).bind(placeId).first();
  if (!place) return deps.J({ ok: false, error: 'listing not found' }, 404);

  const limit = await rateLimitOk(env, { placeId, ip });
  if (!limit.ok) return deps.J({ ok: false, error: limit.reason }, 429);

  // A listing somebody already proved is contested, not transferable. We do
  // not hand it over on a code — the incumbent gets to be told first.
  const owner = await env.DB.prepare(
    'SELECT business_id FROM num_place_owners WHERE place_id=?1 AND revoked_at IS NULL',
  ).bind(placeId).first();

  const id = uid('clm');
  await env.DB.prepare(
    `INSERT INTO num_claims (id, place_id, claimant_name, claimant_email, claimant_phone,
                             channel, state, ip, user_agent, review_reason)
     VALUES (?1,?2,?3,?4,?5,'manual',?6,?7,?8,?9)`,
  ).bind(
    id, placeId, deps.clean(b.name, 80) || null, deps.clean(b.email, 200) || null,
    normalisePhone(b.phone) || null,
    owner ? 'review' : 'pending', ip,
    (req.headers.get('User-Agent') || '').slice(0, 200),
    owner ? 'already_claimed' : null,
  ).run();
  await logEvent(env, id, 'started', owner ? 'contested: listing already owned' : place.name, ip);

  // Link the lead the public form wrote to the proof it is now attempting.
  const leadId = Number(b.lead_id);
  if (Number.isFinite(leadId) && leadId > 0) {
    await env.DB.prepare(
      "UPDATE claims SET num_claim_id=?2, state='verifying' WHERE id=?1 AND state='new'",
    ).bind(leadId, id).run().catch(() => {});
  }

  const all = channelsForClaim(place).map((c) => ({
    channel: c.channel, display: c.display, label: c.label,
  }));
  // SMS is filtered out rather than offered and then failed — see sendCode.
  const usable = all.filter((c) => c.channel !== 'sms');

  return deps.J({
    ok: true,
    claim_id: id,
    business: { id: place.id, name: place.name },
    contested: !!owner,
    channels: owner ? all.filter((c) => c.channel === 'manual') : usable,
    note: owner
      ? 'Someone has already proved this listing. Your claim goes to our team and the current owner is told — we never transfer a listing on a code alone.'
      : 'We send the code to the contact already published on your listing, not to one you type in. That is what proves it is yours.',
  });
}

/* ── POST /api/claims/send ──────────────────────────────────────────────── */

export async function claimSend(req, env, deps) {
  const b = await deps.readJSON(req, 8192).catch(() => ({}));
  const ip = req.headers.get('cf-connecting-ip') || '0';
  const claim = await env.DB.prepare('SELECT * FROM num_claims WHERE id=?1')
    .bind(deps.clean(b.claim_id, 40)).first();
  if (!claim) return deps.J({ ok: false, error: 'claim not found' }, 404);
  if (claim.state === 'verified') return deps.J({ ok: false, error: 'already verified' }, 409);
  if (claim.state === 'review') return deps.J({ ok: false, error: 'this claim is with our team' }, 409);

  const place = await env.DB.prepare('SELECT id, name, phone, email, website FROM places WHERE id=?1')
    .bind(claim.place_id).first();
  if (!place) return deps.J({ ok: false, error: 'listing not found' }, 404);

  const wanted = String(b.channel || '');
  const pick = channelsForClaim(place).find((c) => c.channel === wanted);
  if (!pick || pick.channel === 'manual') {
    return deps.J({ ok: false, error: 'choose a verifiable channel' }, 400);
  }

  // The destination comes from the directory row. The one exception is
  // email_domain, where the claimant names the mailbox — but it must sit on
  // the business's own domain, which is the part they cannot fake.
  let target = pick.value;
  if (pick.channel === 'email_domain') {
    const addr = String(b.email || '').trim().toLowerCase();
    const dom = domainOf(place.website);
    const addrDom = addr.includes('@') ? addr.split('@')[1] : '';
    if (!addr || !sameDomain(addr, dom) || isFreeMail(addrDom)) {
      return deps.J({
        ok: false,
        error: `Use an email address at ${dom} — a free mailbox cannot prove ownership.`,
      }, 400);
    }
    target = addr;
  }

  const code = generateCode();
  const salt = crypto.randomUUID();
  const codeHash = await hashCode(code, salt);
  const expires = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString();

  const out = await sendCode(env, deps, {
    channel: pick.channel, to: target, code, businessName: place.name,
  });
  if (!out.ok) {
    await logEvent(env, claim.id, 'code_send_failed', out.error, ip);
    // A missing provider is our configuration gap, not the claimant's fault.
    // Hand them the manual route rather than a dead end — and say so plainly,
    // because "try again later" on a permanent failure is a lie.
    if (out.error === 'no_sms_provider' || out.error === 'no_email_provider') {
      await env.DB.prepare("UPDATE num_claims SET state='review', review_reason=?2 WHERE id=?1")
        .bind(claim.id, `channel unavailable: ${out.error}`).run();
      return deps.J({
        ok: false, fallback: 'manual',
        error: 'We cannot send a code on that channel yet.',
        message: 'A person from our team will verify this by hand instead — usually the same day.',
      }, 503);
    }
    return deps.J({ ok: false, error: 'Could not send the code. Try the other channel.' }, 502);
  }

  await env.DB.prepare(
    `UPDATE num_claims SET channel=?2, channel_value=?3, code_hash=?4, code_salt=?5,
            attempts=0, sent_at=datetime('now'), expires_at=?6, state='pending' WHERE id=?1`,
  ).bind(
    claim.id, pick.channel,
    pick.channel === 'sms' ? maskPhone(target) : maskEmail(target),
    codeHash, salt, expires,
  ).run();
  await logEvent(env, claim.id, 'code_sent', `${pick.channel} via ${out.via}`, ip);

  return deps.J({
    ok: true,
    sent_to: pick.channel === 'sms' ? maskPhone(target) : maskEmail(target),
    channel: pick.channel,
    expires_in_minutes: CODE_TTL_MIN,
    attempts_allowed: MAX_ATTEMPTS,
  });
}

/* ── POST /api/claims/verify ────────────────────────────────────────────── */

export async function claimVerify(req, env, deps) {
  const b = await deps.readJSON(req, 8192).catch(() => ({}));
  const ip = req.headers.get('cf-connecting-ip') || '0';
  const claim = await env.DB.prepare('SELECT * FROM num_claims WHERE id=?1')
    .bind(deps.clean(b.claim_id, 40)).first();
  if (!claim) return deps.J({ ok: false, error: 'claim not found' }, 404);
  if (claim.state === 'verified') return deps.J({ ok: true, already: true });
  if (claim.state !== 'pending' || !claim.code_hash) {
    return deps.J({ ok: false, error: 'no code pending for this claim' }, 409);
  }

  if (claim.expires_at && new Date(claim.expires_at) < new Date()) {
    await env.DB.prepare("UPDATE num_claims SET state='expired' WHERE id=?1").bind(claim.id).run();
    await logEvent(env, claim.id, 'expired', null, ip);
    return deps.J({ ok: false, error: 'That code expired. Ask for a new one.' }, 410);
  }
  if (claim.attempts >= claim.max_attempts) {
    await env.DB.prepare("UPDATE num_claims SET state='failed' WHERE id=?1").bind(claim.id).run();
    await logEvent(env, claim.id, 'locked', 'attempt cap reached', ip);
    return deps.J({
      ok: false,
      error: 'Too many wrong codes. This claim is locked — start again, or send proof instead.',
    }, 429);
  }

  const supplied = String(b.code || '').replace(/\D/g, '');
  const hash = await hashCode(supplied, claim.code_salt);
  if (!safeEqual(hash, claim.code_hash)) {
    const left = claim.max_attempts - (claim.attempts + 1);
    await env.DB.prepare('UPDATE num_claims SET attempts = attempts + 1 WHERE id=?1').bind(claim.id).run();
    await logEvent(env, claim.id, 'code_wrong', `${left} left`, ip);
    return deps.J({ ok: false, error: 'That code does not match.', attempts_left: Math.max(0, left) }, 400);
  }

  // Verified. Create the business, take ownership, burn the code so it can
  // never be replayed, and run onboardStatements — without which the business
  // is verified but inert: no commission rate, no timezone, no feature flags.
  const place = await env.DB.prepare(
    `SELECT id, name, category, dest, phone, country, area, address, lat, lng, website, email
       FROM places WHERE id=?1`,
  ).bind(claim.place_id).first();
  const businessId = uid('biz');

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO businesses (id, name, kind, category, territory, status, onboarded_by, notes)
       VALUES (?1,?2,'merchant',?3,?4,'active','claim',?5)`,
    ).bind(businessId, place.name, place.category ?? null, place.dest ?? null, `claim ${claim.id}`),
    env.DB.prepare(
      `INSERT INTO num_place_owners (place_id, business_id, claim_id, method, phone)
       VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT(place_id) DO UPDATE SET business_id=excluded.business_id,
             claim_id=excluded.claim_id, method=excluded.method, phone=excluded.phone,
             verified_at=datetime('now'), revoked_at=NULL`,
    ).bind(claim.place_id, businessId, claim.id, claim.channel,
      claim.channel === 'sms' ? place.phone : null),
    env.DB.prepare(
      `UPDATE num_claims SET state='verified', business_id=?2, code_hash=NULL, code_salt=NULL,
              decided_at=datetime('now'), decided_by='auto' WHERE id=?1`,
    ).bind(claim.id, businessId),
    env.DB.prepare("UPDATE places SET status='claimed', business_id=?2 WHERE id=?1")
      .bind(claim.place_id, businessId),
    ...(await onboardStatements(env, businessId, place, 'claim:' + claim.channel)),
  ]);

  // Close the loop on the lead row, so the public form's own table finally
  // records an outcome instead of a permanent 'new'.
  await env.DB.prepare(
    `UPDATE claims SET state='verified', business_id=?2, verified_at=datetime('now')
      WHERE num_claim_id=?1`,
  ).bind(claim.id, businessId).run().catch(() => {});

  await logEvent(env, claim.id, 'verified', claim.channel, ip);

  return deps.J({
    ok: true,
    business_id: businessId,
    place: { id: place.id, name: place.name },
    next: 'Your listing is yours. We will send your dashboard link to the same contact.',
  });
}

/* ── GET /api/claims/status ─────────────────────────────────────────────── */

export async function claimStatus(req, env, url, deps) {
  const cid = deps.clean(url.searchParams.get('claim_id'), 40);
  if (!cid) return deps.J({ ok: false, error: 'claim_id required' }, 400);
  const r = await env.DB.prepare(
    `SELECT c.id, c.state, c.channel, c.channel_value, c.review_reason, c.business_id,
            p.name AS place_name
       FROM num_claims c LEFT JOIN places p ON p.id = c.place_id
      WHERE c.id = ?1`,
  ).bind(cid).first();
  if (!r) return deps.J({ ok: false, error: 'claim not found' }, 404);
  // channel_value is already masked at write time; nothing here un-masks it.
  return deps.J({ ok: true, ...r });
}
