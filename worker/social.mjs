// NUM social layer — identity, invites, friend links and shared plans.
//
// Mounted at /api/social/* on the app Worker (same origin as the SPA, so no
// CORS and the service worker sees ordinary same-site requests). It writes the
// same num-db that num-claim's referral ledger reads, so an invite sent from
// the app shows up in the referral dashboard with no extra plumbing.
//
// Two invariants worth stating out loud, because the whole feature rests on
// them:
//
//   1. Nothing crosses between two people until BOTH have acted — the sender
//      by minting the invite, the receiver by opening it on their own device.
//      A pending link shares nothing. That is what makes "the AIs talk to each
//      other" safe: neither Num can push anything at a stranger.
//   2. A plan is real before a reservation is. Items start as ideas, and the
//      same row becomes the booking when it firms up, so nobody has to wait
//      for a confirmation to start planning together.
import { generateCode, hashCode, safeEqual, normalisePhone, uid, sendCode } from '../claim/verify.mjs';

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 — codes get read aloud
const CLAIM_ORIGIN = 'https://num-claim.thatislumi.workers.dev';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};

function friendly(n = 6) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/** Schema is created lazily so a fresh D1 needs no migration step to work. */
let ensured = false;
async function ensure(env) {
  if (ensured) return;
  const stmts = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
  ensured = true;
}

// Inlined rather than fetched: a Worker has no filesystem. Kept identical to
// worker/social.sql, which is the readable copy and the one to edit first.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT UNIQUE, phone_verified INTEGER NOT NULL DEFAULT 0, code_hash TEXT, code_salt TEXT, code_expires TEXT, attempts INTEGER NOT NULL DEFAULT 0, ref_code TEXT, dest TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), seen_at TEXT);
CREATE INDEX IF NOT EXISTS idx_num_members_phone ON num_members(phone);
CREATE TABLE IF NOT EXISTS num_links (id TEXT PRIMARY KEY, a_id TEXT NOT NULL, b_id TEXT, b_phone TEXT, b_name TEXT, state TEXT NOT NULL DEFAULT 'pending', token TEXT, plan_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), accepted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_num_links_a ON num_links(a_id, state);
CREATE INDEX IF NOT EXISTS idx_num_links_b ON num_links(b_id, state);
CREATE INDEX IF NOT EXISTS idx_num_links_token ON num_links(token);
CREATE TABLE IF NOT EXISTS num_plans (id TEXT PRIMARY KEY, title TEXT NOT NULL, dest TEXT, owner_id TEXT NOT NULL, starts_on TEXT, state TEXT NOT NULL DEFAULT 'planning', join_code TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS num_plan_members (plan_id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'member', joined_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (plan_id, member_id));
CREATE TABLE IF NOT EXISTS num_plan_items (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'idea', title TEXT NOT NULL, place TEXT, address TEXT, day TEXT, time TEXT, status TEXT NOT NULL DEFAULT 'idea', cost TEXT, note TEXT, photo TEXT, by_id TEXT, by_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_num_plan_items_plan ON num_plan_items(plan_id);
CREATE TABLE IF NOT EXISTS num_plan_events (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, ts TEXT NOT NULL DEFAULT (datetime('now')), by_id TEXT, by_name TEXT, kind TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT);
CREATE INDEX IF NOT EXISTS idx_num_plan_events_plan ON num_plan_events(plan_id, id);
`;

async function event(env, planId, by, kind, summary, payload) {
  await env.DB.prepare(
    'INSERT INTO num_plan_events (plan_id, by_id, by_name, kind, summary, payload) VALUES (?1,?2,?3,?4,?5,?6)',
  ).bind(planId, by?.id ?? null, by?.name ?? null, kind, summary.slice(0, 300), payload ? JSON.stringify(payload) : null).run();
  await env.DB.prepare("UPDATE num_plans SET updated_at=datetime('now') WHERE id=?1").bind(planId).run();
}

/** Every plan endpoint runs through this — membership is the authorisation. */
async function memberOf(env, planId, memberId) {
  if (!planId || !memberId) return null;
  return await env.DB.prepare('SELECT * FROM num_plan_members WHERE plan_id=?1 AND member_id=?2')
    .bind(planId, memberId).first();
}

// ── identity ──────────────────────────────────────────────────────────────

/**
 * Upsert the member and mint their referral code. A phone number starts an
 * OTP when a provider is configured; when none is, we say so plainly and keep
 * the number unverified rather than pretending it was checked.
 */
async function me(env, req) {
  const b = await readBody(req);
  const id = clip(b.id, 40) || uid('mem');
  const name = clip(b.name, 60);
  const phone = normalisePhone(b.phone);
  const dest = clip(b.dest, 80);

  const existing = await env.DB.prepare('SELECT * FROM num_members WHERE id=?1').bind(id).first();
  if (phone) {
    const holder = await env.DB.prepare('SELECT id, phone_verified FROM num_members WHERE phone=?1').bind(phone).first();
    if (holder && holder.id !== id) {
      // Verified means it is genuinely theirs — nobody else gets to claim it.
      if (holder.phone_verified) return json({ error: 'That number is already on Num. Sign in from the device that has it.' }, 409);
      // Unverified means nothing was ever proved, so it must not squat the
      // number against the real owner. Release it and let this account take it
      // — the phone column is UNIQUE, so this also avoids a constraint blow-up.
      await env.DB.prepare('UPDATE num_members SET phone=NULL WHERE id=?1').bind(holder.id).run();
    }
  }

  if (existing) {
    await env.DB.prepare(
      "UPDATE num_members SET name=COALESCE(?2,name), phone=COALESCE(?3,phone), dest=COALESCE(?4,dest), seen_at=datetime('now') WHERE id=?1",
    ).bind(id, name, phone, dest).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO num_members (id, name, phone, dest, seen_at) VALUES (?1,?2,?3,?4,datetime('now'))",
    ).bind(id, name, phone, dest).run();
  }

  const row = await env.DB.prepare('SELECT * FROM num_members WHERE id=?1').bind(id).first();

  // Referral code: one per member, reused forever, shared with num-claim's ledger.
  let ref = row.ref_code;
  if (!ref) {
    const prior = await env.DB.prepare("SELECT code FROM num_referral_codes WHERE owner_id=?1 AND owner_type='member' AND active=1")
      .bind(id).first();
    ref = prior?.code ?? null;
    if (!ref) {
      ref = friendly();
      for (let i = 0; i < 5; i++) {
        const clash = await env.DB.prepare('SELECT 1 FROM num_referral_codes WHERE code=?1').bind(ref).first();
        if (!clash) break;
        ref = friendly();
      }
      await env.DB.prepare(
        `INSERT INTO num_referral_codes (code, owner_type, owner_id, reward_cs, reward_referee_cs, max_conversions, max_reward_total_cs, active, created_at)
         VALUES (?1,'member',?2,500,500,200,200000,1,unixepoch())`,
      ).bind(ref, id).run();
    }
    await env.DB.prepare('UPDATE num_members SET ref_code=?2 WHERE id=?1').bind(id, ref).run();
  }

  let verification = null;
  if (phone && !row.phone_verified && b.verify !== false) {
    const code = generateCode();
    const salt = crypto.randomUUID();
    const out = await sendCode(env, { channel: 'sms', to: phone, code, businessName: 'NUM' });
    if (out.ok) {
      await env.DB.prepare(
        'UPDATE num_members SET code_hash=?2, code_salt=?3, code_expires=?4, attempts=0 WHERE id=?1',
      ).bind(id, await hashCode(code, salt), salt, new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString()).run();
      verification = { sent: true, channel: 'sms' };
    } else {
      // Honest failure: the number is on file so invites and links work, but we
      // do not claim it was verified. Adding the Twilio secrets turns this on.
      verification = { sent: false, reason: out.error, note: 'Number saved, but not verified — SMS is not switched on yet.' };
    }
  }

  return json({
    me: { id, name: row.name, phone: row.phone, phone_verified: !!row.phone_verified, ref },
    ref,
    link: `${CLAIM_ORIGIN.replace('num-claim', 'num-app')}/?ref=${ref}`,
    verification,
  });
}

async function verifyMe(env, req) {
  const b = await readBody(req);
  const row = await env.DB.prepare('SELECT * FROM num_members WHERE id=?1').bind(clip(b.id, 40) ?? '').first();
  if (!row) return json({ error: 'unknown member' }, 404);
  if (row.phone_verified) return json({ ok: true, already: true });
  if (!row.code_hash) return json({ error: 'no code pending' }, 409);
  if (row.code_expires && new Date(row.code_expires) < new Date()) return json({ error: 'that code expired — ask for a new one' }, 410);
  if (row.attempts >= MAX_ATTEMPTS) return json({ error: 'too many attempts' }, 429);

  const supplied = String(b.code || '').replace(/\D/g, '');
  if (!safeEqual(await hashCode(supplied, row.code_salt), row.code_hash)) {
    await env.DB.prepare('UPDATE num_members SET attempts=attempts+1 WHERE id=?1').bind(row.id).run();
    return json({ error: 'wrong code', attempts_left: MAX_ATTEMPTS - (row.attempts + 1) }, 400);
  }
  await env.DB.prepare('UPDATE num_members SET phone_verified=1, code_hash=NULL, code_salt=NULL, code_expires=NULL WHERE id=?1')
    .bind(row.id).run();
  return json({ ok: true, phone_verified: true });
}

// ── invites ───────────────────────────────────────────────────────────────

const INSTALL_STEPS = {
  ios: ['Open the link in Safari', 'Tap the Share button (the square with the arrow)', 'Scroll down and tap “Add to Home Screen”', 'Tap Add — Num now opens full screen like any app'],
  android: ['Open the link in Chrome', 'Tap the ⋮ menu, top right', 'Tap “Add to Home screen” / “Install app”', 'Confirm — Num now opens full screen like any app'],
};

/**
 * Mint a personalised invite. The invite is sent from the member's own phone
 * by default: it lands better than a text from an unknown shortcode, and it
 * sidesteps texting a stranger who never agreed to hear from us. The referral
 * code rides in the link, so attribution is automatic.
 */
async function invite(env, req) {
  const b = await readBody(req);
  const from = clip(b.from, 40);
  if (!from) return json({ error: 'from required' }, 400);
  const sender = await env.DB.prepare('SELECT * FROM num_members WHERE id=?1').bind(from).first();
  if (!sender) return json({ error: 'sign up first' }, 404);
  if (!sender.ref_code) return json({ error: 'no referral code on this member' }, 409);

  const toName = clip(b.to_name, 60);
  const toPhone = normalisePhone(b.to_phone);
  const planId = clip(b.plan_id, 40);
  let plan = null;
  if (planId) {
    if (!(await memberOf(env, planId, from))) return json({ error: 'not your plan' }, 403);
    plan = await env.DB.prepare('SELECT id, title, join_code FROM num_plans WHERE id=?1').bind(planId).first();
  }

  const token = friendly(10).toLowerCase();
  const link = `${CLAIM_ORIGIN}/r/${token}`;
  const senderName = sender.name || 'a friend';
  const message =
    clip(b.message, 300) ||
    (plan
      ? `${toName ? toName + ' — ' : ''}it's ${senderName}. I started “${plan.title}” on NUM — my concierge app. Join and we can plan it together, it books the tables and cars for us: ${link}`
      : `${toName ? toName + ' — ' : ''}it's ${senderName}. I use NUM as my concierge — one thread books dinner, cars, tables, everything. Here's my invite: ${link}`);

  await env.DB.prepare(
    `INSERT INTO num_invite_links (token, code, sender_id, sender_name, to_phone, to_name, message, channel)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  ).bind(token, sender.ref_code, from, senderName, toPhone, toName, message, clip(b.channel, 20) ?? 'share').run();

  // The pending half of the friendship. It activates only when they open it.
  await env.DB.prepare(
    'INSERT INTO num_links (id, a_id, b_phone, b_name, token, plan_id) VALUES (?1,?2,?3,?4,?5,?6)',
  ).bind(uid('lnk'), from, toPhone, toName, token, planId).run();

  return json({
    token,
    link,
    message,
    to_name: toName,
    // Send-from-your-own-phone payloads — these work today, no SMS provider needed.
    sms_url: `sms:${toPhone ?? ''}${/iphone|ipad|mac/i.test(req.headers.get('User-Agent') ?? '') ? '&' : '?'}body=${encodeURIComponent(message)}`,
    whatsapp_url: `https://wa.me/${toPhone ? toPhone.replace(/\D/g, '') : ''}?text=${encodeURIComponent(message)}`,
    share: { title: 'Join me on NUM', text: message, url: link },
    install_steps: INSTALL_STEPS,
  });
}

/**
 * The invitee lands here after /r/:token. This is the second half of consent:
 * they opened the invite on their own device, so the link goes active both
 * ways and — if the invite carried a plan — they join it.
 */
async function accept(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const token = clip(b.token, 40);
  if (!meId || !token) return json({ error: 'me and token required' }, 400);

  const link = await env.DB.prepare('SELECT * FROM num_links WHERE token=?1').bind(token).first();
  if (!link) return json({ error: 'unknown invite' }, 404);
  if (link.a_id === meId) return json({ error: 'that is your own invite' }, 400);
  // Already claimed by whoever opened it first. Say so without naming them —
  // a stranger who found the token should learn nothing about the two people.
  if (link.state === 'active') return json({ ok: true, already: true });

  const self = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(meId).first();
  if (!self) return json({ error: 'sign up first' }, 404);

  await env.DB.prepare("UPDATE num_links SET b_id=?2, state='active', accepted_at=datetime('now') WHERE id=?1")
    .bind(link.id, meId).run();
  await env.DB.prepare("UPDATE num_invite_links SET signed_up_at=COALESCE(signed_up_at, datetime('now')), signup_id=?2 WHERE token=?1")
    .bind(token, meId).run();

  let plan = null;
  if (link.plan_id) {
    await env.DB.prepare('INSERT OR IGNORE INTO num_plan_members (plan_id, member_id, name) VALUES (?1,?2,?3)')
      .bind(link.plan_id, meId, self.name).run();
    plan = await env.DB.prepare('SELECT id, title FROM num_plans WHERE id=?1').bind(link.plan_id).first();
    if (plan) await event(env, link.plan_id, { id: meId, name: self.name }, 'joined', `${self.name || 'A friend'} joined the plan.`);
  }

  const friend = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(link.a_id).first();
  return json({ ok: true, friend: friend ? { id: friend.id, name: friend.name } : null, plan });
}

/** Everyone this member is actually connected to, both directions. */
async function friends(env, url) {
  const meId = url.searchParams.get('me');
  if (!meId) return json({ error: 'me required' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.state, l.b_name, l.b_phone, l.token, l.plan_id,
            CASE WHEN l.a_id=?1 THEN l.b_id ELSE l.a_id END AS other_id,
            CASE WHEN l.a_id=?1 THEN 'sent' ELSE 'received' END AS direction
       FROM num_links l
      WHERE l.a_id=?1 OR l.b_id=?1
      ORDER BY l.created_at DESC LIMIT 100`,
  ).bind(meId).all();

  const ids = [...new Set((results ?? []).map((r) => r.other_id).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    const { results: rows } = await env.DB.prepare(
      `SELECT id, name FROM num_members WHERE id IN (${ids.map((_, i) => '?' + (i + 1)).join(',')})`,
    ).bind(...ids).all();
    (rows ?? []).forEach((r) => names.set(r.id, r.name));
  }
  return json({
    friends: (results ?? []).map((r) => ({
      id: r.other_id,
      name: names.get(r.other_id) || r.b_name || 'Friend',
      state: r.state,
      direction: r.direction,
      token: r.token,
      plan_id: r.plan_id,
    })),
  });
}

// ── plans ─────────────────────────────────────────────────────────────────

/** Create or rename a plan. A plan needs a title and nothing else. */
async function planWrite(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  if (!meId) return json({ error: 'me required' }, 400);
  const self = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(meId).first();
  if (!self) return json({ error: 'sign up first' }, 404);

  if (b.id) {
    const planId = clip(b.id, 40);
    if (!(await memberOf(env, planId, meId))) return json({ error: 'not your plan' }, 403);
    await env.DB.prepare(
      "UPDATE num_plans SET title=COALESCE(?2,title), dest=COALESCE(?3,dest), starts_on=COALESCE(?4,starts_on), state=COALESCE(?5,state), updated_at=datetime('now') WHERE id=?1",
    ).bind(planId, clip(b.title, 120), clip(b.dest, 80), clip(b.starts_on, 20), clip(b.state, 20)).run();
    return json({ plan: await env.DB.prepare('SELECT * FROM num_plans WHERE id=?1').bind(planId).first() });
  }

  const id = uid('pln');
  const joinCode = friendly(6);
  await env.DB.prepare(
    'INSERT INTO num_plans (id, title, dest, owner_id, starts_on, join_code) VALUES (?1,?2,?3,?4,?5,?6)',
  ).bind(id, clip(b.title, 120) || 'Our plan', clip(b.dest, 80), meId, clip(b.starts_on, 20), joinCode).run();
  await env.DB.prepare("INSERT INTO num_plan_members (plan_id, member_id, name, role) VALUES (?1,?2,?3,'owner')")
    .bind(id, meId, self.name).run();
  await event(env, id, { id: meId, name: self.name }, 'joined', `${self.name || 'Someone'} started the plan.`);
  return json({ plan: await env.DB.prepare('SELECT * FROM num_plans WHERE id=?1').bind(id).first() });
}

/**
 * Add or update an item. `status` defaults to 'idea' — that is what lets a
 * group plan a night out days before anything is actually reserved, and the
 * same row later becomes the confirmed booking.
 */
async function planItem(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const planId = clip(b.plan_id, 40);
  const mem = await memberOf(env, planId, meId);
  if (!mem) return json({ error: 'not your plan' }, 403);
  const by = { id: meId, name: mem.name };

  const fields = {
    kind: clip(b.kind, 20) ?? 'idea',
    title: clip(b.title, 120),
    place: clip(b.place, 120),
    address: clip(b.address, 200),
    day: clip(b.day, 20),
    time: clip(b.time, 10),
    status: clip(b.status, 20) ?? 'idea',
    cost: clip(b.cost, 60),
    note: clip(b.note, 500),
    photo: clip(b.photo, 400),
  };

  if (b.id) {
    const id = clip(b.id, 40);
    const before = await env.DB.prepare('SELECT * FROM num_plan_items WHERE id=?1 AND plan_id=?2').bind(id, planId).first();
    if (!before) return json({ error: 'unknown item' }, 404);
    await env.DB.prepare(
      `UPDATE num_plan_items SET kind=COALESCE(?3,kind), title=COALESCE(?4,title), place=COALESCE(?5,place),
              address=COALESCE(?6,address), day=COALESCE(?7,day), time=COALESCE(?8,time), status=COALESCE(?9,status),
              cost=COALESCE(?10,cost), note=COALESCE(?11,note), photo=COALESCE(?12,photo), updated_at=datetime('now')
        WHERE id=?1 AND plan_id=?2`,
    ).bind(id, planId, b.kind ? fields.kind : null, fields.title, fields.place, fields.address, fields.day, fields.time,
      b.status ? fields.status : null, fields.cost, fields.note, fields.photo).run();
    const after = await env.DB.prepare('SELECT * FROM num_plan_items WHERE id=?1').bind(id).first();
    const booked = before.status !== 'confirmed' && after.status === 'confirmed';
    await event(env, planId, by, booked ? 'booked' : 'item_updated',
      booked
        ? `${by.name || 'Someone'} locked in ${after.title}${after.day ? ' — ' + after.day : ''}${after.time ? ' ' + after.time : ''}${after.address ? ' · ' + after.address : ''}.`
        : `${by.name || 'Someone'} updated ${after.title}.`,
      after);
    return json({ item: after });
  }

  if (!fields.title) return json({ error: 'title required' }, 400);
  const id = uid('itm');
  await env.DB.prepare(
    `INSERT INTO num_plan_items (id, plan_id, kind, title, place, address, day, time, status, cost, note, photo, by_id, by_name)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
  ).bind(id, planId, fields.kind, fields.title, fields.place, fields.address, fields.day, fields.time, fields.status,
    fields.cost, fields.note, fields.photo, meId, mem.name).run();
  const item = await env.DB.prepare('SELECT * FROM num_plan_items WHERE id=?1').bind(id).first();
  await event(env, planId, by, 'item_added',
    `${by.name || 'Someone'} added ${item.title}${item.day ? ' — ' + item.day : ''}${item.time ? ' ' + item.time : ''}${item.status === 'idea' ? ' (idea, nothing booked yet)' : ''}.`,
    item);
  return json({ item });
}

/**
 * The sync endpoint each member's Num polls. `since` is the last event id it
 * narrated; everything newer is what the other members' agents have done and
 * this member has not been told about yet.
 */
async function planRead(env, url) {
  const id = url.searchParams.get('id');
  const meId = url.searchParams.get('me');
  const since = Number(url.searchParams.get('since') ?? 0) || 0;
  if (!(await memberOf(env, id, meId))) return json({ error: 'not your plan' }, 403);

  const plan = await env.DB.prepare('SELECT * FROM num_plans WHERE id=?1').bind(id).first();
  const { results: members } = await env.DB.prepare('SELECT member_id, name, role FROM num_plan_members WHERE plan_id=?1').bind(id).all();
  const { results: items } = await env.DB.prepare('SELECT * FROM num_plan_items WHERE plan_id=?1 ORDER BY day IS NULL, day, time').bind(id).all();
  const { results: events } = await env.DB.prepare(
    'SELECT id, ts, by_id, by_name, kind, summary FROM num_plan_events WHERE plan_id=?1 AND id > ?2 ORDER BY id LIMIT 50',
  ).bind(id, since).all();

  return json({
    plan,
    members: members ?? [],
    items: items ?? [],
    // Your own actions are not news to you — only the other agents' are.
    events: (events ?? []).filter((e) => e.by_id !== meId),
    cursor: (events ?? []).reduce((m, e) => Math.max(m, e.id), since),
  });
}

async function planList(env, url) {
  const meId = url.searchParams.get('me');
  if (!meId) return json({ error: 'me required' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM num_plan_members m WHERE m.plan_id=p.id) members,
            (SELECT COUNT(*) FROM num_plan_items i WHERE i.plan_id=p.id) items
       FROM num_plans p JOIN num_plan_members pm ON pm.plan_id=p.id
      WHERE pm.member_id=?1 ORDER BY p.updated_at DESC LIMIT 25`,
  ).bind(meId).all();
  return json({ plans: results ?? [] });
}

/** Join by code — the low-tech path when someone reads it out loud. */
async function planJoin(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const code = String(b.join_code || '').trim().toUpperCase();
  const self = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(meId ?? '').first();
  if (!self) return json({ error: 'sign up first' }, 404);
  const plan = await env.DB.prepare('SELECT * FROM num_plans WHERE join_code=?1').bind(code).first();
  if (!plan) return json({ error: 'no plan with that code' }, 404);
  await env.DB.prepare('INSERT OR IGNORE INTO num_plan_members (plan_id, member_id, name) VALUES (?1,?2,?3)')
    .bind(plan.id, meId, self.name).run();
  await event(env, plan.id, { id: meId, name: self.name }, 'joined', `${self.name || 'A friend'} joined the plan.`);
  return json({ plan });
}

// ── router ────────────────────────────────────────────────────────────────

export async function handleSocial(request, env, path) {
  if (!env.DB) return json({ error: 'social features need the database binding' }, 503);
  await ensure(env);
  const url = new URL(request.url);
  const post = request.method === 'POST';

  if (path === '/me' && post) return await me(env, request);
  if (path === '/verify' && post) return await verifyMe(env, request);
  if (path === '/invite' && post) return await invite(env, request);
  if (path === '/accept' && post) return await accept(env, request);
  if (path === '/friends') return await friends(env, url);
  if (path === '/plans') return await planList(env, url);
  if (path === '/plan' && post) return await planWrite(env, request);
  if (path === '/plan') return await planRead(env, url);
  if (path === '/plan/item' && post) return await planItem(env, request);
  if (path === '/plan/join' && post) return await planJoin(env, request);
  return json({ error: 'not found' }, 404);
}

/** Nothing here should ever surface a raw stack trace as a 1101 to the app. */
export async function handleSocialSafe(request, env, path) {
  try {
    return await handleSocial(request, env, path);
  } catch (err) {
    console.error('[social]', path, err?.message ?? err);
    return json({ error: 'that didn’t go through — try again in a moment' }, 500);
  }
}
