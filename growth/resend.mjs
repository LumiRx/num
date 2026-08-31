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
  return { ok: true, sent: messages.length, ids };
}

export async function sendBatch(env, messages) {
  if (!messages.length) return { ok: true, sent: 0, ids: [] };
  if (!env.RESEND_KEY) {
    if (env.EMAIL?.send) return viaCloudflareOneByOne(env, messages);
    return { ok: false, sent: 0, ids: [], error: 'no RESEND_KEY and no EMAIL binding' };
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
    // 401/403 is the key itself, not this batch. Retrying it on the next tick
    // changes nothing, so fall through to Cloudflare rather than reporting a
    // failure that stops the drain for as long as the key stays broken.
    if ((res.status === 401 || res.status === 403) && env.EMAIL?.send) {
      return viaCloudflareOneByOne(env, messages);
    }
    return { ok: false, sent: 0, ids: [], error: 'resend ' + res.status + ' ' + detail };
  }
  const body = await res.json().catch(() => ({}));
  const ids = (body.data || []).map((d) => d.id);
  return { ok: true, sent: messages.length, ids };
}
