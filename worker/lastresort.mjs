/**
 * The reply that needs no model at all.
 *
 * The brain chain has seven brains so a turn never dies with the first one.
 * But on 2026-08-06 every one of them failed at once — Anthropic and Cloudflare
 * Workers AI exhausted in the same window — and the guest got:
 *
 *   "That one slipped away from me. Say it once more."
 *
 * Warm, honest, and completely useless. Saying it again does not help when the
 * cause is a quota that resets tomorrow, and it is the worst possible answer to
 * somebody who arrived from an ad thirty seconds ago.
 *
 * ── WHAT THIS IS ──────────────────────────────────────────────────────────
 *
 * By the time the chain fails we have ALREADY done the expensive part: the
 * grounding step resolved where they are and pulled real partners from D1.
 * That data does not need a language model to be useful — it needs a sentence
 * around it. This builds that sentence deterministically.
 *
 * A guest asking "dinner tonight" gets three real places that are actually
 * near them instead of an apology. Worse than Claude. Enormously better than
 * nothing, and it cannot fail for the same reason the models did, because it
 * makes no network call at all.
 *
 * ── WHAT IT MUST NEVER DO ─────────────────────────────────────────────────
 *
 * Never claim to have booked, held, or confirmed anything. A prose brain that
 * invents a reservation is worse than an outage, and that goes double for a
 * template that cannot even be reasoned with. It offers information and says
 * plainly that the concierge is running lean — an honest limitation beats a
 * confident fiction every time.
 *
 * Never rank. `top_places` rows are not quality-ranked, so "best" and "top"
 * are unavailable to us here exactly as they are everywhere else.
 */

/** Cheap intent read. No model, no cleverness — just what the words obviously want. */
export function readIntent(text) {
  const t = String(text ?? '').toLowerCase();
  // Plurals matter more than they look: `\bcocktail\b` does not match
  // "cocktails", and "drinks", "cars" and "tables" are how people actually
  // type. Every one of those was silently falling through to `other` and
  // getting the blandest opening line we have.
  if (/\b(cars?|drivers?|taxis?|rides?|lifts?|airport|pick ?ups?|transfers?)\b/.test(t)) return 'car';
  if (/\b(eat|dinner|lunch|breakfast|food|restaurants?|tables?|hungry|brunch)\b/.test(t)) return 'food';
  if (/\b(bars?|drinks?|clubs?|night ?outs?|party|cocktails?)\b/.test(t)) return 'night';
  if (/\b(massages?|spa|treatments?|facials?|nails)\b/.test(t)) return 'spa';
  if (/\b(beach(es)?|snorkel\w*|islands?|boats?|tours?|dive|diving|kayak\w*)\b/.test(t)) return 'do';
  return 'other';
}

const OPENER = {
  food: 'Here’s where I’d point you for food right now',
  night: 'Here’s where I’d point you tonight',
  car: 'I can’t arrange the car this second, but here’s what’s around you',
  spa: 'Here’s what’s near you',
  do: 'Here’s what’s near you',
  other: 'Here’s what’s near you',
};

/**
 * Build a reply from what we already fetched, with no model call.
 *
 * Returns null when there is genuinely nothing to say — an empty template is
 * worse than the honest apology, so the caller keeps its existing wording in
 * that case rather than shipping a hollow shell.
 */
export function lastResort({ userText, grounding, place }) {
  const partners = (grounding?.partners ?? []).filter((p) => p && p.name).slice(0, 3);
  if (!partners.length) return null;

  const intent = readIntent(userText);
  const where = place?.name || grounding?.place?.name || null;
  const names = partners.map((p) => {
    const bits = [p.name];
    // Distance is a fact we already hold and the single most useful thing on
    // the line — "3.8 km away" changes a decision, an adjective does not.
    if (typeof p.km === 'number' && isFinite(p.km)) bits.push(`${p.km.toFixed(1)} km`);
    else if (p.area) bits.push(String(p.area));
    return bits.join(' · ');
  });

  const opener = OPENER[intent] ?? OPENER.other;
  const scope = where ? ` in ${where}` : '';

  return {
    reply:
      `${opener}${scope}:\n\n` +
      names.map((n) => `• ${n}`).join('\n') +
      // The honesty line. It says what is true — the thinking part is down, the
      // directory is not — without asking them to do anything useless like
      // "try again", and without pretending a booking happened.
      '\n\nI’m running lean for a few minutes so I can’t book or check openings ' +
      'right this second — but these are real and they’re close. Ask me again shortly ' +
      'and I’ll sort the table and the car properly.',
    card: null,
    chips: null,
    actions: [],
    place: place ?? grounding?.place ?? null,
    degraded: true,
    // Distinct from the apology path so the operator console and any alert can
    // tell "answered without a model" apart from "said nothing useful".
    lane: 'last-resort',
  };
}
