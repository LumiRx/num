/**
 * Which businesses Num actually put in front of a guest.
 *
 * Until this existed, Num could not answer the first question every merchant
 * asks — "how many people did you send me?" — and so the business dashboard had
 * nothing true worth paying for, promotions had no baseline to be measured
 * against, and the pitch had to lean on a demand proxy instead of delivered
 * value. One missing table sat under all of it.
 *
 * WHAT COUNTS AS AN IMPRESSION, AND WHY IT MATTERS
 *
 * Six partners go to the model as candidates. The model might name two. Logging
 * all six would inflate every merchant's number by 3x and quietly turn the one
 * figure they make decisions on into a lie — the most damaging possible place
 * to be generous with the truth.
 *
 * So only two things are recorded:
 *
 *   card   — the business was the featured card in the reply. Strongest signal:
 *            a photo, a name and an action, right in front of the guest.
 *   named  — the business name appears in the reply text.
 *
 * Being considered and passed over is not an impression. If a merchant ever
 * audits this against a transcript, every row should survive.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_place_impressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id TEXT NOT NULL,
  member_id TEXT,
  dest TEXT,
  surface TEXT NOT NULL,
  rank INTEGER,
  asked TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_impr_place_ts ON num_place_impressions(place_id, ts);
CREATE INDEX IF NOT EXISTS idx_impr_ts ON num_place_impressions(ts);
`;
let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/**
 * Strip accents, case and punctuation so "Café Léon" matches "cafe leon".
 *
 * `normalize('NFD')` is the load-bearing line, and not obviously so. It splits
 * "é" into "e" + a combining mark; the final `[^a-z0-9]` strip then drops the
 * mark and keeps the "e". Remove the NFD step and "Café Léon" becomes
 * "caflon" — the accented letters vanish entirely and that merchant silently
 * never gets credited, in a way no error would ever reveal.
 *
 * The explicit combining-mark replace below is therefore redundant today: the
 * `[^a-z0-9]` strip already removes them. It stays as a guard in case that last
 * filter is ever widened, and is flagged as redundant so nobody deletes NFD
 * believing this line covers it. Verified by mutation: removing NFD fails the
 * accent test; removing this line does not.
 */
const norm = (v) =>
  String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// A name shorter than this matches half the reply by accident. "Bar", "Deli"
// and "Zoo" are real listing names, and counting an impression every time the
// word "bar" appears in a sentence would make the numbers worthless in exactly
// the categories that matter most.
const MIN_NAME = 5;

/**
 * Record which of the surfaced partners the guest was actually shown.
 *
 * Never throws and never awaited on the request path — a bookkeeping failure
 * must not cost somebody their answer. Call it inside ctx.waitUntil.
 */
export async function recordImpressions(env, { partners = [], reply = '', card = null, memberId = null, dest = null, asked = null } = {}) {
  if (!env?.DB || !partners.length) return { logged: 0 };

  const replyN = norm(reply);
  const cardN = norm(card?.title);
  const hits = [];

  partners.forEach((p, i) => {
    if (!p?.id) return; // pre-`id` rows; skip rather than guess by name
    const names = [p.name, p.name_local].filter(Boolean).map(norm).filter((n) => n.length >= MIN_NAME);
    if (!names.length) return;

    // rank is the position in the list Num ranked, not the order it was
    // mentioned — it is what tells us later whether being surfaced high
    // actually changes anything.
    if (cardN && names.some((n) => cardN.includes(n) || n.includes(cardN))) {
      hits.push({ id: p.id, surface: 'card', rank: i + 1 });
    } else if (names.some((n) => replyN.includes(n))) {
      hits.push({ id: p.id, surface: 'named', rank: i + 1 });
    }
  });

  if (!hits.length) return { logged: 0 };

  try {
    await ensure(env);
    const ts = Math.floor(Date.now() / 1000);
    const stmt = env.DB.prepare(
      `INSERT INTO num_place_impressions (place_id, member_id, dest, surface, rank, asked, ts)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    );
    await env.DB.batch(
      // `asked` is truncated hard. It is here so a merchant can see WHAT people
      // wanted when their name came up — far more useful than a bare count —
      // but a concierge transcript is not something to retain at length.
      hits.map((h) => stmt.bind(h.id, memberId, dest, h.surface, h.rank, asked ? String(asked).slice(0, 120) : null, ts)),
    );
    return { logged: hits.length };
  } catch (e) {
    console.warn('[impressions] write failed', e?.message ?? e);
    return { logged: 0, error: String(e?.message ?? e) };
  }
}
