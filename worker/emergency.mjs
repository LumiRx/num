/**
 * Emergency numbers — a checked table, never a guess.
 *
 * ── WHY THIS IS A TABLE AND NOT A PROMPT ─────────────────────────────────
 *
 * Ambulance in Thailand is 1669. In Japan it is 119. In the UAE, 998. Almost
 * nowhere outside North America is it 911, and a traveller who dials 911 in
 * Bangkok reaches nothing.
 *
 * A language model will answer this question fluently and will sometimes be
 * wrong, and there is no way to tell which from the outside. Every other thing
 * Num gets wrong costs somebody an evening. This one is different, and it is
 * the single place in the product where "usually right" is not a standard worth
 * having. Dre's call, 13 Sep 2026: a checked table, read rather than recalled.
 *
 * ── THE RULE THAT MATTERS MORE THAN THE DATA ─────────────────────────────
 *
 * AN UNKNOWN COUNTRY RETURNS null. It does not fall back to 911, it does not
 * infer from a neighbour, and it does not let the model fill the gap. A country
 * missing from this table produces the honest sentence in `FALLBACK` instead —
 * which is genuinely useful, because 112 really does reach emergency services
 * from any GSM handset across Europe and much of the world, and on most phones
 * it dials from a locked screen with no SIM at all.
 *
 * Two countries Num covers are deliberately ABSENT: Barbados and the Bahamas.
 * Both run three-digit services alongside 911 routing and I could not verify
 * the current arrangement to the standard the rest of this file is held to.
 * A gap that produces the fallback is safe. A plausible wrong number is not.
 *
 * ── HOW TO ADD ONE ───────────────────────────────────────────────────────
 *
 * Verify against the country's own emergency service or interior ministry, not
 * a travel blog and not a model. Add the source in the comment. If you cannot
 * verify it today, leave it out today.
 */

/**
 * ISO-3166 alpha-2 → the numbers that actually connect there.
 *
 * `all` is used when one number covers everything. When police and ambulance
 * differ they are named separately, because "call the emergency number" is
 * useless advice in a country that has four.
 */
export const EMERGENCY = Object.freeze({
  // ── 112 across the EU/EEA. Single European emergency number, Directive
  // 2002/22/EC — reaches police, ambulance and fire in every member state,
  // in English in most of them.
  AT: { all: '112' },
  CZ: { all: '112' },
  DE: { all: '112', police: '110' },
  DK: { all: '112' },
  ES: { all: '112' },
  FR: { all: '112', police: '17', ambulance: '15', fire: '18' },
  GR: { all: '112', ambulance: '166' },
  HR: { all: '112' },
  HU: { all: '112' },
  IE: { all: '112', also: '999' },
  IS: { all: '112' },
  IT: { all: '112' },
  NL: { all: '112' },
  PT: { all: '112' },
  SE: { all: '112' },
  CH: { all: '112', police: '117', ambulance: '144' },
  TR: { all: '112' },

  // ── The 999 family
  GB: { all: '999', also: '112' },
  HK: { all: '999', also: '112' },
  MY: { all: '999', also: '112' },
  MU: { all: '999', also: '112' },
  SG: { police: '999', ambulance: '995', fire: '995' },
  AE: { police: '999', ambulance: '998', fire: '997' },

  // ── The 911 family
  US: { all: '911' },
  MX: { all: '911' },
  PH: { all: '911' },

  // ── Everywhere else, each on its own scheme
  TH: {
    police: '191', ambulance: '1669', fire: '199',
    // The Tourist Police answer in English and will interpret for you on the
    // line. For a traveller this is often the more useful number of the two.
    tourist: '1155',
  },
  JP: { police: '110', ambulance: '119', fire: '119' },
  KR: { police: '112', ambulance: '119', fire: '119' },
  TW: { police: '110', ambulance: '119', fire: '119' },
  VN: { police: '113', fire: '114', ambulance: '115' },
  ID: { all: '112', police: '110', ambulance: '119' },
  IN: { all: '112', police: '100', ambulance: '102', fire: '101' },
  KH: { police: '117', fire: '118', ambulance: '119' },
  LK: { police: '119', ambulance: '1990' },
  MV: { police: '119', ambulance: '102' },
  // Mongolia. Added 17 Sep 2026, because worker/emergency.test.mjs failed:
  // a destination had been added to scripts/destinations.mjs and Num was
  // sending travellers to a country it could not answer this question for.
  // That test is the reason this was caught rather than discovered by a
  // guest in Ulaanbaatar.
  //
  // Verified against Mongolia's own Communications Regulatory Commission,
  // which lists 101 fire, 102 police, 103 ambulance and 105 emergency
  // response (101/102/103/105 are answered by the General Police
  // Department's Information and Express Management Center):
  //   https://admin.crc.gov.mn/list/harilcaa-holboony-jlchilgee/en?show=195
  // Corroborated by UK FCDO travel advice, which gives ambulance 103,
  // fire 101, police 102:
  //   https://www.gov.uk/foreign-travel-advice/mongolia/getting-help
  //
  // 105 is deliberately NOT set as `all`. Only one of the two sources
  // mentions it, and this file's rule is that a gap producing the honest
  // fallback is safe where a plausible wrong number is not.
  MN: { police: '102', ambulance: '103', fire: '101' },
});

/**
 * What to say when the country is not in the table.
 *
 * Not an apology. 112 is a real answer nearly everywhere, and the locked-screen
 * point is the single most useful thing to know in the moment — a stolen phone,
 * a dead SIM and a foreign network all stop mattering.
 */
export const FALLBACK =
  'I do not have a verified emergency number for here, and I will not guess one. '
  + 'Try 112 — it reaches emergency services across Europe and much of the world, '
  + 'and on most phones it dials from a locked screen with no SIM in it. '
  + 'Your hotel front desk will have the local numbers on the room card.';

/** The numbers for a country, or null. Never a guess, never a neighbour's. */
export function emergencyFor(country) {
  const cc = String(country ?? '').trim().toUpperCase();
  return EMERGENCY[cc] ?? null;
}

/** Do we hold verified numbers for this country? */
export const haveEmergency = (country) => emergencyFor(country) !== null;

/**
 * One sentence a person can act on, ordered by what they most likely need.
 *
 * Ambulance first when they differ, because somebody asking this question at
 * speed is more often looking at a person than at a crime.
 */
export function emergencyLine(country, placeName = null) {
  const e = emergencyFor(country);
  if (!e) return FALLBACK;
  const where = placeName ? ` in ${placeName}` : '';
  const parts = [];

  if (e.all && !e.police && !e.ambulance) {
    parts.push(`Emergency${where} is ${e.all}${e.also ? ` (${e.also} also works)` : ''}.`);
  } else if (e.all) {
    const named = [
      e.ambulance ? `ambulance ${e.ambulance}` : null,
      e.police ? `police ${e.police}` : null,
      e.fire ? `fire ${e.fire}` : null,
    ].filter(Boolean).join(', ');
    parts.push(`Emergency${where} is ${e.all}${named ? `, or direct: ${named}` : ''}.`);
  } else {
    const named = [
      e.ambulance ? `ambulance ${e.ambulance}` : null,
      e.police ? `police ${e.police}` : null,
      e.fire && e.fire !== e.ambulance ? `fire ${e.fire}` : null,
    ].filter(Boolean).join(', ');
    parts.push(`Emergency${where}: ${named}.`);
  }
  if (e.tourist) parts.push(`Tourist Police on ${e.tourist} answer in English and will interpret.`);
  return parts.join(' ');
}

/**
 * Is this turn asking for it?
 *
 * Kept tight, and bare numbers are NOT a trigger on their own. "Room 911" and
 * "flight 112" are ordinary sentences, and answering either with a burst of
 * emergency numbers is alarming to somebody who was not in an emergency. A
 * number only counts when it is being asked ABOUT.
 */
export const asksEmergency = (text) => {
  const t = String(text ?? '');
  if (/\b(emergency number|emergency services|call an ambulance|need an ambulance|ambulance|call the police|police number|paramedic)\b/i.test(t)) return true;
  // "does 911 work here", "is it 112 here", "what's 999 for"
  return /\b(?:is|does|what(?:'s| is)?|which|dial|call)\b[^.?!]{0,24}\b(?:999|911|112|1669|119|110)\b/i.test(t);
};
