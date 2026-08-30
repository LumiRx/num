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
export async function sendBatch(env, messages) {
  if (!messages.length) return { ok: true, sent: 0, ids: [] };
  if (!env.RESEND_KEY) return { ok: false, sent: 0, ids: [], error: 'no RESEND_KEY' };
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
    return { ok: false, sent: 0, ids: [], error: 'resend ' + res.status + ' ' + (await res.text()).slice(0, 300) };
  }
  const body = await res.json().catch(() => ({}));
  const ids = (body.data || []).map((d) => d.id);
  return { ok: true, sent: messages.length, ids };
}
