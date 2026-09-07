/**
 * "SOMETHING IS WRONG" — the tab that had nowhere to go.
 *
 * ── WHY (7 Sep 2026) ──────────────────────────────────────────────────────
 *
 * Dre: "we need to create a support tab for people to submit any issues that
 * they're having."
 *
 * Until now a guest with a problem had exactly two options: say it to the
 * concierge, where it became a conversation Num could not act on, or find
 * info@itsnum.com on the website. Neither reaches anyone reliably, and the
 * evidence is in the database — 33 rows in `feature_requests`, every one still
 * `status = 'new'`, several months old. When there is no door, people knock on
 * the wall and we call it silence.
 *
 * ── THE ONE DESIGN DECISION ───────────────────────────────────────────────
 *
 * A support ticket is worthless without context, and context asked for is
 * context not given: nobody fills in "what version are you running". So the
 * ticket CARRIES it. Version, platform, destination, whether they are signed
 * in, and — when they tick the box — the last thing they asked Num. The person
 * writes one sentence; the ticket arrives with everything needed to reproduce.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not promise a reply time we have no staff to keep, it does not
 * auto-close, and it does not answer with a bot. A support queue that replies
 * "thanks for your feedback" is worse than a quiet one — it teaches people
 * their report went nowhere while looking like it went somewhere.
 *
 * Anyone may file, signed in or not: the guest most likely to hit a bug is the
 * one who could not finish signing up.
 */
import { send, AUDIENCE } from './mailer.mjs';

const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);
const uid = () => `sup_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

/** What a person can say is wrong. Kept short — a long list is a quiz. */
export const KINDS = Object.freeze([
  { id: 'broken', label: 'Something is broken' },
  { id: 'wrong', label: 'Num got something wrong' },
  { id: 'account', label: 'Sign-in or my account' },
  { id: 'billing', label: 'Payment or billing' },
  { id: 'business', label: 'My business listing' },
  { id: 'idea', label: 'An idea or a request' },
  { id: 'other', label: 'Something else' },
]);
const KIND_IDS = new Set(KINDS.map((k) => k.id));

/** open → seen → answered → closed. A ticket is never closed by a machine. */
export const STATES = Object.freeze(['open', 'seen', 'answered', 'closed']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_support_tickets (
  id           TEXT PRIMARY KEY,
  member_id    TEXT,
  business_id  TEXT,
  host_id      TEXT,
  kind         TEXT NOT NULL DEFAULT 'other',
  body         TEXT NOT NULL,
  contact      TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  version      TEXT,
  platform     TEXT,
  dest         TEXT,
  last_ask     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at  TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_status ON num_support_tickets(status, created_at);
CREATE INDEX IF NOT EXISTS idx_support_member ON num_support_tickets(member_id, created_at);
`;

let ready = new WeakSet();
async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run().catch(() => {});
  }
  ready.add(env.DB);
}

/**
 * File a ticket.
 *
 * Refuses only two things: an empty description, and a body so long it is a
 * paste of something else. Everything else is accepted — a support form that
 * argues with somebody who is already having a bad time is the wrong shape.
 */
export async function fileTicket(env, input = {}, ctx = {}) {
  if (!env?.DB) return { ok: false, error: 'Support is momentarily unavailable — please try again shortly.' };
  const body = clip(input.body, 4000);
  if (!body || body.length < 4) {
    return { ok: false, error: 'Tell us what happened, in a line or two — that is all we need to start.' };
  }
  await ensure(env);

  const kind = KIND_IDS.has(String(input.kind)) ? String(input.kind) : 'other';
  const id = uid();
  try {
    await env.DB.prepare(
      `INSERT INTO num_support_tickets
         (id, member_id, business_id, host_id, kind, body, contact, version, platform, dest, last_ask)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    ).bind(
      id, clip(input.me, 40), clip(input.business_id, 40), clip(input.host_id, 40),
      kind, body, clip(input.contact, 160),
      clip(ctx.version, 20), clip(ctx.platform, 40), clip(ctx.dest, 40),
      // Only when they ticked the box. The last thing somebody asked a
      // concierge is private by default, and it is not ours to attach to a
      // support ticket because it would be convenient for us.
      input.include_last_ask ? clip(ctx.lastAsk, 400) : null,
    ).run();
  } catch (e) {
    console.warn('[support] file', e?.message ?? e);
    return { ok: false, error: 'That did not save. Try once more, or email info@itsnum.com and a person will pick it up.' };
  }

  // Told to a human, once, best effort. A ticket nobody is told about is a row.
  if (env.SUPPORT_EMAIL || env.MAIL_FROM) {
    const who = input.me ? `member ${clip(input.me, 40)}` : (clip(input.contact, 160) ?? 'not signed in');
    send(env, {
      to: env.SUPPORT_EMAIL || 'info@itsnum.com',
      subject: `[support] ${kind} — ${body.slice(0, 60)}`,
      text: [
        body, '',
        `who: ${who}`,
        `kind: ${kind}`,
        ctx.version ? `version: ${ctx.version}` : null,
        ctx.platform ? `platform: ${ctx.platform}` : null,
        ctx.dest ? `where: ${ctx.dest}` : null,
        input.include_last_ask && ctx.lastAsk ? `last ask: ${ctx.lastAsk}` : null,
        `ticket: ${id}`,
      ].filter(Boolean).join('\n'),
      __idem: `support-${id}`,
    }, { audience: AUDIENCE.INTERNAL }).catch((e) => console.warn('[support] mail', e?.message ?? e));
  }

  return {
    ok: true,
    id,
    // Said plainly, and true. No promised reply time we cannot keep.
    message: 'Thank you — that is with us. If you left a way to reach you, a person will come back to you.',
  };
}

/** A person's own tickets, so "did that go anywhere" has an answer. */
export async function ticketsFor(env, { memberId, businessId, hostId } = {}) {
  if (!env?.DB) return [];
  const key = memberId ? 'member_id' : businessId ? 'business_id' : hostId ? 'host_id' : null;
  const val = memberId ?? businessId ?? hostId;
  if (!key || !val) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT id, kind, body, status, created_at, answered_at, note
       FROM num_support_tickets WHERE ${key}=?1 ORDER BY created_at DESC LIMIT 25`,
  ).bind(val).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/** The queue, for whoever is actually reading it. Oldest open first. */
export async function queue(env, { status = 'open', limit = 50 } = {}) {
  if (!env?.DB) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT id, member_id, business_id, host_id, kind, body, contact, status,
            version, platform, dest, last_ask, created_at
       FROM num_support_tickets
      WHERE (?1 = 'all' OR status = ?1)
      ORDER BY created_at ASC LIMIT ?2`,
  ).bind(status, Math.min(Number(limit) || 50, 200)).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/** Move a ticket along. Only a person does this — nothing here auto-closes. */
export async function setStatus(env, { id, status, note = null }) {
  if (!env?.DB || !id || !STATES.includes(status)) return { ok: false, error: 'unknown status' };
  await ensure(env);
  const r = await env.DB.prepare(
    `UPDATE num_support_tickets
        SET status=?2, note=COALESCE(?3, note), updated_at=datetime('now'),
            answered_at=CASE WHEN ?2 IN ('answered','closed') THEN datetime('now') ELSE answered_at END
      WHERE id=?1`,
  ).bind(id, status, clip(note, 1000)).run().catch(() => ({ meta: { changes: 0 } }));
  return r.meta.changes ? { ok: true, status } : { ok: false, error: 'no such ticket' };
}

const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
});

/** POST /api/support · GET /api/support/mine · GET /api/support/kinds */
export async function handleSupport(request, env, url) {
  const path = url.pathname.replace(/^\/api\/support/, '') || '/';

  if (path === '/kinds' && request.method === 'GET') return json({ kinds: KINDS });

  if (path === '/mine' && request.method === 'GET') {
    return json({
      tickets: await ticketsFor(env, {
        memberId: clip(url.searchParams.get('me'), 40),
        businessId: clip(url.searchParams.get('business_id'), 40),
        hostId: clip(url.searchParams.get('host_id'), 40),
      }),
    });
  }

  if (path === '/' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const out = await fileTicket(env, b, {
      // Context the CLIENT knows and the server can trust enough for triage.
      version: b.version ?? env.NUM_VERSION ?? null,
      platform: b.platform ?? request.headers.get('User-Agent')?.slice(0, 40) ?? null,
      dest: b.dest ?? null,
      lastAsk: b.last_ask ?? null,
    });
    return json(out, out.ok ? 200 : 400);
  }

  return json({ error: 'not found' }, 404);
}
