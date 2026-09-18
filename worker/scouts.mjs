/**
 * NUM · scouts — the people who walk a street and sign shops up.
 *
 * ── WHAT WAS ALREADY HERE, AND WHAT WAS NOT ──────────────────────────────
 *
 * The hard half was done months ago and never used. `migrations/0006_scouts.sql`
 * defines num_scouts, num_scout_places and num_scout_earnings with the
 * economics enforced by the database rather than by code:
 *
 *   · A finder's fee is released ONLY after that business has produced its
 *     first `finder_gate_minor` of real revenue to NUM. Paying on signature
 *     would make the optimal scout strategy "collect fifty signatures on one
 *     street", which spends real money to buy listings nobody uses.
 *   · `CHECK (amount_minor <= gross_minor)` — nothing owed may ever exceed
 *     what NUM actually collected.
 *   · `UNIQUE (place_id)` on num_scout_places — first scout wins, and a second
 *     one gets a constraint violation rather than a duplicate payout.
 *   · `UNIQUE (scout_place_id, kind, period)` — the monthly job is safe to run
 *     twice.
 *   · Every rate is COPIED onto the row at introduction. A scout who joined in
 *     August is owed August's terms, whatever the programme does later.
 *
 * What did not exist was any code at all. This file is that code.
 *
 * ── SIGN-UP IS OPEN, WHICH CHANGES EVERYTHING ────────────────────────────
 *
 * Dre's call, 15 Sep 2026: anyone can enrol. That is the right growth choice
 * and it means this programme is exposed to the whole internet, so the fraud
 * controls below are not defensive decoration — they are the only thing
 * standing between an open form and an open liability:
 *
 *   · MONTHLY_CLAIM_CAP limits how many introductions one scout can bank in a
 *     month. The schema left it NULL meaning "programme default"; that default
 *     lives here and is applied on every write, because a NULL that nobody
 *     interprets is not a cap.
 *   · A scout cannot introduce a place already owned, already introduced, or
 *     already claimed by the scout themselves.
 *   · Nothing is earned at introduction. Introduced is a CLAIM, not money.
 *
 * ── AND THE WORD THIS FILE REFUSES TO MISUSE ─────────────────────────────
 *
 * An INTRODUCTION IS NOT A SIGN-UP AND A SIGN-UP IS NOT EARNINGS. A scout
 * dashboard that shows "23 businesses" next to a dollar figure, where 23 is
 * introductions and the dollars require revenue that has not happened, is a
 * dashboard that creates an argument in about six weeks. Every count returned
 * from here is named for its state, and `owed_minor` is read from
 * num_scout_earnings rather than computed from anything hopeful.
 */
import { isAdmin } from './console.mjs';
// The same phone reader the claim flow uses, region-aware and already carrying
// the trunk-zero rule that cost a real member a working number in August.
// Reused rather than rewritten: two phone parsers disagree eventually.
import { normalisePhone } from '../claim/verify.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;

/**
 * How many introductions one scout may bank in a calendar month.
 *
 * The schema allows NULL to mean "programme default" and deliberately does NOT
 * treat NULL as unlimited — but a default that lives nowhere is not a cap, so
 * it lives here and is applied on every introduction.
 *
 * Sixty is roughly two a day every day. A real person walking LA does not beat
 * it; somebody scripting a form does, immediately, which is the point.
 */
export const MONTHLY_CLAIM_CAP = 60;

/** The terms version a new scout agrees to. Bumping this does not move anybody. */
export const TERMS_VERSION = 'v1';

/**
 * What an expert earns when somebody they referred earns.
 *
 * 1000 bps = 10% OF THE RECRUIT'S OWN EARNINGS — not of NUM's gross, and not
 * taken off the recruit. If the recruit's finder fee is $5.00, the referrer
 * accrues $0.50 and the recruit still gets $5.00.
 *
 * ONE LEVEL. The referrer's own referrer earns nothing on this. Nothing in
 * this file walks referred_by_scout_id more than once, and a test asserts it,
 * because the distance between a two-level override and the schemes the FTC
 * prosecutes is exactly one recursive query somebody adds in a hurry.
 *
 * Locked onto the recruit's row at sign-up and onto each place at
 * introduction, like every other rate here. Changing this number moves nobody
 * who has already signed up — which is also why it must be right BEFORE the
 * first expert enrols, not after.
 */
export const REFERRER_SHARE_BPS = 1000;

/**
 * How long the override runs, from the recruit's sign-up.
 *
 * It applies to places the recruit INTRODUCES inside this window; one of
 * those places activating later still pays, because the introduction is the
 * thing that was referred. Shorter than the recruit's own 24-month term on
 * purpose: a trailing liability that outlives the relationship it came from
 * is how a referral programme quietly becomes an annuity.
 */
export const REFERRER_TERM_MONTHS = 12;

/**
 * Code alphabet, chosen for a card someone reads aloud in a noisy bar.
 *
 * No 0/O, no 1/I/L. A scout code gets printed on an NFC card and then, when
 * the tap does not work, spelled out over the counter — so the alphabet has
 * to survive being said out loud and typed by somebody else.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;

export function mintCode(random = crypto.getRandomValues.bind(crypto)) {
  const bytes = random(new Uint8Array(CODE_LENGTH));
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/**
 * Normalise a typed code, and reject one that could not have been minted.
 *
 * The alphabet already excludes 0, 1, O, I and L — that is the whole reason it
 * exists, so a code carrying one of them was misread or invented and there is
 * no honest way to guess which character was meant. An earlier version of this
 * function tried to be helpful by mapping O onto 0 and I onto 1; since neither
 * 0 nor 1 is in the alphabet either, it produced codes that can never exist
 * and turned a typo into a silent lookup miss.
 *
 * So: strip punctuation and spaces, uppercase, and require every character to
 * be one we actually mint. A wrong code fails loudly enough to retype.
 */
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{4,12}$`);

export function normaliseCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return CODE_RE.test(s) ? s : null;
}

export const VALID_STATES = Object.freeze(['introduced', 'verified', 'activated', 'rejected', 'void']);

/** What each state means, in the words the dashboard is allowed to use. */
export const STATE_MEANING = Object.freeze({
  introduced: 'You brought them. Nothing is owed yet.',
  verified: 'They confirmed the listing is theirs. Still nothing owed — the fee waits for revenue.',
  activated: 'They have produced revenue and your finder fee is released. The share clock started.',
  rejected: 'Not accepted — a duplicate, or the business said no.',
  void: 'Reversed after the fact.',
});

/* ── the fields, cleaned once, on the server ───────────────────────────────
 *
 * The page does the same tidying as you type, because a field that fixes
 * itself feels better than one that scolds you. None of that is trusted here:
 * the browser is a convenience and this is the record.
 */

/**
 * A typed name, tidied — never "corrected".
 *
 * Case is fixed only when somebody clearly did not choose it: all-lower or
 * all-upper. "mcdonald" is left as typed rather than guessed into McDonald or
 * Mcdonald, and "van der Berg", "O'Neill" and "bell hooks" survive untouched,
 * because a programme that renames people is worse than one with a lowercase
 * row in it.
 */
export function tidyName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const chosen = s !== s.toLowerCase() && s !== s.toUpperCase();
  if (chosen) return s;
  // All-caps is lowered first, or the title-case pass below has nothing to
  // match and CAPS LOCK survives into the row.
  return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
}

/** Domains people mean when they typo. Suggested, never silently applied. */
const MAIL_TYPOS = Object.freeze({
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.cm': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.co': 'hotmail.com',
  'yahoo.co': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com',
  'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'iclod.com': 'icloud.com',
  'icloud.co': 'icloud.com', 'protonmai.com': 'protonmail.com',
});

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Lower-cased and trimmed, with a SUGGESTION when the domain looks mistyped.
 *
 * The suggestion is returned, never substituted. Silently rewriting somebody's
 * email address sends their code, their NDA and eventually their money to an
 * address they never typed, and they find out by never hearing from us.
 */
export function tidyEmail(raw) {
  const email = String(raw || '').trim().toLowerCase().replace(/^mailto:/, '');
  const valid = EMAIL_RE.test(email);
  const domain = valid ? email.slice(email.lastIndexOf('@') + 1) : null;
  const fixed = domain && MAIL_TYPOS[domain];
  return {
    email,
    valid,
    suggestion: fixed ? `${email.slice(0, email.lastIndexOf('@') + 1)}${fixed}` : null,
  };
}

/**
 * Who referred this person, split into what can carry money and what cannot.
 *
 * A valid, active expert code resolves to that expert and is the only thing
 * an override may ever attach to. Anything else — "Dre", "instagram", a code
 * for somebody paused — is kept verbatim as a note so the attribution is not
 * lost, and is explicitly NOT a payable relationship. `why` explains a code
 * that did not resolve, so the page can say so instead of dropping it.
 */
export async function resolveReferrer(env, raw, { selfEmailLc = null } = {}) {
  const typed = clip(String(raw || '').trim(), 120);
  if (!typed) return { scoutId: null, note: null, why: null };

  const code = normaliseCode(typed);
  if (!code) return { scoutId: null, note: typed, why: null };

  const ref = await env.DB.prepare(
    'SELECT id, name, code, status, email_lc FROM num_scouts WHERE code=?1',
  ).bind(code).first();

  if (!ref) return { scoutId: null, note: typed, why: 'that code is not one of ours' };
  if (ref.status !== 'active') {
    return { scoutId: null, note: typed, why: `that expert is ${ref.status}` };
  }
  // Referring yourself is the first thing anybody tries.
  if (selfEmailLc && ref.email_lc === selfEmailLc) {
    return { scoutId: null, note: null, why: 'you cannot refer yourself' };
  }
  return { scoutId: ref.id, note: null, why: null, name: ref.name, code: ref.code };
}

export async function scoutByCode(env, code) {
  const c = normaliseCode(code);
  if (!c || !env?.DB) return null;
  return env.DB.prepare(
    "SELECT * FROM num_scouts WHERE code=?1 AND status='active'",
  ).bind(c).first();
}

export async function scoutForMember(env, memberId) {
  if (!memberId || !env?.DB) return null;
  return env.DB.prepare('SELECT * FROM num_scouts WHERE member_id=?1').bind(memberId).first();
}

/**
 * Enrol a scout. Open to anyone, which is why every guard below exists.
 *
 * The terms version and the moment of agreement are recorded on the row, with
 * the IP, because this is a contractor agreement about money. "They agreed"
 * with no version and no timestamp is not a record, it is a memory.
 */
export async function enrol(env, {
  name, email, phone = null, country = null, memberId = null, ip = null,
  referredBy = null, termsVersion = TERMS_VERSION, now = new Date(),
} = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  const nm = clip(tidyName(name), 80);
  const mail = tidyEmail(email);
  const em = clip(mail.email, 160);
  if (!nm) return { ok: false, why: 'name required' };
  if (!mail.valid) return { ok: false, why: 'a real email is required' };

  // A phone that was typed but could not be read is refused rather than
  // dropped. Storing null here means "they gave us no number", and the day
  // somebody needs to reach an expert about money is the wrong day to find
  // out that is not what it meant.
  let tel = null;
  if (phone != null && String(phone).trim() !== '') {
    tel = normalisePhone(phone, country);
    if (!tel) return { ok: false, why: 'that phone number did not look right — add the country code, or leave it blank' };
  }

  const existing = await env.DB.prepare('SELECT id, code, status FROM num_scouts WHERE email_lc=?1').bind(em).first();
  // Returning the existing code rather than erroring: somebody who fills the
  // form twice wants their code, not a lecture.
  if (existing) {
    return existing.status === 'active'
      ? { ok: true, already: true, id: existing.id, code: existing.code }
      : { ok: false, why: `this account is ${existing.status}` };
  }

  // Terms must exist before anybody can agree to them. Agreeing to a version
  // with no recorded body is agreeing to nothing.
  const terms = await env.DB.prepare('SELECT version FROM num_scout_terms WHERE version=?1').bind(termsVersion).first();
  if (!terms) return { ok: false, why: 'terms are not published yet' };

  // Who sent them. A resolved expert is the only form an override may attach
  // to; anything else is kept as a note and carries no money. Resolved BEFORE
  // the insert so the rate and the end date are written in the same row as
  // the relationship they describe — there is no second write that could fail
  // and leave an expert referred by nobody.
  const ref = await resolveReferrer(env, referredBy, { selfEmailLc: em });
  const ends = new Date(now.getTime());
  ends.setUTCMonth(ends.getUTCMonth() + REFERRER_TERM_MONTHS);

  // Retry on collision rather than trusting 31^6 — a duplicate code would hand
  // one scout another scout's businesses, which is the worst bug this file
  // could have.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = mintCode();
    const id = uid('sc');
    try {
      await env.DB.prepare(
        `INSERT INTO num_scouts (id, member_id, name, email, email_lc, phone, country, code,
           terms_version, agreed_at, agreed_ip, monthly_claim_cap,
           referred_by_scout_id, referred_by_note, referrer_share_bps, referrer_ends_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`,
      ).bind(id, memberId, nm, em, em, tel, clip(country, 2), code,
        termsVersion, now.toISOString(), clip(ip, 64), MONTHLY_CLAIM_CAP,
        ref.scoutId, ref.note,
        ref.scoutId ? REFERRER_SHARE_BPS : 0,
        ref.scoutId ? ends.toISOString() : null).run();
      return {
        ok: true, id, code, termsVersion,
        phone: tel,
        emailSuggestion: mail.suggestion,
        referredBy: ref.scoutId ? { name: ref.name, code: ref.code } : null,
        referrerNote: ref.note,
        referrerWhy: ref.why,
      };
    } catch (err) {
      if (!/UNIQUE/i.test(String(err?.message))) return { ok: false, why: 'could not enrol' };
      // a code collision — go round again
    }
  }
  return { ok: false, why: 'could not mint a code' };
}

/** How many introductions this scout has banked this month. */
export async function claimsThisMonth(env, scoutId, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) n FROM num_scout_places
      WHERE scout_id=?1 AND state <> 'void' AND substr(introduced_at,1,7)=?2`,
  ).bind(scoutId, month).first();
  return Number(row?.n ?? 0);
}

/**
 * A scout brings a business.
 *
 * Creates the claim row in `introduced`. Nothing is owed. The UNIQUE on
 * place_id does the first-come-wins enforcement, so the check below is a
 * politeness — the database is the rule.
 */
export async function introduce(env, {
  scoutId, placeId, bizName, dest = null, country = null, lat = null, lng = null, now = new Date(),
} = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  const scout = await env.DB.prepare("SELECT * FROM num_scouts WHERE id=?1 AND status='active'").bind(scoutId).first();
  if (!scout) return { ok: false, why: 'not an active Num Expert' };

  const pid = clip(placeId, 60);
  const nm = clip(String(bizName || '').trim(), 120);
  if (!pid || !nm) return { ok: false, why: 'place and name required' };

  // Already spoken for. Reported as taken rather than as an error, because the
  // scout standing in the shop needs to know it is not theirs, not that
  // something broke.
  const taken = await env.DB.prepare('SELECT scout_id, state FROM num_scout_places WHERE place_id=?1').bind(pid).first();
  if (taken) {
    return taken.scout_id === scoutId
      ? { ok: true, already: true, why: 'you already introduced this one' }
      : { ok: false, why: 'another Num Expert introduced this business first' };
  }

  // A business already on Num is not a find. Paying for a customer we already
  // had is leakage, not growth — the same rule bizreferral.mjs applies.
  const owned = await env.DB.prepare(
    'SELECT place_id FROM num_place_owners WHERE place_id=?1 AND revoked_at IS NULL',
  ).bind(pid).first();
  if (owned) return { ok: false, why: 'this business is already on Num' };

  const cap = Number(scout.monthly_claim_cap ?? MONTHLY_CLAIM_CAP);
  const used = await claimsThisMonth(env, scoutId, now);
  if (used >= cap) return { ok: false, why: `you have hit this month's cap of ${cap}`, cap, used };

  // The override, stamped onto the place or not at all.
  //
  // Read straight off this scout's row — ONE hop, never walked further. The
  // referrer's own referrer is not consulted here or anywhere else, which is
  // what keeps this a referral bonus rather than a chain.
  //
  // Outside the term, the place is simply introduced with no referrer: what a
  // place owes is then readable off the place forever, with no date arithmetic
  // at payout time and no way for a row to start owing somebody years later.
  const inTerm = scout.referred_by_scout_id
    && (!scout.referrer_ends_at || now.toISOString() <= scout.referrer_ends_at);
  const refScout = inTerm ? scout.referred_by_scout_id : null;
  const refBps = inTerm ? Number(scout.referrer_share_bps ?? 0) : 0;

  const id = uid('sp');
  try {
    await env.DB.prepare(
      `INSERT INTO num_scout_places
         (id, scout_id, place_id, biz_name, dest, country, lat, lng, state,
          finder_gate_minor, finder_cents, share_bps, sub_share_bps, introduced_at,
          referrer_scout_id, referrer_share_bps)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'introduced',?9,?10,?11,?12,?13,?14,?15)`,
    ).bind(id, scoutId, pid, nm, clip(dest, 60), clip(country, 2),
      lat == null ? null : Number(lat), lng == null ? null : Number(lng),
      scout.finder_gate_minor, scout.finder_cents, scout.share_bps, scout.sub_share_bps,
      now.toISOString(), refScout, refBps).run();
    // 'First business signed up' is reached here — the only milestone that
    // counts an introduction, and it is deliberately the smallest one.
    try {
      const { award } = await import('./scoutmilestones.mjs');
      await award(env, scoutId, { now });
    } catch (e) {
      console.log('milestones', String(e?.message ?? e).slice(0, 200));
    }
    return { ok: true, id, state: 'introduced', owed: 0, note: STATE_MEANING.introduced };
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) {
      return { ok: false, why: 'another Num Expert introduced this business first' };
    }
    return { ok: false, why: 'could not record the introduction' };
  }
}

/** The business confirmed the listing. Still earns nothing. */
export async function markVerified(env, { placeId, claimId = null, now = new Date() } = {}) {
  if (!env?.DB || !placeId) return { ok: false };
  const row = await env.DB.prepare(
    "SELECT id, state FROM num_scout_places WHERE place_id=?1 AND state='introduced'",
  ).bind(placeId).first();
  if (!row) return { ok: false, why: 'no introduction waiting on this place' };
  await env.DB.prepare(
    "UPDATE num_scout_places SET state='verified', verified_at=?2, claim_id=COALESCE(?3, claim_id) WHERE id=?1",
  ).bind(row.id, now.toISOString(), claimId).run();
  return { ok: true, id: row.id, state: 'verified', owed: 0, note: STATE_MEANING.verified };
}

/**
 * Money actually arrived from this business. This is the only path that pays.
 *
 * Adds to the running revenue total and, the first time that total crosses the
 * gate, flips the row to `activated`, starts the term clock and accrues the
 * finder fee against the revenue that opened the gate — which is what keeps
 * `amount_minor <= gross_minor` true rather than merely hoped for.
 */
export async function recordRevenue(env, { placeId, amountMinor, now = new Date() } = {}) {
  if (!env?.DB || !placeId) return { ok: false };
  const amount = Math.max(0, Math.round(Number(amountMinor) || 0));
  if (!amount) return { ok: false, why: 'nothing to record' };

  const row = await env.DB.prepare(
    "SELECT * FROM num_scout_places WHERE place_id=?1 AND state IN ('introduced','verified','activated')",
  ).bind(placeId).first();
  if (!row) return { ok: false, why: 'this place has no live scout claim' };

  const before = Number(row.revenue_minor ?? 0);
  const after = before + amount;
  const gate = Number(row.finder_gate_minor ?? 0);
  const crossing = before < gate && after >= gate && row.state !== 'activated';

  const writes = [
    env.DB.prepare('UPDATE num_scout_places SET revenue_minor=?2 WHERE id=?1').bind(row.id, after),
  ];

  if (crossing) {
    const months = Number(row.term_months ?? 24);
    const ends = new Date(now.getTime());
    ends.setUTCMonth(ends.getUTCMonth() + (Number.isFinite(months) && months > 0 ? months : 24));
    writes.push(env.DB.prepare(
      "UPDATE num_scout_places SET state='activated', activated_at=?2, term_ends_at=?3 WHERE id=?1",
    ).bind(row.id, now.toISOString(), ends.toISOString()));
    const finder = Number(row.finder_cents ?? 0);
    writes.push(env.DB.prepare(
      `INSERT INTO num_scout_earnings (id, scout_id, scout_place_id, kind, gross_minor, amount_minor, state, accrued_at)
       VALUES (?1,?2,?3,'finder',?4,?5,'accrued',?6)`,
    ).bind(uid('se'), row.scout_id, row.id, after, finder, now.toISOString()));

    // And the override to whoever referred this expert, if the place carries
    // one. A SHARE OF THE RECRUIT'S FEE, ADDED — never deducted: the person
    // who did the walking is paid in full, and the override is NUM's cost of
    // having been introduced to them.
    //
    // scout_id here is the REFERRER and scout_place_id is the recruit's place,
    // so UNIQUE (scout_place_id, kind, period) still means one override per
    // place and the whole thing stays safe to run twice.
    //
    // The row is written in the same batch as the finder fee. Two writes that
    // can succeed separately are two numbers that can disagree, and the one
    // people check is the one about money.
    const refBps = Number(row.referrer_share_bps ?? 0);
    if (row.referrer_scout_id && refBps > 0 && finder > 0) {
      const override = Math.floor((finder * refBps) / 10000);
      if (override > 0) {
        writes.push(env.DB.prepare(
          `INSERT INTO num_scout_earnings (id, scout_id, scout_place_id, kind, gross_minor, amount_minor, state, accrued_at)
           VALUES (?1,?2,?3,'referrer_override',?4,?5,'accrued',?6)`,
        ).bind(uid('se'), row.referrer_scout_id, row.id, after, override, now.toISOString()));
      }
    }
  }

  await env.DB.batch(writes);

  // Milestones are checked AFTER the batch, never inside it. An award that
  // failed must not roll back money that was correctly earned, and the
  // checker is safe to run again — so the worst case here is a badge that
  // appears on the next activation instead of this one.
  if (crossing) {
    try {
      const { award } = await import('./scoutmilestones.mjs');
      await award(env, row.scout_id, { now });
      if (row.referrer_scout_id) await award(env, row.referrer_scout_id, { now });
    } catch (e) {
      console.log('milestones', String(e?.message ?? e).slice(0, 200));
    }
  }

  return {
    ok: true, state: crossing ? 'activated' : row.state, revenue_minor: after,
    activated: crossing, note: crossing ? STATE_MEANING.activated : null,
  };
}

/**
 * Everything one scout can see about their own work.
 *
 * Counts are per state and named per state. `owed_minor` comes out of
 * num_scout_earnings — never from multiplying introductions by a fee, which
 * is the number that would be wrong and motivating at the same time.
 */
export async function dashboard(env, scoutId, { now = new Date() } = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  const scout = await env.DB.prepare('SELECT * FROM num_scouts WHERE id=?1').bind(scoutId).first();
  if (!scout) return { ok: false, why: 'not a Num Expert' };

  const { results: places = [] } = await env.DB.prepare(
    `SELECT id, place_id, biz_name, dest, state, revenue_minor, finder_cents,
            introduced_at, verified_at, activated_at, term_ends_at
       FROM num_scout_places WHERE scout_id=?1 ORDER BY introduced_at DESC LIMIT 200`,
  ).bind(scoutId).all();

  const byState = {};
  for (const s of VALID_STATES) byState[s] = 0;
  for (const p of places) byState[p.state] = (byState[p.state] ?? 0) + 1;

  const { results: earnings = [] } = await env.DB.prepare(
    `SELECT kind, state, currency, SUM(amount_minor) AS total
       FROM num_scout_earnings WHERE scout_id=?1 GROUP BY kind, state, currency`,
  ).bind(scoutId).all();

  const money = { accrued_minor: 0, payable_minor: 0, paid_minor: 0 };
  for (const e of earnings) {
    const key = `${e.state}_minor`;
    if (key in money) money[key] += Number(e.total ?? 0);
  }

  // Friends, from the member referral programme — the same person, the other
  // half of what they brought in. Read only if they have a member account.
  let friends = { count: 0, note: 'Not linked to a Num account yet, so friend referrals are not counted here.' };
  if (scout.member_id) {
    try {
      const row = await env.DB.prepare(
        'SELECT COUNT(*) n FROM num_referral_conversions WHERE referrer_id=?1',
      ).bind(scout.member_id).first();
      friends = { count: Number(row?.n ?? 0), note: null };
    } catch {
      friends = { count: 0, note: 'Friend referrals could not be read just now.' };
    }
  }

  // The people they brought in, and what that has actually paid.
  //
  // Counted and named separately from their own businesses on purpose. A
  // dashboard that adds "3 experts you referred" into the same number as "12
  // businesses you signed up" is describing two different kinds of work with
  // one figure, and the override is the smaller, slower one — showing it
  // merged would flatter it.
  const { results: recruits = [] } = await env.DB.prepare(
    `SELECT name, code, created_at FROM num_scouts
      WHERE referred_by_scout_id=?1 ORDER BY created_at DESC LIMIT 100`,
  ).bind(scoutId).all().catch(() => ({ results: [] }));

  const overrideRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM num_scout_earnings
      WHERE scout_id=?1 AND kind='referrer_override' AND state <> 'void'`,
  ).bind(scoutId).first().catch(() => null);

  const referrals = {
    count: recruits.length,
    people: recruits.map((r) => ({
      name: String(r.name || '').split(/\s+/)[0],
      code: r.code,
      joined: r.created_at,
    })),
    earned_minor: Number(overrideRow?.total ?? 0),
    note: recruits.length
      ? 'A share of what they earn, on top of what they are paid — never taken out of it.'
      : 'Nobody yet. Anyone who puts your code on the sign-up form shows up here.',
  };

  // What they have reached and what is next. Never worth failing a dashboard
  // over — an Expert who cannot see their money because a badge query broke
  // is a worse outcome than an Expert who cannot see a badge.
  let milestones = null;
  try {
    const { progressFor } = await import('./scoutmilestones.mjs');
    milestones = await progressFor(env, scoutId);
  } catch { /* the rest of the dashboard is unaffected */ }

  const cap = Number(scout.monthly_claim_cap ?? MONTHLY_CLAIM_CAP);
  const used = await claimsThisMonth(env, scoutId, now);

  // Paperwork. Earnings ACCRUE while it is outstanding — the work was done and
  // the claim is real — but nothing becomes payable until the NDA and the tax
  // form are accepted. Blocking accrual instead would punish somebody for a
  // form; blocking payment is what the form is actually for.
  let paperwork = { complete: false, note: null };
  try {
    const { docsComplete } = await import('./expertdocs.mjs');
    const complete = await docsComplete(env, scoutId);
    paperwork = {
      complete,
      note: complete
        ? null
        : 'Your NDA and tax form are not finished. You still earn — nothing is lost — but Num '
          + 'cannot pay out until they are done.',
    };
  } catch {
    paperwork = { complete: false, note: 'Could not check your paperwork just now.' };
  }

  // Brought in but not yet bindable to a place: leads for businesses Num holds
  // no listing for, and hosts, who are not places at all. Named separately and
  // never added to the business count — see worker/scoutintro.mjs for why they
  // are recorded but do not earn.
  let pending = { leads: 0, hosts: 0, earning: false, note: null };
  try {
    const { pendingFor } = await import('./scoutintro.mjs');
    pending = await pendingFor(env, scout.code);
  } catch { /* a count is never worth failing a dashboard over */ }

  return {
    ok: true,
    paperwork,
    pending,
    scout: { id: scout.id, name: scout.name, code: scout.code, status: scout.status, country: scout.country },
    terms: {
      version: scout.terms_version,
      finder_cents: scout.finder_cents,
      finder_gate_minor: scout.finder_gate_minor,
      share_bps: scout.share_bps,
      sub_share_bps: scout.sub_share_bps,
      term_months: scout.term_months,
      referrer_share_bps: scout.referrer_share_bps ?? 0,
      referrer_ends_at: scout.referrer_ends_at ?? null,
      // Said in the response, not left to the page to remember.
      note: 'These are the terms you agreed to and they do not change for you if the programme changes.',
    },
    businesses: { total: places.length, byState, meaning: STATE_MEANING, list: places },
    referrals,
    milestones,
    friends,
    // The wallet, in the three states money actually moves through, each named
    // for what it means rather than left to the page to interpret.
    //
    // `blocked` is the honest part: earnings accrue while the paperwork is
    // outstanding — the work was done — but nothing becomes payable until the
    // NDA and tax form are accepted. Saying so beside the number is what stops
    // "accrued" reading as "coming on Friday".
    money: {
      ...money,
      total_minor: money.accrued_minor + money.payable_minor + money.paid_minor,
      blocked: !paperwork.complete && (money.accrued_minor + money.payable_minor) > 0
        ? 'Your NDA and tax form are not finished, so nothing can be paid out yet. Nothing is lost — it waits for you.'
        : null,
      meaning: {
        accrued: 'Earned and recorded. Waiting on your paperwork, or on the next payout run.',
        payable: 'Cleared to be paid.',
        paid: 'Already sent.',
      },
      note: 'Earned from businesses that have actually produced revenue. An introduction on its own is not money.',
    },
    cap: { monthly: cap, used, left: Math.max(0, cap - used) },
  };
}

/**
 * GET /s/CODE — what an NFC card points at.
 *
 * This USED to 302 to /claim. That was wrong twice over: it assumed everyone
 * who taps a card is a business owner, and it never reached the apex at all
 * (the route lived only on app.itsnum.com, so itsnum.com/s/FARMER 404'd from
 * the day the first card was printed). It now renders a real page with a door
 * for each of the three people who tap it. See worker/scoutpage.mjs.
 */
export async function handleScoutLink(request, env, code) {
  const { handleScoutLanding } = await import('./scoutpage.mjs');
  return handleScoutLanding(request, env, code);
}

/** Read the attribution a card left behind, request-first then cookie. */
export function scoutCodeFrom(request, body = {}) {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('scout') || body?.scout || body?.ref || null;
  if (fromQuery) return normaliseCode(fromQuery);
  const cookie = request.headers.get('cookie') || '';
  const m = /(?:^|;\s*)num_scout=([^;]+)/.exec(cookie);
  return m ? normaliseCode(m[1]) : null;
}

export async function handleScouts(request, env, path, origin) {
  const p = path || '/';

  if (p === '/enrol' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ip = request.headers.get('cf-connecting-ip');
    // The referrer can arrive three ways and they are tried in the order of
    // how deliberate each one is: what they typed on the form, the ?ref= on a
    // link somebody sent them, then the num_scout cookie a card dropped. An
    // explicit answer always beats one we inferred.
    const url = new URL(request.url);
    const referredBy = body.referredBy
      ?? body.referred_by
      ?? url.searchParams.get('ref')
      ?? scoutCodeFrom(request, body)
      ?? null;
    // Country is only guessed when they left it blank. A person signing up in
    // an airport is not necessarily paid in the country they are standing in.
    const country = body.country || request.cf?.country || request.headers.get('cf-ipcountry') || null;
    const r = await enrol(env, { ...body, country, referredBy, ip });
    return json(r, r.ok ? 200 : 400);
  }

  if (p === '/me') {
    const url = new URL(request.url);
    const code = normaliseCode(url.searchParams.get('code'));
    const memberId = clip(url.searchParams.get('me'), 64);
    const scout = code ? await scoutByCode(env, code) : await scoutForMember(env, memberId);
    if (!scout) return json({ ok: false, why: 'not a Num Expert' }, 404);
    return json(await dashboard(env, scout.id));
  }

  if (p === '/introduce' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const code = scoutCodeFrom(request, body);
    const scout = code ? await scoutByCode(env, code) : null;
    if (!scout) return json({ ok: false, why: 'not a Num Expert' }, 403);
    const r = await introduce(env, { ...body, scoutId: scout.id });
    return json(r, r.ok ? 200 : 400);
  }

  // The paper an Expert carries. A full printable page rather than JSON,
  // because the thing being asked for IS a page — see worker/scoutkit.mjs.
  if (p === '/kit') {
    const { handleScoutKit } = await import('./scoutkit.mjs');
    return await handleScoutKit(request, env, origin);
  }

  // Who does this code belong to? Called as somebody types a referrer code on
  // the sign-up page, so they see "Referred by Isaiah" BEFORE they submit
  // rather than discovering months later that a typo lost the attribution.
  //
  // Returns a first name only. A code is semi-public — it is printed on a
  // card and read aloud — so this endpoint must confirm a code without
  // becoming a way to enumerate the programme's full names and emails.
  if (p === '/who') {
    const url = new URL(request.url);
    const code = normaliseCode(url.searchParams.get('code'));
    if (!code) return json({ ok: false, why: 'not a code' }, 404);
    const ref = await env.DB.prepare(
      'SELECT name, code, status FROM num_scouts WHERE code=?1',
    ).bind(code).first();
    if (!ref || ref.status !== 'active') return json({ ok: false, why: 'not one of ours' }, 404);
    return json({ ok: true, code: ref.code, name: String(ref.name || '').split(/\s+/)[0] });
  }

  // What the edge already knows, so the country field arrives filled in
  // instead of asking somebody standing in Bangkok to type TH.
  if (p === '/hello') {
    return json({ ok: true, country: request.cf?.country ?? request.headers.get('cf-ipcountry') ?? null });
  }

  if (p === '/terms') {
    const row = await env.DB.prepare(
      'SELECT version, body, effective_at FROM num_scout_terms ORDER BY effective_at DESC LIMIT 1',
    ).first().catch(() => null);
    return row ? json({ ok: true, ...row }) : json({ ok: false, why: 'no terms published' }, 404);
  }

  if (p === '/admin' && await isAdmin(request, env)) {
    const { results = [] } = await env.DB.prepare(
      `SELECT s.id, s.name, s.email, s.phone, s.code, s.status, s.country, s.created_at,
              s.referred_by_note, s.referrer_share_bps, s.referrer_ends_at,
              r.name AS referred_by_name, r.code AS referred_by_code,
              (SELECT COUNT(*) FROM num_scout_places sp WHERE sp.scout_id=s.id) AS introductions,
              (SELECT COUNT(*) FROM num_scout_places sp WHERE sp.scout_id=s.id AND sp.state='activated') AS activated,
              (SELECT COUNT(*) FROM num_scouts k WHERE k.referred_by_scout_id=s.id) AS referred_in
         FROM num_scouts s
         LEFT JOIN num_scouts r ON r.id = s.referred_by_scout_id
        ORDER BY s.created_at DESC LIMIT 200`,
    ).all();
    return json({ ok: true, scouts: results });
  }

  return json({ error: 'not found' }, 404);
}
