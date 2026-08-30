/**
 * TRAVEL-SPEAK — the words Num may not say about travel, and the two layers
 * that stop it saying them.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * California Business & Professions Code §17550.1(a) defines a "seller of
 * travel" as anyone who "sells, provides, furnishes, contracts for, ARRANGES,
 * OR ADVERTISES THAT HE OR SHE CAN OR MAY ARRANGE" air or sea transportation
 * or lodging. Num's whole structure — the one that makes the surety bond $0 —
 * rests on Num never arranging travel: a partner agency is merchant of record,
 * issues the ticket, holds the money, and owns the traveller's contract.
 *
 * That structure is a fact about the product only for as long as the product
 * behaves that way. A single sentence — "I've booked that for you" — puts Num
 * back inside §17550.1(a) by ADVERTISING an arrangement it never made. Every
 * other control in the structure is enforced by code that either runs or does
 * not. This one is enforced by a language model choosing words, which means it
 * is the only rule in the whole compliance surface that can break unaided, on
 * a turn nobody is watching, in production.
 *
 * So it gets two layers, with deliberately different failure modes:
 *
 *   1. LINT (static, HARD FAIL).  scripts/travelspeak-lint.mjs runs this
 *      module over the string literals of the prompt/persona files and the
 *      travel UI. A hit fails `npm test`, and therefore the build. A false
 *      positive here costs a developer thirty seconds; a false negative ships
 *      a persona that teaches the model the forbidden phrasing on every turn.
 *      Blocking is the right trade.
 *
 *   2. RUNTIME (generated text, REWRITE — NEVER BLOCK).  `scrubPayload` runs
 *      over every concierge response before it leaves the Worker. A hit is
 *      rewritten to permitted framing, never suppressed. See "REWRITE, NOT
 *      BLOCK" below.
 *
 * ── REWRITE, NOT BLOCK ───────────────────────────────────────────────────
 *
 * The runtime layer could refuse the reply and retry, or refuse and fall back
 * to a canned line. It does neither, for three reasons:
 *
 *   · A block is a broken product on every turn it fires, and it fires on
 *     false positives. worker/quality.mjs already carries Dre's rule in
 *     writing — "no message goes unanswered" — and nothing in this file is
 *     allowed to be the thing that produces silence.
 *   · A rewrite is not a weaker mitigation than a block. The legal exposure is
 *     the FORBIDDEN WORDS REACHING THE TRAVELLER. A deterministic rewrite
 *     removes exactly those words with certainty; a block removes them and the
 *     answer with them. Same legal outcome, one of them keeps the product.
 *   · A block costs a model round trip to retry, at the moment a guest is
 *     already waiting, and the retry is produced by the same model that just
 *     broke the rule.
 *
 * The rewrite is a SENTENCE-LEVEL SWAP, not a word swap. Patching "book" into
 * some other verb produces sentences that still claim the arrangement ("I'll
 * sort your flight" is the same advertisement in a nicer coat). Replacing the
 * whole sentence with permitted framing from the counsel memo's §10.3 is the
 * only rewrite that is certainly clean, and it is always grammatical.
 *
 * ── RESTAURANTS ARE NOT TRAVEL ───────────────────────────────────────────
 *
 * "Travel services" under §17550.9 is transportation and lodging. Asking a
 * restaurant to hold a table is a different legal animal entirely: Num brokers
 * it, bills the VENUE, and no traveller money moves. `worker/bookdesk.mjs`
 * must keep working and "book a table" must keep being sayable. Over-blocking
 * kills a shipped feature to solve a problem it never had.
 *
 * So every rule here is CONTEXT-SCOPED. A forbidden term only fires when the
 * nearest topic cue is a travel one. "I'll book you a table" passes. "I'll
 * book you a flight" does not. Where the sentence has no cue at all, the
 * caller's context (the guest's own message) breaks the tie, and where even
 * that is silent the hit is recorded as SOFT and nothing is rewritten — a
 * sentence with no travel referent anywhere cannot advertise arranging travel.
 */

/** What the handoff partner is called in rewritten copy. */
export const DEFAULT_PARTNER = 'our travel partner';

/**
 * Topic cues. These decide whether a "book" is a flight or a dinner.
 *
 * TRAVEL = §17550.9 travel services: transportation and lodging.
 * OTHER  = everything Num brokers that is not travel — tables, treatments,
 *          appointments, tickets to things that do not move you.
 */
export const TRAVEL_CUES = [
  'flight', 'flights', 'flying', 'fly', 'flew', 'airfare', 'airfares', 'fare', 'fares',
  'airline', 'airlines', 'airport', 'airports', 'plane', 'planes', 'aircraft',
  'boarding', 'layover', 'stopover', 'non-stop', 'nonstop', 'one-way', 'round-trip',
  'departure', 'departures', 'departs', 'itinerary', 'itineraries', 'pnr', 'e-ticket',
  'cruise', 'cruises', 'ferry', 'ferries',
  'hotel', 'hotels', 'resort', 'resorts', 'hostel', 'hostels', 'accommodation', 'lodging',
  'rail', 'train', 'trains', 'eurostar', 'sleeper',
  'tour', 'tours', 'travel', 'travels', 'traveller', 'travellers', 'traveler', 'travelers',
  'sabre', 'duffel', 'letsgo2trip', 'premium economy', 'business class', 'first class',
];

/**
 * WEAK travel cues — words that mean travel here and something else two lines
 * later. "Name the dish worth the trip" is a restaurant note; "the trip state"
 * is this app's whole data model; "checkout" is a hotel field and a shopping
 * one. They are real evidence INSIDE the sentence the term is in, and noise
 * from any further away, so they are only consulted at step 1. Promoting them
 * to full cues made the lint fail on three sentences that were about calendars
 * and dinner.
 */
export const WEAK_TRAVEL_CUES = [
  'trip', 'trips', 'transfer', 'transfers', 'nights', 'checkout', 'check-in',
  'economy', 'cabin', 'seat', 'seats', 'suite', 'suites', 'coach', 'sailing', 'stay',
];

export const OTHER_CUES = [
  'table', 'tables', 'restaurant', 'restaurants', 'bistro', 'trattoria', 'izakaya',
  'dinner', 'lunch', 'brunch', 'breakfast', 'supper', 'dining', 'omakase', 'tasting menu',
  'venue', 'venues', 'covers', 'bar', 'bars', 'club', 'nightclub', 'pub', 'cafe', 'café',
  'chef', 'kitchen', 'menu', 'sommelier',
  'massage', 'spa', 'facial', 'treatment', 'salon', 'barber', 'haircut', 'nails', 'tattoo',
  'appointment', 'appointments', 'class', 'classes', 'yoga', 'pilates', 'gym', 'court', 'tee time',
  'cinema', 'cinemas', 'movie', 'movies', 'film', 'films', 'screening', 'showtime', 'showtimes',
  'concert', 'gig', 'show', 'theatre', 'theater', 'match', 'fixture',
  'doctor', 'dentist', 'clinic', 'vet',
  'errand', 'errands', 'courier', 'driver', 'ride', 'delivery', 'takeaway',
];

/**
 * Negation. "I CANNOT book flights" is the opposite of the offence — §17550.1
 * catches advertising that you CAN arrange, so a denial is the thing we want
 * the model saying. Without this the persona's own honest line, "You CANNOT
 * yet: issue real tickets … or arrange anything that needs a human partner",
 * fails its own lint.
 */
const NEGATION = /\b(?:can(?:no|')?t|cannot|never|not|no longer|don'?t|do not|won'?t|will not|unable|isn'?t|aren'?t|without|instead of|rather than)\b/i;

/**
 * Who counts as Num speaking.
 *
 * `output` — a reply to a guest. "I", "we" and "Num" are Num; "you" is the
 *   guest, and "you can book that on their site" is PERMITTED framing, so it
 *   must not fire.
 * `prompt` — a persona or system-prompt file. "you" is Num, because that is
 *   who the file is addressing.
 */
/** How far a topic cue may sit from a term and still be about it. */
const NEAR_CHARS = 240;

const SUBJECTS = { output: `(?:i|we|num)`, prompt: `(?:i|we|you|num)` };

/**
 * THE FORBIDDEN TERMS.
 *
 * `category` picks the replacement sentence. `always` means the term is
 * inherently a travel document and no cue can excuse it. Everything else is
 * cue-scoped.
 *
 * Casing is handled by the `i` flag; possessives fall out of \b, because an
 * apostrophe is a non-word character ("booking's" still matches \bbooking\b).
 */
export const RULES = Object.freeze([
  // Inherently travel documents. No cue can make these innocent.
  { id: 'eticket',        always: true,  category: 'possessive', re: /\be-?tickets?\b/i },
  { id: 'boarding-pass',  always: true,  category: 'possessive', re: /\bboarding pass(?:es)?\b/i },
  { id: 'pnr',            always: true,  category: 'possessive', re: /\bpnr\b/i },
  { id: 'booking-ref',    always: true,  category: 'possessive', re: /\bbooking (?:reference|ref|number|code)\b/i },
  // Ahead of `your-ticket`, which would otherwise claim the words "your
  // ticket" out of "your ticket is ready" and let the whole claim through as
  // merely ambiguous. Num issues no ticket of any kind — not a boarding pass,
  // not a cinema seat — so a claim that one is READY is false whatever it is
  // for, and no cue excuses it.
  { id: 'ticket-ready',   always: true,  category: 'possessive', re: /\btickets? (?:is|are)\s+(?:ready|confirmed|issued|booked)\b/i },

  // Possessive claims — the traveller owns a thing Num says it produced.
  { id: 'your-booking',   category: 'possessive', re: /\byour (?:booking|bookings|reservation|reservations|itinerary)\b/i },
  { id: 'your-ticket',    category: 'possessive', re: /\byour tickets?\b/i },

  // Completed-act claims — Num says the arrangement happened.
  { id: 'booked',         category: 'claims_done', re: /\b(?:booked|rebooked|re-booked)\b/i },
  { id: 'reserved',       category: 'claims_done', re: /\breserved\b/i },
  { id: 'arranged',       category: 'claims_done', re: /\barranged\b/i },
  { id: 'held-it',        category: 'claims_done', re: /\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+held\b/i },
  { id: 'confirmed-bk',   category: 'claims_done', re: /\b(?:booking|reservation) (?:is )?confirmed\b/i },

  // Promise-to-act claims — §17550.1's "advertises that he or she CAN or MAY
  // arrange" is satisfied by the offer alone; nothing has to happen.
  //
  // SUBJ is who is doing it. In generated output that is Num, speaking as "I",
  // "we" or "Num". In a PROMPT FILE the persona addresses Num as "you" — "then
  // say clearly that you can book it" is an instruction to Num to advertise an
  // arrangement, and it is exactly the sentence that was live in
  // worker/services.mjs before this file existed. Hence `mode`.
  { id: 'will-book',      subj: true, category: 'promises_to_do', tail: `(?:'ll| will| can| could| shall| may)?\\s+(?:go ahead and\\s+)?books?\\b` },
  { id: 'will-arrange',   subj: true, category: 'promises_to_do', tail: `(?:'ll| will| can| could| shall| may)?\\s+arrange\\b` },
  { id: 'will-reserve',   subj: true, category: 'promises_to_do', tail: `(?:'ll| will| can| could| shall| may)?\\s+reserve\\b` },
  // "hold" needs an object. Without it the rule eats ordinary English —
  // "treat it as a hint you hold privately" is not an offer to hold a seat.
  { id: 'will-hold',      subj: true, category: 'promises_to_do', tail: `(?:'ll| will| can| could| shall| may)?\\s+hold\\s+(?:it|that|this|one|the|your|a|an|onto)\\b` },
  { id: 'can-issue',      subj: true, category: 'promises_to_do', tail: `(?:'ll| will| can| could| shall| may)?\\s+(?:issue|ticket)s?\\b` },
  { id: 'creates-bk',     subj: true, category: 'claims_done',    tail: `(?:'ll| will| can| could| shall| may)?\\s+creates?\\s+bookings?\\b` },
  { id: 'leave-it',       category: 'promises_to_do', re: /\bleave (?:the|it|that|this) (?:booking|ticket|flight|hotel|trip) (?:with|to) (?:me|us)\b/i },
  { id: 'take-care',      category: 'promises_to_do', re: /\b(?:i|we)(?:'ll| will)?\s+(?:take care of|handle|sort out|sort)\s+(?:the|your)\s+(?:booking|ticket|flight|hotel)\b/i },

  // Bare imperatives — these are what a BUTTON says. Cue-scoped like the rest,
  // but scrubbed in label mode rather than sentence mode.
  { id: 'book-now',       category: 'label', re: /\bbook (?:now|it|this|these|that)\b/i },
  { id: 'confirm-bk',     category: 'label', re: /\b(?:confirm|complete) (?:the |your )?booking\b/i },
  { id: 'hold-fare',      category: 'label', re: /\bhold (?:this|the|your) (?:fare|seat|seats|flight|room)\b/i },

  // The generic nouns and verbs, last so the sharper rules match first.
  { id: 'booking-n',      category: 'claims_done', re: /\bbookings?\b/i },
  { id: 'book-v',         category: 'promises_to_do', re: /\bbooks?\b/i },
  { id: 'reserve-v',      category: 'promises_to_do', re: /\breserv(?:e|es|ing|ation|ations)\b/i },
  { id: 'arrange-v',      category: 'promises_to_do', re: /\barrang(?:e|es|ing|ement|ements)\b/i },
]);

/**
 * The permitted replacements. Lifted verbatim in spirit from the counsel
 * memo's §10.3 "Permitted — copy these verbatim" list: name the supplier,
 * disclaim the issuing, offer the handoff.
 */
export const REPLACEMENTS = Object.freeze({
  claims_done:    (p) => `I can’t issue tickets — ${p} does. Here’s the page for this one.`,
  promises_to_do: (p) => `I don’t issue tickets — ${p} does. Want me to take you there?`,
  possessive:     (p) => `${p[0].toUpperCase()}${p.slice(1)} issues the ticket — here’s the page for this fare.`,
  label:          (p) => `Continue on ${p}`,
});

/* ── cue and sentence machinery ─────────────────────────────────────────── */

const cueRe = (words) =>
  // \p{M} sits with \p{L} on both boundaries: a combining mark is part of the
  // word it sits on, so treating it as a separator would let an English cue
  // match inside a Thai or Arabic word that merely contains those letters.
  new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}_])(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{M}\\p{N}_])`, 'giu');

const TRAVEL_RE = cueRe(TRAVEL_CUES);
const WEAK_RE = cueRe(WEAK_TRAVEL_CUES);
const OTHER_RE = cueRe(OTHER_CUES);

/**
 * Every cue in `text`, with its position and which side it argues for.
 * `weak: true` includes the polysemous travel words — see WEAK_TRAVEL_CUES.
 */
export function cues(text, { weak = false } = {}) {
  const s = String(text ?? '');
  const out = [];
  for (const re of weak ? [TRAVEL_RE, WEAK_RE, OTHER_RE] : [TRAVEL_RE, OTHER_RE]) {
    re.lastIndex = 0;
    const kind = re === OTHER_RE ? 'other' : 'travel';
    let m;
    while ((m = re.exec(s))) {
      out.push({ kind, word: m[1], index: m.index + m[0].length - m[1].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Which side does `text` argue for overall? Used for the caller's context. */
export function dominantCue(text) {
  const c = cues(text);
  if (!c.length) return null;
  const t = c.filter((x) => x.kind === 'travel').length;
  const o = c.length - t;
  if (t === o) return 'travel'; // a tie resolves against us, on purpose
  return t > o ? 'travel' : 'other';
}

/** Sentence spans, so a rewrite can replace exactly one of them. */
export function sentences(text) {
  const s = String(text ?? '');
  const out = [];
  let start = 0;
  const re = /[.!?…\n]+\s*/g;
  let m;
  while ((m = re.exec(s))) {
    out.push({ start, end: m.index + m[0].length, text: s.slice(start, m.index + m[0].length) });
    start = m.index + m[0].length;
  }
  if (start < s.length) out.push({ start, end: s.length, text: s.slice(start) });
  return out.length ? out : [{ start: 0, end: s.length, text: s }];
}

const spanOf = (spans, i) => spans.find((sp) => i >= sp.start && i < sp.end) ?? spans[spans.length - 1];

/**
 * Scan text for travel-speak.
 *
 * @param {string} text
 * @param {{context?: string, mode?: 'output'|'prompt'}} [opts] `context` is the
 *   guest's own message this turn (or, for the lint, the surrounding copy). It
 *   only breaks ties: it is consulted when the sentence itself has no topic cue
 *   at all, which is exactly the case a reply-only scan gets wrong. `mode`
 *   decides whether "you" is Num — see SUBJECTS.
 * @returns {{ok: boolean, hits: Array, soft: Array}}
 *   `hits` are travel-scoped and must be acted on. `soft` are matches with no
 *   discernible topic anywhere — recorded for drift, never rewritten.
 */
export function scan(text, { context = '', mode = 'output' } = {}) {
  const s = String(text ?? '');
  const spans = sentences(s);
  const hits = [];
  const soft = [];
  const claimed = []; // [start,end) already taken by a sharper rule

  for (const rule of RULES) {
    const src = rule.subj ? `\\b${SUBJECTS[mode] ?? SUBJECTS.output}${rule.tail}` : rule.re.source;
    const re = new RegExp(src, 'gi');
    let m;
    while ((m = re.exec(s))) {
      const at = m.index;
      const end = at + m[0].length;
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (claimed.some(([a, b]) => at < b && end > a)) continue;

      const span = spanOf(spans, at);
      const before = s.slice(span.start, at);

      // A denial is the behaviour we want, not the offence.
      if (NEGATION.test(before)) { claimed.push([at, end]); continue; }

      let verdict;
      if (rule.always) {
        verdict = 'travel';
      } else {
        // An escalation ladder, cheapest and most reliable evidence first.
        //   1. the sentence the term is in
        //   2. the rest of the reply — "Booked!" and "your flight leaves at
        //      23:59" are two sentences and one claim
        //   3. the guest's own recent messages, which is where the topic lives
        //      when the reply is a bare "done, sorted"
        //   4. nothing anywhere: SOFT. A text with no travel referent at all
        //      cannot advertise arranging travel, and rewriting it would break
        //      restaurants to fix a sentence that was never about a flight.
        // Weak cues are a LAST resort inside the sentence, not a competitor.
        // "I've reserved two seats for the concert" has a strong non-travel cue
        // ("concert") and a weak travel one ("seats") standing closer; letting
        // the weak word win rewrote a perfectly good sentence about a gig.
        const strong = cues(span.text);
        const local = (strong.length ? strong : cues(span.text, { weak: true }))
          .map((c) => ({ ...c, index: c.index + span.start }));
        // Step 2 is WINDOWED. Unbounded, a "hotel" three thousand characters
        // away in a system-prompt file decides the verdict for a sentence about
        // a calendar, and the lint drowns. NEAR_CHARS is about two sentences of
        // English either side — close enough to be the same thought.
        const pool = local.length
          ? local
          : cues(s).filter((c) => Math.abs(c.index - at) <= NEAR_CHARS);
        if (pool.length) {
          const nearest = pool.reduce((best, c) =>
            Math.abs(c.index - at) < Math.abs(best.index - at) ? c
              : Math.abs(c.index - at) === Math.abs(best.index - at) && c.kind === 'travel' ? c
                : best);
          verdict = nearest.kind;
        } else {
          verdict = dominantCue(context) ?? 'unknown';
        }
      }

      claimed.push([at, end]);
      const hit = {
        rule: rule.id, category: rule.category, match: m[0], index: at, end,
        sentence: span.text.trim(), verdict,
      };
      if (verdict === 'travel') hits.push(hit);
      else if (verdict === 'unknown') soft.push(hit);
    }
  }

  hits.sort((a, b) => a.index - b.index);
  soft.sort((a, b) => a.index - b.index);
  return { ok: hits.length === 0, hits, soft };
}

/**
 * Rewrite generated prose so no forbidden term reaches the traveller.
 *
 * Sentence-level: every sentence carrying a travel-scoped hit is replaced with
 * the permitted line for the strongest category in it. Never returns empty —
 * if every sentence went, the permitted line stands alone as the whole reply.
 */
export function rewrite(text, { context = '', partner = DEFAULT_PARTNER, mode = 'output' } = {}) {
  const s = String(text ?? '');
  const { hits, soft } = scan(s, { context, mode });
  if (!hits.length) return { text: s, changed: false, hits, soft };

  const spans = sentences(s);
  const bySpan = new Map();
  for (const h of hits) {
    const sp = spanOf(spans, h.index);
    const prev = bySpan.get(sp.start);
    // possessive > claims_done > promises_to_do > label, strongest wins.
    const rank = { possessive: 3, claims_done: 2, promises_to_do: 1, label: 0 };
    if (!prev || rank[h.category] > rank[prev.category]) bySpan.set(sp.start, h);
  }

  let out = '';
  let lastLine = null;
  for (const sp of spans) {
    const h = bySpan.get(sp.start);
    if (!h) { out += sp.text; continue; }
    const line = REPLACEMENTS[h.category](partner);
    // Two rewritten sentences in a row would say the same thing twice.
    if (line === lastLine) continue;
    lastLine = line;
    out += line + (/\s$/.test(sp.text) ? ' ' : '');
  }
  const cleaned = out.trim() || REPLACEMENTS.promises_to_do(partner);
  return { text: cleaned, changed: cleaned !== s, hits, soft };
}

/** Short labels — a chip or a button. Swapped whole; a 2-word sentence swap is not a sentence. */
export function rewriteLabel(text, { context = '', partner = DEFAULT_PARTNER, mode = 'output' } = {}) {
  const s = String(text ?? '');
  const { hits, soft } = scan(s, { context, mode });
  if (!hits.length) return { text: s, changed: false, hits, soft };
  return { text: REPLACEMENTS.label(partner), changed: true, hits, soft };
}

/**
 * The keys whose string values are USER-VISIBLE PROSE. A key not on this list
 * is data (a place name, an id, a venue) and is left alone: rewriting
 * `venue_name` would break bookdesk, which is the feature this file must not
 * damage.
 */
const PROSE_KEYS = new Set(['reply', 'meta', 'note', 'blurb', 'summary', 'suggestion', 'detail', 'says']);
const LABEL_KEYS = new Set(['title', 'label']);

/**
 * Scrub a whole concierge response before it leaves the Worker.
 *
 * Walks the payload and rewrites only the prose and label fields. Returns the
 * payload plus `_travelspeak` (the hits, for logging) which the caller strips
 * before it goes on the wire, exactly like `_usage`.
 */
export function scrubPayload(payload, { context = '', partner = DEFAULT_PARTNER } = {}) {
  const found = [];
  const softFound = [];
  const walk = (node, key) => {
    if (typeof node === 'string') {
      if (PROSE_KEYS.has(key)) {
        const r = rewrite(node, { context, partner });
        found.push(...r.hits); softFound.push(...r.soft);
        return r.text;
      }
      if (LABEL_KEYS.has(key)) {
        const r = rewriteLabel(node, { context, partner });
        found.push(...r.hits); softFound.push(...r.soft);
        return r.text;
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((v) => walk(v, key));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k);
      return out;
    }
    return node;
  };
  const scrubbed = walk(payload, null);
  if (!found.length && !softFound.length) return payload;
  return { ...scrubbed, _travelspeak: { hits: found, soft: softFound } };
}
