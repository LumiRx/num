/**
 * Handing a share of a bill to the person it is for.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * billsplit.mjs is careful about money. Shares sum to the parent exactly, the
 * fee is charged once and divided by largest remainder, the parent is closed
 * the moment it splits so one dinner cannot be paid twice. All of that is
 * right.
 *
 * Then it called `notify()` and stopped.
 *
 * Checked against the live database on 19 Sep 2026:
 *
 *   live push tokens                   0
 *   members with an email          1 / 156   (0 verified)
 *   members with a phone          49 / 156   (11 verified)
 *
 * So a split told nobody. Worse, a share minted for a friend who is not on
 * NUM carries no `member_id` at all, so it did not even get the notification
 * row — the code existed in the database and there was no path by which any
 * human could learn of it. Four friends at a table, four correct bills, four
 * people looking at one phone.
 *
 * ── THE FLOOR IS A LINK, AND THE FLOOR IS NEVER ABSENT ───────────────────
 *
 * Every other channel here can be unconfigured, uncredentialed, opted out of
 * or simply missing, and on this date most of them are. So delivery does not
 * begin with a channel, it begins with a URL that works in any browser, and
 * that URL is returned whether or not a single message leaves the building.
 * The person who split the bill is standing next to everyone they split it
 * with; AirDrop, WhatsApp and reading four characters aloud are all delivery
 * mechanisms and NUM does not need to own any of them.
 *
 * Everything after the link is an improvement on handing over a phone.
 *
 * ── THE LADDER, IN THE ORDER IT ACTUALLY WORKS ───────────────────────────
 *
 *   link   always. Costs nothing, needs nothing, cannot fail.
 *   app    a notification row for any member_id. notify() writes it even
 *          with no device on file, so it is waiting when they next open NUM.
 *   sms    proven: 30 delivered, most recent 18 Sep 2026. The nine 30034s in
 *          num_sms_delivery are all from before the Messaging Service fix on
 *          25 Aug. This is the best rail NUM has for reaching a person who is
 *          not holding the app.
 *   email  one address on file across the whole member base. Real, and today
 *          it reaches one person.
 *
 * Push is deliberately not a rung of its own: notify() already fans out to
 * web and APNs, and when tokens exist the `app` rung starts carrying them
 * without a line changing here.
 *
 * ── TEXTING SOMEBODY ELSE'S FRIEND ───────────────────────────────────────
 *
 * The rules are friendtext.mjs's, for the same reason they were written
 * there: a verified human asks, NUM says whose share it is and who asked,
 * STOP is honoured before anything else, and one share produces one text
 * forever. A bill share is the INVITE case rather than the update case — the
 * single message a person receives because a friend at their own table typed
 * their number — so it takes `optedOut` and not `reachable`, which demands
 * prior consent on file that a guest at dinner has had no chance to give.
 *
 * What it does NOT do is spend the invite budget. Eating together twice in a
 * month is not spam and a cap built for cold invites would refuse the second
 * dinner.
 *
 * ── AND NOTHING HERE MAY SAY "DELIVERED" ─────────────────────────────────
 *
 * Twilio answers 201 when it queues. Resend answers 200 when it accepts. The
 * receipt comes later or never. This file reports `queued`, records every
 * attempt in `num_bill_reach` including the ones that never ran, and leaves
 * the word delivered to num_sms_delivery, which is fed by a carrier.
 */
import { sendText } from './friendtext.mjs';
import { optedOut, validPhone } from './optout.mjs';
import { send as sendMail, AUDIENCE, senderFor, MAIL_KIND } from './mailer.mjs';
import { notify } from './push.mjs';
import { track } from './paytrack.mjs';

export const CHANNEL = Object.freeze({
  LINK: 'link',
  APP: 'app',
  SMS: 'sms',
  EMAIL: 'email',
});

/**
 * One text per share, ever, and a ceiling per number that a group of friends
 * who eat together will not hit. Five in thirty days is roughly a weekly
 * dinner; the invite cap of three is built for strangers and does not apply.
 */
export const REACH_LIMITS = Object.freeze({
  perRecipientPer30d: 5,
  noteMax: 120,
});

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_bill_reach (
  id         TEXT PRIMARY KEY,
  token      TEXT NOT NULL,                 -- the share's own bill code
  parent     TEXT,                          -- the bill it is a share of
  channel    TEXT NOT NULL,                 -- link | app | sms | email
  member_id  TEXT,
  address    TEXT,                          -- phone or email, as sent to
  ok         INTEGER NOT NULL,
  detail     TEXT,                          -- provider id, or why not
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_bill_reach_token ON num_bill_reach(token, channel)',
  'CREATE INDEX IF NOT EXISTS idx_bill_reach_addr ON num_bill_reach(address, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_bill_reach_parent ON num_bill_reach(parent, created_at)',
];
const ready = new WeakSet();

/** Created on first use, like friendtext's own table one file over. */
export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.prepare(SCHEMA).run();
  for (const sql of INDEXES) await env.DB.prepare(sql).run().catch(() => {});
  ready.add(env.DB);
}

const uid = () => 'br_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);

/**
 * The URL on the share. `SITE` is set on num-growth and not on num-app, which
 * is where this runs, so the fallback is the live value rather than a guess —
 * the same expression billqr.mjs mints codes with.
 */
export function shareLink(env, token) {
  return `${env?.SITE || 'https://itsnum.com'}/p/${String(token || '').toUpperCase()}`;
}

/**
 * A number or address, shown back to the splitter without giving it away.
 *
 * The last four digits, not "country code plus the last two". friendtext.mjs
 * masks with `^(\+\d{1,3})\d+(\d{2})$` and the `{1,3}` is greedy, so
 * +14155550777 comes back as "+141…77" — three digits that are not the
 * country code, because the length of a country code is not derivable from
 * the digits without a table. Last four is the convention a person already
 * reads on a bank statement, it distinguishes one friend from another, and it
 * claims nothing the string cannot support.
 */
export function maskContact(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.includes('@')) {
    const [user, host] = s.split('@');
    return `${user.slice(0, 2)}…@${host}`;
  }
  const digits = s.replace(/\D/g, '');
  return digits.length > 4 ? `…${digits.slice(-4)}` : '…';
}

/**
 * Where this person can be reached, and by what.
 *
 * A caller may pass a phone or an email directly — the friend whose number
 * was typed at the table — or only a `member_id`, in which case the member's
 * own row is read. What the caller passed wins: a member who gives a
 * different number for tonight means that number, not the one on file.
 */
export async function destinationsFor(env, person = {}) {
  const memberId = clip(person.member_id ?? person.memberId, 40);
  let phone = clip(person.phone, 20);
  let email = clip(person.email, 160)?.toLowerCase() ?? null;
  let name = clip(person.name, 60);

  if (memberId && env?.DB && (!phone || !email || !name)) {
    const row = await env.DB.prepare(
      'SELECT name, phone, phone_verified, email FROM num_members WHERE id = ?1',
    ).bind(memberId).first().catch(() => null);
    if (row) {
      name = name ?? clip(row.name, 60);
      phone = phone ?? clip(row.phone, 20);
      email = email ?? (clip(row.email, 160)?.toLowerCase() ?? null);
    }
  }
  return {
    memberId,
    name,
    phone: validPhone(phone) ? phone : null,
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null,
  };
}

/**
 * May NUM send this text on the splitter's behalf, right now?
 *
 * Returns a reason rather than a boolean because the reason is the message
 * the app shows: "send it from your phone" is a working outcome, and a guest
 * who is told nothing assumes the share vanished.
 */
export async function mayText(env, { to, from, shareToken }) {
  if (!env?.TWILIO_SID || !env?.TWILIO_TOKEN) return { ok: false, why: 'texting is not switched on' };
  if (!validPhone(to)) return { ok: false, why: 'that is not a number NUM can text' };
  if (!from?.phone_verified) return { ok: false, why: 'verify your own number first — NUM has to be able to say who asked' };
  if (await optedOut(env, to)) return { ok: false, why: 'they asked not to be texted — send it from your phone instead' };

  await ensure(env);
  // One text per share, forever. A second tap of Send is a second tap, not a
  // second dinner.
  const already = await env.DB.prepare(
    "SELECT detail FROM num_bill_reach WHERE token = ?1 AND channel = 'sms' AND ok = 1 LIMIT 1",
  ).bind(String(shareToken).toUpperCase()).first().catch(() => null);
  if (already) return { ok: false, why: 'already sent', already: true };

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM num_bill_reach
      WHERE channel = 'sms' AND ok = 1 AND address = ?1 AND created_at > datetime('now','-30 days')`,
  ).bind(to).first().catch(() => ({ n: 0 }));
  if ((recent?.n ?? 0) >= REACH_LIMITS.perRecipientPer30d) {
    return { ok: false, why: 'they have had a few of these this month — send this one from your phone' };
  }
  return { ok: true };
}

async function record(env, { token, parent, channel, memberId, address, ok, detail }) {
  await ensure(env);
  try {
    await env.DB.prepare(
      `INSERT INTO num_bill_reach (id, token, parent, channel, member_id, address, ok, detail)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    ).bind(
      uid(), String(token).toUpperCase(), parent ? String(parent).toUpperCase() : null,
      channel, memberId ?? null, address ?? null, ok ? 1 : 0, clip(detail, 300),
    ).run();
  } catch (e) {
    // Same rule as logMailAttempt: a failure to write the record must never
    // turn a sent message into a failed split.
    console.error('[billreach] record failed', String(e?.message ?? e).slice(0, 200));
  }
}

/**
 * The message. One shape, three renderings, so the three cannot drift apart
 * and say different amounts — which is the failure that matters here, since
 * the amount is the thing the person is being asked to pay.
 */
export function shareMessage({ venue, amount, currency, fromName, link, note }) {
  const who = fromName ? `${fromName}` : 'A friend';
  const money = `${currency || ''} ${amount}`.trim();
  const where = venue ? ` at ${venue}` : '';
  return {
    subject: `Your share of the bill${where} — ${money}`,
    line: `${who} split the bill${where}. Your share is ${money}.`,
    sms: [
      `${who} split the bill${where}. Your share is ${money}.`,
      note ? `“${clip(note, REACH_LIMITS.noteMax)}”` : null,
      link,
      'Sent by NUM. Reply STOP to opt out.',
    ].filter(Boolean).join('\n'),
    text: [
      `${who} split the bill${where}.`,
      '',
      `  Your share   ${money}`,
      venue ? `  Venue        ${venue}` : null,
      note ? `  Note         ${clip(note, REACH_LIMITS.noteMax)}` : null,
      '',
      'Pay it here:',
      link,
      '',
      'You pay the venue directly. NUM never holds the money, and this link is',
      'for your share only — nobody else at the table can be charged on it.',
      '',
      'NUM · 5arz Inc.',
    ].filter(Boolean).join('\n'),
  };
}

/**
 * Hand one share to one person.
 *
 * `share`  { token, amount, currency, member_id, name, phone, email }
 * `parent` { token, venue, currency }
 * `from`   the splitter: { id, name, phone_verified }
 *
 * Always resolves. Never throws, never rejects, and always returns a link —
 * a channel that fails is a channel, not an outcome.
 */
export async function deliverShare(env, { share, parent = {}, from = {}, fetchImpl, note = null } = {}) {
  const token = String(share?.token || '').toUpperCase();
  if (!env?.DB || !token) return { ok: false, token, link: null, attempts: [], reached: [] };

  const link = shareLink(env, token);
  const to = await destinationsFor(env, share);
  const msg = shareMessage({
    venue: parent.venue ?? null,
    amount: share.amount,
    currency: share.currency ?? parent.currency ?? '',
    fromName: from.name ?? null,
    link,
    note,
  });

  const attempts = [];
  const push = (channel, ok, detail, address = null) => {
    attempts.push({ channel, ok, detail, address: address ? maskContact(address) : null });
    return record(env, { token, parent: parent.token ?? null, channel, memberId: to.memberId, address, ok, detail });
  };

  // 1. The link. Recorded as an attempt because it IS the delivery when
  //    nothing else fires, and a split whose only record is three failures
  //    reads as broken when it worked.
  await push(CHANNEL.LINK, true, link);

  // 2. The app. notify() writes the row whether or not a device exists, so
  //    this is worth doing on a member even with zero tokens on file.
  if (to.memberId) {
    const n = await notify(env, {
      memberId: to.memberId,
      kind: 'bill',
      title: parent.venue || 'Your share',
      body: msg.line,
      url: `/pay/${token}`,
      tag: `bill:${token}`,
    }).catch((e) => ({ error: String(e?.message ?? e) }));
    await push(
      CHANNEL.APP,
      !n?.error,
      n?.error ? n.error : `queued${n?.reached ? `, ${n.reached} device(s) woken` : ', no device on file — it waits in the app'}`,
    );
  }

  // 3. The text.
  if (to.phone) {
    const may = await mayText(env, { to: to.phone, from, shareToken: token });
    if (!may.ok) {
      // `already` is not a failure and must not be recorded as one, or a retry
      // makes the log look like a rail that keeps breaking.
      if (!may.already) await push(CHANNEL.SMS, false, may.why, to.phone);
    } else {
      const out = await sendText(env, { to: to.phone, body: msg.sms, fetchImpl });
      await push(CHANNEL.SMS, !!out.ok, out.ok ? `queued ${out.sid ?? ''}`.trim() : out.error, to.phone);
    }
  }

  // 4. The email. Transactional: somebody is waiting on it to pay for dinner.
  if (to.email) {
    const dupe = await env.DB.prepare(
      "SELECT 1 AS x FROM num_bill_reach WHERE token = ?1 AND channel = 'email' AND ok = 1 LIMIT 1",
    ).bind(token).first().catch(() => null);
    if (!dupe) {
      const out = await sendMail(env, {
        to: to.email,
        from: senderFor(env, MAIL_KIND.TRANSACTIONAL),
        subject: msg.subject,
        text: msg.text,
      }, { audience: AUDIENCE.EXTERNAL });
      await push(CHANNEL.EMAIL, !!out.ok, out.ok ? `accepted via ${out.via}${out.id ? ` (${out.id})` : ''}` : out.error, to.email);
    }
  }

  const reached = attempts.filter((a) => a.ok && a.channel !== CHANNEL.LINK).map((a) => a.channel);
  await track(env, {
    token, businessId: parent.business_id ?? null, kind: 'share_sent',
    memberId: to.memberId, amountMinor: share.amount_minor ?? null,
    detail: reached.length ? reached.join('+') : 'link only — hand it over',
  });

  return {
    ok: true,
    token,
    link,
    name: to.name,
    to: { phone: maskContact(to.phone), email: maskContact(to.email), member: !!to.memberId },
    attempts,
    reached,
    // The sentence the app shows under the person's name. Said plainly,
    // because "sent" over a rail that reached nobody is the lie this whole
    // file is built to stop telling.
    say: reached.length
      ? `Sent — ${reached.join(' and ')}`
      : 'Not sent from NUM — pass on the link',
  };
}

/**
 * Hand out every share of a split.
 *
 * Sequential rather than parallel, deliberately: the per-share and
 * per-recipient checks in `mayText` read rows this same loop writes, and four
 * simultaneous sends to one number would each see zero prior texts and all
 * four would go.
 */
export async function deliverShares(env, { shares = [], parent = {}, from = {}, fetchImpl, note = null } = {}) {
  const out = [];
  for (const share of shares) {
    out.push(await deliverShare(env, { share, parent, from, fetchImpl, note }));
  }
  return {
    ok: true,
    shares: out,
    // How many shares NUM itself got to a person. The rest are real bills that
    // somebody has to hand over, which is a task for a human, not a failure.
    reached: out.filter((s) => s.reached.length).length,
    handover: out.filter((s) => !s.reached.length).length,
  };
}

/** Everything that has been tried for one share, newest first — for support. */
export async function reachTrail(env, token) {
  if (!env?.DB || !token) return [];
  await ensure(env);
  const out = await env.DB.prepare(
    `SELECT channel, address, ok, detail, created_at FROM num_bill_reach
      WHERE token = ?1 ORDER BY created_at DESC, id DESC LIMIT 50`,
  ).bind(String(token).toUpperCase()).all().catch(() => null);
  return (out?.results ?? []).map((r) => ({
    channel: r.channel,
    to: maskContact(r.address),
    ok: !!r.ok,
    detail: r.detail,
    at: r.created_at,
  }));
}
