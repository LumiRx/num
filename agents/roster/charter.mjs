/**
 * The charter every NUM agent inherits, and the reason there is one.
 *
 * Dre asked for "an agent that can build agents to always fill new positions".
 * That is the right instinct and it is also the fastest way a company destroys
 * itself, because the first thing an unconstrained agent-builder does is make
 * an agent that emails 14,403 businesses tonight. The queue exists. The key is
 * set. Nothing technical is stopping it.
 *
 * So the builder is not the interesting part — spawning a worker is twenty
 * lines. THE CONSTRAINT SYSTEM IS THE PRODUCT. An agent here cannot be created
 * without a charter, a charter cannot omit the house rules, and the house
 * rules are the same sentences the brand is sold on.
 *
 * ── the house rules
 *
 * These are not aspirations. Each one is already enforced somewhere in this
 * codebase and each one is load-bearing for a promise made in public:
 *
 *   PLACEMENT      gate.test.mjs fails the build if the merchant page implies
 *                  placement is purchasable. learn.test.mjs fails it if money
 *                  can reach the ranking. No agent may say otherwise.
 *   TRUTH          NUM states what the directory holds and says when it does
 *                  not know. An agent that improvises a fact is worse than an
 *                  agent that sends nothing.
 *   CONSENT        num_optouts, num_suppressions and num_sms_consent exist and
 *                  are checked before every send. Failing closed is the only
 *                  acceptable failure.
 *   PACE           invitecron.mjs ramps 50/150/400/800/1500 a day and sends
 *                  Tue-Thu inside two named windows. An agent may not outrun
 *                  the ramp because it is in a hurry.
 *   REVIEW         nothing an agent submits reaches a traveller unread.
 *   IDENTITY       an agent says it is NUM, and says it is automated where the
 *                  law requires it (California and Germany, per Meta's own
 *                  messaging policy; equivalents elsewhere).
 *
 * ── the shape of a charter
 *
 * `may` and `never` are both required and both explicit. An agent with an
 * empty `never` is not a cautious agent, it is an undescribed one — and the
 * spawner refuses it. `budget` is required for the same reason: an agent with
 * no ceiling has a ceiling of "everything in the database".
 */

/** Actions no NUM agent may ever take, whatever its role. */
export const FORBIDDEN = Object.freeze({
  sell_placement:
    'Offer, imply or negotiate better placement, ranking or visibility in exchange for money, '
    + 'signup, data or any other consideration. Placement is not for sale and two tests fail the '
    + 'build if it becomes so.',
  invent_fact:
    'State anything about a place, a price, an opening time or a person that the directory does '
    + 'not hold. Saying "I do not know" is always available and always preferred.',
  contact_opted_out:
    'Message anyone on num_optouts or num_suppressions, or any number without consent in '
    + 'num_sms_consent. Checked before every send; a failed check is a stop, not a warning.',
  publish_unreviewed:
    'Make anything submitted by an agent visible to a traveller without a person at 5arz '
    + 'reading it first.',
  impersonate_human:
    'Claim or imply that the sender is a human being. NUM is a named voice, not a fake person — '
    + 'the failure mode that killed Meta\'s AI profiles was claiming humanity, not being synthetic.',
  take_from_tip:
    'Take, hold, net off or route any part of a gratuity. It is the server\'s money.',
  outrun_ramp:
    'Send outside the configured windows or above the daily cap, for any reason including a '
    + 'deadline, a demo or a founder asking nicely.',
});

/** Every agent must declare a kill switch that a human can reach in one step. */
export const KILL_VAR = 'AGENTS_PAUSED';

/**
 * Build a charter. Throws rather than returning an invalid one — a half-valid
 * charter is how a constraint system becomes decorative.
 *
 * @param {object} o
 * @param {string} o.id        stable slug, e.g. 'outreach-email'
 * @param {string} o.role      one sentence: what this agent is for
 * @param {string[]} o.may     explicit permitted actions
 * @param {string[]} o.never   role-specific prohibitions, on top of FORBIDDEN
 * @param {object} o.budget    { perRun, perDay } hard ceilings
 * @param {object} [o.windows] { days:[1-7], utcHours:[…] } when it may act
 * @param {string[]} [o.requires] preconditions that must be TRUE to run at all
 */
export function charter(o = {}) {
  const need = ['id', 'role', 'may', 'never', 'budget'];
  for (const k of need) {
    if (o[k] == null) throw new Error(`charter: ${k} is required — an agent without ${k} is undescribed, not permissive`);
  }
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(o.id)) throw new Error(`charter: bad id ${o.id}`);
  if (!Array.isArray(o.may) || !o.may.length) throw new Error('charter: may must list at least one permitted action');
  if (!Array.isArray(o.never)) throw new Error('charter: never must be an array');
  if (!(o.budget.perRun > 0) || !(o.budget.perDay > 0)) {
    throw new Error('charter: budget.perRun and budget.perDay must both be positive — an agent with no ceiling has a ceiling of the whole database');
  }
  if (o.budget.perRun > o.budget.perDay) throw new Error('charter: perRun exceeds perDay');

  // The house rules are merged in, not offered as an option.
  const never = Object.freeze([...Object.values(FORBIDDEN), ...o.never]);

  return Object.freeze({
    id: o.id,
    role: o.role,
    may: Object.freeze([...o.may]),
    never,
    budget: Object.freeze({ ...o.budget }),
    windows: o.windows ? Object.freeze({ ...o.windows }) : null,
    requires: Object.freeze([...(o.requires || [])]),
    killVar: KILL_VAR,
  });
}

/**
 * May this agent act right now?
 *
 * Returns a REASON when the answer is no, because "the agent did nothing last
 * night" with no explanation is how an automated system quietly stops working
 * and nobody notices for three weeks.
 *
 * @returns {{ok:boolean, reason?:string}}
 */
export function canAct(ch, { env = {}, now = new Date(), state = {} } = {}) {
  if (String(env[KILL_VAR] || '').toLowerCase() === 'true') {
    return { ok: false, reason: `paused: ${KILL_VAR} is set` };
  }
  for (const req of ch.requires) {
    if (!state[req]) return { ok: false, reason: `precondition not met: ${req}` };
  }
  if (ch.windows) {
    const day = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
    if (ch.windows.days && !ch.windows.days.includes(day)) {
      return { ok: false, reason: `outside send days (today is ${day})` };
    }
    if (ch.windows.utcHours && !ch.windows.utcHours.includes(now.getUTCHours())) {
      return { ok: false, reason: `outside send window (${now.getUTCHours()}:00 UTC)` };
    }
  }
  const sent = state.sentToday || 0;
  if (sent >= ch.budget.perDay) {
    return { ok: false, reason: `daily budget spent (${sent}/${ch.budget.perDay})` };
  }
  return { ok: true };
}

/** How many this run may do, given what the day has already spent. */
export const allowance = (ch, sentToday = 0) =>
  Math.max(0, Math.min(ch.budget.perRun, ch.budget.perDay - sentToday));

/**
 * The last line of defence: read the message an agent is about to send and
 * refuse it if it breaks a house rule.
 *
 * Crude on purpose. A regex cannot understand intent, and a model asked to
 * check its own output will pass its own output. What this catches is the
 * specific, recurring, expensive phrases — the ones that turn a marketing
 * email into a broken promise. Catching four things reliably beats claiming
 * to catch everything.
 */
const TRIPWIRES = Object.freeze([
  { re: /\b(top of (the )?(list|results|search)|rank(ed)? (you )?higher|boost your (position|ranking|visibility)|featured placement|pay to (rank|feature|appear)|priority listing|premium placement)\b/i,
    rule: 'sell_placement' },
  { re: /\b(guarantee[ds]? (you )?(more )?(bookings|customers|revenue|covers)|we guarantee)\b/i,
    rule: 'invent_fact', why: 'NUM cannot guarantee an outcome it does not control' },
  { re: /\b(I am a (real )?(person|human)|speaking as a human|this is not automated)\b/i,
    rule: 'impersonate_human' },
  { re: /\bverified (restaurants?|bars?|hotels?|venues?|places?|businesses|business|listings?)\b/i,
    rule: 'invent_fact', why: '"verified" describes a person or a claimed listing, never a place' },
]);

/** @returns {Array<{rule:string, why:string, match:string}>} empty when clean. */
export function screen(text) {
  const s = String(text || '');
  const hits = [];
  for (const t of TRIPWIRES) {
    const m = s.match(t.re);
    if (m) hits.push({ rule: t.rule, why: t.why || FORBIDDEN[t.rule], match: m[0] });
  }
  return hits;
}
