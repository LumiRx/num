// Leaving: unfriend, delete a plan, delete an account.
//
// Every product builds the joining and forgets the leaving, and the result is
// an app people feel trapped in. Num had NO unfriend, NO way to remove a plan,
// and NO way to delete an account — a stranger with your number could friend
// you permanently and there was nothing you could do about it.
//
// Three principles shape this file:
//
//   1. LEAVING IS NOT AN ERROR. No guilt copy, no "are you sure you want to
//      lose everything", no dark pattern. The confirmation exists only where
//      the action is genuinely irreversible or costs someone else something.
//
//   2. MONEY BLOCKS DELETION, AND SAYS SO. You cannot delete an account
//      holding Stars or standing in an open errand — not to trap you, but
//      because deleting it would either destroy value that is yours or strand
//      a counterparty mid-transaction. The refusal names the number and the
//      way out.
//
//   3. WHAT THE OTHER PERSON SEES IS PART OF THE DESIGN. Unfriending is
//      silent by intent — telling someone "X removed you" invites a
//      confrontation the person was trying to avoid. Leaving a shared plan is
//      NOT silent, because the group is holding a table for you.
import { notify } from './push.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const readBody = async (req) => { try { return await req.json(); } catch { return {}; } };

/**
 * Unfriend. Removes the link in BOTH directions — it is one row read from
 * either end, so one delete is the whole job.
 *
 * DELIBERATELY SILENT. The person most likely to use this is someone who was
 * added by a stranger who had their number, and notifying that stranger turns
 * a quiet exit into a confrontation. The friendship simply stops existing.
 *
 * Also blocks the re-add: `invite()` friends an existing member instantly, so
 * without a block the remover could be re-added seconds later by the same
 * person. A removal that can be undone by the other party is not a removal.
 */
async function unfriend(env, req) {
  const b = await readBody(req);
  const me = clip(b.me, 40);
  const them = clip(b.id, 40);
  if (!me || !them) return json({ error: 'Who should I remove?' }, 400);

  const r = await env.DB.prepare(
    'DELETE FROM num_links WHERE (a_id=?1 AND b_id=?2) OR (a_id=?2 AND b_id=?1)',
  ).bind(me, them).run();

  if (b.block) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO num_blocks (member_id, blocked_id, created_at) VALUES (?1,?2,datetime(\'now\'))',
    ).bind(me, them).run().catch(() => {});
  }

  return json({
    ok: true,
    removed: (r.meta?.changes ?? 0) > 0,
    blocked: !!b.block,
    // Said plainly so the app can be honest in its confirmation.
    note: b.block
      ? 'Removed and blocked — they can’t add you again.'
      : 'Removed. They aren’t told, and they can add you again unless you block them.',
  });
}

/**
 * Delete a plan, or leave one.
 *
 * The owner deletes it for everyone; a member leaves it for themselves. Those
 * are different actions with the same button, and conflating them is how a
 * guest accidentally destroys the host's weekend.
 *
 * Leaving IS announced: the group is holding a table for a party size that
 * just changed, and silence there costs someone a booking.
 */
async function planRemove(env, req) {
  const b = await readBody(req);
  const me = clip(b.me, 40);
  const planId = clip(b.plan_id, 40);
  if (!me || !planId) return json({ error: 'Which plan?' }, 400);

  const plan = await env.DB.prepare('SELECT id, title, owner_id FROM num_plans WHERE id=?1').bind(planId).first();
  if (!plan) return json({ error: 'No such plan.' }, 404);

  const mine = await env.DB.prepare('SELECT member_id FROM num_plan_members WHERE plan_id=?1 AND member_id=?2')
    .bind(planId, me).first();
  if (!mine) return json({ error: 'That isn’t your plan.' }, 403);

  const self = await env.DB.prepare('SELECT name FROM num_members WHERE id=?1').bind(me).first();

  // ── MEMBER: leave ────────────────────────────────────────────────────
  if (plan.owner_id !== me) {
    await env.DB.prepare('DELETE FROM num_plan_members WHERE plan_id=?1 AND member_id=?2').bind(planId, me).run();
    // The rest of the group needs to know the party got smaller — they may be
    // holding a table on the old number.
    const { results } = await env.DB.prepare('SELECT member_id FROM num_plan_members WHERE plan_id=?1 AND member_id<>?2')
      .bind(planId, me).all().catch(() => ({ results: [] }));
    for (const m of results ?? []) {
      await notify(env, {
        memberId: m.member_id, kind: 'plan', title: plan.title,
        body: `${self?.name || 'Someone'} left the plan.`,
        url: '/?app', tag: `plan:${planId}`,
      }).catch(() => {});
    }
    return json({ ok: true, left: true, title: plan.title });
  }

  // ── OWNER: delete for everyone ───────────────────────────────────────
  // Tell the others BEFORE the rows go, or there is nobody left to tell.
  const { results: others } = await env.DB.prepare(
    'SELECT member_id FROM num_plan_members WHERE plan_id=?1 AND member_id<>?2',
  ).bind(planId, me).all().catch(() => ({ results: [] }));
  for (const m of others ?? []) {
    await notify(env, {
      memberId: m.member_id, kind: 'plan', title: plan.title,
      body: `${self?.name || 'The host'} cancelled this plan.`,
      url: '/?app', tag: `plan:${planId}`,
    }).catch(() => {});
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM num_plan_events WHERE plan_id=?1').bind(planId),
    env.DB.prepare('DELETE FROM num_plan_items WHERE plan_id=?1').bind(planId),
    env.DB.prepare('DELETE FROM num_plan_members WHERE plan_id=?1').bind(planId),
    env.DB.prepare('DELETE FROM num_plans WHERE id=?1').bind(planId),
  ]);
  return json({ ok: true, deleted: true, title: plan.title, told: (others ?? []).length });
}

/**
 * Delete an account, and everything of yours in it.
 *
 * TWO STEPS ON PURPOSE. The first returns exactly what will be destroyed and a
 * confirmation phrase; the second does it. Not a dark pattern — this is the
 * one action in the product with no undo, and a person deserves to see the
 * inventory before they agree to it.
 *
 * Blocked while money or obligations are outstanding, because deleting then
 * would either destroy the member's own value or strand a counterparty.
 */
async function accountDelete(env, req) {
  const b = await readBody(req);
  const me = clip(b.me, 40);
  if (!me) return json({ error: 'Who?' }, 400);

  const member = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(me).first();
  if (!member) return json({ error: 'No such account.' }, 404);

  const n = async (sql, ...binds) => {
    const r = await env.DB.prepare(sql).bind(...binds).first().catch(() => null);
    return Number(r?.n ?? 0);
  };
  const stars = await n('SELECT stars n FROM num_star_balances WHERE member_id=?1', me);
  const liveErrands = await n(
    "SELECT COUNT(*) n FROM num_errands WHERE (poster_id=?1 OR runner_id=?1) AND state NOT IN ('settled','cancelled')", me);
  const openTabs = await n(
    "SELECT COUNT(*) n FROM num_tab_members tm JOIN num_tabs t ON t.id=tm.tab_id WHERE tm.member_id=?1 AND t.state='open'", me);

  const inventory = {
    stars,
    friends: await n("SELECT COUNT(*) n FROM num_links WHERE (a_id=?1 OR b_id=?1) AND state='active'", me),
    plans_owned: await n('SELECT COUNT(*) n FROM num_plans WHERE owner_id=?1', me),
    plans_joined: await n('SELECT COUNT(*) n FROM num_plan_members WHERE member_id=?1', me),
    messages: await n('SELECT COUNT(*) n FROM num_dm WHERE from_id=?1 OR to_id=?1', me),
    live_errands: liveErrands,
    open_tabs: openTabs,
  };

  // ── Things that must be settled first ────────────────────────────────
  const blockers = [];
  if (stars > 0) {
    blockers.push(`You still hold ★${stars.toLocaleString()}. Spend it or cash out what's earned first — deleting would destroy it.`);
  }
  if (liveErrands > 0) {
    blockers.push(`${liveErrands} errand${liveErrands === 1 ? ' is' : 's are'} still running. Finishing or cancelling them first keeps the other person whole.`);
  }
  if (openTabs > 0) {
    blockers.push(`You're on ${openTabs} open tab${openTabs === 1 ? '' : 's'}. Settle up and the rest of the table isn't left short.`);
  }

  // Step one: show them the inventory. No `confirm`, no deletion.
  if (b.confirm !== 'DELETE') {
    return json({
      ok: false,
      needs_confirm: true,
      confirm_with: 'DELETE',
      inventory,
      blockers,
      can_delete: blockers.length === 0,
      note: blockers.length
        ? 'A couple of things to settle first — none of them take long.'
        : 'This removes your account and everything above. It cannot be undone.',
    }, 200);
  }

  if (blockers.length) return json({ ok: false, blockers, inventory }, 409);

  // ── Do it ────────────────────────────────────────────────────────────
  // Plans this member OWNS are deleted with their contents; plans they merely
  // joined just lose them. Anything shared that others still need — a tab's
  // settled history, an errand's record — keeps its row, because deleting it
  // would rewrite someone else's ledger.
  const owned = await env.DB.prepare('SELECT id FROM num_plans WHERE owner_id=?1').bind(me).all().catch(() => ({ results: [] }));
  for (const p of owned.results ?? []) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM num_plan_events WHERE plan_id=?1').bind(p.id),
      env.DB.prepare('DELETE FROM num_plan_items WHERE plan_id=?1').bind(p.id),
      env.DB.prepare('DELETE FROM num_plan_members WHERE plan_id=?1').bind(p.id),
      env.DB.prepare('DELETE FROM num_plans WHERE id=?1').bind(p.id),
    ]).catch(() => {});
  }

  const wipe = [
    'DELETE FROM num_plan_members WHERE member_id=?1',
    'DELETE FROM num_links WHERE a_id=?1 OR b_id=?1',
    'DELETE FROM num_dm WHERE from_id=?1 OR to_id=?1',
    'DELETE FROM num_push_subs WHERE member_id=?1',
    'DELETE FROM num_notifications WHERE member_id=?1',
    'DELETE FROM num_prefs WHERE member_id=?1',
    'DELETE FROM num_inbox WHERE member_id=?1',
    'DELETE FROM num_star_balances WHERE member_id=?1',
    'DELETE FROM num_blocks WHERE member_id=?1 OR blocked_id=?1',
    'DELETE FROM num_members WHERE id=?1',
  ];
  for (const sql of wipe) {
    await env.DB.prepare(sql).bind(me).run().catch((e) => console.warn('[delete]', sql.slice(12, 40), e?.message));
  }

  console.log('[account] deleted', me);
  return json({ ok: true, deleted: true, removed: inventory });
}

export async function handleAccount(request, env, path) {
  const post = request.method === 'POST';
  // One-time table for blocks; everything else already exists.
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS num_blocks (member_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at TEXT, PRIMARY KEY (member_id, blocked_id))',
  ).run().catch(() => {});

  if (path === '/unfriend' && post) return await unfriend(env, request);
  if (path === '/plan/remove' && post) return await planRemove(env, request);
  if (path === '/delete' && post) return await accountDelete(env, request);
  return json({ error: 'not found' }, 404);
}

/** Is `them` blocked by `me`? Used by invite() to make a removal stick. */
export async function isBlocked(env, me, them) {
  if (!me || !them) return false;
  const r = await env.DB.prepare(
    'SELECT 1 x FROM num_blocks WHERE (member_id=?1 AND blocked_id=?2) OR (member_id=?2 AND blocked_id=?1)',
  ).bind(me, them).first().catch(() => null);
  return !!r;
}
