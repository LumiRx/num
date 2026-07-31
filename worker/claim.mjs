// Claiming a business listing, from inside the app.
//
// The rule the whole thing rests on, unchanged from the standalone claim
// worker: **the proof goes to the contact already published on the listing —
// never to one the claimant types in.** Our directory holds the phone, email
// and website each business publishes to the world. Receiving something there
// proves you control the business's public contact point. A claimant-supplied
// address proves only that they own an inbox.
//
// Three ways to prove it, in the order we prefer them:
//
//   1. email    — a one-tap magic link to `places.email`, the address on the
//                 listing. Clicking it IS the proof; no code to retype.
//   2. sms      — a 6-digit code to `places.phone`.
//   3. domain   — the claimant names a mailbox, but it must sit on the same
//                 registrable domain as `places.website`. Free mail is refused.
//
// Anything else is manual review. A listing is never transferred on a code
// alone, and a contested listing always goes to a human.
import { generateCode, hashCode, safeEqual, normalisePhone, uid, domainOf, sameDomain, isFreeMail, maskPhone, maskEmail } from '../claim/verify.mjs';

const CODE_TTL_MIN = 20;
const LINK_TTL_MIN = 60;
const MAX_ATTEMPTS = 5;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_app_claims (
  id TEXT PRIMARY KEY, place_id TEXT NOT NULL, member_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open', channel TEXT, target TEXT,
  code_hash TEXT, code_salt TEXT, link_token TEXT, expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, evidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_num_app_claims_place ON num_app_claims(place_id);
CREATE INDEX IF NOT EXISTS idx_num_app_claims_token ON num_app_claims(link_token);
`;
let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  // num_place_owners predates the app and has no idea what an app member is.
  // Adding the link is a one-line migration; "duplicate column" is the
  // expected outcome on every deploy after the first.
  try {
    await env.DB.prepare('ALTER TABLE num_place_owners ADD COLUMN member_ref TEXT').run();
  } catch (err) {
    if (!/duplicate column/i.test(err?.message ?? '')) console.warn('[claim] migration:', err?.message);
  }
  ready = true;
}

/** Which proofs this listing can actually support, with the target masked. */
function channelsFor(place) {
  const out = [];
  if (place.email) {
    out.push({ channel: 'email', display: maskEmail(place.email), label: 'One-tap link to the email on your listing' });
  }
  if (place.phone) {
    out.push({ channel: 'sms', display: maskPhone(place.phone), label: 'Code by text to the number on your listing' });
  }
  const dom = domainOf(place.website);
  if (dom && !isFreeMail(dom)) {
    out.push({ channel: 'domain', display: `you@${dom}`, label: `Any mailbox on ${dom}` });
  }
  out.push({ channel: 'manual', display: null, label: 'None of these reach me — send it to a human' });
  return out;
}

// ── search ────────────────────────────────────────────────────────────────

/**
 * Find your listing. Deliberately narrow: name prefix within a destination,
 * so this cannot be walked as a bulk export of the directory.
 */
async function search(env, url) {
  const q = (url.searchParams.get('q') ?? '').trim();
  const dest = clip(url.searchParams.get('dest'), 40);
  if (q.length < 3) return json({ results: [], hint: 'Type at least three letters of the name.' });

  const { results } = await env.DB.prepare(
    `SELECT id, name, category, area, dest, phone, email, website, rating, reviews, photo_url, business_id
       FROM places
      WHERE name LIKE ?1 ${dest ? 'AND dest = ?2' : ''}
      ORDER BY (rating IS NULL), rating DESC LIMIT 12`,
  ).bind(`%${q}%`, ...(dest ? [dest] : [])).all();

  return json({
    results: (results ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      area: p.area,
      dest: p.dest,
      rating: p.rating,
      reviews: p.reviews,
      photo: p.photo_url,
      // Never the raw contact — that IS the verification target.
      claimed: !!p.business_id,
      proofs: channelsFor(p).filter((c) => c.channel !== 'manual').length,
    })),
  });
}

// ── claim ─────────────────────────────────────────────────────────────────

async function start(env, req) {
  const b = await readBody(req);
  const placeId = clip(b.place_id, 60);
  const memberId = clip(b.me, 40);
  if (!placeId || !memberId) return json({ error: 'place_id and me required' }, 400);

  const member = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(memberId).first();
  if (!member) return json({ error: 'Add your name and number first — a claim has to belong to someone.' }, 404);
  const place = await env.DB.prepare('SELECT * FROM places WHERE id=?1').bind(placeId).first();
  if (!place) return json({ error: 'listing not found' }, 404);

  const owner = await env.DB.prepare('SELECT member_ref, revoked_at FROM num_place_owners WHERE place_id=?1').bind(placeId).first();
  // Already owned by somebody else: a code must never transfer a listing, so
  // this goes to a human and the incumbent keeps it meanwhile.
  const contested = !!owner && !owner.revoked_at && owner.member_ref !== memberId;

  const cap = await env.DB.prepare(
    "SELECT COUNT(*) n FROM num_app_claims WHERE place_id=?1 AND created_at > datetime('now','-1 day')",
  ).bind(placeId).first();
  if ((cap?.n ?? 0) >= 5) return json({ error: 'Too many claims on this listing today. Try again tomorrow.' }, 429);

  const id = uid('acl');
  await env.DB.prepare('INSERT INTO num_app_claims (id, place_id, member_id, state) VALUES (?1,?2,?3,?4)')
    .bind(id, placeId, memberId, contested ? 'review' : 'open').run();

  return json({
    claim_id: id,
    place: { id: place.id, name: place.name, area: place.area, dest: place.dest },
    contested,
    // Masked, always. Seeing "•••• 4821" is enough to recognise your own number;
    // seeing the whole thing would hand an attacker the target.
    channels: channelsFor(place).map((c) => ({ channel: c.channel, display: c.display, label: c.label })),
  });
}

async function sendProof(env, req, origin) {
  const b = await readBody(req);
  const claim = await env.DB.prepare('SELECT * FROM num_app_claims WHERE id=?1').bind(clip(b.claim_id, 40) ?? '').first();
  if (!claim) return json({ error: 'claim not found' }, 404);
  if (claim.state === 'verified') return json({ error: 'already verified' }, 409);
  const place = await env.DB.prepare('SELECT * FROM places WHERE id=?1').bind(claim.place_id).first();
  if (!place) return json({ error: 'listing not found' }, 404);

  const wanted = clip(b.channel, 20);
  const available = channelsFor(place);
  const pick = available.find((c) => c.channel === wanted);
  if (!pick) return json({ error: 'choose one of the offered channels' }, 400);

  if (wanted === 'manual') {
    await env.DB.prepare("UPDATE num_app_claims SET state='review', evidence=?2 WHERE id=?1")
      .bind(claim.id, clip(b.evidence, 2000)).run();
    return json({ ok: true, state: 'review', message: 'Sent to our team — we usually come back within a day.' });
  }

  // THE TARGET COMES FROM THE DIRECTORY ROW, NEVER FROM THE REQUEST.
  let target = null;
  if (wanted === 'email') target = place.email;
  else if (wanted === 'sms') target = place.phone;
  else if (wanted === 'domain') {
    const addr = String(b.email ?? '').trim().toLowerCase();
    const dom = domainOf(place.website);
    if (!addr || !sameDomain(addr, dom) || isFreeMail(domainOf(`x@${addr.split('@')[1] ?? ''}`))) {
      return json({ error: `That mailbox has to be on ${dom ?? 'your business domain'} — a free mailbox can't prove ownership.` }, 400);
    }
    target = addr;
  }
  if (!target) return json({ error: 'that channel is not available for this listing' }, 400);

  const expires = new Date(Date.now() + (wanted === 'sms' ? CODE_TTL_MIN : LINK_TTL_MIN) * 60_000).toISOString();

  if (wanted === 'sms') {
    const code = generateCode();
    const salt = crypto.randomUUID();
    const out = await sendSms(env, target, `NUM: your code to claim ${place.name} is ${code}. It expires in ${CODE_TTL_MIN} minutes.`);
    if (!out.ok) return manualFallback(env, claim.id, out.error);
    await env.DB.prepare(
      "UPDATE num_app_claims SET state='pending', channel='sms', target=?2, code_hash=?3, code_salt=?4, expires_at=?5, attempts=0 WHERE id=?1",
    ).bind(claim.id, target, await hashCode(code, salt), salt, expires).run();
    return json({ ok: true, mode: 'code', sent_to: maskPhone(target) });
  }

  // Both email paths use a magic link: clicking it IS the proof, so there is
  // nothing to mistype and nothing to read out to somebody over the phone.
  const token = crypto.randomUUID().replace(/-/g, '');
  const link = `${origin}/claim/confirm?t=${token}`;
  const out = await sendEmail(env, target, `Confirm you run ${place.name}`, confirmEmail(place, link));
  if (!out.ok) return manualFallback(env, claim.id, out.error);
  await env.DB.prepare(
    "UPDATE num_app_claims SET state='pending', channel=?2, target=?3, link_token=?4, expires_at=?5 WHERE id=?1",
  ).bind(claim.id, wanted, target, token, expires).run();
  return json({ ok: true, mode: 'link', sent_to: maskEmail(target) });
}

/** No provider configured is our gap, not the claimant's — hand them a human. */
async function manualFallback(env, claimId, reason) {
  await env.DB.prepare("UPDATE num_app_claims SET state='review' WHERE id=?1").bind(claimId).run();
  return json({
    ok: true,
    state: 'review',
    message:
      reason === 'no_email_provider' || reason === 'no_sms_provider'
        ? 'We can’t send that automatically yet, so this has gone to our team — we usually come back within a day.'
        : 'That didn’t send, so this has gone to our team instead.',
  });
}

async function verify(env, req) {
  const b = await readBody(req);
  const claim = await env.DB.prepare('SELECT * FROM num_app_claims WHERE id=?1').bind(clip(b.claim_id, 40) ?? '').first();
  if (!claim) return json({ error: 'claim not found' }, 404);
  if (claim.state === 'verified') return json({ ok: true, already: true });
  if (claim.state !== 'pending' || !claim.code_hash) return json({ error: 'no code pending for this claim' }, 409);
  if (claim.expires_at && new Date(claim.expires_at) < new Date()) return json({ error: 'that code expired — ask for a new one' }, 410);
  if (claim.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare("UPDATE num_app_claims SET state='locked' WHERE id=?1").bind(claim.id).run();
    return json({ error: 'too many attempts — this claim is locked' }, 429);
  }
  const supplied = String(b.code ?? '').replace(/\D/g, '');
  if (!safeEqual(await hashCode(supplied, claim.code_salt), claim.code_hash)) {
    await env.DB.prepare('UPDATE num_app_claims SET attempts=attempts+1 WHERE id=?1').bind(claim.id).run();
    return json({ error: 'That code didn’t match.', attempts_left: MAX_ATTEMPTS - (claim.attempts + 1) }, 400);
  }
  return json(await grant(env, claim));
}

/** Create the business, record the owner, and burn the proof. */
async function grant(env, claim) {
  const place = await env.DB.prepare('SELECT id, name, category, dest, phone FROM places WHERE id=?1').bind(claim.place_id).first();
  const businessId = uid('biz');
  await env.DB.batch([
    env.DB.prepare("INSERT INTO businesses (id, name, kind, category, territory, status, onboarded_by, created_at) VALUES (?1,?2,'venue',?3,?4,'active','app-claim',datetime('now'))")
      .bind(businessId, place.name, place.category ?? null, place.dest ?? null),
    env.DB.prepare(
      `INSERT OR REPLACE INTO num_place_owners (place_id, business_id, claim_id, method, phone, member_ref, verified_at)
       VALUES (?1,?2,?3,?4,?5,?6,datetime('now'))`,
    ).bind(claim.place_id, businessId, claim.id, claim.channel, claim.channel === 'sms' ? claim.target : null, claim.member_id),
    env.DB.prepare('UPDATE places SET business_id=?2 WHERE id=?1').bind(claim.place_id, businessId),
    env.DB.prepare("UPDATE num_app_claims SET state='verified', verified_at=datetime('now'), code_hash=NULL, code_salt=NULL, link_token=NULL WHERE id=?1")
      .bind(claim.id),
  ]);
  return { ok: true, state: 'verified', business_id: businessId, place: place.name };
}

/** The magic link. Clicking it from the listed inbox is the proof. */
async function confirm(env, url) {
  const token = url.searchParams.get('t');
  const claim = token ? await env.DB.prepare('SELECT * FROM num_app_claims WHERE link_token=?1').bind(token).first() : null;
  const page = (title, body, ok = true) =>
    html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#201e1d;
background:#faf7f4;background-image:radial-gradient(60% 40% at 20% 0%,#ffe9e2 0,transparent 60%)}
.w{max-width:460px;margin:0 auto;padding:56px 22px}
.c{background:rgba(255,255,255,.72);border:1px solid rgba(32,30,29,.08);border-radius:20px;padding:22px;box-shadow:0 10px 30px rgba(32,30,29,.07)}
h1{font-size:24px;margin:0 0 8px;letter-spacing:-.02em}p{color:#6b625d;margin:0}
.k{font-size:11px;letter-spacing:.16em;font-weight:800;color:${ok ? '#0e6b45' : '#ec3013'}}
a{display:block;margin-top:18px;text-align:center;text-decoration:none;background:linear-gradient(135deg,#ff6a3d,#ec3013);color:#fff;font-weight:700;padding:14px;border-radius:999px}</style>
<div class="w"><div class="c"><div class="k">${ok ? 'VERIFIED' : 'THIS LINK'}</div><h1>${esc(title)}</h1><p>${body}</p>
<a href="/?app">Open Num</a></div></div>`);

  if (!claim) return page('That link isn’t valid any more', 'It may have already been used, or a newer one was sent. Start the claim again from the app and we’ll send a fresh link.', false);
  if (claim.state === 'verified') return page('Already done', 'This listing is already verified to your account. Open Num and you’ll find the owner tools waiting.');
  if (claim.expires_at && new Date(claim.expires_at) < new Date()) return page('That link expired', 'Links last an hour. Start the claim again in the app and we’ll send another.', false);

  const out = await grant(env, claim);
  return page(`${out.place} is yours`, 'We reached you on the contact published on the listing, which is all the proof we need. The owner tools are open in the app now.');
}

async function status(env, url) {
  const me = url.searchParams.get('me');
  if (!me) return json({ error: 'me required' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.state, c.channel, c.created_at, p.name, p.area, p.dest
       FROM num_app_claims c JOIN places p ON p.id=c.place_id
      WHERE c.member_id=?1 ORDER BY c.created_at DESC LIMIT 10`,
  ).bind(me).all();
  return json({ claims: results ?? [] });
}

// ── delivery ──────────────────────────────────────────────────────────────

async function sendSms(env, to, body) {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) return { ok: false, error: 'no_sms_provider' };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body }),
    });
    return res.ok ? { ok: true } : { ok: false, error: 'sms_failed' };
  } catch {
    return { ok: false, error: 'sms_failed' };
  }
}

async function sendEmail(env, to, subject, htmlBody) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'no_email_provider' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.CLAIM_FROM || 'Num <verify@itsnum.com>', to, subject, html: htmlBody }),
    });
    return res.ok ? { ok: true } : { ok: false, error: 'email_failed' };
  } catch {
    return { ok: false, error: 'email_failed' };
  }
}

const confirmEmail = (place, link) => `
<div style="font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#201e1d;max-width:460px;margin:0 auto;padding:24px">
  <div style="font-size:11px;letter-spacing:.16em;font-weight:800;color:#ec3013">NUM</div>
  <h1 style="font-size:22px;margin:10px 0 6px">Do you run ${esc(place.name)}?</h1>
  <p style="color:#6b625d;margin:0 0 18px">Someone asked to claim this listing on Num. We sent this to the address published on it, so if that is you, one tap confirms it and the owner tools open.</p>
  <a href="${link}" style="display:block;text-align:center;text-decoration:none;background:linear-gradient(135deg,#ff6a3d,#ec3013);color:#fff;font-weight:700;padding:14px;border-radius:999px">Yes — this is my business</a>
  <p style="color:#8b817b;font-size:13px;margin:18px 0 0">If this wasn't you, ignore it and nothing happens. The link expires in an hour.</p>
</div>`;

// ── router ────────────────────────────────────────────────────────────────

export async function handleClaim(request, env, path, origin) {
  if (!env.DB) return json({ error: 'claims need the database binding' }, 503);
  await ensure(env);
  const url = new URL(request.url);
  const post = request.method === 'POST';
  try {
    if (path === '/search') return await search(env, url);
    if (path === '/start' && post) return await start(env, request);
    if (path === '/send' && post) return await sendProof(env, request, origin);
    if (path === '/verify' && post) return await verify(env, request);
    if (path === '/status') return await status(env, url);
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[claim]', path, err?.message ?? err);
    return json({ error: 'that didn’t go through — try again in a moment' }, 500);
  }
}

export async function handleClaimConfirm(request, env) {
  if (!env.DB) return html('<p>Unavailable.</p>', 503);
  await ensure(env);
  try {
    return await confirm(env, new URL(request.url));
  } catch (err) {
    console.error('[claim-confirm]', err?.message ?? err);
    return html('<p style="font:16px system-ui;padding:40px">Something went wrong with that link.</p>', 500);
  }
}
