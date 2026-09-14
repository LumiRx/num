// What a notification is allowed to say, and how long it is allowed to be.
//
// Built from the voice research in num-VOICE-HOW-TO-BE-BELIEVED-2026-09-13, which
// asked for exactly this by name: "banned-phrase lint on outbound copy". A rule
// that lives only in a document is a rule the next person in a hurry does not
// know about. This one runs in the test suite.
//
// ── THE SHAPE OF A NOTIFICATION ────────────────────────────────────────────
//
// iOS gives three lines and they are not interchangeable:
//
//   TITLE     the thing itself. A name, not a category. "Serenity II", not
//             "Booking update". Read in the half-second before someone decides
//             whether to look.
//   SUBTITLE  the fact. When, where. "Saturday, 9am · Royal Phuket".
//   BODY      the sentence a person actually reads, once the first two have
//             earned it.
//
// Splitting them this way is what lets the body be a sentence rather than a
// data dump. NUM had no subtitle at all until today, so every "when" was
// competing with the only line that could carry warmth.

/** Lock-screen truncation. Past these a phone shows an ellipsis, which reads as
 *  carelessness rather than brevity — the cut always lands mid-thought. */
export const LIMITS = { title: 34, subtitle: 38, body: 118 };

/* ── What NUM never says ───────────────────────────────────────────────────
 *
 * Each rule carries the finding behind it, because a ban with no reason gets
 * argued away by whoever is writing copy at 2am.
 */
export const BANNED = [
  {
    id: 'deontic',
    // 33-study meta-analysis: controlling language drives reactance at r = .20,
    // while gain/loss framing is null. The lever is control, not tone.
    test: /\b(you (must|should|need to|have to)|don'?t forget to|be sure to|make sure you)\b/i,
    why: 'controlling language causes reactance — say what is true and let them choose',
  },
  {
    id: 'accounting',
    // Aggarwal: a communal-framed relationship punishes exchange behaviour hard
    // (3.33 vs 6.04). Every warm cue raises the penalty on every invoice.
    test: /\b(your plan|upgrade|premium|free tier|credits? (left|remaining)|\d+ (requests?|asks?) (left|remaining)|subscription)\b/i,
    why: 'accounting language inside a conversation breaks the communal frame — billing lives on the billing page',
  },
  {
    id: 'claims-friendship',
    // Behave like a friend, never say you are one. A manufactured need the
    // member cannot discharge is the cleanest fraud line in the design.
    test: /\b(i'?m your friend|as your friend|your best friend|we'?re friends|i'?ve missed you|i miss you)\b/i,
    why: 'behave like a friend, never claim to be one',
  },
  {
    id: 'engagement-bait',
    // nudge.mjs said it first, in August: "No 'haven't seen you in a while',
    // no engagement bait, ever."
    test: /\b(haven'?t seen you|come back|we miss you|it'?s been a while|still there\?|don'?t miss out|last chance|hurry)\b/i,
    why: 'a notification that exists to serve us instead of them is growth hacking in a concierge voice',
  },
  {
    id: 'spotlight-support',
    // Bolger & Amarel: support the recipient NOTICES was worse than no support
    // at all, d = 0.63–1.09, ~55% of it through perceived inefficacy.
    test: /\b(i (saw|noticed|could tell) (you|that)|you seemed|looked like you were (struggling|having trouble)|i went ahead and|i took care of it for you)\b/i,
    why: 'help that spotlights inadequacy harms — state the outcome, not the rescue',
  },
  {
    id: 'hollow-because',
    // Langer: at 20 pages, a fake reason performed exactly as badly as no reason
    // (24% vs 24%). Every concierge request is the 20-page kind.
    test: /\bbecause (we|i) (thought|think|figured)\b|\bsince you might\b/i,
    why: 'an invented reason performs no better than none — give a real one or none',
  },
  {
    id: 'passive-good-news',
    // Gable: passive-constructive responding to good news predicts POORER
    // outcomes than no response. Benign understatement is a cost.
    test: /\b(nice|great|cool|good)[,.]? (glad|happy) (it|that|you)\b/i,
    why: 'understating good news is worse than silence — respond actively or not at all',
  },
  {
    id: 'fake-urgency',
    test: /\b(act now|expires soon|only \d+ left|limited time|while supplies last)\b/i,
    why: 'manufactured scarcity is the opposite of a concierge',
  },
  {
    id: 'open-the-app',
    // The tap already opens it. Spending one of ~118 characters saying so is
    // spending the only line that could have carried something.
    test: /\b(open (the app|num)|tap (here|to open)|click here|check the app)\b/i,
    why: 'tapping already opens it — the words are wasted',
  },
];

/**
 * Check one piece of copy.
 *
 * Returns every problem rather than the first, so a rewrite fixes the whole
 * line in one pass instead of playing whack-a-mole.
 */
export function lint({ title = '', subtitle = '', body = '' } = {}, { surface = 'push' } = {}) {
  const problems = [];
  const fields = { title, subtitle, body };

  // LENGTH IS A LOCK-SCREEN PROBLEM, NOT A VOICE ONE.
  //
  // The limits exist because a phone truncates a push notification and the cut
  // lands mid-thought. In-app copy — a permission ask, a card, a sheet — has
  // room, and squeezing a good sentence into 34 characters to satisfy a rule it
  // was never under makes the writing worse for no reason.
  //
  // The BANNED rules still apply everywhere. Those are about what NUM is willing
  // to say, which does not change with the size of the box.
  const measured = surface === 'push';

  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue;
    const limit = measured ? LIMITS[field] : null;
    if (limit && text.length > limit) {
      problems.push({
        field, id: 'too-long',
        why: `${text.length} characters — a phone truncates ${field} around ${limit}, and the cut lands mid-thought`,
      });
    }
    for (const rule of BANNED) {
      const m = text.match(rule.test);
      if (m) problems.push({ field, id: rule.id, why: rule.why, found: m[0] });
    }
  }

  // An unresolved placeholder is the worst thing a notification can contain: it
  // arrives on a lock screen, it cannot be recalled, and it says plainly that
  // nobody looked. Caught here because the fallback for a missing name is a
  // design decision, not a template accident.
  for (const [field, text] of Object.entries(fields)) {
    if (/undefined|null|NaN|\{\{|\}\}|\[object/i.test(text)) {
      problems.push({ field, id: 'placeholder', why: 'an unresolved value would go out on a lock screen exactly as written' });
    }
  }

  return problems;
}

export const clean = (copy, opts) => lint(copy, opts).length === 0;

/* ── Shaping helpers ──────────────────────────────────────────────────────── */

/**
 * Somebody's name, or an honest stand-in.
 *
 * Never "there" and never a nickname we invented. The research is specific: an
 * invented nickname is a brand mascot and reads as CRM. If we do not know their
 * name we simply do not use one — a sentence that works without it is better
 * than a sentence with a guess in it.
 */
export const who = (name) => {
  const n = String(name || '').trim();
  return n && !/^(undefined|null)$/i.test(n) ? n.split(/\s+/)[0] : null;
};

/**
 * A time a person would say out loud.
 *
 * "Saturday, 9am" — not "2026-09-20T09:00:00Z", and not "in 3 days". A weekday
 * is how somebody holds a plan in their head; a countdown is how a system holds
 * it. The comma is deliberate: it is a 300-700ms pause instruction, and silent
 * reading produces the same brain response to it as an ear does to a real pause.
 */
export function when(iso, { tz = 'Asia/Bangkok', now = new Date() } = {}) {
  const raw = String(iso ?? '').trim();
  if (!raw) return null;

  // WALL CLOCK OR INSTANT — and getting this wrong tells somebody the wrong time.
  //
  // This codebase stores two different kinds of time in the same-looking string.
  // num_plans.starts_time is a wall clock: what the host typed, already local,
  // meant to be read back unchanged. An ISO instant with a Z or an offset is a
  // real moment that must be converted into the member's zone.
  //
  // Treating the first as the second is not a rounding error. "2026-09-15
  // 09:00:00" run through a Bangkok conversion comes out as 4pm, and a member
  // arrives seven hours late to a boat. So a string carrying no zone is taken at
  // face value and never shifted.
  const hasZone = /(z|[+-]\d{2}:?\d{2})$/i.test(raw);
  // A date with no time at all. num_plans stores the day and the hour in two
  // separate columns and the hour is often blank, so this is common. Saying
  // "Saturday" is true; saying "Saturday, 12am" is a time nobody agreed to.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const d = new Date(dateOnly ? raw + 'T00:00Z' : raw.replace(' ', 'T') + (hasZone ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return null;
  // A zoneless string is displayed in UTC, which is the same arithmetic as
  // "leave it exactly as written".
  if (!hasZone) tz = 'UTC';

  const day = (x) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(d).replace(':00', '').replace(/\s/g, '').toLowerCase();

  const today = day(now);
  const tomorrow = day(new Date(now.getTime() + 86400_000));
  const target = day(d);

  if (target === today) return dateOnly ? 'Today' : `Today, ${time}`;
  if (target === tomorrow) return dateOnly ? 'Tomorrow' : `Tomorrow, ${time}`;

  const within = (d - now) / 86400_000;
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(d);
  if (within > 0 && within < 7) return dateOnly ? weekday : `${weekday}, ${time}`;

  const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' }).format(d);
  return dateOnly ? date : `${date}, ${time}`;
}

/**
 * Trim to a length without leaving a word in pieces.
 *
 * Cuts at the last space and adds nothing. An ellipsis on a lock screen is the
 * phone's job to add, and adding our own just means the sentence is cut twice.
 */
export function fit(text, limit) {
  const t = String(text || '').trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '');
}
