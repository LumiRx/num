// LetsGo2Trip — flights and stays Num cannot issue itself.
//
// ── WHAT THIS IS ─────────────────────────────────────────────────────────
//
// A referral rail, and only that. Num picks the route and the dates, hands
// over an attributed URL, and LetsGo2Trip does the rest: the fare, the
// passenger form, the 3DS payment, the PNR, the e-ticket, the refund, the
// support desk. Num never says "booked" and never quotes a fare it has not
// been given.
//
// It is worth building despite Num already carrying `sabre_air` and `duffel`,
// because those two rails give Num CONTENT and this one gives Num
// FULFILMENT — ticket issuance, and UAE/GCC card acceptance through Telr.
// Num is Stripe-only and has never completed a payment; a traveller in Dubai
// paying with an AED card is not currently a thing Num can serve at all.
//
// ── THE TWO THINGS THIS FILE REFUSES TO DO ───────────────────────────────
//
// 1. IT WILL NOT HIDE THE SURCHARGE.
//
//    Their deck (p4) prices the example booking $500 base + $15 issuance +
//    $15 concierge fee = $530, and p10 shows where the third line comes from:
//    under partner slug `num`, "Checkout surcharge: +$15 concierge fee
//    enabled". It is a toggle, it is on for Num's traffic specifically, and
//    the customer flow on pages 1–5 never mentions it.
//
//    So a traveller who asks Num for a flight pays more than a traveller who
//    goes to letsgo2trip.com directly. That is a defensible way to be paid —
//    concierges charge fees — and an indefensible way to do it silently,
//    against a product sold on acting for the traveller. Their own homepage
//    also advertises "no third-party markups", which one traveller with two
//    browser tabs will notice.
//
//    Therefore: `surchargeLine()` is not optional and no flag suppresses it.
//    Set LGT_SURCHARGE_CS=0 to remove the fee. There is deliberately no way
//    to keep the fee and drop the sentence — the fee is a commercial choice,
//    the silence is not one Num gets to make.
//
// 2. IT WILL NOT INVENT THE COMMISSION.
//
//    The deck states the flight rate three ways — 1.5% (p6), "+$10" (p4),
//    "$15.00 flat / passenger" (p10) — which on their own $530 example is
//    $7.95, $10.00 and $15.00. Hotels are 6.0% on p6 and 5.0% on p10, and
//    "revenue share" is never defined against gross or against their margin,
//    a 20× difference on the same booking.
//
//    So `expectedFor()` returns null until a human sets LGT_RATE, and the
//    referral row is written with commission_expected_cs NULL rather than a
//    guess. `band()` keeps every stated reading so reconciliation can say
//    "they paid the bottom of their own contract" — which is the whole
//    reason to keep our own ledger at all.

import { appendParams } from './urlparam.mjs';

const BASE = 'https://letsgo2trip.com';

/**
 * Their tracking parameters, verified from the deck's own link builder (p8):
 *
 *   letsgo2trip.com/flights?origin=DXB&dest=LHR
 *     &partner_id=num&utm_campaign=summer_influencer_promo_2026
 *
 * `ref_id` appears on p2's attribution payload. It is the one that matters
 * most to us and the one their ledger (p7) does NOT show — see `REF_ASK`.
 */
export const PARAM = Object.freeze({
  partner: 'partner_id',
  campaign: 'utm_campaign',
  ref: 'ref_id',
});

/**
 * Their attribution rests on a 30-day HTTP-only cookie (p1). That is fine for
 * a web click and no use to Num at all.
 *
 * Num answers inside an app webview, and increasingly over SMS and WhatsApp.
 * In those contexts a cookie is partitioned, ITP-capped, or simply absent —
 * a link pasted into Messages and opened on a different device carries no
 * cookie and never did. A booking Num caused would then be attributed to
 * nobody, and Num would have no way to know it happened.
 *
 * So the ref is generated HERE, recorded HERE, before the traveller leaves.
 * The contract ask that makes it worth anything is that it comes back on
 * every row of their ledger export.
 */
export const REF_ASK =
  'ref_id must appear on every row of the LetsGo2Trip ledger export. '
  + 'Reconciliation runs on our ref, not on their booking reference, because '
  + 'their reference only exists for bookings they already attributed to us.';

export const REF_PREFIX = 'lgt_';

/** A ref Num owns. Short enough for a URL, wide enough not to collide. */
export function newRef(rand = crypto.randomUUID.bind(crypto)) {
  return REF_PREFIX + String(rand()).replace(/-/g, '').slice(0, 16);
}

export const lgtReady = (env) => !!env?.LGT_PARTNER_ID;

/* ── THE RATE, AND WHY THERE ISN'T ONE ───────────────────────────────────
   Every reading stated anywhere in their material, with the page it came
   from, so a disagreement later is a document question rather than a memory
   question. `flat_cs` is cents per booking; `bp` is basis points of gross. */
export const STATED = Object.freeze({
  flight: Object.freeze([
    Object.freeze({ src: 'p6 partner dashboard', says: 'Flights: 1.5%', bp: 150 }),
    Object.freeze({ src: 'p4 profit flow', says: '+$10 Num commission', flat_cs: 1000 }),
    Object.freeze({ src: 'p10 admin rules', says: 'Flight: $15.00 flat / passenger', flat_cs: 1500 }),
  ]),
  stay: Object.freeze([
    Object.freeze({ src: 'p10 admin rules', says: 'Hotel: 5.0% revenue share', bp: 500 }),
    Object.freeze({ src: 'p6 partner dashboard', says: 'Hotels: 6.0% revenue share on completed stays', bp: 600 }),
  ]),
  esim: Object.freeze([Object.freeze({ src: 'p6 partner dashboard', says: 'eSIM: 15%', bp: 1500 })]),
  tour: Object.freeze([Object.freeze({ src: 'p6 partner dashboard', says: 'Tours 10%', bp: 1000 })]),
});

/** One reading applied to one gross amount. */
const apply = (r, grossCs) =>
  (r.flat_cs != null ? r.flat_cs : Math.round((grossCs * r.bp) / 10000));

/**
 * What the deck says we would earn, at its widest.
 *
 * Returns every stated reading priced against this booking, plus the low and
 * the high. A single number here would be a fiction with a decimal point on
 * it; the spread is the actual state of the agreement.
 *
 * @returns {{low:number, high:number, spread:number, readings:Array}|null}
 */
export function band(product, grossCs) {
  const rules = STATED[product];
  if (!rules || !(grossCs > 0)) return null;
  const readings = rules.map((r) => ({ ...r, cs: apply(r, grossCs) }));
  const amounts = readings.map((x) => x.cs);
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  return { low, high, spread: high - low, readings };
}

/**
 * What we actually expect to be paid — null until somebody agrees a rate.
 *
 * LGT_RATE is JSON, one entry per product, in the same shape as STATED:
 *   {"flight":{"flat_cs":1500},"stay":{"bp":600,"basis":"gross"}}
 *
 * Until it is set this returns null and the referral row carries NULL, which
 * is the honest value. Writing a guess would make the first statement
 * reconcile against our own invention.
 */
export function expectedFor(env, product, grossCs) {
  const raw = env?.LGT_RATE;
  if (!raw || !(grossCs > 0)) return null;
  let table;
  try {
    table = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    console.warn('[lgt] LGT_RATE is not valid JSON — expected commission left unknown');
    return null;
  }
  const r = table?.[product];
  if (!r || (r.flat_cs == null && r.bp == null)) return null;
  return apply(r, grossCs);
}

/* ── THE SURCHARGE ───────────────────────────────────────────────────────
   Default $15, from their own p4 breakdown and p10 rule. Configurable to
   zero. NOT configurable to invisible. */
export const DEFAULT_SURCHARGE_CS = 1500;

/**
 * READ THIS BEFORE CHANGING LGT_SURCHARGE_CS.
 *
 * This value is Num's BELIEF ABOUT WHAT THEIR CHECKOUT CHARGES. It is not a
 * switch on the fee. The toggle lives in their admin (p10, "Checkout
 * surcharge: +$15 concierge fee enabled") and only LetsGo2Trip can move it.
 *
 * So setting this to 0 while their toggle is still on does not make the
 * booking cheaper — it makes Num stop disclosing a fee the traveller is
 * still being charged, which is precisely the failure the whole disclosure
 * design exists to prevent, achieved by the one route that looks like
 * turning the fee off.
 *
 * Set it to 0 only after they confirm in writing that the surcharge is
 * disabled for partner slug `num`, and keep the confirmation.
 */
export const surchargeCs = (env) => {
  const v = env?.LGT_SURCHARGE_CS;
  if (v == null || v === '') return DEFAULT_SURCHARGE_CS;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_SURCHARGE_CS;
};

const money = (cs, cur = 'USD') =>
  `${cur === 'USD' ? '$' : ''}${cs % 100 ? (cs / 100).toFixed(2) : cs / 100}`;

/**
 * The sentence the traveller must see before they click.
 *
 * Returns '' only when the fee is genuinely zero. Every prompt block below
 * embeds this, and a test fails the build if one stops doing so.
 */
export function surchargeLine(env) {
  const cs = surchargeCs(env);
  if (!cs) return '';
  return (
    `THE FEE, SAID OUT LOUD: this booking carries a ${money(cs)} Num booking fee on top of the fare — `
    + 'that is how Num gets paid for doing this, and it is the only thing Num takes. Say it plainly in your '
    + 'own words BEFORE they click, never after. Do not bury it, do not call it a service charge, and never '
    + 'let them find it at checkout. If they would rather book direct and skip it, tell them that is fine.'
  );
}

/* ── THE LINKS ───────────────────────────────────────────────────────────
   Verified against their p8 link builder for flights. Their hotel search
   parameters are NOT documented anywhere in the deck, so `stayLink` sends
   the city as a query and claims nothing about being prefilled. An unknown
   parameter is ignored by their app; a prompt that promised a prefilled
   search that did not appear would be a lie we told on their behalf. */

const IATA = /^[A-Za-z]{3}$/;

const pad = (n) => String(n).padStart(2, '0');
export function isoDate(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** appendParams takes PAIRS, not an object — an object silently appends nothing. */
function attribute(url, env, ref) {
  const pairs = [[PARAM.partner, String(env.LGT_PARTNER_ID)]];
  if (env.LGT_CAMPAIGN) pairs.push([PARAM.campaign, String(env.LGT_CAMPAIGN)]);
  pairs.push([PARAM.ref, ref]);
  return appendParams(url, pairs);
}

/**
 * A flight search, prefilled where Num knows the route.
 *
 * Num has no IATA resolver, so `origin` and `dest` arrive as codes from the
 * caller or not at all. Missing codes are NOT an error and NOT a reason to
 * return null: their flights page works perfectly well unprefilled, and a
 * traveller sent to a working search with our ref on it is worth more than
 * silence. What is refused is a malformed code, which would produce a search
 * for nowhere with our marker attached.
 *
 * @returns {{url:string, ref:string, prefilled:boolean}|null}
 */
export function flightLink(env, opts = {}) {
  if (!lgtReady(env)) return null;
  const ref = opts.ref || newRef();
  const q = [];
  const o = String(opts.origin || '').trim().toUpperCase();
  const d = String(opts.dest || '').trim().toUpperCase();
  if (o && !IATA.test(o)) return null;
  if (d && !IATA.test(d)) return null;
  if (o) q.push(['origin', o]);
  if (d) q.push(['dest', d]);
  const out = isoDate(opts.depart);
  const back = isoDate(opts.return);
  if (out) q.push(['depart', out]);
  if (back) q.push(['return', back]);
  const adults = Number(opts.adults);
  if (Number.isInteger(adults) && adults > 0 && adults <= 9) q.push(['adults', String(adults)]);

  return {
    url: attribute(appendParams(`${BASE}/flights`, q), env, ref),
    ref,
    prefilled: !!(o && d),
  };
}

/**
 * A hotel search.
 *
 * `prefilled` is false on purpose even when a city is passed: nothing in the
 * deck documents their hotel query parameters, so Num does not yet know that
 * the city lands. Flip this to true in the same commit that verifies a real
 * hotel URL against their site, and not before.
 */
export function stayLink(env, place, opts = {}) {
  if (!lgtReady(env)) return null;
  const ref = opts.ref || newRef();
  const q = [];
  const city = String(place?.name || place?.dest || '').trim();
  if (city) q.push(['dest', city]);
  const inn = isoDate(opts.checkin);
  const out = isoDate(opts.checkout);
  if (inn) q.push(['checkin', inn]);
  if (out) q.push(['checkout', out]);

  return {
    url: attribute(appendParams(`${BASE}/hotels`, q), env, ref),
    ref,
    prefilled: false,
  };
}

/* ── INTENT ──────────────────────────────────────────────────────────────
   Narrow on purpose. This rail sends somebody to another website and asks
   them to pay a fee; the cost of firing on a turn that was not about booking
   travel is much higher than the cost of staying quiet. */

// `get me to` is deliberately absent: "get me to the airport" is a transfer,
// not a flight, and `flight|fly` already catches every real case.
const FLIGHT_RE = /\b(flight|flights|fly|flying|airfare|air fare|plane ticket|plane tickets|one[- ]way|return ticket|cheapest way to fly)\b/i;

// The bare noun `hotel` used to be enough here, and "a quiet bar near the
// hotel" tripped it — a request for a drink answered with a booking link and
// a $15 fee disclosure. A stay needs asking FOR one, not mentioning one.
const STAY_RE = /\b(?:(?:need|want|find|book|get|looking for|recommend|suggest)\b[^.?!]{0,30}\b(?:hotel|room|beds?|accommodation)|hotels? in\b|somewhere to stay|place to stay|places to stay|accommodation in\b|book a room|a room for|nights? in\b)/i;

export const wantsFlight = (t) => FLIGHT_RE.test(String(t || ''));
export const wantsStay = (t) => STAY_RE.test(String(t || ''));

/* ── THE PROMPT BLOCKS ───────────────────────────────────────────────────
   Every one of these embeds `surchargeLine`. `charter.mjs` catches the
   phrases Num must never repeat from their material; this is the other half —
   the thing Num must always say. */

const NEVER =
  'NEVER call this "verified direct inventory" or repeat any claim about markups. You cannot see their '
  + 'cost base or their supplier, and asserting something you cannot check is how a good answer becomes a '
  + 'false statement. Say who sells it: LetsGo2Trip ticket it and support it.';

const CANNOT =
  'You CANNOT see fares, seats or availability through this and you cannot book it. Never quote a price as '
  + 'though you had looked it up. If they want a number, give the honest band and say the link has the live ones.';

/**
 * LAST RESORT, AND IT HAS TO READ LIKE ONE.
 *
 * This rail sends somebody OUT OF THE APP to a checkout that charges them a
 * fee. That is worth doing when the alternative is "I can't help you buy
 * this", and it is worth nothing at all when Num could have finished the job
 * itself — a concierge that hands you a link to somebody else's website is a
 * search engine with better manners.
 *
 * So the wording leads with what Num already did, offers the handoff as the
 * one remaining step rather than as the answer, and says out loud that they
 * are leaving. `index.mjs` will not even build this block while
 * `canIssueFlight(env)` is true.
 */
export function flightBlock(link, env, route = {}) {
  if (!link?.url) return '';
  const where = route.origin && route.dest ? `${route.origin} → ${route.dest}` : 'the route they asked for';
  return (
    '\n\nFLIGHTS — THE LAST STEP ONLY. Num cannot issue a ticket today, so do the whole job first: work out the '
    + 'route, the timing and what it is worth paying for, and give them that properly. Only when they actually want '
    + 'to buy it, offer the handoff — as a step, not as the answer.\n'
    + `LetsGo2Trip can issue this one: they take the payment, send the e-ticket, hold the PNR, and they accept UAE `
    + `and GCC cards. The link is ${link.url} and it opens `
    + `${link.prefilled ? `a search set to ${where}` : 'their flight search'}.\n`
    + 'Say plainly that it leaves Num and lands on another company\'s site, and that they are buying from '
    + 'LetsGo2Trip rather than from us. Never lead with the link, never send it unasked, and if they would '
    + `rather book it themselves elsewhere say that is completely fine.\n${CANNOT}\n${NEVER}\n${surchargeLine(env)}`
  ).trimEnd();
}

export function stayBlock(link, env, place) {
  if (!link?.url) return '';
  return (
    `\n\nSTAYS — THE LAST STEP ONLY. Answer the question first: which area, which room, why that one${
      place?.name ? ` in ${place.name}` : ''}. Offer the handoff only when they want to book, and only if Num `
    + 'has no better route.\n'
    + `LetsGo2Trip confirms the room — the link is ${link.url}. Do not say it is prefilled; say it opens their `
    + 'hotel search, and say it leaves Num for another company\'s site.\n'
    + `${CANNOT}\n${NEVER}\n${surchargeLine(env)}`
  ).trimEnd();
}

/* ── OUR SIDE OF THE LEDGER ──────────────────────────────────────────────
   Their ledger (p7) is the only account of what is owed, it cannot be audited
   from outside, and cancelled bookings "can show $0.00 earned" with no reason
   attached. Without an independent count of what Num sent there is no way to
   tell a 9% conversion rate from a broken attribution cookie.

   `num_travel_referrals` already carries `commission_expected_cs` and
   `commission_received_cs` as separate columns. It was built for exactly this
   reconciliation and has never held a row. */

/**
 * Open a referral at the moment of handoff.
 *
 * Never throws. This runs AFTER the URL has been decided and cannot change
 * it: a bookkeeping failure must not cost somebody their answer, and it must
 * not cost them their link either.
 *
 * `state` is 'sent' rather than 'draft' because the handoff has happened —
 * draft would mean Num prepared something it never gave anybody.
 */
export async function openReferral(env, r = {}) {
  if (!env?.DB || !r.ref) return { opened: false };
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO num_travel_referrals
         (id, ref, member_id, partner_id, partner_name, product,
          origin, destination, depart_on, return_on, adults,
          state, commission_expected_cs, sent_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'sent',?12,datetime('now'))`,
    ).bind(
      r.ref,
      r.ref,
      String(r.memberId || 'anon'),
      String(env.LGT_PARTNER_ID),
      'LetsGo2Trip',
      r.product === 'stay' ? 'stay' : 'flight',
      r.origin ?? null,
      r.destination ?? null,
      isoDate(r.depart),
      isoDate(r.return),
      Number.isInteger(r.adults) && r.adults > 0 ? r.adults : 1,
      // Null until a rate is agreed. See expectedFor().
      r.grossCs ? expectedFor(env, r.product === 'stay' ? 'stay' : 'flight', r.grossCs) : null,
    ).run();
    return { opened: true, ref: r.ref };
  } catch (e) {
    console.warn('[lgt] referral write failed', e?.message ?? e);
    return { opened: false, error: String(e?.message ?? e) };
  }
}
