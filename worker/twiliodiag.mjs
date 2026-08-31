/**
 * "Which Messaging Service SID am I supposed to be using?" — answered from
 * Twilio, not from memory.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * On 25 Aug 2026 someone read the answer out of the Twilio console and wrote
 * it into a comment at the top of twiliosender.mjs: brand approved, campaign
 * approved, service `MG64fac228…` carries it. On 26 Aug at 17:56 UTC a value
 * beginning `Mqmc…` was put into TWILIO_MESSAGING_SERVICE_SID instead — a
 * string that is not a Twilio SID of any kind. The health check has said
 * `degraded` every five minutes since: 1,131 consecutive runs, four days,
 * every SMS quietly falling back to the bare number and every US send at the
 * mercy of a carrier that sees an unregistered sender.
 *
 * The lesson is not "be careful pasting". It is that the correct value lived
 * in a human's console session and a code comment, so recovering it meant
 * someone logging in again — and for four days nobody did.
 *
 * This endpoint asks Twilio directly, using the credentials the Worker
 * already holds, and prints the answer next to what is currently configured.
 * It never returns a credential: an Account SID and Auth Token go out in the
 * Authorization header and only SIDs, names and statuses come back.
 *
 * Admin-gated, because the sender pool and campaign registration are business
 * facts about the account and not something a guest should be able to read.
 */

const API = 'https://messaging.twilio.com/v1';

/** A Messaging Service SID is "MG" + 32 hex. Anything else is a paste error. */
export const isServiceSid = (v) => /^MG[0-9a-f]{32}$/i.test(String(v ?? '').trim());

/**
 * What went wrong with the value that IS set, said in the words of whoever
 * has to fix it. Every Twilio prefix is a plausible mis-paste from the same
 * console page, so name the one that was actually pasted.
 */
export function diagnose(value) {
  const v = String(value ?? '').trim();
  if (!v) return { ok: false, kind: 'missing', note: 'TWILIO_MESSAGING_SERVICE_SID is not set at all — every US send falls back to the bare number.' };
  if (isServiceSid(v)) return { ok: true, kind: 'messaging_service', note: 'Correctly shaped Messaging Service SID.' };
  const KNOWN = [
    ['AC', 'the Account SID — the one at the top of the console dashboard'],
    ['BN', 'an A2P Brand registration SID'],
    ['CM', 'an A2P Campaign SID'],
    ['PN', 'a phone-number SID'],
    ['SK', 'an API Key SID'],
    ['VA', 'a Verify Service SID'],
  ];
  const hit = KNOWN.find(([p]) => v.toUpperCase().startsWith(p));
  return {
    ok: false,
    kind: hit ? `wrong_sid_${hit[0].toLowerCase()}` : 'not_a_sid',
    note: hit
      ? `This is ${hit[1]}, not a Messaging Service SID.`
      : 'This is not a Twilio SID of any kind — it matches no known prefix, so it was probably pasted from somewhere else entirely.',
    // First four characters only. Enough to recognise the mistake, never
    // enough to be a credential in a log.
    starts: v.slice(0, 4),
    length: v.length,
  };
}

/** One authenticated GET against the Messaging API. Returns null on failure. */
async function get(env, path) {
  // THE NAMES MATTER. This codebase calls them TWILIO_SID / TWILIO_TOKEN
  // (20 and 19 uses); TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are Twilio's own
  // documentation names and appear nowhere else in the repo. Reading the
  // documentation names would have made this endpoint report "credentials not
  // set" on a Worker that has them — a diagnostic tool that is wrong in
  // exactly the situation it exists for. Both are accepted, ours first.
  const sid = String(env?.TWILIO_SID ?? env?.TWILIO_ACCOUNT_SID ?? '').trim();
  const token = String(env?.TWILIO_TOKEN ?? env?.TWILIO_AUTH_TOKEN ?? '').trim();
  if (!sid || !token) return null;
  try {
    const res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { _error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { _error: String(err?.message ?? err).slice(0, 120) };
  }
}

/**
 * Every Messaging Service on the account, with the two things that decide
 * whether it is the right one: the numbers in its sender pool, and whether an
 * A2P campaign is registered against it.
 */
export async function inspectAccount(env) {
  const list = await get(env, '/Services?PageSize=50');
  if (!list) return { ok: false, error: 'TWILIO_SID / TWILIO_TOKEN are not both set on this Worker.' };
  if (list._error) return { ok: false, error: `Twilio: ${list._error}` };

  const services = Array.isArray(list.services) ? list.services : [];
  const want = String(env?.TWILIO_FROM ?? '').trim();

  const detailed = await Promise.all(services.map(async (s) => {
    const [numbers, a2p] = await Promise.all([
      get(env, `/Services/${s.sid}/PhoneNumbers?PageSize=50`),
      get(env, `/Services/${s.sid}/Compliance/Usa2p`),
    ]);
    const pool = Array.isArray(numbers?.phone_numbers)
      ? numbers.phone_numbers.map((p) => String(p.phone_number ?? ''))
      : [];
    return {
      sid: s.sid,
      friendly_name: s.friendly_name ?? null,
      senders: pool.length,
      // The single most useful line: is the number we actually send from
      // inside THIS service's pool? A campaign-approved service that does not
      // contain our number is still the wrong answer.
      carries_our_number: want ? pool.includes(want) : null,
      a2p_campaign: a2p?._error ? null : (a2p?.campaign_status ?? a2p?.status ?? null),
      a2p_use_case: a2p?._error ? null : (a2p?.us_app_to_person_usecase ?? null),
    };
  }));

  // The right service is the one that is BOTH campaign-approved and holds the
  // number we send from. Ranked rather than filtered, so a near-miss is
  // visible instead of silently absent.
  const score = (s) =>
    (String(s.a2p_campaign ?? '').toUpperCase() === 'APPROVED' ? 2 : 0) +
    (s.carries_our_number ? 1 : 0);
  const ranked = [...detailed].sort((a, b) => score(b) - score(a));
  const best = ranked[0] && score(ranked[0]) > 0 ? ranked[0] : null;

  return { ok: true, from: want || null, services: ranked, recommended: best };
}

/** GET /api/admin/twilio — admin key required. */
export async function handleTwilioDiag(request, env) {
  const json = (status, body) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
    return json(404, { error: 'not found' });
  }

  const configured = diagnose(env.TWILIO_MESSAGING_SERVICE_SID);
  const account = await inspectAccount(env);

  const fix = account.ok && account.recommended && !configured.ok
    ? `printf '%s' '${account.recommended.sid}' | npx wrangler secret put TWILIO_MESSAGING_SERVICE_SID --config wrangler.app.jsonc`
    : null;

  return json(200, {
    configured,
    account,
    // The command to run, spelled out. The whole point of this endpoint is
    // that nobody should have to reconstruct it from three doc pages at the
    // moment they discover SMS has been down for four days.
    fix,
  });
}
