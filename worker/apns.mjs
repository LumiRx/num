// Sending to an iPhone.
//
// This file is the thing that did not exist. src/lib/native.ts has been asking
// people for notification permission, receiving an APNs token, and POSTing it to
// /api/push/native since the native shell shipped — and there was no handler and
// no sender. Every yes was thrown away, and on iOS a no is close to permanent.
//
// Built against Apple's own specification rather than memory, because every
// mistake here fails SILENTLY: a wrong header, a stale token or the wrong host
// returns a 4xx that nobody sees, and the person simply never hears from us.
//   https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
//   https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns

export const APNS_HOST = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** Apple's hard limit on the payload. Not negotiable, and worth enforcing here
 *  rather than discovering as a 413 per device. */
export const MAX_PAYLOAD = 4096;

/**
 * Reasons Apple tells us never to retry.
 *
 * Copied from the response-handling page verbatim, because "retry anyway" on
 * these is how a provider gets its connection dropped: APNs disconnects a
 * provider with too many error conditions, and sooner for BadDeviceToken.
 */
export const NEVER_RETRY = new Set([
  'BadDeviceToken', 'DeviceTokenNotForTopic', 'Forbidden',
  'ExpiredToken', 'Unregistered', 'PayloadTooLarge',
]);

/**
 * Reasons that mean the token is dead and should stop being used.
 *
 * Note 410 is explicitly NOT an error condition per Apple — it is the normal way
 * to learn somebody deleted the app. Disabling the row is the correct response,
 * and retrying it forever is what fills a log with noise and gets us throttled.
 */
export const DEAD_TOKEN = new Set(['Unregistered', 'ExpiredToken', 'BadDeviceToken', 'DeviceTokenNotForTopic']);

export const apnsReady = (env) => !!(
  env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID
);

/**
 * Which environment OUR key can serve.
 *
 * Apple now scopes team keys: "These keys restrict usage to either Sandbox or
 * Production." One key cannot serve both, and using a token from a key of the
 * wrong environment is an error rather than a silent miss.
 *
 * Defaults to production, which is what an App Store build AND a TestFlight
 * build both use. Only a debug build installed from Xcode talks to sandbox, so
 * production is the right default for a shipped app and the wrong one only while
 * somebody is debugging on their own device.
 *
 * Set APNS_ENVIRONMENT to 'sandbox' if the key you created was a Development key.
 */
export function keyEnvironment(env) {
  const v = String(env?.APNS_ENVIRONMENT || 'production').toLowerCase().trim();
  if (v === 'sandbox') return 'sandbox';
  // 'both' is a REAL case, not a convenience. Apple's newer team keys are scoped
  // to one environment, but keys created before that change still show
  // "Sandbox & Production" in the portal and Apple has said they keep working.
  // An account holding one of those would otherwise have its sandbox tokens
  // refused by us for a restriction its key does not actually have.
  if (v === 'both' || v === 'sandbox & production' || v === 'all') return 'both';
  return 'production';
}

/** Can the configured key serve a token from this environment? */
export const keyServes = (env, environment) => {
  const k = keyEnvironment(env);
  return k === 'both' || k === environment;
};

/** Why it is not ready, in words, because "push is off" is not a diagnosis. */
export function apnsMissing(env) {
  return ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID'].filter((k) => !env?.[k]);
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The .p8 Apple gives you, as bytes.
 *
 * It arrives as a PEM block. Workers' secret store keeps newlines, but a value
 * pasted through a form often loses them — so the header, the footer and ALL
 * whitespace are stripped rather than assumed, and what remains is the base64 of
 * a PKCS#8 key. Being tolerant here costs nothing and saves an afternoon of
 * "InvalidProviderToken" with a perfectly good key.
 */
export function p8ToBytes(pem) {
  const body = String(pem || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('APNS_KEY_P8 is empty or not a PEM key');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* ── The provider token, and why it is cached ─────────────────────────────
 *
 * Apple: "Update the authentication token no more than once every 20 minutes."
 * Exceed that and they answer 429 TooManyProviderTokenUpdates — so minting a
 * fresh JWT per notification does not merely waste CPU, it gets the whole batch
 * rejected. A token is valid for up to an hour.
 *
 * Cached for 45 minutes: comfortably inside the hour of validity, comfortably
 * outside the 20-minute update floor, and it survives a burst of sends on one
 * warm isolate. A cold isolate mints one, which is correct and cheap.
 */
let tokenCache = { jwt: null, exp: 0, kid: null };
export const TOKEN_TTL_MS = 45 * 60 * 1000;

export function _resetTokenCache() { tokenCache = { jwt: null, exp: 0, kid: null }; }

export async function providerToken(env, now = Date.now()) {
  if (tokenCache.jwt && tokenCache.exp > now && tokenCache.kid === env.APNS_KEY_ID) {
    return tokenCache.jwt;
  }
  const header = b64url(new TextEncoder().encode(JSON.stringify({
    alg: 'ES256', kid: String(env.APNS_KEY_ID),
  })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    iss: String(env.APNS_TEAM_ID), iat: Math.floor(now / 1000),
  })));

  const key = await crypto.subtle.importKey(
    'pkcs8', p8ToBytes(env.APNS_KEY_P8),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  // WebCrypto ECDSA returns the raw r||s pair, which is exactly what a JWS
  // ES256 signature is. No DER unwrapping needed — and attempting one here
  // would produce a signature Apple rejects as unverifiable.
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    new TextEncoder().encode(`${header}.${payload}`),
  );

  const jwt = `${header}.${payload}.${b64url(sig)}`;
  tokenCache = { jwt, exp: now + TOKEN_TTL_MS, kid: String(env.APNS_KEY_ID) };
  return jwt;
}

/**
 * The payload, inside Apple's 4KB.
 *
 * Truncates the body rather than letting APNs refuse the whole thing. A slightly
 * short sentence is a notification; a 413 is silence.
 */
export function buildPayload({ title, subtitle, body, url, kind, notifId, badge }) {
  const make = (b) => JSON.stringify({
    aps: {
      alert: {
        title: String(title || '').slice(0, 120),
        // THE LINE NUM WAS NOT USING.
        //
        // iOS gives three: title, subtitle, body. NUM only ever set two, so the
        // when and the where had to be crammed into the sentence a person reads,
        // and the sentence lost. The subtitle is a natural home for the fact —
        // "Saturday, 9am" or "Royal Phuket" — which leaves the body free to say
        // the thing worth saying.
        //
        // Omitted entirely when empty rather than sent as "": an empty subtitle
        // still reserves its line on some layouts, and a blank gap under a title
        // reads as something failing to load.
        ...(subtitle ? { subtitle: String(subtitle).slice(0, 80) } : {}),
        body: b,
      },
      sound: 'default',
      ...(badge === undefined ? {} : { badge }),
      // Lets the app update its own content when the notification arrives rather
      // than trusting what was baked in at send time.
      'mutable-content': 1,
    },
    // Custom keys travel alongside `aps` and are what the app taps through on.
    u: url || '/',
    k: kind || 'num',
    n: notifId || null,
  });

  let b = String(body || '');
  let out = make(b);
  // Shrink until it fits. Byte length, not string length — an emoji or a Thai
  // character is several bytes, and a character-count check would pass a payload
  // Apple then refuses.
  while (new TextEncoder().encode(out).length > MAX_PAYLOAD && b.length > 0) {
    b = b.slice(0, Math.max(0, b.length - Math.ceil(b.length * 0.1) - 1));
    out = make(b.length ? b + '…' : '');
  }
  return out;
}

/**
 * Send one notification to one device.
 *
 * Returns a verdict rather than throwing, because the caller's job is to record
 * what happened per token: { ok, status, reason, dead, retryAfterMs }.
 *
 * `collapseId` maps to the existing `tag` idea — a second "your table moved"
 * replaces the first on the lock screen instead of stacking. Nobody wants four
 * notifications about one table.
 */
export async function sendApns(env, {
  token, environment = 'production', title, subtitle, body, url, kind, notifId,
  collapseId, priority = 5, badge, bundleId,
}) {
  if (!apnsReady(env)) {
    return { ok: false, status: 0, reason: 'NotConfigured', dead: false, missing: apnsMissing(env) };
  }
  if (!token) return { ok: false, status: 0, reason: 'MissingDeviceToken', dead: true };

  // A token our key cannot serve is skipped, not attempted.
  //
  // Apple's team keys are environment-scoped, so a Production key sending to a
  // sandbox token fails every time — forever, on every sweep, incrementing the
  // fail count until the token is written off as broken when it is perfectly
  // good and simply belongs to the other door. Refusing up front keeps a
  // debugging device from looking like a dead one.
  const serves = keyEnvironment(env);
  if (!keyServes(env, environment)) {
    return {
      ok: false, status: 0, reason: 'WrongEnvironmentForKey', dead: false, retriable: false,
      detail: `this token is ${environment} and the configured key serves ${serves}`,
    };
  }

  const host = APNS_HOST[environment] || APNS_HOST.production;
  const payload = buildPayload({ title, subtitle, body, url, kind, notifId, badge });

  const headers = {
    authorization: `bearer ${await providerToken(env)}`,
    // Required on watchOS, recommended everywhere, and a mismatch lets Apple
    // delay or drop the notification. An alert is what this always is.
    'apns-push-type': 'alert',
    // The bundle id. For push type `alert` Apple requires the topic to be
    // exactly the app's bundle id, with no suffix.
    'apns-topic': String(bundleId || env.APNS_BUNDLE_ID),
    // 5, not 10, for anything proactive. Priority 10 means "interrupt them now"
    // and is for something they are waiting on; a suggestion is not that, and
    // 5 lets the device decide based on power. Using 10 for everything is how an
    // app earns a reputation for being rude.
    'apns-priority': String(priority),
    // Worth storing for 24 hours: a phone that is off overnight should still get
    // told in the morning. Zero would mean one attempt and then gone.
    'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400),
    'apns-id': crypto.randomUUID(),
    'content-type': 'application/json',
  };
  if (collapseId) headers['apns-collapse-id'] = String(collapseId).slice(0, 64);

  let res;
  try {
    res = await fetch(`${host}/3/device/${token}`, {
      method: 'POST', headers, body: payload,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // A network failure is not a dead token. Retriable, and never a reason to
    // stop sending to this device.
    return { ok: false, status: 0, reason: 'NetworkError', detail: String(e?.message ?? e), dead: false, retryAfterMs: 60_000 };
  }

  if (res.status === 200) {
    return { ok: true, status: 200, apnsId: res.headers.get('apns-id') };
  }

  let reason = null;
  let timestamp = null;
  try {
    const j = await res.json();
    reason = j?.reason ?? null;
    timestamp = j?.timestamp ?? null;
  } catch { /* an empty or non-JSON body is possible; the status still tells us */ }

  // A stale provider token is the one 403 worth acting on immediately: mint a
  // new one so the NEXT send in this batch succeeds instead of the whole run
  // failing behind one expired JWT.
  if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') {
    _resetTokenCache();
  }

  return {
    ok: false,
    status: res.status,
    reason: reason || `HTTP ${res.status}`,
    timestamp,
    dead: DEAD_TOKEN.has(reason),
    // 429 and 5xx are worth another go. Apple says wait 15 minutes on 5xx.
    retryAfterMs: res.status === 429 ? 60_000 : res.status >= 500 ? 15 * 60_000 : null,
    retriable: !NEVER_RETRY.has(reason) && res.status !== 403,
  };
}
