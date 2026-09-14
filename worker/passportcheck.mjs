/**
 * NUM · the six-month rule, for any trip — not only a flight Num sold.
 *
 * ── WHY THIS MOVED OUT OF THE FLIGHT FLOW ────────────────────────────────
 *
 * `passportValidFor` has been right for weeks and has been reachable from
 * exactly one place: the preflight on a flight order. That means Num only
 * catches an expiring passport for somebody who had already chosen a fare,
 * entered a passenger, and got as far as paying.
 *
 * Almost nobody gets turned away at a border. They get turned away at a
 * CHECK-IN DESK, three hours before a flight, by an airline that will be
 * fined if it carries them — which is exactly the moment nothing can be
 * done. The check is worth nothing at the point of sale and worth a whole
 * trip six weeks out.
 *
 * So the rule now fires on any trip with a date, whether the flight came
 * from Num, from LetsGo2Trip, or from a tab open in another window.
 *
 * ── THE EXPIRY DATE NEVER LEAVES THIS WORKER ─────────────────────────────
 *
 * `passport_expires_on` is on PASSENGER_PII_FIELDS, and everything below is
 * built to be read by a model running on somebody else's hardware. So the
 * comparison happens HERE and only the VERDICT travels — 'short', 'expired',
 * 'unknown' — plus `needsUntil`, which is computed from the trip date alone
 * and says nothing about the person.
 *
 * The model does not need the number. It needs to know there is a problem and
 * to say so kindly. The member already knows their own passport, and the app
 * can show them the date locally. A date sent to a model to be read back to
 * the person who supplied it is PII spent for nothing.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────
 *
 * It does not tell anybody they are fine to travel. Six months is the
 * strictest common reading and most destinations apply it, but a handful
 * want three months, a few only the length of stay, and a few — Schengen
 * among them — also cap how OLD the passport may be. Num checks the rule
 * that strands people and points at the government page for the rest. It
 * never says "you're all set", because it cannot see their visa, their
 * purpose, or the airline's own policy.
 *
 * ── AND IT ASKS AT MOST ONCE ─────────────────────────────────────────────
 *
 * num_passengers currently holds zero rows, so for every member alive today
 * the honest answer is "Num does not know". A product that cannot check
 * should ask — once, warmly, when a trip is close enough for the answer to
 * matter and far enough out that a renewal is still possible. Asking every
 * turn is nagging, and nagging is how people stop reading.
 */
import { passportValidFor, PASSPORT_MONTHS_REQUIRED } from './flightbooking.mjs';

/**
 * The window in which asking is a favour rather than an interruption.
 *
 * A renewal takes four to eight weeks in most countries and an expedited one
 * still takes days. Below the floor there is nothing they can do with the
 * answer except panic, so Num warns rather than asks. Above the ceiling the
 * trip is a daydream and the question is intrusive.
 */
export const ASK_FROM_DAYS = 120;
export const ASK_UNTIL_DAYS = 10;

/** Should Num ask for a passport expiry it does not hold? */
export function shouldAsk({ daysOut, destination, asked = false, onFile = false } = {}) {
  if (onFile || asked) return false;
  if (!destination) return false;
  if (!Number.isFinite(daysOut)) return false;
  return daysOut <= ASK_FROM_DAYS && daysOut >= ASK_UNTIL_DAYS;
}

/**
 * Check one passport against one trip.
 *
 * Returns a verdict, never a decision. `state` is one of:
 *   'unknown'  — nothing on file. Num cannot answer and says so.
 *   'expired'  — it runs out before they travel. Nothing else matters.
 *   'short'    — valid on the day, short of the six months airlines apply.
 *   'ok'       — clears the six-month rule. NOT the same as "cleared to fly".
 */
export function checkPassport({ expiry = null, tripDate = null, months = PASSPORT_MONTHS_REQUIRED } = {}) {
  if (!expiry || !tripDate) return { state: 'unknown', expiry: expiry || null };
  const v = passportValidFor(expiry, tripDate, months);
  // passportValidFor returns null for a date it cannot parse. An unreadable
  // expiry is not a passing one — it is the same as not knowing.
  if (!v) return { state: 'unknown', expiry };
  if (v.expired) return { state: 'expired', expiry, needsUntil: null };
  const needsUntil = v.needsUntil.toISOString().slice(0, 10);
  return { state: v.ok ? 'ok' : 'short', expiry, needsUntil };
}

/**
 * The block the model reads. Null when there is nothing worth saying, which
 * is most turns — an empty block is how this stays a favour and not a nag.
 */
export function passportBlock({
  expiry = null, tripDate = null, daysOut = null,
  destination = null, asked = false, who = 'their',
} = {}) {
  const check = checkPassport({ expiry, tripDate });
  const where = destination ? ` to ${destination}` : '';

  if (check.state === 'expired') {
    return 'PASSPORT — EXPIRES BEFORE THE TRIP\n'
      + `The passport Num holds runs out before this trip${where} begins. Do not state the date — `
      + 'you have not been given it and guessing one is worse than saying none. This is not a detail '
      + 'to mention at the end: say it first, plainly and without alarm, and help them start a '
      + 'renewal today. Everything else on the plan waits for this.';
  }

  if (check.state === 'short') {
    const room = Number.isFinite(daysOut) && daysOut > 45
      ? 'There is time to renew, which is the whole reason for raising it now. '
      : 'There may not be time for a normal renewal — most countries run an expedited service, and that is the thing to look at today. ';
    return 'PASSPORT — SHORT OF THE SIX MONTHS AIRLINES APPLY\n'
      + 'The passport Num holds expires too soon for these dates, and you have not been given the '
      + `date itself — do not state or guess one. Most destinations want it valid to at least `
      + `${check.needsUntil}. Airlines are fined for carrying somebody who is refused entry, so they `
      + 'apply the strictest reading at the CHECK-IN DESK — people are stopped there, not at the border. '
      + room
      + 'Say it once, clearly, near the top. Do not repeat it every turn.';
  }

  if (check.state === 'ok') {
    // Deliberately silent. A passport that clears the rule is not news, and
    // "you're all set" is a claim Num is not entitled to make — it cannot
    // see their visa, their purpose, or the airline's own policy.
    return null;
  }

  if (shouldAsk({ daysOut, destination, asked, onFile: Boolean(expiry) })) {
    return 'PASSPORT — NOT ON FILE, WORTH ONE QUESTION\n'
      + `They have a trip${where} in about ${daysOut} days and Num does not hold ${who} passport expiry. `
      + 'The single most common reason somebody is turned away is a passport with under six months left, '
      + 'and it is caught at check-in when nothing can be done. Ask for the expiry date ONCE, lightly, '
      + 'folded into whatever else you are saying — not as a form, not as a warning, and never twice. '
      + 'If they would rather not say, drop it completely and do not raise it again.';
  }

  return null;
}
