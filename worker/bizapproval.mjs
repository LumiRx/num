/**
 * Deciding on a business that put its hand up.
 *
 * ── WHAT WAS ACTUALLY MISSING ─────────────────────────────────────────────
 *
 * Not the alert. `nudge.claimSweep` has texted on every web signup since day
 * one, within about two minutes, and the audit trail proves it fired for all
 * eight claims on file.
 *
 * What was missing is everything after it. `claims.state` has been 'new' on
 * every row ever written; `decided_at` and `decided_by` have never held a
 * value. Eight businesses — a Holiday Inn Express, a hotel, restaurants —
 * signed up over four weeks and no row records a decision.
 *
 * ── AND WHY DECIDING DID NOT HELP ─────────────────────────────────────────
 *
 * All eight were approved at 20:26 on 30 Aug. `num_claim_decisions` holds the
 * eight ledger rows. `claims.state` is still 'new' on all eight.
 *
 * `decided_at` and `decided_by` do not exist on the production `claims` table.
 * The UPDATE below sets all three columns in one statement, so it throws, and
 * a `.catch(() => {})` ate the error. The ledger filled, the state never
 * moved, and `autoApproveAll` then reported `approved: 0` on every later run
 * because the ledger insert was already there — so the failure was invisible
 * from both ends at once.
 *
 * The tests never caught it because their fixtures create `claims` WITH those
 * two columns (bizbilling.test.mjs, bizconsole.test.mjs). The test schema was
 * more correct than the database, which is the one direction a fixture must
 * never drift.
 *
 * Two other paths write the same columns and failed the same silent way:
 * `bizapi.mjs:308` and `claimverify.mjs:406` — the second being the path a
 * business reaches by *proving* it owns the listing.
 *
 * ── AND THE HOLE THE ALERT LEFT ───────────────────────────────────────────
 *
 * claimSweep dedupes with INSERT OR IGNORE, keyed per claim, forever. That is
 * right for "don't nag on every tick" and wrong for "make sure he knows":
 * claim 15 (Fingal Hotel) was announced at 14:45 on 29 Aug — three days into
 * the SMS outage, when every message left on a bare long code and carriers
 * dropped it. One shot, into a dead channel, and the system now believes the
 * job is done.
 *
 * A one-shot notification is a promise you cannot keep. `staleDigest()` is the
 * repair: while a claim sits undecided it is re-raised on a widening schedule,
 * so a lost alert costs hours instead of a business. It stops the moment
 * somebody decides — which is the only signal that anybody actually saw it.
 */

/** Claims waiting on a human. `new` is the intake state; nothing else is. */
export async function pendingClaims(env, { limit = 50 } = {}) {
  if (!env?.DB) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, business_name, contact_name, phone, email, source, country,
            place_id, verified_at, created_at
       FROM claims
      WHERE state = 'new'
      ORDER BY created_at ASC
      LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/** Ledger of what was decided and by whom. Self-migrating, like the rest. */
async function ensure(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_claim_decisions (
       claim_id    TEXT PRIMARY KEY,
       decision    TEXT NOT NULL,
       decided_by  TEXT NOT NULL,
       note        TEXT,
       onboarded   INTEGER NOT NULL DEFAULT 0,
       created_at  TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_claim_reminders (
       claim_id    TEXT NOT NULL,
       round       INTEGER NOT NULL,
       sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (claim_id, round)
     )`,
  ).run();

  // SQLite has no ADD COLUMN IF NOT EXISTS, so a duplicate-column error is the
  // expected steady state and is the only error swallowed here. Three code
  // paths write these two columns and every one of them failed silently for
  // weeks, because production never had them and the test fixtures did.
  for (const col of ['decided_at TEXT', 'decided_by TEXT']) {
    await env.DB.prepare(`ALTER TABLE claims ADD COLUMN ${col}`).run().catch(() => {});
  }
}

export const DECISIONS = Object.freeze(['approved', 'rejected']);

/**
 * Record a decision.
 *
 * Writes BOTH the ledger row and `claims.state`, in that order: the ledger is
 * append-only and carries who decided, while `claims.state` is what every
 * existing console query already reads. Updating only the second would leave
 * "approved by whom, when" unanswerable, which is exactly the gap this closes.
 *
 * Idempotent — deciding twice is a no-op rather than a second onboarding email
 * to a business that already got one.
 */
export async function decideClaim(env, { id, decision, by, note = null }) {
  if (!env?.DB) return { ok: false, error: 'no database' };
  if (!DECISIONS.includes(decision)) return { ok: false, error: `unknown decision ${decision}` };
  const claimId = String(id ?? '').slice(0, 64);
  if (!claimId) return { ok: false, error: 'no claim id' };
  await ensure(env);

  const claim = await env.DB.prepare(
    'SELECT id, business_name, contact_name, email, country, state FROM claims WHERE id = ?1 LIMIT 1',
  ).bind(claimId).first();
  if (!claim) return { ok: false, error: 'no such claim' };

  const first = await env.DB.prepare(
    'INSERT OR IGNORE INTO num_claim_decisions (claim_id, decision, decided_by, note) VALUES (?1,?2,?3,?4)',
  ).bind(claimId, decision, String(by ?? 'unknown').slice(0, 60), note).run();
  const alreadyDecided = !first?.meta?.changes;

  // NOT swallowed. A decision the console cannot see is not a decision, and
  // the silent catch that used to be here is the entire reason eight
  // businesses sat approved-but-pending for a day without anyone noticing.
  const moved = await env.DB.prepare(
    `UPDATE claims SET state = ?2, decided_at = datetime('now'), decided_by = ?3 WHERE id = ?1`,
  ).bind(claimId, decision, String(by ?? 'unknown').slice(0, 60)).run()
    .then(() => ({ ok: true }))
    .catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) }));

  if (!moved.ok) {
    return { ok: false, error: `ledger written but state not moved: ${moved.error}`, claim, decision, alreadyDecided };
  }

  return { ok: true, claim, decision, alreadyDecided };
}

/**
 * EVERY BUSINESS GETS AN ACCOUNT. Not every business gets a badge.
 *
 * These are two different questions and conflating them was the old design's
 * mistake. "May this person see a dashboard for their own venue and correct
 * their opening hours?" — yes, always, immediately, because refusing costs us
 * a real business and protects nothing. "Should travellers be told this
 * listing is confirmed by its owner?" — only on proof (see bizverify.mjs).
 *
 * So approval is automatic and instant. Verification is earned separately and
 * shows as a badge; an approved-but-unverified business can edit its own
 * details and is simply not marked as confirmed.
 *
 * What approval does NOT grant: category, rating and ranking stay uneditable
 * by anyone at any price, exactly as the console page states.
 */
export async function autoApproveAll(env, { by = 'auto' } = {}) {
  if (!env?.DB) return { approved: 0 };
  await ensure(env);
  const { results } = await env.DB.prepare(
    "SELECT id, verified_at FROM claims WHERE state = 'new' ORDER BY created_at ASC LIMIT 50",
  ).all().catch(() => ({ results: [] }));
  let approved = 0;
  for (const row of results ?? []) {
    const out = await decideClaim(env, {
      id: row.id,
      decision: 'approved',
      by: row.verified_at ? `${by}:verified` : `${by}:unverified`,
      note: row.verified_at ? 'listing ownership verified' : 'auto-approved; ownership not yet proved',
    });
    if (out.ok && !out.alreadyDecided) approved += 1;
  }
  return { approved };
}

/**
 * How long a claim may sit before it is raised again, and how often after that.
 *
 * Widening on purpose. The first reminder is soon enough to still catch the
 * owner while they are sitting by the phone; the later ones exist so a claim
 * cannot quietly become three weeks old, which is what happened to Morrisons
 * Lounge. It stops at seven rounds rather than nagging forever — by then the
 * problem is not that nobody was told.
 */
export const REMINDER_HOURS = Object.freeze([2, 8, 24, 72, 168, 336, 672]);

/**
 * Which reminder round a claim of this age is due, or null.
 *
 * ONLY EVER THE HIGHEST ROUND. The first version of this walked down the
 * schedule looking for any unsent round, so a six-day-old claim fired round 3,
 * then round 2 on the next tick, then round 1, then round 0 — four texts in
 * twenty minutes for one signup, from a function written to reduce noise.
 * Caught by its own test.
 *
 * The rule is therefore: find the highest round this claim has aged into, and
 * fire it only if nothing at that level or beyond has already gone out.
 */
export function dueRound(ageHours, sentRounds = []) {
  const highestSent = sentRounds.length ? Math.max(...sentRounds) : -1;
  for (let i = REMINDER_HOURS.length - 1; i >= 0; i -= 1) {
    if (ageHours >= REMINDER_HOURS[i]) return i > highestSent ? i : null;
  }
  return null;
}

/**
 * Re-raise undecided claims. THE FIX FOR A DROPPED ALERT.
 *
 * Returns the message rather than sending it, so this is testable without a
 * transport and so the caller decides which channel to use.
 */
export async function staleDigest(env, { now = Date.now() } = {}) {
  if (!env?.DB) return null;
  await ensure(env);
  const waiting = await pendingClaims(env, { limit: 50 });
  if (!waiting.length) return null;

  const due = [];
  for (const c of waiting) {
    const ageHours = (now - Date.parse(`${String(c.created_at).replace(' ', 'T')}Z`)) / 3_600_000;
    if (!Number.isFinite(ageHours)) continue;
    const { results } = await env.DB.prepare(
      'SELECT round FROM num_claim_reminders WHERE claim_id = ?1',
    ).bind(String(c.id)).all().catch(() => ({ results: [] }));
    const round = dueRound(ageHours, (results ?? []).map((r) => Number(r.round)));
    if (round !== null) due.push({ claim: c, round, ageHours });
  }
  if (!due.length) return null;

  for (const d of due) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO num_claim_reminders (claim_id, round) VALUES (?1,?2)',
    ).bind(String(d.claim.id), d.round).run().catch(() => {});
  }

  const line = (d) => {
    const days = Math.floor(d.ageHours / 24);
    const age = days >= 1 ? `${days}d` : `${Math.floor(d.ageHours)}h`;
    const who = [d.claim.contact_name, d.claim.phone].filter(Boolean).join(' ');
    return `${d.claim.business_name} (${age}${who ? `, ${who}` : ''})`;
  };

  return {
    count: due.length,
    text:
      `[biz] ${due.length} business signup(s) STILL WAITING on a decision: ` +
      `${due.slice(0, 5).map(line).join('; ')}` +
      `${due.length > 5 ? ` +${due.length - 5} more` : ''}` +
      ' — console → Claims to approve or reject.',
    claims: due.map((d) => d.claim),
  };
}
