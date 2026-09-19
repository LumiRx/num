/**
 * A BUSINESS REPLIES, AND NUM HEARS IT.
 *
 * ── THE ROUTE, AND WHY IT COSTS NOTHING ──────────────────────────────────
 *
 * itsnum.com's MX already points at Cloudflare (route1/2/3.mx.cloudflare.net),
 * because Email Routing has been handling the domain since before any of this.
 * A Cloudflare Email Worker hangs off that same MX: a routing rule sends the
 * address to this Worker, the Worker is handed the raw message, and no DNS
 * changes, no second provider and no MX cutover are involved.
 *
 * The alternative was moving the MX to Resend, which would have taken the
 * whole domain's inbound mail with it for the sake of a nicer API on one
 * address. Not worth it.
 *
 * ── THE ONE RULE THIS FILE KEEPS ─────────────────────────────────────────
 *
 * NOTHING THAT ARRIVES IS EVER DISCARDED.
 *
 * A message that matches no thread opens one. A message that cannot be parsed
 * is stored raw. A duplicate is a no-op and not an error. An auto-reply is
 * recorded and simply does not raise the flag. Every one of those paths exists
 * because the alternative is a restaurant writing to us and NUM deciding, on
 * its own, that it did not count — which is exactly what was happening when
 * replies went to a personal mailbox on another domain.
 *
 * The message is also FORWARDED to the human address, always, before any of
 * the above is attempted. If everything in this file throws, a person still
 * gets the email. That ordering is the whole safety argument: recording is an
 * improvement on forwarding, never a replacement for it.
 *
 * ── AND IT NEVER REPLIES ─────────────────────────────────────────────────
 *
 * This handler writes rows and sends one alert to us. It does not answer the
 * business. Drafting an answer is bizreply.mjs, sending it needs a human tap,
 * and the two are kept apart so that no inbound message can ever cause an
 * outbound one on its own.
 */

import { parseMessage, topReply } from './mailparse.mjs';
import { matchThread, openThread, record, bareAddress } from './bizthread.mjs';

const MAX_BYTES = 2 * 1024 * 1024;

async function rawOf(message) {
  // message.raw is a ReadableStream. Bounded on purpose: a 30 MB message with
  // a video attached must not be pulled into memory to find one paragraph.
  const reader = message.raw.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { chunks.push(value.slice(0, Math.max(0, MAX_BYTES - (size - value.length)))); break; }
    chunks.push(value);
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(all), truncated: size > MAX_BYTES, size };
}

/**
 * The Cloudflare `email()` handler.
 *
 * Exported separately from the Worker's default export so it can be called
 * with a fake message in a test — an email handler that can only be exercised
 * by sending real mail to production is one nobody exercises.
 */
export async function handleInboundEmail(message, env, ctx) {
  // FIRST, ALWAYS. Before parsing, before the database, before anything that
  // can throw. A person's inbox is the fallback for every bug below.
  const humanCopy = env?.MAIL_INBOUND_FORWARD || env?.ADMIN_EMAIL;
  if (humanCopy) {
    try { await message.forward(humanCopy); } catch (e) {
      console.error('[bizinbound] forward failed', String(e).slice(0, 200));
    }
  }

  let parsed = null; let raw = null;
  try {
    raw = await rawOf(message);
    parsed = parseMessage(raw.text);
  } catch (e) {
    console.error('[bizinbound] parse failed', String(e).slice(0, 200));
  }

  const from = bareAddress(parsed?.from ?? message.from);
  const toList = [
    ...(parsed?.to ?? []),
    parsed?.deliveredTo,
    message.to,
  ].filter(Boolean);

  const { thread: found, how } = await matchThread(env, {
    to: toList,
    inReplyTo: parsed?.inReplyTo,
    references: parsed?.references,
    from,
  }).catch(() => ({ thread: null, how: null }));

  // No match is not a reason to drop it. Somebody wrote to us.
  const thread = found ?? await openThread(env, {
    email: from,
    businessName: null,
    state: 'wrote_in',
  }).catch(() => null);

  if (!thread) {
    // The database is unreachable. The forward above already happened, so the
    // message is not lost — say so loudly and stop.
    console.error('[bizinbound] could not open a thread; the forwarded copy is the only record');
    return;
  }

  const body = parsed?.text && parsed.text.trim()
    ? parsed.text
    : `[NUM could not read this message's body — the raw source follows]\n\n${raw?.text ?? ''}`;

  const out = await record(env, thread.id, {
    direction: 'in',
    from: parsed?.from ?? message.from,
    to: message.to,
    subject: parsed?.subject ?? '(no subject)',
    body,
    messageId: parsed?.messageId,
    inReplyTo: parsed?.inReplyTo,
    matchedBy: found ? how : 'unmatched',
  }).catch(() => ({ ok: false }));

  if (out?.duplicate) return;

  // An auto-reply is a fact about a mail server. It is on the thread, and it
  // does not mean a person answered, so the flag comes back down.
  if (parsed?.auto) {
    await env.DB?.prepare('UPDATE num_biz_threads SET needs_reply = 0 WHERE id = ?1')
      .bind(thread.id).run().catch(() => {});
    return;
  }

  const notify = async () => {
    const { send, AUDIENCE } = await import('./mailer.mjs');
    const site = env?.SITE || 'https://itsnum.com';
    const who = thread.business_name ? `${thread.business_name} <${from}>` : from;
    await send(env, {
      to: env?.ALERT_EMAIL_TO || env?.ADMIN_EMAIL,
      from: env?.ALERT_EMAIL_FROM || 'NUM <alerts@itsnum.com>',
      subject: `${thread.business_name || from} replied`,
      text: [
        `${who} replied to NUM.`,
        thread.state ? `Where they were: ${thread.state}` : null,
        found ? `Matched to their thread by ${how}.` : 'No existing thread matched — a new one was opened.',
        how === 'address' ? 'Matched on the From address alone, which is a guess. Worth a glance.' : null,
        parsed?.attachments?.length
          ? `Attachments (not stored): ${parsed.attachments.map((a) => a.filename).join(', ')}`
          : null,
        '',
        topReply(parsed?.text ?? '').slice(0, 1500),
        '',
        `Answer it: ${site}/ops/threads/${thread.id}`,
      ].filter((l) => l !== null).join('\n'),
    }, { audience: AUDIENCE.INTERNAL }).catch((e) => console.error('[bizinbound] alert failed', String(e).slice(0, 200)));
  };

  // waitUntil so the SMTP transaction is not held open on our alert. If the
  // context has no waitUntil (a test), just await it.
  if (ctx?.waitUntil) ctx.waitUntil(notify());
  else await notify();
}
