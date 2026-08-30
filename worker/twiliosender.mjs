/**
 * Which sender Twilio should use — and why this file exists at all.
 *
 * ── THE BUG THIS FIXES ───────────────────────────────────────────────────
 *
 * Every SMS Num has ever sent to a real phone came back `30034`:
 * *"A2P 10DLC campaign is not registered or not approved."* Nine failures
 * across seven real numbers, 5–21 Aug 2026. The only messages that ever
 * landed went to Twilio's magic test number, which never touches a carrier.
 *
 * For a month that was recorded as "A2P is unregistered, wait three weeks".
 * It was not. Checked in the Twilio console on 25 Aug 2026:
 *
 *   Brand    BN1431cc624e18b5df636e25e57a9c6a80   Approved, 28 Jul 2026
 *   Campaign CMe79ec4b4fb42d1790e585495e87b27e0   Approved, Mixed use case
 *   Service  MG64fac228…                          carries the campaign
 *
 * The registration had been approved for a week before the first failure.
 *
 * **A US long code inherits campaign approval through its Messaging Service,
 * not on its own.** Every call site sent `From: <bare number>`, so Twilio had
 * no way to associate the message with the approved campaign, and the carrier
 * rejected it exactly as it rejects an unregistered sender. Same error code,
 * completely different cause — which is why it was misread for a month.
 *
 * ── WHY A SHARED HELPER RATHER THAN THREE EDITS ──────────────────────────
 *
 * There are three senders (claim verification, the booking desk, health
 * alerts) and they drifted apart before. One of them getting the fix and the
 * others not is the same outage again, in a quieter place, and the quiet one
 * is the health alert — the sender whose whole job is to tell us something
 * broke.
 *
 * ── THE FALLBACK IS DELIBERATE ───────────────────────────────────────────
 *
 * With no service SID configured this returns `From` and behaves exactly as
 * before. Non-US destinations do not need a campaign, tests and local runs
 * have no service, and a missing secret must degrade to the old behaviour
 * rather than stop every message in the product.
 */

/**
 * @param {{ TWILIO_MESSAGING_SERVICE_SID?: string, TWILIO_FROM?: string }} env
 * @returns {{ MessagingServiceSid: string } | { From: string } | null}
 *   null when neither is configured — the caller should not attempt a send.
 */
export function senderParams(env) {
  const svc = String(env?.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  // Shape check, not just presence. A Messaging Service SID is "MG" plus 32
  // hex characters; anything else is a paste error (an account SID starts
  // "AC", a campaign "CM", a brand "BN" — all plausible things to paste into
  // the wrong secret, and all of which Twilio would reject at send time with
  // an error nobody would connect back to this).
  if (/^MG[0-9a-f]{32}$/i.test(svc)) return { MessagingServiceSid: svc };

  const from = String(env?.TWILIO_FROM || '').trim();
  if (from) return { From: from };

  return null;
}

/** True when a Messaging Service is configured and usable. */
export const usingMessagingService = (env) =>
  Object.hasOwn(senderParams(env) || {}, 'MessagingServiceSid');
