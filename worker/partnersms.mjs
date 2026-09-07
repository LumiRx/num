/**
 * Text updates for the people who run the businesses and the hosts.
 *
 * ── WHAT DRE ASKED FOR ───────────────────────────────────────────────────
 *
 * 7 Sep 2026: "when business sign up or host sign up they opt in to be text
 * updates from us. so we can be in touch with them."
 *
 * ── WHAT WAS ALREADY THERE, AND WHY IT COULD NEVER HAVE WORKED ───────────
 *
 * Hosts have had an `sms_opt_in` column since migration 0013, with a checkbox
 * on the host dashboard that sets it. Nothing has ever read it to decide
 * whether to send. Nothing wrote a consent row when it was ticked. So:
 *
 *   · `smsconsent.reachable()` — the check every sender in this codebase runs
 *     before a message goes out — answers "no consent on file" for every host
 *     who has ever ticked that box, and fails closed. Correctly.
 *   · Which means the box is a light switch wired to nothing. A host ticks it,
 *     believes they will hear from us, and never does.
 *
 * That is the same shape as the member bug fixed on 4 Sep: a verified member
 * had no consent row, so every "text the guest" path failed closed for
 * everyone. Businesses did not even have the switch.
 *
 * ── SO CONSENT IS RECORDED WHERE CONSENT LIVES ───────────────────────────
 *
 * `num_sms_consent` is the register, and `smsconsent.record()` is the only way
 * into it. This file does not invent a second one. What it adds is the door
 * for the two partner types, and three rules that keep the register worth
 * having:
 *
 *   1. THE BOX IS NEVER PRE-TICKED. A pre-checked box is not express written
 *      consent under the TCPA, it is the single most reliable way an opt-in
 *      programme is destroyed in front of a jury, and it produces a list of
 *      people who did not agree — which does not convert either.
 *
 *   2. THE SENTENCE RECORDED IS THE SENTENCE SHOWN. One exported constant
 *      renders the label AND goes into the consent row. Two strings drift, and
 *      the day they drift the register stops being evidence and becomes a
 *      claim.
 *
 *   3. TICKING WITHOUT A NUMBER IS NOT AN OPT-IN. `hostintegrity.mjs` already
 *      reports `sms_on_without_number` as live drift. Rather than record
 *      consent against nothing, this refuses and says which field is missing.
 *
 * ── TRANSACTIONAL IS NOT THE SAME PERMISSION, AND IS NOT GATED HERE ──────
 *
 * A booking request going to the venue phone (`bookdesk.mjs`) and a sign-in
 * code are transactional: the partner asked for that specific thing, in the
 * moment, and no separate opt-in is needed or implied. THIS consent covers the
 * other kind — product news, a nudge that their listing is incomplete, "you
 * are live", "you have had six requests this week".
 *
 * Keeping them apart is not pedantry. Carriers and courts both draw the line
 * there, and a campaign that sends marketing under a transactional
 * registration is how a messaging account is lost. `SCOPE` records which one
 * a given consent row was for, so nobody has to reconstruct it later.
 */
import * as consent from './smsconsent.mjs';

/** Which partner is opting in. */
export const KIND = Object.freeze({ BUSINESS: 'business', HOST: 'host' });

/**
 * What the consent is FOR. Recorded, not inferred.
 *
 * `updates` is the one this file grants. `transactional` is listed so the
 * distinction is written down somewhere a future reader will find it, and so
 * a row can never quietly mean both.
 */
export const SCOPE = Object.freeze({
  UPDATES: 'updates',
  TRANSACTIONAL: 'transactional',
});

/**
 * The sentence, shown and recorded.
 *
 * It names who is texting, what about, how often it could be, that rates
 * apply, and the way out. Those five are what a consent disclosure has to
 * carry; a cheerful "keep me posted!" carries none of them.
 */
export const PARTNER_CONSENT_TEXT =
  'Yes — NUM may text this number about my listing: when it goes live, when it needs '
  + 'something, and when there are requests waiting. A few messages a month. '
  + 'Message and data rates may apply. Reply STOP to stop, HELP for help.';

/** The label a partner reads next to the checkbox. Same string, one source. */
export const consentCheckbox = ({ id = 'sms_opt_in', name = 'sms_opt_in', checked = false } = {}) => `
  <label for="${id}" style="margin-top:14px;display:block">
    <input type="checkbox" id="${id}" name="${name}" value="1"${checked ? ' checked' : ''}>
    ${PARTNER_CONSENT_TEXT}
  </label>`;

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_partner_sms (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  partner_id  TEXT NOT NULL,
  phone       TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'updates',
  consent_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT,
  UNIQUE (kind, partner_id)
)`;
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_partner_sms_phone ON num_partner_sms(phone)',
];
const ready = new WeakSet();
export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.prepare(SCHEMA).run();
  for (const sql of INDEXES) await env.DB.prepare(sql).run().catch(() => {});
  ready.add(env.DB);
}

/**
 * Take a partner's opt-in.
 *
 * Returns a stated reason rather than a boolean, because every one of these
 * failures is something the form has to be able to tell the person standing
 * in front of it.
 */
export async function optIn(env, {
  kind, partnerId, phone, ticked, page = null, ip = null, userAgent = null, country = null, name = null,
}) {
  if (!env?.DB) return { ok: false, error: 'Momentarily unavailable — try again in a minute.' };
  if (!Object.values(KIND).includes(kind)) return { ok: false, error: `unknown partner kind ${kind}` };
  if (!partnerId) return { ok: false, error: 'partnerId is required' };

  // Not an error, and not silent either. An unticked box is a decision, and
  // the caller needs to be able to tell it apart from a failure.
  if (!ticked) return { ok: true, optedIn: false, reason: 'not_ticked' };

  if (!consent.validPhone(phone)) {
    return {
      ok: false,
      optedIn: false,
      error: 'Add a mobile number in full international form (+1…) to get text updates.',
    };
  }

  const rec = await consent.record(env, {
    phone,
    source: consent.SOURCE.WEB_FORM,
    consentText: `[${kind}/${SCOPE.UPDATES}] ${PARTNER_CONSENT_TEXT}`,
    page, ip, userAgent, country, firstName: name,
  });
  if (!rec.ok) return { ok: false, optedIn: false, error: rec.error };

  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO num_partner_sms (id, kind, partner_id, phone, scope, consent_at, revoked_at)
     VALUES (?1,?2,?3,?4,?5,datetime('now'),NULL)
     ON CONFLICT(kind, partner_id) DO UPDATE SET phone = ?4, revoked_at = NULL`,
  ).bind(
    `psms_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    kind, String(partnerId), String(phone).trim(), SCOPE.UPDATES,
  ).run();

  return { ok: true, optedIn: true, phone: String(phone).trim() };
}

/**
 * They asked to stop.
 *
 * The partner row is marked and the consent register is told, because a STOP
 * given on a dashboard means the same thing as a STOP sent by text, and a
 * product where those two disagree will eventually text someone who said no.
 */
export async function optOut(env, { kind, partnerId }) {
  if (!env?.DB || !partnerId) return { ok: false };
  await ensure(env);
  const row = await env.DB.prepare(
    'SELECT phone FROM num_partner_sms WHERE kind = ?1 AND partner_id = ?2',
  ).bind(kind, String(partnerId)).first().catch(() => null);

  await env.DB.prepare(
    `UPDATE num_partner_sms SET revoked_at = datetime('now')
      WHERE kind = ?1 AND partner_id = ?2`,
  ).bind(kind, String(partnerId)).run();

  if (row?.phone) {
    await env.DB.prepare(
      "UPDATE num_sms_consent SET revoked_at = unixepoch() WHERE phone = ?1",
    ).bind(row.phone).run().catch(() => {});
  }
  return { ok: true };
}

/**
 * May we text this partner right now, and if not, why not?
 *
 * Both registers have to agree. The partner row says they asked us to; the
 * consent register is the one that also knows about a STOP sent by text, an
 * opt-out recorded elsewhere, or a revocation. Either saying no is a no.
 */
export async function reachable(env, { kind, partnerId }) {
  if (!env?.DB || !partnerId) return { ok: false, why: 'no consent on file' };
  await ensure(env);
  const row = await env.DB.prepare(
    'SELECT phone, revoked_at FROM num_partner_sms WHERE kind = ?1 AND partner_id = ?2',
  ).bind(kind, String(partnerId)).first().catch(() => null);
  if (!row) return { ok: false, why: 'they have not opted in to text updates' };
  if (row.revoked_at) return { ok: false, why: 'they opted out' };

  const reg = await consent.reachable(env, row.phone);
  if (!reg.ok) return { ok: false, why: reg.why };
  return { ok: true, phone: row.phone };
}
