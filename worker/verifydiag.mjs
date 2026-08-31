/**
 * NUM · Twilio Verify delivery truth.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * On 30 Aug 2026 Andre signed up and no text arrived. `num_signin_events`
 * row 8 said `stage=send outcome=ok via=verify` at 22:15:04. `num_sms_delivery`
 * had nothing at all — its newest row was nine days old. Two tables, one
 * event, and they disagreed about whether a message existed.
 *
 * Neither was lying. They were measuring different pipes:
 *
 *   · Programmable Messaging (Messages.json) — what the Messaging Service SID
 *     fix on 30 Aug repaired, and what `num_sms_delivery` records, because
 *     that path passes a StatusCallback and Twilio calls us back with the
 *     carrier's verdict.
 *   · Twilio Verify — what sign-in codes ACTUALLY use, chosen precisely
 *     because Verify is exempt from A2P 10DLC. It has no StatusCallback. It
 *     answers 201 `pending` the instant it accepts the request and then never
 *     mentions the message again.
 *
 * So `outcome: ok` on the Verify path meant "Twilio accepted the request",
 * not "a phone buzzed" — the identical blind spot that Programmable Messaging
 * had until StatusCallback closed it, reintroduced by the migration that was
 * supposed to fix delivery. A code can be accepted, billed, dropped by the
 * carrier, and every record we hold still reads green.
 *
 * Verify's answer to this is the Verification Attempts API. It is a pull, not
 * a push: nobody calls us, so somebody has to ask. Nothing ever did.
 *
 * ── WHAT THIS MODULE REFUSES TO DO ───────────────────────────────────────
 *
 * It never infers delivery. An attempt Twilio has not yet resolved reads
 * `unknown`, not `ok`. Guessing in the optimistic direction is the bug this
 * file exists to end, and it would be a strange way to end it.
 */

import { CARRIER_HINTS, ensureDelivery } from './sms.mjs';

const VERIFY_API = 'https://verify.twilio.com/v2';

/** A Verify Service SID is "VA" + 32 hex. A verification is "VE", an attempt "VL". */
export const isVerifyServiceSid = (v) => /^VA[0-9a-f]{32}$/i.test(String(v ?? '').trim());

/**
 * What went wrong with the VERIFY_SERVICE_SID that IS set, named for whoever
 * has to fix it. Same shape and same reasoning as twiliodiag.diagnose() —
 * every Twilio prefix is a plausible mis-paste from the same console.
 */
export function diagnoseVerifySid(value) {
  const v = String(value ?? '').trim();
  if (!v) {
    return {
      ok: false,
      kind: 'missing',
      note: 'VERIFY_SERVICE_SID is not set, so sign-in codes fall back to Programmable Messaging — which US carriers reject with 30034 unless the A2P campaign is approved.',
    };
  }
  if (isVerifyServiceSid(v)) return { ok: true, kind: 'verify_service', note: 'Correctly shaped Verify Service SID.' };
  const KNOWN = [
    ['AC', 'the Account SID — the one at the top of the console dashboard'],
    ['MG', 'a Messaging Service SID — the Programmable Messaging one, not Verify'],
    ['BN', 'an A2P Brand registration SID'],
    ['CM', 'an A2P Campaign SID'],
    ['PN', 'a phone-number SID'],
    ['SK', 'an API Key SID'],
  ];
  const hit = KNOWN.find(([p]) => v.toUpperCase().startsWith(p));
  return {
    ok: false,
    kind: hit ? `wrong_sid_${hit[0].toLowerCase()}` : 'not_a_sid',
    note: hit ? `This is ${hit[1]}, not a Verify Service SID.` : 'This is not a Twilio SID of any kind.',
    // First four characters only. Enough to recognise the mistake, never
    // enough to be a credential in a log.
    starts: v.slice(0, 4),
    length: v.length,
  };
}

/**
 * The failures that are specific to Verify, as opposed to the carrier codes
 * `sms.mjs` already translates. These are the ones where the fix is in the
 * Verify console and nowhere else.
 */
const VERIFY_HINTS = {
  60200: 'Malformed destination number. Verify is strict E.164 — check the country code.',
  60203: 'Max send attempts reached for this number. Verify throttles at 5 sends per number per 10 minutes.',
  60212: 'Too many concurrent requests for this number.',
  60220: 'Verify Fraud Guard blocked this send as suspected pumping fraud.',
  60223: 'Delivery channel disabled for this Verify service.',
  60410: 'This destination country is not enabled in Verify geo permissions.',
  60605: 'Verify is not permitted to send to this country on this account.',
};

/**
 * Turn one raw Verify attempt into the sentence an operator needs.
 *
 * ── I READ THE WRONG FIELD FIRST — 31 Aug 2026 ───────────────────────────
 *
 * The first cut of this took `channel_data.status` to be the carrier verdict.
 * It is not. Twilio puts TWO statuses in that object and they answer opposite
 * questions:
 *
 *   status          — did the person type the code back? ("unconfirmed")
 *   message_status  — did a carrier take the message?    ("undelivered")
 *
 * So the first live run of this endpoint reported `status: unconfirmed,
 * delivered: null` and a verdict of "pending — ask again in a minute" about an
 * attempt that was nineteen hours old and would never change. A diagnostic
 * built to end confident-sounding nonsense produced confident-sounding
 * nonsense, from the wrong field, on its first outing. The fix is to read the
 * field that answers the question being asked.
 *
 * `error_code: "0"` means NO error, and must not be shown as one.
 *
 * And the most useful fact in the whole payload turned out to be `to` — the
 * number Twilio actually texted. On 30 Aug a code went to +1310735…, one digit
 * from the number the person was holding, and every other field said the send
 * was fine. It was. It just went somewhere else.
 */
export function explainAttempt(attempt) {
  const cd = attempt?.channel_data ?? {};

  // The carrier's word. `message_status` is the only field here that answers
  // "did a phone buzz"; everything else is about the code, not the message.
  const delivery = cd.message_status ? String(cd.message_status).toLowerCase() : null;
  // Whether the person typed the code back. Useful, and NOT a delivery signal.
  const confirmation = cd.status ? String(cd.status).toLowerCase() : null;

  const rawCode = cd.error_code ?? cd.errorCode ?? null;
  const code = rawCode == null || rawCode === '' || String(rawCode) === '0' ? null : String(rawCode);
  const n = Number(code);

  // DELIVERED is the only value that means the message landed. `sent` means a
  // carrier accepted a handoff and can still drop it; treating `sent` as
  // success is how the previous blind spot was built.
  const delivered = delivery === 'delivered' ? true
    : delivery === 'undelivered' || delivery === 'failed' ? false
      : null;

  return {
    sid: attempt?.sid ?? null,
    verification_sid: attempt?.verification_sid ?? null,
    channel: attempt?.channel ?? null,
    at: attempt?.date_created ?? null,
    // Verify reports whether the person went on to type the code. An
    // unconverted attempt on a DELIVERED message is a product problem; on an
    // undelivered one it is a carrier problem. Different people, different fix.
    converted: attempt?.conversion_status === 'converted',
    // THE NUMBER WE ACTUALLY TEXTED. First field an operator should read: a
    // perfectly delivered code to the wrong digits looks identical to success
    // in every other field.
    to: cd.to ?? null,
    carrier: cd.carrier ?? null,
    country: cd.country ?? null,
    status: delivery ?? 'unknown',
    confirmation: confirmation ?? null,
    delivered,
    error_code: code,
    hint: code ? (VERIFY_HINTS[n] ?? CARRIER_HINTS[n] ?? null) : null,
  };
}

/**
 * How long we wait before an unresolved attempt stops being "in flight".
 *
 * Twilio normally reports a carrier result within seconds. An attempt with no
 * `message_status` five minutes on is not pending — it is a question Twilio is
 * never going to answer, and saying "ask again in a minute" about it is how a
 * dead end gets dressed up as progress.
 */
const PENDING_GRACE_MS = 5 * 60 * 1000;

export const isStale = (attempt, now = Date.now()) =>
  !!attempt?.at && (now - new Date(attempt.at).getTime()) > PENDING_GRACE_MS;

const auth = (env) => 'Basic ' + btoa(`${env.TWILIO_SID ?? env.TWILIO_ACCOUNT_SID}:${env.TWILIO_TOKEN ?? env.TWILIO_AUTH_TOKEN}`);

const credentialled = (env) =>
  Boolean((env?.TWILIO_SID ?? env?.TWILIO_ACCOUNT_SID) && (env?.TWILIO_TOKEN ?? env?.TWILIO_AUTH_TOKEN));

/** One authenticated GET against the Verify API. Never throws. */
async function get(env, path) {
  if (!credentialled(env)) return { _error: 'TWILIO_SID / TWILIO_TOKEN are not both set on this Worker.' };
  try {
    const res = await fetch(`${VERIFY_API}${path}`, {
      headers: { Authorization: auth(env), Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { _error: `HTTP ${res.status}${body?.message ? ` — ${String(body.message).slice(0, 160)}` : ''}` };
    }
    return await res.json();
  } catch (err) {
    return { _error: String(err?.message ?? err).slice(0, 120) };
  }
}

/**
 * Every Verify attempt since a moment, newest first.
 *
 * Filtered by our own service SID when we have one: the Attempts endpoint is
 * account-wide, and on an account running more than one Verify service an
 * unfiltered read would blame ours for somebody else's failures.
 */
export async function attemptsSince(env, sinceIso, { pageSize = 50 } = {}) {
  const qs = new URLSearchParams({ PageSize: String(Math.min(100, Math.max(1, pageSize))) });
  if (sinceIso) qs.set('DateCreatedAfter', sinceIso);
  if (isVerifyServiceSid(env?.VERIFY_SERVICE_SID)) qs.set('ServiceSid', String(env.VERIFY_SERVICE_SID).trim());
  const body = await get(env, `/Attempts?${qs}`);
  if (body?._error) return { ok: false, error: body._error, attempts: [] };
  const list = Array.isArray(body?.attempts) ? body.attempts : [];
  return { ok: true, attempts: list.map(explainAttempt) };
}

/** The attempts belonging to one verification, for "what happened to MY code". */
export async function attemptsForVerification(env, verificationSid) {
  if (!/^VE[0-9a-f]{32}$/i.test(String(verificationSid ?? '').trim())) return { ok: false, error: 'not a verification sid', attempts: [] };
  const body = await get(env, `/Attempts?VerificationSid=${encodeURIComponent(String(verificationSid).trim())}&PageSize=20`);
  if (body?._error) return { ok: false, error: body._error, attempts: [] };
  const list = Array.isArray(body?.attempts) ? body.attempts : [];
  return { ok: true, attempts: list.map(explainAttempt) };
}

/**
 * Pull recent Verify outcomes into `num_sms_delivery`, so the one table that
 * answers "did our texts arrive" finally covers the pipe that carries sign-in.
 *
 * Keyed by the ATTEMPT sid (VL…), which shares a primary key column with
 * Programmable Messaging's message sid (SM…). Different prefixes, no
 * collisions, one place to look — which is the entire point. Before this,
 * `SELECT status, COUNT(*) FROM num_sms_delivery` on the ops console described
 * a pipeline that no longer carried a single sign-in code.
 *
 * The destination number falls back to our own member row when Twilio omits
 * it, because a delivery record with no recipient cannot be acted on.
 */
export async function reconcileVerifySends(env, { sinceIso, now = Date.now() } = {}) {
  const since = sinceIso ?? new Date(now - 6 * 60 * 60 * 1000).toISOString();
  const read = await attemptsSince(env, since);
  if (!read.ok) return { ok: false, error: read.error, seen: 0, written: 0, undelivered: 0 };

  let written = 0;
  const failures = [];
  for (const a of read.attempts) {
    // Nothing to record until the carrier has said something. Writing
    // `unknown` rows would fill the delivery table with non-answers and make
    // the status histogram on the ops console useless.
    if (a.delivered === null) continue;

    let to = a.to;
    if (!to && a.verification_sid) {
      to = (await env.DB.prepare('SELECT phone FROM num_members WHERE code_sid=?1')
        .bind(a.verification_sid).first().catch(() => null))?.phone ?? null;
    }
    try {
      await ensureDelivery(env);
      await env.DB.prepare(
        `INSERT INTO num_sms_delivery (message_sid, to_phone, status, error_code, error_hint, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,unixepoch(),unixepoch())
         ON CONFLICT(message_sid) DO UPDATE SET
           status     = excluded.status,
           error_code = COALESCE(excluded.error_code, num_sms_delivery.error_code),
           error_hint = COALESCE(excluded.error_hint, num_sms_delivery.error_hint),
           updated_at = excluded.updated_at`,
      ).bind(a.sid, to, a.status, a.error_code, a.hint).run();
      written += 1;
    } catch (e) {
      console.warn('[verify] delivery write failed', e?.message ?? e);
    }
    if (a.delivered === false) failures.push(a);
  }

  return {
    ok: true,
    seen: read.attempts.length,
    written,
    undelivered: failures.length,
    // The distinct reasons, not every row. An operator needs to know which
    // console to open, and twelve copies of 30034 is still one answer.
    reasons: [...new Set(failures.map((f) => f.error_code ?? f.status))],
    worst: failures[0] ?? null,
  };
}

/**
 * The one-sentence verdict. Written so it can be read at speed during an
 * incident by somebody who has not seen this file.
 */
export function verdictFor({ configured, attempts, service, now = Date.now() }) {
  if (!configured.ok) return { state: 'misconfigured', say: configured.note };
  if (service?._error) return { state: 'unreachable', say: `Twilio would not describe the Verify service: ${service._error}` };
  if (!attempts.ok) return { state: 'unreachable', say: `Could not read Verify attempts: ${attempts.error}` };
  if (!attempts.attempts.length) {
    return { state: 'quiet', say: 'Verify has recorded no attempts in this window. Either nothing was sent, or the sends went through a different service than the one configured here.' };
  }
  const resolved = attempts.attempts.filter((a) => a.delivered !== null);
  const bad = resolved.filter((a) => a.delivered === false);
  if (!resolved.length) {
    const newest = attempts.attempts[0];
    // Old and unresolved is a different animal from young and unresolved, and
    // telling somebody to "ask again in a minute" about a nineteen-hour-old
    // attempt is exactly the sort of cheerful non-answer this file exists to
    // stop producing.
    if (isStale(newest, now)) {
      return {
        state: 'unresolved',
        say: `Twilio accepted ${attempts.attempts.length} attempt(s) and never reported a carrier result — the newest is from ${newest.at}. Waiting will not change this. Check the destination number first: the last code went to ${newest.to ?? 'a number Twilio did not report'}${newest.carrier ? ` on ${newest.carrier}` : ''}. A code delivered to the wrong digits looks identical to a healthy send in every other field.`,
      };
    }
    return { state: 'pending', say: `Twilio has accepted ${attempts.attempts.length} attempt(s) but has not yet reported a carrier result. This is normal for the first ~30 seconds.` };
  }
  if (bad.length === resolved.length) {
    const a = bad[0];
    return { state: 'failing', say: `Every resolved attempt failed at the carrier (${a.status}${a.error_code ? `, error ${a.error_code}` : ''}). ${a.hint ?? 'No hint available for this code.'}` };
  }
  if (bad.length) {
    return { state: 'partial', say: `${bad.length} of ${resolved.length} resolved attempts failed at the carrier. Most recent failure: ${bad[0].error_code ?? bad[0].status}. ${bad[0].hint ?? ''}`.trim() };
  }
  const last = resolved.find((a) => a.delivered) ?? resolved[0];
  return {
    state: 'delivering',
    say: `All ${resolved.length} resolved attempts were delivered. Most recent went to ${last.to ?? 'an unreported number'}${last.carrier ? ` on ${last.carrier}` : ''}. If somebody still says no code arrived, CHECK THAT NUMBER IS THEIRS before anything else — the message reached a carrier, so what is left is a blocked sender, a full inbox, or the wrong digits on file.`,
  };
}

/** GET /api/admin/verify — admin key required. Never returns a credential. */
export async function handleVerifyDiag(request, env) {
  const json = (status, body) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
    return json(404, { error: 'not found' });
  }

  const url = new URL(request.url);
  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours') ?? 24) || 24));
  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const configured = diagnoseVerifySid(env.VERIFY_SERVICE_SID);
  const service = configured.ok
    ? await get(env, `/Services/${String(env.VERIFY_SERVICE_SID).trim()}`)
    : null;
  const attempts = configured.ok ? await attemptsSince(env, sinceIso) : { ok: false, error: 'no service sid', attempts: [] };

  return json(200, {
    window_hours: hours,
    configured,
    service: service?._error
      ? { error: service._error }
      : service
        ? {
          sid: service.sid ?? null,
          friendly_name: service.friendly_name ?? null,
          code_length: service.code_length ?? null,
          // A custom sender pool is the single most likely way Verify stops
          // being A2P-exempt: attach your own Messaging Service and the
          // traffic goes out on your unregistered long code again.
          custom_code_enabled: service.custom_code_enabled ?? null,
          lookup_enabled: service.lookup_enabled ?? null,
        }
        : null,
    verdict: verdictFor({ configured, attempts, service }),
    attempts: attempts.attempts.slice(0, 25),
  });
}
