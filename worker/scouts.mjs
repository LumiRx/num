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
  termsVersion = TERMS_VERSION, now = new Date(),
} = {}) {
  if (!env?.DB) return { ok: false, why: 'no database' };
  const nm = clip(String(name || '').trim(), 80);
  const em = clip(String(email || '').trim().toLowerCase(), 160);
  if (!nm) return { ok: false, why: 'name required' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return { ok: false, why: 'a real email is required' };

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

  // Retry on collision rather than trusting 31^6 — a duplicate code would hand
  // one scout another scout's businesses, which is the worst bug this file
  // could have.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = mintCode();
    const id = uid('sc');
    try {
      await env.DB.prepare(
        `INSERT INTO num_scouts (id, member_id, name, email, email_lc, phone, country, code,
           terms_version, agreed_at, agreed_ip, monthly_claim_cap)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
      ).bind(id, memberId, nm, em, em, clip(phone, 32), clip(country, 2), code,
        termsVersion, now.toISOString(), clip(ip, 64), MONTHLY_CLAIM_CAP).run();
      return { ok: true, id, code, termsVersion };
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

  const id = uid('sp');
  try {
    await env.DB.prepare(
      `INSERT INTO num_scout_places
         (id, scout_id, place_id, biz_name, dest, country, lat, lng, state,
          finder_gate_minor, finder_cents, share_bps, sub_share_bps, introduced_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'introduced',?9,?10,?11,?12,?13)`,
    ).bind(id, scoutId, pid, nm, clip(dest, 60), clip(country, 2),
      lat == null ? null : Number(lat), lng == null ? null : Number(lng),
      scout.finder_gate_minor, scout.finder_cents, scout.share_bps, scout.sub_share_bps,
      now.toISOString()).run();
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
    writes.push(env.DB.prepare(
      `INSERT INTO num_scout_earnings (id, scout_id, scout_place_id, kind, gross_minor, amount_minor, state, accrued_at)
       VALUES (?1,?2,?3,'finder',?4,?5,'accrued',?6)`,
    ).bind(uid('se'), row.scout_id, row.id, after, Number(row.finder_cents ?? 0), now.toISOString()));
  }

  await env.DB.batch(writes);
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
      // Said in the response, not left to the page to remember.
      note: 'These are the terms you agreed to and they do not change for you if the programme changes.',
    },
    businesses: { total: places.length, byState, meaning: STATE_MEANING, list: places },
    friends,
    money: {
      ...money,
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
    const r = await enrol(env, { ...body, ip });
    if (!r.ok) return json(r, 400);

    // SIGNED IN THE MOMENT THEY JOIN.
    //
    // The paperwork — the NDA and the tax form — is the very next thing a new
    // Expert does, and both now require a session rather than a referral code.
    // Without this they would fill the form in, receive a code, and then be
    // told to go and check their email before they could sign anything.
    //
    // This is not a weaker door. The person just typed their own details into
    // the form that created the account; they are at the keyboard. Every
    // RETURNING visit goes through the emailed link.
    const { mintExpertSession, SESSION_COOKIE } = await import('./scoutmagic.mjs');
    const token = await mintExpertSession(env, r.id);
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers['Set-Cookie'] = SESSION_COOKIE(token);
    return new Response(JSON.stringify(r), { status: 200, headers });
  }

  // ── ASK FOR A SIGN-IN LINK ──────────────────────────────────────────────
  //
  // The reply never varies. Whether the address belongs to an Expert, to a
  // paused one, or to nobody at all, the caller is told the same thing — or
  // this endpoint becomes a way to ask "is this person one of Num's
  // contractors?", which is a list worth harvesting and an answer we do not
  // owe. A mail failure is LOUD in the logs and silent in the response, for
  // the same reason.
  if (p === '/login' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { startExpertMagic } = await import('./scoutmagic.mjs');
    const r = await startExpertMagic(env, {
      email: body.email,
      ip: request.headers.get('cf-connecting-ip'),
      origin,
    });
    if (r.sent && !r.mailed && r.error) {
      // Dre tried this and got nothing. If mail is refused the person waiting
      // at the door has no way to know, so the operator must.
      console.error('[scouts] sign-in mail refused:', r.error);
    }
    return json({ ok: true, sent: true });
  }

  // ── REDEEM ONE ─────────────────────────────────────────────────────────
  //
  // Lands from an email client, so it answers with a redirect and a cookie
  // rather than JSON. Failure goes back to the dashboard carrying a reason,
  // because "that link has expired" and "that link is not one we issued" send
  // a person to two different next actions.
  if (p === '/magic') {
    const url = new URL(request.url);
    const { redeemExpertMagic, mintExpertSession, SESSION_COOKIE } = await import('./scoutmagic.mjs');
    const out = await redeemExpertMagic(env, url.searchParams.get('t'));
    if (!out.ok) {
      return new Response(null, {
        status: 303,
        headers: { Location: `/scout/?err=${encodeURIComponent(out.reason)}`, 'Referrer-Policy': 'no-referrer' },
      });
    }
    const token = await mintExpertSession(env, out.scoutId);
    if (!token) {
      // No signing key configured. Say so rather than setting a cookie that
      // can never verify and leaving somebody in a redirect loop.
      console.error('[scouts] cannot mint an Expert session — ADMIN_KEY is not set');
      return new Response(null, { status: 303, headers: { Location: '/scout/?err=sign-in%20is%20not%20configured' } });
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: '/scout/?in=1',
        'Set-Cookie': SESSION_COOKIE(token),
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  // ── THE DASHBOARD ──────────────────────────────────────────────────────
  //
  // THE CODE IS NO LONGER A KEY. Until 16 Sep 2026 this accepted
  // `?code=FARMER` and handed back the Expert's whole record — earnings, rate
  // card, paperwork — to anyone who typed it. That code is printed on an NFC
  // card, read aloud across counters and public at `itsnum.com/s/FARMER`, so
  // it authenticated nobody; it just looked like it did.
  //
  // Two things are accepted now. A signed session cookie from the emailed
  // link, which is the door people use. Or a Num member id, for the Expert
  // card inside the app — that is the same bearer model every other `?me=`
  // route in this Worker uses, it is not printed on anything, and changing it
  // here alone would break the in-app sheet while fixing nothing.
  if (p === '/me') {
    const url = new URL(request.url);
    const { expertFromRequest } = await import('./scoutmagic.mjs');

    const sid = await expertFromRequest(env, request);
    if (sid) return json(await dashboard(env, sid));

    const memberId = clip(url.searchParams.get('me'), 64);
    const scout = memberId ? await scoutForMember(env, memberId) : null;
    if (!scout) {
      return json({ ok: false, why: 'Sign in to see your dashboard.', need_login: true }, 401);
    }
    return json(await dashboard(env, scout.id));
  }

  // Signing out has to be as easy as signing in, and on a shared laptop it is
  // the only way to put the earnings away again.
  if (p === '/logout') {
    return new Response(null, {
      status: 303,
      headers: {
        Location: '/scout/',
        'Set-Cookie': 'num_expert_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
      },
    });
  }

  if (p === '/introduce' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const code = scoutCodeFrom(request, body);
    const scout = code ? await scoutByCode(env, code) : null;
    if (!scout) return json({ ok: false, why: 'not a Num Expert' }, 403);
    const r = await introduce(env, { ...body, scoutId: scout.id });
    return json(r, r.ok ? 200 : 400);
  }

  if (p === '/terms') {
    const row = await env.DB.prepare(
      'SELECT version, body, effective_at FROM num_scout_terms ORDER BY effective_at DESC LIMIT 1',
    ).first().catch(() => null);
    return row ? json({ ok: true, ...row }) : json({ ok: false, why: 'no terms published' }, 404);
  }

  if (p === '/admin' && await isAdmin(request, env)) {
    const { results = [] } = await env.DB.prepare(
      `SELECT s.id, s.name, s.code, s.status, s.country, s.created_at,
              (SELECT COUNT(*) FROM num_scout_places sp WHERE sp.scout_id=s.id) AS introductions,
              (SELECT COUNT(*) FROM num_scout_places sp WHERE sp.scout_id=s.id AND sp.state='activated') AS activated
         FROM num_scouts s ORDER BY s.created_at DESC LIMIT 200`,
    ).all();
    return json({ ok: true, scouts: results });
  }

  return json({ error: 'not found' }, 404);
}
