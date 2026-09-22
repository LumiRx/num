/**
 * TELL DRE WHEN NOBODY CAN SIGN IN.
 *
 * Dre, 20 Sep 2026: "If this ever happens, I need an immediate text message
 * to alert me."
 *
 * ── WHAT HAPPENED, AND WHY NOTHING SAID SO ───────────────────────────────
 *
 * On 20 Sep 2026 a post on X sent Num its biggest day ever — 130 signups in
 * five hours against a baseline of about one a day. At 08:31Z the last
 * verification text went out. At 08:34Z Twilio began refusing every request
 * on the account with error 20003. It stayed refused for more than nine
 * hours. Seventy-one sends failed. Not one person was told.
 *
 * Every piece needed to notice already existed and none of them was pointed
 * at this:
 *
 *   num_signin_events   recorded all 71 failures, correctly, in real time.
 *   verifydiag.mjs      asks Twilio how sends resolved — but only logs, and
 *                       when the account itself is refused, its own call to
 *                       Twilio fails too.
 *   health.checkSms()   answered `ok: true` throughout, because it validates
 *                       CONFIGURATION — is a Messaging Service SID set, is it
 *                       shaped like an MG — and configuration was perfect.
 *                       It never asked whether a single text had gone out.
 *   health.alert()      three working channels, waiting for a caller that
 *                       did not exist.
 *
 * So the gap was never detection. It was that nothing turned a table anyone
 * could have read into a sentence somebody received. This file is that
 * sentence, and it is deliberately the same shape as brainalert.mjs.
 *
 * ── THE RULE THAT DECIDES EVERYTHING BELOW ───────────────────────────────
 *
 * Ask the only question a member would ask: IS ANYBODY GETTING A CODE? Not
 * "is Twilio configured", not "did Twilio accept the request" — that was the
 * 30 Aug blind spot and it is how `outcome: ok` came to mean "Twilio took
 * the parcel" rather than "a phone buzzed". Attempts with zero successes is
 * the whole test, and it is true no matter which vendor, code or layer broke.
 *
 * ── SILENCE IS NOT AN OUTAGE ─────────────────────────────────────────────
 *
 * At 04:00 Bangkok time nobody is signing in, so there are no successes and
 * no failures. A watchdog that reads that as "no codes are arriving" pages
 * every night until it is muted, and then it is muted on the morning that
 * matters. No attempts means no evidence, and no evidence is reported as
 * `quiet` and never alerted on.
 *
 * ── A BAD PHONE NUMBER IS NOT AN OUTAGE EITHER ───────────────────────────
 *
 * Twilio 60200 means the number we were handed is not a real number. That is
 * a fact about one member's typing, not about our account, and counting it
 * as evidence that the channel is down would let three people fat-fingering
 * their number at 3am fire a page. Per-number rejections are excluded from
 * the denominator entirely — they prove nothing either way.
 */

/**
 * Rejections that describe the DESTINATION, not us. Excluded from the
 * evidence on both sides: they neither prove the channel works nor that it
 * is broken.
 */
export const PER_NUMBER = Object.freeze([
  '60200', // invalid parameter — in practice a malformed E.164 number
  '60203', // max send attempts reached for this number
  '60205', // SMS not supported by this landline
  '60410', // Fraud Guard blocked this specific number
  '21211', // invalid 'To' number
  '21614', // 'To' number is not SMS-capable
]);

/**
 * Failures that NO amount of waiting fixes. A human has to open a console.
 * These get named explicitly in the message, because the difference between
 * "retry in ten minutes" and "go and look now" is the entire value of the
 * alert.
 */
export const NEEDS_HUMAN = Object.freeze({
  20003: 'Twilio is refusing our login (permission denied). Almost always an empty balance, a suspended account, or a deleted/rotated auth token. Twilio Console → Billing → Overview, then check for a red banner.',
  20005: 'The Twilio account is suspended or closed. Twilio Console → Billing, and contact Twilio support.',
  20429: 'Twilio is rate-limiting the whole account. A burst usually clears itself within minutes; if it does not, the account limit is too low for this traffic. Twilio Console \u2192 Monitor \u2192 Logs \u2192 Errors.',
  30034: 'US carrier registration (A2P 10DLC) is not approved for the number we are sending from. Twilio Console → Messaging → Regulatory Compliance.',
  60300: 'The Verify service SID is wrong or the service was deleted. Check VERIFY_SERVICE_SID.',
  60605: 'Verify is not permitted to send to this destination country. Twilio Console → Verify → Geo permissions.',
});

/**
 * ── THE FAILURE A CHANNEL-LEVEL CHECK CANNOT SEE ─────────────────────────
 *
 * Everything above asks "is ANYBODY getting a code", and one success answers
 * yes. That is the right question for an outage and the wrong one for what
 * turned up the same evening: at 22:49 on 20 Sep 2026, hours after the
 * account was restored and while codes were sending normally to the US,
 * every send to Indonesia was being refused with 60605 — Verify Geo
 * Permissions had that country switched off.
 *
 * The channel was up. The board was right to say so. And the second-largest
 * country in the surge could not create an account: 22 Indonesian signups
 * that morning, zero verified, and no single number anywhere in the product
 * that would ever have gone red.
 *
 * These two error codes mean "a whole class of people is locked out" rather
 * than "this one number is bad", so they are worth saying out loud even
 * while everything else is healthy. Reported once a day, because it is a
 * setting somebody has to go and change, not an emergency to be woken for.
 */
export const BLOCKED_CLASS = Object.freeze({
  60605: 'Twilio Verify Geo Permissions is blocking a whole destination country. Twilio Console \u2192 Verify \u2192 Settings \u2192 Geo permissions — set that country\u2019s SMS channel to Allow, or to Monitor for fraud. Takes effect immediately, no deploy.',
  60410: 'Twilio Fraud Guard is blocking these numbers as suspected SMS pumping. Some will be real people. Twilio Console \u2192 Verify \u2192 Fraud Guard — review the blocked list and lower the protection level for that country if the traffic is genuine.',
});

/** How far back to look, and how much evidence is enough to be sure. */
export const WINDOW_MINUTES = 20;
export const MIN_ATTEMPTS = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_sms_alerts (
  scope TEXT NOT NULL,
  level TEXT NOT NULL,
  window TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, level, window)
);
`;
const readied = new WeakSet();
async function ensure(env) {
  if (!env?.DB || readied.has(env.DB)) return;
  for (const s of SCHEMA.split(';').map((x) => x.trim()).filter(Boolean)) {
    await env.DB.prepare(s).run();
  }
  readied.add(env.DB);
}

/**
 * Read the window and decide. Pure given its input so the tests can pin
 * every branch without a database.
 *
 * `rows` is one row per (outcome, reason) with a count, exactly as the
 * GROUP BY below produces.
 */
export function assess(rows, { minAttempts = MIN_ATTEMPTS } = {}) {
  const all = rows ?? [];
  const ok = all.filter((r) => r.outcome === 'ok').reduce((n, r) => n + Number(r.n || 0), 0);

  // Split the failures before counting anything. A rejection that names the
  // destination is not evidence about the channel.
  const failures = all.filter((r) => r.outcome !== 'ok');
  const systemic = failures.filter((r) => !PER_NUMBER.includes(String(r.reason ?? '')));
  const perNumber = failures.filter((r) => PER_NUMBER.includes(String(r.reason ?? '')));

  const failed = systemic.reduce((n, r) => n + Number(r.n || 0), 0);
  const skipped = perNumber.reduce((n, r) => n + Number(r.n || 0), 0);
  const attempts = ok + failed;

  // The dominant reason, so the message can say where to go rather than
  // just that something is wrong.
  const byReason = new Map();
  for (const r of systemic) {
    const k = String(r.reason ?? 'unknown');
    byReason.set(k, (byReason.get(k) ?? 0) + Number(r.n || 0));
  }
  const ranked = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  const reason = ranked.length ? ranked[0][0] : null;

  // Counted across ALL failures, including the per-number bucket: 60410 is
  // excluded from the outage evidence (it names specific numbers) but a run
  // of them still means real people are being turned away.
  const blocked = failures
    .filter((r) => Object.prototype.hasOwnProperty.call(BLOCKED_CLASS, String(r.reason ?? '')))
    .map((r) => [String(r.reason), Number(r.n || 0)])
    .sort((x, y) => y[1] - x[1]);

  if (attempts === 0) return { level: 'quiet', ok, failed, skipped, attempts, reason: null, reasons: ranked, blocked };
  if (ok > 0) return { level: 'ok', ok, failed, skipped, attempts, reason, reasons: ranked, blocked };
  if (attempts < minAttempts) {
    // Failing, but not yet enough to be sure it is not coincidence. Reported
    // so it shows in logs and the next tick can confirm; never paged on.
    return { level: 'suspect', ok, failed, skipped, attempts, reason, reasons: ranked, blocked };
  }
  return {
    level: 'down',
    ok,
    failed,
    skipped,
    attempts,
    reason,
    reasons: ranked,
    blocked,
    needs_human: Object.prototype.hasOwnProperty.call(NEEDS_HUMAN, String(reason)),
  };
}

/** Hourly while down — the product is broken and a reminder is welcome. */
export function windowFor(now = new Date()) {
  return new Date(now).toISOString().slice(0, 13);
}

/** Daily for a blocked country — it is a task, and a task is not a siren. */
export function dayFor(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** The words. Short, because this arrives on a phone. */
export function messageFor(a, { lastOkAt = null, now = new Date() } = {}) {
  const remedy = NEEDS_HUMAN[String(a.reason)]
    ?? `Twilio error ${a.reason ?? 'unknown'} — open Twilio Console → Monitor → Logs → Errors for the reason.`;
  const dry = lastOkAt ? ` Last code that actually sent: ${minutesAgo(lastOkAt, now)}.` : '';
  return `[SIGN-IN DOWN] No verification code has sent in ${WINDOW_MINUTES} min — ${a.failed} failed, 0 delivered.${dry} ${remedy}`;
}

/** "3h 28m ago", in the fewest words that are still precise. */
export function minutesAgo(iso, now = new Date()) {
  const then = Date.parse(String(iso).includes('T') ? iso : `${String(iso).replace(' ', 'T')}Z`);
  if (!Number.isFinite(then)) return 'unknown';
  const mins = Math.max(0, Math.round((new Date(now).getTime() - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

/**
 * One claim per hour. Written BEFORE the send, for the same reason
 * brainalert.mjs writes it first: a send that throws must not leave the
 * window open, or a five-minute cron sends twelve.
 */
async function claim(env, scope, level, window) {
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO num_sms_alerts (scope, level, window) VALUES (?1, ?2, ?3)',
  ).bind(scope, level, window).run().catch(() => null);
  return !!r?.meta?.changes;
}

/**
 * One tick, called from the five-minute cron.
 *
 * Reads only `num_signin_events`, which both the Verify path and the legacy
 * Messaging path write. Deliberately does NOT call Twilio: on 20 Sep the
 * whole account was refusing requests, so a watchdog that had to ask Twilio
 * for permission to report that Twilio was refusing permission would have
 * been silent too.
 */
export async function alertOnSms(env, { now = new Date(), alertFn = null } = {}) {
  if (!env?.DB) return { level: 'quiet', sent: [] };
  await ensure(env);

  const { results: rows } = await env.DB.prepare(
    `SELECT outcome, reason, COUNT(*) AS n
       FROM num_signin_events
      WHERE stage = 'send'
        AND via <> 'email'
        AND ts >= datetime('now', ?1)
      GROUP BY outcome, reason`,
  ).bind(`-${WINDOW_MINUTES} minutes`).all().catch(() => ({ results: null }));
  if (!rows) return { level: 'quiet', sent: [], why: 'no signin table' };

  const a = assess(rows);

  const last = await env.DB.prepare(
    "SELECT MAX(ts) AS ts FROM num_signin_events WHERE stage='send' AND outcome='ok' AND via <> 'email'",
  ).first().catch(() => null);
  const lastOkAt = last?.ts ?? null;

  const send = alertFn ?? (async (text) => {
    const { alert } = await import('./health.mjs');
    // kind 'sms_down' is on alerttriage's NEVER_GATED list. Whether members
    // can sign in is not a judgement call.
    return alert(env, text, { kind: 'sms_down', subject: 'no verification code has sent' });
  });

  const sent = [];

  // ── SOMEBODY IS LOCKED OUT EVEN THOUGH THE CHANNEL IS UP ────────────────
  //
  // Checked BEFORE the all-clear return, because this is precisely the case
  // that hides behind a healthy channel. See BLOCKED_CLASS above for the
  // Indonesian evening that put it here.
  for (const [code, n] of a.blocked ?? []) {
    if (await claim(env, `blocked:${code}`, 'blocked', dayFor(now))) {
      await send(`[sign-in] ${n} verification code(s) refused with Twilio ${code} in the last ${WINDOW_MINUTES} min `
        + `while the channel itself is up — a whole group of people cannot sign in. ${BLOCKED_CLASS[code]}`);
      sent.push({ level: 'blocked', reason: code, n });
    }
  }

  // ── ALL CLEAR ────────────────────────────────────────────────────────────
  // Without this the only way to learn it is over is to go and look, which
  // is the behaviour this file exists to replace.
  if (a.level === 'ok') {
    const { results: open } = await env.DB.prepare(
      "SELECT 1 FROM num_sms_alerts WHERE scope='sms' AND level='down' LIMIT 1",
    ).all().catch(() => ({ results: [] }));
    if ((open ?? []).length) {
      await send(`[sign-in] back up — codes are sending again (${a.ok} in the last ${WINDOW_MINUTES} min).`);
      sent.push({ level: 'recovered' });
      await env.DB.prepare("DELETE FROM num_sms_alerts WHERE scope='sms'").run().catch(() => {});
    }
    return { level: a.level, sent, assessment: a, last_ok_at: lastOkAt };
  }

  if (a.level === 'down') {
    if (await claim(env, 'sms', 'down', windowFor(now))) {
      await send(messageFor(a, { lastOkAt, now }));
      sent.push({ level: 'down', reason: a.reason, failed: a.failed });
    }
  }

  return { level: a.level, sent, assessment: a, last_ok_at: lastOkAt };
}
