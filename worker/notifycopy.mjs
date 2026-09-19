// Every notification NUM sends, in one place, in one voice.
//
// Scattered template literals are how a product ends up with four voices: the
// one written on a good day, the one written at 2am, the one copied from a
// competitor, and the one nobody remembers writing. Collected here they can be
// read together, linted together, and argued about as a whole.
//
// The rules they are written to are in worker/notifyvoice.mjs, and the research
// behind those is num-VOICE-HOW-TO-BE-BELIEVED-2026-09-13. The four that shape
// almost every line below:
//
//   1. INVISIBLE SUPPORT. "Table's at 8 — the corner one," never "I saw you
//      were struggling so I sorted it." Help that spotlights inadequacy tested
//      WORSE than no help at all.
//   2. NO ACCOUNTING IN THE CONVERSATION. A communal-framed relationship
//      punishes exchange behaviour far harder than a transactional one punishes
//      warmth. Plans, limits and tiers live on the billing page.
//   3. A REAL REASON OR NONE. An invented because-clause performs exactly as
//      well as no reason at all once the request costs anything.
//   4. NAME THE DELAY. Unexplained silence reduces perceived sincerity
//      monotonically. Explained waiting does not.
//
// Each function returns { title, subtitle, body } — the three lines iOS gives
// us. Subtitle carries the fact so the body can carry the sentence.

import { who, when, fit, LIMITS } from './notifyvoice.mjs';

const trim = (c) => ({
  title: fit(c.title, LIMITS.title),
  ...(c.subtitle ? { subtitle: fit(c.subtitle, LIMITS.subtitle) } : {}),
  body: fit(c.body, LIMITS.body),
});

/* ── Things a person is waiting on ─────────────────────────────────────────
 *
 * The highest-value notifications in the product, because the member already
 * wants them. Nothing here has to earn attention — it only has to be clear.
 */

/** A table, a car, a boat: the thing they asked for is confirmed. */
export const confirmed = ({ what, at, where, detail }) => trim({
  // The NAME, not the category. "Baan Rim Pa", never "Your reservation".
  title: what,
  subtitle: [when(at), where].filter(Boolean).join(' · '),
  // Invisible support: the outcome, and one detail that proves a person looked.
  // No "I managed to get you", no "I had to call twice".
  body: detail || 'Confirmed. Everything is set.',
});

/** It could not be done. A refusal ends in a choice, never a closed door. */
export const couldNot = ({ what, why, alternative }) => trim({
  title: what,
  // The real reason, in their words where possible. A vague "unavailable" is
  // the fabricated-because problem wearing different clothes.
  subtitle: why || null,
  // The choice is IN the substance rather than bolted on as "let me know!" —
  // the postscript version of autonomy support tested weakly.
  body: alternative
    ? `${alternative} Say the word and it's yours.`
    : 'Want me to try somewhere else, or a different night?',
});

/** Something changed after it was confirmed. */
export const changed = ({ what, from, to, note }) => trim({
  title: what,
  subtitle: to ? `Now ${when(to) || to}` : null,
  body: note || (from ? `Moved from ${when(from) || from}. Everything else is the same.` : 'The details moved. Everything else is the same.'),
});

/* ── Money ─────────────────────────────────────────────────────────────────
 *
 * The one place mitigation is DROPPED. Fischer & Orasanu: first officers hint,
 * and both ranks wrongly rate hints as more effective than commands — 75% of
 * the accidents reviewed involved a failure to challenge. Money, passports and
 * allergies are the cockpit. State it flat.
 */

export const paid = ({ amount, to }) => trim({
  title: to ? `Paid ${to}` : 'Payment went through',
  subtitle: amount || null,
  // Verified, and it says WHO verified it. Confident only about what we checked.
  body: 'Stripe confirmed it. The receipt is in your wallet.',
});

export const paymentFailed = ({ amount, what, why }) => trim({
  title: 'That payment did not go through',
  subtitle: [what, amount].filter(Boolean).join(' · '),
  // No softening, no "it looks like there may have been an issue". A bald
  // statement and the one action that fixes it.
  body: `${why || 'The card was declined.'} Nothing has been charged. Another card will fix it.`,
});

export const earned = ({ amount, from, nth }) => trim({
  title: `You earned ${amount}`,
  subtitle: from || null,
  // Good news gets an active response, not a receipt. Gable: the passive
  // version predicts POORER outcomes than saying nothing at all.
  //
  // The second sentence is only added when the COUNT IS KNOWN. The first draft
  // of this line said "that is the third place you brought in" as a constant —
  // a warm sentence that would have been factually wrong for everybody who was
  // not on their third, which is the fabricated-detail failure exactly. A
  // notification that flatters with a made-up number is worse than a plain one.
  body: nth >= 2
    ? `It is in your wallet already. That is ${ordinal(nth)} place you have brought in.`
    : 'It is in your wallet already.',
});

/** "the second", "the third" — for counts a person would actually say out loud. */
function ordinal(n) {
  const names = ['', 'the first', 'the second', 'the third', 'the fourth', 'the fifth',
    'the sixth', 'the seventh', 'the eighth', 'the ninth', 'the tenth'];
  return names[n] || `the ${n}th`;
}

export const cashoutQueued = ({ amount, eta }) => trim({
  title: 'Cash-out on its way',
  subtitle: amount || null,
  // Naming the wait is what converts a delay from insincerity into competence.
  body: eta ? `With the payout desk now. It lands ${eta}, and I'll tell you when.` : "With the payout desk now. I'll tell you the moment it lands.",
});

/* ── People ────────────────────────────────────────────────────────────────── */

/** A message from a real person. The title is the person, always. */
export const message = ({ from, text }) => trim({
  title: who(from) || 'A message',
  body: text || 'Sent you something.',
});

export const addedToPlan = ({ by, plan, at }) => trim({
  title: plan,
  subtitle: when(at),
  // No "open Num to see it" — the tap does that, and the words are the only
  // thing on the screen that could have been useful.
  body: `${who(by) || 'Someone'} put you on this. Are you in?`,
});

/**
 * INVITED, NOT ADDED — and the difference is the whole notification.
 *
 * `addedToPlan` above is true when somebody really is on a plan: they
 * accepted, or they started it. It used to be sent to people who had done
 * neither, because an invite to an existing member wrote them straight into
 * num_plan_members. "Someone put you on this" was accurate about what the
 * code had done and wrong about what should have happened.
 *
 * This is the one that goes out before a yes. It asks, and it names who is
 * asking, because the first thing anybody wants to know about an invitation
 * is who sent it.
 */
export const invitedToPlan = ({ by, plan, at }) => trim({
  title: plan,
  subtitle: when(at),
  body: `${who(by) || 'Someone'} invited you. Have a look?`,
});

export const planTomorrow = ({ plan, at, where, heads_up }) => trim({
  title: plan,
  subtitle: [when(at), where].filter(Boolean).join(' · '),
  // The weather line only appears when it CHANGES what you would do. Fine
  // weather is not news, and a notification about nothing spends the budget
  // that the real one needs.
  body: heads_up || 'Tomorrow. Everything is arranged.',
});

/* ── The concierge speaking first ──────────────────────────────────────────
 *
 * The only category that has to earn its interruption, so it is the only one
 * with a hard rule attached: a suggestion carries something the member could
 * not have known without us, or it is not sent.
 */

export const suggestion = ({ headline, fact, because }) => trim({
  title: headline,
  subtitle: fact || null,
  // `because` is REQUIRED by the caller and never invented here. A suggestion
  // with no real reason behind it performed no better than no reason at all,
  // and building a default would guarantee the fabricated kind.
  body: because,
});

/** Something they told us they wanted, now possible. */
export const nowPossible = ({ what, fact, theirWords }) => trim({
  title: what,
  subtitle: fact || null,
  // Private idioms: >1/3 of solidarity variance is explained by reusing the
  // other person's own phrases. Only ever THEIR words, never an invented
  // nickname — that reads as CRM.
  body: theirWords
    ? `You said you wanted ${theirWords}. This is it.`
    : 'This is the one you were after.',
});

/* ── Asking for something ──────────────────────────────────────────────────── */

/**
 * A rating. The honest version gives THEM the reason, not us.
 *
 * The old copy said "every rating changes what the next guest is shown" — a
 * reason that serves NUM, offered to somebody being asked for a favour. The
 * exchange frame showing through the communal one is precisely what Aggarwal
 * measured the cost of.
 */
export const howWasIt = ({ place }) => trim({
  title: `How was ${place}?`,
  body: "If it was good I'll remember it for you. If it wasn't, I won't send you back.",
});

/* ── The one that asks permission ──────────────────────────────────────────
 *
 * Not a push — this is the in-app moment. It is here because it is the single
 * highest-leverage piece of copy in the whole feature: 2 members of 148 have
 * ever enabled notifications, and the reason is that the only place to do it is
 * a settings screen nobody visits.
 *
 * Asked at the moment there is something worth being told about, which is what
 * src/lib/push.ts has said in a comment since the day it was written.
 */
export const askToTell = ({ about }) => ({
  title: about ? `Want me to tell you when ${about}?` : 'Want me to tell you when it is done?',
  body: "I'll only use it for things you're waiting on. Nothing else, and you can stop it any time.",
  yes: 'Yes, tell me',
  no: 'Not now',
});
