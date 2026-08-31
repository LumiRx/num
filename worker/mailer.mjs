// One way to send an email, with more than one way for it to arrive.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// On 30 Aug 2026 the invite cron had been running every five minutes for five
// days and every single send was refused:
//
//   resend 403 — This API key is not authorized to send emails from itsnum.com
//
// The key was set. The domain was verified. SPF, DKIM and the SES feedback MX
// were all live. The key was simply a restricted sending key with no
// authorised domain attached, and nothing in the system noticed — the failure
// was one column in one table nobody read.
//
// Two things were wrong and only one of them was the key.
//
//   1. THERE WAS NO SECOND WAY OUT. A single transport with a broken
//      credential is a company that cannot talk to anybody, and the fix lives
//      in a dashboard somebody has to open.
//   2. NOTHING SAID SO. A send path that fails silently for five days is
//      worse than one that fails loudly for five minutes.
//
// So: ordered transports, and every send reports which one carried it.
//
// ── THE SECOND TRANSPORT WAS ALREADY THERE ───────────────────────────────
//
// `wrangler.app.jsonc` has carried `"send_email": [{ "name": "EMAIL" }]` all
// along — an unrestricted Cloudflare Email binding, bound to the Worker,
// never called once. itsnum.com is on Cloudflare DNS, and Cloudflare sends to
// verified destination addresses in the account for free even when only Email
// Routing is configured.
//
// That does not make it a full replacement: sending to an ARBITRARY address
// needs the domain onboarded to Email Sending (which adds records under
// cf-bounce.itsnum.com and, importantly, does NOT touch the root MX — the
// existing SES inbound keeps working). Until that is done this transport
// reaches the team and not the world, which is still the difference between
// "we cannot answer Adam" and "we can".

export const TRANSPORT = Object.freeze({
  RESEND: 'resend',
  CLOUDFLARE: 'cloudflare',
  NONE: 'none',
});

const asArray = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean);

/** A message, normalised, so every transport reads the same object. */
export function normalise(msg = {}, env = {}) {
  const to = asArray(msg.to).map((s) => String(s).trim().toLowerCase());
  const toSet = new Set(to);
  /**
   * Who gets a blind copy.
   *
   * `MAIL_BCC` is the standing address that must see anything a lead could
   * reply to. `bulk: true` opts a send out of it — a copy of all 39,271
   * outreach invites is not a safety net, it is a second dead mailbox, and
   * some providers count every BCC against the send.
   *
   * A recipient who is already on `to` is not also blind-copied: that is how
   * somebody gets two of the same email and stops reading either.
   */
  const bcc = (msg.bulk ? [] : [...asArray(msg.bcc), ...(env?.MAIL_BCC ? [env.MAIL_BCC] : [])])
    .map((s) => String(s).trim().toLowerCase())
    .filter((a) => a && !toSet.has(a));
  return {
    to,
    bcc: [...new Set(bcc)],
    from: String(msg.from || env?.MAIL_FROM || 'NUM <info@itsnum.com>'),
    /**
     * Never null if we can help it. A reply goes to From unless told
     * otherwise, and the default From is info@itsnum.com — the address whose
     * inbound has been rejecting at the SMTP layer. Every lead who hit reply
     * on anything NUM has ever sent got a bounce.
     */
    replyTo: msg.replyTo ? String(msg.replyTo) : (env?.MAIL_REPLY_TO ? String(env.MAIL_REPLY_TO) : null),
    subject: String(msg.subject ?? '').slice(0, 300),
    text: msg.text ? String(msg.text) : null,
    html: msg.html ? String(msg.html) : null,
  };
}

/** Bare address out of "Name <a@b.c>", which Cloudflare's API wants. */
export function bareAddress(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim();
}
export function displayName(from) {
  const m = String(from).match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : null;
}

/** What is wrong with this message, if anything. Checked before any transport. */
export function invalid(m) {
  if (!m.to.length) return 'no recipient';
  if (m.to.some((t) => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t))) return 'a recipient address is malformed';
  if (!m.subject) return 'no subject';
  if (!m.text && !m.html) return 'no body';
  return null;
}

/* ── TRANSPORTS ──────────────────────────────────────────────────────────
   Each returns {ok, id?, error?}. None throws — a transport that throws
   takes the next one down with it. */

async function viaResend(env, m) {
  const key = env.RESEND_KEY || env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'no RESEND_KEY' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: m.from,
        to: m.to,
        subject: m.subject,
        ...(m.text ? { text: m.text } : {}),
        ...(m.html ? { html: m.html } : {}),
        ...(m.bcc?.length ? { bcc: m.bcc } : {}),
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `resend ${res.status} ${body?.message ?? ''}`.trim() };
    return { ok: true, id: body?.id ?? null };
  } catch (e) {
    return { ok: false, error: `resend ${String(e?.message ?? e)}` };
  }
}

/**
 * Cloudflare will only send FROM a domain that is a routing or sending domain
 * on the account. On 30 Aug 2026 itsnum.com was neither — Email Routing read
 * `enabled: false, status: unconfigured` — and every attempt came back
 * "could not find domain config of sending domain".
 *
 * 5arz.com, the parent company's domain, was already `ready` and enabled. So
 * MAIL_CF_FROM names a sender on a domain that actually works, and this
 * transport uses it when the caller's own from-address would be refused.
 *
 * SUBSTITUTING A SENDER IS NOT A FREE ACTION. A reply to a message goes to
 * the From address unless told otherwise, so a silent swap sends the answer
 * somewhere nobody reads — which is the failure that lost 1,051 invite
 * replies in the first place. The original address is therefore preserved as
 * Reply-To, and the result says the swap happened.
 */
async function viaCloudflare(env, m) {
  if (!env.EMAIL?.send) return { ok: false, error: 'no EMAIL binding' };
  const override = env.MAIL_CF_FROM ? String(env.MAIL_CF_FROM) : null;
  const from = override ?? m.from;
  const substituted = !!override && bareAddress(override) !== bareAddress(m.from);
  const replyTo = m.replyTo ?? (substituted ? bareAddress(m.from) : null);
  try {
    const name = displayName(from);
    const out = await env.EMAIL.send({
      to: m.to.length === 1 ? m.to[0] : m.to,
      from: name ? { email: bareAddress(from), name } : bareAddress(from),
      subject: m.subject,
      ...(m.text ? { text: m.text } : {}),
      ...(m.html ? { html: m.html } : {}),
      ...(m.bcc?.length ? { bcc: m.bcc.length === 1 ? m.bcc[0] : m.bcc } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
    return { ok: true, id: out?.messageId ?? null, substitutedFrom: substituted ? bareAddress(from) : null };
  } catch (e) {
    // The two real ones, and both are limits rather than bugs:
    //   "could not find domain config of sending domain" — the FROM domain is
    //   not a routing or sending domain on this account.
    //   "destination not verified" — until a sending domain is onboarded,
    //   Cloudflare reaches only the account's verified destinations.
    return { ok: false, error: `cloudflare ${String(e?.message ?? e)}` };
  }
}

/**
 * Send, trying each transport in order until one carries it.
 *
 * @returns {Promise<{ok:boolean, via:string, id?:string, tried:Array<{via,error}>}>}
 * `tried` always lists what was attempted and why each failed, because the
 * five silent days happened for want of exactly that list.
 */
export async function send(env, message, { order = null } = {}) {
  const m = normalise(message, env);
  const bad = invalid(m);
  if (bad) return { ok: false, via: TRANSPORT.NONE, error: bad, tried: [] };

  const chain = order ?? [TRANSPORT.RESEND, TRANSPORT.CLOUDFLARE];
  const tried = [];
  for (const via of chain) {
    const fn = via === TRANSPORT.RESEND ? viaResend : via === TRANSPORT.CLOUDFLARE ? viaCloudflare : null;
    if (!fn) continue;
    const r = await fn(env, m);
    if (r.ok) return { ok: true, via, id: r.id, substitutedFrom: r.substitutedFrom ?? null, tried };
    tried.push({ via, error: r.error });
  }
  return {
    ok: false,
    via: TRANSPORT.NONE,
    error: tried.map((t) => `${t.via}: ${t.error}`).join(' | ') || 'no transport configured',
    tried,
  };
}

/**
 * Which transports could carry a message right now, and why not.
 *
 * Derived — it asks each transport what it needs rather than reporting a
 * flag. `resend_key_present` answered YES for five days while nothing sent,
 * and that is the failure this shape exists to stop repeating.
 */
export function transports(env) {
  return [
    {
      via: TRANSPORT.RESEND,
      configured: !!(env?.RESEND_KEY || env?.RESEND_API_KEY),
      note: 'a key being present says nothing about whether it is authorised for a domain — see num_invites.error',
    },
    {
      via: TRANSPORT.CLOUDFLARE,
      configured: !!env?.EMAIL?.send,
      note: 'reaches verified destination addresses in the account for free; arbitrary recipients need the domain '
        + 'onboarded to Email Sending (Compute → Email Service → Email Sending → Onboard Domain). That adds records '
        + 'under cf-bounce.itsnum.com and does NOT change the root MX, so the existing SES inbound keeps working.',
    },
  ];
}

/**
 * Record every attempt, so a silent failure becomes a readable row.
 *
 * Writes to num_health, which the health endpoint already reads — the point
 * is that this shows up somewhere a person looks, not in a log nobody tails.
 */
export async function recordSend(env, kind, result) {
  if (!env?.DB) return;
  try {
    // num_health's own shape — verdict / failing / detail, append-only. Using
    // its columns rather than inventing parallel ones means the existing
    // health endpoint surfaces this without being taught to.
    await env.DB.prepare(
      'INSERT INTO num_health (verdict, failing, detail) VALUES (?1, ?2, ?3)',
    ).bind(
      result.ok ? 'ok' : 'fail',
      `mail:${kind}`,
      (result.ok ? `sent via ${result.via}${result.id ? ` (${result.id})` : ''}` : result.error).slice(0, 500),
    ).run();
  } catch (e) {
    console.warn('[mailer] health write failed', e?.message ?? e);
  }
}

/**
 * A one-shot proof that mail leaves the building, run from the cron.
 *
 * Set MAIL_SELFTEST to an address and the next tick sends one message and
 * writes the outcome to num_health under `mail:selftest`. Unset it afterwards.
 * This exists because "is email working" had been answered from configuration
 * for five days and configuration was not the thing that was wrong.
 */
export async function selfTest(env) {
  const to = env?.MAIL_SELFTEST;
  if (!to) return { skipped: true };
  const r = await send(env, {
    to,
    from: env.MAIL_FROM || 'NUM <info@itsnum.com>',
    subject: 'Num mail self-test',
    text: 'If you are reading this, Num can send email again.\n\n'
      + 'Sent by the five-minute cron because MAIL_SELFTEST was set. '
      + 'Unset it now:\n\n'
      + '  npx wrangler secret delete MAIL_SELFTEST --config wrangler.app.jsonc\n\n'
      + 'Num · 5arz Inc.',
  });
  await recordSend(env, 'selftest', r);
  console.log(`[mailer] self-test ${r.ok ? `sent via ${r.via}` : `FAILED — ${r.error}`}`);
  return r;
}
