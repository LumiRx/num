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
import { notify } from './push.mjs';
import { answerEventInvite } from './events.mjs';
import { INVITE_POLICIES, DEFAULT_INVITE_POLICY, ensurePermissions, memberPolicy, setInvitePolicy } from './permissions.mjs';

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 — codes get read aloud
const CLAIM_ORIGIN = 'https://num-claim.thatislumi.workers.dev';

/**
 * Where the app actually lives — and therefore the ONLY origin an invite,
 * referral or QR code may point at.
 *
 * This was https://itsnum.com/app, which is the marketing site and 307s to a
 * landing page. Three separate bugs came out of that one string:
 *
 *   · The recipient looked SIGNED OUT. localStorage is per-origin, so a
 *     member who set Num up on app.itsnum.com has no account at all on
 *     itsnum.com. Their trip, their Stars, their friends — all invisible.
 *   · The invite never appeared, because nothing on that origin reads it.
 *   · Someone with the app installed was asked to install it again. A PWA
 *     only captures links inside its own scope; a link outside it opens the
 *     browser and offers a download.
 *
 * Derived from the request rather than hardcoded, so preview deploys generate
 * links back to the preview they came from instead of sending a tester to
 * production.
 */
const appOrigin = (env, request) => {
  // The canonical host wins. Deriving from the request means a preview deploy
  // mints invites pointing at a workers.dev URL — which is what a share link
  // reading "num-app.thatislumi.workers.dev" actually is. Only fall back to
  // the request when no canonical host is configured at all.
  if (env?.NUM_APP_ORIGIN) return env.NUM_APP_ORIGIN;
  const o = new URL(request.url).origin;
  return /workers\.dev$/.test(new URL(o).hostname) ? 'https://app.itsnum.com' : o;
};

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
  await ensurePermissions(env);
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
CREATE TABLE IF NOT EXISTS num_plan_members (plan_id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'member', joined_at TEXT NOT NULL DEFAULT (datetime('now')), vote TEXT, PRIMARY KEY (plan_id, member_id));
CREATE TABLE IF NOT EXISTS num_plan_items (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'idea', title TEXT NOT NULL, place TEXT, address TEXT, day TEXT, time TEXT, status TEXT NOT NULL DEFAULT 'idea', cost TEXT, note TEXT, photo TEXT, by_id TEXT, by_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_num_plan_items_plan ON num_plan_items(plan_id);
/* Who is actually on a reservation. member_id is nullable on purpose: a table
   for four routinely includes somebody who will never install Num, and a guest
   list that can only hold app users is a guest list that is always wrong.
   Named guests count toward the party size and have no agent of their own. */
CREATE TABLE IF NOT EXISTS num_item_attendees (
  item_id TEXT NOT NULL, member_id TEXT, name TEXT NOT NULL,
  rsvp TEXT NOT NULL DEFAULT 'going', added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, name)
);
CREATE INDEX IF NOT EXISTS idx_num_item_attendees ON num_item_attendees(item_id);
CREATE INDEX IF NOT EXISTS idx_num_item_attendees_member ON num_item_attendees(member_id);
CREATE TABLE IF NOT EXISTS num_plan_events (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, ts TEXT NOT NULL DEFAULT (datetime('now')), by_id TEXT, by_name TEXT, kind TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT);
CREATE INDEX IF NOT EXISTS idx_num_plan_events_plan ON num_plan_events(plan_id, id);
CREATE TABLE IF NOT EXISTS num_star_balances (member_id TEXT PRIMARY KEY, stars INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS num_star_moves (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, delta INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT, counterparty TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_num_star_moves_member ON num_star_moves(member_id);
CREATE TABLE IF NOT EXISTS num_identity_signals (member_id TEXT PRIMARY KEY, device_id TEXT, ip_hash TEXT, ua_hash TEXT, country TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_num_identity_ip ON num_identity_signals(ip_hash);
CREATE TABLE IF NOT EXISTS num_tabs (id TEXT PRIMARY KEY, code TEXT UNIQUE, title TEXT NOT NULL, venue TEXT, owner_id TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'stars', state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT);
CREATE TABLE IF NOT EXISTS num_tab_members (tab_id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT, joined_at TEXT NOT NULL DEFAULT (datetime('now')), settled_at TEXT, PRIMARY KEY (tab_id, member_id));
CREATE TABLE IF NOT EXISTS num_tab_items (id TEXT PRIMARY KEY, tab_id TEXT NOT NULL, label TEXT NOT NULL, stars INTEGER NOT NULL, paid_by TEXT NOT NULL, shared_with TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_num_tab_items ON num_tab_items(tab_id);
CREATE TABLE IF NOT EXISTS num_tab_settlements (id TEXT PRIMARY KEY, tab_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, stars INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_num_tab_settlements ON num_tab_settlements(tab_id);
`;

async function event(env, planId, by, kind, summary, payload) {
  await env.DB.prepare(
    'INSERT INTO num_plan_events (plan_id, by_id, by_name, kind, summary, payload) VALUES (?1,?2,?3,?4,?5,?6)',
  ).bind(planId, by?.id ?? null, by?.name ?? null, kind, summary.slice(0, 300), payload ? JSON.stringify(payload) : null).run();
  await env.DB.prepare("UPDATE num_plans SET updated_at=datetime('now') WHERE id=?1").bind(planId).run();

  // The group hears about it on their phones, not the next time they happen to
  // open the app. This is the whole point of a shared plan: a booking is only
  // useful to the other five people if it reaches them.
  //
  // 'joined' is deliberately excluded — nobody needs a buzz because somebody
  // accepted an invite they already knew about.
  if (kind === 'joined') return;
  try {
    const plan = await env.DB.prepare('SELECT title FROM num_plans WHERE id=?1').bind(planId).first();
    const { results: members } = await env.DB.prepare(
      'SELECT member_id FROM num_plan_members WHERE plan_id=?1 AND member_id <> ?2',
    ).bind(planId, by?.id ?? '').all();
    await Promise.all(
      (members ?? []).map((m) =>
        notify(env, {
          memberId: m.member_id,
          kind: 'plan',
          title: plan?.title ?? 'Your plan',
          body: summary,
          url: '/?app',
          // One tag per plan: three changes in a minute collapse into the
          // latest instead of stacking three buzzes for one dinner.
          tag: `plan:${planId}`,
        }),
      ),
    );
  } catch (err) {
    console.warn('[plan-notify]', err?.message ?? err);
  }
}

/** Every plan endpoint runs through this — membership is the authorisation. */
async function memberOf(env, planId, memberId) {
  if (!planId || !memberId) return null;
  return await env.DB.prepare('SELECT * FROM num_plan_members WHERE plan_id=?1 AND member_id=?2')
    .bind(planId, memberId).first();
}

// ── who is real: signals and collisions ───────────────────────────────────

const sha12 = async (v) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v ?? '')));
  return [...new Uint8Array(buf)].slice(0, 12).map((x) => x.toString(16).padStart(2, '0')).join('');
};

async function ctxSignals(env, memberId, req, body) {
  const ip = req.headers.get('CF-Connecting-IP') ?? '';
  await env.DB.prepare(
    `INSERT INTO num_identity_signals (member_id, device_id, ip_hash, ua_hash, country)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(member_id) DO UPDATE SET ip_hash=excluded.ip_hash, ua_hash=excluded.ua_hash, country=excluded.country`,
  ).bind(
    memberId,
    clip(body?.device, 64) ?? memberId,
    ip ? await sha12(ip) : null,
    await sha12(req.headers.get('User-Agent') ?? ''),
    req.headers.get('CF-IPCountry') ?? null,
  ).run();
}

/** A refused duplicate is a signal, not just an error — so keep it. */
async function flagCollision(env, { kind, value, existing, attempted, req }) {
  try {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO num_identity_signals (member_id, device_id, ip_hash, ua_hash, country) VALUES (?1,?2,?3,?4,?5)',
    ).bind(
      `collision:${kind}:${await sha12(value)}:${attempted}`,
      attempted,
      req ? await sha12(req.headers.get('CF-Connecting-IP') ?? '') : null,
      `blocked:${kind}:kept=${existing}`,
      req?.headers.get('CF-IPCountry') ?? null,
    ).run();
  } catch (err) {
    console.warn('[identity] collision log failed', err?.message ?? err);
  }
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
  // A number without a country code is unusable: it cannot be texted, it
  // cannot be matched against another member, and it silently becomes a
  // different number in another country. normalisePhone keeps the digits
  // either way, so without this check it SAVED and then failed at every
  // later step, which is far worse than refusing it here.
  if (b.phone && (!phone || !phone.startsWith('+'))) {
    return json({ error: 'That number needs its country code — start it with + (like +1, +44 or +66).', bad_phone: true }, 400);
  }
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

  // A NEW account needs a name. Without this, `POST /me {}` minted an account
  // AND a referral code on every call — a Sybil farm in one curl loop, and
  // referral codes are worth Stars. Existing accounts may still patch freely.
  if (!existing && !name) {
    return json({ error: 'Tell me your name first — I can’t open an account without one.' }, 400);
  }

  if (holder) {
    // One number, one account, verified or not.
    //
    // Releasing an unverified number to whoever asked next was wrong in both
    // directions: it let one person mint an account per device from a single
    // number, and it handed a stranger somebody else's account for the price of
    // typing their number. Until SMS is on, an unverified number is a CLAIM, so
    // the right answer to a collision is to refuse it and write it down.
    await flagCollision(env, { kind: 'phone', value: phone, existing: holder.id, attempted: id, req });

    // RECOVERY. If the number on the existing account was never verified, hand
    // that account back to whoever is asking, rather than locking them out.
    //
    // This looks like a weakening and is not. The block exists to stop one
    // person minting many accounts — but an UNVERIFIED number proves nothing
    // in the first place: anybody could have typed it to register. Refusing
    // the same claim on the way back in therefore stops no attacker and
    // strands every real person who clears their storage, reinstalls, or gets
    // a new phone. Their trip, their Stars and their friends become
    // unreachable, with an error telling them to use a device that is the one
    // they are holding.
    //
    // A VERIFIED number is different — that is a real proof and it stays shut.
    if (!holder.phone_verified) {
      await env.DB.prepare("UPDATE num_members SET name=COALESCE(NULLIF(?2,''), name), seen_at=datetime('now') WHERE id=?1")
        .bind(holder.id, clip(b.name, 60) ?? '').run().catch(() => {});
      const back = await env.DB.prepare('SELECT * FROM num_members WHERE id=?1').bind(holder.id).first();
      return json({
        me: {
          id: back.id,
          name: back.name,
          phone: back.phone,
          phone_verified: !!back.phone_verified,
          name_locked: !!back.name_locked,
          avatar: back.avatar ?? null,
          bio: safeParse(back.bio),
          ref: back.ref_code,
        },
        ref: back.ref_code,
        link: `${appOrigin(env, req)}/r/${back.ref_code}`,
        recovered: true,
        verification: { sent: false, reason: 'recovered_unverified', note: 'Welcome back — everything on this number is still here.' },
      });
    }

    return json(
      {
        error: holder.phone_verified
          ? 'That number is already on Num. Sign in from the device that has it.'
          : 'That number is already on an account. Open Num on the device you set it up on, or verify it to move it across.',
        number_taken: true,
      },
      409,
    );
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

  // Who, and roughly where from — the raw material for spotting a farm. Hashed,
  // because an IP is personal data and the only question we ever ask of it is
  // whether two accounts share one, never what it was.
  ctxSignals(env, id, req, b).catch((err) => console.warn('[identity]', err?.message ?? err));

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
    link: `${appOrigin(env, req)}/r/${ref}`,
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
  // Straight to the app, carrying the token. It used to go via the claim
  // worker's /r/ route, which 302'd to a workers.dev URL and DROPPED the
  // token on the way — so the recipient arrived on a origin where they had no
  // account, with no invite to accept. Two of the three hops existed only to
  // lose information; bootSocial has always read `?i=` directly.
  const link = `${appOrigin(env, req)}/i/${token}`;
  const senderName = sender.name || 'a friend';

  // Is the invitee ALREADY one of us? Then the invite is a delivery, not a
  // pitch. Without this check an existing member (Vivian, day one) tapped the
  // link, landed in Safari — which on iOS shares nothing with her installed
  // app — and was asked to sign up again. Instead: put the plan straight into
  // her app, buzz her phone, and let the texted link be a pointer, not a gate.
  const existing = toPhone
    ? await env.DB.prepare('SELECT id, name FROM num_members WHERE phone=?1').bind(toPhone).first()
    : null;
  if (existing && plan) {
    await env.DB.prepare('INSERT OR IGNORE INTO num_plan_members (plan_id, member_id, name) VALUES (?1,?2,?3)')
      .bind(plan.id, existing.id, existing.name ?? toName).run();
    // 'joined' kind deliberately: it doesn't broadcast-push (see event()), and
    // the invitee gets their own targeted buzz below instead.
    await event(env, plan.id, { id: from, name: senderName }, 'joined',
      `${existing.name || toName || 'A friend'} was added by ${senderName} — the plan is in their app.`);
    await notify(env, {
      memberId: existing.id, kind: 'plan', title: plan.title,
      body: `${senderName} added you to “${plan.title}” — open Num to see it and say if you're in.`,
      url: '/?app', tag: `plan:${plan.id}`,
    }).catch(() => {});
  }

  const message =
    clip(b.message, 300) ||
    (existing && plan
      ? `${toName ? toName + ' — ' : ''}it's ${senderName}. “${plan.title}” is already waiting in your NUM app — open Num and you're in. (Link if you need it: ${link})`
      : plan
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
    // Already a member — the plan is in their app and their phone buzzed.
    // The client shows "delivered" instead of pretending a signup is needed.
    on_num: !!existing,
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
/**
 * Connect two people directly, from a shared code.
 *
 * This is what a QR or a "connect with me" link should always have done. The
 * old links carried ?c=<member id> and NOTHING read it — the code generated
 * fine, scanned fine, and then sat there. Sharing a code is an offer and
 * scanning one is an acceptance, so the connection is made on the spot rather
 * than queued as a request nobody remembers to approve.
 *
 * Idempotent by construction: an existing link between the two is returned
 * rather than duplicated, so scanning the same code twice is harmless.
 */
/**
 * Verify a Num member against their 5arz account.
 *
 * 5arz already does real identity work — ID checks, uniqueness attestations,
 * scored work sessions — and a person who has been through that should not be
 * asked to prove themselves twice. If they are verified over there, they are
 * verified here.
 *
 * IT MATCHES ON EMAIL, NOT PHONE. The 5arz members table has no phone column
 * at all, so a phone-based link is not available however much it would suit
 * the signup flow we already have. Email is the only shared identifier, which
 * means Num has to ask for one — and asking is honest, because the alternative
 * is a match on something neither system holds.
 *
 * This does NOT verify the phone number. It verifies the PERSON. Those are
 * different claims and conflating them would put a "verified" badge next to a
 * number nobody has ever sent a code to — which is exactly the badge people
 * would rely on when deciding whether to meet a stranger.
 */
async function verifyVia5arz(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  if (!meId) return json({ error: 'me is required' }, 400);
  if (!env.LEDGER) return json({ error: '5arz is not connected to this Worker.' }, 503);

  // PROOF, not a claim. The first version of this took an email address and
  // verified whoever typed it — which meant anybody could type any of the
  // verified addresses and inherit that person's identity. An identity system
  // that trusts the assertion it is meant to be checking is worse than none,
  // because it puts a badge on the lie.
  //
  // 5arz signs its members in with Google, so a Google ID token is proof the
  // person controls the account. It is validated with Google (not parsed and
  // believed), and matched on `sub` — the stable subject id — rather than on
  // the email, which users can change.
  const idToken = clip(b.google_id_token, 4096);
  if (!idToken) {
    return json(
      {
        error: 'Sign in with the Google account you use for 5arz — an email address on its own is not proof.',
        needs: 'google_id_token',
      },
      401,
    );
  }

  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!info?.sub) return json({ error: 'That sign-in could not be verified with Google.' }, 401);

  // The token must have been issued FOR us. Without this check any valid
  // Google token from any app in the world would be accepted here.
  if (env.GOOGLE_CLIENT_ID && info.aud !== env.GOOGLE_CLIENT_ID) {
    return json({ error: 'That sign-in was issued for a different app.' }, 401);
  }
  if (info.email_verified === 'false' || info.email_verified === false) {
    return json({ error: 'That Google account has an unverified email.' }, 401);
  }

  const email = clip(String(info.email ?? '').trim().toLowerCase(), 160);
  const googleSub = clip(info.sub, 64);

  const self = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(meId).first();
  if (!self) return json({ error: 'sign up first' }, 404);

  // google_sub is the strong match: stable, and it cannot be typed by someone
  // who does not control the account. email_lower is the fallback for the 5arz
  // members who signed up before Google was wired in — still safe, because the
  // address itself now comes from a validated token rather than the request.
  const row =
    (await env.LEDGER
      .prepare('SELECT id, verified_at, verification_ref, identity_status, country, legal_name FROM members WHERE google_sub=?1 LIMIT 1')
      .bind(googleSub)
      .first()
      .catch(() => null)) ??
    (await env.LEDGER
      .prepare('SELECT id, verified_at, verification_ref, identity_status, country, legal_name FROM members WHERE email_lower=?1 LIMIT 1')
      .bind(email)
      .first()
      .catch(() => null));

  if (!row) {
    return json({
      verified: false,
      reason: 'no_5arz_account',
      message: 'No 5arz account on that address. Sign in to 5arz with it first, then come back.',
    });
  }
  if (!row.verified_at) {
    return json({
      verified: false,
      reason: 'not_verified_there',
      message: 'That 5arz account exists but hasn’t completed identity verification yet.',
      identity_status: row.identity_status ?? null,
    });
  }

  // One 5arz identity, one Num account. Without this, a single verified person
  // could bless any number of Num accounts, which is the whole Sybil problem
  // wearing a badge.
  const taken = await env.DB.prepare("SELECT id FROM num_members WHERE bio LIKE ?1 AND id <> ?2")
    .bind(`%"5arz_id":"${row.id}"%`, meId).first().catch(() => null);
  if (taken) {
    return json({ verified: false, reason: 'already_linked', message: 'That 5arz account is already linked to another Num account.' }, 409);
  }

  const bio = safeParse((await env.DB.prepare('SELECT bio FROM num_members WHERE id=?1').bind(meId).first())?.bio);
  bio['5arz_id'] = row.id;
  bio['5arz_verified_at'] = row.verified_at;
  if (row.country) bio.country = row.country;

  await env.DB.prepare(
    "UPDATE num_members SET identity_verified=1, identity_basis='5arz', bio=?2, name=COALESCE(NULLIF(name,''), ?3) WHERE id=?1",
  ).bind(meId, JSON.stringify(bio), clip(row.legal_name, 60)).run().catch(async () => {
    // The columns may not exist on older deployments — add them and retry
    // rather than failing a verification that genuinely succeeded.
    await env.DB.prepare('ALTER TABLE num_members ADD COLUMN identity_verified INTEGER NOT NULL DEFAULT 0').run().catch(() => {});
    await env.DB.prepare('ALTER TABLE num_members ADD COLUMN identity_basis TEXT').run().catch(() => {});
    await env.DB.prepare("UPDATE num_members SET identity_verified=1, identity_basis='5arz', bio=?2 WHERE id=?1")
      .bind(meId, JSON.stringify(bio)).run().catch(() => {});
  });

  return json({
    verified: true,
    basis: '5arz',
    verified_at: row.verified_at,
    country: row.country ?? null,
    // Said plainly so no caller mistakes one for the other.
    note: 'Identity is verified through 5arz. The phone number is still unverified — that needs an SMS code.',
  });
}

async function connect(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const toId = clip(b.to, 40);
  if (!meId || !toId) return json({ error: 'me and to are required' }, 400);
  if (meId === toId) return json({ error: 'That’s your own code.' }, 400);

  const self = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(meId).first();
  if (!self) return json({ error: 'sign up first' }, 404);
  const other = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(toId).first();
  if (!other) return json({ error: 'That code doesn’t match anyone on Num.' }, 404);

  // Either direction counts — friendship is not directional, and creating a
  // second row for the mirror image would double every friend list.
  const existing = await env.DB.prepare(
    "SELECT id, state FROM num_links WHERE (a_id=?1 AND b_id=?2) OR (a_id=?2 AND b_id=?1) LIMIT 1",
  ).bind(meId, toId).first();

  if (existing) {
    if (existing.state !== 'active') {
      await env.DB.prepare("UPDATE num_links SET state='active', accepted_at=datetime('now') WHERE id=?1")
        .bind(existing.id).run();
    }
    return json({ ok: true, already: existing.state === 'active', friend: { id: other.id, name: other.name } });
  }

  await env.DB.prepare(
    "INSERT INTO num_links (id, a_id, b_id, b_name, state, accepted_at) VALUES (?1,?2,?3,?4,'active',datetime('now'))",
  ).bind(uid('lnk'), toId, meId, self.name).run();

  return json({ ok: true, friend: { id: other.id, name: other.name } });
}

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

// ── who may reach me ──────────────────────────────────────────────────────

/**
 * The invite door, read and written.
 *
 * `accepting` is returned alongside `invite_policy` because the UI is a switch
 * and a choice, not a three-way radio nobody reads: flipping it off has to
 * remember whether they were on 'friends' or 'public' so flipping it back does
 * not silently open them up to strangers. `previous` carries that memory.
 */
async function prefsRead(env, url) {
  const meId = clip(url.searchParams.get('me'), 40);
  if (!meId) return json({ error: 'me required' }, 400);
  const p = await memberPolicy(env, meId);
  if (!p) return json({ error: 'no such member' }, 404);
  return json({
    invite_policy: p.policy,
    accepting: p.policy !== 'off',
    options: [
      { value: 'friends', label: 'Friends only', detail: 'Only people you’re connected to can ask you to join things.' },
      { value: 'public', label: 'Anyone on Num', detail: 'Anyone can ask. You still answer every one.' },
      { value: 'off', label: 'Off', detail: 'Nobody can ask. Your own invites still work.' },
    ],
  });
}

async function prefsWrite(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  if (!meId) return json({ error: 'me required' }, 400);
  const current = await memberPolicy(env, meId);
  if (!current) return json({ error: 'sign up first' }, 404);

  // Two ways in, because a switch and a picker are both real UI. `accepting:
  // false` means off; `accepting: true` restores the last open setting rather
  // than assuming 'public', which is the setting nobody would have chosen.
  let next = clip(b.invite_policy, 20);
  if (next == null && typeof b.accepting === 'boolean') {
    next = b.accepting ? (INVITE_POLICIES.has(clip(b.previous, 20)) && b.previous !== 'off' ? b.previous : DEFAULT_INVITE_POLICY) : 'off';
  }
  if (!INVITE_POLICIES.has(next)) {
    return json({ error: `invite_policy must be one of ${[...INVITE_POLICIES].join(', ')}` }, 400);
  }

  const saved = await setInvitePolicy(env, meId, next);
  if (!saved) return json({ error: 'that didn’t save' }, 500);
  return json({
    ok: true,
    invite_policy: saved,
    accepting: saved !== 'off',
    was: current.policy,
    // Said back plainly, because a privacy switch that does not confirm what
    // it just did is a switch people flip twice.
    note:
      saved === 'off'
        ? 'Nobody can send you invites now. You can still send your own.'
        : saved === 'public'
          ? 'Anyone on Num can ask you to join something. You answer every one.'
          : 'Only people you’re connected to can ask you to join something.',
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
export async function ensureBalance(env, memberId) {
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

/**
 * A member's own balance and history.
 *
 * Two problems this had, both worth naming because they are the same mistake:
 * treating the member id as a secret when it is not.
 *
 *   · It MINTED. ensureBalance ran before any check, so calling this with a
 *     made-up id created a row and granted it the welcome Stars. Anyone could
 *     manufacture balances by the thousand, and every one of them polluted the
 *     escrow invariant the operator dashboard relies on.
 *   · It LEAKED. It returned the full move history — who paid whom, for what —
 *     for any id supplied. Member ids are printed in the connect QR code, so
 *     scanning somebody's code was enough to read their transactions.
 *
 * Fixed here by requiring the member to actually exist before anything is
 * created or returned. That closes the minting outright and narrows the leak
 * to people who already hold a real id.
 *
 * IT DOES NOT CLOSE THE LEAK COMPLETELY, and pretending otherwise would be
 * worse than the bug. This app has no session: the member id IS the
 * credential, and it is also the thing shown in a QR. The real fix is a device
 * secret issued at sign-up and sent with each request — see docs/security.md.
 */
async function stars(env, url) {
  const meId = clip(url.searchParams.get('me'), 40);
  if (!meId) return json({ error: 'me required' }, 400);
  const member = await env.DB.prepare('SELECT id FROM num_members WHERE id=?1').bind(meId).first();
  if (!member) return json({ error: 'no such member' }, 404);
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

// ── live tabs ─────────────────────────────────────────────────────────────
//
// A tab is the bill while it is still happening, not after. Someone opens it,
// the rest scan in, and every round lands on it as it is bought — so the moment
// anyone asks "what do I owe?" the answer already exists.
//
// The split is PER ITEM, not per table, because the whole reason splitting a
// bill is unpleasant is that one person had the wine and two people did not.
// An item names who was on it; if it names nobody, everybody is.

/** Who owes what, computed from the items rather than stored. */
/**
 * Who owes whom, right now.
 *
 * `settlements` is not an afterthought — without it the split is computed from
 * the rounds alone, so a person who has already paid still reads "owes ★30"
 * and can be asked to pay again. Money that has moved has to move the maths
 * with it: a settlement counts as the payer having put that much in, and the
 * receiver having had that much of their stake returned.
 */
function settleUp(members, items, settlements = []) {
  const owed = Object.fromEntries(members.map((m) => [m.member_id, 0]));
  const paid = Object.fromEntries(members.map((m) => [m.member_id, 0]));
  for (const it of items) {
    const on = (() => {
      try {
        const parsed = JSON.parse(it.shared_with ?? 'null');
        return Array.isArray(parsed) && parsed.length ? parsed : members.map((m) => m.member_id);
      } catch {
        return members.map((m) => m.member_id);
      }
    })().filter((id) => id in owed);
    if (!on.length) continue;
    // Integer Stars only. The remainder goes to the payer rather than
    // vanishing — a split that loses a Star is a split somebody argues about.
    const each = Math.floor(it.stars / on.length);
    const remainder = it.stars - each * on.length;
    on.forEach((id) => (owed[id] += each));
    owed[it.paid_by] = (owed[it.paid_by] ?? 0) + remainder;
    paid[it.paid_by] = (paid[it.paid_by] ?? 0) + it.stars;
  }
  for (const st of settlements) {
    if (!(st.from_id in paid) || !(st.to_id in paid)) continue;
    paid[st.from_id] += st.stars;
    paid[st.to_id] -= st.stars;
  }

  return members.map((m) => ({
    member_id: m.member_id,
    name: m.name,
    owes: owed[m.member_id] ?? 0,
    paid: paid[m.member_id] ?? 0,
    net: (paid[m.member_id] ?? 0) - (owed[m.member_id] ?? 0),
    settled_at: m.settled_at,
  }));
}

async function tabState(env, id) {
  const tab = await env.DB.prepare('SELECT * FROM num_tabs WHERE id=?1 OR code=?1').bind(id).first();
  if (!tab) return null;
  const { results: members } = await env.DB.prepare('SELECT member_id, name, settled_at FROM num_tab_members WHERE tab_id=?1').bind(tab.id).all();
  // Join the payer's name in: "Ana bought the first round" is the line people
  // read, and an id is not a name.
  const { results: items } = await env.DB.prepare(
    `SELECT i.*, m.name AS paid_by_name FROM num_tab_items i
     LEFT JOIN num_tab_members m ON m.tab_id = i.tab_id AND m.member_id = i.paid_by
     WHERE i.tab_id=?1 ORDER BY i.rowid`,
  ).bind(tab.id).all();
  const { results: paid } = await env.DB.prepare('SELECT from_id, to_id, stars FROM num_tab_settlements WHERE tab_id=?1').bind(tab.id).all();
  const total = (items ?? []).reduce((n, i) => n + i.stars, 0);
  return {
    tab,
    members: members ?? [],
    items: items ?? [],
    total,
    settled: (paid ?? []).reduce((n, p) => n + p.stars, 0),
    split: settleUp(members ?? [], items ?? [], paid ?? []),
  };
}

async function tabWrite(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const self = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(meId ?? '').first();
  if (!self) return json({ error: 'sign up first' }, 404);

  const id = uid('tab');
  const code = friendly(6);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO num_tabs (id, code, title, venue, owner_id) VALUES (?1,?2,?3,?4,?5)')
      .bind(id, code, clip(b.title, 80) || 'Tonight', clip(b.venue, 120), meId),
    env.DB.prepare('INSERT INTO num_tab_members (tab_id, member_id, name) VALUES (?1,?2,?3)').bind(id, meId, self.name),
  ]);
  return json(await tabState(env, id));
}

async function tabJoin(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const self = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(meId ?? '').first();
  if (!self) return json({ error: 'sign up first' }, 404);
  const tab = await env.DB.prepare("SELECT * FROM num_tabs WHERE code=?1 AND state='open'").bind(String(b.code ?? '').toUpperCase()).first();
  if (!tab) return json({ error: 'No open tab with that code.' }, 404);
  await env.DB.prepare('INSERT OR IGNORE INTO num_tab_members (tab_id, member_id, name) VALUES (?1,?2,?3)').bind(tab.id, meId, self.name).run();
  await notifyTab(env, tab, meId, `${self.name || 'Someone'} joined the tab.`);
  return json(await tabState(env, tab.id));
}

async function tabItem(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const tabId = clip(b.tab_id, 40);
  const mine = await env.DB.prepare('SELECT * FROM num_tab_members WHERE tab_id=?1 AND member_id=?2').bind(tabId ?? '', meId ?? '').first();
  if (!mine) return json({ error: 'not your tab' }, 403);
  const tab = await env.DB.prepare("SELECT * FROM num_tabs WHERE id=?1 AND state='open'").bind(tabId).first();
  if (!tab) return json({ error: 'That tab is closed.' }, 409);

  const stars = Math.floor(Number(b.stars));
  if (!Number.isFinite(stars) || stars <= 0) return json({ error: 'How many Stars?' }, 400);
  const on = Array.isArray(b.shared_with) && b.shared_with.length ? b.shared_with.map((x) => clip(x, 40)) : null;

  await env.DB.prepare('INSERT INTO num_tab_items (id, tab_id, label, stars, paid_by, shared_with) VALUES (?1,?2,?3,?4,?5,?6)')
    .bind(uid('itm'), tabId, clip(b.label, 80) || 'Round', stars, meId, on ? JSON.stringify(on) : null).run();
  await notifyTab(env, tab, meId, `${mine.name || 'Someone'} put ${clip(b.label, 40) || 'a round'} on the tab — ★${stars}.`);
  return json(await tabState(env, tabId));
}

/**
 * Settle. Everyone who owes pays the people who fronted it, in Stars, through
 * the same conditional-debit ledger a direct payment uses — so a tab cannot
 * move money the balance does not have.
 */
async function tabSettle(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const state = await tabState(env, clip(b.tab_id, 40) ?? '');
  if (!state) return json({ error: 'no such tab' }, 404);
  if (!state.members.some((m) => m.member_id === meId)) return json({ error: 'not your tab' }, 403);

  const mine = state.split.find((s) => s.member_id === meId);
  if (!mine || mine.net >= 0) {
    await env.DB.prepare("UPDATE num_tab_members SET settled_at=datetime('now') WHERE tab_id=?1 AND member_id=?2").bind(state.tab.id, meId).run();
    return json({ ok: true, nothing_owed: true, ...(await tabState(env, state.tab.id)) });
  }

  // Pay each person who is up, largest first, until this member is square.
  let left = -mine.net;
  const creditors = state.split.filter((s) => s.net > 0).sort((a, b2) => b2.net - a.net);

  // Every balance row has to exist before a conditional debit can touch it.
  // Without this the debit updates zero rows and reports "not enough Stars" to
  // somebody whose balance is fine — it just had never been written down.
  await Promise.all([meId, ...creditors.map((c) => c.member_id)].map((id) => ensureBalance(env, id)));
  const paid = [];
  for (const c of creditors) {
    if (left <= 0) break;
    const amount = Math.min(left, c.net);
    const debit = await env.DB.prepare('UPDATE num_star_balances SET stars = stars - ?2 WHERE member_id = ?1 AND stars >= ?2').bind(meId, amount).run();
    if (!debit.meta?.changes) {
      const bal = await env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1').bind(meId).first();
      return json({ error: `Not enough Stars — you have ★${bal?.stars ?? 0} and owe ★${-mine.net}.`, balance: bal?.stars ?? 0 }, 409);
    }
    // The credit, the two ledger lines and the settlement record go together:
    // the debit above has already happened, so anything that fails here would
    // take Stars off somebody and give them to nobody. Move ids are unique per
    // settlement — a fixed id would make a legitimate second settlement (more
    // rounds arrived after the first) collide and strand the debit.
    const ref = uid('stl');
    await env.DB.batch([
      env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(c.member_id, amount),
      env.DB.prepare("INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'tab',?4,?5)")
        .bind(`${ref}:out`, meId, -amount, state.tab.title, c.member_id),
      env.DB.prepare("INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'tab',?4,?5)")
        .bind(`${ref}:in`, c.member_id, amount, state.tab.title, meId),
      env.DB.prepare('INSERT INTO num_tab_settlements (id, tab_id, from_id, to_id, stars) VALUES (?1,?2,?3,?4,?5)')
        .bind(ref, state.tab.id, meId, c.member_id, amount),
    ]);
    paid.push({ to: c.name, stars: amount });
    left -= amount;
  }
  await env.DB.prepare("UPDATE num_tab_members SET settled_at=datetime('now') WHERE tab_id=?1 AND member_id=?2").bind(state.tab.id, meId).run();
  await notifyTab(env, state.tab, meId, `${mine.name || 'Someone'} settled up.`);
  return json({ ok: true, paid, ...(await tabState(env, state.tab.id)) });
}

async function tabClose(env, req) {
  const b = await readBody(req);
  const tab = await env.DB.prepare('SELECT * FROM num_tabs WHERE id=?1').bind(clip(b.tab_id, 40) ?? '').first();
  if (!tab) return json({ error: 'no such tab' }, 404);
  if (tab.owner_id !== clip(b.me, 40)) return json({ error: 'only whoever opened it can close it' }, 403);
  await env.DB.prepare("UPDATE num_tabs SET state='closed', closed_at=datetime('now') WHERE id=?1").bind(tab.id).run();
  return json(await tabState(env, tab.id));
}

async function notifyTab(env, tab, byId, line) {
  try {
    const { results } = await env.DB.prepare('SELECT member_id FROM num_tab_members WHERE tab_id=?1 AND member_id <> ?2').bind(tab.id, byId).all();
    await Promise.all(
      (results ?? []).map((m) =>
        notify(env, { memberId: m.member_id, kind: 'tab', title: tab.title, body: line, url: '/?app', tag: `tab:${tab.id}` }),
      ),
    );
  } catch (err) {
    console.warn('[tab-notify]', err?.message ?? err);
  }
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
    `SELECT g.token, g.rsvp, g.via, e.id AS event_id, e.title, e.day, e.time, e.place, e.slug, m.name AS host_name
       FROM num_event_guests g JOIN num_events e ON e.id=g.event_id
       LEFT JOIN num_members m ON m.id = e.host_id
      WHERE (g.member_id = ?1 OR (?2 IS NOT NULL AND g.phone = ?2)) AND g.rsvp='pending' AND e.state='open'
      ORDER BY g.invited_at DESC LIMIT 10`,
  ).bind(meId, me.phone).all();

  return json({
    connects: connects ?? [],
    plans: plans ?? [],
    // `via: 'agent'` is the flag the app reads to say "their Num asked yours"
    // rather than "you were sent a link" — same row, different sentence.
    events: (events ?? []).map((e) => ({ ...e, via: e.via ?? 'link' })),
  });
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

    // It has to actually be theirs. This used to stamp `member_id = meId` on
    // whatever token was passed, so any member who came by a token — the host
    // who minted it, most obviously — could answer on the invitee's behalf and
    // then own the row. Positive check only: yours if it names you, or was
    // addressed to your number.
    const mine = (g.member_id && g.member_id === meId) || (g.phone && self.phone && g.phone === self.phone);
    if (!mine) return json({ error: 'not your invite' }, 403);

    const rsvp = action === 'accept' ? 'yes' : action === 'decline' ? 'no' : 'maybe';
    // Same path the member's own Num uses — so the host is told, and a plan
    // behind the event hears about it, whichever door the answer came through.
    const out = await answerEventInvite(env, {
      guest: g,
      rsvp,
      name: g.name ?? self.name,
      message: clip(b.message, 300),
      memberId: meId,
    });
    return out.error ? json({ error: out.error }, out.status ?? 400) : json({ ok: true, rsvp: out.rsvp, posted: out.line });
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
 * Who is on a reservation.
 *
 * Three things this has to get right, and each is a real-world failure:
 *
 *   · A guest need not be a Num member. Half of any dinner table is not on
 *     the app, and refusing to count them makes the party size wrong — which
 *     is the number the restaurant actually holds seats against.
 *   · Saying no removes a seat. party_size counts everyone who has not said
 *     "out", because a table held for six that four people turn up to is how
 *     a venue learns to stop trusting you.
 *   · Anyone on the plan may add a guest, but only that guest — or whoever
 *     added them — may change their answer. Otherwise one member can mark
 *     another as not coming and somebody quietly misses dinner.
 */
async function itemAttendees(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const itemId = clip(b.item_id, 40);
  if (!meId || !itemId) return json({ error: 'me and item_id are required' }, 400);

  const item = await env.DB.prepare('SELECT id, plan_id, title FROM num_plan_items WHERE id=?1').bind(itemId).first();
  if (!item) return json({ error: 'no such reservation' }, 404);
  const mem = await memberOf(env, item.plan_id, meId);
  if (!mem) return json({ error: 'not your plan' }, 403);

  const name = clip(b.name, 60);
  const action = b.remove ? 'remove' : b.rsvp ? 'rsvp' : 'add';
  if (!name) return json({ error: 'Who is coming? Give a name.' }, 400);

  if (action === 'add') {
    await env.DB.prepare(
      `INSERT INTO num_item_attendees (item_id, member_id, name, rsvp, added_by) VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT(item_id, name) DO UPDATE SET member_id=COALESCE(excluded.member_id, member_id)`,
    ).bind(itemId, clip(b.member_id, 40), name, 'going', meId).run();
  } else if (action === 'rsvp') {
    const rsvp = ['going', 'maybe', 'out'].includes(b.rsvp) ? b.rsvp : 'going';
    const row = await env.DB.prepare('SELECT member_id, added_by FROM num_item_attendees WHERE item_id=?1 AND name=?2')
      .bind(itemId, name).first();
    if (!row) return json({ error: 'They are not on this one.' }, 404);
    // A Num member owns their own answer outright — being the person who
    // added them to the table does not grant the right to answer for them.
    // For a plain-name guest there is nobody else who CAN answer, so whoever
    // added them speaks for them.
    const theirs = row.member_id ? row.member_id === meId : row.added_by === meId;
    if (!theirs) {
      return json(
        { error: row.member_id ? 'Only they can change their own answer.' : 'Only whoever added them can answer for them.' },
        403,
      );
    }
    await env.DB.prepare('UPDATE num_item_attendees SET rsvp=?3 WHERE item_id=?1 AND name=?2').bind(itemId, name, rsvp).run();
  } else {
    await env.DB.prepare('DELETE FROM num_item_attendees WHERE item_id=?1 AND name=?2').bind(itemId, name).run();
  }

  const { results } = await env.DB.prepare('SELECT member_id, name, rsvp FROM num_item_attendees WHERE item_id=?1').bind(itemId).all();
  const attendees = results ?? [];
  const party = attendees.filter((a) => a.rsvp !== 'out').length;

  // Narrated into the plan so every other member's agent picks it up on their
  // next sync. A party size that changes silently is the whole problem.
  await event(
    env,
    item.plan_id,
    { id: meId, name: mem.name },
    'attendees',
    action === 'add'
      ? `${name} is on ${item.title} — ${party} going.`
      : action === 'remove'
        ? `${name} is off ${item.title} — ${party} going.`
        : `${name} is ${b.rsvp} for ${item.title} — ${party} going.`,
    { item_id: itemId, party_size: party },
  ).catch(() => null);

  return json({ ok: true, attendees, party_size: party });
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
  const { results: members } = await env.DB.prepare('SELECT member_id, name, role, vote FROM num_plan_members WHERE plan_id=?1').bind(id).all();
  const { results: items } = await env.DB.prepare('SELECT * FROM num_plan_items WHERE plan_id=?1 ORDER BY day IS NULL, day, time').bind(id).all();
  const { results: events } = await env.DB.prepare(
    'SELECT id, ts, by_id, by_name, kind, summary FROM num_plan_events WHERE plan_id=?1 AND id > ?2 ORDER BY id LIMIT 50',
  ).bind(id, since).all();

  // One query for every attendee on the plan, grouped in memory. A per-item
  // query would be N round trips for a list that is almost always tiny.
  const { results: guests } = await env.DB.prepare(
    `SELECT a.item_id, a.member_id, a.name, a.rsvp FROM num_item_attendees a
       JOIN num_plan_items i ON i.id = a.item_id
      WHERE i.plan_id = ?1`,
  ).bind(id).all().catch(() => ({ results: [] }));
  const byItem = new Map();
  for (const g of guests ?? []) {
    if (!byItem.has(g.item_id)) byItem.set(g.item_id, []);
    byItem.get(g.item_id).push({ member_id: g.member_id, name: g.name, rsvp: g.rsvp });
  }

  return json({
    plan,
    members: members ?? [],
    items: (items ?? []).map((i) => {
      const attendees = byItem.get(i.id) ?? [];
      return {
        ...i,
        attendees,
        // The number that matters to a restaurant. Anyone who has said no is
        // not a seat, and a booking held for a party that shrank is the most
        // common way a table gets given away.
        party_size: attendees.filter((a) => a.rsvp !== 'out').length,
      };
    }),
    // Historically your own events were filtered out, because the only consumer
    // was narration ("what did the OTHERS do"). A chat thread must show your
    // own messages, so clients that render the feed ask for them with self=1.
    // The old filter stays as the default so pre-chat clients (≤0.8.78, still
    // cached in service workers for a while) don't suddenly narrate the user's
    // own actions back at them.
    events: url.searchParams.get('self') === '1'
      ? (events ?? [])
      : (events ?? []).filter((e) => e.by_id !== meId),
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

/**
 * A member says something to the group, in their own words.
 *
 * Deliberately a plan EVENT (kind='comment') rather than a new table: the plan
 * already has one ordered feed that every member polls, pushes on, and renders
 * — a second timeline for humans would mean two cursors, two notify paths, and
 * a merge bug the first time someone books mid-conversation. Comments and
 * system events interleave in the order they happened, which is what a group
 * chat is.
 *
 * event() pushes to every member EXCEPT the author (see its member query), so
 * commenting never buzzes your own phone.
 */
async function planComment(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const planId = clip(b.plan_id, 40);
  const text = String(b.text ?? '').trim().slice(0, 280);
  if (!meId || !planId) return json({ error: 'me and plan_id required' }, 400);
  if (!text) return json({ error: 'say something' }, 400);
  const self = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(meId).first();
  if (!self) return json({ error: 'sign up first' }, 404);
  if (!(await memberOf(env, planId, meId))) return json({ error: 'not your plan' }, 403);
  await event(env, planId, { id: meId, name: self.name }, 'comment', text);
  return json({ ok: true });
}

/**
 * Approve or bow out of the plan as a whole. Not the same thing as a
 * reservation RSVP (num_item_attendees) — this is "are you in on this trip",
 * asked once per member per plan, changeable until the group books.
 */
async function planVote(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const planId = clip(b.plan_id, 40);
  const vote = b.vote === 'in' ? 'in' : b.vote === 'out' ? 'out' : null;
  if (!meId || !planId || !vote) return json({ error: 'me, plan_id and vote (in|out) required' }, 400);
  const self = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(meId).first();
  if (!self) return json({ error: 'sign up first' }, 404);
  if (!(await memberOf(env, planId, meId))) return json({ error: 'not your plan' }, 403);
  await env.DB.prepare('UPDATE num_plan_members SET vote=?1 WHERE plan_id=?2 AND member_id=?3')
    .bind(vote, planId, meId).run();
  await event(env, planId, { id: meId, name: self.name }, 'vote',
    vote === 'in' ? `${self.name || 'Someone'} is in ✓` : `${self.name || 'Someone'} can't make it`);
  return json({ ok: true, vote });
}

/**
 * Which of these phone numbers already belong to Num members — so an invite
 * flow can say "on Num already, connects instantly" vs "send them a text".
 *
 * Guardrails, because a phone→membership oracle invites enumeration: caller
 * must be a member, at most 20 numbers per call, and the answer is a bare
 * boolean per phone — no names, no member ids, no profile data. Names are
 * only ever revealed by the person themselves accepting a connect.
 */
async function lookupPhones(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  if (!meId) return json({ error: 'me required' }, 400);
  const self = await env.DB.prepare('SELECT id FROM num_members WHERE id=?1').bind(meId).first();
  if (!self) return json({ error: 'sign up first' }, 404);
  const phones = (Array.isArray(b.phones) ? b.phones : []).slice(0, 20)
    .map((p) => String(p ?? '').replace(/[^0-9+]/g, '')).filter((p) => p.length >= 7);
  if (!phones.length) return json({ results: [] });
  const marks = phones.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await env.DB.prepare(
    `SELECT phone FROM num_members WHERE phone IN (${marks})`,
  ).bind(...phones).all();
  const on = new Set((results ?? []).map((r) => r.phone));
  return json({ results: phones.map((p) => ({ phone: p, on_num: on.has(p) })) });
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
  if (path === '/connect' && post) return await connect(env, request);
  if (path === '/verify/5arz' && post) return await verifyVia5arz(env, request);
  if (path === '/friends') return await friends(env, url);
  if (path === '/prefs' && post) return await prefsWrite(env, request);
  if (path === '/prefs') return await prefsRead(env, url);
  if (path === '/requests') return await requests(env, url);
  if (path === '/who') return await who(env, url);
  if (path === '/stars') return await stars(env, url);
  if (path === '/tab' && post) return await tabWrite(env, request);
  if (path === '/tab') {
    const st = await tabState(env, url.searchParams.get('id') ?? '');
    return st ? json(st) : json({ error: 'no such tab' }, 404);
  }
  if (path === '/tab/join' && post) return await tabJoin(env, request);
  if (path === '/tab/item' && post) return await tabItem(env, request);
  if (path === '/tab/settle' && post) return await tabSettle(env, request);
  if (path === '/tab/close' && post) return await tabClose(env, request);
  if (path === '/pay' && post) return await pay(env, request);
  if (path === '/respond' && post) return await respond(env, request);
  if (path === '/plans') return await planList(env, url);
  if (path === '/plan' && post) return await planWrite(env, request);
  if (path === '/plan') return await planRead(env, url);
  if (path === '/plan/item' && post) return await planItem(env, request);
  if (path === '/plan/item/attendees' && post) return await itemAttendees(env, request);
  if (path === '/plan/join' && post) return await planJoin(env, request);
  if (path === '/plan/comment' && post) return await planComment(env, request);
  if (path === '/plan/vote' && post) return await planVote(env, request);
  if (path === '/lookup' && post) return await lookupPhones(env, request);
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
