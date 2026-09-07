/**
 * NUM TEXTS YOUR FRIEND THE PLAN.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * Everything social in NUM assumed the friend is reached from the member's
 * own phone: the invite is minted, and the app hands the member an sms: link,
 * a WhatsApp link, or the share sheet. That is the right default — it lands
 * better and it never texts a stranger who did not agree to hear from us.
 * But it is one more thing to do, on a phone, while organising six people,
 * and the plan itself never reaches anyone who is not on NUM.
 *
 * Dre, 4 Sep 2026: "if they enter in their friend's number into Num we can
 * text their friends the plans."
 *
 * ── THE RULES THAT MAKE THIS LAWFUL AND WELCOME ──────────────────────────
 *
 *   1. A verified human asks. The sender must be phone-verified; NUM says who
 *      asked, by name, in the message. An anonymous device cannot make NUM
 *      text anyone.
 *   2. One invite per plan per number, ever. A second friend inviting the
 *      same person to the same plan does not produce a second text.
 *   3. Caps: a sender may have NUM text 20 people a day; a number may receive
 *      at most 3 invites in 30 days from anyone. Above that the app falls
 *      back to "send it from your phone", which still works.
 *   4. STOP is honoured before anything else (worker/optout.mjs), and every
 *      message carries the way out.
 *   5. Follow-ups — "dinner moved to 8" — go ONLY to numbers that have written
 *      back. The invite is the one message a stranger gets; their reply is
 *      the consent (worker/sms.mjs records it), and even then at most one
 *      update per plan per number every six hours.
 *   6. Delivery is tracked (StatusCallback → num_sms_delivery). "We asked
 *      Twilio" is never reported to the member as "delivered".
 */
import { senderParams } from './twiliosender.mjs';
import { optedOut, validPhone } from './optout.mjs';

const SCHEMA = `CREATE TABLE IF NOT EXISTS num_friend_texts (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                 -- invite | update
  token       TEXT,                          -- num_invite_links.token for an invite
  plan_id     TEXT,
  sender_id   TEXT,
  to_phone    TEXT NOT NULL,
  body        TEXT NOT NULL,
  message_sid TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_friend_texts_phone ON num_friend_texts(to_phone, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_friend_texts_sender ON num_friend_texts(sender_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_friend_texts_plan ON num_friend_texts(plan_id, to_phone, created_at)',
];
const ready = new WeakSet();
export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  await env.DB.prepare(SCHEMA).run();
  for (const sql of INDEXES) await env.DB.prepare(sql).run().catch(() => {});
  ready.add(env.DB);
}

export const LIMITS = Object.freeze({
  senderPerDay: 20,
  recipientInvitesPer30d: 3,
  updateGapHours: 6,
  bodyMax: 480,
});
export const UPDATE_KINDS = new Set(['item_added', 'booked', 'confirmed', 'time_changed', 'date_set', 'cancelled']);

const uid = () => 'ft_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

/** The one send path. Returns { ok, sid } or { ok:false, error }. */
export async function sendText(env, { to, body, fetchImpl = fetch }) {
  const sender = senderParams(env);
  if (!env?.TWILIO_SID || !env?.TWILIO_TOKEN || !sender) return { ok: false, error: 'texting is not switched on' };
  const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      To: to,
      ...sender,
      Body: body,
      // Twilio answers 201 the instant it queues; only the receipt says a
      // carrier took it. Same reasoning as bookdesk and claim/verify.
      StatusCallback: 'https://app.itsnum.com/api/sms/status',
    }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message ?? e), json: async () => ({}) }));
  if (!r?.ok) {
    const detail = await r?.text?.().catch(() => '') ?? '';
    return { ok: false, error: `twilio ${r?.status ?? 0}: ${detail.slice(0, 160)}` };
  }
  const j = await r.json().catch(() => ({}));
  return { ok: true, sid: j?.sid ?? null };
}

/**
 * NUM sends the invite that /api/social/invite minted. `from` is the member
 * asking; `token` is theirs or nothing happens.
 */
export async function textInvite(env, { token, from, fetchImpl } = {}) {
  if (!env?.DB) return { ok: false, status: 503, error: 'no database' };
  token = clip(token, 40); from = clip(from, 40);
  if (!token || !from) return { ok: false, status: 400, error: 'token and from required' };
  await ensure(env);

  const inv = await env.DB.prepare(
    'SELECT token, code, sender_id, sender_name, to_phone, to_name, message, sent_at, channel FROM num_invite_links WHERE token = ?1 AND sender_id = ?2',
  ).bind(token, from).first();
  if (!inv) return { ok: false, status: 404, error: 'no such invite' };
  if (!validPhone(inv.to_phone)) return { ok: false, status: 400, error: 'that invite has no number to text' };

  const sender = await env.DB.prepare('SELECT id, name, phone_verified FROM num_members WHERE id = ?1').bind(from).first();
  if (!sender?.phone_verified) return { ok: false, status: 403, error: 'verify your own number first — an invite has to come from someone' };

  const prior = await env.DB.prepare(
    'SELECT id, message_sid FROM num_friend_texts WHERE kind = ?1 AND token = ?2 LIMIT 1',
  ).bind('invite', token).first();
  if (prior) return { ok: true, status: 200, already: true, sid: prior.message_sid };

  if (await optedOut(env, inv.to_phone)) return { ok: false, status: 403, error: 'they asked not to be texted — send it from your phone instead' };

  const link = await env.DB.prepare('SELECT plan_id FROM num_links WHERE token = ?1').bind(token).first().catch(() => null);
  const planId = link?.plan_id ?? null;
  if (planId) {
    const dup = await env.DB.prepare(
      'SELECT 1 AS x FROM num_friend_texts WHERE kind = ?1 AND plan_id = ?2 AND to_phone = ?3 LIMIT 1',
    ).bind('invite', planId, inv.to_phone).first();
    if (dup) return { ok: false, status: 409, error: 'they have already been texted about this plan' };
  }
  const senderToday = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM num_friend_texts WHERE sender_id = ?1 AND created_at > datetime('now','-1 day')",
  ).bind(from).first();
  if ((senderToday?.n ?? 0) >= LIMITS.senderPerDay) return { ok: false, status: 429, error: `that is ${LIMITS.senderPerDay} today — send the rest from your phone` };
  const recipient = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM num_friend_texts WHERE kind = 'invite' AND to_phone = ?1 AND created_at > datetime('now','-30 days')",
  ).bind(inv.to_phone).first();
  if ((recipient?.n ?? 0) >= LIMITS.recipientInvitesPer30d) return { ok: false, status: 429, error: 'they have had a few invites this month — send this one from your phone' };

  const who = sender.name || inv.sender_name || 'a friend';
  const body = clip(inv.message, 300) + `\n\nSent by NUM for ${who}. Reply STOP to opt out.`;
  const out = await sendText(env, { to: inv.to_phone, body, fetchImpl });
  if (!out.ok) return { ok: false, status: 503, error: out.error };

  await env.DB.prepare(
    'INSERT INTO num_friend_texts (id, kind, token, plan_id, sender_id, to_phone, body, message_sid) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
  ).bind(uid(), 'invite', token, planId, from, inv.to_phone, body, out.sid).run();
  await env.DB.prepare("UPDATE num_invite_links SET sent_at = datetime('now'), channel = 'num_sms' WHERE token = ?1").bind(token).run().catch(() => {});
  return { ok: true, status: 200, sid: out.sid, to: inv.to_phone.replace(/^(\+\d{1,3})\d+(\d{2})$/, '$1…$2') };
}

/**
 * A plan changed. Tell the friends who are not on NUM yet — but only the
 * ones who wrote back (consent), never more than once per six hours per
 * plan, and only for changes worth a text.
 */
export async function textPlanUpdate(env, { planId, kind, summary, byName, fetchImpl, consentCheck } = {}) {
  if (!env?.DB || !planId || !UPDATE_KINDS.has(kind)) return { sent: 0, skipped: 0 };
  await ensure(env);
  const plan = await env.DB.prepare('SELECT id, title FROM num_plans WHERE id = ?1').bind(planId).first().catch(() => null);
  if (!plan) return { sent: 0, skipped: 0 };
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT b_phone AS phone, token FROM num_links WHERE plan_id = ?1 AND b_id IS NULL AND b_phone IS NOT NULL AND state <> 'blocked'",
  ).bind(planId).all().catch(() => ({ results: [] }));
  const reachable = consentCheck ?? (async (phone) => {
    const { reachable: r } = await import('./smsconsent.mjs');
    return (await r(env, phone)).ok;
  });
  let sent = 0, skipped = 0;
  for (const row of results ?? []) {
    if (!validPhone(row.phone)) { skipped++; continue; }
    if (await optedOut(env, row.phone)) { skipped++; continue; }
    if (!(await reachable(row.phone))) { skipped++; continue; }
    const recent = await env.DB.prepare(
      `SELECT 1 AS x FROM num_friend_texts WHERE kind = 'update' AND plan_id = ?1 AND to_phone = ?2
        AND created_at > datetime('now', ?3) LIMIT 1`,
    ).bind(planId, row.phone, `-${LIMITS.updateGapHours} hours`).first();
    if (recent) { skipped++; continue; }
    const link = row.token ? `https://app.itsnum.com/i/${row.token}` : 'https://app.itsnum.com';
    const body = clip(`${byName || 'The group'} updated “${plan.title}”: ${clip(summary, 200)}\nSee the plan: ${link}`, LIMITS.bodyMax - 40)
      + '\nReply STOP to opt out.';
    const out = await sendText(env, { to: row.phone, body, fetchImpl });
    if (!out.ok) { skipped++; continue; }
    await env.DB.prepare(
      'INSERT INTO num_friend_texts (id, kind, token, plan_id, sender_id, to_phone, body, message_sid) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
    ).bind(uid(), 'update', row.token ?? null, planId, null, row.phone, body, out.sid).run();
    sent++;
  }
  return { sent, skipped };
}

/** For the app: can NUM text on this member's behalf right now? */
export function textingAvailable(env, member) {
  return !!(env?.TWILIO_SID && env?.TWILIO_TOKEN && senderParams(env) && member?.phone_verified);
}

/** HTTP: POST /api/social/invite/text {token, from} */
export async function handleTextInvite(env, request) {
  let b = {};
  try { b = await request.json(); } catch { /* empty */ }
  const out = await textInvite(env, { token: b.token, from: b.from });
  const { status, ...rest } = out;
  return new Response(JSON.stringify(rest), {
    status: status ?? (out.ok ? 200 : 400),
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
