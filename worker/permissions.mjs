// Who is allowed to reach whom.
//
// Agent-to-agent invites change the threat model. Every other invite path in
// Num goes out through the member's OWN phone — a text they typed and sent —
// so the recipient's consent is implicit in the fact that they know the
// sender's number. An agent invite has no such gate: one member's Num speaks
// directly into another member's Num, on a channel neither person typed into.
//
// So the RECIPIENT owns the door, and this module is the door:
//
//   'friends'  (default) — only people they are actually connected to.
//   'public'            — anyone on Num may ask. For a host, a promoter, a
//                          business: someone whose whole point is being
//                          reachable by people they have not met yet.
//   'off'               — nobody. The switch, for when a week is full or a
//                          trip is over.
//
// The default is 'friends' rather than 'public' on purpose. A default that
// opens a channel is a default nobody chose; a member who wants to be
// reachable can say so in one tap, and a member who never opens the setting is
// still only reachable by people they already agreed to.
//
// Note what this does NOT gate: it gates the ASK, not the answer. A permitted
// invite still arrives as a question the recipient answers yes or no. Nothing
// is added to anyone's calendar, plan or thread until they say yes.

export const INVITE_POLICIES = new Set(['friends', 'public', 'off']);
export const DEFAULT_INVITE_POLICY = 'friends';

/**
 * How many invites one sender may leave hanging with one recipient.
 *
 * This is the anti-nag rule, and it is per-PAIR rather than a global rate
 * limit because that is the shape of the actual problem: nobody minds a
 * hundred invites a day from a hundred different people, and everybody minds
 * four unanswered ones from the same person. Silence is an answer, and after
 * three the sender has had it.
 */
export const MAX_PENDING_PER_PAIR = 3;

/**
 * `invite_policy` is added lazily, the same way the rest of the social schema
 * is: a fresh D1 needs no migration step, and an existing one gets the column
 * on the next request. "duplicate column" is the expected outcome on every
 * deploy after the first.
 */
let ensured = false;
export async function ensurePermissions(env) {
  if (ensured) return;
  for (const alter of [
    `ALTER TABLE num_members ADD COLUMN invite_policy TEXT NOT NULL DEFAULT '${DEFAULT_INVITE_POLICY}'`,
    'ALTER TABLE num_members ADD COLUMN invite_policy_at TEXT',
  ]) {
    try {
      await env.DB.prepare(alter).run();
    } catch (err) {
      if (!/duplicate column/i.test(err?.message ?? '')) console.warn('[permissions] migration:', err?.message);
    }
  }
  ensured = true;
}

/**
 * Read the whole row rather than the one column.
 *
 * `SELECT invite_policy` throws outright on a deployment where the migration
 * has not landed yet, which would turn a missing column into a failed invite.
 * `SELECT *` cannot fail that way, and the ?? below is then a real default
 * rather than a guess.
 */
export async function memberPolicy(env, memberId) {
  if (!memberId) return null;
  const row = await env.DB.prepare('SELECT * FROM num_members WHERE id=?1').bind(memberId).first();
  if (!row) return null;
  const policy = INVITE_POLICIES.has(row.invite_policy) ? row.invite_policy : DEFAULT_INVITE_POLICY;
  return { id: row.id, name: row.name, avatar: row.avatar ?? null, policy };
}

export async function setInvitePolicy(env, memberId, policy) {
  if (!INVITE_POLICIES.has(policy)) return null;
  const res = await env.DB.prepare("UPDATE num_members SET invite_policy=?2, invite_policy_at=datetime('now') WHERE id=?1")
    .bind(memberId, policy).run();
  return res.meta?.changes ? policy : null;
}

/** Connected, in either direction — friendship is not directional. */
export async function areFriends(env, a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM num_links WHERE state='active' AND ((a_id=?1 AND b_id=?2) OR (a_id=?2 AND b_id=?1)) LIMIT 1",
  ).bind(a, b).first();
  return !!row;
}

/**
 * May `fromId`'s Num ask `toId`'s Num to join something?
 *
 * Returns a plain answer with a line the sender's agent can actually say. The
 * refusals are deliberately vague about WHICH rule stopped it — "not taking
 * invites right now" covers both 'off' and 'friends', so a stranger probing
 * member ids cannot map out who has switched what on. The one case we are
 * explicit about is the nag cap, because that one is the sender's own doing
 * and they can fix it by waiting.
 */
export async function canInvite(env, fromId, toId) {
  if (!fromId || !toId) return { ok: false, reason: 'missing', message: 'Who is this for?' };
  if (fromId === toId) return { ok: true, policy: 'self' };

  const to = await memberPolicy(env, toId);
  if (!to) return { ok: false, reason: 'unknown_member', message: 'Nobody on Num has that code.' };
  const them = to.name || 'They';

  if (to.policy === 'off') {
    return { ok: false, reason: 'closed', policy: to.policy, message: `${them} isn’t taking invites right now.` };
  }
  if (to.policy === 'friends' && !(await areFriends(env, fromId, toId))) {
    return {
      ok: false,
      reason: 'not_connected',
      policy: to.policy,
      // The useful next step, not just a refusal: connecting is the thing that
      // would make this work, and it is one tap away.
      message: `${them} only takes invites from people they’re connected to. Send them a connection request first.`,
      remedy: 'connect',
    };
  }

  const pending = await env.DB.prepare(
    "SELECT COUNT(*) n FROM num_event_guests WHERE member_id=?1 AND invited_by=?2 AND rsvp='pending'",
  ).bind(toId, fromId).first().catch(() => ({ n: 0 }));
  if ((pending?.n ?? 0) >= MAX_PENDING_PER_PAIR) {
    return {
      ok: false,
      reason: 'too_many_pending',
      policy: to.policy,
      message: `${them} hasn’t answered your last ${pending.n} invites — give them a moment before sending another.`,
    };
  }

  return { ok: true, policy: to.policy, to };
}
