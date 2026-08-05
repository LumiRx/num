// Taking money — the last thing standing between Num and a real booking.
//
// Two modes, because one of them works today and the other needs an account
// that does not exist yet:
//
//   LINKS   A payment link created by hand in the Stripe dashboard, pasted
//           into config here. Num hands it over. No API key, no integration,
//           works this afternoon. The limit is that the amount is fixed at
//           creation, so it only fits things with a known price.
//
//   STRIPE  A Checkout Session minted per request, for the exact amount, with
//           the booking reference attached. Needs a secret key. This is the
//           real one.
//
// The mode is decided by what is configured, not by a flag somebody has to
// remember to flip: a secret key present means sessions, otherwise links,
// and neither present means Num says plainly that it cannot take payment yet
// rather than inventing a checkout that goes nowhere.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
//
// It never sees a card number. Not in a form, not in a log, not in transit.
// Stripe Checkout is a hosted page on Stripe's domain, so the card never
// touches this Worker and PCI scope stays where it belongs. Any design where
// Num collects the digits itself would be a compliance problem wearing a
// feature's clothes — and note that Sabre's own flight check only ever asks
// for a BIN, the first six digits, which is precisely because the full number
// is somebody else's problem on purpose.

import { checkPayment, refusal, STAR_PACKS } from './preflight.mjs';
import { alert } from './health.mjs';

const STRIPE = 'https://api.stripe.com/v1';

/**
 * NUM Stars have TWO POOLS, and the split is the whole design:
 *
 *   EARNED    — from work: errands run, bounties collected, tabs settled your
 *               way. Cashable to 5arz (worker/cashout.mjs). Paying someone for
 *               services they performed is what every platform with a payout
 *               does; it is not money transmission.
 *
 *   PURCHASED — bought with cash. Spends inside Num on errands, tabs and
 *               bookings. NOT cashable, ever. Cash in → cash out is precisely
 *               the money-transmitter shape, and one line of code allowing it
 *               would change what Stars legally are.
 *
 * `cashable()` therefore computes from ORIGIN (num_star_moves.kind), never
 * from the balance. Do not "simplify" it to read the balance — that silently
 * merges the pools and takes the licensing exposure with it.
 *
 * NUM Stars are still NOT the 5arz `stars_ledger`: separate system, separate
 * worker, separate economy. Cash-out is a REQUEST from here that the payout
 * desk settles there. The two ledgers must never be merged.
 */
export const STAR_POLICY = Object.freeze({
  earned_cashable: true,
  purchased_cashable: false,
  cash_out_destination: '5arz',
  spends_on: ['errands', 'tabs', 'bookings', 'bounties'],
  statement: 'Stars you earn can be cashed out. Stars you buy spend inside Num.',
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Hand-made links, keyed by a short name. One JSON var, one paste. */
function links(env) {
  try {
    const p = JSON.parse(env.PAY_LINKS || '{}');
    return p && typeof p === 'object' ? p : {};
  } catch {
    console.warn('[pay] PAY_LINKS is not valid JSON — treating as none');
    return {};
  }
}

export const payMode = (env) => (env.STRIPE_SECRET_KEY ? 'stripe' : Object.keys(links(env)).length ? 'links' : 'none');

/**
 * THE PRICE LIST LIVES IN preflight.mjs, NOT IN THE REQUEST.
 *
 * The first version took `amount_cents` AND `ref` from the client and never
 * checked that they agreed — so `{ref:"stars:5000", amount_cents:100}` bought
 * ★5,000 for a dollar, and the webhook credited it because it reads the Stars
 * count out of `ref`. Verified against production before this fix: a live
 * Stripe session was minted for $1.00.
 *
 * Anything a customer receives must be priced by us. The client may say WHICH
 * pack; it may never say what a pack costs.
 */
// Re-exported so callers and tests have one place to read prices from.
export { STAR_PACKS };

/**
 * Stripe's API is form-encoded, including nested objects, which trips people
 * up because everything else about it looks modern. `a[b]=c` is the shape.
 */
function form(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) out.push(form(v, key));
    else if (Array.isArray(v)) v.forEach((item, i) => out.push(typeof item === 'object' ? form(item, `${key}[${i}]`) : `${key}[${i}]=${encodeURIComponent(item)}`));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

async function stripe(env, path, body, idem) {
  const res = await fetch(`${STRIPE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Stripe's own idempotency, not ours. A retried checkout creation must
      // not leave two sessions for one booking.
      ...(idem ? { 'Idempotency-Key': idem } : {}),
    },
    body: form(body),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(parsed?.error?.message ?? `Stripe ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_payments (
  id TEXT PRIMARY KEY, member_id TEXT, mode TEXT NOT NULL, ref TEXT,
  amount_cents INTEGER, currency TEXT, description TEXT,
  session_id TEXT, url TEXT, state TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_num_payments_member ON num_payments(member_id);
CREATE INDEX IF NOT EXISTS idx_num_payments_ref ON num_payments(ref);
CREATE TABLE IF NOT EXISTS num_star_ledger (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, delta INTEGER NOT NULL,
  kind TEXT NOT NULL, ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_num_star_ledger_member ON num_star_ledger(member_id, created_at);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/**
 * Produce something the traveller can pay with.
 *
 * Returns a URL either way, so every caller has one code path whether this is
 * a hand-made link or a real session. The difference is visible in `mode` for
 * anyone who needs to care — the confirmation copy does, because a fixed link
 * cannot promise the amount matches the booking.
 */
export async function requestPayment(env, { memberId, amountCents, currency = 'usd', description, ref, link, successUrl, cancelUrl }) {
  await ensure(env);
  const mode = payMode(env);
  const id = `pay_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

  if (mode === 'none') {
    return { ok: false, mode, error: 'No payment method is connected yet.' };
  }

  if (mode === 'links') {
    const table = links(env);
    const url = table[link ?? 'default'] ?? Object.values(table)[0];
    if (!url) return { ok: false, mode, error: 'No matching payment link is configured.' };
    await env.DB?.prepare(
      'INSERT INTO num_payments (id, member_id, mode, ref, amount_cents, currency, description, url) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
    ).bind(id, clip(memberId, 40), 'links', clip(ref, 60), amountCents ?? null, currency, clip(description, 200), url).run().catch(() => {});
    return {
      ok: true,
      mode,
      url,
      id,
      // Said plainly because it is true and the copy downstream depends on it:
      // a hand-made link has a price baked in at creation.
      note: 'This is a fixed payment link — check the amount on the Stripe page matches what was quoted.',
    };
  }

  const amount = Math.round(Number(amountCents));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, mode, error: 'A positive amount is required.' };

  const origin = env.NUM_APP_ORIGIN || 'https://app.itsnum.com';
  const session = await stripe(
    env,
    '/checkout/sessions',
    {
      mode: 'payment',
      success_url: successUrl || `${origin}/?paid=${id}`,
      cancel_url: cancelUrl || `${origin}/?app`,
      client_reference_id: id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amount,
            product_data: { name: clip(description, 120) || 'Num booking' },
          },
        },
      ],
      // The reference travels with the money, so a webhook or a dashboard row
      // can be tied back to the thing it paid for without a spreadsheet.
      metadata: { num_payment_id: id, ...(ref ? { num_ref: ref } : {}), ...(memberId ? { num_member: memberId } : {}) },
      // AND on the payment intent. Stripe does NOT copy session metadata to
      // the intent or the charge — so without this, charge.refunded arrives
      // carrying nothing, the refund handler reads undefined, and the whole
      // reclaim path is dead code. Found in self-review, not by a refund —
      // which is the only acceptable way to find it.
      payment_intent_data: {
        metadata: { num_payment_id: id, ...(ref ? { num_ref: ref } : {}), ...(memberId ? { num_member: memberId } : {}) },
      },
    },
    id,
  );

  await env.DB?.prepare(
    'INSERT INTO num_payments (id, member_id, mode, ref, amount_cents, currency, description, session_id, url) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)',
  ).bind(id, clip(memberId, 40), 'stripe', clip(ref, 60), amount, currency, clip(description, 200), session.id, session.url).run().catch(() => {});

  return { ok: true, mode, url: session.url, id, session_id: session.id, amount_cents: amount, currency };
}

// ── Stripe webhook — "paid" is something Stripe signs, not a button press ──
//
// §8 of the CTO handoff: every webhook verifies a signature. Stripe signs
// `t.payload` with the endpoint secret (HMAC-SHA256, hex, in the
// Stripe-Signature header). No secret configured means no webhook — we would
// rather not know than believe a forgery.
async function verifyStripeSig(env, payload, header) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = header.split(',').map((p) => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // replay window
  const enc = (s) => new TextEncoder().encode(s);
  const key = await crypto.subtle.importKey('raw', enc(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.includes(hex);
}

// ── routes ────────────────────────────────────────────────────────────────

export async function handlePay(request, env, path) {
  const post = request.method === 'POST';

  if (path === '/webhook' && post) {
    const payload = await request.text();
    const ok = await verifyStripeSig(env, payload, request.headers.get('Stripe-Signature'));
    if (!ok) {
      console.warn('[pay] webhook rejected — bad or missing signature');
      return json({ error: 'bad signature' }, 400);
    }
    let event = {};
    try { event = JSON.parse(payload); } catch { return json({ error: 'bad payload' }, 400); }
    if (event.type === 'checkout.session.completed') {
      const s = event.data?.object ?? {};
      // `completed` is not `paid`. Async methods (bank debits, vouchers) fire
      // this event while the money is still in flight and can still fail —
      // crediting on the event alone hands out Stars for a payment that may
      // never land.
      if (s.payment_status && s.payment_status !== 'paid') {
        console.warn('[pay] session completed but not paid:', s.payment_status);
        return json({ received: true, ignored: 'unpaid' });
      }
      const id = s.client_reference_id || s.metadata?.num_payment_id;
      if (id) {
        await ensure(env);
        // Idempotent by construction: only a row still in 'created' flips, so
        // Stripe's at-least-once delivery can't credit the same purchase twice.
        const flip = await env.DB?.prepare(
          "UPDATE num_payments SET state='paid', paid_at=datetime('now') WHERE id=?1 AND state<>'paid'",
        ).bind(id).run().catch(() => null);
        const firstTime = (flip?.meta?.changes ?? 0) > 0;
        const memberId = s.metadata?.num_member;

        // DELIVER WHAT WAS BOUGHT. Without this a Stars purchase takes the
        // money and hands over nothing — the reason /request refuses Stars
        // until STARS_SALE_OK is set AND this path exists.
        const ref = s.metadata?.num_ref ?? '';

        // A membership is delivered the same way Stars are: only after Stripe
        // has signed for the money. Never from a client request.
        const tierMatch = /^tier:([a-z_]{2,20})$/.exec(ref);
        if (firstTime && tierMatch && memberId) {
          const { grantTier } = await import('./membership.mjs');
          const g = await grantTier(env, memberId, tierMatch[1], { source: 'stripe', ref: id });
          console.log('[pay] tier', tierMatch[1], g.ok ? 'granted to' : 'FAILED for', memberId);
        }

        const packMatch = /^stars:(\d{1,7})$/.exec(ref);
        if (firstTime && packMatch && memberId && env.STARS_SALE_OK === '1') {
          const n = Number(packMatch[1]);
          await env.DB?.prepare('INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?1, 0)').bind(memberId).run().catch(() => {});
          await env.DB?.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(memberId, n).run().catch(() => {});
          // num_star_moves — the SAME table every other Star movement uses.
          //
          // This wrote to a `num_star_ledger` that nothing else reads: errands,
          // social, cash-out, the console and the wallet history all read
          // num_star_moves. So a purchase left the balance correct and the
          // history blank — the one Star event a person actually paid for was
          // the one they couldn't see, and it was missing from the audit trail
          // too.
          //
          // Kind stays 'purchase', which is deliberately NOT in cashout's
          // EARNED_KINDS. Bought Stars were already un-cashable, but only by
          // accident of being in a table nobody read. Now it's on purpose.
          await env.DB?.prepare(
            "INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'purchase',?4,NULL)",
          ).bind(`sm_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`, memberId, n, `Stripe ${id}`).run().catch((e) => console.warn('[pay] moves', e?.message));
          console.log('[pay] credited', n, 'stars to', memberId, 'for', id);
        }

        if (memberId) {
          const { notify } = await import('./push.mjs');
          await notify(env, {
            memberId,
            kind: 'pay',
            title: 'Payment received',
            body: 'Stripe confirmed it — receipt is on your wallet.',
            url: '/?app',
            tag: `pay:${id}`,
          }).catch(() => {});
        }
      }
    }

    // ── Money that comes BACK ────────────────────────────────────────────
    //
    // Only `checkout.session.completed` was handled, so every payment in the
    // system was in state 'paid' forever. A refunded Star pack left the money
    // returned, the Stars still spendable, and the wallet still showing a
    // receipt — which is both a hole and a lie to the person reading it.
    //
    // Stripe is the source of truth for money, so we take its word for these
    // and write down what happened rather than deciding anything ourselves.
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const c = event.data?.object ?? {};
      const id = c.metadata?.num_payment_id;
      const memberId = c.metadata?.num_member;
      const ref = c.metadata?.num_ref ?? '';
      const disputed = event.type === 'charge.dispute.created';
      const state = disputed ? 'disputed' : 'refunded';

      if (id) {
        await ensure(env);
        // Same idempotence shape as the credit: only a row not already in this
        // state flips, so Stripe's at-least-once delivery can't claw back the
        // same Stars twice.
        const flip = await env.DB?.prepare(
          'UPDATE num_payments SET state=?2 WHERE id=?1 AND state<>?2',
        ).bind(id, state).run().catch(() => null);
        const firstTime = (flip?.meta?.changes ?? 0) > 0;

        const packMatch = /^stars:(\d{1,7})$/.exec(ref);
        if (firstTime && packMatch && memberId) {
          const n = Number(packMatch[1]);
          // Take back what was bought. The balance is allowed to go negative
          // rather than clamping at zero: if someone spent refunded Stars we
          // need to SEE that, not quietly absorb it. A negative balance is a
          // thing a human should look at; a silently-adjusted one is a thing
          // nobody ever finds.
          await env.DB?.prepare('UPDATE num_star_balances SET stars = stars - ?2 WHERE member_id = ?1')
            .bind(memberId, n).run().catch(() => {});
          await env.DB?.prepare(
            "INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'refund',?4,NULL)",
          ).bind(`sm_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`, memberId, -n, `${state} ${id}`)
            .run().catch((e) => console.warn('[pay] refund move', e?.message));
          console.warn('[pay]', state, '— reclaimed', n, 'stars from', memberId, 'for', id);
        }

        // A membership that was refunded should stop being a membership.
        const tierMatch = /^tier:([a-z_]{2,20})$/.exec(ref);
        if (firstTime && tierMatch && memberId) {
          await env.DB?.prepare("UPDATE num_memberships SET tier='free', renews_at=NULL WHERE member_id=?1")
            .bind(memberId).run().catch(() => {});
          console.warn('[pay]', state, '— membership revoked for', memberId);
        }
      }
      // Worth a human's attention either way — a dispute especially.
      await alert(env, `[pay] ${state}: ${id ?? 'unknown payment'} ${ref}`).catch(() => {});
    }

    // A payment that failed should say so, not sit in 'created' looking like
    // something still in flight.
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data?.object ?? {};
      const id = pi.metadata?.num_payment_id;
      if (id) {
        await ensure(env);
        await env.DB?.prepare("UPDATE num_payments SET state='failed' WHERE id=?1 AND state='created'")
          .bind(id).run().catch(() => {});
      }
    }

    return json({ received: true });
  }

  if (path === '/status' || path === '/' || path === '') {
    const mode = payMode(env);
    return json({
      mode,
      can_take_payment: mode !== 'none',
      // TEST or LIVE — the difference between taking money and rehearsing it.
      //
      // `can_take_payment: true` only means a Stripe key is present. With a
      // test key every step still works: a session mints, Checkout renders,
      // the webhook fires, Stars land, the member is delighted — and not one
      // real cent moves. There is no error anywhere to notice, which makes it
      // exactly the failure this codebase keeps producing: a system reporting
      // success while doing nothing. Twilio's wrong SID hid the same way for
      // the product's entire life until its shape was surfaced.
      //
      // Derived from the key prefix, which is not a secret — `sk_test_` vs
      // `sk_live_` is published in Stripe's own docs. The key itself is never
      // read, logged or returned.
      stripe_mode: env.STRIPE_SECRET_KEY
        ? (String(env.STRIPE_SECRET_KEY).startsWith('sk_live_') ? 'live'
          : String(env.STRIPE_SECRET_KEY).startsWith('sk_test_') ? 'test'
          : 'unrecognised-key-prefix')
        : null,
      // A webhook secret is not optional decoration: without it every "paid"
      // event is refused, so checkout completes and nothing is ever granted.
      webhook_configured: !!env.STRIPE_WEBHOOK_SECRET,
      // Stars-for-cash is a licensing decision, not a feature flag — §8:
      // "Never sell Stars." It stays refused until Duke sets STARS_SALE_OK=1
      // on the record. Bills, tabs, bookings and bounties are unaffected.
      stars_sale: env.STARS_SALE_OK === '1',
      stars: STAR_POLICY,
      // The packs, priced HERE. The wallet used to carry its own copy of these
      // numbers, which is the $1-for-★5,000 hole in a different shirt: two
      // sources of truth for a price, and the client's is the one an attacker
      // controls. The client displays what this returns and nothing else.
      packs: Object.entries(STAR_PACKS).map(([stars, cents]) => ({
        stars: Number(stars),
        cents,
        price: `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`,
      })),
      apple_pay: mode === 'stripe' ? 'shown automatically in Stripe Checkout on Apple devices' : 'arrives with the Stripe key',
      configured_links: Object.keys(links(env)),
      note:
        mode === 'stripe'
          ? 'Checkout sessions are minted per request for the exact amount.'
          : mode === 'links'
            ? 'Using fixed payment links. Amounts are set when the link is made, not per booking.'
            : 'Nothing connected. Set STRIPE_SECRET_KEY for real checkout, or PAY_LINKS for hand-made links.',
      // Stated on the status endpoint so it is impossible to miss.
      card_handling: 'Num never sees a card number. Payment happens on Stripe’s own hosted page.',
    });
  }

  if (path === '/request' && post) {
    const b = await readBody(request);

    // EVERY payment is checked before it exists. The verdict recomputes the
    // amount from our own price list, so a client number is a claim to be
    // checked rather than an input to trust — and a wrong one comes back with
    // the corrected transaction attached instead of a bare refusal.
    const verdict = checkPayment(b);
    if (!verdict.ok) return json({ ...refusal(verdict), mode: payMode(env) }, 400);
    b.amount_cents = verdict.amount_cents;
    if (/^stars:/.test(String(b.ref ?? ''))) {
      b.currency = 'usd';
      b.description = `Num — ${verdict.note}`;
    }

    // Closed-loop switch. NUM Stars are credit for NUM and nothing else —
    // see CLOSED_LOOP below. Buying them is therefore a prepaid in-app
    // balance, not a stored-value instrument that can leave the system. It
    // still waits on STARS_SALE_OK so the go/no-go stays a recorded decision.
    if (String(b.ref ?? '').startsWith('stars:') && env.STARS_SALE_OK !== '1') {
      return json({
        ok: false,
        mode: payMode(env),
        error: 'Star top-ups aren’t open yet. You can earn Stars in Num now, and any bill or booking can be paid directly.',
      }, 403);
    }
    try {
      const out = await requestPayment(env, {
        memberId: clip(b.me, 40),
        amountCents: b.amount_cents,
        currency: b.currency ?? 'usd',
        description: clip(b.description, 200),
        ref: clip(b.ref, 60),
        link: clip(b.link, 40),
      });
      return json(out, out.ok ? 200 : 503);
    } catch (err) {
      console.error('[pay]', err?.message ?? err);
      return json({ error: err?.message ?? 'That didn’t go through.' }, err?.status ?? 500);
    }
  }

  if (path === '/history') {
    const url = new URL(request.url);
    const me = clip(url.searchParams.get('me'), 40);
    if (!me || !env.DB) return json({ payments: [] });
    await ensure(env);
    const { results } = await env.DB.prepare(
      'SELECT id, mode, ref, amount_cents, currency, description, state, created_at, paid_at FROM num_payments WHERE member_id=?1 ORDER BY rowid DESC LIMIT 25',
    ).bind(me).all();
    return json({ payments: results ?? [] });
  }

  // ── /activity — everything financial, in one list ──────────────────────
  //
  // Stars and money were two separate stories: /history returned card
  // payments, /social/stars returned Star moves, and the wallet showed
  // neither — it rendered a seeded demo array. So the one screen a person
  // opens to answer "what happened to my money?" answered with fiction.
  //
  // One feed, because that is how the question is actually asked. Nobody
  // wonders "what happened in my Stars ledger" — they wonder what they were
  // charged and what they have left.
  //
  // Server-side labelling on purpose: the client should never have to know
  // that kind 'tab' means a shared bill. If it did, two clients would drift.
  if (path === '/activity') {
    const url = new URL(request.url);
    const me = clip(url.searchParams.get('me'), 40);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 40, 1), 100);
    if (!me || !env.DB) return json({ activity: [] });
    await ensure(env);

    const [moves, pays] = await Promise.all([
      env.DB.prepare(
        `SELECT m.id, m.delta, m.kind, m.note, m.counterparty, m.created_at, p.name AS other_name
           FROM num_star_moves m
           LEFT JOIN num_members p ON p.id = m.counterparty
          WHERE m.member_id = ?1
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?2`,
      ).bind(me, limit).all().catch(() => ({ results: [] })),
      env.DB.prepare(
        `SELECT id, amount_cents, currency, description, state, ref, created_at, paid_at
           FROM num_payments WHERE member_id = ?1
          ORDER BY rowid DESC LIMIT ?2`,
      ).bind(me, limit).all().catch(() => ({ results: [] })),
    ]);

    // What a person would call this, not what the column says.
    const STAR_LABEL = {
      welcome: () => 'Welcome Stars',
      purchase: () => 'Bought Stars',
      refund: () => 'Refunded — Stars returned',
      pay: (r) => `Sent to ${r.other_name ?? 'someone'}`,
      receive: (r) => `From ${r.other_name ?? 'someone'}`,
      tab: (r) => r.note || 'Shared bill',
      errand: (r) => r.note || 'Errand',
      referral: () => 'Referral reward',
      bounty: (r) => r.note || 'Bounty',
      reward: (r) => r.note || 'Reward',
      cashout: () => 'Cashed out',
    };

    const activity = [
      ...(moves.results ?? []).map((r) => ({
        id: r.id,
        at: r.created_at,
        unit: 'stars',
        delta: r.delta,
        title: (STAR_LABEL[r.kind] ?? (() => r.kind))(r),
        detail: r.note && r.note !== (STAR_LABEL[r.kind]?.(r) ?? '') ? r.note : null,
        kind: r.kind,
        state: 'done',
      })),
      ...(pays.results ?? []).map((r) => ({
        id: r.id,
        at: r.paid_at || r.created_at,
        unit: r.currency || 'usd',
        // Money LEAVES you — always negative, so the sign means the same thing
        // in both halves of one list. A mixed feed where +/- flips meaning is
        // worse than two separate lists.
        delta: -Math.abs(r.amount_cents ?? 0),
        title: r.description || 'Payment',
        detail: null,
        kind: /^tier:/.test(r.ref ?? '') ? 'membership' : /^stars:/.test(r.ref ?? '') ? 'topup' : 'payment',
        // 'created' means Stripe never came back — in flight, not complete.
        state: r.state === 'paid' ? 'done' : r.state === 'created' ? 'pending' : r.state,
      })),
    ]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, limit);

    return json({ activity });
  }

  // ── /report — the month, added up ──────────────────────────────────────
  //
  // The activity feed answers "what happened?"; this answers "so where did it
  // all go?" — which is a different question, asked monthly, usually with a
  // slight sense of dread. Totals by kind, per month, straight off
  // num_star_moves and num_payments. Computed at read time from the ledgers,
  // never stored: a stored summary can drift from the rows it summarises, and
  // then you have two answers to one question about money.
  if (path === '/report') {
    const url = new URL(request.url);
    const me = clip(url.searchParams.get('me'), 40);
    // Default: this month. ?month=2026-07 for any other.
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') ?? '')
      ? url.searchParams.get('month')
      : new Date().toISOString().slice(0, 7);
    if (!me || !env.DB) return json({ month, stars: {}, money: {} });
    await ensure(env);

    const [stars, money, balance] = await Promise.all([
      env.DB.prepare(
        `SELECT kind, COUNT(*) n, SUM(delta) net,
                SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) got,
                SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) spent
           FROM num_star_moves
          WHERE member_id = ?1 AND strftime('%Y-%m', created_at) = ?2
          GROUP BY kind`,
      ).bind(me, month).all().catch(() => ({ results: [] })),
      env.DB.prepare(
        `SELECT state, COUNT(*) n, SUM(amount_cents) cents
           FROM num_payments
          WHERE member_id = ?1 AND strftime('%Y-%m', COALESCE(paid_at, created_at)) = ?2
          GROUP BY state`,
      ).bind(me, month).all().catch(() => ({ results: [] })),
      env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1')
        .bind(me).first().catch(() => null),
    ]);

    const sk = Object.fromEntries((stars.results ?? []).map((r) => [r.kind, { count: r.n, net: r.net, in: r.got, out: r.spent }]));
    const mk = Object.fromEntries((money.results ?? []).map((r) => [r.state, { count: r.n, cents: r.cents }]));

    return json({
      month,
      balance: Number(balance?.stars ?? 0),
      stars: {
        by_kind: sk,
        in: Object.values(sk).reduce((a, v) => a + v.in, 0),
        out: Object.values(sk).reduce((a, v) => a + v.out, 0),
      },
      money: {
        by_state: mk,
        // Only 'paid' is money that actually left. Pending isn't spent yet and
        // failed never was — a report that adds those in is lying upward,
        // which is the worse direction for a money report to lie.
        charged_cents: mk.paid?.cents ?? 0,
        refunded_cents: mk.refunded?.cents ?? 0,
      },
    });
  }

  return json({ error: 'not found' }, 404);
}
