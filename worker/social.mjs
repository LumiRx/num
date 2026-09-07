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
import { generateCode, hashCode, safeEqual, normalisePhone, normaliseMobile, uid, sendCode, verifyConfigured, verifySend, verifyCheck } from '../claim/verify.mjs';
import { notify } from './push.mjs';
import { isBlocked } from './account.mjs';
import { answerEventInvite } from './events.mjs';
import { INVITE_POLICIES, DEFAULT_INVITE_POLICY, ensurePermissions, memberPolicy, setInvitePolicy } from './permissions.mjs';
import { markReferralEarned } from './referral.mjs';
import { logSignin } from './signinlog.mjs';
import { verifyAppleToken } from './appleauth.mjs';
// NUM texts the friend the plan — the member's own phone stays the default,
// this is the one-tap alternative. See worker/friendtext.mjs for the rules.
import { handleTextInvite, textingAvailable, textPlanUpdate } from './friendtext.mjs';

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
  // Group intelligence consent. Sharing your diet with a PLAN is a different
  // act from telling Num — default off, flipped per-plan by its owner… no.
  // Flipped by the MEMBER, per plan, because it is their information.
  'ALTER TABLE num_plan_members ADD COLUMN share_prefs INTEGER NOT NULL DEFAULT 0',
  // First-touch ad attribution — which ad brought this member. Written once
  // at signup, never overwritten: re-attribution on every visit makes every
  // campaign's numbers bleed into the most recent click.
  'ALTER TABLE num_members ADD COLUMN utm_source TEXT',
  'ALTER TABLE num_members ADD COLUMN utm_medium TEXT',
  'ALTER TABLE num_members ADD COLUMN utm_campaign TEXT',
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
CREATE TABLE IF NOT EXISTS num_plans (id TEXT PRIMARY KEY, title TEXT NOT NULL, dest TEXT, owner_id TEXT NOT NULL, starts_on TEXT, starts_time TEXT, state TEXT NOT NULL DEFAULT 'planning', join_code TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
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
CREATE TABLE IF NOT EXISTS num_plan_item_votes (item_id TEXT NOT NULL, member_id TEXT NOT NULL, vote TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (item_id, member_id));
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
  // The friends who are NOT on Num yet — texted only if they wrote back,
  // never more than once per six hours per plan. worker/friendtext.mjs.
  try {
    await textPlanUpdate(env, { planId, kind, summary, byName: by?.name });
  } catch (err) {
    console.warn('[plan-text]', err?.message ?? err);
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

// ── App Review access ─────────────────────────────────────────────────────

/**
 * ONE account, ONE code, ONE expiry date — and none of the three are in this
 * file.
 *
 * Why this exists. Num has exactly one way in: a name and a phone number, and
 * the number is proved by an SMS code. There is no email, no password, no
 * social login — `review@itsnum.com` is a mailbox, not a credential, and
 * nothing in the app has ever accepted one. So an App Review reviewer opening
 * a fresh install has the same problem a member with a new phone has, and
 * since A2P 10DLC is unregistered every SMS we hand Twilio comes back 30034.
 * The recovery branch above fails closed on exactly that, which is correct for
 * a stranger holding somebody's number and fatal for the one person Apple
 * sends to check the app works.
 *
 * So the reviewer gets a code that does not travel by SMS. It travels in the
 * App Review Information panel of App Store Connect, which is the same place
 * Apple already expects the demo password to live.
 *
 * What keeps this from being a back door:
 *
 *   · It is not a bypass of `/verify`. It is a second *source* for the one
 *     code `/verify` already demands. `/me` still returns no member ID, and
 *     the ID is still released only by `/verify`, still only against a code.
 *   · It is bound to one phone number, given as a Worker secret. A caller
 *     cannot steer it: the number is compared to the grant, never taken from
 *     the request, so presenting the reviewer code against anybody else's
 *     number matches nothing and falls through to the ordinary path.
 *   · It can be pinned harder still — set `REVIEW_DEMO_MEMBER` to the demo
 *     account's id and a match on the number alone is not enough.
 *   · Reading this source tells an attacker the mechanism and nothing usable.
 *     The phone, the code and the deadline are secrets; without all three the
 *     function below returns null and the branches never run.
 *   · It expires by wall clock, not by anybody remembering. `REVIEW_ACCESS_UNTIL`
 *     in the past is the same as no grant at all.
 *   · It is revoked in one command — delete any one of the secrets.
 *   · A short code is refused rather than accepted: a mistyped 6-digit secret
 *     would be a guessable password on a known account, so anything under
 *     REVIEW_MIN_CODE_LEN turns the grant OFF instead of weakening it.
 *   · Every use — offered, wrong, capped, granted — writes a row to
 *     `num_identity_signals`, so "did anyone use this, and when" is a query.
 *
 * Against the SEC-001 threat model: the attacker there needs only a phone
 * number that exists on Num, and gets a member ID for it. This grant gives an
 * attacker who has read every line of the repo nothing at all for any number
 * except one we chose, and for that one only if they also hold a secret that
 * lives in App Store Connect. It does not widen SEC-001 (an ID is still a
 * credential — that is Phase 0+1 of the capability work, not this), and it
 * does not reopen SEC-006: no unverified number gets its account handed back
 * without a code, and the code for 124 of 125 members still has to arrive by
 * SMS.
 *
 * DEFAULT: OFF. `wrangler.app.jsonc` sets none of these.
 */
/**
 * Where the person actually is, for turning a bare national number into E.164.
 *
 * Cloudflare gives us `CF-IPCountry` on every request. That is a fact about the
 * connection rather than a guess about the number, which is the distinction
 * that matters: a bare `4437079219` is a Maryland mobile if you are in the US
 * and nothing at all if you are in Bangkok, and inventing the difference is how
 * you text a stranger on another continent.
 *
 * `XX` is Cloudflare's value for "unknown", and `T1` is Tor. Both become
 * undefined, which makes normalisePhone refuse the number rather than guess —
 * the person is then asked for the country code, which is a recoverable
 * inconvenience instead of an unrecoverable wrong number.
 */
function regionOf(req) {
  const cc = req?.headers?.get?.('CF-IPCountry');
  if (!cc || cc === 'XX' || cc === 'T1') return undefined;
  return cc.toUpperCase();
}

const REVIEW_MIN_CODE_LEN = 8;

function reviewerGrant(env) {
  const phone = normalisePhone(env?.REVIEW_DEMO_PHONE);
  const code = typeof env?.REVIEW_DEMO_CODE === 'string' ? env.REVIEW_DEMO_CODE.trim() : '';
  const until = typeof env?.REVIEW_ACCESS_UNTIL === 'string' ? env.REVIEW_ACCESS_UNTIL.trim() : '';
  // All three, or nothing. Two of three is a half-configured door and it stays shut.
  if (!phone || !code || !until) return null;
  if (code.length < REVIEW_MIN_CODE_LEN) return null;
  const expires = Date.parse(until);
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  return { phone, code, expires, member: clip(env?.REVIEW_DEMO_MEMBER, 40) || null };
}

/**
 * The grant, but only for the number it names — and only for the member it
 * names, when it names one. Returns null for everybody else, which is what
 * makes this one account rather than a mode.
 */
function reviewerFor(env, phone, memberId) {
  const g = reviewerGrant(env);
  if (!g) return null;
  const p = normalisePhone(phone);
  if (!p || p !== g.phone) return null;
  if (g.member && memberId && g.member !== memberId) return null;
  return g;
}

/** Every touch of the grant, kept. An unused door and an abused one must not look alike. */
async function auditReview(env, { stage, outcome, memberId, req }) {
  try {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO num_identity_signals (member_id, device_id, ip_hash, ua_hash, country) VALUES (?1,?2,?3,?4,?5)',
    ).bind(
      `review:${stage}:${outcome}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      memberId ?? null,
      req ? await sha12(req.headers.get('CF-Connecting-IP') ?? '') : null,
      `review-grant:${stage}:${outcome}`,
      req?.headers.get('CF-IPCountry') ?? null,
    ).run();
  } catch (err) {
    console.warn('[review] audit failed', err?.message ?? err);
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
  const region = regionOf(req);
  const phone = normaliseMobile(b.phone, region);
  // A number without a country code is unusable: it cannot be texted, it
  // cannot be matched against another member, and it silently becomes a
  // different number in another country. normalisePhone keeps the digits
  // either way, so without this check it SAVED and then failed at every
  // later step, which is far worse than refusing it here.
  //
  // `normaliseMobile`, not `normalisePhone`, since 2 Sep 2026: this number is
  // about to be TEXTED. The first real campaign arrival who tried to sign in
  // had `+44 991…` stored — a bare Indian-looking mobile with the UK code
  // put on it because that is where he was standing. Twilio said 60200 and
  // he never saw a code. The sentence below is written for him: it names
  // the country we guessed, so he can see the guess and correct it.
  if (b.phone && (!phone || !phone.startsWith('+'))) {
    const looksInternational = String(b.phone).trim().startsWith('+');
    const guessed = region && !looksInternational
      ? ` I read it as a ${region} number — if your phone is from somewhere else, start with its country code (like +91, +1 or +44).`
      : ' Start it with + and your country code (like +1, +44 or +66).';
    return json({ error: `That doesn’t look like a mobile number I can text.${guessed}`, bad_phone: true }, 400);
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

    // APP REVIEW ACCESS. The reviewer is in exactly the position this branch
    // refuses to serve — a fresh install, holding a number that is already on
    // an account, with no way to receive the text that would prove it. So for
    // the ONE number named by the grant (and nobody else, ever) we say the
    // same 202 the genuine recovery says, and let /verify judge the code. The
    // code just came from App Store Connect instead of from Twilio.
    //
    // Note where this sits: BEFORE the phone_verified test, deliberately. The
    // store checklist says the demo number must be verified, and a verified
    // number closes the recovery branch for good — which would lock the
    // reviewer out on their second device, having done everything right.
    //
    // Note what it does NOT contain: no me, no id, no ref, no link. Identical
    // in that respect to the branch below it.
    const reviewGrant = reviewerFor(env, phone, holder.id);
    if (reviewGrant) {
      await auditReview(env, { stage: 'me', outcome: 'code_pending', memberId: holder.id, req });
      return json({
        recovery: 'code_sent',
        recovered: false,
        phone: holder.phone,
        verification: { sent: false, channel: 'review', note: 'Enter the sign-in code from App Store Connect.' },
        next: 'POST /api/social/verify with { phone, code } to finish signing in.',
      }, 202);
    }

    // RECOVERY. If the number on the existing account was never verified, get
    // that account back to whoever OWNS THE NUMBER — proved by a code sent to
    // it — rather than locking them out and rather than handing it to whoever
    // typed the number.
    //
    // The account is still recoverable without the old device. What is no
    // longer true is that recovery is free. Two things used to make this the
    // cheapest full account takeover in the codebase (SEC-006 × SEC-001):
    //
    //   · `verify: false` — a caller-supplied flag — suppressed the SMS. So
    //     the branch could be walked in complete silence: the real owner was
    //     never told their account had been handed over.
    //   · The response returned `me.id`. That ID is the credential on every
    //     other route in this file and in pay.mjs, dm.mjs and account.mjs —
    //     Stars, tab settlement, DMs, deletion. Returning it to an
    //     unauthenticated caller IS the takeover; nothing else was needed.
    //
    // So: the flag is ignored here (it is honoured only for a NEW number,
    // below, where there is no account to take over), the text always goes,
    // and the ID is released by /verify against the code — never by this
    // route. Genuine recovery is one extra step and unchanged in spirit:
    // POST /me → read the SMS → POST /verify { phone, code } → you are in.
    //
    // ── A VERIFIED NUMBER USED TO BE SHUT, AND THAT WAS BACKWARDS ────────
    //
    // This branch read `if (!holder.phone_verified)`: an UNVERIFIED number
    // could be recovered with a code, a VERIFIED one could not. It was
    // written as anti-takeover hardening and it inverted the property it was
    // protecting.
    //
    // An unverified number is a CLAIM — nobody has ever proved they hold it.
    // A verified number is PROVEN — we know for a fact that an SMS to it
    // reaches the person who owns the account. The second is the stronger
    // case for allowing recovery, not the weaker one.
    //
    // What protects this branch was never the refusal. It is that the code
    // goes to the number ALREADY ON FILE (never one the caller typed), and
    // that `/me` releases no identity at all — the member id comes back only
    // from `/verify`, only against that code. Refusing verified numbers added
    // nothing on top of that; it only meant the more thoroughly somebody
    // proved they owned their number, the more permanently they were locked
    // out of it.
    //
    // The lived cost: verify your number, then change or wipe your phone, and
    // Num answered "Sign in from the device that has it." That device is
    // exactly the thing you no longer have — the single most common reason
    // anybody needs to sign in again — and there was no other way in.
    //
    // Recovery now runs for any number on file. The real owner is still told
    // either way: the code lands on their handset, which is the standard
    // signal that somebody is trying to get into their account.
    {
      // No write before proof. The old code wrote the CALLER's name onto the
      // account first, which defaced a stranger's profile even when the rest
      // of the branch failed.
      // THROTTLED, not skipped. A refusal here still means a code is in
      // flight — one went out less than a minute ago — so the person belongs
      // on the code screen, not on an error. Returning `sent: false` with the
      // gate's own sentence keeps the contract this branch promises (a 202
      // carrying `recovery: 'code_sent'`, never an id) while telling the truth
      // about what just happened.
      const refuse = await sendGate(env, holder.id);
      const verification = refuse
        ? { sent: false, throttled: true, note: refuse.error, retry_after_sec: refuse.retry_after_sec }
        : await issueCode(env, holder.id, holder.phone);
      if (!verification.sent && !refuse) {
        // Fail closed. We could not reach the owner, so we cannot tell them
        // this is happening, so we do not act on it. `flagCollision` above
        // already recorded the attempt either way.
        return json({
          error: 'That number is already on Num, and I can’t text a code to it right now. Message us and we’ll get you back in.',
          number_taken: true,
          recovery: 'unavailable',
          verification,
        }, 503);
      }
      return json({
        recovery: 'code_sent',
        recovered: false,
        phone: holder.phone,
        verification,
        next: 'POST /api/social/verify with { phone, code } to finish signing in.',
      }, 202);
    }

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
  // First-touch attribution, first write wins. COALESCE keeps the original:
  // a member who signs up from the Instagram ad and later opens a YouTube
  // link stays Instagram's conversion, which is the only honest ledger for
  // deciding where the next ad dollar goes.
  const utm = b.utm && typeof b.utm === 'object' ? b.utm : null;
  if (utm?.source) {
    writes.push(env.DB.prepare(
      `UPDATE num_members SET utm_source=COALESCE(utm_source,?2), utm_medium=COALESCE(utm_medium,?3), utm_campaign=COALESCE(utm_campaign,?4) WHERE id=?1`,
    ).bind(id, clip(utm.source, 60), clip(utm.medium, 60), clip(utm.campaign, 80)));
  }
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
    verification = await issueCode(env, id, phone);
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

/**
 * Mint a code, text it, and store the hash — the one place that does this.
 *
 * It exists as a function because it used to be inline in the signup path and
 * nowhere else, which meant a person got exactly ONE chance at a code, ever.
 * If that first text failed, or arrived late, or they closed the app before
 * typing it, they were permanently unable to verify: coming back hit the
 * recovery branch, which returned "welcome back" and silently sent nothing,
 * and no other route could issue one. Sharing this between signup, recovery
 * and resend is what makes "I didn't get the code" a solvable situation.
 *
 * The hash is only written when the send actually succeeded. A stored hash for
 * a text that never arrived is a member who can never verify and whose retry
 * gets told a code is already pending.
 */
async function issueCode(env, id, phone) {
  // TWILIO VERIFY FIRST, when it is configured.
  //
  // Verify traffic is exempt from A2P 10DLC, which is the only reason a code
  // can arrive at all today — every send through Programmable Messaging comes
  // back 30034 from the carrier. Verify owns the code, its expiry and its rate
  // limits, so there is nothing to store here: the check goes back to Twilio
  // rather than to our own `code_hash`.
  //
  // Falls through to the old path when VERIFY_SERVICE_SID is unset, so this is
  // safe to deploy before the Twilio service exists.
  if (verifyConfigured(env)) {
    const v = await verifySend(env, phone);
    // Logged BOTH ways. A code never sent and a code sent-but-never-entered are
    // opposite problems fixed by different people, and until this line they
    // were indistinguishable from outside — see worker/signinlog.mjs for the
    // seven weeks that cost.
    if (!v.ok) {
      await logSignin(env, { memberId: id, stage: 'send', outcome: 'failed', reason: v.code, via: 'verify' });
      return { sent: false, reason: v.code, note: v.error };
    }
    await logSignin(env, { memberId: id, stage: 'send', outcome: 'ok', via: 'verify' });
    // Clear any legacy pending code so a stale one cannot be used to sign in
    // alongside the Verify one. Belt and braces during the cutover.
    //
    // `code_sid` KEEPS THE VERIFICATION SID (VE…). Verify has no
    // StatusCallback: it answers `pending` and then never mentions the message
    // again, so the only way to learn whether a phone actually buzzed is to go
    // back and ASK, per verification, via the Attempts API. Storing the sid is
    // what makes that possible — see worker/verifydiag.mjs. Without it, `ok`
    // above means "Twilio accepted the request" and nothing more, which is
    // exactly how a signup on 30 Aug 2026 recorded a successful send for a
    // text that never existed.
    await env.DB.prepare('ALTER TABLE num_members ADD COLUMN code_sid TEXT').run().catch(() => {});
    await env.DB.prepare(
      'UPDATE num_members SET code_hash=NULL, code_salt=NULL, code_expires=NULL, attempts=0, code_sid=?2 WHERE id=?1',
    ).bind(id, v.sid ?? null).run().catch(() => {});
    return { sent: true, channel: 'sms', via: 'verify', expires_in_min: 10 };
  }

  const code = generateCode();
  const salt = crypto.randomUUID();
  const out = await sendCode(env, { channel: 'sms', to: phone, code, businessName: 'NUM' });
  if (!out.ok) {
    await logSignin(env, { memberId: id, stage: 'send', outcome: 'failed', reason: out.error, via: 'sms' });
    // Honest failure: the number is on file so invites and links still work,
    // but we never claim a verification we did not get. While A2P 10DLC is
    // unapproved every send lands here.
    return { sent: false, reason: out.error, note: 'Number saved, but not verified — SMS is not switched on yet.' };
  }
  // code_sid ties this pending code to the message carrying it, so a delivery
  // failure can retract exactly this code and nothing newer. Added by
  // migration; rows written before it simply have a null sid and are never
  // auto-retracted, which is the safe direction to be wrong in.
  await env.DB.prepare('ALTER TABLE num_members ADD COLUMN code_sid TEXT').run().catch(() => {});
  await env.DB.prepare(
    'UPDATE num_members SET code_hash=?2, code_salt=?3, code_expires=?4, attempts=0, code_sid=?5 WHERE id=?1',
  ).bind(id, await hashCode(code, salt), salt, new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString(), out.sid ?? null).run();
  await logSignin(env, { memberId: id, stage: 'send', outcome: 'ok', via: 'sms' });
  return { sent: true, channel: 'sms', expires_in_min: CODE_TTL_MIN };
}

/**
 * "Send it again." The single most common thing that happens in any phone
 * verification flow, and until now the only flow with no answer to it.
 *
 * Cooled down rather than hard-limited: each resend costs us a message and an
 * unthrottled endpoint is a way to spend our Twilio balance on someone else's
 * afternoon. A cooldown says "not yet" to a button masher without locking out
 * a person whose first text genuinely never came.
 *
 * ── THE COOLDOWN USED TO BE DEAD CODE ────────────────────────────────────
 *
 * It read the cooldown off `code_expires`, which only the Programmable
 * Messaging path writes. On the Twilio Verify path — the one every sign-in
 * has actually used since Verify was switched on — `issueCode` NULLs that
 * column on purpose, because Verify owns the code and its expiry. So the
 * whole block was skipped, and the rate limit that existed on paper did not
 * exist in production: one held button was an unbounded row of paid messages
 * until Twilio's own 60203 stopped it, at which point the person who genuinely
 * never got a code was locked out for ten minutes by their own impatience.
 *
 * It now measures from `num_signin_events`, which BOTH paths write and which
 * exists for exactly this reason — knowing what happened without inferring it
 * from a side effect. Computed in SQL rather than JS: `datetime('now')` has no
 * timezone marker, and `new Date('2026-08-30 22:15:04')` is parsed as local
 * time by V8, so a machine that is not on UTC would silently mis-measure every
 * cooldown it enforced.
 */
const RESEND_COOLDOWN_SEC = 60;

/**
 * A ceiling as well as a cooldown. The cooldown alone permits 60 messages an
 * hour to one number, which is a bill and a Fraud Guard trip rather than a
 * person who needs help. Five is more than anybody legitimately needs and less
 * than Twilio's own per-number limit, so we say "no" in our own words before
 * Twilio says it in a 60203 nobody can read.
 */
const RESEND_MAX_PER_HOUR = 5;

/**
 * May we spend another text on this member right now?
 *
 * Shared by `/resend` and by the RECOVERY branch of `/me`, because both mint a
 * code and only one of them was ever throttled. Recovery takes a bare phone
 * number from an unauthenticated caller and sends a paid SMS to whoever owns
 * it — so anybody holding a Num member's number could text them on a loop, at
 * our expense, and the only thing that would eventually stop it was Twilio's
 * own 60203, which then locks the real owner out for ten minutes. Capping the
 * button while leaving that open would have been theatre.
 *
 * Returns null when clear, or the refusal to hand back. Never throws: a gate
 * that fails open on a D1 hiccup is better than a sign-in that dies on one.
 */
async function sendGate(env, memberId) {
  // ONLY SUCCESSFUL SENDS COOL ANYTHING DOWN.
  //
  // The first cut counted every `send` row whatever its outcome, which meant a
  // send that FAILED — no provider, a 400 from Twilio, a number the carrier
  // refuses — locked the person out for a minute and told them "a code is on
  // its way". Nothing was on its way. That is the same lie this whole change
  // exists to delete, rebuilt one layer up, and the takeover suite caught it
  // within a minute of the gate being shared: its victims sign up with SMS
  // deliberately broken, so every one of them was born throttled.
  //
  // It is also the right rule on cost, which is what the cap is for: a message
  // that never left is a message nobody paid for.
  const gate = await env.DB.prepare(
    `SELECT
       (SELECT strftime('%s','now') - strftime('%s', ts) FROM num_signin_events
          WHERE member_id=?1 AND stage='send' AND outcome='ok' ORDER BY id DESC LIMIT 1) AS last_send_sec,
       (SELECT COUNT(*) FROM num_signin_events
          WHERE member_id=?1 AND stage='send' AND outcome='ok' AND ts > datetime('now','-1 hour')) AS sends_hour`,
  ).bind(memberId).first().catch(() => null);

  const sinceLast = Number(gate?.last_send_sec ?? Number.POSITIVE_INFINITY);
  if (Number.isFinite(sinceLast) && sinceLast < RESEND_COOLDOWN_SEC) {
    return {
      error: 'A code is on its way — give it a moment before asking for another.',
      retry_after_sec: Math.max(1, RESEND_COOLDOWN_SEC - sinceLast),
    };
  }
  if (Number(gate?.sends_hour ?? 0) >= RESEND_MAX_PER_HOUR) {
    return {
      error: 'That\u2019s as many codes as I can send to one number in an hour. If none of them arrived, the problem is not the button — message us and we will sort it by hand.',
      retry_after_sec: 3600,
      capped: true,
    };
  }
  return null;
}

async function resendCode(env, req) {
  const b = await readBody(req);

  // TWO WAYS IN, because the people most likely to need a resend have no
  // member id to send us. Recovery deliberately withholds it — `/me` answers
  // 202 with no id and the id is released only by `/verify` against a code
  // (SEC-001). So an id-only resend endpoint failed exactly the person staring
  // at a code box that never filled.
  //
  // Resending by number is not a new exposure: it is precisely what `/me`
  // already does, to the number ALREADY ON FILE, releasing nothing. Nobody
  // learns anything from this endpoint they could not learn from that one.
  const id = clip(b.id, 40);
  const phone = id ? null : normalisePhone(b.phone, regionOf(req));
  const row = id
    ? await env.DB.prepare('SELECT id, phone, phone_verified, code_sid FROM num_members WHERE id=?1').bind(id).first()
    : phone
      ? await env.DB.prepare('SELECT id, phone, phone_verified, code_sid FROM num_members WHERE phone=?1').bind(phone).first()
      : null;

  // NO ENUMERATION ORACLE. A number that is not on file gets the same sentence
  // as one that is cooling down — "not right now" — because a distinguishable
  // 404 turns this endpoint into a free "is this person on Num" lookup for
  // anybody with a phone book.
  if (!row) {
    return json({
      error: 'I can’t send another code to that number right now. Check the digits, or start again from the top.',
      retry_after_sec: RESEND_COOLDOWN_SEC,
    }, 429);
  }
  if (row.phone_verified) return json({ ok: true, already: true });
  if (!row.phone) return json({ error: 'no number on file' }, 400);

  const refuse = await sendGate(env, row.id);
  if (refuse) return json(refuse, 429);

  // WHAT HAPPENED TO THE LAST ONE, before promising anything about the next.
  //
  // Verify reports carrier outcomes only on request, so a code that a carrier
  // rejected leaves our side reading `ok`. Asking costs one GET and turns
  // "I have sent another code" — which would be the second lie in a row — into
  // the actual reason nothing arrived. Best-effort: a diagnostic that fails
  // must never block the resend it was describing.
  let previous = null;
  if (String(row.code_sid ?? '').startsWith('VE')) {
    try {
      const { attemptsForVerification } = await import('./verifydiag.mjs');
      const seen = await attemptsForVerification(env, row.code_sid);
      const failed = (seen.attempts ?? []).find((a) => a.delivered === false);
      if (failed) previous = { delivered: false, error_code: failed.error_code, hint: failed.hint };
    } catch {
      /* the diagnosis is a bonus; the resend is the job */
    }
  }

  const out = await issueCode(env, row.id, row.phone);
  // Never echo the member id back: this endpoint is reachable with a phone
  // number alone, and `issueCode` is shared with paths that already hold one.
  return json({ ...out, previous });
}

async function verifyMe(env, req) {
  const b = await readBody(req);
  // Two ways in, and the second one is the other half of the recovery fix.
  //
  //   by id    — the ordinary case: a member who already has their ID and is
  //              proving the number attached to it.
  //   by phone — recovery. /me no longer hands the ID back for an unverified
  //              number, so somebody coming back on a new device has exactly
  //              two things: the number, and the code we just texted to it.
  //              Presenting both IS the proof of possession, so this is the
  //              one place the ID may be released.
  const byPhone = !clip(b.id, 40) && !!normalisePhone(b.phone, regionOf(req));
  const row = byPhone
    ? await env.DB.prepare('SELECT * FROM num_members WHERE phone=?1').bind(normalisePhone(b.phone, regionOf(req))).first()
    : await env.DB.prepare('SELECT * FROM num_members WHERE id=?1').bind(clip(b.id, 40) ?? '').first();
  if (!row) return json({ error: 'unknown member' }, 404);

  // APP REVIEW ACCESS, the other half. Only the phone path, only the number
  // the grant names, only the code held in App Store Connect — and it changes
  // nothing about the account it lets into. In particular it does NOT set
  // phone_verified: that is a claim about a number we have not texted, and
  // setting it would lock the demo account's name and shut the door behind
  // the reviewer.
  //
  // It sits above the phone_verified short-circuit because that branch
  // answers { ok: true, already: true } with no identity in it — correct for
  // a member who already has their ID, useless to a reviewer who has never
  // had one.
  const reviewGrant = byPhone ? reviewerFor(env, row.phone, row.id) : null;
  if (reviewGrant) {
    if ((row.attempts ?? 0) >= MAX_ATTEMPTS) {
      await auditReview(env, { stage: 'verify', outcome: 'capped', memberId: row.id, req });
      return json({ error: 'too many attempts' }, 429);
    }
    // Hashed on both sides with the same salt so the comparison is
    // constant-time AND length-blind — safeEqual bails early on a length
    // mismatch, which would otherwise leak how long the code is.
    const offered = String(b.code ?? '').trim();
    const salt = 'review-grant';
    if (!safeEqual(await hashCode(offered, salt), await hashCode(reviewGrant.code, salt))) {
      await env.DB.prepare('UPDATE num_members SET attempts=attempts+1 WHERE id=?1').bind(row.id).run();
      await auditReview(env, { stage: 'verify', outcome: 'wrong_code', memberId: row.id, req });
      return json({ error: 'wrong code', attempts_left: MAX_ATTEMPTS - ((row.attempts ?? 0) + 1) }, 400);
    }
    await env.DB.prepare("UPDATE num_members SET attempts=0, seen_at=datetime('now') WHERE id=?1").bind(row.id).run();
    await auditReview(env, { stage: 'verify', outcome: 'granted', memberId: row.id, req });
    return json({
      ok: true,
      phone_verified: !!row.phone_verified,
      recovered: true,
      review_access: true,
      me: {
        id: row.id,
        name: row.name,
        phone: row.phone,
        phone_verified: !!row.phone_verified,
        name_locked: !!row.name_locked,
        avatar: row.avatar ?? null,
        bio: safeParse(row.bio),
        ref: row.ref_code,
      },
      ref: row.ref_code,
    });
  }

  // `already: true` carries NO identity — correct for a member who already
  // holds their id and re-verified, useless to somebody signing in on a new
  // device, who is here precisely to obtain one. Short-circuiting the PHONE
  // path on `phone_verified` was the second half of the lockout: `/me` would
  // send them a code and this line threw it away unread.
  //
  // On the phone path a verified number now falls through to the code check
  // like any other. The identity is still released only against a correct
  // code — that has not changed and must not.
  if (row.phone_verified && !byPhone) return json({ ok: true, already: true });

  // TWILIO VERIFY holds the code when it is configured, so the check goes back
  // to Twilio rather than to a hash of ours. Only reached below the review
  // grant, which is deliberately independent of any SMS provider.
  //
  // THE TRAP: a wrong code does NOT make Verify return an error. It answers
  // 200 with status "pending". Testing for "not an error" would admit anybody
  // with any code, so only `approved` passes, and verifyCheck tests for that
  // string explicitly rather than for truthiness.
  //
  // Our own attempt counter still runs. Verify enforces five checks per
  // verification, but that is per-verification, and the counter here is what
  // makes a stream of fresh verifications against one member expensive too.
  const viaVerify = verifyConfigured(env);
  const note = (outcome, reason) =>
    logSignin(env, { memberId: row.id, stage: 'check', outcome, reason, via: viaVerify ? 'verify' : 'sms' });
  if (viaVerify) {
    if (row.attempts >= MAX_ATTEMPTS) { await note('capped'); return json({ error: 'too many attempts' }, 429); }
    const chk = await verifyCheck(env, row.phone, String(b.code || '').trim());
    if (!chk?.approved) {
      await env.DB.prepare('UPDATE num_members SET attempts=attempts+1 WHERE id=?1').bind(row.id).run();
      // `status` separates a wrong code (pending) from a verification that
      // expired or never started (not_found). Same 400 to the guest, very
      // different things to go and fix.
      await note('wrong_code', chk?.status);
      return json({ error: 'wrong code', attempts_left: MAX_ATTEMPTS - (row.attempts + 1) }, 400);
    }
  } else {
    if (!row.code_hash) { await note('failed', 'no_code_pending'); return json({ error: 'no code pending' }, 409); }
    if (row.code_expires && new Date(row.code_expires) < new Date()) {
      await note('expired');
      return json({ error: 'that code expired — ask for a new one' }, 410);
    }
    if (row.attempts >= MAX_ATTEMPTS) { await note('capped'); return json({ error: 'too many attempts' }, 429); }

    const supplied = String(b.code || '').replace(/\D/g, '');
    if (!safeEqual(await hashCode(supplied, row.code_salt), row.code_hash)) {
      await env.DB.prepare('UPDATE num_members SET attempts=attempts+1 WHERE id=?1').bind(row.id).run();
      await note('wrong_code');
      return json({ error: 'wrong code', attempts_left: MAX_ATTEMPTS - (row.attempts + 1) }, 400);
    }
  }
  await note('ok');
  // Whoever referred this person has now earned it. Fire-and-forget: a
  // referral bookkeeping problem must never fail somebody's verification.
  markReferralEarned(env, row.id, 'phone_verified').catch(() => {});
  await env.DB.prepare('UPDATE num_members SET phone_verified=1, code_hash=NULL, code_salt=NULL, code_expires=NULL WHERE id=?1')
    .bind(row.id).run();
  // THE CONSENT ROW. A verified number with no consent row was a member Num
  // could never text — not a confirmation, not a reminder, not a friend's
  // plan. The sentence they were shown is recorded, not a boolean. Fire and
  // forget: bookkeeping must never fail a verification.
  import('./smsconsent.mjs')
    .then((c) => c.record(env, {
      phone: row.phone,
      source: c.SOURCE.WEB_FORM,
      consentText: c.SIGNUP_CONSENT_TEXT,
      page: '/signup',
      firstName: row.name ?? null,
      userAgent: String(req.headers.get('User-Agent') ?? '').slice(0, 200) || null,
      country: req.cf?.country ?? null,
    }))
    .catch((e) => console.warn('[verify] consent record failed', e?.message ?? e));
  // SIGNING UP MUST NOT COST THEM WHAT NUM ALREADY LEARNED.
  //
  // Everything noticed before this moment is filed against the device, because
  // that is the only handle a first-time guest has. If it stayed there, the
  // reward for verifying a phone would be a Num that suddenly knows less about
  // you than it did a minute ago — and people notice that immediately. Fires
  // once, here, and only fills blanks: the account is older and more trusted
  // than the device, so an existing member fact always wins.
  if (b.anon) {
    import('./soulprofile.mjs')
      .then((m) => m.mergeAnon(env, String(b.anon).slice(0, 64), row.id))
      .catch(() => {});
  }
  // The ID rides back ONLY on the recovery path, and only now that the code
  // has been presented. On the ordinary path the caller already had it, and
  // repeating it would make this response look like a way to obtain one.
  if (!byPhone) return json({ ok: true, phone_verified: true });
  const back = await env.DB.prepare('SELECT * FROM num_members WHERE id=?1').bind(row.id).first();
  return json({
    ok: true,
    phone_verified: true,
    recovered: true,
    me: {
      id: back.id,
      name: back.name,
      phone: back.phone,
      phone_verified: true,
      name_locked: !!back.name_locked,
      avatar: back.avatar ?? null,
      bio: safeParse(back.bio),
      ref: back.ref_code,
    },
    ref: back.ref_code,
  });
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
  // WHO IS THIS PERSON? By member id if the app knows it, else by phone.
  //
  // Phone-only was a real bug: a friend you connected with by QR has no phone
  // stored against them, so `existing` came back null, the link was written
  // with b_id AND b_phone both NULL — and the inbox query matches on one or
  // the other, so that row was unreachable by every read path, forever. The
  // sender saw "invited"; the friend was never invited to anything. Tapping a
  // QR-connected friend in the invite sheet hit this every single time.
  const toId = clip(b.to_id, 40);
  // A removal that the other party can undo is not a removal. If either side
  // blocked the other, the invite stops here.
  if (toId && (await isBlocked(env, from, toId))) {
    return json({ error: 'That person can’t be added.' }, 403);
  }
  const existing =
    (toId
      ? await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(toId).first()
      : null) ??
    (toPhone
      ? await env.DB.prepare('SELECT id, name FROM num_members WHERE phone=?1').bind(toPhone).first()
      : null);
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

  // The friendship. For a STRANGER it stays pending until they open the link
  // — consent by action. For an EXISTING member it activates immediately:
  // both people are on Num, the sender addressed them by their own number,
  // and the recipient's phone buzzes with who connected — the agents talk to
  // each other, no text message in the loop. (This is the fix for Dre↔Vivian
  // day one: she was a member, yet her invite behaved like a cold signup.)
  await env.DB.prepare(
    "INSERT INTO num_links (id, a_id, b_id, b_phone, b_name, token, plan_id, state, accepted_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
  ).bind(
    uid('lnk'), from, existing?.id ?? null, toPhone, toName, token, planId,
    existing ? 'active' : 'pending', existing ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
  ).run();
  if (existing && !plan) {
    // Plan invites already notified above; a pure friend-connect buzzes too.
    await notify(env, {
      memberId: existing.id, kind: 'friend', title: 'New connection',
      body: `${senderName} connected with you on Num.`, url: '/?app', tag: `friend:${from}`,
    }).catch(() => {});
  }

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
    // Can NUM text this one for them? Only with a number to text, a verified
    // sender, and texting switched on — the app shows the button only then.
    num_text: !!toPhone && !existing && textingAvailable(env, sender),
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
// ── Pairing codes: crossing the Safari ↔ installed-app wall ───────────────
//
// On iOS the home-screen app and Safari have SEPARATE storage. They are the
// same origin and the same server, but they cannot see each other's
// localStorage — so each mints its own member id. A friend link tapped in
// Messages opens Safari, the friendship binds to the Safari identity, and the
// person's actual app never hears about it. That is the "it added a friend to
// my Safari Num" bug, and no amount of client code inside one context can see
// into the other.
//
// A pairing code is the bridge that does not require them to see each other:
// the browser parks the pending connection on the SERVER and shows a short
// code; the app redeems it against its own identity. Six characters because
// it gets read off one screen and typed into another, and because it lives
// for fifteen minutes — long enough to walk between apps, short enough that a
// screenshot in a group chat is not a standing invitation.
const PAIR_TTL_MIN = 15;
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1

const PAIR_SCHEMA = `
CREATE TABLE IF NOT EXISTS num_pair_codes (
  code TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), used_at TEXT
);
`;
let pairReady = false;
async function ensurePair(env) {
  if (pairReady || !env.DB) return;
  await env.DB.prepare(PAIR_SCHEMA.trim()).run();
  pairReady = true;
}

const pairCode = () => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((n) => PAIR_ALPHABET[n % PAIR_ALPHABET.length]).join('');
};

/** Park a connect/invite that arrived in the wrong browsing context. */
async function pairMint(env, req) {
  await ensurePair(env);
  const b = await readBody(req);
  const kind = b.connect_to ? 'connect' : b.token ? 'invite' : null;
  const payload = clip(b.connect_to ?? b.token, 120);
  if (!kind || !payload) return json({ error: 'nothing to pair' }, 400);

  const code = pairCode();
  await env.DB.prepare('INSERT INTO num_pair_codes (code, kind, payload) VALUES (?1,?2,?3)')
    .bind(code, kind, payload).run();
  return json({ code, expires_in_minutes: PAIR_TTL_MIN });
}

/**
 * Redeem in the app, against the APP's identity — which is the whole point.
 * Single-use and time-boxed; a used or stale code says so rather than failing
 * silently, because the person is standing there holding a code that looked
 * right.
 */
async function pairRedeem(env, req) {
  await ensurePair(env);
  const b = await readBody(req);
  const me = clip(b.me, 40);
  const code = clip(b.code, 12)?.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!me || !code) return json({ error: 'Which code?' }, 400);

  const row = await env.DB.prepare(
    "SELECT kind, payload, used_at, created_at FROM num_pair_codes WHERE code = ?1",
  ).bind(code).first();
  if (!row) return json({ error: 'That code isn’t one of ours — check it and try again.' }, 404);
  if (row.used_at) return json({ error: 'That code has already been used.' }, 409);

  const age = (Date.now() - Date.parse(`${row.created_at}Z`)) / 60000;
  if (!Number.isFinite(age) || age > PAIR_TTL_MIN) {
    return json({ error: 'That code has expired — ask for the link again.' }, 410);
  }

  await env.DB.prepare("UPDATE num_pair_codes SET used_at = datetime('now') WHERE code = ?1").bind(code).run();

  // Replay the original intent, now bound to the app's member id.
  const fake = (body) => new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (row.kind === 'connect') return await connect(env, fake({ me, to: row.payload }));
  return await accept(env, fake({ me, token: row.payload }));
}

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
/**
 * Sign in with Apple.
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────
 *
 * App Review rejected 1.0(2) under guideline 4.8: the app offered "Continue
 * with Google" (for 5arz identity linking) and no login service that limits
 * collection to name and email, lets the user withhold a real email, and does
 * not track for advertising. Sign in with Apple is Apple's own named example.
 *
 * It is also the first sign-in Num has had that does not depend on SMS. Of
 * 129 members, 2 have ever completed phone verification.
 *
 * ── THE IDENTITY RULE ─────────────────────────────────────────────────────
 *
 * One Apple ID, one Num account, permanently — the same rule as 5arz linking
 * and for the same reason: an identity that can fan out to many accounts is
 * not an identity. `apple_sub` is the primary key, so the constraint is the
 * database's, not a code path someone can forget to call.
 *
 * `sub` is what we key on, never the email: Apple's Private Relay addresses
 * change, users can hide them entirely, and an account that moves when an
 * email does is an account that can be stolen when one is reassigned.
 */
async function appleSignIn(env, req) {
  await ensure(env);
  const b = await readBody(req);

  const token = clip(b.identity_token, 4096);
  if (!token) return json({ error: 'Missing Apple identity token.' }, 400);

  let claims;
  try {
    // Verified against Apple's published keys. NEVER decoded and believed —
    // see appleauth.mjs; a client-supplied JWT is a claim until the signature
    // says otherwise.
    claims = await verifyAppleToken(token, {
      audience: env.APPLE_BUNDLE_ID || undefined,
    });
  } catch (err) {
    console.warn('[apple] rejected:', err?.message ?? err);
    return json({ error: 'That Apple sign-in could not be verified.' }, 401);
  }

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_apple_identities (
       apple_sub  TEXT PRIMARY KEY,
       member_id  TEXT NOT NULL,
       email      TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run();

  const known = await env.DB.prepare(
    'SELECT member_id FROM num_apple_identities WHERE apple_sub = ?1 LIMIT 1',
  ).bind(claims.sub).first();

  let memberId = known?.member_id ?? null;

  if (!memberId) {
    // First sight of this Apple ID. Adopt the device's current anonymous
    // member when it has one so a guest who has already been chatting keeps
    // their thread; otherwise mint a fresh account.
    const claimed = clip(b.me, 40);
    const existing = claimed
      ? await env.DB.prepare('SELECT id FROM num_members WHERE id = ?1 LIMIT 1').bind(claimed).first()
      : null;
    memberId = existing?.id ?? uid('mem');

    // APPLE SENDS THE NAME EXACTLY ONCE, on the first authorization for this
    // Apple ID — never again, not even after the app is deleted and
    // reinstalled. So it is stored now or it is lost.
    const name = clip(b.name, 60);
    if (existing) {
      if (name) {
        await env.DB.prepare(
          'UPDATE num_members SET name = COALESCE(name, ?2), seen_at = datetime(\'now\') WHERE id = ?1',
        ).bind(memberId, name).run();
      }
    } else {
      await env.DB.prepare(
        "INSERT INTO num_members (id, name, ref_code, seen_at) VALUES (?1,?2,?3,datetime('now'))",
      ).bind(memberId, name, friendly()).run();
    }

    try {
      await env.DB.prepare(
        'INSERT INTO num_apple_identities (apple_sub, member_id, email) VALUES (?1,?2,?3)',
      ).bind(claims.sub, memberId, claims.email).run();
    } catch {
      // Lost a race against another device signing in with the same Apple ID.
      // The row that won is the truth; adopt it rather than creating a second
      // account for one person.
      const row = await env.DB.prepare(
        'SELECT member_id FROM num_apple_identities WHERE apple_sub = ?1 LIMIT 1',
      ).bind(claims.sub).first();
      if (row?.member_id) memberId = row.member_id;
    }
  }

  const me = await env.DB.prepare(
    'SELECT id, name, phone, phone_verified, avatar, bio, ref_code FROM num_members WHERE id = ?1 LIMIT 1',
  ).bind(memberId).first();
  if (!me) return json({ error: 'Could not open that account.' }, 500);

  // `stage`/`outcome` are a closed vocabulary in signinlog.mjs and anything
  // outside it is refused with a warning and logged nowhere — which would have
  // made every Apple sign-in invisible in the one table that answers "can
  // people actually get in". `via` is the free field, and it is what
  // distinguishes this path from an SMS code.
  await logSignin(env, { memberId, stage: 'check', outcome: 'ok', via: 'apple' }).catch(() => {});

  return json({
    me: {
      id: me.id,
      name: me.name,
      phone: me.phone,
      phone_verified: !!me.phone_verified,
      avatar: me.avatar ?? null,
      bio: safeParse(me.bio),
      ref: me.ref_code,
    },
    ref: me.ref_code,
    // Deliberately NOT echoed: the email. Private Relay exists so a person can
    // withhold it; storing it is necessary, reflecting it back into client
    // state that syncs and logs is not.
    signed_in_with: 'apple',
  });
}

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
  // FAIL CLOSED. This used to be `if (env.GOOGLE_CLIENT_ID && ...)`, so with
  // the secret unset the audience check was skipped entirely and ANY valid
  // Google token from ANY app on the internet was accepted — and /api/version
  // publicly advertises whether the id is set, so an attacker could check
  // first. A verification that switches itself off when unconfigured is worse
  // than no verification, because it still hands out the badge.
  if (!env.GOOGLE_CLIENT_ID || info.aud !== env.GOOGLE_CLIENT_ID) {
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

  // A block has to hold on EVERY path in, not just the one we thought of.
  // invite() checked this; connect() didn't — so anyone you removed could
  // walk back in by scanning your QR, which is the easiest path of all. A
  // block that one route ignores is not a block.
  //
  // Deliberately vague: naming the block tells the blocked person they were
  // blocked, which is precisely what the silence was protecting against.
  if (await isBlocked(env, meId, toId)) {
    return json({ error: 'That code isn’t working.' }, 403);
  }

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

  // TELL THE OTHER PERSON. They just gained a friend who can now DM them and
  // add them to plans — a state change on their account that they had no part
  // in initiating. Writing the row and staying silent is how "I scanned you"
  // became "nothing happened" on the other phone. Only reached for a NEW
  // link — the already-connected branch returns above.
  await notify(env, {
    memberId: other.id, kind: 'friend', title: 'New connection',
    body: `${self.name || 'Someone'} connected with you on Num.`,
    url: '/?app', tag: `friend:${meId}`,
  }).catch(() => {});

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
  // The person who SENT the invite is the one waiting to hear. Until now they
  // learned nothing — while the app told the accepter "they know." They did
  // not. This is that message becoming true.
  await notify(env, {
    memberId: link.a_id, kind: 'friend', title: 'Invite accepted',
    body: link.plan_id
      ? `${self?.name || 'They'} joined your plan.`
      : `${self?.name || 'Someone you invited'} is on Num now.`,
    url: '/?app', tag: `accept:${meId}`,
  }).catch(() => {});

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
  // Money arrived and nobody said so. The payee's only signal was a 45-second
  // poll — with the app closed, nothing at all, ever. Every other credit in
  // this codebase buzzes (errand settle, referral share); this one didn't.
  await notify(env, {
    memberId: to, kind: 'pay', title: `★${amount.toLocaleString()} from ${payer?.name || 'a friend'}`,
    body: note ? `“${note}”` : 'It’s in your wallet.',
    url: '/?app', tag: `pay:${from}`,
  }).catch(() => {});

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
    try {
      await env.DB.batch([
        env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(c.member_id, amount),
        env.DB.prepare("INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'tab',?4,?5)")
          .bind(`${ref}:out`, meId, -amount, state.tab.title, c.member_id),
        env.DB.prepare("INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'tab',?4,?5)")
          .bind(`${ref}:in`, c.member_id, amount, state.tab.title, meId),
        env.DB.prepare('INSERT INTO num_tab_settlements (id, tab_id, from_id, to_id, stars) VALUES (?1,?2,?3,?4,?5)')
          .bind(ref, state.tab.id, meId, c.member_id, amount),
      ]);
    } catch (err) {
      // PUT IT BACK. The comment above described this hazard correctly and
      // then didn't guard it: the debit had already landed, so a failed batch
      // (D1 blip, storage cap, id collision) simply destroyed the payer's
      // Stars. pay(), moveEscrow() and cashout all roll back; this is the one
      // money path that didn't, and it runs in a loop over every creditor.
      await env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1')
        .bind(meId, amount).run().catch(() => {});
      console.error('[tab-settle] rolled back', err?.message ?? err);
      return json({ error: 'That settlement didn’t go through — nothing was taken.' }, 500);
    }
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
  // Closing a tab takes away everyone else's ability to settle it. Silence
  // here means a friend mid-payment just gets "That tab is closed."
  await notifyTab(env, tab, clip(b.me, 40), `${tab.title} is closed.`).catch(() => {});

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
      "UPDATE num_plans SET title=COALESCE(?2,title), dest=COALESCE(?3,dest), starts_on=COALESCE(?4,starts_on), starts_time=COALESCE(?6,starts_time), state=COALESCE(?5,state), updated_at=datetime('now') WHERE id=?1",
    ).bind(planId, clip(b.title, 120), clip(b.dest, 80), clip(b.starts_on, 20), clip(b.state, 20), clip(b.starts_time, 8)).run();
    const plan = await env.DB.prepare('SELECT * FROM num_plans WHERE id=?1').bind(planId).first();
    // Setting WHEN is the moment a plan becomes real — it goes on the feed and
    // buzzes every member (event() pushes to everyone but the author), and the
    // clients mirror it onto each calendar on their next sync.
    if (b.starts_on || b.starts_time) {
      await event(env, planId, { id: meId, name: self.name }, 'scheduled',
        `${self.name || 'Someone'} set the plan for ${plan.starts_on ?? 'a date TBC'}${plan.starts_time ? ` at ${plan.starts_time}` : ''} — it's on everyone's calendar.`);
    }
    return json({ plan });
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
  // How the group feels about each idea, in one query alongside the rest.
  const tally = await voteTally(env, id);

  return json({
    /**
     * THE PLAN OWN DOOR INTO THE CHAT - added 6 Sep 2026.
     *
     * A plan is where a group decides, and until now the only way to get an
     * idea into one was to already be in the chat with the plan already open.
     * So the person with the idea had to explain the app to everyone else.
     * This is one link: it opens Num, selects THIS plan, and starts a thread
     * on the plan own subject, so whatever Num suggests can be dropped
     * straight in and voted on.
     *
     * The join code is the key, exactly as the invite path already uses it, so
     * a friend who follows it and is not on the plan yet joins by following.
     */
    ask_link: plan?.join_code
      ? `https://app.itsnum.com/?plan=${encodeURIComponent(plan.join_code)}&ask=1`
      : null,
    plan,
    members: members ?? [],
    items: (items ?? []).map((i) => {
      const attendees = byItem.get(i.id) ?? [];
      const v = tally[i.id] ?? { up: 0, down: 0, voters: [] };
      return {
        ...i,
        attendees,
        // The group feeling on THIS idea, and my own tap so the button can
        // render pressed without a second request.
        votes: { up: v.up, down: v.down },
        my_vote: (v.voters ?? []).find((x) => x.member_id === meId)?.vote ?? null,
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

// ── Group intelligence ─────────────────────────────────────────────────────
//
// "Ben doesn't eat shellfish, Cleo lands at nine, so it's the late seating at
// the one place that does halal" — a human concierge holds all of that in
// their head. This gives Num the same view of a group, under one hard rule:
//
//   A MEMBER'S PREFERENCES JOIN THE PLAN ONLY IF THAT MEMBER SAID SO.
//
// Consent is per-plan and per-member (share_prefs on the membership row),
// default OFF. Telling Num your diet is a private act; sharing it with six
// friends on a trip is a different one, and conflating them would make people
// stop telling Num anything — which kills the whole feature layer above it.

/** Flip my own sharing for one plan. Nobody can flip it for me. */
/**
 * A thumb up or down on ONE idea in the plan.
 *
 * ── WHY THIS IS NOT THE VOTE WE ALREADY HAD ────────────────────────────────
 *
 * `num_plan_members.vote` answers "am I coming at all" — one answer per person
 * for the whole plan. It has been mistaken for choosing between ideas since it
 * shipped, and it cannot do that job: five people who are all "in" still have
 * no way to say which of the four restaurants they want.
 *
 * That is the actual failure mode of planning with friends. Somebody drops
 * three ideas in, everyone says "any of those works", and forty minutes later
 * the group eats at the place they can see from the hotel door. A vote per
 * IDEA is the smallest thing that ends that.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *
 * One vote per person per item, changeable — a group decision that cannot be
 * changed is an argument, not a decision. Voting the same way twice clears it
 * (tap again to un-vote), because the alternative is a tally nobody can
 * correct. Only members of the plan may vote, checked against the item's own
 * plan, so an item id from another group is refused rather than counted.
 */
async function itemVote(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const itemId = clip(b.item_id, 40);
  const want = b.vote === 'up' ? 'up' : b.vote === 'down' ? 'down' : null;
  if (!meId || !itemId || !want) return json({ error: 'me, item_id and vote (up|down) required' }, 400);

  const item = await env.DB.prepare('SELECT id, plan_id, title FROM num_plan_items WHERE id=?1').bind(itemId).first();
  if (!item) return json({ error: 'That idea is no longer on the plan.' }, 404);
  if (!(await memberOf(env, item.plan_id, meId))) return json({ error: 'not your plan' }, 403);

  const prev = await env.DB.prepare('SELECT vote FROM num_plan_item_votes WHERE item_id=?1 AND member_id=?2')
    .bind(itemId, meId).first();
  const mine = prev?.vote === want ? null : want;   // tapping the same way clears it
  if (mine) {
    await env.DB.prepare(
      `INSERT INTO num_plan_item_votes (item_id, member_id, vote) VALUES (?1,?2,?3)
       ON CONFLICT(item_id, member_id) DO UPDATE SET vote=excluded.vote, created_at=datetime('now')`,
    ).bind(itemId, meId, mine).run();
  } else {
    await env.DB.prepare('DELETE FROM num_plan_item_votes WHERE item_id=?1 AND member_id=?2').bind(itemId, meId).run();
  }

  const tally = await voteTally(env, item.plan_id);
  const self = await env.DB.prepare('SELECT name FROM num_plan_members WHERE plan_id=?1 AND member_id=?2')
    .bind(item.plan_id, meId).first();
  // Narrated to the group only when a vote is CAST. "Someone un-voted" is
  // noise in a feed that people read to know what changed.
  if (mine) {
    await event(env, item.plan_id, { id: meId, name: self?.name }, 'item_vote',
      `${self?.name || 'Someone'} ${mine === 'up' ? 'likes' : 'passed on'} ${item.title}`);
  }
  return json({ ok: true, vote: mine, votes: tally[itemId] ?? { up: 0, down: 0 } });
}

/** Every item's tally on one plan, in one query. Never throws. */
async function voteTally(env, planId) {
  const { results } = await env.DB.prepare(
    `SELECT v.item_id, v.member_id, v.vote FROM num_plan_item_votes v
       JOIN num_plan_items i ON i.id = v.item_id
      WHERE i.plan_id = ?1`,
  ).bind(planId).all().catch(() => ({ results: [] }));
  const out = {};
  for (const r of results ?? []) {
    const t = (out[r.item_id] ??= { up: 0, down: 0, voters: [] });
    if (r.vote === 'up') t.up += 1; else t.down += 1;
    t.voters.push({ member_id: r.member_id, vote: r.vote });
  }
  return out;
}

async function planShare(env, req) {
  const b = await readBody(req);
  const me = clip(b.me, 40);
  const planId = clip(b.plan_id, 40);
  const share = b.share ? 1 : 0;
  if (!me || !planId) return json({ error: 'me and plan_id required' }, 400);
  const flip = await env.DB.prepare(
    'UPDATE num_plan_members SET share_prefs=?3 WHERE plan_id=?1 AND member_id=?2',
  ).bind(planId, me, share).run();
  if (!flip.meta.changes) return json({ error: 'You’re not on that plan.' }, 404);
  return json({ ok: true, sharing: !!share });
}

/**
 * What the group needs, merged. Only fields that matter for choosing a venue
 * or a time — never the whole bio, because "what does the plan need" and
 * "tell me everything about Ben" are different questions and only the first
 * one was consented to.
 */
const FIT_FIELDS = ['dietary', 'budget', 'vibe', 'mobility', 'arrive'];

/** The computation behind /plan/fit, exported so the brain can use it too. */
export async function groupNeeds(env, planId) {
  const { results } = await env.DB.prepare(
    `SELECT pm.member_id, pm.share_prefs, m.name, m.bio
       FROM num_plan_members pm JOIN num_members m ON m.id = pm.member_id
      WHERE pm.plan_id = ?1`,
  ).bind(planId).all().catch(() => ({ results: [] }));
  const members = results ?? [];
  const shared = members.filter((r) => r.share_prefs);
  const needs = {};
  for (const r of shared) {
    let bio = {};
    try { bio = JSON.parse(r.bio ?? '{}') ?? {}; } catch { /* old rows */ }
    for (const f of FIT_FIELDS) {
      const v = clip(bio[f], 120);
      if (!v) continue;
      (needs[f] ??= []).push({ who: r.name ?? 'someone', what: v });
    }
  }
  const lines = [];
  if (needs.dietary?.length) lines.push(`Dietary: ${needs.dietary.map((n) => `${n.who} — ${n.what}`).join('; ')}.`);
  if (needs.budget?.length) lines.push(`Budget: ${needs.budget.map((n) => n.what).join(', ')}.`);
  if (needs.vibe?.length) lines.push(`Mood: ${needs.vibe.map((n) => n.what).join(', ')}.`);
  if (needs.mobility?.length) lines.push(`Access: ${needs.mobility.map((n) => `${n.who} — ${n.what}`).join('; ')}.`);
  if (needs.arrive?.length) lines.push(`Arrivals: ${needs.arrive.map((n) => `${n.who} ${n.what}`).join('; ')}.`);
  return {
    members: members.length,
    sharing: shared.length,
    needs,
    summary: lines.length
      ? `Group of ${members.length}, ${shared.length} sharing preferences. ${lines.join(' ')}`
      : null,
  };
}

async function planFit(env, url) {
  const planId = clip(url.searchParams.get('plan_id'), 40);
  const me = clip(url.searchParams.get('me'), 40);
  if (!planId || !me) return json({ error: 'plan_id and me required' }, 400);

  // Only a member sees the group's needs. The fit summary is exactly the kind
  // of aggregate that leaks — "no shellfish, halal, lands 21:00" narrows six
  // people to one fast.
  const mine = await env.DB.prepare(
    'SELECT member_id, share_prefs FROM num_plan_members WHERE plan_id=?1 AND member_id=?2',
  ).bind(planId, me).first();
  if (!mine) return json({ error: 'You’re not on that plan.' }, 403);

  const fit = await groupNeeds(env, planId);
  return json({
    plan_id: planId,
    // My own flag, so the toggle renders true state instead of guessing.
    me_sharing: !!mine.share_prefs,
    ...fit,
    summary: fit.summary
      ?? `Group of ${fit.members} — nobody is sharing preferences yet, so recommendations can only fit the person asking.`,
  });
}

export async function handleSocial(request, env, path) {
  if (!env.DB) return json({ error: 'social features need the database binding' }, 503);
  await ensure(env);
  const url = new URL(request.url);
  const post = request.method === 'POST';

  if (path === '/me' && post) return await me(env, request);
  if (path === '/verify' && post) return await verifyMe(env, request);
  if (path === '/resend' && post) return await resendCode(env, request);
  if (path === '/invite' && post) return await invite(env, request);
  if (path === '/invite/text' && post) return await handleTextInvite(env, request);
  if (path === '/accept' && post) return await accept(env, request);
  if (path === '/connect' && post) return await connect(env, request);
  if (path === '/pair/mint' && post) return await pairMint(env, request);
  if (path === '/pair/redeem' && post) return await pairRedeem(env, request);
  if (path === '/verify/5arz' && post) return await verifyVia5arz(env, request);
  if (path === '/apple' && post) return await appleSignIn(env, request);
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
  if (path === '/plan/item/vote' && post) return await itemVote(env, request);
  if (path === '/plan/share' && post) return await planShare(env, request);
  if (path === '/plan/fit') return await planFit(env, url);
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
