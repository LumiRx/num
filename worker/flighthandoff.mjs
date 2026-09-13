/**
 * THE BUTTON AT THE END OF A FARE.
 *
 * ── THE HOLE THIS FILLS ──────────────────────────────────────────────────
 *
 * On 13 Sep 2026 the fares tray showed real, live Sabre prices and offered
 * exactly one action: "IS THIS STILL LIVE?". A traveller who found the
 * flight they wanted had nowhere to go. The footer said so honestly — "Num
 * can price and re-check these — it can't buy the ticket" — which is true
 * and is not a product. It is a dead end with a good explanation attached.
 *
 * Meanwhile the LetsGo2Trip rail, which CAN issue that ticket, only ever
 * appeared as a link in prose when the model happened to notice the person
 * was asking about flights. The two never met: real fares in one box, the
 * only way to buy in a different paragraph, matched by nothing.
 *
 * This route joins them. Given the route a fare is for, it mints the
 * partner link, records the referral, and hands back the one sentence that
 * must be read before anybody taps it.
 *
 * ── IT TURNS ITSELF OFF ──────────────────────────────────────────────────
 *
 * `canIssueFlight(env)` is the single definition of "Num can issue a ticket
 * itself", shared with the concierge prompt and /api/pay/status. The day it
 * flips true, this route stops answering — because sending a traveller out
 * to another company's checkout, and charging them a surcharge for the
 * privilege, is indefensible once we could have finished the job ourselves.
 *
 * Nobody has to remember to turn it off. That is the point of putting the
 * condition here rather than in a deploy note.
 *
 * ── WHY THE FEE IS IN THE RESPONSE AND NOT IN THE CLIENT ─────────────────
 *
 * The surcharge is LetsGo2Trip's, it is configurable, and it is the single
 * most important thing on the screen. A number hardcoded in a React
 * component drifts from `LGT_SURCHARGE_CS` the first time either changes and
 * nobody notices, because the failure is silent and the person who finds out
 * is the traveller at checkout. So the server, which owns the value, is the
 * only thing allowed to say it.
 */
import { canIssueFlight } from './services.mjs';
import { flightLink, lgtReady, newRef, openReferral, surchargeCs } from './letsgo2trip.mjs';

const IATA = /^[A-Za-z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const dollars = (cs) =>
  `$${cs % 100 ? (cs / 100).toFixed(2) : String(cs / 100)}`;

/**
 * Whether this rail should be offered at all, and why not when it should not.
 * Exported so the capability endpoint and the tests read the same answer.
 */
export function handoffAvailable(env) {
  if (canIssueFlight(env ?? {})) {
    return { available: false, why: 'Num can issue this itself — no handoff.' };
  }
  if (!lgtReady(env ?? {})) {
    return { available: false, why: 'No booking partner is configured.' };
  }
  return { available: true };
}

/**
 * The sentence a person must be able to read BEFORE they tap, in the words
 * they would use themselves.
 *
 * Three facts, in the order that matters to somebody about to spend money:
 * who they are buying from, what it costs on top, and that going direct is
 * fine. The prompt version of this (letsgo2trip.surchargeLine) instructs a
 * model; this one is read by a human, so it is short and has no orders in it.
 */
export function disclosure(env) {
  const cs = surchargeCs(env ?? {});
  const who = 'LetsGo2Trip issues the ticket and takes the payment, not Num.';
  if (!cs) return `${who} Booking through this link is how Num gets paid for arranging it.`;
  return (
    `${who} Their checkout adds ${dollars(cs)} on top of this fare for bookings Num sends, `
    + 'and part of that is how Num gets paid. Booking direct with the airline skips it, '
    + 'and that is completely fine.'
  );
}

/** Cents from a fare string, or null. Never throws on the model's idea of a price. */
export function grossCs(price, currency) {
  // Only USD is converted. A EUR fare passed through as if it were dollars
  // would write a wrong commission expectation into the referral ledger,
  // and a wrong number in a money table is worse than no number.
  if (currency && String(currency).toUpperCase() !== 'USD') return null;
  const raw = String(price ?? '');
  // The strip below removes a minus sign along with the currency symbol, so
  // '-5' would arrive as 5 and a negative fare would be recorded as a
  // positive one. Caught by a test, not by a reviewer: reject the sign first.
  if (/-/.test(raw)) return null;
  const n = Number(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export function parseRequest(body) {
  const from = String(body?.fromCode ?? '').trim().toUpperCase();
  const to = String(body?.toCode ?? '').trim().toUpperCase();
  if (!IATA.test(from) || !IATA.test(to)) return { ok: false, error: 'Need a departure and arrival airport.' };
  if (from === to) return { ok: false, error: 'Those are the same airport.' };
  const depart = String(body?.depart ?? '').slice(0, 10);
  if (!DATE.test(depart)) return { ok: false, error: 'Need a departure date.' };
  const ret = String(body?.ret ?? '').slice(0, 10);
  const adultsRaw = Number(body?.adults);
  const adults = Number.isInteger(adultsRaw) && adultsRaw > 0 && adultsRaw <= 9 ? adultsRaw : 1;
  return {
    ok: true,
    from,
    to,
    depart,
    ret: DATE.test(ret) ? ret : null,
    adults,
    gross: grossCs(body?.price, body?.currency),
    memberId: body?.me ? String(body.me).slice(0, 64) : null,
  };
}

export async function handleFlightHandoff(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: { 'content-type': 'application/json' },
    });
  }
  const gate = handoffAvailable(env);
  if (!gate.available) {
    // 200, not 404. The client asks this question to decide whether to draw a
    // button; "no" is a valid answer to a valid question, and an error status
    // would make a correct refusal look like a broken route in the logs.
    return new Response(JSON.stringify({ available: false, why: gate.why }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  const body = await request.json().catch(() => ({}));
  const q = parseRequest(body);
  if (!q.ok) {
    return new Response(JSON.stringify({ error: q.error }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }

  const ref = newRef();
  const link = flightLink(env, {
    ref, origin: q.from, dest: q.to, depart: q.depart, return: q.ret, adults: q.adults,
  });
  if (!link?.url) {
    return new Response(JSON.stringify({ error: 'Could not build the booking link.' }), {
      status: 502, headers: { 'content-type': 'application/json' },
    });
  }

  // Awaited, not fired and forgotten. This row is the only independent record
  // that Num sent this person anywhere — the same reasoning as the concierge
  // rail in index.mjs. It never throws; a bookkeeping failure costs a row,
  // never the link.
  await openReferral(env, {
    ref,
    memberId: q.memberId,
    product: 'flight',
    origin: q.from,
    destination: q.to,
    depart: q.depart,
    return: q.ret,
    adults: q.adults,
    grossCs: q.gross,
  });

  return new Response(JSON.stringify({
    available: true,
    url: link.url,
    ref,
    prefilled: link.prefilled,
    partner: 'LetsGo2Trip',
    fee_cs: surchargeCs(env),
    disclosure: disclosure(env),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
