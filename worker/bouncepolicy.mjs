/**
 * WHAT A BOUNCE COSTS, AND WHY IT WAS COSTING US THE INBOX.
 *
 * ── THE MEASUREMENT THAT STARTED THIS ────────────────────────────────────
 *
 * 18 Sep 2026, the month to that date, straight off the provider:
 *
 *   itsnum.com   1,821 sent   1,440 delivered   381 bounced (20.9%)
 *                              207 of them PERMANENT
 *                              1,392 delayed at the receiving end
 *   aeroz.io        50 sent      46 delivered     4 bounced (8%)
 *   5arz.com        59 sent      59 delivered     0 bounced
 *
 * A 20.9% bounce rate is not a bad week. Every large mailbox provider treats
 * sustained hard bounces above roughly 2% as the signature of a purchased or
 * scraped list, because that is overwhelmingly what it is the signature of.
 * The 1,392 delayed deliveries are the same providers throttling us: a
 * receiving server that is unsure about a sender does not refuse, it slows
 * down. We were being slowed down 1,392 times.
 *
 * That is the answer to "why does our mail go to spam". Not SPF — SPF, DKIM
 * and DMARC are all published and verified on itsnum.com and have been since
 * July. Not the template. The list. We spent a domain's reputation on
 * addresses scraped off a map, and then sent a restaurant owner a claim link
 * from the same domain and wondered why he had to press "trust sender".
 *
 * ── THE TWO HOLES THIS FILE CLOSES ───────────────────────────────────────
 *
 * 1. NOTHING WAS LEARNING FROM A BOUNCE. maildelivery.mjs receives every
 *    Resend webhook and suppressed only COMPLAINTS. A permanent bounce
 *    updated a claim row and was otherwise forgotten: the address stayed
 *    mailable, the lead stayed live, and `num_invites` — the table the drain
 *    reads — was never told at all. We could not have computed our own bounce
 *    rate from our own database if we had tried.
 *
 * 2. NOTHING COULD STOP THE DRAIN. The invite breaker trips when a SEND
 *    fails. A send that succeeds into a dead mailbox is not a failure by that
 *    definition, so the drain would have kept going at 20% bounces until the
 *    domain was unusable. A circuit breaker that only watches the half of the
 *    system that reports errors is not a circuit breaker.
 *
 * ── WHAT COUNTS AS PERMANENT, AND WHY THE DEFAULT IS "NO" ────────────────
 *
 * A full mailbox, a greylist, a timeout: transient. The address exists and the
 * person behind it may well be a customer next month, so suppressing it is
 * throwing away something real. A nonexistent user or a dead domain:
 * permanent, and every further attempt is pure reputational cost for a
 * message nobody will ever read.
 *
 * Anything we cannot classify is treated as transient. Over-suppressing is
 * quiet and permanent; under-suppressing shows up in the next bounce reading
 * and gets fixed. Given a choice between the failure that hides and the
 * failure that surfaces, take the one that surfaces.
 */

/** Suppress above this rolling rate, and say so loudly. */
export const BOUNCE_CEILING = 0.05;
/** Below this many recent sends the rate is noise, not a signal. */
export const MIN_SAMPLE = 40;

const PERMANENT = /permanent|no.?such|does ?not exist|unknown user|user unknown|invalid recipient|recipient (address )?rejected|mailbox unavailable|address rejected|no mailbox|domain not found|nxdomain|550/i;
const TRANSIENT = /transient|temporar|greylist|grey.?list|deferred|mailbox full|over quota|quota exceeded|try again|timed? out|throttl|rate.?limit|4\d\d/i;

/**
 * Permanent, transient or unknown — from whatever shape the provider sent.
 *
 * Resend forwards SES's classification in `data.bounce.type` when it has one
 * and a free-text reason when it does not, so both are read and the structured
 * field wins. Transient is checked FIRST: "mailbox full" contains no permanent
 * marker but a 550-style message can carry both words, and a full mailbox is
 * the case we must not suppress.
 */
export function classifyBounce(data = {}) {
  const structured = String(data?.bounce?.type ?? '').toLowerCase();
  if (structured.startsWith('permanent')) return 'permanent';
  if (structured.startsWith('transient')) return 'transient';

  const text = [data?.reason, data?.bounce?.message, data?.bounce?.subType, data?.message]
    .filter(Boolean).join(' ');
  if (!text) return 'unknown';
  if (TRANSIENT.test(text)) return 'transient';
  if (PERMANENT.test(text)) return 'permanent';
  return 'unknown';
}

/**
 * Record a bounce or a complaint everywhere it matters.
 *
 * Deliberately tolerant of missing tables: this runs inside a webhook that
 * must answer 200 or the provider retries it forever, and a `leads` table that
 * does not exist in some environment is not a reason to refuse a delivery
 * receipt. Every write is individually swallowed, and the return value says
 * what actually happened rather than assuming it all did.
 */
export async function recordBounce(env, { ref, to, type, data = {} } = {}) {
  const out = { suppressed: false, invite: false, lead: false, kind: null };
  if (!env?.DB) return out;

  const complaint = type === 'email.complained';
  const kind = complaint ? 'complaint' : classifyBounce(data);
  out.kind = kind;
  const why = String(data?.reason ?? data?.bounce?.message ?? type ?? '').slice(0, 200);
  const addr = to ? String(to).toLowerCase().slice(0, 160) : null;

  // The invite ledger learns of it either way. A transient bounce is not a
  // reason to suppress an address, but it IS the difference between "we sent
  // 1,821 invites" and "1,440 people were sent an invite", and only one of
  // those two sentences is true.
  if (ref) {
    const r = await env.DB.prepare(
      `UPDATE num_invites
          SET status = ?2, error = ?3
        WHERE provider_id = ?1`,
    ).bind(String(ref), complaint ? 'complained' : `bounced_${kind}`, why)
      .run().catch(() => null);
    out.invite = !!r?.meta?.changes;
  }

  // Suppression is for the ones that can never work, plus every complaint.
  // A complaint is somebody saying "this is spam" about a domain that also
  // carries sign-in codes and booking confirmations; there is no version of
  // that where we mail them again.
  if (addr && (complaint || kind === 'permanent')) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO num_suppressions (email, reason, note) VALUES (?1, ?2, ?3)',
    ).bind(addr, complaint ? 'complaint' : 'bounce', why).run().catch(() => {});
    out.suppressed = true;

    // And out of the outreach pool, so a second lead row carrying the same
    // dead address cannot spend another send on it. 'dead' rather than
    // 'opted_out': they did not opt out of anything, the mailbox is gone, and
    // conflating the two would misreport how many people actually refused us.
    const l = await env.DB.prepare(
      "UPDATE leads SET status = 'dead', updated_at = datetime('now') WHERE lower(email) = ?1",
    ).bind(addr).run().catch(() => null);
    out.lead = !!l?.meta?.changes;
  }

  return out;
}

/**
 * The rolling health of the sending domain, from our own records.
 *
 * Counted over the most recent `sample` invites that have actually been
 * ATTEMPTED — sent, bounced or complained — rather than over a period, because
 * a ramp that sends 50 a day and a burst that sends 500 need the same question
 * answered: of the last few hundred messages that left, how many landed.
 *
 * `ok` is false only when there is enough evidence to be sure. With fewer than
 * MIN_SAMPLE attempts the honest answer is "not yet known", and a breaker that
 * trips on three bounces out of five stops a launch on noise.
 */
export async function sendHealth(env, { sample = 300 } = {}) {
  if (!env?.DB) return { ok: true, known: false, reason: 'no database' };
  const row = await env.DB.prepare(
    `SELECT
        COUNT(*)                                                       AS n,
        SUM(CASE WHEN status LIKE 'bounced_permanent' THEN 1 ELSE 0 END) AS hard,
        SUM(CASE WHEN status LIKE 'bounced_%'          THEN 1 ELSE 0 END) AS bounced,
        SUM(CASE WHEN status = 'complained'            THEN 1 ELSE 0 END) AS complaints
       FROM (SELECT status FROM num_invites
              WHERE status IN ('sent','complained')
                 OR status LIKE 'bounced_%'
              ORDER BY sent_at DESC LIMIT ?1)`,
  ).bind(sample).first().catch(() => null);

  const n = Number(row?.n ?? 0);
  if (n < MIN_SAMPLE) {
    return { ok: true, known: false, n, reason: `only ${n} attempts on record — too few to judge` };
  }
  const hard = Number(row?.hard ?? 0);
  const complaints = Number(row?.complaints ?? 0);
  const rate = hard / n;
  const ok = rate <= BOUNCE_CEILING;
  return {
    ok, known: true, n, hard, complaints,
    bounced: Number(row?.bounced ?? 0),
    rate: Math.round(rate * 1000) / 1000,
    ceiling: BOUNCE_CEILING,
    reason: ok
      ? `${hard} hard bounces in the last ${n} — under the ${Math.round(BOUNCE_CEILING * 100)}% ceiling`
      : `${hard} hard bounces in the last ${n} (${Math.round(rate * 100)}%) — over the `
        + `${Math.round(BOUNCE_CEILING * 100)}% ceiling. Sending more spends a reputation that `
        + 'sign-in codes and booking confirmations also depend on. Clean the list before resuming.',
  };
}
