// The thread itself, remembered server-side.
//
// worker/memory.mjs (29 Aug 2026) made FACTS durable — "vegetarian", "two
// kids" — and left the conversation where it had always lived: in one
// browser's localStorage. That was a deliberate scope call, with this file
// named as the next step if losing the thread turned out to matter. It does:
// a member who reinstalls, opens Num on a second device, or clears a browser
// gets a concierge with a perfect memory for their allergies and no memory of
// the table they were choosing between five minutes ago. That reads as a
// stranger who has been briefed, not as the friend who lives there.
//
// ── What is stored, and why so little ────────────────────────────────────
//
//   · The last `KEEP` turns per subject, each clipped to `MAX_CHARS`. The
//     model only ever sees the last 14 messages anyway (index.mjs), so
//     keeping more would be a retention liability with no reader.
//   · Rows older than `TTL_DAYS` are swept on every write. A conversation
//     from March is not context, it is a record, and num_asks already keeps
//     the ask side of it for cost and quality.
//   · Keyed on member OR device (`anon:<id>`), for the same reason
//     soulprofile.mjs is: nine in ten asks carry no member id, and the first
//     conversation is the one where somebody decides whether Num is any good.
//
// ── The one rule ─────────────────────────────────────────────────────────
//
// THE CLIENT'S OWN HISTORY WINS. Server turns are the FLOOR: they are used
// only to fill in what the client does not have — a fresh device, a cleared
// store — and never to override or reorder what the person can see on their
// own screen. If the client sends a full thread, the server adds nothing.

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_member_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const INDEX = 'CREATE INDEX IF NOT EXISTS idx_turns_subject ON num_member_turns(subject, id)';

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.prepare(SCHEMA).run();
  await env.DB.prepare(INDEX).run();
  ready = true;
}
export function _resetSchemaCache() { ready = false; }

export const KEEP = 24;          // rows kept per subject
export const MAX_CHARS = 1200;   // per turn
export const TTL_DAYS = 30;
export const WINDOW = 14;        // what the model is shown, same as index.mjs

/** member id, or the device, or nothing — the same choice soulprofile makes. */
export function subjectFor({ memberId, anonId }) {
  if (memberId) return String(memberId).slice(0, 64);
  if (anonId) return `anon:${String(anonId).slice(0, 64)}`;
  return null;
}

const clip = (s) => String(s ?? '').trim().slice(0, MAX_CHARS);

/** The stored thread, oldest first, at most WINDOW turns. Never throws. */
export async function loadTurns(env, subject) {
  if (!subject || !env?.DB) return [];
  try {
    await ensure(env);
    const { results } = await env.DB.prepare(
      'SELECT role, content FROM num_member_turns WHERE subject = ?1 ORDER BY id DESC LIMIT ?2',
    ).bind(subject, WINDOW).all();
    return (results ?? []).reverse().map((r) => ({ role: r.role, content: r.content }));
  } catch (e) {
    console.warn('[turns] loadTurns failed, treating as no history:', e?.message ?? e);
    return [];
  }
}

/**
 * Append this exchange and trim. Fire-and-forget from the caller.
 *
 * Empty user text or empty reply stores nothing: an assistant turn with no
 * user turn before it would reorder the thread the next time it is merged.
 */
export async function saveTurn(env, subject, userText, assistantText) {
  if (!subject || !env?.DB) return false;
  const u = clip(userText);
  const a = clip(assistantText);
  if (!u || !a) return false;
  try {
    await ensure(env);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO num_member_turns (subject, role, content) VALUES (?1, ?2, ?3)').bind(subject, 'user', u),
      env.DB.prepare('INSERT INTO num_member_turns (subject, role, content) VALUES (?1, ?2, ?3)').bind(subject, 'assistant', a),
      // Trim to KEEP, and sweep anything past its TTL. Both in the same batch
      // as the write so a subject can never grow without bound.
      env.DB.prepare(
        `DELETE FROM num_member_turns WHERE subject = ?1 AND id NOT IN (
           SELECT id FROM num_member_turns WHERE subject = ?1 ORDER BY id DESC LIMIT ?2)`,
      ).bind(subject, KEEP),
      env.DB.prepare(`DELETE FROM num_member_turns WHERE ts < datetime('now', ?1)`).bind(`-${TTL_DAYS} days`),
    ]);
    return true;
  } catch (e) {
    console.warn('[turns] saveTurn failed:', e?.message ?? e);
    return false;
  }
}

/**
 * Fill in what the client does not have.
 *
 *   client full (>= WINDOW)    → client, untouched.
 *   client short, server empty → client.
 *   client short, server has   → stored turns the client is not already
 *     showing (matched on role+content), then the client's own, capped to
 *     WINDOW from the end. The client's order is never changed.
 */
export function mergeHistory(client, server) {
  const own = Array.isArray(client) ? client.filter((m) => m && (m.role === 'user' || m.role === 'assistant')) : [];
  const stored = Array.isArray(server) ? server : [];
  if (own.length >= WINDOW || !stored.length) return own.slice(-WINDOW);

  const key = (m) => `${m.role} ${String(m.content ?? '').trim().slice(0, MAX_CHARS)}`;
  const seen = new Set(own.map(key));
  const prefix = stored.filter((m) => !seen.has(key(m)));
  const merged = [...prefix, ...own];
  // Never open on an assistant turn — the model reads that as answering nothing.
  while (merged.length > WINDOW || (merged.length && merged[0].role === 'assistant')) merged.shift();
  return merged;
}
