// Consent to be texted: how it is earned, recorded, and proved.
//
// ── THE SITUATION THIS WAS WRITTEN FOR ───────────────────────────────────
//
// On 30 Aug 2026 Num held 1,830,191 business phone numbers scraped from open
// map data and 87,210 more on leads, and `num_sms_consent` had ZERO ROWS.
// Not one person or business had agreed to be texted.
//
// Texting that list is not a growth tactic, it is the end of the company.
// Under the TCPA each unconsented text to a US mobile carries $500–$1,500 in
// statutory damages, per message, and it is the most reliably litigated
// consumer statute in America. Ten thousand messages is a five-to-fifteen
// million dollar exposure and a class action with a ready-made member list.
// The UK (PECR), Thailand (PDPA) and the UAE all reach the same answer by
// different routes.
//
// It also would not have worked. Num's A2P 10DLC campaign is unapproved, so
// US carriers reject every send with 30034 before anybody reads anything.
//
// And Num's own charter already forbade it, in words somebody chose:
//
//   "Send to any number without a consent row. There is no 'probably fine'
//    here."                                    — OUTREACH_SMS.never
//
// ── SO THE LIST IS BUILT THE OTHER WAY ROUND ─────────────────────────────
//
// The strongest consent there is, legally and commercially, is somebody
// texting YOU first. It is unambiguous, it is timestamped by the carrier,
// and the person who did it actually wants to hear back — which is the
// difference between a list that converts and a list that reports you.
//
// Num is a concierge you text. "Text NUM" is not a compliance workaround, it
// is the product's front door. This file turns walking through that door into
// a consent record that would survive being read out in a deposition.
//
// ── WHAT MAKES A CONSENT RECORD DEFENSIBLE ───────────────────────────────
//
// Not a boolean. A defensible record answers: who, what exactly were they
// shown or what exactly did they send, when, from where, and under which
// version of the terms. Anything less is a claim about consent rather than
// evidence of it.

export const CONSENT_VERSION = 'v1';

/**
 * The sentence shown under the phone field at sign-up (InviteSheet.tsx) and
 * recorded, verbatim, the moment the number is verified. Until 4 Sep 2026 a
 * verified member had NO consent row — so every "text the guest" path failed
 * closed for everyone, and the code they asked for was the only text they
 * ever got. A test pins that the app shows exactly this sentence.
 */
export const SIGNUP_CONSENT_TEXT =
  'By continuing, Num may text this number to sign you in and about your own bookings, plans and friends\u2019 invites. Message rates may apply. Reply STOP any time.';

/** How consent arrived, strongest first. */
export const SOURCE = Object.freeze({
  INBOUND_SMS: 'inbound_sms', // they texted us — the strongest there is
  WEB_FORM: 'web_form', //      a ticked box with the text they were shown
  KEYWORD: 'keyword', //        they replied START to an existing thread
  VERBAL: 'verbal', //          logged by a person; weakest, needs a name
});

/**
 * The sentence recorded against an inbound text.
 *
 * It quotes what they actually sent, because the evidence that they initiated
 * contact IS their message. A generic "user opted in" proves nothing.
 */
export const inboundConsentText = (body) =>
  `Sent an unsolicited message to NUM's published number, initiating contact: `
  + `"${String(body ?? '').slice(0, 140)}"`;

const E164 = /^\+[1-9]\d{6,14}$/;
export const validPhone = (p) => E164.test(String(p ?? '').trim());

/**
 * Record consent.
 *
 * Never throws and never overwrites an earlier record's evidence — the FIRST
 * consent is the one that matters if it is ever challenged, so a repeat
 * simply clears any revocation and updates when we last saw them. Rewriting
 * the original text with today's message would destroy the evidence trail.
 *
 * @returns {Promise<{ok:boolean, created?:boolean, error?:string}>}
 */
export async function record(env, {
  phone, source, consentText, page = null, ip = null, userAgent = null, country = null, firstName = null,
}) {
  if (!env?.DB) return { ok: false, error: 'no DB' };
  if (!validPhone(phone)) return { ok: false, error: 'phone must be E.164' };
  if (!Object.values(SOURCE).includes(source)) return { ok: false, error: `unknown consent source ${source}` };
  if (!consentText) return { ok: false, error: 'consent text is required — a boolean is not evidence' };

  try {
    const ins = await env.DB.prepare(
      `INSERT INTO num_sms_consent
         (id, phone, first_name, consent_text, consent_version, page, ip, user_agent, country, created_at, revoked_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,unixepoch(),NULL)
       ON CONFLICT(phone) DO UPDATE SET revoked_at = NULL`,
    ).bind(
      `sc_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
      String(phone).trim(),
      firstName,
      `[${source}] ${consentText}`.slice(0, 500),
      CONSENT_VERSION,
      page,
      ip,
      userAgent ? String(userAgent).slice(0, 200) : null,
      country,
    ).run();
    return { ok: true, created: (ins?.meta?.changes ?? 0) > 0 };
  } catch (e) {
    console.warn('[consent] write failed', e?.message ?? e);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Is this number reachable right now? Consent present, not revoked, not opted out. */
export async function reachable(env, phone) {
  if (!env?.DB || !validPhone(phone)) return { ok: false, why: 'no consent on file' };
  try {
    const row = await env.DB.prepare(
      'SELECT revoked_at FROM num_sms_consent WHERE phone = ?1',
    ).bind(String(phone).trim()).first();
    if (!row) return { ok: false, why: 'no consent on file' };
    if (row.revoked_at) return { ok: false, why: 'they opted out' };
    // The opt-out table this worker actually owns and writes (worker/optout.mjs).
    // The old read here was `num_optouts.contact` — a column that does not
    // exist on a table keyed by another codebase's salted hash — so every
    // STOP recorded anywhere but the consent row was invisible to this check.
    const { optedOut } = await import('./optout.mjs');
    if (await optedOut(env, phone)) return { ok: false, why: 'on the opt-out list' };
    return { ok: true };
  } catch (e) {
    // Fail CLOSED. An error reading the consent register must never be read
    // as permission — that is the one direction this check must not fail in.
    return { ok: false, why: `consent check failed: ${String(e?.message ?? e)}` };
  }
}

/** How many numbers Num may actually text, and how that has been trending. */
export async function audience(env) {
  if (!env?.DB) return { consented: 0, revoked: 0 };
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS live,
            SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
       FROM num_sms_consent`,
  ).first().catch(() => null);
  return { consented: row?.live ?? 0, revoked: row?.revoked ?? 0, total: row?.total ?? 0 };
}
