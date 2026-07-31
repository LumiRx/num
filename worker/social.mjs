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

const safeParse = (v) => {
  try {
    return v ? JSON.parse(v) : {};
  } catch {
    return {};
  }
};

/** Schema is created lazily so a fresh D1 needs no migration step to work. */
let ensured = false;
async function ensure(env) {
  if (ensured) return;
  const stmts = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
  // SQLite has no ADD COLUMN IF NOT EXISTS, and CREATE TABLE IF NOT EXISTS
  // silently skips a table that already exists with an older shape — so new
  // columns are added one at a time and the "duplicate column" error is the
  // expected outcome on every deploy after the first.
  for (const alter of MIGRATIONS) {
    try {
      await env.DB.prepare(alter).run();
    } catch (err) {
      if (!/duplicate column/i.test(err?.message ?? '')) console.warn('[social] migration:', err?.message);
    }
  }
  ensured = true;
}

const MIGRATIONS = [
  'ALTER TABLE num_members ADD COLUMN avatar TEXT',
  'ALTER TABLE num_members ADD COLUMN bio TEXT',
  'ALTER TABLE num_members ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0',
];

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
CREATE TABLE IF NOT EXISTS num_star_balances (member_id TEXT PRIMARY KEY, stars INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS num_star_moves (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, delta INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT, counterparty TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_num_star_moves_member ON num_star_moves(member_id);
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
  const avatar = clip(b.avatar, 60000);
  const bio = b.bio ? JSON.stringify(b.bio).slice(0, 4000) : null;

  // ROUND TRIP 1 — the member and any holder of this phone, in one query
  // instead of two. D1 latency is the whole cost of this endpoint: at 100
  // concurrent signups every extra sequential query added ~400ms to p50, so
  // the shape of this function matters more than anything inside it.
  const { results: rows } = await env.DB.prepare(
    'SELECT * FROM num_members WHERE id = ?1 OR (?2 IS NOT NULL AND phone = ?2)',
  ).bind(id, phone).all();
  const existing = (rows ?? []).find((r) => r.id === id) ?? null;
  const holder = phone ? (rows ?? []).find((r) => r.phone === phone && r.id !== id) ?? null : null;

  if (holder) {
    // Verified means it is genuinely theirs — nobody else gets to claim it.
    if (holder.phone_verified) return json({ error: 'That number is already on Num. Sign in from the device that has it.' }, 409);
  }
  if (existing) {
    // The name on a verified account is an identity claim, not a nickname: it
    // is what a friend sees next to a verified number. Once the number is
    // proved, the name is frozen and changing it goes through support — the
    // same reason a bank makes you phone them.
    const nameChange = name && name !== existing.name;
    if (nameChange && (existing.phone_verified === 1 || existing.name_locked === 1)) {
      return json({ error: 'Your name is tied to your verified number. Ask us to change it and we will.', name_locked: true }, 409);
    }
  }

  // The referral code is minted optimistically rather than after a uniqueness
  // probe: 32^6 is a billion codes, and the UNIQUE index is the real guard —
  // so we spend a retry on the (vanishingly rare) clash instead of a round
  // trip on every signup.
  const ref = existing?.ref_code ?? friendly();

  // ROUND TRIP 2 — everything the write needs, in one batch.
  const writes = [];
  // An unverified holder never proved anything, so it must not squat the
  // number against its real owner. Release it in the same batch.
  if (holder) writes.push(env.DB.prepare('UPDATE num_members SET phone=NULL WHERE id=?1').bind(holder.id));
  writes.push(
    existing
      ? env.DB.prepare(
          `UPDATE num_members SET name=COALESCE(?2,name), phone=COALESCE(?3,phone), dest=COALESCE(?4,dest),
                  avatar=COALESCE(?5,avatar), bio=COALESCE(?6,bio), ref_code=COALESCE(ref_code,?7), seen_at=datetime('now')
            WHERE id=?1`,
        ).bind(id, name, phone, dest, avatar, bio, ref)
      : env.DB.prepare(
          "INSERT INTO num_members (id, name, phone, dest, avatar, bio, ref_code, seen_at) VALUES (?1,?2,?3,?4,?5,?6,?7,datetime('now'))",
        ).bind(id, name, phone, dest, avatar, bio, ref),
  );
  if (!existing?.ref_code) {
    writes.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO num_referral_codes (code, owner_type, owner_id, reward_cs, reward_referee_cs,
                                                   max_conversions, max_reward_total_cs, active, created_at)
         VALUES (?1,'member',?2,500,500,200,200000,1,unixepoch())`,
      ).bind(ref, id),
    );
  }
  await env.DB.batch(writes);

  let verification = null;
  if (phone && !existing?.phone_verified && b.verify !== false) {
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

  // No re-read: we know exactly what was written, and a third round trip to
  // confirm our own INSERT is latency the user pays for nothing.
  return json({
    me: {
      id,
      name: name ?? existing?.name ?? null,
      phone: phone ?? existing?.phone ?? null,
      phone_verified: !!existing?.phone_verified,
      name_locked: !!(existing?.phone_verified || existing?.name_locked),
      avatar: avatar ?? existing?.avatar ?? null,
      bio: safeParse(bio ?? existing?.bio),
      ref,
    },
    ref,
    link: `https://itsnum.com/app?ref=${ref}`,
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

// ── Stars: the ledger ─────────────────────────────────────────────────────
//
// Balances live on the server, not the device. That is not a preference: a
// balance a phone can edit is not a balance, and the moment two people can pay
// each other the client stops being allowed an opinion about who has what.
//
// Stars are an in-app credit, not money and not a currency. Every movement is
// double-entered into num_star_moves so a balance can always be reconstructed
// from the log rather than trusted on its own.

const WELCOME_STARS = 100;

/** Credit a new member their welcome balance exactly once. */
async function ensureBalance(env, memberId) {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?1, ?2)').bind(memberId, WELCOME_STARS),
    env.DB.prepare(
      "INSERT OR IGNORE INTO num_star_moves (id, member_id, delta, kind, note) VALUES (?1,?2,?3,'welcome','Welcome to Num')",
    ).bind(`welcome_${memberId}`, memberId, WELCOME_STARS),
  ]);
}

/**
 * Who is behind a code — the display name and nothing else. A payment
 * confirmation that says "pay them" is not a confirmation, and this is the
 * minimum a payer needs to check they are paying the right person. No phone,
 * no email, no id beyond the one they already scanned.
 */
async function who(env, url) {
  const id = clip(url.searchParams.get('id'), 40);
  if (!id) return json({ error: 'id required' }, 400);
  const row = await env.DB.prepare('SELECT id, name, avatar, phone_verified FROM num_members WHERE id=?1').bind(id).first();
  if (!row) return json({ error: 'no one on Num has that code' }, 404);
  return json({ id: row.id, name: row.name, avatar: row.avatar ?? null, verified: !!row.phone_verified });
}

async function stars(env, url) {
  const meId = url.searchParams.get('me');
  if (!meId) return json({ error: 'me required' }, 400);
  await ensureBalance(env, meId);
  const row = await env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1').bind(meId).first();
  const { results: moves } = await env.DB.prepare(
    `SELECT m.id, m.delta, m.kind, m.note, m.counterparty, m.created_at, p.name AS other_name
       FROM num_star_moves m LEFT JOIN num_members p ON p.id = m.counterparty
      WHERE m.member_id=?1 ORDER BY m.rowid DESC LIMIT 25`,
  ).bind(meId).all();
  return json({ balance: row?.stars ?? 0, moves: moves ?? [] });
}

/**
 * Move Stars from one member to another.
 *
 * The debit is a CONDITIONAL update — `WHERE stars >= amount` — and we check
 * how many rows it changed. That is what makes a double-tap or a race safe:
 * two concurrent payments cannot both pass the check, because the second one
 * updates zero rows. `idem` makes a retried request a no-op rather than a
 * second payment, which matters when someone scans a QR on a bad connection.
 */
async function pay(env, req) {
  const b = await readBody(req);
  const from = clip(b.me, 40);
  const to = clip(b.to, 40);
  const amount = Math.floor(Number(b.amount));
  const note = clip(b.note, 140);
  const idem = clip(b.idem, 80) || crypto.randomUUID();

  if (!from || !to) return json({ error: 'me and to are required' }, 400);
  if (from === to) return json({ error: 'That’s your own code.' }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'Amount has to be a positive number of Stars.' }, 400);
  if (amount > 100_000) return json({ error: 'That’s over the per-payment limit.' }, 400);

  const payee = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(to).first();
  if (!payee) return json({ error: 'That code doesn’t match anyone on Num.' }, 404);
  const payer = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(from).first();
  if (!payer) return json({ error: 'sign up first' }, 404);

  // Already done? Return the same answer rather than paying twice.
  const seen = await env.DB.prepare('SELECT id FROM num_star_moves WHERE id=?1').bind(`${idem}:out`).first();
  if (seen) {
    const row = await env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1').bind(from).first();
    return json({ ok: true, already: true, balance: row?.stars ?? 0, to: payee.name });
  }

  await ensureBalance(env, from);
  await ensureBalance(env, to);

  const debit = await env.DB.prepare('UPDATE num_star_balances SET stars = stars - ?2 WHERE member_id = ?1 AND stars >= ?2')
    .bind(from, amount).run();
  if (!debit.meta?.changes) {
    const row = await env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1').bind(from).first();
    return json({ error: `Not enough Stars — you have ★${row?.stars ?? 0}.`, balance: row?.stars ?? 0 }, 409);
  }

  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(to, amount),
      env.DB.prepare("INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'pay',?4,?5)")
        .bind(`${idem}:out`, from, -amount, note, to),
      env.DB.prepare("INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'receive',?4,?5)")
        .bind(`${idem}:in`, to, amount, note, from),
    ]);
  } catch (err) {
    // The credit failed after the debit succeeded — put it back. Losing Stars
    // into a gap is the one outcome that is never acceptable.
    await env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(from, amount).run();
    console.error('[stars] rolled back', err?.message ?? err);
    return json({ error: 'That didn’t go through — nothing was taken.' }, 500);
  }

  const row = await env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1').bind(from).first();
  return json({ ok: true, balance: row?.stars ?? 0, to: payee.name, amount });
}

// ── the inbox ─────────────────────────────────────────────────────────────

/**
 * Everything waiting on this member's answer, in one call.
 *
 * The important bit is that a pending invite is matched by PHONE, not by
 * clicking a link: someone texts you an invite, you sign up with the number
 * they sent it to, and the request is simply there. Nothing to find, no link to
 * dig back out of a message thread.
 */
async function requests(env, url) {
  const meId = url.searchParams.get('me');
  if (!meId) return json({ error: 'me required' }, 400);
  const me = await env.DB.prepare('SELECT id, phone FROM num_members WHERE id=?1').bind(meId).first();
  if (!me) return json({ connects: [], plans: [], events: [] });

  const { results: connects } = await env.DB.prepare(
    `SELECT l.id, l.a_id, l.plan_id, l.created_at, m.name AS from_name, m.avatar AS from_avatar,
            p.title AS plan_title
       FROM num_links l
       LEFT JOIN num_members m ON m.id = l.a_id
       LEFT JOIN num_plans p ON p.id = l.plan_id
      WHERE l.state='pending' AND l.a_id <> ?1
        AND (l.b_id = ?1 OR (?2 IS NOT NULL AND l.b_phone = ?2))
      ORDER BY l.created_at DESC LIMIT 20`,
  ).bind(meId, me.phone).all();

  // Plans you are already in, where someone else has added something you have
  // not seen — the "they want you at dinner on Thursday" case.
  const { results: plans } = await env.DB.prepare(
    `SELECT p.id, p.title, p.dest, p.starts_on,
            (SELECT COUNT(*) FROM num_plan_members x WHERE x.plan_id=p.id) members,
            (SELECT COUNT(*) FROM num_plan_items i WHERE i.plan_id=p.id AND i.status IN ('idea','proposed')) open_items,
            (SELECT summary FROM num_plan_events e WHERE e.plan_id=p.id AND e.by_id <> ?1 ORDER BY e.id DESC LIMIT 1) latest
       FROM num_plans p JOIN num_plan_members pm ON pm.plan_id=p.id
      WHERE pm.member_id=?1 ORDER BY p.updated_at DESC LIMIT 10`,
  ).bind(meId).all();

  const { results: events } = await env.DB.prepare(
    `SELECT g.token, g.rsvp, e.id AS event_id, e.title, e.day, e.time, e.place, e.slug, m.name AS host_name
       FROM num_event_guests g JOIN num_events e ON e.id=g.event_id
       LEFT JOIN num_members m ON m.id = e.host_id
      WHERE (g.member_id = ?1 OR (?2 IS NOT NULL AND g.phone = ?2)) AND g.rsvp='pending'
      ORDER BY g.invited_at DESC LIMIT 10`,
  ).bind(meId, me.phone).all();

  return json({ connects: connects ?? [], plans: plans ?? [], events: events ?? [] });
}

/**
 * Answer one. Accepting a connection is the same consent step the invite link
 * performs — this is just the other door into it, for people who never clicked.
 */
async function respond(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const id = clip(b.id, 60);
  const action = ['accept', 'decline', 'propose', 'message'].includes(b.action) ? b.action : null;
  if (!meId || !id || !action) return json({ error: 'me, id and a valid action are required' }, 400);
  const self = await env.DB.prepare('SELECT id, name, phone FROM num_members WHERE id=?1').bind(meId).first();
  if (!self) return json({ error: 'sign up first' }, 404);

  if (b.kind === 'connect') {
    const link = await env.DB.prepare('SELECT * FROM num_links WHERE id=?1').bind(id).first();
    if (!link) return json({ error: 'unknown request' }, 404);
    // You must be the ADDRESSEE. The earlier version only rejected when b_id
    // was already set, so a pending invite — which is every invite in an inbox —
    // could be accepted by any member who knew its id, putting a stranger
    // inside a private group plan. Positive check only: this request is yours
    // if it names you, or was sent to your number.
    const mine =
      (link.b_id && link.b_id === meId) ||
      (link.b_phone && self.phone && link.b_phone === self.phone);
    if (link.a_id === meId || !mine) return json({ error: 'not your request' }, 403);
    if (action === 'decline') {
      await env.DB.prepare("UPDATE num_links SET state='declined', b_id=?2 WHERE id=?1").bind(id, meId).run();
      return json({ ok: true, state: 'declined' });
    }
    await env.DB.prepare("UPDATE num_links SET b_id=?2, state='active', accepted_at=datetime('now') WHERE id=?1").bind(id, meId).run();
    let plan = null;
    if (link.plan_id) {
      await env.DB.prepare('INSERT OR IGNORE INTO num_plan_members (plan_id, member_id, name) VALUES (?1,?2,?3)')
        .bind(link.plan_id, meId, self.name).run();
      plan = await env.DB.prepare('SELECT id, title FROM num_plans WHERE id=?1').bind(link.plan_id).first();
      if (plan) await event(env, link.plan_id, { id: meId, name: self.name }, 'joined', `${self.name || 'A friend'} joined the plan.`);
    }
    const friend = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(link.a_id).first();
    return json({ ok: true, state: 'active', friend, plan });
  }

  if (b.kind === 'plan') {
    const mem = await memberOf(env, id, meId);
    if (!mem) return json({ error: 'not your plan' }, 403);
    const note = clip(b.message, 300);
    const when = clip(b.time, 40);
    // Proposing a time and leaving a note are the two things a group actually
    // does; both land in the feed so every other Num narrates them.
    const summary =
      action === 'propose'
        ? `${self.name || 'Someone'} suggested ${when || 'another time'}${note ? ` — “${note}”` : ''}.`
        : action === 'decline'
          ? `${self.name || 'Someone'} can’t make it${note ? ` — “${note}”` : ''}.`
          : action === 'accept'
            ? `${self.name || 'Someone'} is in.`
            : `${self.name || 'Someone'} said: “${note ?? ''}”`;
    await event(env, id, { id: meId, name: self.name }, action === 'propose' ? 'item_updated' : 'note', summary, { action, when, note });
    return json({ ok: true, posted: summary });
  }

  if (b.kind === 'event') {
    const g = await env.DB.prepare('SELECT * FROM num_event_guests WHERE token=?1').bind(id).first();
    if (!g) return json({ error: 'unknown invite' }, 404);
    const rsvp = action === 'accept' ? 'yes' : action === 'decline' ? 'no' : 'maybe';
    await env.DB.prepare(
      "UPDATE num_event_guests SET rsvp=?2, member_id=?3, message=COALESCE(?4,message), replied_at=datetime('now') WHERE token=?1",
    ).bind(id, rsvp, meId, clip(b.message, 300)).run();
    return json({ ok: true, rsvp });
  }

  return json({ error: 'unknown kind' }, 400);
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
  if (path === '/requests') return await requests(env, url);
  if (path === '/who') return await who(env, url);
  if (path === '/stars') return await stars(env, url);
  if (path === '/pay' && post) return await pay(env, request);
  if (path === '/respond' && post) return await respond(env, request);
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
