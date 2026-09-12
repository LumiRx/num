/**
 * Entering the Friday pack draw by texting Num a code.
 *
 * ── WHY A CODE, WHEN "USED NUM THIS WEEK" ALREADY WORKED ─────────────────
 *
 * The first design entered every member who sent Num any message that week.
 * It needed nothing from anybody, which sounds like an advantage and is not.
 *
 * It entered people who did not know they had entered. That is a poor
 * experience — a prize arriving unasked-for is confusing — and it is a weak
 * legal position, because a sweepstakes rests on an entrant choosing to enter.
 * It also gave us nothing to point at afterwards: "they asked Num about dinner"
 * is not an entry anybody can see, and a draw nobody can see the entries for is
 * a draw nobody can check.
 *
 * A code fixes all three. Sending PACKS is unambiguous, deliberate, timestamped,
 * and countable. Dre asked for exactly this on 12 Sep 2026 — "give them a code
 * to text num so we know theyre entering in" — and it is the better mechanism,
 * not just the requested one.
 *
 * The cost is honest: fewer people will send a code than passively qualify. At
 * 21 active members that may mean a handful of entries against ten prizes, so
 * early weeks will have very short odds. That is fine, and better than handing
 * prizes to people who never asked for one.
 *
 * ── THE MESSAGE MUST *BE* THE CODE ───────────────────────────────────────
 *
 * Not contain it. "What are booster packs?" and "where can I buy packs in
 * Bangkok" are questions about the product we just added a card-shop search
 * for — entering them in a prize draw because the word appeared is exactly the
 * class of error the card-shop classifier exists to avoid, one layer up.
 */

/**
 * What a member sends. Short, unambiguous, hard to type by accident.
 *
 * `growth/fridayrules.mjs` publishes this same word in clause 3, and the two
 * are asserted equal in packdraw.test.mjs — a rules page naming one code while
 * the service accepts another is a promotion whose published terms are false.
 */
export const ENTRY_CODE = 'PACKS';

/**
 * The entry period, identified by the Thursday it ends on.
 *
 * The rules define a week as Friday 00:00 UTC to the following Thursday 23:59
 * UTC, so the closing Thursday names the period — and a member who enters on
 * Friday and one who enters the following Wednesday land in the same draw,
 * which is the whole point.
 */
export function weekKeyFor(now = new Date()) {
  const d = new Date(now);
  const day = d.getUTCDay();              // Sun 0 … Thu 4, Fri 5, Sat 6
  const untilThursday = (4 - day + 7) % 7; // Thursday itself → 0
  d.setUTCDate(d.getUTCDate() + untilThursday);
  return d.toISOString().slice(0, 10);
}

/**
 * Is this message an entry?
 *
 * The whole message, allowing for surrounding punctuation and whitespace and
 * any case. Nothing else counts — see the header.
 */
export function isEntry(text) {
  const t = String(text ?? '')
    .trim()
    .replace(/^[\s"'.,!¡¿?()\[\]-]+|[\s"'.,!¡¿?()\[\]-]+$/g, '')
    .toUpperCase();
  return t === ENTRY_CODE;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_giveaway_entries (
  week_key TEXT NOT NULL,
  member_id TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  source TEXT,
  PRIMARY KEY (week_key, member_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_week ON num_giveaway_entries(week_key);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}
/** Tests only — the module-level flag would otherwise leak between them. */
export const __resetSchema = () => { ready = false; };

/**
 * Record one entry.
 *
 * The primary key is (week, member), so sending PACKS five times on Tuesday is
 * one entry — which is what clause 3 of the rules promises, enforced by the
 * table rather than by remembering to check.
 *
 * Returns `already: true` on a repeat so the reply can say "you're already in"
 * instead of implying a second chance nobody has.
 */
export async function recordEntry(env, { memberId, now = new Date(), source = 'app' } = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  if (!memberId) return { ok: false, why: 'sign in first', needsAccount: true };
  try {
    await ensure(env);
    const weekKey = weekKeyFor(now);
    const before = await env.DB
      .prepare('SELECT entered_at FROM num_giveaway_entries WHERE week_key=?1 AND member_id=?2')
      .bind(weekKey, String(memberId)).first().catch(() => null);
    if (before) return { ok: true, already: true, weekKey };

    await env.DB.prepare(
      `INSERT OR IGNORE INTO num_giveaway_entries (week_key, member_id, entered_at, source)
       VALUES (?1,?2,?3,?4)`,
    ).bind(weekKey, String(memberId), new Date(now).toISOString(), String(source).slice(0, 24)).run();
    return { ok: true, already: false, weekKey };
  } catch (e) {
    console.warn('[packdraw]', e?.message ?? e);
    return { ok: false, why: 'could not record that entry' };
  }
}

/** How many are in this week's draw. Shown to the member, so it must be real. */
export async function entryCount(env, now = new Date()) {
  if (!env?.DB) return 0;
  try {
    await ensure(env);
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM num_giveaway_entries WHERE week_key=?1')
      .bind(weekKeyFor(now)).first().catch(() => null);
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

/**
 * What Num says back.
 *
 * Every reply carries the terms and the rules link, because the reply IS the
 * moment somebody enters and it is the only place we can be sure they see them.
 * A promotion whose conditions live only on a page nobody opened is a promotion
 * whose conditions were never communicated.
 */
export function entryReply({ already = false, count = 0, weekKey = '' } = {}) {
  const head = already
    ? "You're already in this week's draw — one entry each, however many times you send it."
    : "You're in. Ten packs go out this Friday, one each to ten people.";
  const many = count > 0
    ? ` ${count} ${count === 1 ? 'person has' : 'people have'} entered so far.`
    : '';
  return `${head}${many}\n\nWinners are drawn at random on Friday${weekKey ? ` ${weekKey}` : ''} and told right here. `
    + 'US and UK, 18 or over — we\'ll check before anything ships. '
    + 'Full rules: itsnum.com/friday-rules';
}

/** Somebody sent the code without an account. */
export const NEEDS_ACCOUNT_REPLY =
  'Almost — the draw is for Num members, and you\'re not signed in on this device. '
  + 'Sign in or make an account (it takes a minute and costs nothing), then send PACKS again. '
  + 'Full rules: itsnum.com/friday-rules';
