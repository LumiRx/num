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
export function normalisePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/[^\d+]/g, '');
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return (plus ? '+' : '') + digits;
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
