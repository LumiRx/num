/**
 * NUM · claim verification — the anti-fraud core.
 *
 * The premise, and the only rule that really matters:
 *
 *   THE CODE IS SENT TO THE CONTACT ALREADY PUBLISHED FOR THE BUSINESS,
 *   NEVER TO A NUMBER OR ADDRESS THE CLAIMANT TYPES IN.
 *
 * Our directory holds the phone and website a business publishes to the world
 * (OpenStreetMap, the business's own site). Proving you can receive a code on
 * that channel proves you control the business's public contact point — which
 * is exactly the standard Google Business Profile, Yelp and Apple use. A
 * claimant-supplied number proves nothing at all: anyone can receive a code on
 * their own phone.
 *
 * Verification ladder, strongest first:
 *   1. sms / voice   → OTP to places.phone            (auto-verifies)
 *   2. email_domain  → OTP to an address at the SAME registrable domain as
 *                      places.website                  (auto-verifies)
 *   3. manual        → no usable channel on file, a contested listing, or a
 *                      failed ladder → evidence + human review (never auto)
 *
 * Everything else here is the boring part that makes the above hold up:
 * hashed single-use codes, short TTLs, attempt caps, per-place and per-IP rate
 * limits, an append-only event log, and contested-claim handling that alerts
 * the incumbent owner instead of silently transferring a listing.
 */

export const CODE_TTL_MIN = 10;
export const MAX_ATTEMPTS = 5;
export const MAX_CLAIMS_PER_PLACE_PER_DAY = 5;
export const MAX_CLAIMS_PER_IP_PER_DAY = 10;

const enc = new TextEncoder();

export const nowIso = () => new Date().toISOString();
export const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** 6 digits, uniform, from the CSPRNG (no Math.random anywhere near auth). */
export function generateCode() {
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= 4_294_000_000); // reject the biased tail
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

export async function hashCode(code, salt) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${salt}:${code}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time compare so a timing side-channel can't leak the code. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** E.164-ish normaliser: strips punctuation, keeps a leading +. */
/**
 * ONE NUMBER, ONE STRING. This is what identity hangs on.
 *
 * The old version returned `(plus ? '+' : '') + digits` — it preserved the
 * ABSENCE of a plus and validated only that there were 7 to 15 digits, with no
 * country rule at all. Two consequences, both of which were live in production
 * until 2026-08-21:
 *
 *  1. DUPLICATE ACCOUNTS. `num_members.phone` is UNIQUE, but `4437079219` and
 *     `+14437079219` are different strings, so the constraint never fired.
 *     Isaiah Rich held two accounts. So did Rebekah. Each of them signed up
 *     once as far as they knew, typed their number slightly differently the
 *     second time, and got a stranger's empty version of their own app.
 *  2. UNDIALABLE NUMBERS ON FILE. `+1989128566684` — thirteen digits after the
 *     +1, when NANP is exactly ten — was accepted and stored at 13:14 on
 *     2026-08-21 by live code. It can never receive a verification code and
 *     can never receive a booking text.
 *
 * It also silently broke sign-in recovery. "Does this number already have an
 * account?" is decided by an exact match on the stored string, so somebody who
 * signed up as `3107387319` and later typed `+1 310 738 7319` did not get
 * their account back — they got a THIRD one.
 *
 * ── WHY A DEFAULT REGION AND NOT A GUESS ─────────────────────────────────
 *
 * A bare ten-digit number is ambiguous: `4437079219` is a Maryland mobile in
 * the US and nothing at all in Thailand. Guessing a country code is how you
 * text a stranger on another continent — the exact mistake worker/bookdesk.mjs
 * documents at length.
 *
 * So the country is PASSED IN, not inferred: callers hand us the region from
 * `CF-IPCountry` on the request, which is where the person actually is. With
 * no region and no plus, we refuse rather than guess. Refusing is honest and
 * recoverable; guessing is neither.
 *
 * Twilio Verify is strict E.164 and answers error 60200 to anything else, so
 * this is also the gate that has to hold before OTP can move off Programmable
 * Messaging.
 */

/**
 * National number lengths for the regions Num actually serves.
 *
 * MOBILE AND LANDLINE LENGTHS BOTH BELONG HERE. The first cut of this table
 * listed only mobile lengths and refused every Thai landline — `076 360 333`
 * is an 8-digit national number, and Phuket restaurants are landlines, so it
 * would have broken the exact venues the booking desk exists to call. The
 * backfill planner's tests caught it; nothing about a phone-shaped signup
 * would have.
 */
const REGIONS = {
  US: { cc: '1', nat: [10] },
  CA: { cc: '1', nat: [10] },
  GB: { cc: '44', nat: [9, 10] },      // 9 for some landlines, 10 for mobiles
  TH: { cc: '66', nat: [8, 9] },       // 8 landline, 9 mobile
  AU: { cc: '61', nat: [9] },
  SG: { cc: '65', nat: [8] },
  AE: { cc: '971', nat: [8, 9] },
  // Added 2 Sep 2026. The one real campaign arrival who ever tried to sign in
  // typed a bare ten-digit number that began 99 while standing in the UK. The
  // server put +44 on it, Twilio answered 60200, and he never got a code. A
  // 10-digit number starting 99 is not a British number in any range — it is
  // the shape of an Indian mobile. Num's whole customer is a person far from
  // home, so "where they are" is the wrong guess for "where their SIM is
  // from"; the rows below at least let a person AT home type their number
  // plainly, and `normaliseMobile` refuses shapes that cannot receive a text.
  IN: { cc: '91', nat: [10] },
  MY: { cc: '60', nat: [9, 10] },
  ID: { cc: '62', nat: [9, 10, 11, 12] },
  PH: { cc: '63', nat: [10] },
  VN: { cc: '84', nat: [9, 10] },
  JP: { cc: '81', nat: [9, 10] },
  KR: { cc: '82', nat: [9, 10] },
  HK: { cc: '852', nat: [8] },
  DE: { cc: '49', nat: [10, 11] },
  FR: { cc: '33', nat: [9] },
  ES: { cc: '34', nat: [9] },
  IT: { cc: '39', nat: [9, 10] },
  NL: { cc: '31', nat: [9] },
  IE: { cc: '353', nat: [9] },
  NZ: { cc: '64', nat: [8, 9, 10] },
  ZA: { cc: '27', nat: [9] },
  MX: { cc: '52', nat: [10] },
  BR: { cc: '55', nat: [10, 11] },
};

/**
 * What the first digits of a NATIONAL number look like when it is a mobile —
 * i.e. something that can receive an SMS code. Landlines are deliberately
 * excluded here and deliberately kept in `normalisePhone`: the booking desk
 * phones restaurants, and restaurants are landlines.
 *
 * Only countries whose numbering plan is settled enough to write down. A
 * country absent from this table passes on `normalisePhone` alone.
 */
const MOBILE_NSN = {
  1: /^[2-9]\d{2}[2-9]\d{6}$/,     // NANP: area code and exchange never start 0/1
  44: /^7\d{9}$/,                   // UK mobiles are 07xxx — ten digits starting 7
  66: /^[689]\d{8}$/,               // Thai mobiles 06/08/09, nine digits
  61: /^4\d{8}$/,                   // Australian mobiles 04
  65: /^[89]\d{7}$/,                // Singapore mobiles 8/9
  971: /^5\d{8}$/,                  // UAE mobiles 05
  91: /^[6-9]\d{9}$/,               // Indian mobiles 6–9, ten digits
  60: /^1\d{8,9}$/,                 // Malaysian mobiles 01x
  62: /^8\d{8,11}$/,                // Indonesian mobiles 08
  63: /^9\d{9}$/,                   // Philippine mobiles 09
  84: /^[35789]\d{8}$/,             // Vietnamese mobiles 03/05/07/08/09
  81: /^[789]0\d{8}$/,              // Japanese mobiles 070/080/090
  82: /^10\d{8}$/,                  // Korean mobiles 010
  49: /^1[5-7]\d{8,9}$/,            // German mobiles 015/016/017
  33: /^[67]\d{8}$/,                // French mobiles 06/07
  34: /^[67]\d{8}$/,                // Spanish mobiles 6/7
  39: /^3\d{8,9}$/,                 // Italian mobiles 3xx
  31: /^6\d{8}$/,                   // Dutch mobiles 06
  353: /^8\d{8}$/,                  // Irish mobiles 08
  64: /^2\d{7,9}$/,                 // NZ mobiles 02
  27: /^[678]\d{8}$/,               // South African mobiles 06/07/08
};

/**
 * Could this E.164 number receive a text? True when the country is one we
 * have not written down (no opinion), false only when we KNOW the shape is
 * wrong for that country. `+44 991…` is the row this exists for.
 */
export function plausibleMobile(e164) {
  if (!e164 || !e164.startsWith('+')) return false;
  const digits = e164.slice(1);
  // Longest country code first, so 971 is not read as 9 + 71.
  const ccs = Object.keys(MOBILE_NSN).sort((a, b) => b.length - a.length);
  for (const cc of ccs) {
    if (!digits.startsWith(cc)) continue;
    return MOBILE_NSN[cc].test(digits.slice(cc.length));
  }
  return true;
}

/**
 * `normalisePhone`, then "and can it be texted". This is the gate for every
 * path that is about to SEND A CODE — sign-up, sign-in recovery, resend. It
 * is not the gate for storing a venue's phone, which is allowed to be a
 * landline.
 *
 * Refusing here costs one sentence on screen. Not refusing costs a 60200
 * from Twilio, a `send failed` row, and a person who never finds out why
 * nothing arrived.
 */
export function normaliseMobile(raw, region) {
  const e164 = normalisePhone(raw, region);
  if (!e164) return null;
  return plausibleMobile(e164) ? e164 : null;
}

/** Country code -> allowed total digit counts, for validating a +number. */
const CC_LENGTHS = {
  1: [11],
  44: [11, 12],
  66: [10, 11],
  61: [11],
  65: [10],
  971: [11, 12],
};

export function normalisePhone(raw, region) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/[^\d+]/g, '');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;

  // Already carries a country code.
  if (s.startsWith('+')) {
    if (digits.length < 8 || digits.length > 15) return null;
    // Validate against the country code when we know it. An unknown country
    // passes on length alone rather than being rejected — Num serves 38 of
    // them and this table is deliberately not a phone-number library.
    for (const [cc, lens] of Object.entries(CC_LENGTHS)) {
      if (!digits.startsWith(cc)) continue;

      // TRUNK ZERO AFTER THE COUNTRY CODE, stripped before anything is judged.
      //
      // People copy the country code from one place and their number from
      // another, and the number they copy is written the way their own country
      // writes it — trunk prefix still on the front. `+44` + `07391794169` is
      // a real member's real mobile, stored 2026-08-14, one character from
      // working.
      //
      // Stripped UNCONDITIONALLY rather than only as a repair for a bad
      // length, because in Thailand both readings pass the length gate:
      // `+66` + `081234567` is eleven digits (valid) and so is the number it
      // was meant to be. Length cannot separate them — but the rule can. A
      // trunk prefix exists for domestic dialling only; no national number in
      // any of these countries begins with 0. So a leading zero after the
      // country code is always the prefix, never the number.
      const nsn = digits.slice(cc.length).replace(/^0+/, '');
      const full = cc + nsn;

      if (!lens.includes(full.length)) return null;
      // UK, one extra rule, because length alone let a dead number through.
      // A 9-digit national number is geographic and starts 1 or 2; mobiles are
      // always 10 digits starting 7. `+44 656612406` satisfies the length gate
      // and is not an assignable range — it is on file for a real member who
      // can never receive a code.
      if (cc === '44' && full.length === 11 && !/^44[12]/.test(full)) return null;
      return `+${full}`;
    }
    return `+${digits}`;
  }

  // No plus. The region decides, and without one we refuse.
  const r = REGIONS[String(region ?? '').toUpperCase()];
  if (!r) return null;

  // Strip a trunk prefix ("0" in the UK, TH, AU) before matching.
  const nat = digits.replace(/^0+/, '');
  if (r.nat.includes(nat.length)) return `+${r.cc}${nat}`;
  // Someone typed their own country code without the plus: 14437079219.
  if (digits.startsWith(r.cc) && r.nat.includes(digits.length - r.cc.length)) return `+${digits}`;
  return null;
}

/** Registrable-ish domain: strips scheme, www, path, and a leading label. */
export function domainOf(url) {
  if (!url) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Same registrable domain (accepts sub-domains of the business's site). */
export function sameDomain(email, siteDomain) {
  if (!email || !siteDomain) return false;
  const at = email.split('@')[1]?.toLowerCase();
  if (!at) return false;
  return at === siteDomain || at.endsWith(`.${siteDomain}`);
}

/**
 * Free/consumer mail hosts can never prove ownership of a business domain —
 * anyone can open one. These are only ever accepted for CONTACTING a claimant.
 */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
  'yandex.com', 'qq.com', '163.com', 'naver.com', 'zoho.com',
]);
export const isFreeMail = (domain) => !!domain && FREE_MAIL.has(domain.toLowerCase());

export const maskPhone = (p) => (p ? p.replace(/.(?=.{2}$)/g, '•').replace(/^(\+?\d{0,3})/, '$1 ') : null);
export const maskEmail = (e) => {
  if (!e) return null;
  const [u, d] = e.split('@');
  if (!d) return null;
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${d}`;
};

/**
 * Decide how a given directory row can be verified. Returns the ladder rung we
 * can actually use, plus what to show the claimant (masked).
 */
export function channelsFor(place) {
  const out = [];
  const phone = normalisePhone(place?.phone);
  if (phone) out.push({ channel: 'sms', value: phone, display: maskPhone(phone), label: 'Text the number on your listing' });
  const dom = domainOf(place?.website);
  if (dom && !isFreeMail(dom)) {
    out.push({ channel: 'email_domain', value: dom, display: `you@${dom}`, label: `Email an address at ${dom}` });
  }
  // Always available, always human-reviewed.
  out.push({ channel: 'manual', value: null, display: null, label: 'Send proof instead (reviewed by our team)' });
  return out;
}

/**
 * Rate limits, evaluated before any code is minted or sent. Cheap D1 counts;
 * the point is to make brute force and spray-claiming expensive rather than
 * to be perfectly precise.
 */
export async function rateLimitOk(env, { placeId, ip }) {
  const day = "datetime('now','-1 day')";
  const perPlace = await env.DB.prepare(
    `SELECT COUNT(*) n FROM num_claims WHERE place_id=?1 AND created_at > ${day}`,
  ).bind(placeId).first();
  if ((perPlace?.n ?? 0) >= MAX_CLAIMS_PER_PLACE_PER_DAY) {
    return { ok: false, reason: 'This listing has had too many claim attempts today. Try again tomorrow or send proof.' };
  }
  if (ip) {
    const perIp = await env.DB.prepare(
      `SELECT COUNT(*) n FROM num_claims WHERE ip=?1 AND created_at > ${day}`,
    ).bind(ip).first();
    if ((perIp?.n ?? 0) >= MAX_CLAIMS_PER_IP_PER_DAY) {
      return { ok: false, reason: 'Too many claims from this connection today.' };
    }
  }
  return { ok: true };
}

export async function logEvent(env, claimId, event, detail, ip) {
  try {
    await env.DB.prepare(
      'INSERT INTO num_claim_events (claim_id, event, detail, ip) VALUES (?1,?2,?3,?4)',
    ).bind(claimId, event, detail ? String(detail).slice(0, 500) : null, ip ?? null).run();
  } catch {
    /* the audit log must never break the flow it is auditing */
  }
}

/**
 * Outbound codes. No SMS provider is configured yet, so this is deliberately
 * pluggable: Twilio if its secrets exist, else email via Resend, else (dev
 * only) log. It NEVER silently pretends to have sent something.
 */
/**
 * TWILIO VERIFY — the way out of A2P for verification codes.
 *
 * Twilio's own A2P page: "If you're only using 10DLC numbers to send user
 * verification text messages, you can use Twilio Verify rather than registering
 * for A2P 10DLC." Verify traffic is EXEMPT from 10DLC.
 *
 * That matters here more than it sounds. On 2026-08-21 `num_sms_delivery`
 * showed every real send failing with carrier error 30034 — an unregistered
 * campaign — including Andre's own number. One SMS had ever been delivered, to
 * Twilio's magic test number, which never touches a carrier. 129 members, 42
 * numbers on file, two verified, and both of those predate the current sender.
 * Sign-in was not underperforming; it was closed.
 *
 * A2P registration is still needed for everything else Num sends — the
 * concierge thread, venue booking requests — and that is 10 to 15 days away.
 * Verify moves the ONE message that gates sign-in off that path entirely.
 *
 * It also deletes code rather than adding it. Verify generates the code,
 * tracks its ten-minute expiry, rate-limits sends and checks, and runs fraud
 * detection. `generateCode`, `hashCode`, the `code_hash` / `code_salt` /
 * `code_expires` / `attempts` columns and the resend cooldown all become
 * Twilio's problem once traffic is fully across.
 *
 * OFF UNTIL CONFIGURED. Without `VERIFY_SERVICE_SID` these return null and
 * every caller falls back to the Programmable Messaging path, unchanged. That
 * is what makes this safe to deploy before the Twilio service exists.
 */
export const verifyConfigured = (env) =>
  Boolean(env?.VERIFY_SERVICE_SID && env?.TWILIO_SID && env?.TWILIO_TOKEN);

const verifyAuth = (env) => 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`);
const verifyUrl = (env, leaf) =>
  `https://verify.twilio.com/v2/Services/${env.VERIFY_SERVICE_SID}/${leaf}`;

/**
 * Ask Verify to send a code. Returns null when Verify is not configured, so
 * the caller knows to use the old path rather than treating it as a failure.
 */
export async function verifySend(env, to, channel = 'sms') {
  if (!verifyConfigured(env)) return null;
  const res = await fetch(verifyUrl(env, 'Verifications'), {
    method: 'POST',
    headers: { Authorization: verifyAuth(env), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, Channel: channel }),
  }).catch((e) => ({ ok: false, _err: e?.message }));

  const body = await res.json?.().catch(() => ({})) ?? {};
  if (!res.ok) {
    // Verify's codes are not Messaging's. 60200 is a malformed number — which
    // is why the E.164 backfill had to land before this could be switched on.
    const map = {
      60200: 'That number is not in a form we can text — check the country code.',
      60203: 'Too many codes sent to that number. Try again in a few minutes.',
      60212: 'Verification is misconfigured on our side. Nothing you did.',
      60410: 'We cannot text that country yet.',
    };
    return { ok: false, code: body.code ?? null, error: map[body.code] ?? body.message ?? 'Could not send a code.' };
  }
  // `pending` means it is on its way. Verify never returns the code itself.
  return { ok: true, status: body.status, sid: body.sid ?? null };
}

/**
 * Check a code against Verify.
 *
 * A WRONG CODE DOES NOT THROW — it comes back 200 with status "pending", which
 * is the single easiest thing to get wrong in this API and would let anybody in
 * with any code. Only `approved` is a pass, and it is tested for explicitly.
 */
export async function verifyCheck(env, to, code) {
  if (!verifyConfigured(env)) return null;
  const res = await fetch(verifyUrl(env, 'VerificationCheck'), {
    method: 'POST',
    headers: { Authorization: verifyAuth(env), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, Code: String(code ?? '') }),
  }).catch(() => null);

  // A 404 means there is no pending verification — expired, already used, or
  // never sent. Indistinguishable from a wrong code to the person, and it must
  // not read as success.
  if (!res || !res.ok) return { ok: false, approved: false };
  const body = await res.json().catch(() => ({}));
  return { ok: true, approved: body.status === 'approved', status: body.status };
}

export async function sendCode(env, { channel, to, code, businessName }) {
  const text =
    `${code} is your NUM verification code for ${businessName || 'your business'}. ` +
    `It expires in ${CODE_TTL_MIN} minutes. If you didn't request this, ignore it — nobody can claim your listing without it.`;

  if (channel === 'sms' || channel === 'voice') {
    if (env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM) {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        // StatusCallback is what turns "Twilio accepted it" into "a carrier
        // delivered it". Without it the success below is a promise to try:
        // Twilio answers 201 the instant it queues a message, and a carrier
        // can drop it silently seconds later with nobody any the wiser. On
        // 2026-08-04 that blind spot left us unable to tell a filtered message
        // from a delivered one, right after a day spent misreading an auth
        // failure as a compliance problem.
        body: new URLSearchParams({
          To: to,
          From: env.TWILIO_FROM,
          Body: text,
          StatusCallback: 'https://app.itsnum.com/api/sms/status',
        }),
      });
      if (!res.ok) {
        // Read Twilio's own words, not just the status line.
        //
        // This used to return `sms provider ${status}` and nothing else, which
        // cost most of a day: a 401 and a 400 look identical from outside, and
        // "SMS is failing" was misdiagnosed as an unapproved A2P campaign when
        // it was actually rejected credentials. Twilio always answers with a
        // JSON body naming the exact cause, and the distinctions matter:
        //
        //   20003 "Authenticate"                 — bad SID or token, and the
        //         message says "invalid username" (SID) vs "invalid password"
        //         (token), which is the difference between two separate fixes
        //   30034 unregistered A2P 10DLC campaign — the compliance path
        //   21266 To and From cannot be the same  — a test artefact, not a fault
        //   21608 unverified number on a trial account
        //
        // The body contains no credentials — Twilio says "your AccountSid or
        // AuthToken was incorrect" without echoing either — so this is safe to
        // surface to the caller and to log.
        let detail = '';
        try {
          const body = await res.json();
          const parts = [body?.code, body?.message].filter(Boolean);
          if (parts.length) detail = ` — ${parts.join(' ')}`.slice(0, 200);
        } catch {
          // A non-JSON error body is itself informative, but never worth an
          // exception on a path whose job is reporting a different failure.
        }
        return { ok: false, error: `sms provider ${res.status}${detail}`, status: res.status };
      }
      // Carry Twilio's message SID back to the caller.
      //
      // It is what lets a later delivery receipt be matched to the exact code
      // it was carrying. Without it, a failure callback can only say "a
      // message to this number failed" — and clearing the member's pending
      // code on that basis would wipe a NEWER, valid code whenever a slow
      // failure receipt lands after a successful retry.
      let sid = null;
      try { sid = (await res.json())?.sid ?? null; } catch { /* body is a bonus, not a requirement */ }
      return { ok: true, via: 'twilio', sid };
    }
    return { ok: false, error: 'no_sms_provider' };
  }

  if (channel === 'email_domain') {
    if (env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'NUM <info@5arz.com>',
          to: [to],
          subject: `${code} — your NUM verification code`,
          text,
        }),
      });
      if (!res.ok) return { ok: false, error: `email provider ${res.status}` };
      return { ok: true, via: 'resend' };
    }
    return { ok: false, error: 'no_email_provider' };
  }

  return { ok: false, error: 'unsupported_channel' };
}
