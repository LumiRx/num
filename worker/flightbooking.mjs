// Booking a flight: what Num must know, what it must check, and what it asks.
//
// ── THE SHAPE OF THE PROBLEM ─────────────────────────────────────────────
//
// A flight booking needs about eight facts per passenger and every one of
// them is a place a trip can die. Not "the form was invalid" — the ticket
// issues, the traveller flies to the airport, and the airline turns them
// away. The expensive failures are all knowable in advance:
//
//   PASSPORT UNDER SIX MONTHS. Most of the world requires a passport valid
//   at least six months beyond arrival. The airline is fined if it carries
//   somebody who will be refused entry, so the airline refuses at check-in.
//   This is the single most common denied boarding there is, and it is
//   checkable the moment we know the expiry date and the travel date.
//
//   NAME NOT AS IN THE PASSPORT. "Mike" instead of "Michael". Airlines
//   charge to correct it and some will not correct it at all — the ticket is
//   reissued at the current fare. So Num asks for the name AS PRINTED, and
//   says why, once.
//
//   AN INFANT WHO TURNS TWO MID-TRIP. Under 2 flies on a lap for a nominal
//   fare; 2 and over needs a seat. Age is taken at each flight date, not at
//   booking, so a child born 2024-09-20 is an infant outbound on 2026-09-14
//   and a child on the return. Booking them as an infant both ways produces
//   a ticket the airline will not honour on the way home.
//
// ── WHY THE PROMPTS LIVE HERE AND NOT IN THE PROMPT ──────────────────────
//
// The model could be told "collect passenger details" and would do a
// reasonable job most of the time. Most of the time is the wrong standard
// when the failure is somebody standing at a check-in desk. So the fields,
// the order, the validation and the exact question are code, and the model's
// job is to say them in its own voice — `nextPrompt()` returns what to ask
// and why, never a script to read out.
//
// ── ONE FACT AT A TIME ───────────────────────────────────────────────────
//
// A form asks for eight things at once because a form has one screen. A
// concierge conversation does not, and dumping eight fields into a chat
// message is how people abandon. `nextPrompt` returns exactly one.

/* ── PASSENGER TYPES ─────────────────────────────────────────────────────
   Taken at the DATE OF THE FLIGHT, not the date of booking. This is the
   rule that catches the infant-turning-two case, and getting it wrong
   produces a ticket that is fine outbound and refused on the return. */
export const PAX = Object.freeze({ ADULT: 'adult', CHILD: 'child', INFANT: 'infant' });

export const DAY = 86400000;

/** Whole years between two dates, calendar-correct (no 365.25 drift). */
export function yearsBetween(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  let y = b.getUTCFullYear() - a.getUTCFullYear();
  const m = b.getUTCMonth() - a.getUTCMonth();
  if (m < 0 || (m === 0 && b.getUTCDate() < a.getUTCDate())) y -= 1;
  return y;
}

export function paxTypeOn(dob, flightDate) {
  const age = yearsBetween(dob, flightDate);
  if (age == null || age < 0) return null;
  if (age < 2) return PAX.INFANT;
  if (age < 12) return PAX.CHILD;
  return PAX.ADULT;
}

/**
 * The rule that actually strands people: a passport must normally be valid
 * six months beyond arrival. Some destinations want three, a few want only
 * the length of stay — but the airline applies the strictest reading it can
 * be fined for, so six is what Num checks against.
 */
export const PASSPORT_MONTHS_REQUIRED = 6;

export function passportValidFor(expiry, travelDate, months = PASSPORT_MONTHS_REQUIRED) {
  const exp = new Date(expiry);
  const fly = new Date(travelDate);
  if (Number.isNaN(exp.getTime()) || Number.isNaN(fly.getTime())) return null;
  const need = new Date(fly);
  need.setUTCMonth(need.getUTCMonth() + months);
  return { ok: exp >= need, expires: exp, needsUntil: need, expired: exp < fly };
}

/* ── THE FIELDS ──────────────────────────────────────────────────────────
   `ask` is the intent of the question, not a line to recite — the concierge
   says it in its own voice. `why` is only surfaced when it is not obvious,
   because explaining every field is its own kind of friction. */

const NAME_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{0,62}$/;
const PASSPORT_RE = /^[A-Za-z0-9]{5,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const ISO2_RE = /^[A-Za-z]{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const FIELDS = Object.freeze([
  {
    key: 'given_name', label: 'First name', per: 'passenger',
    ask: 'their first name exactly as it is printed in the passport',
    why: 'the airline matches the ticket to the passport, and a mismatch is charged as a reissue',
    valid: (v) => NAME_RE.test(String(v ?? '').trim()),
    error: 'That does not look like a name as a passport would print it.',
  },
  {
    key: 'family_name', label: 'Last name', per: 'passenger',
    ask: 'their surname exactly as printed in the passport',
    valid: (v) => NAME_RE.test(String(v ?? '').trim()),
    error: 'That does not look like a surname as a passport would print it.',
  },
  {
    key: 'dob', label: 'Date of birth', per: 'passenger',
    ask: 'their date of birth',
    why: 'it sets the fare type — under 2 flies on a lap, under 12 is a child fare',
    valid: (v) => DATE_RE.test(String(v ?? '')) && new Date(v) < new Date() && new Date(v) > new Date('1900-01-01'),
    error: 'I need that as a real date of birth, year first — 1991-04-08.',
  },
  {
    key: 'nationality', label: 'Nationality', per: 'passenger',
    ask: 'the nationality on the passport',
    why: 'it decides whether a visa is needed for this route',
    valid: (v) => ISO2_RE.test(String(v ?? '').trim()),
    normalise: (v) => String(v).trim().toUpperCase(),
    error: 'I need the country as it appears on the passport.',
  },
  {
    key: 'passport_number', label: 'Passport number', per: 'passenger',
    ask: 'the passport number',
    valid: (v) => PASSPORT_RE.test(String(v ?? '').replace(/\s/g, '')),
    normalise: (v) => String(v).replace(/\s/g, '').toUpperCase(),
    error: 'A passport number is 5–15 letters and digits with no spaces.',
  },
  {
    key: 'passport_expiry', label: 'Passport expiry', per: 'passenger',
    ask: 'the passport expiry date',
    why: 'most countries want six months left on it and the airline checks at the desk, not at the border',
    valid: (v) => DATE_RE.test(String(v ?? '')),
    error: 'I need the expiry date, year first — 2029-11-02.',
  },
  {
    key: 'email', label: 'Email', per: 'booking',
    ask: 'the email the tickets should go to',
    valid: (v) => EMAIL_RE.test(String(v ?? '').trim()),
    normalise: (v) => String(v).trim().toLowerCase(),
    error: 'That email will not reach anybody — can you check it?',
  },
  {
    key: 'phone', label: 'Mobile', per: 'booking',
    ask: 'a mobile number in case the airline needs to reach them on the day',
    why: 'delays and gate changes go to the number on the booking, not to us',
    valid: (v) => PHONE_RE.test(String(v ?? '').replace(/[\s()-]/g, '')),
    normalise: (v) => String(v).replace(/[\s()-]/g, ''),
    error: 'I need that with the country code — +447700900123.',
  },
]);

export const PER_PASSENGER = Object.freeze(FIELDS.filter((f) => f.per === 'passenger').map((f) => f.key));
export const PER_BOOKING = Object.freeze(FIELDS.filter((f) => f.per === 'booking').map((f) => f.key));
export const fieldFor = (key) => FIELDS.find((f) => f.key === key) || null;

/* ── STATE ───────────────────────────────────────────────────────────────
   Deliberately small and serialisable — this rides in the trip state, and a
   state machine that cannot survive being written to JSON and read back is
   a state machine that loses somebody's booking on a page reload. */
export const STATE = Object.freeze({
  QUOTED: 'quoted', //      a fare is chosen, nothing collected
  COLLECTING: 'collecting', // mid-conversation
  READY: 'ready', //        everything present and valid, awaiting a human tap
  ISSUING: 'issuing', //    handed to the issuer
  ISSUED: 'issued',
  FAILED: 'failed',
});

/**
 * Start a booking against a chosen fare.
 * `seats` is how many passengers the fare was quoted for; the traveller is
 * never asked to re-state it.
 */
export function startBooking(offer, seats = 1) {
  return {
    state: STATE.QUOTED,
    offer,
    passengers: Array.from({ length: Math.max(1, seats) }, () => ({})),
    contact: {},
    issued: null,
    errors: [],
  };
}

/** Put one answer in. Returns a NEW booking — no mutation, so a bad answer
 *  cannot half-apply and leave the record in a state nobody designed. */
export function apply(booking, key, value, index = 0) {
  const f = fieldFor(key);
  if (!f) return { booking, ok: false, error: `Num does not collect "${key}".` };
  const raw = f.normalise ? f.normalise(value) : String(value ?? '').trim();
  if (!f.valid(raw)) return { booking, ok: false, error: f.error };

  const next = structuredClone(booking);
  if (f.per === 'booking') next.contact[key] = raw;
  else {
    next.passengers[index] = { ...(next.passengers[index] || {}), [key]: raw };
  }
  next.state = complete(next).ok ? STATE.READY : STATE.COLLECTING;
  return { booking: next, ok: true };
}

/**
 * The one thing to ask next, or null when there is nothing left.
 *
 * Order is deliberate: names and dates of birth first because they are
 * answered from memory, passport details last because they need the document
 * in hand. Asking for a passport number before the fare is settled is how a
 * conversation ends.
 */
export function nextPrompt(booking) {
  if (!booking || booking.state === STATE.ISSUED) return null;
  const n = booking.passengers.length;
  for (let i = 0; i < n; i++) {
    for (const key of PER_PASSENGER) {
      if (!booking.passengers[i]?.[key]) {
        const f = fieldFor(key);
        return {
          key,
          index: i,
          per: 'passenger',
          who: n > 1 ? `passenger ${i + 1} of ${n}` : 'them',
          ask: f.ask,
          why: f.why ?? null,
          label: f.label,
        };
      }
    }
  }
  for (const key of PER_BOOKING) {
    if (!booking.contact?.[key]) {
      const f = fieldFor(key);
      return { key, index: null, per: 'booking', who: 'the booking', ask: f.ask, why: f.why ?? null, label: f.label };
    }
  }
  return null;
}

/** How far through we are, so the concierge can say "two more things". */
export function remaining(booking) {
  const perPax = PER_PASSENGER.length * booking.passengers.length;
  const total = perPax + PER_BOOKING.length;
  let have = 0;
  for (const p of booking.passengers) for (const k of PER_PASSENGER) if (p?.[k]) have += 1;
  for (const k of PER_BOOKING) if (booking.contact?.[k]) have += 1;
  return { have, total, left: total - have };
}

/* ── THE CHECKS THAT HAPPEN AFTER EVERYTHING IS PRESENT ──────────────────
   Field validation says the answer is well-formed. These say the trip will
   actually work, and they need the itinerary as well as the passenger. */

/**
 * @returns {{ok:boolean, blocking:Array, warnings:Array}}
 * `blocking` must be resolved before issuing. `warnings` are things the
 * traveller should be told and may choose to accept.
 */
export function preflight(booking) {
  const blocking = [];
  const warnings = [];
  const depart = booking?.offer?.depart_date;
  const last = booking?.offer?.return_date || depart;

  booking.passengers.forEach((p, i) => {
    const who = p.given_name ? `${p.given_name} ${p.family_name ?? ''}`.trim() : `Passenger ${i + 1}`;

    if (p.passport_expiry && depart) {
      const v = passportValidFor(p.passport_expiry, last);
      if (v?.expired) {
        blocking.push({
          code: 'passport_expired', index: i,
          message: `${who}'s passport expires ${p.passport_expiry}, before they travel. That flight cannot be flown on it.`,
        });
      } else if (v && !v.ok) {
        // Blocking, not a warning. An airline that would be fined for
        // carrying them refuses at the desk, and a "warning" here means Num
        // charged somebody for a ticket it already knew they could not use.
        blocking.push({
          code: 'passport_six_months', index: i,
          message: `${who}'s passport expires ${p.passport_expiry}. Most destinations need six months beyond the trip — `
            + `for these dates that means valid to at least ${v.needsUntil.toISOString().slice(0, 10)}. They will very `
            + 'likely be turned away at check-in. Renew first, or pick a route that accepts less.',
        });
      }
    }

    if (p.dob && depart) {
      const outbound = paxTypeOn(p.dob, depart);
      const inbound = paxTypeOn(p.dob, last);
      if (outbound && inbound && outbound !== inbound) {
        // The infant-turning-two case. Ticketed as an infant both ways, the
        // return is refused — the airline needs a seat for a two-year-old.
        blocking.push({
          code: 'pax_type_changes', index: i,
          message: `${who} is ${outbound === PAX.INFANT ? 'an infant' : `a ${outbound}`} on the way out and `
            + `${inbound === PAX.INFANT ? 'an infant' : `a ${inbound}`} on the way back — they have a birthday mid-trip. `
            + 'The return needs to be ticketed at the older fare or it will be refused.',
        });
      }
      if (outbound === PAX.INFANT) {
        warnings.push({
          code: 'infant_lap', index: i,
          message: `${who} flies on a lap at an infant fare. No seat, no baggage allowance of their own on most airlines.`,
        });
      }
    }
  });

  const adults = booking.passengers.filter((p) => p.dob && paxTypeOn(p.dob, depart) === PAX.ADULT).length;
  const infants = booking.passengers.filter((p) => p.dob && paxTypeOn(p.dob, depart) === PAX.INFANT).length;
  if (infants > adults) {
    blocking.push({
      code: 'infants_exceed_adults',
      message: `${infants} infants and ${adults} adults — an infant flies on an adult's lap, so there are not enough laps. `
        + 'One of them needs their own seat.',
    });
  }

  return { ok: blocking.length === 0, blocking, warnings };
}

/** Is every field present and well-formed? Says nothing about whether the
 *  trip works — that is `preflight`. */
export function complete(booking) {
  const missing = [];
  booking.passengers.forEach((p, i) => {
    for (const k of PER_PASSENGER) if (!p?.[k]) missing.push({ key: k, index: i });
  });
  for (const k of PER_BOOKING) if (!booking.contact?.[k]) missing.push({ key: k, index: null });
  return { ok: missing.length === 0, missing };
}

/**
 * Everything that must be true before an issuer is called.
 * Both gates, in one place, so no caller can accidentally run one and not
 * the other — issuing on a complete-but-unflyable booking is the failure
 * this whole file exists to prevent.
 */
export function readyToIssue(booking) {
  const c = complete(booking);
  if (!c.ok) return { ok: false, reason: 'incomplete', missing: c.missing };
  const p = preflight(booking);
  if (!p.ok) return { ok: false, reason: 'preflight', blocking: p.blocking };
  return { ok: true, warnings: p.warnings };
}

/* ── WHAT THE CONCIERGE IS TOLD ──────────────────────────────────────────
   The block below goes into the prompt while a booking is open. It carries
   the next question and the state, never a script. */
export function bookingBlock(booking) {
  if (!booking || booking.state === STATE.ISSUED) return '';
  const r = remaining(booking);
  const next = nextPrompt(booking);
  const pf = preflight(booking);

  const lines = [
    '\n\nA FLIGHT BOOKING IS OPEN.',
    `Fare: ${booking.offer?.carrier ?? ''} ${booking.offer?.flight_no ?? ''} ${booking.offer?.origin ?? ''}→${booking.offer?.dest ?? ''} `
      + `on ${booking.offer?.depart_date ?? ''}${booking.offer?.return_date ? ` returning ${booking.offer.return_date}` : ''}. `
      + `${booking.passengers.length} passenger${booking.passengers.length === 1 ? '' : 's'}.`,
    `Collected ${r.have} of ${r.total}.`,
  ];

  if (next) {
    lines.push(
      `ASK FOR ONE THING NOW: ${next.ask}${next.who !== 'them' && next.per === 'passenger' ? ` — for ${next.who}` : ''}.`
      + (next.why ? ` If they ask why, or if it needs a reason to feel less intrusive: ${next.why}.` : ''),
      'ASK FOR THAT AND NOTHING ELSE. One question per message. Do not list the remaining fields, do not paste a form, '
      + 'and do not ask them to "reply with" a template — you are having a conversation, not collecting a document.',
    );
  } else {
    lines.push('Everything is collected. Read the itinerary and the total back to them and ask them to confirm.');
  }

  if (pf.blocking.length) {
    lines.push(
      'STOP — THIS BOOKING CANNOT BE ISSUED AS IT STANDS. Tell them plainly, now, before anything else:',
      ...pf.blocking.map((b) => `  · ${b.message}`),
    );
  }
  if (pf.warnings.length) {
    lines.push('MENTION, WITHOUT ALARM:', ...pf.warnings.map((w) => `  · ${w.message}`));
  }

  lines.push(
    'NOTHING IS BOOKED UNTIL A PERSON TAPS CONFIRM. Never say "booked", "confirmed" or "ticketed" before the issuer '
    + 'has come back with a real reference. Until then it is a held quote and the price can move.',
  );
  return lines.join('\n');
}
