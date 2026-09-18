/**
 * HOW THEY LIKED IT — the reaction ledger.
 *
 * The five emoji under every answer (😍 👍 😐 👎 🥱) are the cheapest feedback
 * NUM gets, which is why guests actually use them. Until 18 Sep 2026 a tap
 * stayed on the phone: it taught THAT guest's style profile (src/lib/prefs.ts)
 * and told the team nothing. This module is the other half — the row the
 * dashboard reads to answer "are the answers getting better, and where not".
 *
 * ── WHAT A ROW IS ──────────────────────────────────────────────────────────
 *
 * One row per (person, message). A second tap on the same message replaces
 * the first: a change of mind is one opinion, not two. The row is
 * self-contained — lane, brain, place, the ask and the reply's opening ride
 * on it — because the app never sees num_asks.id, and a rating that needs a
 * join nobody can make is a rating nobody reads.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 *
 * Not a ranking signal. 👎 on a venue here is "show the team", not "hide the
 * venue for everyone" — that decision is Dre's, once there is a week of data
 * to look at. Not PII: `asked` and `reply` go through the same scrubAsk()
 * as num_asks. Not load-bearing: a failed write is logged and the guest's
 * tap still counted on their own phone.
 */
import { scrubAsk } from './asks.mjs';

export const REACTIONS = Object.freeze(['love', 'like', 'meh', 'no', 'long']);
const POSITIVE = new Set(['love', 'like']);
const NEGATIVE = new Set(['no', 'meh']);

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Stable id: the same person re-rating the same message lands on the same row. */
async function idFor(who, index, asked) {
  const bytes = new TextEncoder().encode(`${who}|${index}|${String(asked ?? '').slice(0, 120)}`);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'r_' + [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Record one tap. Returns `{ ok, id, reaction }` or `{ ok: false, error }`.
 * Never throws — a failure in the feedback channel must not become a failure
 * the guest sees.
 */
export async function record(env, body = {}) {
  const reaction = String(body.reaction ?? '');
  if (!REACTIONS.includes(reaction)) return { ok: false, error: 'unknown reaction' };
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0) return { ok: false, error: 'bad index' };
  const memberId = clip(body.member, 64);
  const anonId = clip(body.anon, 64);
  const who = memberId ? `m:${memberId}` : anonId ? `a:${anonId}` : null;
  if (!who) return { ok: false, error: 'no identity' };
  if (!env?.DB) return { ok: false, error: 'no database' };

  const asked = clip(scrubAsk(String(body.asked ?? '')), 300);
  const reply = clip(scrubAsk(String(body.reply ?? '')), 300);
  const turn = body.turn && typeof body.turn === 'object' ? body.turn : {};
  const id = await idFor(who, index, asked);
  try {
    await env.DB.prepare(
      `INSERT INTO num_reactions (id, day, who, member_id, anon_id, msg_index, reaction, subject, asked, reply, place, lane, brain, model, lang)
       VALUES (?1, date('now'), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT(id) DO UPDATE SET
         reaction = excluded.reaction,
         subject  = excluded.subject,
         ts       = datetime('now'),
         day      = date('now')`,
    ).bind(
      id, who, memberId, anonId, index, reaction,
      clip(body.subject, 120), asked, reply,
      clip(body.place, 80), clip(turn.lane, 60), clip(turn.brain, 40), clip(turn.model, 80), clip(body.lang, 12),
    ).run();
    return { ok: true, id, reaction };
  } catch (e) {
    console.warn('[reactions] could not record —', e?.message ?? e);
    return { ok: false, error: 'write failed' };
  }
}

const rate = (pos, neg) => (pos + neg ? Math.round((100 * pos) / (pos + neg)) : null);

/** One dimension's scoreboard: positive vs negative, and how often "too long". */
function fold(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] ?? '—';
    const o = m.get(k) ?? { [key]: k, n: 0, positive: 0, negative: 0, long: 0 };
    o.n += 1;
    if (POSITIVE.has(r.reaction)) o.positive += 1;
    else if (NEGATIVE.has(r.reaction)) o.negative += 1;
    else if (r.reaction === 'long') o.long += 1;
    m.set(k, o);
  }
  return [...m.values()]
    .map((o) => ({ ...o, approval: rate(o.positive, o.negative), long_pct: o.n ? Math.round((100 * o.long) / o.n) : 0 }))
    .sort((a, b) => b.n - a.n);
}

/**
 * The shape the team dashboard renders. `approval` is positive / (positive +
 * negative) — 🥱 is neither, it is its own line, because "right answer, too
 * long" is a different fix from "wrong answer".
 */
export async function summary(env, { days = 7 } = {}) {
  const d = Math.min(Math.max(1, Number(days) || 7), 90);
  const empty = { days: d, totals: { n: 0, positive: 0, negative: 0, long: 0, approval: null, long_pct: 0, people: 0 }, by_reaction: {}, by_lane: [], by_brain: [], by_place: [], worst: [] };
  if (!env?.DB) return empty;
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, ts, who, reaction, subject, asked, reply, place, lane, brain, model, lang
         FROM num_reactions
        WHERE ts >= datetime('now', ?1)
        ORDER BY ts DESC
        LIMIT 5000`,
    ).bind(`-${d} days`).all();
    const rows = results ?? [];
    const positive = rows.filter((r) => POSITIVE.has(r.reaction)).length;
    const negative = rows.filter((r) => NEGATIVE.has(r.reaction)).length;
    const long = rows.filter((r) => r.reaction === 'long').length;
    const by_reaction = {};
    for (const k of REACTIONS) by_reaction[k] = rows.filter((r) => r.reaction === k).length;
    return {
      days: d,
      totals: {
        n: rows.length, positive, negative, long,
        approval: rate(positive, negative),
        long_pct: rows.length ? Math.round((100 * long) / rows.length) : 0,
        people: new Set(rows.map((r) => r.who)).size,
      },
      by_reaction,
      by_lane: fold(rows, 'lane'),
      by_brain: fold(rows, 'brain'),
      by_place: fold(rows, 'place').slice(0, 12),
      // What to read first: the answers people rejected or yawned at, newest
      // first, with the question that produced them.
      worst: rows
        .filter((r) => NEGATIVE.has(r.reaction) || r.reaction === 'long')
        .slice(0, 12)
        .map((r) => ({ ts: r.ts, reaction: r.reaction, subject: r.subject, asked: r.asked, reply: r.reply, place: r.place, lane: r.lane, brain: r.brain })),
    };
  } catch (e) {
    console.warn('[reactions] summary failed —', e?.message ?? e);
    return { ...empty, error: String(e?.message ?? e).slice(0, 120) };
  }
}
