/**
 * Per-member memory — the durable facts Num has learned about a guest, kept
 * server-side so they survive losing the app.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * Everything "remembering" looks like it already does is client-side only.
 * src/lib/data.ts keeps the whole profile and the last 200 messages in
 * localStorage (persistable(), saveState()) and the app sends both back on
 * every /api/num call — that is why a `remember` action ever seems to work.
 * It covers exactly one browser on one device, forever, and nothing else:
 * reinstall the app, get a new phone, or open Num on a laptop between trips
 * and the KNOWN FACTS block in prompt.mjs is empty again. For a guest Num has
 * already phone-verified (num_members) — a real, stable identity, not a
 * device — landing back at "let's start with your name" is the exact
 * trust-destroying moment PERSONA already warns about for location: being
 * asked again for something you already said reads as not being listened to.
 *
 * So the durable half of memory moves server-side, keyed by member id. The
 * client-side copy is not replaced — it is still what makes THIS device fast
 * and offline-tolerant — this is the floor underneath it.
 *
 * ── WHY A KEY/VALUE TABLE, NOT A TRANSCRIPT ───────────────────────────────
 *
 * A `remember` action is already a key and a short value — "dietary:
 * pescatarian", not a paragraph — because that is what the prompt schema
 * asks the model to emit (see prompt.mjs's `remember` payload docs). Storing
 * exactly that shape keeps this table tiny per guest forever and keeps it
 * doing ONE job: the KNOWN FACTS Num must never re-ask for. The raw
 * transcript is deliberately NOT mirrored here — num_asks already logs every
 * ask's text for cost and quality, and a second, unbounded per-member
 * transcript is a retention liability nobody asked for, for a job this table
 * already does with three orders of magnitude less data.
 *
 * ── LOAD ORDER ────────────────────────────────────────────────────────
 *
 * Server facts are the FLOOR, never the ceiling: worker/index.mjs loads them
 * first and spreads the client's own state.profile on top, so a correction
 * the guest just made this session always wins over what shipped a minute
 * ago into D1.
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_member_facts (
  member_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (member_id, key)
)`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.prepare(SCHEMA).run();
  ready = true;
}

// Test-only: node:test reuses module state across tests in one file, but
// each test builds its own fresh in-memory DB. Mirrors learn.mjs / commission.mjs.
export function _resetSchemaCache() {
  ready = false;
}

const MAX_KEY = 40;
const MAX_VALUE = 300;
// A per-member ceiling, not a per-call one. The set of keys the persona
// actually asks the model to remember (name, home_city, current_city,
// destination, trip_dates, party_size, hotel, dietary, vibe_prefs) is under
// a dozen — this is headroom for that vocabulary to grow, not a budget any
// real guest should ever brush against. It exists so a misbehaving model
// emitting a fresh key every turn cannot grow one guest's row count forever.
export const MAX_FACTS_PER_MEMBER = 60;

const normKey = (k) => String(k ?? '').trim().toLowerCase().slice(0, MAX_KEY);
const normValue = (v) => String(v ?? '').trim().slice(0, MAX_VALUE);

/**
 * What Num already knows about this member, server-side.
 *
 * Never throws. A memory read that failed must degrade to "no known facts",
 * never to a broken turn — the guest just gets asked something they may have
 * said before, which is the status quo everywhere today, not a new failure.
 */
export async function loadFacts(env, memberId) {
  if (!memberId || !env?.DB) return {};
  try {
    await ensure(env);
    const { results } = await env.DB.prepare('SELECT key, value FROM num_member_facts WHERE member_id = ?1')
      .bind(String(memberId).slice(0, 64))
      .all();
    const facts = {};
    for (const r of results ?? []) facts[r.key] = r.value;
    return facts;
  } catch (e) {
    console.warn('[memory] loadFacts failed, treating as no known facts:', e?.message ?? e);
    return {};
  }
}

/**
 * Record whatever `remember` actions this turn produced.
 *
 * Takes the whole normalized action list, not a pre-filtered one, so every
 * call site can pass `result.actions` straight through without knowing the
 * action shape. Callers wrap this in ctx.waitUntil — it is fire-and-forget
 * by design: a fact failing to save costs the guest nothing THIS turn, only
 * a possible re-ask next time, which is exactly what happens today with no
 * server memory at all.
 */
export async function saveFacts(env, memberId, actions) {
  if (!memberId || !env?.DB || !Array.isArray(actions) || !actions.length) return;
  const facts = actions.filter((a) => a?.type === 'remember' && a.key && a.value);
  if (!facts.length) return;
  try {
    await ensure(env);
    const mid = String(memberId).slice(0, 64);
    const now = new Date().toISOString();
    const { results: existing } = await env.DB.prepare('SELECT key FROM num_member_facts WHERE member_id = ?1')
      .bind(mid)
      .all();
    const known = new Set((existing ?? []).map((r) => r.key));
    let budget = Math.max(0, MAX_FACTS_PER_MEMBER - known.size);
    const writes = [];
    for (const f of facts) {
      const key = normKey(f.key);
      const value = normValue(f.value);
      if (!key || !value) continue;
      const isNew = !known.has(key);
      if (isNew) {
        // Full: an existing key can still be corrected below, but a brand
        // new one waits rather than evicting something older silently.
        if (budget <= 0) continue;
        budget -= 1;
        known.add(key);
      }
      writes.push(
        env.DB
          .prepare(
            `INSERT INTO num_member_facts (member_id, key, value, updated_at) VALUES (?1,?2,?3,?4)
             ON CONFLICT(member_id, key) DO UPDATE SET value=?3, updated_at=?4`,
          )
          .bind(mid, key, value, now),
      );
    }
    if (writes.length) await env.DB.batch(writes);
  } catch (e) {
    console.warn('[memory] saveFacts failed:', e?.message ?? e);
  }
}

/** Forget one fact — for a future "forget my dietary note" flow / support request. Never throws. */
export async function forgetFact(env, memberId, key) {
  if (!memberId || !key || !env?.DB) return;
  try {
    await ensure(env);
    await env.DB.prepare('DELETE FROM num_member_facts WHERE member_id = ?1 AND key = ?2')
      .bind(String(memberId).slice(0, 64), normKey(key))
      .run();
  } catch (e) {
    console.warn('[memory] forgetFact failed:', e?.message ?? e);
  }
}
