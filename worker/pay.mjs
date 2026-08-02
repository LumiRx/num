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
        const packMatch = /^stars:(\d{1,7})$/.exec(ref);
        if (firstTime && packMatch && memberId && env.STARS_SALE_OK === '1') {
          const n = Number(packMatch[1]);
          await env.DB?.prepare('INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?1, 0)').bind(memberId).run().catch(() => {});
          await env.DB?.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(memberId, n).run().catch(() => {});
          await env.DB?.prepare(
            'INSERT INTO num_star_ledger (id, member_id, delta, kind, ref) VALUES (?1,?2,?3,?4,?5)',
          ).bind(`sl_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`, memberId, n, 'purchase', id).run().catch((e) => console.warn('[pay] ledger', e?.message));
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
    return json({ received: true });
  }

  if (path === '/status' || path === '/' || path === '') {
    const mode = payMode(env);
    return json({
      mode,
      can_take_payment: mode !== 'none',
      // Stars-for-cash is a licensing decision, not a feature flag — §8:
      // "Never sell Stars." It stays refused until Duke sets STARS_SALE_OK=1
      // on the record. Bills, tabs, bookings and bounties are unaffected.
      stars_sale: env.STARS_SALE_OK === '1',
      stars: STAR_POLICY,
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

  return json({ error: 'not found' }, 404);
}
