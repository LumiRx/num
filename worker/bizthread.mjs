/**
 * THE CONVERSATION WITH A BUSINESS — one place, both directions.
 *
 * ── WHAT WAS ACTUALLY HAPPENING ──────────────────────────────────────────
 *
 * NUM sends a business an invitation from `NUM <hello@itsnum.com>` with
 * `Reply-To: info@thatislumi.com`. So a restaurant that replies is writing to
 * a different company's domain, into a human's personal mailbox, and nothing
 * in this system ever learns that they answered.
 *
 * That is not a theoretical gap. On 18 Sep 2026 Hugo's Restaurant replied with
 * four sites, a reservation system and two precise questions. It reached NUM
 * as a screenshot pasted into a chat window, because there was nowhere else
 * for it to go. Everything the company knows about its warmest inbound lead
 * exists because a person happened to read their own email that day.
 *
 * Meanwhile the funnel says: 3,538 invitations, 668 opens, 77 clicks, 9 forms,
 * 4 verification attempts, 2 verified businesses. Two. The scarce thing here
 * is not addresses to mail, it is businesses who answered — and we were
 * dropping those on the floor.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────
 *
 * A thread per business contact, carrying every message in both directions,
 * with the onboarding state attached. An inbound reply lands in the same
 * object as the invitation that provoked it, next to what we know about how
 * far that business got. It is a record, not an inbox: the point is that the
 * next person — or the next agent — can see the whole conversation and where
 * it stands without asking anybody what happened.
 *
 * ── HOW A REPLY FINDS ITS THREAD, IN DESCENDING ORDER OF CERTAINTY ───────
 *
 * Every outbound message goes out with `Reply-To: reply+<key>@itsnum.com`,
 * where the key names the thread. Three ways to match, tried in order, and the
 * message RECORDS WHICH ONE WAS USED, because they are not equally good:
 *
 *   key       The address we asked them to reply to carried the thread id.
 *             Certain. Survives forwarding, survives a changed subject line.
 *   headers   In-Reply-To / References name a Message-ID we sent. Near
 *             certain, but lost whenever somebody composes a fresh mail
 *             rather than hitting reply.
 *   address   The From address matches a thread's contact. A guess, and a
 *             defensible one — but two people at one restaurant, or one
 *             person at two restaurants, will both land wrong sometimes, so
 *             `matched_by = 'address'` is stored and shown rather than hidden.
 *
 * Nothing is dropped when all three fail. An unmatched reply becomes a thread
 * of its own with no business attached, which is a person writing to us and
 * is worth strictly more than a silent discard.
 *
 * ── AND WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 * It never sends anything by itself. Recording a message and transmitting one
 * are separate calls, and the draft/approve path (bizreply.mjs) sits between
 * them. A system that can both compose and send on its own behalf, to a
 * business, about commercial terms, is one bad generation away from a promise
 * nobody at NUM made.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_biz_threads (
  id            TEXT PRIMARY KEY,
  reply_key     TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  contact_name  TEXT,
  business_name TEXT,
  lead_id       TEXT,
  place_id      TEXT,
  business_id   TEXT,
  invite_token  TEXT,
  dest          TEXT,
  country       TEXT,
  state         TEXT NOT NULL DEFAULT 'invited',
  owner         TEXT,
  needs_reply   INTEGER NOT NULL DEFAULT 0,
  closed_at     TEXT,
  last_in_at    TEXT,
  last_out_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bizthread_email ON num_biz_threads(email);
CREATE INDEX IF NOT EXISTS idx_bizthread_open  ON num_biz_threads(needs_reply, last_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_bizthread_biz   ON num_biz_threads(business_id);
CREATE INDEX IF NOT EXISTS idx_bizthread_place ON num_biz_threads(place_id);

CREATE TABLE IF NOT EXISTS num_biz_messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  channel      TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms','note')),
  from_addr    TEXT,
  to_addr      TEXT,
  subject      TEXT,
  body         TEXT,
  message_id   TEXT,
  in_reply_to  TEXT,
  provider_id  TEXT,
  matched_by   TEXT,
  state        TEXT NOT NULL DEFAULT 'received'
               CHECK (state IN ('received','draft','approved','sent','failed','declined')),
  drafted_by   TEXT,
  approved_by  TEXT,
  approved_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bizmsg_thread ON num_biz_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bizmsg_state  ON num_biz_messages(state, created_at);
-- Mail is delivered at least once. A provider that retries a webhook, or a
-- mail server that delivers a message twice, must not produce two rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bizmsg_msgid
  ON num_biz_messages(message_id) WHERE message_id IS NOT NULL;
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}
export function __resetReady() { ready = false; }

const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const lc = (v) => (v ? String(v).trim().toLowerCase().slice(0, 160) : null);
const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

/**
 * The key that goes in the reply address.
 *
 * Base36 of 12 random bytes: short enough to survive a mail client that wraps
 * a header, long enough that guessing one is not a way to read somebody
 * else's conversation. It is an identifier and NOT a credential — landing a
 * message in a thread is all it can do, and the inbound path treats everything
 * that arrives as untrusted regardless.
 */
export function newReplyKey() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 18);
}

/** `reply+<key>@itsnum.com`, or whatever REPLY_DOMAIN says. */
export function replyAddress(env, key) {
  const base = env?.MAIL_REPLY_BASE || 'reply@itsnum.com';
  const [local, domain] = String(base).split('@');
  return `${local}+${key}@${domain}`;
}

/** The key back out of an address we were sent to. Null when there isn't one. */
export function keyFromAddress(addr) {
  const m = String(addr ?? '').toLowerCase().match(/(?:^|[<\s,;])([^<>\s,;@]+)\+([a-z0-9]{6,32})@/);
  return m ? m[2] : null;
}

/** The bare address out of `Name <a@b.com>`, or out of a bare address. */
export function bareAddress(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/<([^>]+)>/);
  return lc(m ? m[1] : s.split(/[\s,;]+/)[0]);
}

/**
 * Find the thread for this business contact, or open one.
 *
 * Keyed on the ADDRESS, not the business: the address is what a mail server
 * gives us and the only thing guaranteed present on both sides of the
 * conversation. Identifiers we happen to learn later — a lead, a place, a
 * business — are attached as they arrive and never overwritten with null,
 * because a later message knowing less must not erase what an earlier one
 * established.
 */
export async function openThread(env, {
  email, contactName = null, businessName = null,
  leadId = null, placeId = null, businessId = null, inviteToken = null,
  dest = null, country = null, state = null, owner = null,
} = {}) {
  const addr = lc(email);
  if (!env?.DB || !addr) return null;
  await ensure(env);

  const found = await env.DB.prepare(
    'SELECT * FROM num_biz_threads WHERE email = ?1 AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1',
  ).bind(addr).first().catch(() => null);

  if (found) {
    await env.DB.prepare(
      `UPDATE num_biz_threads SET
         contact_name  = COALESCE(?2, contact_name),
         business_name = COALESCE(?3, business_name),
         lead_id       = COALESCE(?4, lead_id),
         place_id      = COALESCE(?5, place_id),
         business_id   = COALESCE(?6, business_id),
         invite_token  = COALESCE(?7, invite_token),
         dest          = COALESCE(?8, dest),
         country       = COALESCE(?9, country),
         state         = COALESCE(?10, state),
         owner         = COALESCE(?11, owner),
         updated_at    = datetime('now')
       WHERE id = ?1`,
    ).bind(
      found.id, clip(contactName, 120), clip(businessName, 160), clip(leadId, 64),
      clip(placeId, 120), clip(businessId, 64), clip(inviteToken, 64),
      clip(dest, 40), clip(country, 2), clip(state, 40), clip(owner, 80),
    ).run().catch(() => {});
    return env.DB.prepare('SELECT * FROM num_biz_threads WHERE id = ?1').bind(found.id).first();
  }

  const id = uid('thr');
  await env.DB.prepare(
    `INSERT INTO num_biz_threads
       (id, reply_key, email, contact_name, business_name, lead_id, place_id,
        business_id, invite_token, dest, country, state, owner)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
  ).bind(
    id, newReplyKey(), addr, clip(contactName, 120), clip(businessName, 160),
    clip(leadId, 64), clip(placeId, 120), clip(businessId, 64), clip(inviteToken, 64),
    clip(dest, 40), clip(country, 2), clip(state, 40) ?? 'invited', clip(owner, 80),
  ).run();
  return env.DB.prepare('SELECT * FROM num_biz_threads WHERE id = ?1').bind(id).first();
}

export async function threadByKey(env, key) {
  if (!env?.DB || !key) return null;
  await ensure(env);
  return env.DB.prepare('SELECT * FROM num_biz_threads WHERE reply_key = ?1').bind(String(key)).first().catch(() => null);
}

export async function threadById(env, id) {
  if (!env?.DB || !id) return null;
  await ensure(env);
  return env.DB.prepare('SELECT * FROM num_biz_threads WHERE id = ?1').bind(String(id)).first().catch(() => null);
}

/**
 * Match an incoming message to a thread, and say how.
 *
 * The `how` is returned rather than swallowed because the three methods are
 * not equally trustworthy, and a human reading the thread later is entitled to
 * know whether this message was addressed to it or merely looked like it
 * belonged. See the note at the top of the file.
 */
export async function matchThread(env, { to = [], inReplyTo = null, references = null, from = null } = {}) {
  await ensure(env);

  for (const addr of [].concat(to)) {
    const key = keyFromAddress(addr);
    if (!key) continue;
    const t = await threadByKey(env, key);
    if (t) return { thread: t, how: 'key' };
  }

  const ids = [inReplyTo, ...String(references ?? '').split(/\s+/)].filter(Boolean).slice(0, 12);
  for (const mid of ids) {
    const row = await env.DB.prepare(
      "SELECT thread_id FROM num_biz_messages WHERE message_id = ?1 AND direction = 'out' LIMIT 1",
    ).bind(String(mid).replace(/[<>]/g, '')).first().catch(() => null);
    if (row?.thread_id) {
      const t = await threadById(env, row.thread_id);
      if (t) return { thread: t, how: 'headers' };
    }
  }

  const addr = bareAddress(from);
  if (addr) {
    const t = await env.DB.prepare(
      'SELECT * FROM num_biz_threads WHERE email = ?1 AND closed_at IS NULL ORDER BY updated_at DESC LIMIT 1',
    ).bind(addr).first().catch(() => null);
    if (t) return { thread: t, how: 'address' };
  }

  return { thread: null, how: null };
}

/**
 * Record a message. Recording is not sending — see the file note.
 *
 * Returns `{ ok, id, duplicate }`. A duplicate is a success: mail arrives at
 * least once and a retried webhook must be a no-op, not an error the caller
 * has to decide what to do about.
 */
export async function record(env, threadId, {
  direction, channel = 'email', from = null, to = null, subject = null, body = null,
  messageId = null, inReplyTo = null, providerId = null, matchedBy = null,
  state = null, draftedBy = null,
} = {}) {
  if (!env?.DB || !threadId || !['in', 'out'].includes(direction)) return { ok: false };
  await ensure(env);

  const id = uid('msg');
  const mid = messageId ? String(messageId).replace(/[<>]/g, '').slice(0, 250) : null;
  if (mid) {
    const seen = await env.DB.prepare('SELECT id FROM num_biz_messages WHERE message_id = ?1')
      .bind(mid).first().catch(() => null);
    if (seen) return { ok: true, id: seen.id, duplicate: true };
  }

  await env.DB.prepare(
    `INSERT INTO num_biz_messages
       (id, thread_id, direction, channel, from_addr, to_addr, subject, body,
        message_id, in_reply_to, provider_id, matched_by, state, drafted_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
  ).bind(
    id, String(threadId), direction, channel,
    clip(from, 200), clip(to, 200), clip(subject, 300),
    // Long enough for a real email, capped so a mail bomb cannot fill the
    // database. What is cut is said so in the body rather than silently lost.
    body == null ? null : String(body).slice(0, 20000)
      + (String(body).length > 20000 ? '\n\n[…truncated by NUM at 20,000 characters]' : ''),
    mid, clip(inReplyTo, 250), clip(providerId, 120), clip(matchedBy, 20),
    state ?? (direction === 'in' ? 'received' : 'draft'), clip(draftedBy, 60),
  ).run();

  if (direction === 'in') {
    // An inbound message always raises the flag. Nothing here decides that a
    // reply does not need answering — that judgement belongs to a person, and
    // a system that quietly closed threads would lose exactly the ones it
    // misjudged.
    await env.DB.prepare(
      "UPDATE num_biz_threads SET needs_reply = 1, last_in_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1",
    ).bind(String(threadId)).run().catch(() => {});
  }
  return { ok: true, id, duplicate: false };
}

export async function markSent(env, messageId, providerId) {
  if (!env?.DB || !messageId) return;
  await ensure(env);
  const row = await env.DB.prepare('SELECT thread_id FROM num_biz_messages WHERE id = ?1')
    .bind(String(messageId)).first().catch(() => null);
  await env.DB.prepare("UPDATE num_biz_messages SET state='sent', provider_id=?2 WHERE id=?1")
    .bind(String(messageId), clip(providerId, 120)).run().catch(() => {});
  if (row?.thread_id) {
    // Answering clears the flag. Only a send does — approving a draft that
    // then fails to leave must leave the thread looking unanswered, because
    // it is.
    await env.DB.prepare(
      "UPDATE num_biz_threads SET needs_reply = 0, last_out_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1",
    ).bind(row.thread_id).run().catch(() => {});
  }
}

/** Every message on a thread, oldest first — the conversation as it happened. */
export async function conversation(env, threadId, { limit = 100 } = {}) {
  if (!env?.DB || !threadId) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT id, direction, channel, from_addr, to_addr, subject, body, state,
            matched_by, drafted_by, approved_by, created_at
       FROM num_biz_messages WHERE thread_id = ?1 ORDER BY created_at ASC LIMIT ?2`,
  ).bind(String(threadId), limit).all();
  return results ?? [];
}

/**
 * Threads waiting on us, oldest first.
 *
 * Oldest first and not newest: a business that wrote four days ago and has
 * heard nothing is the one being let down, and a stack would bury them under
 * this morning's arrivals for ever.
 */
export async function waiting(env, { limit = 50 } = {}) {
  if (!env?.DB) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT t.*, (SELECT body FROM num_biz_messages m
                   WHERE m.thread_id = t.id AND m.direction = 'in'
                   ORDER BY m.created_at DESC LIMIT 1) AS last_message
       FROM num_biz_threads t
      WHERE t.needs_reply = 1 AND t.closed_at IS NULL
      ORDER BY t.last_in_at ASC LIMIT ?1`,
  ).bind(limit).all();
  return (results ?? []).map((t) => ({
    ...t,
    waiting_hours: t.last_in_at
      ? Math.round((Date.now() - Date.parse(`${t.last_in_at.replace(' ', 'T')}Z`)) / 36e5)
      : null,
  }));
}

export async function setState(env, threadId, state, { owner = null } = {}) {
  if (!env?.DB || !threadId || !state) return { ok: false };
  await ensure(env);
  await env.DB.prepare(
    "UPDATE num_biz_threads SET state=?2, owner=COALESCE(?3, owner), updated_at=datetime('now') WHERE id=?1",
  ).bind(String(threadId), clip(state, 40), clip(owner, 80)).run().catch(() => {});
  return { ok: true };
}
