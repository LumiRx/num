/**
 * The guest's copy, and the only moment they will ever hand over an address.
 *
 * ── WHERE THIS STARTS ────────────────────────────────────────────────────
 *
 * The settled-bill email has existed since 12 Sep 2026 and it goes to the
 * VENUE. The guest got nothing, and the reason was not an oversight: NUM held
 * nowhere to send it. Checked against the live database on 19 Sep 2026:
 *
 *   members with an email       1 / 156   (0 verified)
 *   live push tokens                  0
 *   members with a phone       49 / 156   (11 verified)
 *
 * `num_members.email` exists and is empty. So a guest receipt was never a
 * template problem. It was a destination problem, and no amount of writing
 * copy would have fixed it.
 *
 * ── SO THE ADDRESS IS ASKED FOR AT THE ONE MOMENT IT IS WORTH SOMETHING ──
 *
 * A person who has just paid a bill and is looking at the confirmation is the
 * only person who will ever type an address in to get a receipt. Not at
 * sign-up, where it is a field in the way of something they wanted; not
 * later, where they have no reason. Here, where the thing they are being
 * offered is the thing they are already looking at.
 *
 * ── THE PAGE IS STILL THE RECEIPT ────────────────────────────────────────
 *
 * Giving an address is an ADDITION and never a replacement. `/p/<token>`
 * renders the settled bill for anybody holding the link, needs no contact
 * detail and cannot fail to be delivered because it is already open. A guest
 * who gives nothing has lost nothing. That is why this module cannot refuse a
 * payment, block a page or hold anything up: it is strictly extra.
 *
 * ── CONSENT HERE IS NOT THE CONSENT IN billreach.mjs ─────────────────────
 *
 * billreach texts somebody ELSE'S friend, so it demands a phone-verified
 * sender, caps and a dedupe: the recipient never asked. This is a person
 * asking for their own receipt about their own payment, which is the
 * strongest consent there is, and it needs none of that apparatus.
 *
 * One thing survives regardless. A number that has said STOP does not get
 * texted, even when somebody types it in on this page — a STOP is a standing
 * instruction and not a preference we get to weigh against convenience. The
 * page says so and offers email instead.
 *
 * NOT growth/billreceipt.test.mjs, which guards the VENUE's settled-bill
 * email in growth/worker.js. Same event, opposite recipient: that one tells
 * a merchant what they earned and what it cost, this one tells a guest what
 * they paid. They share nothing but the moment they fire.
 */
import { sendText } from './friendtext.mjs';
import { optedOut, validPhone } from './optout.mjs';
import { send as sendMail, AUDIENCE, senderFor, MAIL_KIND } from './mailer.mjs';

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_bill_receipts (
  id         TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  channel    TEXT NOT NULL,                 -- email | sms
  address    TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_bill_receipt_one ON num_bill_receipts(token, channel, address)',
  'CREATE INDEX IF NOT EXISTS idx_bill_receipt_token ON num_bill_receipts(token, created_at)',
];
const ready = new WeakSet();

export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.prepare(SCHEMA).run();
  for (const sql of INDEXES) await env.DB.prepare(sql).run().catch(() => {});
  ready.add(env.DB);
}

const uid = () => 'rc_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The settled bill, with what was on it. Null when it is not ours or not paid. */
export async function paidBill(env, token) {
  if (!env?.DB || !token) return null;
  const t = String(token).toUpperCase();
  const bill = await env.DB.prepare(
    `SELECT l.token, l.label, l.amount, l.currency, l.settled_at, l.charged_via, l.split_parent,
            b.name AS venue
       FROM num_paylinks l
       JOIN businesses b ON b.id = l.business_id
      WHERE l.token = ?1 AND l.settled_at IS NOT NULL`,
  ).bind(t).first().catch(() => null);
  if (!bill) return null;
  const items = await env.DB.prepare(
    'SELECT name, qty, unit_minor, line_minor FROM num_bill_items WHERE token = ?1 ORDER BY pos',
  ).bind(t).all().catch(() => null);
  return { ...bill, items: items?.results ?? [] };
}

/**
 * The receipt itself. One source for both channels, so the two cannot quote
 * different amounts — which is the only thing on here a person will check.
 */
export function receiptText(bill, { site = 'https://itsnum.com' } = {}) {
  const money = `${bill.currency || ''} ${bill.amount}`.trim();
  const link = `${site}/p/${bill.token}`;
  const lines = (bill.items ?? []).map(
    (i) => `  ${i.qty}x ${i.name}${' '.repeat(Math.max(1, 28 - String(i.name).length))}${(i.line_minor / 100).toFixed(2)}`,
  );
  return {
    subject: `Receipt — ${bill.venue} · ${money}`,
    // Short enough for one SMS segment at any sensible venue name, and it
    // leads with the link, because on a phone the link IS the receipt.
    sms: [
      `${bill.venue} — paid ${money}.`,
      link,
      `Ref ${bill.token}`,
    ].join('\n'),
    text: [
      `${bill.venue}${bill.label ? ` · ${bill.label}` : ''}`,
      '',
      `  Paid      ${money}`,
      `  When      ${bill.settled_at || 'just now'}`,
      bill.charged_via ? `  How       ${bill.charged_via}` : null,
      `  Reference ${bill.token}`,
      ...(lines.length ? ['', 'What was on it:', ...lines] : []),
      '',
      bill.split_parent ? 'This was your share of a bill somebody split.' : null,
      bill.split_parent ? '' : null,
      'Your receipt stays here, and you can open it any time:',
      link,
      '',
      `The money went straight from you to ${bill.venue}. NUM never held it and`,
      'never saw your card. Quote the reference above if you need to ask them',
      'about the bill.',
      '',
      'NUM · 5arz Inc.',
    ].filter((l) => l !== null).join('\n'),
  };
}

/** What has already been sent for this bill, so the page never offers twice. */
export async function sentFor(env, token) {
  if (!env?.DB || !token) return [];
  await ensure(env);
  const out = await env.DB.prepare(
    'SELECT channel, address, ok, detail, created_at FROM num_bill_receipts WHERE token = ?1 ORDER BY created_at DESC LIMIT 20',
  ).bind(String(token).toUpperCase()).all().catch(() => null);
  return out?.results ?? [];
}

async function record(env, { token, channel, address, ok, detail }) {
  await ensure(env);
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO num_bill_receipts (id, token, channel, address, ok, detail)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    ).bind(uid(), String(token).toUpperCase(), channel, address, ok ? 1 : 0, clip(detail, 300)).run();
  } catch (e) {
    console.error('[billreceipt] record failed', String(e?.message ?? e).slice(0, 200));
  }
}

/**
 * Every outcome, as a code and the sentence it means.
 *
 * The page gets the CODE, never the sentence. `payReceipt` redirects back to
 * `/p/<token>` and anything carried in that redirect is a query string, which
 * is to say a thing anybody can write: `?say=Your%20card%20was%20charged%20twice`
 * on a real NUM receipt page, in NUM's own voice, is a better phishing message
 * than most phishing messages. Escaping it stops a script and does nothing
 * about the sentence.
 *
 * So there is no text to smuggle. An unknown code renders nothing.
 */
export const SAID = Object.freeze({
  sent: 'Sent — it should arrive in a moment.',
  already: 'Already sent — check your inbox.',
  empty: 'Type an email address or a mobile number.',
  bademail: 'That does not look like an email address.',
  badnumber: 'Include the country code, like +66 or +44, and we will text it.',
  nobill: 'That bill is not one we can send a receipt for.',
  stopped: 'That number asked us to stop texting. Give an email address instead.',
  nosms: 'We could not text that just now. Your receipt is on this page either way.',
  nomail: 'We could not email that just now. Your receipt is on this page either way.',
});

/** The sentence for a code, or nothing at all for one we did not write. */
export const sayFor = (code) => SAID[String(code || '')] ?? null;

/**
 * Send one guest their receipt.
 *
 * `to` is whatever they typed: an email address or a phone number. Which it is
 * is read off the string rather than asked, because a person who has just paid
 * for dinner should not also have to pick a radio button.
 *
 * Always resolves with a sentence the page can show. A failure here is a
 * failure to send a copy of something already on screen, and it is reported
 * as exactly that rather than as an error about their payment.
 */
export async function sendReceipt(env, token, to, { fetchImpl, site } = {}) {
  const typed = clip(to, 160);
  if (!typed) return { ok: false, code: 'empty', say: SAID.empty };

  const bill = await paidBill(env, token);
  // Deliberately the same answer for a bill that is not ours and one that is
  // not paid: this endpoint must not become a way to ask whether a code exists.
  if (!bill) return { ok: false, code: 'nobill', say: SAID.nobill };

  const isEmail = typed.includes('@');
  if (isEmail && !EMAIL.test(typed)) return { ok: false, code: 'bademail', say: SAID.bademail };
  const phone = isEmail ? null : typed.replace(/[\s()-]/g, '');
  if (!isEmail && !validPhone(phone)) {
    return { ok: false, code: 'badnumber', say: SAID.badnumber };
  }

  await ensure(env);
  const address = isEmail ? typed.toLowerCase() : phone;
  const already = await env.DB.prepare(
    'SELECT ok FROM num_bill_receipts WHERE token = ?1 AND channel = ?2 AND address = ?3 AND ok = 1',
  ).bind(String(token).toUpperCase(), isEmail ? 'email' : 'sms', address).first().catch(() => null);
  if (already) return { ok: true, already: true, code: 'already', say: SAID.already };

  const msg = receiptText(bill, { site: site || env?.SITE || 'https://itsnum.com' });

  if (!isEmail) {
    // A STOP outlives a request. Somebody who asked us never to text them does
    // not get a text because a different screen offered one, and saying so is
    // better than silently doing nothing.
    if (await optedOut(env, phone)) {
      await record(env, { token, channel: 'sms', address, ok: false, detail: 'on the opt-out list' });
      return { ok: false, code: 'stopped', say: SAID.stopped };
    }
    const out = await sendText(env, { to: phone, body: msg.sms, fetchImpl });
    await record(env, { token, channel: 'sms', address, ok: !!out.ok, detail: out.ok ? `queued ${out.sid ?? ''}`.trim() : out.error });
    return out.ok
      ? { ok: true, code: 'sent', say: SAID.sent }
      // Named, not hidden. A guest who is told "sent" and receives nothing
      // stops believing the next thing the product tells them.
      : { ok: false, code: 'nosms', say: SAID.nosms };
  }

  const out = await sendMail(env, {
    to: address,
    from: senderFor(env, MAIL_KIND.TRANSACTIONAL),
    subject: msg.subject,
    text: msg.text,
  }, { audience: AUDIENCE.EXTERNAL });
  await record(env, { token, channel: 'email', address, ok: !!out.ok, detail: out.ok ? `accepted via ${out.via}${out.id ? ` (${out.id})` : ''}` : out.error });
  return out.ok
    ? { ok: true, code: 'sent', say: SAID.sent }
    : { ok: false, code: 'nomail', say: SAID.nomail };
}

/**
 * Which channels this worker could actually use right now.
 *
 * Asked rather than asserted, so the page never offers a box that cannot
 * work. A guest typing into a dead field and hearing nothing is worse than a
 * page that offered nothing.
 */
export function channelsAvailable(env) {
  return {
    email: !!(env?.RESEND_KEY || env?.RESEND_API_KEY),
    sms: !!(env?.TWILIO_SID && env?.TWILIO_TOKEN),
  };
}
