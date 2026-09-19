/**
 * Ambassadors — the door onto an engine that was already built and already
 * pays.
 *
 * ── READ THIS BEFORE ADDING ANYTHING ─────────────────────────────────────
 *
 * There is no new economics in this file and there must not be one. The money
 * was decided by Dre on 13 Sep 2026 and lives in `worker/memberreferral.mjs`:
 * **20% of the commission NUM actually collected, for as long as both stay
 * active**, held as a column on `num_members` and paid as EARNED Stars so it
 * inherits the cash-out path that already works. That file's own header
 * reasons about "an influencer with 500 good referrals" earning ~$1,600 a
 * month. The engine was finished before anybody could reach it.
 *
 * What was missing was somewhere to stand. An ambassador was indistinguishable
 * from a member holding a code: no account, no console, nowhere to say who
 * they are or what they reach, and no way for a business to find them. This
 * file is that and nothing else.
 *
 * ── THE ONE REAL SEAM, AND WHY memberreferral.mjs HAD TO CHANGE ──────────
 *
 * `linkReferral` resolved `owner_type = 'member'` and nothing else. So an
 * ambassador code would have redirected correctly at /r/CODE, logged the
 * arrival, carried ?ref= into signup — and then written no payment edge at
 * all. Every part of it would have LOOKED like it worked. That is the worst
 * possible failure: a person posting a link for six months to an audience,
 * earning nothing, with no error anywhere to tell them.
 *
 * So `linkReferral` now resolves an ambassador code one hop to the member
 * account behind it, and refuses clearly when there is not one yet. Which
 * leads to the rule this whole file is organised around:
 *
 * ── AN AMBASSADOR IS PAID AS A MEMBER, OR NOT AT ALL ────────────────────
 *
 * The share is credited to a `num_members` row — that is where the Star
 * balance and the cash-out live. An ambassador with no connected member
 * account has a link that counts arrivals and pays nobody. We do not hide
 * that behind an encouraging dashboard. `payable` is computed on every read
 * and the console says, in words, that the link cannot pay yet and exactly
 * what fixes it.
 *
 * Connection is proved from BOTH sides and never from a typed-in phone
 * number. They control the application email (their console key was sent
 * there), and the member row must carry that same address with
 * `email_verified = 1`. Matching on an unverified field would let anybody
 * type a stranger's address and take their earnings.
 *
 * ── WHAT WE SAY WE OFFER ────────────────────────────────────────────────
 *
 * BENEFITS below is checked against the live feature registry, not against
 * the pricing page. Hotels (`stays`) and car hire sit in `needs_setup`;
 * VIP services are the hosts and `num_assets` holds zero listable rows. Those
 * are listed as not-yet, by name, with the reason. An ambassador's whole worth
 * is that their audience believes them, and the fastest way to spend that is
 * to hand them a benefits list with three things on it they cannot deliver.
 *
 * ── FOLLOWER COUNTS ─────────────────────────────────────────────────────
 *
 * Dre's call, 19 Sep 2026: self-declared, clearly labelled. `claimed` and
 * `verified` are separate columns and every read returns both plus a `basis`
 * string. No surface may render a claimed figure without saying it is claimed.
 */
import { rows, readFailedResponse, isReadFailed } from './readfail.mjs';
import { referralSummary } from '../worker/memberreferral.mjs';
import { TIERS, MYSTERY_LINE, nextTier, milestonesFor, recordMilestones } from './milestones.mjs';
import { NICHES, readNiches, cleanNiches, offerFit, REWARD_POOL, postLinesFor } from './niches.mjs';
import { CAMPAIGN as TOKYO, standingFor as tokyoStandingFor } from './tokyodraw.mjs';

/** Matches the CHECK on num_ambassador_socials.platform. Both copies exist
 *  because SQLite will not hand the list back; a test binds them. */
export const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x', 'facebook',
  'twitch', 'blog', 'other'];

/** What an ambassador can truthfully tell their audience today.
 *
 *  `live` is the promise. `soon` is named rather than omitted, because an
 *  ambassador who finds out from a follower that hotels do not work has been
 *  embarrassed by us. Built 19 Sep 2026 from the live registry and the
 *  discounts audit; whoever switches `stays` on moves the row. */
export const BENEFITS = {
  live: [
    { key: 'concierge', what: 'The concierge, free, in 39 countries',
      how: 'Their own link gets a person the same free concierge every member gets. It is the biggest thing NUM gives away and it costs nothing to serve.' },
    { key: 'referral', what: '20% of what NUM earns from everyone they bring in',
      how: 'For as long as both stay active. Paid as Stars, cashable like any other earning. This is the programme — the rest is on top.' },
    { key: 'perks', what: 'Venue perks on bookings made in the chat',
      how: 'A dessert, an upgrade, a late checkout, put up by the venue itself. Real wherever a venue has agreed one.' },
    { key: 'activities', what: 'Activities and tickets',
      how: 'Booked through NUM and live today.' },
    { key: 'luggage', what: 'Luggage storage',
      how: 'Live, works, and almost nobody knows to ask for it.' },
    { key: 'draw', what: 'The Friday giveaway, ten winners a week',
      how: 'Running already. Something to post about that is true this week.' },
  ],
  soon: [
    { key: 'stays', what: 'Hotels', why: 'Built, not switched on — it needs a partner ID set. Do not promise a hotel rate yet.' },
    { key: 'cars', what: 'Car hire', why: 'Same: the code is there, the partner setting is not.' },
    { key: 'vip', what: 'VIP host services — cars, boats, jets, villas', why: 'The layer works end to end and nothing is listed in it yet. Real the day a host lists something, and not one day before.' },
  ],
};

/** What they agreed to, on the day they agreed to it. A version rather than
 *  a boolean because what somebody accepted is a fact about a date. */
export const AMB_TERMS_VERSION = 'ambassador-2026-09-19';

/** The claim state machine, mirroring the CHECK on num_ambassador_claims.
 *  Exported so a test can assert the two lists have not drifted. */
export const OFFER_STATES = ['claimed', 'posted', 'done', 'withdrawn'];

const nowIso = () => new Date().toISOString();

/**
 * Mint an ambassador code that can survive being looked up.
 *
 * NO PUNCTUATION, AND THIS IS NOT A STYLE CHOICE. `linkReferral` normalises
 * an incoming code with `.replace(/[^A-Z0-9]/g, '')` before it matches, so a
 * stored code containing a hyphen can never be found by it — the needle has
 * the hyphen removed and the haystack does not. Member codes are six plain
 * characters and work; host codes look like `BERNA-PPK8` and would not, which
 * is harmless only because host codes are owner_type 'agent' and were never
 * eligible.
 *
 * The first version of this file called the shared `mintCode`, which produces
 * `RAE-1234`. Every ambassador link would have redirected, logged, attributed
 * and then quietly failed to resolve — the exact failure the one-hop change
 * exists to end, reintroduced one line below it. A test asserts the shape.
 */
export async function mintAmbCode(env, name) {
  const stem = (String(name || '').toUpperCase().replace(/[^A-Z]/g, '') || 'NUM').slice(0, 4);
  const pick = () => {
    const a = new Uint8Array(6);
    (globalThis.crypto || crypto).getRandomValues(a);
    // No I, O, 0 or 1. A code is read off a phone screen and typed by hand.
    const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return [...a].map((b) => alpha[b % alpha.length]).join('');
  };
  for (let i = 0; i < 8; i++) {
    const code = (stem + pick()).slice(0, 10);
    const hit = await env.DB.prepare('SELECT code FROM num_referral_codes WHERE code = ?1')
      .bind(code).first().catch(() => null);
    if (!hit) return code;
  }
  return 'A' + pick() + pick().slice(0, 3);
}
const id = (p) => p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** The ambassador behind a console key, or null.
 *
 *  Same credential model as hosts and Experts: the link IS the key. Kept in
 *  one place so that if it ever becomes a real login it becomes one here. */
export async function ambAuth(env, url, D) {
  const k = url.searchParams.get('k') || '';
  if (k.length < 20 || k.length > 80) return null;
  const amb = await env.DB.prepare(
    `SELECT * FROM num_ambassadors WHERE console_key = ?1`,
  ).bind(k).first().catch(() => null);
  if (!amb) return null;
  if (D?.sameSecret && !D.sameSecret(amb.console_key, k)) return null;
  if (amb.status === 'ended') return null;
  return amb;
}

/**
 * Find the member account behind an ambassador, and link it if it is there.
 *
 * BOTH SIDES OR NEITHER. The address must match the one their console key was
 * sent to, AND the member row must have verified that address itself. One
 * side alone is a typed-in string, and a typed-in string must never move
 * somebody else's earnings.
 *
 * Returns the member id or null. Never throws — a failure here must not stop
 * an application from being accepted.
 */
export async function connectMember(env, amb) {
  if (!env?.DB || !amb?.email) return null;
  try {
    if (amb.member_id) return amb.member_id;
    const m = await env.DB.prepare(
      `SELECT id FROM num_members
        WHERE LOWER(email) = LOWER(?1) AND email_verified = 1
        ORDER BY created_at ASC LIMIT 1`,
    ).bind(String(amb.email)).first().catch(() => null);
    if (!m?.id) return null;
    // One member account per ambassador. If the same person applied twice we
    // would rather the second application sit unpayable and visible than
    // silently divert the first one's earnings.
    /* FAILS CLOSED, because this decides whose wallet gets paid. It used to
       `.catch(() => null)`, which reads a failed check as "nobody has
       claimed this member" and links anyway — handing one ambassador's
       earnings edge to another on a single read hiccup. The comment above
       says the intent is for a second application to sit unpayable and
       VISIBLE; not linking is exactly that. */
    let taken;
    try {
      taken = await env.DB.prepare(
        'SELECT id FROM num_ambassadors WHERE member_id = ?1 AND id <> ?2',
      ).bind(m.id, amb.id).first();
    } catch {
      return null;
    }
    if (taken) return null;
    await env.DB.prepare(
      'UPDATE num_ambassadors SET member_id = ?2, updated_at = ?3 WHERE id = ?1',
    ).bind(amb.id, m.id, nowIso()).run();
    return m.id;
  } catch { return null; }
}

/**
 * Everything the console needs, in one request.
 *
 * The host console taught this: four round trips on open means four chances
 * to show a half-built page, and a boot that half-fails is read as a crash.
 */
export async function ambSummary(req, env, url, D) {
  const { J } = D;
  const amb = await ambAuth(env, url, D);
  if (!amb) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'GET') return J({ ok: false, error: 'method' }, 405);

  try {
    const memberId = amb.member_id || await connectMember(env, amb);
    const money = memberId
      ? await referralSummary(env, memberId)
      : { referred: 0, earned: 0 };

    const socials = await rows(env.DB.prepare(
      `SELECT id, platform, handle, url, followers_claimed, followers_verified,
              verified_by, claimed_at, verified_at
         FROM num_ambassador_socials WHERE ambassador_id = ?1
        ORDER BY COALESCE(followers_verified, followers_claimed, 0) DESC`,
    ).bind(amb.id).all(), 'your channels');

    /* ── WHO THEY ACTUALLY BROUGHT IN ──────────────────────────────────
     *
     * Dre, 19 Sep 2026: "people need to know their connections are
     * happening." A count alone does not do that — "3" is a number, and
     * three rows with dates on them are three people.
     *
     * AN INITIAL, NEVER A NAME, AND NEVER CONTACT DETAILS. These people
     * joined NUM; they did not agree to appear on somebody else's roster.
     * "J. joined on the 14th, has not used NUM yet" carries the whole of
     * the signal the ambassador needs — their link works, and this person
     * has not earned them anything yet — without handing over a list of
     * strangers' names to whoever holds a console key.
     *
     * `earned` is per person and it is the honest half: an ambassador
     * looking at ten joins and zero earnings should be able to see that it
     * is because nobody has booked anything, not because NUM is holding
     * out on them.
     */
    /* Resolved before the milestone write below, which now reads its
       counted figure. */
    const tokyo = memberId
      ? await tokyoStandingFor(env, memberId)
      : { referred: 0, earned: 0, free: 0, entries: 0, joined: 0, not_counted: 0, reasons: [] };

    const brought = memberId ? await rows(env.DB.prepare(
      `SELECT m.id, m.name, m.created_at, m.referred_at,
              (SELECT COALESCE(SUM(s.delta),0) FROM num_star_moves s
                WHERE s.member_id = ?1 AND s.kind = 'referral' AND s.counterparty = m.id) AS earned
         FROM num_members m
        WHERE m.referred_by = ?1
        ORDER BY COALESCE(m.referred_at, m.created_at) DESC LIMIT 200`,
    ).bind(memberId).all(), 'the people you brought in') : [];

    /* ── MILESTONES RUN ON THE COUNTED FIGURE, NOT THE RAW ONE ─────────
     *
     * Caught by looking at a live console on 19 Sep: the Tokyo card
     * correctly showed 11 of 30 signups counting, while the milestone
     * ladder beside it had awarded "Twenty-five" on the raw 30. Milestones
     * carry real prizes, so a farm that cannot buy a draw entry could still
     * buy a mystery bonus — the anti-gaming rules have to govern every
     * reward on the page or they govern none of it.
     *
     * NOT brought.length either: that list is capped at 200, so the day
     * somebody passes two hundred signups the cap would silently freeze
     * their milestones for ever. */
    if (memberId) await recordMilestones(env, { ambassadorId: amb.id, count: tokyo.referred });
    const reached = await milestonesFor(env, amb.id);

    const claims = await rows(env.DB.prepare(
      `SELECT c.id, c.state, c.post_url, c.posted_at, c.note, c.created_at,
              o.id AS offer_id, o.title, o.they_get, o.we_ask, o.ends_at
         FROM num_ambassador_claims c
         JOIN num_ambassador_offers o ON o.id = c.offer_id
        WHERE c.ambassador_id = ?1
        ORDER BY c.created_at DESC LIMIT 100`,
    ).bind(amb.id).all(), 'what you have taken up');

    const site = env.SITE || 'https://itsnum.com';
    return J({
      ok: true,
      you: publicAmbassador(amb, socials, { self: true }),
      status: amb.status,
      link: site + '/r/' + amb.code,
      code: amb.code,
      money: {
        ...money,
        pct: Number(env?.MEMBER_REFERRAL_PCT ?? 20),
        // The Stars figure is what has landed, not what is owed. Said out
        // loud because "earned" reads as an accrual to anybody who has used
        // an affiliate dashboard before.
        what_earned_means: 'Stars already paid into your wallet from people you brought in. It moves when they actually use NUM, not when they sign up.',
      },
      /* ── THE SENTENCE THAT MUST NEVER BE SOFTENED ──────────────────────
         A link that counts arrivals and pays nobody, presented next to an
         earnings figure of zero, reads as "nobody has used it yet". It is
         not the same thing, and the difference is months of somebody's
         work. */
      payable: Boolean(memberId),
      payable_note: memberId ? null
        : 'Your link works and every arrival is counted — but NUM cannot pay you yet, because your share is paid into a NUM member wallet and we have not found yours. Open NUM, verify this same email address in the app, then reload this page.',
      socials,
      followers_note: 'Follower counts are what you told us, not what a platform confirmed. Every page that shows them says so.',
      /* The people, not just the number. Initials only — see the query. */
      brought: brought.map((m) => ({
        initial: String(m.name || '').trim() ? String(m.name).trim()[0].toUpperCase() + '.' : 'Someone',
        joined: m.referred_at || m.created_at,
        earned: Number(m.earned || 0),
      })),
      /* Starting points, not scripts — and only ever about things that are
         actually switched on. See POST_LINES. */
      post_lines: postLinesFor(readNiches(amb.niches_json), site + '/r/' + amb.code),
      niches: {
        mine: readNiches(amb.niches_json),
        all: NICHES,
        why: 'A business looking for somebody to talk about a restaurant wants an audience that came for food, not the biggest account on the list. This is the field that makes an offer land, and it decides what you see on the Offers tab.',
      },
      /* THE ROTATION, shown as a POOL and never as a prediction. Naming what
         the next one will be would turn a mystery into a promise, which is
         the one thing the milestone copy may not do. */
      reward_pool: REWARD_POOL.map((r) => ({ key: r.key, label: r.label, blurb: r.blurb, ready: r.ready })),
      tokyo: { campaign: TOKYO, ...tokyo },
      milestones: {
        tiers: TIERS,
        reached,
        next: nextTier(tokyo.referred),
        /* ONE SENTENCE, ONE PLACE. It must never harden into a promise on
           one screen while staying honest on another, so every surface
           renders this string rather than writing its own. */
        how_it_works: MYSTERY_LINE,
      },
      claims,
      benefits: BENEFITS,
      listed: Number(amb.listed) === 1,
      listed_note: 'Off by default. Turned on, a business looking for ambassadors can see your name, your city, your bio and the reach you claim. Never your email or your phone.',
    });
  } catch (e) {
    if (isReadFailed(e)) return readFailedResponse(J, e);
    throw e;
  }
}

/** What anybody other than the ambassador themselves is allowed to see.
 *
 *  No email, no phone, no console key, no member id. The same rule the host
 *  directory works by: two parties who want to talk are introduced, they do
 *  not read each other's contact details off a list. */
export function publicAmbassador(amb, socials = [], { self = false } = {}) {
  const chans = (socials || []).map((s) => ({
    platform: s.platform,
    handle: s.handle,
    url: s.url || null,
    followers_claimed: s.followers_claimed ?? null,
    followers_verified: s.followers_verified ?? null,
    // One string a page can render without having to reason about two
    // nullable columns and get it wrong.
    basis: s.followers_verified != null ? 'confirmed by the platform' : 'self-declared',
  }));
  const out = {
    id: amb.id,
    name: amb.name,
    city: amb.city || '',
    country: amb.country || '',
    bio: amb.bio || '',
    channels: chans,
    reach_claimed: chans.reduce((n, c) => n + Number(c.followers_claimed || 0), 0),
    reach_verified: chans.reduce((n, c) => n + Number(c.followers_verified || 0), 0),
  };
  if (self) { out.email = amb.email; out.phone = amb.phone || ''; }
  return out;
}

/**
 * POST /api/amb/profile?k=KEY — their own details, and the directory switch.
 *
 * `listed` is the only field here with a consequence outside this row, so it
 * is the only one with a rule: it can be turned on at any time, and turning
 * it off takes effect on the next read of the directory. There is no cache
 * to invalidate and there must not be one.
 */
export async function ambProfile(req, env, url, D) {
  const { J, clean, readJSON, badOrigin } = D;
  if (badOrigin(req)) return J({ ok: false }, 403);
  const amb = await ambAuth(env, url, D);
  if (!amb) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);

  let b;
  try { b = await readJSON(req, 16384); } catch { return J({ ok: false }, 400); }

  const name = clean(b.name, 120) || amb.name;
  const city = clean(b.city, 80);
  const country = clean(b.country, 80);
  const bio = clean(b.bio, 400);
  const listed = b.listed === undefined ? Number(amb.listed) : (b.listed ? 1 : 0);
  // Absent means "not sent by this form", which is different from "cleared".
  // A settings form that posts only the fields it shows must not silently
  // wipe a field it does not.
  const niches = b.niches === undefined ? readNiches(amb.niches_json) : cleanNiches(b.niches);

  await env.DB.prepare(
    `UPDATE num_ambassadors
        SET name=?2, city=?3, country=?4, bio=?5, listed=?6, niches_json=?7, updated_at=?8
      WHERE id=?1`,
  ).bind(amb.id, name, city, country, bio, listed, JSON.stringify(niches), nowIso()).run();

  return J({ ok: true, saved: true, listed: listed === 1, niches });
}

/**
 * One social channel, normalised — the rules that decide whether a row is
 * storable, in one place.
 *
 * Pulled out of `ambSocial` on 19 Sep 2026 so the SIGN-UP can write channels
 * too. Before that, the application form asked for reach in a free-text box
 * ("Instagram @yourname, about 40k. TikTok @yourname, about 12k.") and every
 * word of it landed in `applied_note`, where nothing could read it: the
 * directory could not sort on it, an offer could not be matched against it,
 * and no verification could ever be attached to it. A person told us their
 * reach and Num filed it as prose.
 *
 * It returns a row or a reason. It never returns a half-built one, and it
 * cannot set `followers_verified` — that column has exactly one writer and it
 * is not any endpoint a person can reach.
 */
export function socialRow(input = {}, clean, cleanUrl) {
  const platform = PLATFORMS.includes(String(input.platform)) ? String(input.platform) : null;
  if (!platform) return { ok: false, error: 'platform', allowed: PLATFORMS };
  // Handles are written with and without the @ by the same person on the same
  // day. Stored one way so the unique index actually catches a duplicate.
  const handle = clean(String(input.handle || '').replace(/^@+/, ''), 80);
  if (!handle) return { ok: false, error: 'handle' };
  const url = cleanUrl(input.url, 300);
  // A follower count is a number or it is absent. An empty box means "I did
  // not say", which is a different fact from zero and must not become one.
  let followers = null;
  const raw = input.followers;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const n = Math.floor(Number(String(raw).replace(/[,\s]/g, '')));
    if (!Number.isFinite(n) || n < 0 || n > 2_000_000_000) return { ok: false, error: 'followers' };
    followers = n;
  }
  return { ok: true, row: { platform, handle, url, followers } };
}

/**
 * POST /api/amb/social?k=KEY — add, update or remove a channel.
 *
 * `{ action:'save', platform, handle, url, followers }` or
 * `{ action:'remove', id }`.
 *
 * A saved figure ONLY ever touches `followers_claimed`. `followers_verified`
 * is not writable from here at all, by anybody, at any time — the endpoint a
 * person can reach is not allowed to write the column that means a platform
 * confirmed it. When an OAuth connection is built it gets its own writer and
 * sets `verified_by = 'oauth'`.
 */
export async function ambSocial(req, env, url, D) {
  const { J, clean, cleanUrl, readJSON, badOrigin } = D;
  if (badOrigin(req)) return J({ ok: false }, 403);
  const amb = await ambAuth(env, url, D);
  if (!amb) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);

  let b;
  try { b = await readJSON(req, 8192); } catch { return J({ ok: false }, 400); }

  if (b.action === 'remove') {
    const rid = clean(b.id, 60);
    if (!rid) return J({ ok: false, error: 'which one' }, 400);
    await env.DB.prepare(
      'DELETE FROM num_ambassador_socials WHERE id = ?1 AND ambassador_id = ?2',
    ).bind(rid, amb.id).run();
    return J({ ok: true, removed: true });
  }

  const parsed = socialRow(b, clean, cleanUrl);
  if (!parsed.ok) return J({ ok: false, error: parsed.error, allowed: parsed.allowed }, 400);
  const { platform, handle, url: link, followers } = parsed.row;

  const existing = await env.DB.prepare(
    'SELECT id FROM num_ambassador_socials WHERE ambassador_id=?1 AND platform=?2 AND handle=?3',
  ).bind(amb.id, platform, handle).first().catch(() => null);

  /* ── A CEILING, BECAUSE reach_claimed IS A SUM ────────────────────────
   *
   * The unique index is on (ambassador, platform, handle), and handle is
   * free text — so one console key could add rows without limit, each
   * carrying a claimed follower count, and publicAmbassador SUMS them into
   * the figure the business directory sorts on. Twenty rows of two billion
   * pins somebody at the top of that list for ever, and the directory runs
   * one social query per ambassador, so it degrades for every host too.
   *
   * Twenty channels is far more than any real person has. */
  if (!existing?.id) {
    const have = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM num_ambassador_socials WHERE ambassador_id = ?1',
    ).bind(amb.id).first().catch(() => ({ n: MAX_SOCIALS }));
    if (Number(have?.n ?? MAX_SOCIALS) >= MAX_SOCIALS) {
      return J({ ok: false, error: 'too_many',
        why: `That is ${MAX_SOCIALS} channels, which is already more than anybody posts on. Remove one to add another.` }, 409);
    }
  }

  if (existing?.id) {
    await env.DB.prepare(
      `UPDATE num_ambassador_socials
          SET url=?2, followers_claimed=?3, claimed_at=?4, updated_at=?4
        WHERE id=?1`,
    ).bind(existing.id, link, followers, nowIso()).run();
    return J({ ok: true, id: existing.id, updated: true });
  }

  const sid = id('soc');
  await env.DB.prepare(
    `INSERT INTO num_ambassador_socials
       (id, ambassador_id, platform, handle, url, followers_claimed, claimed_at, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?7)`,
  ).bind(sid, amb.id, platform, handle, link, followers, nowIso()).run();
  return J({ ok: true, id: sid, added: true });
}

/**
 * GET /api/amb/offers?k=KEY — what is on the table, and what they have taken.
 *
 * Only `open` offers, only ones that have not ended, and a `full` flag rather
 * than hiding an offer that has run out of slots — somebody who posted about
 * it yesterday should still be able to see what it was.
 */
export async function ambOffers(req, env, url, D) {
  const { J } = D;
  const amb = await ambAuth(env, url, D);
  if (!amb) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'GET') return J({ ok: false, error: 'method' }, 405);

  try {
    const list = await rows(env.DB.prepare(
      `SELECT o.*,
              (SELECT COUNT(*) FROM num_ambassador_claims c
                WHERE c.offer_id = o.id AND c.state <> 'withdrawn') AS taken,
              (SELECT c.state FROM num_ambassador_claims c
                WHERE c.offer_id = o.id AND c.ambassador_id = ?1) AS mine
         FROM num_ambassador_offers o
        WHERE o.status = 'open'
          AND (o.ends_at IS NULL OR o.ends_at >= ?2)
        ORDER BY o.created_at DESC LIMIT 100`,
    ).bind(amb.id, nowIso().slice(0, 10)).all(), 'what is on offer');

    /* ORDERED BY WHO IT IS FOR. An ambassador who opens this tab and finds
       nine things with nothing to do with them stops opening it, and the
       tenth — the one that was for them — is never seen. An untargeted offer
       scores neutral rather than zero so the open ones do not sink out of
       sight behind every targeted one. */
    const mine = readNiches(amb.niches_json);
    const scored = list.map((o) => ({ o, fit: offerFit(o.niches_json, mine) }))
      .sort((a, b) => b.fit - a.fit || String(b.o.created_at).localeCompare(String(a.o.created_at)));

    return J({
      ok: true,
      your_niches: mine,
      offers: scored.map(({ o, fit }) => ({
        id: o.id,
        for_you: fit > 1,
        niches: readNiches(o.niches_json),
        title: o.title,
        they_get: o.they_get,
        we_ask: o.we_ask,
        city: o.city || '',
        country: o.country || '',
        ends_at: o.ends_at || null,
        posted_by: o.posted_by_kind,
        slots: o.slots ?? null,
        taken: Number(o.taken || 0),
        full: o.slots != null && Number(o.taken || 0) >= Number(o.slots),
        mine: o.mine || null,
      })),
      note: list.length ? null
        : 'Nothing on the table this week. Your link and your share work regardless — offers are extra, not the programme.',
    });
  } catch (e) {
    if (isReadFailed(e)) return readFailedResponse(J, e);
    throw e;
  }
}

/**
 * POST /api/amb/claim?k=KEY — take an offer, say where it went, or step back.
 *
 * `{ action:'claim', offer_id }` · `{ action:'posted', offer_id, post_url }`
 * · `{ action:'withdraw', offer_id }`
 *
 * THE SLOT CHECK IS A RACE AND IS TREATED AS ONE. Counting claims and then
 * inserting can oversell an offer with one slot to two people a millisecond
 * apart, and the person who loses finds out from the business. The unique
 * index on (offer_id, ambassador_id) stops a double claim by one person; the
 * count is re-checked after the insert and rolled back if it lost, which is
 * the closest thing to a transaction D1 gives us here.
 */
export async function ambClaim(req, env, url, D) {
  const { J, clean, cleanUrl, readJSON, badOrigin } = D;
  if (badOrigin(req)) return J({ ok: false }, 403);
  const amb = await ambAuth(env, url, D);
  if (!amb) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  if (amb.status !== 'active') {
    return J({ ok: false, error: 'not_active',
      why: 'Offers open up once your application is accepted.' }, 403);
  }

  let b;
  try { b = await readJSON(req, 8192); } catch { return J({ ok: false }, 400); }
  const offerId = clean(b.offer_id, 60);
  if (!offerId) return J({ ok: false, error: 'which offer' }, 400);

  const offer = await env.DB.prepare(
    'SELECT * FROM num_ambassador_offers WHERE id = ?1',
  ).bind(offerId).first().catch(() => null);
  if (!offer) return J({ ok: false, error: 'no such offer' }, 404);

  if (b.action === 'withdraw') {
    await env.DB.prepare(
      `UPDATE num_ambassador_claims SET state='withdrawn', updated_at=?3
        WHERE offer_id=?1 AND ambassador_id=?2 AND state <> 'done'`,
    ).bind(offerId, amb.id, nowIso()).run();
    return J({ ok: true, state: 'withdrawn' });
  }

  if (b.action === 'posted') {
    /* cleanUrl, NOT clean. clean() is the NAME whitelist — ':' and '/' are not
       on it, so "https://instagram.com/p/x" came back as "https //instagram.com
       p x" and the check below refused a perfectly good link. Found by pasting
       a real URL into the live console, not by reading this file: every test
       passed, because the tests called the module with a fake `clean` that
       only trimmed. The fake now matches the real one. */
    const link = cleanUrl(b.post_url, 400);
    // The CHECK constraint on the table refuses 'posted' with no URL. Caught
    // here too so the person gets a sentence rather than a 500.
    if (!/^https?:\/\/\S+$/i.test(link)) {
      return J({ ok: false, error: 'post_url',
        why: 'Paste the link to the post itself — that is the whole of the evidence.' }, 400);
    }
    const res = await env.DB.prepare(
      `UPDATE num_ambassador_claims
          SET state='posted', post_url=?3, posted_at=?4, updated_at=?4
        WHERE offer_id=?1 AND ambassador_id=?2 AND state IN ('claimed','posted')`,
    ).bind(offerId, amb.id, link, nowIso()).run();
    if (!Number(res?.meta?.changes ?? 0)) {
      return J({ ok: false, error: 'not_claimed',
        why: 'Take the offer up first, then add the link.' }, 409);
    }
    return J({ ok: true, state: 'posted' });
  }

  // ── claim ──────────────────────────────────────────────────────────────
  if (offer.status !== 'open') {
    return J({ ok: false, error: 'closed', why: 'That one has closed.' }, 409);
  }
  const cid = id('cl');
  try {
    await env.DB.prepare(
      `INSERT INTO num_ambassador_claims (id, offer_id, ambassador_id, state, created_at, updated_at)
       VALUES (?1,?2,?3,'claimed',?4,?4)`,
    ).bind(cid, offerId, amb.id, nowIso()).run();
  } catch {
    // The unique index did its job. Already theirs is not an error.
    return J({ ok: true, state: 'claimed', already: true });
  }

  if (offer.slots != null) {
    const c = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM num_ambassador_claims
        WHERE offer_id = ?1 AND state <> 'withdrawn'
          AND created_at <= (SELECT created_at FROM num_ambassador_claims WHERE id = ?2)`,
    ).bind(offerId, cid).first().catch(() => null);
    if (Number(c?.n ?? 0) > Number(offer.slots)) {
      await env.DB.prepare('DELETE FROM num_ambassador_claims WHERE id = ?1').bind(cid).run();
      return J({ ok: false, error: 'full',
        why: 'Somebody took the last place a moment before you. Nothing was promised to your audience yet.' }, 409);
    }
  }
  return J({ ok: true, state: 'claimed', id: cid });
}

/**
 * GET /api/amb/directory?k=KEY — who is available, for a business or a host.
 *
 * NOT PUBLIC AND NOT SEARCHABLE BY ANYBODY WITH THE URL. A list of people
 * with their city, their following and their niche is exactly the list a
 * scraper wants, and the people on it opted in to being found by businesses
 * on NUM, not to being on the open web. It takes a host or business console
 * key, the same as every other cross-party read here.
 *
 * `listed = 1 AND status = 'active'` — an application that has not been
 * accepted yet is not a person a business should be writing to.
 */
export async function ambDirectory(req, env, url, D) {
  const { J, clean, hostAuth, bizAuth } = D;
  if (req.method !== 'GET') return J({ ok: false, error: 'method' }, 405);

  const who = (await hostAuth(env, url).catch(() => null))
    || (bizAuth ? await bizAuth(env, url, req).catch(() => null) : null);
  if (!who) return J({ ok: false, error: 'unauthorised' }, 401);

  const q = clean(url.searchParams.get('q'), 80);
  const city = clean(url.searchParams.get('city'), 80);
  const platform = PLATFORMS.includes(String(url.searchParams.get('platform') || ''))
    ? String(url.searchParams.get('platform')) : null;

  try {
    const where = ['a.listed = 1', "a.status = 'active'"];
    const binds = [];
    const add = (sql, ...v) => {
      where.push(sql.replace(/\$(\d)/g, (_, n) => '?' + (binds.length + Number(n))));
      binds.push(...v);
    };
    const like = (s) => '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    if (q) add("(a.name LIKE $1 ESCAPE '\\' OR a.bio LIKE $1 ESCAPE '\\')", like(q));
    if (city) add("(a.city LIKE $1 ESCAPE '\\' OR a.country LIKE $1 ESCAPE '\\')", like(city));
    if (platform) {
      add('EXISTS (SELECT 1 FROM num_ambassador_socials s WHERE s.ambassador_id = a.id AND s.platform = $1)', platform);
    }

    const found = await rows(env.DB.prepare(
      `SELECT a.id, a.name, a.city, a.country, a.bio
         FROM num_ambassadors a
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC LIMIT 100`,
    ).bind(...binds).all(), 'ambassadors');

    const out = [];
    for (const a of found) {
      const socials = await rows(env.DB.prepare(
        `SELECT platform, handle, url, followers_claimed, followers_verified
           FROM num_ambassador_socials WHERE ambassador_id = ?1`,
      ).bind(a.id).all(), 'their channels');
      out.push(publicAmbassador(a, socials));
    }
    // Reach they claim, largest first. Sorted on the claimed figure because
    // that is all there is today — and the field that carries it is named so
    // that no page can render it as anything else.
    out.sort((x, y) => (y.reach_verified - x.reach_verified) || (y.reach_claimed - x.reach_claimed));

    return J({
      ok: true,
      ambassadors: out,
      /* Said in the payload, not left to the page, because this list will be
         read by code we did not write before it is read by a person. */
      follower_counts: 'Self-declared by the ambassador and not confirmed by any platform, unless a figure appears under followers_verified.',
      how_to_reach_them: 'Post an offer and they come to you. NUM does not hand out contact details for people who joined a directory.',
      note: out.length ? null
        : 'No ambassador has opted into the directory yet. It is off by default and each one turns it on themselves.',
    });
  } catch (e) {
    if (isReadFailed(e)) return readFailedResponse(J, e);
    throw e;
  }
}

/** Applications one network may file in a day. A real person applying beside
 *  a friend is two; twenty is a script. Same shape as the host guardrail. */
export const AMB_JOINS_PER_NETWORK_PER_DAY = 5;

/** Channels one ambassador may list. See the ceiling check in ambSocial. */
export const MAX_SOCIALS = 20;

/**
 * POST /api/amb/join — apply.
 *
 * WRITTEN AS ONE BATCH ON PURPOSE. The host join endpoint spent a week
 * silently failing because a three-statement batch is atomic and the third
 * statement named a column that did not exist: the host row rolled back with
 * it, `num_hosts` held zero rows, and every founding host was lost without a
 * sound. Two statements here, both checked against the schema by a test that
 * runs the real migration.
 *
 * `status` starts at 'applied'. The link and the share are live immediately —
 * there is no reason to make somebody wait to earn — but offers and the
 * directory wait for acceptance, which is the only thing acceptance gates.
 */
export async function ambJoin(req, env, url, D) {
  const { J, clean, cleanUrl, readJSON, badOrigin, token, e164, country, ipHash } = D;
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);

  let b;
  try { b = await readJSON(req, 16384); } catch { return J({ ok: false }, 400); }

  const name = clean(b.name, 120);
  const email = clean(b.email, 160).toLowerCase();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return J({ ok: false, error: 'name_email' }, 400);
  }

  /* ── CHANNELS AND NICHES, ASKED AT THE DOOR ───────────────────────────
   *
   * Dre, 19 Sep 2026: "lets add that with all the social media and niche
   * questions so we can get them best signed up."
   *
   * Both used to be asked AFTER acceptance, in the console — and the form
   * asked for reach as a sentence ("Instagram @yourname, about 40k"), which
   * landed in `applied_note` where nothing could read it. So every
   * application arrived carrying the two facts that decide whether to accept
   * it, and neither in a column: nobody could sort the queue by reach, match
   * an offer to a specialism, or tell a 200k food creator from a blank form.
   *
   * Validated HERE, before the throttle and long before the send, so a
   * malformed channel costs nothing and a good application is never half
   * written. Niches cap at six inside cleanNiches — an ambassador for
   * everything matches every offer, which makes the field useless to the
   * businesses it exists to serve.
   *
   * Both are optional. Somebody with no channel to declare is still an
   * application, and demanding one would turn away the quiet ones who bring
   * ten friends each. */
  const socials = [];
  const sent = Array.isArray(b.socials) ? b.socials.slice(0, MAX_SOCIALS) : [];
  const seen = new Set();
  for (const raw of sent) {
    if (!raw || !String(raw.handle ?? '').trim()) continue; // an empty row is not an answer
    const parsed = socialRow(raw, clean, cleanUrl);
    if (!parsed.ok) return J({ ok: false, error: 'social_' + parsed.error, allowed: parsed.allowed }, 400);
    const key = parsed.row.platform + ':' + parsed.row.handle.toLowerCase();
    if (seen.has(key)) continue; // the same channel twice is one channel
    seen.add(key);
    socials.push(parsed.row);
  }
  const niches = cleanNiches(b.niches);

  /* ── THE THROTTLE COMES FIRST, BEFORE ANY EMAIL ───────────────────────
   *
   * Found in review, 19 Sep 2026. The resend branch below used to run — and
   * SEND — before this check, so anybody who knew an ambassador's address
   * could POST it in a loop and put one email per request into that person's
   * inbox, each one carrying their console key, at whatever rate they liked.
   *
   * It costs the victim their inbox and it costs NUM its sending reputation,
   * which this project has already had to halt once. The send is the
   * expensive, irreversible half of this endpoint, so nothing reaches it
   * until the caller has been counted. */
  const iph = await ipHash(req);

  // Applying twice is a person who lost their link, not a new ambassador.
  // Send the console key again rather than minting a second code against the
  // same audience — two codes for one person splits their own earnings.
  const existing = await env.DB.prepare(
    'SELECT id, code, console_key, name, key_sent_at FROM num_ambassadors WHERE LOWER(email) = ?1',
  ).bind(email).first().catch(() => null);

  const site = env.SITE || 'https://itsnum.com';
  if (existing?.console_key) {
    /* A PER-ACCOUNT COOLDOWN, not just a per-IP one. The IP limit alone is
       no defence here: the attack is distributed by nature — any machine can
       ask for somebody else's key to be resent. One resend an hour is
       generous for a person who lost a link and useless as a weapon. */
    const last = existing.key_sent_at ? Date.parse(existing.key_sent_at) : 0;
    if (Number.isFinite(last) && Date.now() - last < 60 * 60 * 1000) {
      // The SAME answer as a successful resend. Saying "too soon" would
      // confirm the address belongs to an ambassador just as loudly.
      return J({ ok: true, existing: true, emailed: true });
    }
    await env.DB.prepare('UPDATE num_ambassadors SET key_sent_at = ?2 WHERE id = ?1')
      .bind(existing.id, nowIso()).run().catch(() => {});
    const sent = await mailKey(D, env, { email, name: existing.name, key: existing.console_key, code: existing.code, site, again: true });
    return J({ ok: true, existing: true, emailed: sent });
  }

  /* FAILS CLOSED. This used to `.catch(() => null)` and then read the miss
     as zero, so one bad read disabled the only limit on how many ambassador
     accounts one network could mint. A throttle that switches itself off
     when the database is unhappy is not a throttle. */
  let madeToday;
  try {
    madeToday = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM num_ambassadors
        WHERE agreed_ip = ?1 AND created_at > datetime('now','-1 day')`,
    ).bind(iph).first();
  } catch {
    return J({ ok: false, error: 'try_again' }, 503);
  }
  if (Number(madeToday?.n ?? Infinity) >= AMB_JOINS_PER_NETWORK_PER_DAY) {
    return J({ ok: false, error: 'slow_down' }, 429);
  }

  const code = await mintAmbCode(env, name);
  const ambId = 'a_' + token(10);
  const consoleKey = token(20);
  const ts = nowIso();

  await env.DB.batch([
    // owner_type 'ambassador' is the category the codes table already
    // permitted and nothing had ever used. linkReferral resolves it one hop
    // to the member account behind it — see that file, and do not add a
    // second kind of ambassador code.
    env.DB.prepare(
      `INSERT INTO num_referral_codes
         (code,owner_type,owner_id,university_id,reward_cs,reward_referee_cs,
          max_conversions,max_reward_total_cs,active,expires_at,created_at)
       VALUES (?1,'ambassador',?2,NULL,0,0,NULL,NULL,1,NULL,?3)`,
    ).bind(code, ambId, Math.floor(Date.now() / 1000)),
    env.DB.prepare(
      `INSERT INTO num_ambassadors
         (id,name,email,phone,country,city,code,bio,status,listed,console_key,
          terms_version,agreed_at,agreed_ip,applied_note,niches_json,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'applied',0,?9,?10,?11,?12,?13,?14,?11,?11)`,
    ).bind(ambId, name, email, e164(b.phone), clean(b.country, 80) || country(req),
      clean(b.city, 80), code, clean(b.bio, 400), consoleKey,
      AMB_TERMS_VERSION, ts, iph, clean(b.note, 600), JSON.stringify(niches)),
    // The channels they declared. `followers_claimed` only — this endpoint
    // cannot reach `followers_verified`, and that is the point of the split.
    ...socials.map((r) => env.DB.prepare(
      `INSERT INTO num_ambassador_socials
         (id, ambassador_id, platform, handle, url, followers_claimed, claimed_at, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?7)`,
    ).bind(id('soc'), ambId, r.platform, r.handle, r.url, r.followers, ts)),
  ]);

  // If they are already a member, the link is payable from this second.
  const linked = await connectMember(env, { id: ambId, email, member_id: null });
  const emailed = await mailKey(D, env, {
    email, name, key: consoleKey, code, site, payable: Boolean(linked), socials, niches,
  });

  return J({
    ok: true,
    code,
    link: site + '/r/' + code,
    console: site + '/amb/?k=' + consoleKey,
    payable: Boolean(linked),
    // Honest, not hopeful. The console link is the entire account and is never
    // put on a page, so "emailed: true" after a failed send is the difference
    // between an ambassador and a stranded row.
    emailed,
    socials: socials.length,
    niches,
  });
}

/**
 * The one email this file sends: their key.
 *
 * It is the whole account. Sent once on application and again on any repeat
 * application, and never shown on a page they might not still be looking at.
 * Failure to send is swallowed — an application that is already written must
 * not be reported as failed because a mail provider was slow.
 */
async function mailKey(D, env, { email, name, key, code, site, again = false, payable = false, socials = [], niches = [] }) {
  if (!D?.sendBatch) return false;
  const first = String(name || '').split(' ')[0] || 'there';
  const link = site + '/r/' + code;
  const console_ = site + '/amb/?k=' + key;
  /* Read back what they typed. Somebody who filled in three channels and six
   * niches and then got an email mentioning none of them cannot tell whether
   * any of it arrived — and the one moment they will fix a typo'd handle is
   * the minute after they sent it. */
  const nicheLabel = new Map(NICHES.map((n) => [n.key, n.label]));
  const summary = again ? '' : [
    ...socials.map((x) => `  ${x.platform} @${x.handle}${x.followers ? ` — about ${Number(x.followers).toLocaleString('en-GB')}, as you declared it` : ''}`),
    niches.length ? `  You post about: ${niches.map((k) => nicheLabel.get(k) ?? k).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  try {
    await D.sendBatch(env, [{
      to: [email],
      subject: again ? 'Your NUM ambassador link, again' : 'Your NUM ambassador link',
      text: `${first},

${again ? 'Here is your link and console again — nothing has changed and nothing was created twice.' : 'Your link works from right now. A person reads every application, and being accepted is what opens the offers and lets businesses find you — we will come back to you on that. Two things in the meantime, both below.'}

YOUR LINK
${link}
Everyone who joins NUM through it is yours. You earn 20% of what NUM earns from them, for as long as you are both active, paid into your NUM wallet as Stars you can cash out.

YOUR CONSOLE
${console_}
That link IS your account — there is no password. Keep it, and do not post it.
${payable ? '' : `
ONE THING FIRST: your share is paid into a NUM member wallet and we could not find yours. Open NUM, verify this same email address in the app, and your link can pay. Until then it counts arrivals and pays nobody, and we would rather say so now than let you find out in three months.
`}
${summary ? `WHAT YOU TOLD US
${summary}
If any of that is wrong, fix it in your console — it is what we match offers against.

` : ''}What is real today: the free concierge in 39 countries, venue perks, activities and tickets, luggage storage, and the Friday giveaway. What is not yet: hotels, car hire, and the VIP host services — they are built and not switched on, so please do not promise them.

Reply to this email and a person answers.

— NUM`,
      tags: [{ name: 'kind', value: 'amb_key' }],
    }]);
    return true;
  } catch (e) {
    /* ── A SWALLOWED FAILURE HERE LOCKS SOMEBODY OUT ──────────────────
     *
     * This email IS the account: the console link is the whole credential
     * and is deliberately never shown on a page. So a send that fails and
     * is only console.warn'd leaves a person with an ambassador row, a
     * referral code and no way to reach either — while the response tells
     * them it was emailed. Num's own bounce rate on itsnum.com was 20.9%
     * the day before this was written, so this is not a rare branch.
     *
     * The send still must not fail the application — the row is already
     * written and reporting it as failed would have them apply twice. What
     * changes is that the caller learns the truth and can say so. */
    console.warn('[ambassador mail]', e?.message ?? e);
    return false;
  }
}

/**
 * GET  /api/admin/milestones?key=ADMIN  — who NUM owes a bonus, oldest first.
 * POST /api/admin/milestones?key=ADMIN  — { id, state, reward_kind, reward_note }
 *
 * ── WHY A DISCRETIONARY REWARD NEEDS AN ENDPOINT ────────────────────────
 *
 * Nothing is guaranteed at a milestone — that is the design. Which means the
 * thing that can go wrong is not NUM choosing something cheap, it is NUM
 * choosing NOTHING because nobody knew there was a choice to make. An
 * ambassador reaches twenty-five, hears nothing for three weeks, and tells
 * the other ambassadors the milestones are decoration. That costs more than
 * any prize.
 *
 * So this is the list, with `days_waiting` on every row, and it is the
 * answer to "are we behind on anybody". Marking one `sent` with a note is
 * what puts the reward on the ambassador's own screen — until then their
 * console says "reached — NUM will be in touch", which is true, and stays
 * true only for as long as somebody reads this list.
 */
export async function ambMilestonesAdmin(req, env, url, D) {
  const { J, clean, readJSON } = D;
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return J({ ok: false }, 401);

  const { openMilestones } = await import('./milestones.mjs');

  if (req.method === 'GET') {
    const open = await openMilestones(env);

    /* ── WHAT THE ROW SAYS versus WHAT COUNTS TODAY ───────────────────────
     *
     * A milestone row records the rung as it was when it fired. The
     * anti-gaming rules landed on 19 Sep, so a rung banked before them — or
     * one banked on signups that have since been found to share a device —
     * can name a number that no longer holds.
     *
     * Rather than rewrite history, every row in the queue is shown beside a
     * FRESH count. Whoever is about to send somebody a trip sees "reached
     * 25, counts 11 today" and asks the obvious question. A queue that
     * cannot be checked is how a discretionary reward gets handed to a farm. */
    const { qualityFor } = await import('./tokyodraw.mjs');
    for (const row of open) {
      const m = await env.DB.prepare('SELECT member_id FROM num_ambassadors WHERE id = ?1')
        .bind(row.ambassador_id).first().catch(() => null);
      if (!m?.member_id) { row.counts_today = null; row.check = 'no NUM account linked'; continue; }
      try {
        const q = await qualityFor(env, m.member_id);
        row.counts_today = q.counted;
        row.joined_total = q.joined;
        row.check = q.counted >= row.tier ? null
          : `reached ${row.tier}, but only ${q.counted} of ${q.joined} signups count today — check before sending anything`;
      } catch {
        row.counts_today = null;
        row.check = 'could not recount just now';
      }
    }

    return J({
      ok: true,
      open,
      needs_a_look: open.filter((r) => r.check).length,
      owed: open.length,
      // The number worth looking at. One person waiting a month is worse
      // than ten waiting a day, and a raw count hides that.
      longest_wait_days: open.length ? Math.max(...open.map((r) => Number(r.days_waiting || 0))) : 0,
      how: 'POST { id, state: chosen|sent|declined, reward_kind, reward_note }. '
        + 'reward_note is shown to the ambassador on their own console once state is sent.',
    });
  }

  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  let b;
  try { b = await readJSON(req, 8192); } catch { return J({ ok: false }, 400); }

  const id = clean(b.id, 60);
  const state = ['chosen', 'sent', 'declined'].includes(String(b.state)) ? String(b.state) : null;
  if (!id || !state) return J({ ok: false, error: 'id and state' }, 400);

  const res = await env.DB.prepare(
    `UPDATE num_ambassador_milestones
        SET state = ?2,
            reward_kind = COALESCE(?3, reward_kind),
            reward_note = COALESCE(?4, reward_note),
            decided_by  = COALESCE(?5, decided_by),
            chosen_at = CASE WHEN ?2 IN ('chosen','sent') AND chosen_at IS NULL THEN ?6 ELSE chosen_at END,
            sent_at   = CASE WHEN ?2 = 'sent' THEN ?6 ELSE sent_at END
      WHERE id = ?1`,
  ).bind(id, state, clean(b.reward_kind, 40) || null, clean(b.reward_note, 200) || null,
    clean(b.decided_by, 60) || null, nowIso()).run();

  if (!Number(res?.meta?.changes ?? 0)) return J({ ok: false, error: 'no such milestone' }, 404);
  return J({ ok: true, id, state });
}

/**
 * GET  /api/admin/tokyo?key=ADMIN  — the standings, and who would win.
 * POST /api/admin/tokyo?key=ADMIN  — { action:'draw', seed? } or
 *                                    { action:'free', email, name }
 *
 * ── THE DRAW IS NOT RUN BY ACCIDENT ──────────────────────────────────────
 *
 * GET shows the field and never selects anybody. POST with action 'draw' is
 * the only thing that records a result, and `INSERT OR IGNORE` on a date-keyed
 * id means running it twice in one day cannot produce a second winner.
 *
 * The response hands back the seed and the whole ticket list, because clause 8
 * of the Official Rules promises the result can be checked rather than taken
 * on trust, and a promise that requires somebody to go digging in a database
 * is not one that will be kept.
 */
export async function tokyoAdmin(req, env, url, D) {
  const { J, clean, readJSON } = D;
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return J({ ok: false }, 401);

  const { standings, runTokyoDraw, grantFreeEntry, LADDER, PRIZE, CAMPAIGN }
    = await import('./tokyodraw.mjs');

  if (req.method === 'GET') {
    const rows = await standings(env);
    return J({
      ok: true,
      campaign: CAMPAIGN,
      prize: PRIZE,
      ladder: LADDER,
      people: rows.length,
      tickets: rows.reduce((n, r) => n + r.entries, 0),
      standings: rows.slice(0, 200),
      // Said plainly so nobody has to infer it from an empty array.
      note: rows.length ? null
        : `Nobody holds an entry yet. The first rung is ${LADDER.first} signups, and the free route is the Enter button in the app.`,
      how: "POST { action: 'draw', seed? } to run it, or { action: 'free', email, name } to grant a postal entry.",
    });
  }

  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  let b;
  try { b = await readJSON(req, 8192); } catch { return J({ ok: false }, 400); }

  if (b.action === 'free') {
    // The mail-in route from clause 3. Granted by hand because it arrives by
    // hand, and it must work for somebody with no NUM account at all.
    const email = clean(b.email, 160).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return J({ ok: false, error: 'email' }, 400);
    const r = await grantFreeEntry(env, {
      email, name: clean(b.name, 120), source: 'post', note: clean(b.note, 200),
    });
    return J(r);
  }

  if (b.action === 'draw') {
    const r = await runTokyoDraw(env, { seed: clean(b.seed, 120) || null, winners: 1 });
    return J(r, r.ok ? 200 : 409);
  }

  return J({ ok: false, error: 'action' }, 400);
}

/**
 * GET  /api/admin/holds?key=ADMIN  — referral money waiting on a person.
 * POST /api/admin/holds?key=ADMIN  — { ref, release: true|false, by }
 *
 * The queue that makes the hold honest. `referrer_verified` and
 * `member_verified` are on every row because they are the question: two
 * 5arz-verified accounts are two people and the money should be released;
 * one verified and one not, on one device, is the case the hold exists for.
 */
export async function holdsAdmin(req, env, url, D) {
  const { J, clean, readJSON } = D;
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return J({ ok: false }, 401);

  const { openHolds, decideHold } = await import('../worker/memberreferral.mjs');

  if (req.method === 'GET') {
    const held = await openHolds(env);
    return J({
      ok: true,
      held,
      owed: held.length,
      stars_held: held.reduce((n, h) => n + Number(h.stars || 0), 0),
      longest_wait_days: held.length ? Math.max(...held.map((h) => Number(h.days_waiting || 0))) : 0,
      how: "POST { ref, release: true } pays it under the original settlement ref, so it cannot pay twice. "
        + "release: false refuses it. Two 5arz-verified accounts are two people — release those.",
      note: held.length ? null : 'Nothing is being held.',
    });
  }

  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  let b;
  try { b = await readJSON(req, 8192); } catch { return J({ ok: false }, 400); }
  const ref = clean(b.ref, 200);
  if (!ref) return J({ ok: false, error: 'ref' }, 400);
  if (typeof b.release !== 'boolean') {
    return J({ ok: false, error: 'release', why: 'Say release: true or release: false. There is no default for somebody\'s money.' }, 400);
  }
  const r = await decideHold(env, { ref, release: b.release, by: clean(b.by, 60) || 'ops' });
  return J(r, r.ok ? 200 : 404);
}
