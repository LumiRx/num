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

/* ── THE NUMBER A HUMAN CAN TEXT ───────────────────────────────────────────
 *
 * Found 19 Sep 2026, walking the host console. The host console promises three
 * separate times that "your supplier can text a photo straight to NUM", the
 * supplier invite email promises the same thing, and the photo queue, the
 * moderation panel and resolveSupplier() all exist to receive it. The inbound
 * path is real: worker/sms.mjs answers the webhook and calls ingestMedia.
 *
 * The number to send them TO was printed nowhere. Not in the console, not in
 * the invite email, not on any page. The invite did name a number, correctly —
 * the supplier's own, as the number they send FROM, which is how we know whose
 * photograph it is — so the sentence read as a complete instruction while the
 * only part a supplier actually needed was absent. The console was plainer
 * about the gap and no more useful: "text a photo to your NUM number", three
 * times, to a host who has never been told what that number is.
 *
 * A working feature nobody can address is not a working feature, so it lives
 * here beside senderParams: one function, one truth, and a null that callers
 * must handle by dropping the promise rather than printing a blank.
 *
 * NUM_SMS_NUMBER is preferred because the number that ANSWERS the webhook need
 * not be the number we send from. TWILIO_FROM is the fallback because when we
 * do send from it, it is already sitting in the supplier's message thread as
 * the number to reply to. A Messaging Service SID is never returned: "MG64f…"
 * is not something a person can text.
 */
export function numSmsNumber(env) {
  for (const v of [env?.NUM_SMS_NUMBER, env?.TWILIO_FROM]) {
    // Spaces, brackets, hyphens and the unicode dashes a number gets pasted
    // with are stripped; nothing else is, so a letter still fails the test.
    const s = String(v || '').trim().replace(/[\s()./-]/g, '')
      .replace(/[‐‑‒–—―]/g, '');
    // E.164 and nothing else. A short code, an alphanumeric sender id or a
    // half-typed number would print as an address a supplier cannot reach.
    if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  }
  return null;
}
