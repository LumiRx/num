// REMINDERS (19 Sep 2026). "Remind me at six to call the hotel."
//
// The first thing a member can ask NUM to do for them later. Until today the
// only reminders in the product were NUM's own ladders (a table three hours
// out, a claim nobody answered); a member had no way to leave themselves a
// note that comes back at a time.
//
// What this is: a row with a text and a UTC time, owned by one member,
// optionally hung on a plan or an item. Every five minutes the cron sends the
// due ones by push (worker/push.mjs — the same notify() every other buzz
// uses) and marks them sent; the app also lands a due reminder in the thread
// when it is open (lib/reminders.ts), so a phone without push still hears it
// while NUM is on screen.
//
// What this is not: SMS. NUM's number carries sign-in codes and has been kept
// to that; a reminder by text is a decision for Dre, not a default.
//
// The client parses the sentence (lib/reminders.ts parseReminder) and sends a
// time; the server stores what it is given and never guesses a time itself.
import { notify } from './push.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_reminders (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  text         TEXT NOT NULL,
  due_at       TEXT NOT NULL,
  plan_id      TEXT,
  item_id      TEXT,
  source       TEXT NOT NULL DEFAULT 'text',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at      TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_num_reminders_member ON num_reminders(member_id, due_at);
CREATE INDEX IF NOT EXISTS idx_num_reminders_due ON num_reminders(sent_at, cancelled_at, due_at);
`;

let ensured = false;
async function ensure(env) {
  if (ensured) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ensured = true;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
const uid = () => 'rem_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

/** A reminder may be set from one minute out to a year out. */
export const MIN_AHEAD_MS = 60_000;
export const MAX_AHEAD_MS = 366 * 86400e3;

/** The shape the app reads. `due_at` is UTC ISO; the app shows it in local time. */
const row = (r) => ({ id: r.id, text: r.text, due_at: r.due_at, plan_id: r.plan_id, item_id: r.item_id, source: r.source, sent_at: r.sent_at, cancelled_at: r.cancelled_at, created_at: r.created_at });

export async function handleReminders(request, env, path) {
  if (!env.DB) return json({ error: 'reminders need the database binding' }, 503);
  await ensure(env);
  const url = new URL(request.url);
  const post = request.method === 'POST';

  // Mine: everything still to come, plus what fired in the last day so the
  // app can show "reminded you at 6" on the day it happened.
  if (path === '/' && !post) {
    const me = clip(url.searchParams.get('me'), 40);
    if (!me) return json({ error: 'me required' }, 400);
    const { results } = await env.DB.prepare(
      `SELECT * FROM num_reminders WHERE member_id = ?1 AND cancelled_at IS NULL
         AND due_at >= datetime('now', '-1 day') ORDER BY due_at LIMIT 100`,
    ).bind(me).all();
    return json({ reminders: (results ?? []).map(row) });
  }

  if (path === '/' && post) {
    const b = await request.json().catch(() => ({}));
    const me = clip(b.me, 40);
    const text = clip(b.text, 200);
    const dueAt = clip(b.due_at, 40);
    if (!me || !text || !dueAt) return json({ error: 'me, text and due_at required' }, 400);
    const member = await env.DB.prepare('SELECT id FROM num_members WHERE id=?1').bind(me).first();
    if (!member) return json({ error: 'sign up first' }, 404);
    const due = Date.parse(dueAt);
    if (!Number.isFinite(due)) return json({ error: 'due_at is an ISO time' }, 400);
    const ahead = due - Date.now();
    if (ahead < MIN_AHEAD_MS) return json({ error: 'That time has already gone — pick one at least a minute out.' }, 400);
    if (ahead > MAX_AHEAD_MS) return json({ error: 'A year out is as far as a reminder goes.' }, 400);
    const id = uid();
    await env.DB.prepare(
      'INSERT INTO num_reminders (id, member_id, text, due_at, plan_id, item_id, source) VALUES (?1,?2,?3,?4,?5,?6,?7)',
    ).bind(id, me, text, new Date(due).toISOString(), clip(b.plan_id, 40), clip(b.item_id, 40), b.source === 'voice' ? 'voice' : 'text').run();
    const r = await env.DB.prepare('SELECT * FROM num_reminders WHERE id=?1').bind(id).first();
    return json({ reminder: row(r) });
  }

  if (path === '/cancel' && post) {
    const b = await request.json().catch(() => ({}));
    const me = clip(b.me, 40);
    const id = clip(b.id, 40);
    if (!me || !id) return json({ error: 'me and id required' }, 400);
    const r = await env.DB.prepare(
      "UPDATE num_reminders SET cancelled_at = datetime('now') WHERE id = ?1 AND member_id = ?2 AND cancelled_at IS NULL AND sent_at IS NULL",
    ).bind(id, me).run();
    return json({ ok: true, cancelled: Number(r.meta?.changes ?? 0) > 0 });
  }

  return json({ error: 'not found' }, 404);
}

/**
 * The cron lane: every reminder whose time has come, once. Marking sent
 * BEFORE the push is deliberate — a push that throws must not make the
 * next tick buzz the same reminder again; a reminder that was marked and
 * never buzzed is still on the member's day in the app.
 */
export async function sendDueReminders(env, { now = new Date() } = {}) {
  if (!env?.DB) return { sent: 0 };
  await ensure(env);
  const { results } = await env.DB.prepare(
    'SELECT * FROM num_reminders WHERE sent_at IS NULL AND cancelled_at IS NULL AND due_at <= ?1 ORDER BY due_at LIMIT 200',
  ).bind(now.toISOString()).all();
  let sent = 0;
  for (const r of results ?? []) {
    const claimed = await env.DB.prepare('UPDATE num_reminders SET sent_at = ?2 WHERE id = ?1 AND sent_at IS NULL').bind(r.id, now.toISOString()).run();
    if (!claimed.meta?.changes) continue;
    sent++;
    await notify(env, {
      memberId: r.member_id, kind: 'reminder', title: 'Reminder', body: r.text,
      url: r.plan_id ? '/?go=plan' : '/?app', tag: `reminder:${r.id}`,
    }).catch((e) => console.warn('[reminders] push', e?.message ?? e));
  }
  return { sent, due: (results ?? []).length };
}
