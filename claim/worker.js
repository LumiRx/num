/**
 * NUM · claim + referral API  (worker: num-claim)
 *
 * Business claim (see verify.mjs for the anti-fraud reasoning):
 *   GET  /claim/lookup?q=      → find your listing in the directory
 *   POST /claim/start          { place_id, name, email, phone } → channels you can verify on
 *   POST /claim/send           { claim_id, channel }            → OTP to the LISTED contact
 *   POST /claim/verify         { claim_id, code }               → ownership, number linked
 *   POST /claim/evidence       { claim_id, note, links[] }      → manual review queue
 *   GET  /claim/status?id=
 *   GET  /admin/claims?state=  (admin key)  ·  POST /admin/decide { claim_id, decision }
 *
 * Referrals & invites:
 *   POST /ref/code             { owner_id, owner_type, name?, university? } → their code
 *   POST /ref/invite           { code, to_name?, to_phone?, message? } → personalised link
 *   GET  /r/:token             → records the open, redirects into the app
 *   POST /ref/signup           { token|code, signup_id }  → attribute the conversion
 *   GET  /ref/stats?code=      → sent / opened / joined, plus the leaderboard rank
 */
import {
  CODE_TTL_MIN, MAX_ATTEMPTS, channelsFor, generateCode, hashCode, isFreeMail, logEvent,
  domainOf, maskEmail, maskPhone, normalisePhone, nowIso, rateLimitOk, safeEqual, sameDomain,
  sendCode, uid,
} from './verify.mjs';
import { onboardStatements } from './onboard.mjs';

const APP = 'https://num-app.thatislumi.workers.dev';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });

const ipOf = (req) => req.headers.get('CF-Connecting-IP') ?? null;
const body = async (req) => { try { return await req.json(); } catch { return {}; } };

// ── Business claim ────────────────────────────────────────────────────────

async function lookup(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const dest = url.searchParams.get('dest');
  if (q.length < 2) return json({ results: [] });
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.category, p.area, p.dest, p.address, p.phone, p.website,
            (o.place_id IS NOT NULL) AS claimed
       FROM places p LEFT JOIN num_place_owners o ON o.place_id = p.id AND o.revoked_at IS NULL
      WHERE p.name LIKE ?1 ${dest ? 'AND p.dest = ?2' : ''}
      ORDER BY (p.rating IS NULL), p.rating DESC LIMIT 12`,
  ).bind(`%${q}%`, ...(dest ? [dest] : [])).all();

  // Never leak the full contact — it is the verification target.
  return json({
    results: (results ?? []).map((r) => ({
      id: r.id, name: r.name, category: r.category, area: r.area, dest: r.dest,
      address: r.address, claimed: !!r.claimed,
      can_verify: channelsFor(r).map((c) => ({ channel: c.channel, display: c.display, label: c.label })),
    })),
  });
}

async function start(env, req) {
  const b = await body(req);
  const ip = ipOf(req);
  const placeId = String(b.place_id || '');
  if (!placeId) return json({ error: 'place_id required' }, 400);

  const place = await env.DB.prepare(
    'SELECT id, name, phone, website, dest FROM places WHERE id = ?1',
  ).bind(placeId).first();
  if (!place) return json({ error: 'listing not found' }, 404);

  const limit = await rateLimitOk(env, { placeId, ip });
  if (!limit.ok) return json({ error: limit.reason }, 429);

  // Contested listing: an owner already proved control. We do NOT let a code
  // silently transfer it — it goes to review and the incumbent is flagged.
  const owner = await env.DB.prepare(
    'SELECT business_id FROM num_place_owners WHERE place_id=?1 AND revoked_at IS NULL',
  ).bind(placeId).first();

  const id = uid('clm');
  const claimantPhone = normalisePhone(b.phone);
  await env.DB.prepare(
    `INSERT INTO num_claims (id, place_id, claimant_name, claimant_email, claimant_phone, channel, state, ip, user_agent, review_reason)
     VALUES (?1,?2,?3,?4,?5,'manual',?6,?7,?8,?9)`,
  ).bind(
    id, placeId, b.name ?? null, b.email ?? null, claimantPhone,
    owner ? 'review' : 'pending', ip, (req.headers.get('User-Agent') || '').slice(0, 200),
    owner ? 'already_claimed' : null,
  ).run();
  await logEvent(env, id, 'started', owner ? 'contested: listing already owned' : place.name, ip);

  const channels = channelsFor(place).map((c) => ({ channel: c.channel, display: c.display, label: c.label }));
  return json({
    claim_id: id,
    business: { id: place.id, name: place.name },
    contested: !!owner,
    channels: owner ? channels.filter((c) => c.channel === 'manual') : channels,
    note: owner
      ? 'This listing is already verified by someone. Your claim goes to our team, and the current owner is notified — we never transfer a listing on a code alone.'
      : 'We send the code to the contact published on the listing, not to a number you enter. That is what proves the listing is yours.',
  });
}

async function send(env, req) {
  const b = await body(req);
  const ip = ipOf(req);
  const claim = await env.DB.prepare('SELECT * FROM num_claims WHERE id=?1').bind(String(b.claim_id || '')).first();
  if (!claim) return json({ error: 'claim not found' }, 404);
  if (claim.state === 'verified') return json({ error: 'already verified' }, 409);
  if (claim.state === 'review') return json({ error: 'this claim is with our team' }, 409);

  const place = await env.DB.prepare('SELECT id, name, phone, website FROM places WHERE id=?1').bind(claim.place_id).first();
  if (!place) return json({ error: 'listing not found' }, 404);

  const wanted = String(b.channel || '');
  const available = channelsFor(place);
  const pick = available.find((c) => c.channel === wanted);
  if (!pick || pick.channel === 'manual') return json({ error: 'choose a verifiable channel' }, 400);

  // The destination is derived from the DIRECTORY row, never from the request.
  let target = pick.value;
  if (pick.channel === 'email_domain') {
    // The claimant names the mailbox, but it must live on the business's own
    // domain — that is the part they cannot fake.
    const addr = String(b.email || '').trim().toLowerCase();
    const dom = domainOf(place.website);
    if (!addr || !sameDomain(addr, dom) || isFreeMail(domainOf(`x@${addr.split('@')[1]}`))) {
      return json({ error: `Use an email address at ${dom} — a free mailbox can't prove ownership.` }, 400);
    }
    target = addr;
  }

  const code = generateCode();
  const salt = crypto.randomUUID();
  const codeHash = await hashCode(code, salt);
  const expires = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString();

  const out = await sendCode(env, { channel: pick.channel, to: target, code, businessName: place.name });
  if (!out.ok) {
    await logEvent(env, claim.id, 'code_send_failed', out.error, ip);
    // No provider is a configuration gap, not the claimant's fault: hand them
    // the manual route rather than a dead end.
    if (out.error === 'no_sms_provider' || out.error === 'no_email_provider') {
      await env.DB.prepare("UPDATE num_claims SET state='review', review_reason=?2 WHERE id=?1")
        .bind(claim.id, `channel unavailable: ${out.error}`).run();
      return json({
        error: 'We can’t send codes on that channel yet.',
        fallback: 'manual',
        message: 'Send proof instead and our team will verify it by hand — usually same day.',
      }, 503);
    }
    return json({ error: 'Could not send the code. Try the other channel.' }, 502);
  }

  await env.DB.prepare(
    `UPDATE num_claims SET channel=?2, channel_value=?3, code_hash=?4, code_salt=?5,
            attempts=0, sent_at=datetime('now'), expires_at=?6, state='pending' WHERE id=?1`,
  ).bind(claim.id, pick.channel, pick.channel === 'sms' ? maskPhone(target) : maskEmail(target), codeHash, salt, expires).run();
  await logEvent(env, claim.id, 'code_sent', `${pick.channel} via ${out.via}`, ip);

  return json({
    sent_to: pick.channel === 'sms' ? maskPhone(target) : maskEmail(target),
    channel: pick.channel,
    expires_in_minutes: CODE_TTL_MIN,
    attempts_allowed: MAX_ATTEMPTS,
  });
}

async function verify(env, req) {
  const b = await body(req);
  const ip = ipOf(req);
  const claim = await env.DB.prepare('SELECT * FROM num_claims WHERE id=?1').bind(String(b.claim_id || '')).first();
  if (!claim) return json({ error: 'claim not found' }, 404);
  if (claim.state === 'verified') return json({ ok: true, already: true });
  if (claim.state !== 'pending' || !claim.code_hash) return json({ error: 'no code pending for this claim' }, 409);

  if (claim.expires_at && new Date(claim.expires_at) < new Date()) {
    await env.DB.prepare("UPDATE num_claims SET state='expired' WHERE id=?1").bind(claim.id).run();
    await logEvent(env, claim.id, 'expired', null, ip);
    return json({ error: 'That code expired. Request a new one.' }, 410);
  }
  if (claim.attempts >= claim.max_attempts) {
    await env.DB.prepare("UPDATE num_claims SET state='failed' WHERE id=?1").bind(claim.id).run();
    await logEvent(env, claim.id, 'locked', 'attempt cap reached', ip);
    return json({ error: 'Too many wrong codes. This claim is locked — start again or send proof.' }, 429);
  }

  const supplied = String(b.code || '').replace(/\D/g, '');
  const hash = await hashCode(supplied, claim.code_salt);
  if (!safeEqual(hash, claim.code_hash)) {
    const left = claim.max_attempts - (claim.attempts + 1);
    await env.DB.prepare('UPDATE num_claims SET attempts = attempts + 1 WHERE id=?1').bind(claim.id).run();
    await logEvent(env, claim.id, 'code_wrong', `${left} left`, ip);
    return json({ error: 'That code doesn’t match.', attempts_left: Math.max(0, left) }, 400);
  }

  // Verified. Create the business, take ownership, link the verified number,
  // and burn the code so it can never be replayed.
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
       ON CONFLICT(place_id) DO UPDATE SET business_id=excluded.business_id, claim_id=excluded.claim_id,
             method=excluded.method, phone=excluded.phone, verified_at=datetime('now'), revoked_at=NULL`,
    ).bind(claim.place_id, businessId, claim.id, claim.channel, claim.channel === 'sms' ? place.phone : null),
    env.DB.prepare(
      `UPDATE num_claims SET state='verified', business_id=?2, code_hash=NULL, code_salt=NULL,
              decided_at=datetime('now'), decided_by='auto' WHERE id=?1`,
    ).bind(claim.id, businessId),
    env.DB.prepare("UPDATE places SET status='claimed', business_id=?2 WHERE id=?1").bind(claim.place_id, businessId),
    // Without these two the business is verified but inert -- no commission
    // rate, no timezone, no locale, no feature flags. See onboard.mjs.
    ...(await onboardStatements(env, businessId, place, 'claim:' + claim.channel)),
  ]);
  await logEvent(env, claim.id, 'verified', claim.channel, ip);

  return json({
    ok: true,
    business_id: businessId,
    place: { id: place.id, name: place.name },
    next: 'Sign in with the same contact to manage your listing.',
  });
}

async function evidence(env, req) {
  const b = await body(req);
  const claim = await env.DB.prepare('SELECT id, state FROM num_claims WHERE id=?1').bind(String(b.claim_id || '')).first();
  if (!claim) return json({ error: 'claim not found' }, 404);
  const payload = JSON.stringify({
    note: String(b.note || '').slice(0, 2000),
    links: Array.isArray(b.links) ? b.links.slice(0, 8).map((l) => String(l).slice(0, 500)) : [],
    at: nowIso(),
  });
  await env.DB.prepare("UPDATE num_claims SET evidence=?2, state='review', review_reason=COALESCE(review_reason,'evidence_submitted') WHERE id=?1")
    .bind(claim.id, payload).run();
  await logEvent(env, claim.id, 'review', 'evidence submitted', ipOf(req));
  return json({ ok: true, state: 'review', message: 'With our team now — most claims are decided within a day.' });
}

async function status(env, url) {
  const c = await env.DB.prepare(
    'SELECT id, state, channel, channel_value, review_reason, created_at, decided_at FROM num_claims WHERE id=?1',
  ).bind(url.searchParams.get('id') || '').first();
  if (!c) return json({ error: 'not found' }, 404);
  return json(c);
}

// ── Admin review ──────────────────────────────────────────────────────────

const isAdmin = (env, req) => !!env.ADMIN_KEY && req.headers.get('X-Admin-Key') === env.ADMIN_KEY;

async function adminClaims(env, req, url) {
  if (!isAdmin(env, req)) return json({ error: 'unauthorized' }, 401);
  const state = url.searchParams.get('state') || 'review';
  const { results } = await env.DB.prepare(
    `SELECT c.*, p.name place_name, p.address, p.dest
       FROM num_claims c JOIN places p ON p.id = c.place_id
      WHERE c.state = ?1 ORDER BY c.created_at DESC LIMIT 100`,
  ).bind(state).all();
  return json({ claims: results ?? [] });
}

async function adminDecide(env, req) {
  if (!isAdmin(env, req)) return json({ error: 'unauthorized' }, 401);
  const b = await body(req);
  const claim = await env.DB.prepare('SELECT * FROM num_claims WHERE id=?1').bind(String(b.claim_id || '')).first();
  if (!claim) return json({ error: 'claim not found' }, 404);
  const approve = b.decision === 'approve';

  if (!approve) {
    await env.DB.prepare("UPDATE num_claims SET state='rejected', decided_at=datetime('now'), decided_by=?2, review_reason=?3 WHERE id=?1")
      .bind(claim.id, String(b.by || 'admin'), String(b.reason || 'rejected')).run();
    await logEvent(env, claim.id, 'decided', 'rejected: ' + (b.reason || ''), ipOf(req));
    return json({ ok: true, state: 'rejected' });
  }

  const place = await env.DB.prepare(
    `SELECT id, name, category, dest, phone, country, area, address, lat, lng, website, email
       FROM places WHERE id=?1`,
  ).bind(claim.place_id).first();
  const businessId = uid('biz');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO businesses (id, name, kind, category, territory, status, onboarded_by, notes)
       VALUES (?1,?2,'merchant',?3,?4,'active','claim-review',?5)`,
    ).bind(businessId, place.name, place.category ?? null, place.dest ?? null, `claim ${claim.id} (manual)`),
    env.DB.prepare(
      `INSERT INTO num_place_owners (place_id, business_id, claim_id, method, phone)
       VALUES (?1,?2,?3,'manual',?4)
       ON CONFLICT(place_id) DO UPDATE SET business_id=excluded.business_id, claim_id=excluded.claim_id,
             method='manual', verified_at=datetime('now'), revoked_at=NULL`,
    ).bind(claim.place_id, businessId, claim.id, claim.claimant_phone ?? null),
    env.DB.prepare("UPDATE num_claims SET state='verified', business_id=?2, decided_at=datetime('now'), decided_by=?3 WHERE id=?1")
      .bind(claim.id, businessId, String(b.by || 'admin')),
    env.DB.prepare("UPDATE places SET status='claimed', business_id=?2 WHERE id=?1").bind(claim.place_id, businessId),
    ...(await onboardStatements(env, businessId, place, 'claim-review:' + String(b.by || 'admin'))),
  ]);
  await logEvent(env, claim.id, 'decided', 'approved by ' + (b.by || 'admin'), ipOf(req));
  return json({ ok: true, state: 'verified', business_id: businessId });
}

// ── Referrals & invites ───────────────────────────────────────────────────

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 — these get read aloud
function friendlyCode(seed = 6) {
  const buf = new Uint8Array(seed);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

async function refCode(env, req) {
  const b = await body(req);
  const ownerId = String(b.owner_id || '').trim();
  if (!ownerId) return json({ error: 'owner_id required' }, 400);
  const ownerType = ['member', 'ambassador', 'university', 'business', 'agent', 'placement'].includes(b.owner_type)
    ? b.owner_type : 'member';

  const existing = await env.DB.prepare(
    'SELECT code FROM num_referral_codes WHERE owner_id=?1 AND owner_type=?2 AND active=1 LIMIT 1',
  ).bind(ownerId, ownerType).first();
  if (existing) return json({ code: existing.code, link: `${APP}/?ref=${existing.code}` });

  let code = friendlyCode();
  for (let i = 0; i < 5; i++) {
    const clash = await env.DB.prepare('SELECT 1 FROM num_referral_codes WHERE code=?1').bind(code).first();
    if (!clash) break;
    code = friendlyCode();
  }
  await env.DB.prepare(
    `INSERT INTO num_referral_codes (code, owner_type, owner_id, university_id, reward_cs, reward_referee_cs,
                                     max_conversions, max_reward_total_cs, active, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,unixepoch())`,
  ).bind(
    code, ownerType, ownerId, b.university_id ?? null,
    Number(b.reward_cs ?? 500), Number(b.reward_referee_cs ?? 500),
    // Uncapped codes are uncapped liability — the schema says so and we honour it.
    Number(b.max_conversions ?? 200), Number(b.max_reward_total_cs ?? 200000),
  ).run();

  if (ownerType === 'ambassador') {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO num_ambassadors (id, name, email, university_id, member_ref, status, created_at)
       VALUES (?1,?2,?3,?4,?5,'active',unixepoch())`,
    ).bind(uid('amb'), String(b.name || 'Ambassador'), b.email ?? null, b.university_id ?? null, ownerId).run();
  }
  return json({ code, link: `${APP}/?ref=${code}` });
}

/**
 * Mint a personalised invite. We deliberately do NOT text on the member's
 * behalf by default: an invite that arrives from their own number lands better
 * and needs no consent gymnastics. The response carries ready-to-use sms:,
 * WhatsApp and share payloads; if an SMS provider is configured the caller can
 * opt into `send: true`.
 */
async function refInvite(env, req) {
  const b = await body(req);
  const code = String(b.code || '').trim().toUpperCase();
  if (!code) return json({ error: 'code required' }, 400);
  const owner = await env.DB.prepare('SELECT code, owner_id, active FROM num_referral_codes WHERE code=?1').bind(code).first();
  if (!owner || !owner.active) return json({ error: 'unknown or inactive code' }, 404);

  const token = friendlyCode(10).toLowerCase();
  const toPhone = normalisePhone(b.to_phone);
  const toName = b.to_name ? String(b.to_name).slice(0, 60) : null;
  const senderName = b.sender_name ? String(b.sender_name).slice(0, 60) : null;
  const link = `${APP.replace('num-app', 'num-claim')}/r/${token}`;

  const message =
    String(b.message || '').slice(0, 300) ||
    `${toName ? toName + ' — ' : ''}it's ${senderName || 'me'}. I use NUM as my concierge: one thread books dinner, cars, tables, everything. Here's my invite${b.reward ? ` (we both get ${b.reward})` : ''}: ${link}`;

  await env.DB.prepare(
    `INSERT INTO num_invite_links (token, code, sender_id, sender_name, to_phone, to_name, message, channel)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  ).bind(token, code, owner.owner_id, senderName, toPhone, toName, message, b.channel ?? 'share').run();

  let sent = null;
  if (b.send === true && toPhone) {
    const out = await sendCode(env, { channel: 'sms', to: toPhone, code: '', businessName: '' });
    sent = out.ok ? 'sms' : `unavailable:${out.error}`;
    if (out.ok) await env.DB.prepare("UPDATE num_invite_links SET sent_at=datetime('now') WHERE token=?1").bind(token).run();
  }

  return json({
    token,
    link,
    message,
    // Send-from-your-own-phone payloads: work today, no provider, no consent risk.
    sms_url: toPhone ? `sms:${toPhone}?&body=${encodeURIComponent(message)}` : `sms:?&body=${encodeURIComponent(message)}`,
    whatsapp_url: `https://wa.me/${toPhone ? toPhone.replace(/\D/g, '') : ''}?text=${encodeURIComponent(message)}`,
    share: { title: 'Join me on NUM', text: message, url: link },
    sent,
  });
}

async function invitedOpen(env, token) {
  const row = await env.DB.prepare('SELECT token, code FROM num_invite_links WHERE token=?1').bind(token).first();
  if (!row) return new Response(null, { status: 302, headers: { Location: APP } });
  await env.DB.prepare("UPDATE num_invite_links SET opened_at=COALESCE(opened_at, datetime('now')) WHERE token=?1")
    .bind(token).run();
  // Land on the install page, not straight in the app. An invite goes to
  // somebody who by definition does not have Num yet, and dropping them into a
  // browser tab means they never put it on their home screen. The page carries
  // ref and i straight through to its own "Open Num" button, so an existing
  // user is one tap away and a new one is told what to do.
  return new Response(null, {
    status: 302,
    headers: { Location: `https://itsnum.com/app?ref=${row.code}&i=${token}`, 'Cache-Control': 'no-store' },
  });
}

/** Attribute a signup, honouring the code's fraud caps. */
async function refSignup(env, req) {
  const b = await body(req);
  const token = b.token ? String(b.token) : null;
  let code = b.code ? String(b.code).toUpperCase() : null;
  const signupId = String(b.signup_id || '').trim();
  if (!signupId) return json({ error: 'signup_id required' }, 400);

  if (token && !code) {
    const row = await env.DB.prepare('SELECT code FROM num_invite_links WHERE token=?1').bind(token).first();
    code = row?.code ?? null;
  }
  if (!code) return json({ error: 'no referral to attribute' }, 400);

  const rc = await env.DB.prepare('SELECT * FROM num_referral_codes WHERE code=?1').bind(code).first();
  if (!rc || !rc.active) return json({ error: 'unknown or inactive code' }, 404);

  // Self-referral and repeat-attribution are the two cheapest frauds; block both.
  if (rc.owner_id === signupId) return json({ error: 'self-referral' }, 400);
  const dupe = await env.DB.prepare('SELECT 1 FROM num_referral_conversions WHERE member_ref=?1').bind(signupId).first();
  if (dupe) return json({ ok: true, already: true });

  const used = await env.DB.prepare('SELECT COUNT(*) n FROM num_referral_conversions WHERE code=?1').bind(code).first();
  if (rc.max_conversions != null && (used?.n ?? 0) >= rc.max_conversions) {
    return json({ ok: false, error: 'This code has reached its limit.' }, 409);
  }

  // Matches the existing STRICT schema: explicit id, member_ref, reward_status.
  // `verified` stays 0 until the referee actually activates — rewards are
  // granted on verified conversions, never on a bare signup.
  await env.DB.prepare(
    `INSERT INTO num_referral_conversions (id, code, member_ref, verified, reward_cs, reward_status, created_at)
     VALUES (?1,?2,?3,0,?4,'pending',unixepoch())`,
  ).bind(uid('rcv'), code, signupId, rc.reward_cs).run();

  if (token) {
    await env.DB.prepare("UPDATE num_invite_links SET signed_up_at=datetime('now'), signup_id=?2 WHERE token=?1")
      .bind(token, signupId).run();
  }
  return json({ ok: true, code, reward_cs: rc.reward_cs, reward_referee_cs: rc.reward_referee_cs });
}

async function refStats(env, url) {
  const code = (url.searchParams.get('code') || '').toUpperCase();
  if (!code) return json({ error: 'code required' }, 400);
  const rc = await env.DB.prepare('SELECT code, owner_id, owner_type, reward_cs, max_conversions FROM num_referral_codes WHERE code=?1')
    .bind(code).first();
  if (!rc) return json({ error: 'unknown code' }, 404);

  const invites = await env.DB.prepare(
    `SELECT COUNT(*) sent, SUM(opened_at IS NOT NULL) opened, SUM(signed_up_at IS NOT NULL) joined
       FROM num_invite_links WHERE code=?1`,
  ).bind(code).first();
  const conv = await env.DB.prepare(
    "SELECT COUNT(*) n, COALESCE(SUM(reward_cs),0) earned FROM num_referral_conversions WHERE code=?1",
  ).bind(code).first();
  const { results: recent } = await env.DB.prepare(
    `SELECT to_name, to_phone, opened_at, signed_up_at, created_at
       FROM num_invite_links WHERE code=?1 ORDER BY created_at DESC LIMIT 20`,
  ).bind(code).all();

  return json({
    code: rc.code,
    owner_type: rc.owner_type,
    invites_sent: invites?.sent ?? 0,
    opened: invites?.opened ?? 0,
    joined: invites?.joined ?? 0,
    conversions: conv?.n ?? 0,
    earned_cs: conv?.earned ?? 0,
    cap: rc.max_conversions,
    // Phone numbers are the invitee's, not the sender's — mask them.
    recent: (recent ?? []).map((r) => ({ ...r, to_phone: maskPhone(r.to_phone) })),
  });
}

async function leaderboard(env, url) {
  const uni = url.searchParams.get('university');
  const { results } = await env.DB.prepare(
    `SELECT c.code, c.owner_id, c.owner_type, COUNT(v.code) joined
       FROM num_referral_codes c LEFT JOIN num_referral_conversions v ON v.code = c.code
      WHERE c.active=1 ${uni ? 'AND c.university_id = ?1' : ''}
      GROUP BY c.code ORDER BY joined DESC, c.created_at ASC LIMIT 25`,
  ).bind(...(uni ? [uni] : [])).all();
  return json({ leaderboard: results ?? [] });
}

// ── router ────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (p.startsWith('/r/')) return await invitedOpen(env, p.slice(3));

      if (p === '/claim/lookup' && request.method === 'GET') return await lookup(env, url);
      if (p === '/claim/start' && request.method === 'POST') return await start(env, request);
      if (p === '/claim/send' && request.method === 'POST') return await send(env, request);
      if (p === '/claim/verify' && request.method === 'POST') return await verify(env, request);
      if (p === '/claim/evidence' && request.method === 'POST') return await evidence(env, request);
      if (p === '/claim/status' && request.method === 'GET') return await status(env, url);

      if (p === '/admin/claims' && request.method === 'GET') return await adminClaims(env, request, url);
      if (p === '/admin/decide' && request.method === 'POST') return await adminDecide(env, request);

      if (p === '/ref/code' && request.method === 'POST') return await refCode(env, request);
      if (p === '/ref/invite' && request.method === 'POST') return await refInvite(env, request);
      if (p === '/ref/signup' && request.method === 'POST') return await refSignup(env, request);
      if (p === '/ref/stats' && request.method === 'GET') return await refStats(env, url);
      if (p === '/ref/leaderboard' && request.method === 'GET') return await leaderboard(env, url);

      if (p === '/') return json({ ok: true, service: 'num-claim' });
      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error('[num-claim]', err?.stack || err);
      return json({ error: 'server error' }, 500);
    }
  },
};
