/**
 * THE DESK — where a person answers a business.
 *
 * Every route here is under /api/admin/ and guarded by adminGuard, because
 * this surface can read what a business wrote to us and send mail in NUM's
 * name. worker/adminroutes.test.mjs walks the router and fails on any
 * /api/admin/ handler that does not call the guard, which is the reason it is
 * called at the top of this file's dispatcher rather than per route: one gate,
 * impossible to add a route behind by accident.
 *
 *   GET  /api/admin/biz/desk              what is waiting, oldest first
 *   GET  /api/admin/biz/funnel            the whole funnel, counted
 *   GET  /api/admin/biz/thread?id=        one conversation, with their state
 *   POST /api/admin/biz/draft             draft a reply (sends nothing)
 *   POST /api/admin/biz/send              approve a draft and send it
 *   POST /api/admin/biz/decline           throw a draft away, and keep it
 *   POST /api/admin/biz/note              add a note to a thread
 *   POST /api/admin/biz/followup          the one-time clicker follow-up
 *
 * SEND AND DRAFT ARE SEPARATE ROUTES ON PURPOSE. Not a flag on one route: a
 * boolean that decides whether mail leaves the building is a boolean somebody
 * will default wrong. Sending is its own verb and takes a name.
 */

import { adminGuard } from './adminkey.mjs';
import { waiting, conversation, threadById, setState, record } from './bizthread.mjs';
import { stateOf, funnel } from './bizstate.mjs';
import { draftReply, approveAndSend, decline } from './bizreply.mjs';
import { runFollowup } from './bizfollowup.mjs';

const J = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function handleBizDesk(request, env, path) {
  const denied = adminGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const post = request.method === 'POST';
  const body = post ? await request.json().catch(() => ({})) : {};

  if (path === '/desk' && request.method === 'GET') {
    const rows = await waiting(env, { limit: Number(url.searchParams.get('limit')) || 50 });
    // Their onboarding state comes with the list, not on a second click. The
    // whole point is that somebody can answer without going and looking six
    // things up, which is what nobody was doing.
    const out = [];
    for (const t of rows) {
      const s = await stateOf(env, { email: t.email, placeId: t.place_id, businessId: t.business_id }).catch(() => null);
      out.push({
        thread_id: t.id, email: t.email, business: t.business_name,
        waiting_hours: t.waiting_hours, last_message: String(t.last_message ?? '').slice(0, 400),
        step: s?.step ?? null, next: s?.next ?? null,
      });
    }
    return J({ waiting: out, count: out.length });
  }

  if (path === '/funnel' && request.method === 'GET') {
    const f = await funnel(env);
    return J({
      funnel: f,
      // Stated rather than left to be worked out. 3,538 invitations and two
      // verified businesses is the fact that should decide what gets built,
      // and a column of raw counts lets everyone avoid noticing it.
      note: f && f.invited
        ? `${f.invited} invited, ${f.clicked} reached the claim page, ${f.applied} filled the form, `
          + `${f.verified} proved a listing, ${f.configured} said how bookings should reach them.`
        : null,
    });
  }

  if (path === '/thread' && request.method === 'GET') {
    const id = url.searchParams.get('id');
    const t = await threadById(env, id);
    if (!t) return J({ error: 'no such thread' }, 404);
    const [msgs, s] = await Promise.all([
      conversation(env, t.id),
      stateOf(env, { email: t.email, placeId: t.place_id, businessId: t.business_id }).catch(() => null),
    ]);
    return J({ thread: t, messages: msgs, state: s });
  }

  if (path === '/draft' && post) {
    const out = await draftReply(env, body.thread_id, { by: body.by || 'desk' });
    // A refusal is a normal outcome and carries its reason and the text that
    // was refused. Hiding those would make the guard unimprovable.
    return J(out, out.ok ? 200 : 422);
  }

  if (path === '/send' && post) {
    if (!body.by) return J({ ok: false, why: 'who is approving this? send { by: "dre" }' }, 400);
    const out = await approveAndSend(env, body.message_id, body.by);
    return J(out, out.ok ? 200 : 422);
  }

  if (path === '/decline' && post) {
    await decline(env, body.message_id, body.by, body.why);
    return J({ ok: true });
  }

  if (path === '/note' && post) {
    if (!body.thread_id || !body.text) return J({ ok: false, why: 'thread_id and text' }, 400);
    const out = await record(env, body.thread_id, {
      direction: 'out', channel: 'note', body: String(body.text),
      state: 'sent', draftedBy: body.by || 'desk',
    });
    if (body.state) await setState(env, body.thread_id, body.state, { owner: body.by });
    return J(out);
  }

  if (path === '/followup' && post) {
    // dryRun defaults to true in runFollowup and the caller must say
    // `send: true` to change that. These are real businesses who already gave
    // us the benefit of the doubt once.
    const out = await runFollowup(env, {
      limit: Math.min(Number(body.limit) || 40, 100),
      dryRun: body.send !== true,
    });
    return J(out);
  }

  return J({ error: `no such desk route: ${request.method} ${path}` }, 404);
}
