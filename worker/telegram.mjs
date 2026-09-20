/**
 * THE WIRE THAT IS NOT OWNED BY ANYONE WE ALREADY DEPEND ON.
 *
 * Dre, 20 Sep 2026: "If this ever happens, I need an immediate text message
 * to alert me."
 *
 * ── WHY NOT JUST USE THE TEXT CHANNEL WE ALREADY HAVE ────────────────────
 *
 * health.alert() has sent texts through Twilio since August. On 20 Sep 2026
 * Twilio started refusing every request on this account with error 20003 —
 * permission denied, an account-level failure — and stayed that way for more
 * than nine hours while the biggest signup day in the product's life ran
 * through a broken front door.
 *
 * Had a watchdog existed that morning, it would have tried to tell Dre by
 * text, and the text would have been rejected by the same dead account that
 * caused the outage. The alarm would have been mute for exactly the reason
 * it was ringing.
 *
 * That is the same category error as the 81 dead `ops.alert` rows in
 * failures.mjs, one layer up: a reporting path that shares a dependency with
 * the thing it reports on is not a reporting path. So this file exists to be
 * the channel with NOTHING in common with the rest of the stack — not
 * Twilio, not Resend, not Cloudflare Email, not our own domain, not our own
 * DNS. One outbound HTTPS call to a third party we use for nothing else.
 *
 * ── WHY TELEGRAM AND NOT A SECOND SMS COMPANY ────────────────────────────
 *
 * A real text from Vonage or Plivo would still be a text, but every US SMS
 * vendor sits behind the same carrier registration (A2P 10DLC) that Num
 * waited three weeks for in August. A second vendor buys a second copy of
 * the same multi-week dependency, and buys it in the exact scenario where we
 * need the alarm working today. Telegram needs no registration, no sender
 * pool and no carrier, delivers in under a second, and buzzes a phone the
 * same way a text does.
 *
 * ── DESIGN RULES ─────────────────────────────────────────────────────────
 *
 * 1. NEVER THROWS. This is called from inside an alert path. A channel that
 *    can throw takes down the alerting system it was added to protect.
 * 2. NEVER RETRIES. The five-minute cron is the retry. A loop here would
 *    hold a Worker invocation open during an incident.
 * 3. REPORTS HONESTLY. Returns {ok:false} on an HTTP error rather than
 *    swallowing it, because health.alert() decides whether ANY channel
 *    carried the message, and a lie here recreates the 30 Aug blind spot
 *    where trying and succeeding were indistinguishable.
 * 4. UNCONFIGURED IS NOT A FAILURE. A deployment without the secrets set
 *    reports `skipped`, so it never counts as a delivery and never raises a
 *    false alarm about the alerter.
 */

/** Telegram rejects anything past 4096 characters outright. */
const LIMIT = 4000;

/** Is this deployment wired for Telegram at all. */
export function configured(env) {
  return !!(env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_CHAT_ID);
}

/**
 * Send one message. Resolves to {ok, skipped?, status?, error?} — never rejects.
 *
 * `disable_web_page_preview` matters more than it looks: alert text often
 * carries a console URL, and without it Telegram renders a large link card
 * that pushes the actual message off a phone's notification preview.
 */
export async function notify(env, text, { timeoutMs = 8000 } = {}) {
  if (!configured(env)) return { ok: false, skipped: true, error: 'telegram not configured' };
  const body = String(text ?? '').slice(0, LIMIT);
  if (!body.trim()) return { ok: false, skipped: true, error: 'empty message' };

  // A hung request is worse than a failed one here: the cron has other work
  // and an alert that has not arrived in eight seconds has already lost its
  // race with a human noticing.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: body,
        disable_web_page_preview: true,
      }),
      signal: ctl.signal,
    });
    if (r.ok) return { ok: true, status: r.status };
    // Telegram puts the real reason in the body, and it is almost always one
    // of two setup mistakes worth naming rather than logging as "400":
    // a wrong chat id, or a bot the user has never pressed Start on.
    const detail = await r.text().catch(() => '');
    return { ok: false, status: r.status, error: detail.slice(0, 200) || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}
