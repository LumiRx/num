/**
 * "Somebody just joined through your link."
 *
 * ── WHY THIS IS ITS OWN FILE AND ITS OWN MOMENT ──────────────────────────
 *
 * Dre, 19 Sep 2026: "people need to know their connections are happening."
 *
 * Until now the only thing that ever told a referrer anything was the
 * notification inside `creditMemberReferral`, which fires when their person
 * SPENDS. That can be weeks after they joined, and it might never happen at
 * all — a member who installs NUM and books nothing earns nobody anything.
 * So the entire feedback loop for referring was: post a link, and then
 * silence, possibly for ever.
 *
 * That is the wrong moment to be quiet. The join is the proof the link works.
 * It is the only moment where somebody finds out their posting did something,
 * and it is free to tell them.
 *
 * ── IT TELLS THE REFERRER, NOT THE NEW MEMBER'S STORY ────────────────────
 *
 * The new person's name is NOT in the notification. They joined NUM, they did
 * not agree to be announced to somebody by name, and "J. just joined" carries
 * the whole of the signal that matters. The referrer learns their link works;
 * the new member keeps their privacy. Nobody needed the full name for this to
 * feel good.
 *
 * ── AND IT NEVER BREAKS A SIGNUP ─────────────────────────────────────────
 *
 * Every path here is caught and swallowed. A person joining NUM must not be
 * able to fail because a push subscription expired or a mail provider was
 * slow. The referral itself is already written by the time this runs.
 */
import { notify } from './push.mjs';

/** One initial, or nothing. See the header — the name is deliberately not used. */
function initial(name) {
  const s = String(name || '').trim();
  return s ? s[0].toUpperCase() + '.' : 'Someone';
}

/**
 * Tell the referrer that somebody joined, and record any milestone it crossed.
 *
 * `referrerId` is a MEMBER id — that is what referred_by holds and what the
 * Star balance hangs off. If that member is also an ambassador, they get the
 * ambassador treatment too: an email, because an ambassador may not have the
 * app open for days, and a milestone check.
 */
export async function announceReferral(env, { referrerId, newMemberName } = {}) {
  if (!env?.DB || !referrerId) return { told: false };
  const out = { told: false, emailed: false, milestones: [] };

  // How many they have brought in, including this one. Worth saying out loud
  // in the notification: "that is 7 now" is a running total somebody can feel,
  // where "somebody joined" alone is the same message every time.
  let count = 0;
  try {
    const c = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM num_members WHERE referred_by = ?1',
    ).bind(String(referrerId)).first();
    count = Number(c?.n ?? 0);
  } catch { /* the notification is still worth sending without the total */ }

  try {
    await notify(env, {
      memberId: String(referrerId),
      kind: 'referral',
      // 34 characters for a title and 118 for a body — worker/notifyvoice.mjs
      // owns those limits because a notification is the one piece of copy
      // that cannot be recalled once it is on a lock screen. The first
      // version of this line was 45 and would have been cut mid-thought.
      // No interpolation in the title. The lock-screen limit is 34 and the
      // linter counts a `${...}` at its widest, so an initial in the title
      // costs eleven characters that the sentence needs more.
      title: 'Your link just brought someone in',
      body: count > 1
        ? `${initial(newMemberName)} joined. That makes ${count} so far — you earn a share of what NUM makes from them.`
        : `${initial(newMemberName)} signed up through your link. You earn a share of what NUM makes from them.`,
      url: '/?app',
      // NOT tagged per-referrer: a tag collapses notifications, and collapsing
      // these would mean the second person to join replaces the first and the
      // referrer only ever sees one. Unique per event on purpose.
      tag: `joined:${referrerId}:${count}`,
    });
    out.told = true;
  } catch (e) {
    console.warn('[announce push]', e?.message ?? e);
  }

  // ── is this referrer an ambassador? ─────────────────────────────────────
  let amb = null;
  try {
    amb = await env.DB.prepare(
      "SELECT id, name, email, status FROM num_ambassadors WHERE member_id = ?1 AND status <> 'ended'",
    ).bind(String(referrerId)).first();
  } catch { /* the table may not exist on an older database — that is fine */ }
  if (!amb) return { ...out, count };

  try {
    const { recordMilestones } = await import('../growth/milestones.mjs');
    out.milestones = await recordMilestones(env, { ambassadorId: amb.id, count });
  } catch (e) {
    console.warn('[announce milestones]', e?.message ?? e);
  }

  try {
    out.emailed = await mailAmbassador(env, { amb, count, milestones: out.milestones });
  } catch (e) {
    console.warn('[announce mail]', e?.message ?? e);
  }

  return { ...out, count };
}

/**
 * The ambassador's email.
 *
 * Sent on a milestone, and on the FIRST join only. Not on every join: an
 * ambassador who is doing well would get forty emails a week and mute the
 * lot, and the one that says "you reached fifty" would be muted with them.
 * The console and the push carry the day-to-day; email is for the two moments
 * that are worth interrupting somebody for.
 */
async function mailAmbassador(env, { amb, count, milestones }) {
  const worthIt = count === 1 || (milestones && milestones.length);
  if (!worthIt || !amb?.email) return false;

  let sendBatch;
  try { ({ sendBatch } = await import('../growth/resend.mjs')); } catch { return false; }
  if (typeof sendBatch !== 'function') return false;
  const first = String(amb.name || '').split(' ')[0] || 'there';
  const site = env.SITE || 'https://itsnum.com';

  const top = milestones && milestones.length
    ? milestones.map((m) => `${m.name.toUpperCase()} — ${m.blurb}`).join('\n')
    : 'Somebody just joined NUM through your link. That is the hard one, and it is done.';

  const { MYSTERY_LINE } = await import('../growth/milestones.mjs');
  const body = `${first},

${top}

You have brought in ${count} ${count === 1 ? 'person' : 'people'} so far.

${milestones && milestones.length ? MYSTERY_LINE + '\n\n' : ''}Your console: ${site}/amb/

Reply to this email and a person answers.

— NUM`;

  await sendBatch(env, [{
    to: [amb.email],
    subject: milestones && milestones.length
      ? `You reached ${milestones[milestones.length - 1].name.toLowerCase()}`
      : 'Your first NUM sign-up',
    text: body,
    tags: [{ name: 'kind', value: milestones && milestones.length ? 'amb_milestone' : 'amb_first' }],
  }]);
  return true;
}
