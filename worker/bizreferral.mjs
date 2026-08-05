// Refer a business, earn 2% of every booking Num sends it — for as long as it
// stays on Num.
//
// The growth loop: a guest asks the bar "are you on Num?", the bar isn't, the
// guest refers it, and once it joins the guest earns from every booking Num
// puts through its door. Every user becomes a salesperson at zero CAC, and it
// is the cheapest way to fill a new city.
//
// ── The promises this makes, stated plainly ──────────────────────────────
//
// An ongoing revenue share is a real financial obligation, so this file is
// deliberately conservative about it. Note the basis: BOOKINGS THROUGH NUM,
// not the merchant's whole till — the referrer is paid out of business we
// demonstrably created, which keeps the cost proportional to the value.
//
//   · The rate is CONFIGURED (`BIZ_REFERRAL_PCT`), never hardcoded, and is
//     recorded ON THE REFERRAL ROW at the moment it is created. Changing the
//     rate later must not silently rewrite what someone was promised — that is
//     the difference between a business decision and a broken promise.
//   · Nothing is earned at referral time. A referral is a CLAIM. It earns only
//     when a booking at that business is actually paid, and only while the
//     business stays on Num.
//   · Attribution is FIRST-CLAIM-WINS and one referrer per business, forever.
//     Without that rule two people eventually claim the same restaurant and
//     both believe they are owed.
//   · Self-referral is blocked, and so is referring a business already on Num.
//     Paying for a customer we already had is not growth, it is leakage.
//
// Earnings land as EARNED Stars, which means they inherit the cash-out path in
// cashout.mjs (earned is cashable, purchased is not). One economy, one rule.
import { notify } from './push.mjs';
import { isAdmin } from './console.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

/**
 * 2% of what a referred business earns THROUGH BOOKINGS Num sends them.
 *
 * "Referred and booked" is the tighter, better promise: the referrer is paid
 * out of business we demonstrably created, not out of the merchant's till.
 * That keeps the obligation proportional to value delivered, and it means the
 * cost of the programme scales with revenue rather than with signups.
 *
 * Override with BIZ_REFERRAL_PCT. Whatever is set here is copied onto each
 * referral row at claim time and never re-read for that row.
 */
const DEFAULT_PCT = 2;
const rate = (env) => {
  const n = Number(env.BIZ_REFERRAL_PCT ?? DEFAULT_PCT);
  // A nonsense rate is a business risk, not a rounding error — clamp hard.
  return Number.isFinite(n) && n > 0 && n <= 50 ? n : DEFAULT_PCT;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_biz_referrals (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  biz_name TEXT NOT NULL,
  biz_key TEXT NOT NULL,
  city TEXT, contact TEXT, note TEXT,
  business_id TEXT,
  -- The rate PROMISED at claim time. Never read the live config for an
  -- existing referral: people are owed what they were told, not what we
  -- decided later.
  pct REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'claimed',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  lifetime_stars INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_biz_ref_key ON num_biz_referrals(biz_key);
CREATE INDEX IF NOT EXISTS idx_biz_ref_referrer ON num_biz_referrals(referrer_id, state);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/**
 * One business, one key. "Joe's Bar", "joes bar" and "JOES BAR  " are the same
 * place, and if they are not, two people get paid for one customer.
 */
export const bizKey = (name, city) =>
  `${String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${String(city ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;

/**
 * Credit a referrer when a booking at their business is paid.
 *
 * Call this from the BOOKING settlement path, not from generic merchant
 * revenue — the promise is a share of business Num sent them. `ref` must be
 * unique per booking; it is what makes a retried webhook idempotent.
 */
export async function creditBizReferral(env, { businessId, stars, ref }) {
  await ensure(env);
  if (!businessId || !(stars > 0) || !ref) return { credited: 0 };

  const row = await env.DB.prepare(
    "SELECT id, referrer_id, pct FROM num_biz_referrals WHERE business_id = ?1 AND state = 'active'",
  ).bind(businessId).first().catch(() => null);
  if (!row) return { credited: 0 };

  const cut = Math.floor((Number(stars) * Number(row.pct)) / 100);
  if (cut < 1) return { credited: 0 };

  // Idempotent on the caller's ref — a retried webhook must not pay twice.
  const moveId = `bizref:${ref}`;
  const already = await env.DB.prepare('SELECT id FROM num_star_moves WHERE id = ?1').bind(moveId).first().catch(() => null);
  if (already) return { credited: 0, duplicate: true };

  await env.DB.prepare('INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?1, 0)').bind(row.referrer_id).run();
  await env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(row.referrer_id, cut).run();
  // Kind 'referral' is in cashout.mjs EARNED_KINDS — this is money they worked
  // for, so it is cashable like any other earning.
  await env.DB.prepare(
    "INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'referral',?4,?5)",
  ).bind(moveId, row.referrer_id, cut, `${row.pct}% of a booking at a place you brought in`, businessId).run();
  await env.DB.prepare('UPDATE num_biz_referrals SET lifetime_stars = lifetime_stars + ?2 WHERE id = ?1')
    .bind(row.id, cut).run();

  await notify(env, {
    memberId: row.referrer_id,
    kind: 'referral',
    title: `You earned ★${cut}`,
    body: 'A place you brought to Num just took a booking — your share is in your wallet.',
    url: '/?app',
    tag: `bizref:${row.id}`,
  }).catch(() => {});

  return { credited: cut };
}

/**
 * Activation from the VERIFIED-CLAIM path — the missing link in the chain.
 *
 * Before this, a referral only ever activated if an admin manually called
 * /activate with two ids fished out of the database. So the loop we sold —
 * "refer a place, earn when they join" — was a promise with no mechanism:
 * the business could onboard, the referrer's claim would sit in 'claimed'
 * forever, and nobody would ever know the two rows were about the same
 * restaurant.
 *
 * This is safe where the public /activate endpoint was not, because the
 * trigger is a business PROVING ownership through the claim loop — not
 * anyone naming a business id. The one check that matters: the person who
 * verified the listing must not be the referrer, because "you can't refer
 * your own business" is a rule about money, and rules about money hold on
 * every path or on none.
 */
export async function activateByKey(env, { name, city, businessId, ownerMemberId }) {
  const key = bizKey(name, city);
  // Try dest-qualified first, then city-less — people claim "Baan Rim Pa"
  // without typing "Phuket", and an unmatched referral pays nobody.
  const row = await env.DB.prepare(
    "SELECT id, referrer_id, biz_name, pct FROM num_biz_referrals WHERE state='claimed' AND (biz_key = ?1 OR biz_key = ?2) LIMIT 1",
  ).bind(key, bizKey(name, '')).first().catch(() => null);
  if (!row) return { matched: false };
  if (row.referrer_id === ownerMemberId) return { matched: false, self: true };

  const r = await env.DB.prepare(
    "UPDATE num_biz_referrals SET state='active', business_id=?2, activated_at=datetime('now') WHERE id=?1 AND state='claimed'",
  ).bind(row.id, businessId).run();
  if (!(r.meta?.changes > 0)) return { matched: false };

  await notify(env, {
    memberId: row.referrer_id,
    kind: 'referral',
    title: `${row.biz_name} joined Num`,
    body: `The place you brought in is live. You now earn ${row.pct}% of every booking Num sends them.`,
    url: '/?app',
    tag: `bizref:${row.id}`,
  }).catch(() => {});
  return { matched: true, referral_id: row.id, referrer_id: row.referrer_id };
}


export async function handleBizReferral(request, env, path) {
  const post = request.method === 'POST';
  const url = new URL(request.url);
  await ensure(env);

  if (path === '/terms' || path === '/' || path === '') {
    return json({
      pct: rate(env),
      earns: 'Stars, cashable like any other earning',
      when: 'Every booking Num sends them — for as long as they stay on Num.',
      basis: 'bookings made through Num',
      rules: [
        'You earn on bookings Num sends them, not on their whole till.',
        'One referrer per business, first claim wins.',
        'You can’t refer a business already on Num.',
        'You can’t refer your own business.',
        'The rate is locked at the moment you claim — later changes don’t affect it.',
      ],
    });
  }

  // Claim a business.
  if (path === '/claim' && post) {
    const b = await request.json().catch(() => ({}));
    const me = clip(b.me, 40);
    const name = clip(b.name, 120)?.trim();
    const city = clip(b.city, 80)?.trim();
    if (!me || !name) return json({ ok: false, error: 'Which place, and where?' }, 400);

    const self = await env.DB.prepare('SELECT id FROM num_members WHERE id=?1').bind(me).first();
    if (!self) return json({ ok: false, error: 'Sign up first.' }, 404);

    const key = bizKey(name, city);

    // Already on Num? Then there is nothing to refer, and saying so is kinder
    // than taking a claim that will never pay.
    const existing = await env.DB.prepare(
      'SELECT id FROM businesses WHERE lower(replace(name, " ", "")) = ?1 LIMIT 1',
    ).bind(String(name).toLowerCase().replace(/\s/g, '')).first().catch(() => null);
    if (existing) {
      return json({ ok: false, error: `${name} is already on Num — no referral to make, but they can serve you today.` }, 409);
    }

    const taken = await env.DB.prepare('SELECT referrer_id FROM num_biz_referrals WHERE biz_key = ?1').bind(key).first();
    if (taken) {
      return json({
        ok: false,
        error: taken.referrer_id === me
          ? `You’ve already claimed ${name}. We’ll tell you the moment they join.`
          : `${name} has already been claimed by someone else.`,
      }, 409);
    }

    const pct = rate(env);
    const id = uid('bref');
    await env.DB.prepare(
      'INSERT INTO num_biz_referrals (id, referrer_id, biz_name, biz_key, city, contact, note, pct) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
    ).bind(id, me, name, key, city, clip(b.contact, 120), clip(b.note, 400), pct).run();

    return json({
      ok: true,
      id,
      pct,
      message: `${name} is yours. If they join Num, you earn ${pct}% of every booking Num sends them — for as long as they stay.`,
    });
  }

  // Mine, with what they've earned.
  if (path === '/mine') {
    const me = clip(url.searchParams.get('me'), 40);
    if (!me) return json({ referrals: [] });
    const { results } = await env.DB.prepare(
      'SELECT id, biz_name, city, state, pct, lifetime_stars, created_at, activated_at FROM num_biz_referrals WHERE referrer_id = ?1 ORDER BY rowid DESC LIMIT 50',
    ).bind(me).all();
    const earned = (results ?? []).reduce((s, r) => s + Number(r.lifetime_stars ?? 0), 0);
    return json({ referrals: results ?? [], lifetime_stars: earned, pct: rate(env) });
  }

  // Admin: a claimed business signed up — link it and start the clock.
  //
  // GATED. This was open to the internet: anyone could claim a business, then
  // activate their own claim against a real business id and start collecting a
  // share of its bookings — as `referral` Stars, which are cashable. Activation
  // decides who gets paid, so it is an admin action, not a public one.
  if (path === '/activate' && post) {
    if (!(await isAdmin(env, request))) return json({ error: 'unauthorized' }, 401);
    const b = await request.json().catch(() => ({}));
    const id = clip(b.id, 40);
    const businessId = clip(b.business_id, 40);
    if (!id || !businessId) return json({ ok: false, error: 'id and business_id required' }, 400);
    const r = await env.DB.prepare(
      "UPDATE num_biz_referrals SET state='active', business_id=?2, activated_at=datetime('now') WHERE id=?1 AND state='claimed'",
    ).bind(id, businessId).run();
    if (!(r.meta?.changes > 0)) return json({ ok: false, error: 'Not found, or already active.' }, 409);

    const row = await env.DB.prepare('SELECT referrer_id, biz_name, pct FROM num_biz_referrals WHERE id=?1').bind(id).first();
    if (row) {
      await notify(env, {
        memberId: row.referrer_id,
        kind: 'referral',
        title: `${row.biz_name} joined Num`,
        body: `The place you brought in is live. You now earn ${row.pct}% of every booking Num sends them.`,
        url: '/?app',
        tag: `bizref:${id}`,
      }).catch(() => {});
    }
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
