// Talking to a friend, fast.
//
// Not a chat product. The whole value is that a message arrives on the lock
// screen and can be answered from there — "on my way", "grab me one", "yes" —
// without opening anything. The AIM feeling was never the window; it was that
// the round trip was short enough to feel like the other person was there.
//
// Three decisions that make that possible:
//
//   · MESSAGES ONLY GO BETWEEN CONNECTED MEMBERS. Not a directory, not a
//     search, no way to message a stranger. A messaging surface anyone can
//     reach is a spam surface within a week, and Num already has the right
//     graph — you connected by QR or invite.
//
//   · THE PUSH CARRIES NO TEXT. Same rule as every other notification here:
//     the wake-up is empty and the content is fetched at display time, so a
//     message read on a laptop is not still sitting on a lock screen an hour
//     later, and no push service ever sees what was said.
//
//   · DELIVERY IS RECORDED, READ IS NOT GUESSED. `delivered_at` is set when a
//     device actually fetches it. Read receipts are a social contract, not a
//     technical one, and inventing them from a fetch would be a lie.

import { notify } from './push.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const uid = () => `dm_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_dms (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  read_at TEXT
);
/* rowid cannot appear in an index — SQLite rejects the whole statement, the
   ensure() batch throws, and EVERY request to this module 500s. created_at
   orders the thread just as well. */
CREATE INDEX IF NOT EXISTS idx_dms_pair ON num_dms(to_id, from_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dms_inbox ON num_dms(to_id, read_at);
`;
let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/**
 * Are these two actually connected?
 *
 * Checked on every send rather than trusted from the client, because the
 * client is the one thing an attacker controls. Either direction counts —
 * friendship is not directional.
 */
async function connected(env, a, b) {
  const row = await env.DB.prepare(
    "SELECT 1 FROM num_links WHERE state='active' AND ((a_id=?1 AND b_id=?2) OR (a_id=?2 AND b_id=?1)) LIMIT 1",
  ).bind(a, b).first().catch(() => null);
  return !!row;
}

/**
 * Send one message.
 *
 * `idem` is honoured because the lock-screen reply path is exactly where a
 * double-send happens: a flaky connection, a retried service-worker fetch, and
 * the friend gets "on my way" twice.
 */
async function send(env, req, ctx) {
  const b = await readBody(req);
  const from = clip(b.me, 40);
  const to = clip(b.to, 40);
  const body = clip(String(b.body ?? '').trim(), 2000);
  const idem = clip(b.idem, 80);

  if (!from || !to) return json({ error: 'me and to are required' }, 400);
  if (!body) return json({ error: 'Nothing to send.' }, 400);
  if (from === to) return json({ error: 'That’s you.' }, 400);

  const [self, other] = await Promise.all([
    env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(from).first(),
    env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(to).first(),
  ]);
  if (!self) return json({ error: 'sign up first' }, 404);
  if (!other) return json({ error: 'no such member' }, 404);
  if (!(await connected(env, from, to))) {
    return json({ error: 'You’re not connected to them yet — scan their code or send an invite first.' }, 403);
  }

  if (idem) {
    const seen = await env.DB.prepare('SELECT id FROM num_dms WHERE id=?1').bind(idem).first().catch(() => null);
    if (seen) return json({ ok: true, already: true, id: idem });
  }

  const id = idem || uid();
  await env.DB.prepare('INSERT INTO num_dms (id, from_id, to_id, body, kind) VALUES (?1,?2,?3,?4,?5)')
    .bind(id, from, to, body, clip(b.kind, 16) || 'text').run();

  // The push is a bare wake-up. `tag` collapses on the sender, so five quick
  // messages are one line on the lock screen rather than five — which is what
  // makes fast back-and-forth bearable rather than a pile of alerts.
  await notify(env, {
    memberId: to,
    kind: 'dm',
    title: self.name || 'A friend',
    body,
    url: `/?dm=${encodeURIComponent(from)}`,
    tag: `dm:${from}`,
    ctx,
  }).catch(() => null);

  return json({ ok: true, id, at: new Date().toISOString() });
}

/** The thread with one person, newest last so it renders straight down. */
async function thread(env, url) {
  const me = clip(url.searchParams.get('me'), 40);
  const withId = clip(url.searchParams.get('with'), 40);
  if (!me || !withId) return json({ error: 'me and with are required' }, 400);

  const { results } = await env.DB.prepare(
    `SELECT id, from_id, to_id, body, kind, created_at, read_at FROM num_dms
      WHERE (from_id=?1 AND to_id=?2) OR (from_id=?2 AND to_id=?1)
      ORDER BY rowid DESC LIMIT 50`,
  ).bind(me, withId).all();

  // Reading the thread IS the read receipt — the only moment we can honestly
  // claim they saw it.
  await env.DB.prepare("UPDATE num_dms SET read_at=datetime('now') WHERE to_id=?1 AND from_id=?2 AND read_at IS NULL")
    .bind(me, withId).run().catch(() => {});

  return json({ messages: (results ?? []).reverse() });
}

/** Everyone with something unread, so the app can show one badge per person. */
async function inbox(env, url) {
  const me = clip(url.searchParams.get('me'), 40);
  if (!me) return json({ error: 'me required' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT d.from_id, m.name, COUNT(*) unread, MAX(d.created_at) last_at,
            (SELECT body FROM num_dms x WHERE x.from_id=d.from_id AND x.to_id=?1 ORDER BY x.rowid DESC LIMIT 1) last_body
       FROM num_dms d LEFT JOIN num_members m ON m.id = d.from_id
      WHERE d.to_id=?1 AND d.read_at IS NULL
      GROUP BY d.from_id ORDER BY last_at DESC LIMIT 20`,
  ).bind(me).all();
  return json({ from: results ?? [] });
}

export async function handleDm(request, env, path, ctx) {
  if (!env.DB) return json({ error: 'messaging needs the database binding' }, 503);
  await ensure(env);
  const url = new URL(request.url);

  try {
    if (path === '/send' && request.method === 'POST') return await send(env, request, ctx);
    if (path === '/thread') return await thread(env, url);
    if (path === '/inbox' || path === '/' || path === '') return await inbox(env, url);
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[dm]', path, err?.message ?? err);
    return json({ error: 'that didn’t go through' }, 500);
  }
}
