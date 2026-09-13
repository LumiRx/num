/**
 * One Resend batch call, shared by every sender in this worker.
 *
 * Extracted from worker.js on 26 Aug 2026 when the invite drain needed the
 * exact same call the host-invite drain already made. Two copies of "how we
 * talk to Resend" is two places a header or an error-handling choice can
 * drift — the batch idempotency key, the 300-char error clip, the shape of
 * the ok/sent/ids/error return — so there is now one.
 */

function randomHex(bytes = 12) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {object} env               needs RESEND_KEY
 * @param {object[]} messages        Resend batch-send message objects. Each
 *   may carry `__idem` (stripped before sending) to name its own idempotency
 *   key; the batch's own idempotency key comes from the first message's
 *   `__idem`, or a random one when none is given.
 * @returns {Promise<{ok:boolean, sent:number, ids:string[], error?:string}>}
 *   `sent` is `messages.length` on success — Resend's batch endpoint is
 *   all-or-nothing, so a caller never gets a partial count back from here.
 */
/**
 * Cloudflare Email Sending, one message at a time.
 *
 * Resend's batch endpoint takes the whole tick in one call; Cloudflare's
 * binding takes one message. At a ramp that opens on 50 a day that difference
 * costs nothing, and it is the only transport that currently works: the
 * production Resend key returns 401 "API key is invalid", and the copy on disk
 * is a restricted key authorised for no domain we own (checked against
 * itsnum.com, mail.itsnum.com, 5arz.com and thatislumi.com on 31 Aug).
 *
 * All-or-nothing is deliberately preserved. `drainInvites` marks a lead
 * `invited` on a reported success, so a partial count would silently burn the
 * leads the caller believes were skipped. If any message fails, the whole tick
 * reports failure and the drain releases every lead it claimed.
 */
async function viaCloudflareOneByOne(env, messages) {
  const { send } = await import('../worker/mailer.mjs');
  const ids = [];
  for (const { __idem, ...m } of messages) {
    const out = await send(env, {
      to: m.to,
      from: m.from,
      subject: m.subject,
      text: m.text,
      html: m.html,
      replyTo: Array.isArray(m.reply_to) ? m.reply_to[0] : m.reply_to,
      // A copy of every invite is not a safety net, it is a second mailbox
      // nobody reads — and some providers count each BCC against the send.
      bulk: true,
    }, { order: ['cloudflare'] });
    if (!out?.ok) {
      return { ok: false, sent: 0, ids: [], error: `cloudflare ${out?.error ?? 'unknown'}`.slice(0, 300) };
    }
    ids.push(out.id);
  }
  // `via` exists because of a real half-hour of confusion on 12 Sep 2026: a
  // bill-settled email reported ok, wrote no row to num_mail_events, and the
  // only clue that it had gone out over Cloudflare rather than Resend was the
  // SHAPE of the returned id (an RFC Message-ID, not a Resend UUID). A caller
  // should never have to decode an id format to learn which rail it used.
  return { ok: true, sent: messages.length, ids, via: 'cloudflare' };
}

/**
 * Send a batch, and NEVER claim a delivery we cannot make.
 *
 * THE FALLBACK NO LONGER REPORTS SUCCESS BY DEFAULT, and that is the whole
 * point of this function now.
 *
 * It used to drop to Cloudflare on a 401/403 and return `ok: true`. The
 * reasoning was that a bad key is not this batch's fault, so stopping the drain
 * helps nobody. Half right, and the wrong half is expensive: the Cloudflare
 * binding only reaches destinations verified on the account, so for a merchant,
 * a host or a guest it ACCEPTS the message and discards it. mailer.mjs refuses
 * to put Cloudflare in the external chain for exactly this reason, in a comment
 * naming the cost — "six businesses became unreachable-forever rather than
 * merely un-emailed" — and this function reached past that guard with
 * `{ order: ['cloudflare'] }`.
 *
 * So the drain kept draining into nothing, every ledger wrote `sent`, and
 * because a lead is only mailed once, those leads were spent. A loud failure is
 * retried. A false success never is.
 *
 * `internal: true` is the opt-in for mail going to an address that IS verified
 * on the Cloudflare account — ops alerts to ourselves. Everything else fails,
 * and says why.
 */
export async function sendBatch(env, messages, { internal = false } = {}) {
  if (!messages.length) return { ok: true, sent: 0, ids: [] };
  if (!env.RESEND_KEY) {
    if (internal && env.EMAIL?.send) {
      const out = await viaCloudflareOneByOne(env, messages);
      return { ...out, fell_back_from: 'no RESEND_KEY' };
    }
    return {
      ok: false, sent: 0, ids: [],
      error: 'no RESEND_KEY' + (env.EMAIL?.send
        ? ' — refusing the Cloudflare rail for outside recipients, it would accept and discard'
        : ' and no EMAIL binding'),
    };
  }
  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.RESEND_KEY,
      'content-type': 'application/json',
      'idempotency-key': messages[0].__idem || randomHex(12),
    },
    body: JSON.stringify(messages.map(({ __idem, ...m }) => m)),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // 401/403 is the key itself, not this batch — retrying on the next tick
    // changes nothing. That used to justify falling through to Cloudflare for
    // everyone. It only justifies it for recipients Cloudflare can actually
    // reach, which means addresses verified on our own account.
    if ((res.status === 401 || res.status === 403) && internal && env.EMAIL?.send) {
      const out = await viaCloudflareOneByOne(env, messages);
      return { ...out, fell_back_from: ('resend ' + res.status + ' ' + detail).slice(0, 200) };
    }
    // A rejected key is loud now. It stops the drain, which is the point: the
    // alternative was spending every lead on a rail that cannot reach them.
    return { ok: false, sent: 0, ids: [], error: 'resend ' + res.status + ' ' + detail };
  }
  const body = await res.json().catch(() => ({}));
  const ids = (body.data || []).map((d) => d.id);
  return { ok: true, sent: messages.length, ids, via: 'resend' };
}
