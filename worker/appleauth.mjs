/**
 * Verifying "Sign in with Apple", properly.
 *
 * ── THE ONLY RULE THAT MATTERS ────────────────────────────────────────────
 *
 * The device sends a JWT. A JWT is a string, and a string a client controls is
 * a claim, not a fact. Everything here exists to turn one into the other:
 * fetch Apple's public keys, check the signature against them, and only then
 * read a single field out of the payload.
 *
 * This codebase has been here before. SEC-001 was an account takeover that
 * needed nothing more than an endpoint returning an id it had not proved the
 * caller owned. Decoding this token without verifying it would be the same
 * bug wearing a bigger word: anyone could mint `{"sub":"<your apple id>"}`,
 * base64 it, and sign in as you.
 *
 * So: no "decode and trust", no dev shortcut, no `skipVerify` flag. There is
 * one code path and it verifies.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * App Review rejected 1.0(2) under guideline 4.8 — the app offered a
 * third-party login (Google, for 5arz identity linking) with no equivalent
 * privacy-preserving option. Sign in with Apple is Apple's own named example.
 *
 * It is also, incidentally, the first sign-in Num has that does not depend on
 * SMS. Of 129 members, 2 have ever completed phone verification.
 */

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';

/** Default audience: the iOS bundle id. Overridable for the Android/web flows. */
export const DEFAULT_AUDIENCE = 'com.itsnum.app';

/** base64url → bytes. Not base64: the alphabet and the padding both differ. */
export function b64urlToBytes(s) {
  const norm = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

/**
 * Apple's public keys, cached in memory for the isolate's life.
 *
 * Apple rotates these. A key id we have never seen is the NORMAL signal that a
 * rotation happened, so an unknown `kid` refetches once rather than failing —
 * but a refetch that still does not contain it fails closed. "Try again with
 * no signature check" is not a fallback, it is the vulnerability.
 */
let keyCache = { at: 0, keys: null };
const KEY_TTL_MS = 60 * 60 * 1000;

export async function appleKeys(fetchImpl = fetch, { force = false } = {}) {
  const fresh = keyCache.keys && Date.now() - keyCache.at < KEY_TTL_MS;
  if (fresh && !force) return keyCache.keys;
  const res = await fetchImpl(APPLE_KEYS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`apple keys HTTP ${res.status}`);
  const body = await res.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  if (!keys.length) throw new Error('apple returned no keys');
  keyCache = { at: Date.now(), keys };
  return keys;
}

/** Test seam only — never call from request code. */
export function __resetAppleKeyCache() { keyCache = { at: 0, keys: null }; }

async function importKey(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

/**
 * Verify an Apple identity token and return the claims it actually proves.
 *
 * @returns {{ sub: string, email: string|null, emailVerified: boolean, isPrivateRelay: boolean }}
 * @throws  on ANY failure — bad shape, unknown key, bad signature, wrong
 *          issuer, wrong audience, expired. The caller must not catch and
 *          continue; there is no partially-valid token.
 */
export async function verifyAppleToken(token, {
  audience = DEFAULT_AUDIENCE,
  now = Date.now(),
  fetchImpl = fetch,
} = {}) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = b64urlToJson(headerB64);
  // Pinned, not read-and-obeyed. `alg: none` and HMAC-with-the-public-key are
  // the two classic JWT forgeries and both start with trusting this field.
  if (header?.alg !== 'RS256') throw new Error(`unexpected alg ${header?.alg}`);
  if (!header?.kid) throw new Error('no kid');

  let keys = await appleKeys(fetchImpl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await appleKeys(fetchImpl, { force: true });
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('unknown apple key id');

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    await importKey(jwk),
    b64urlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) throw new Error('bad signature');

  const claims = b64urlToJson(payloadB64);
  if (claims?.iss !== APPLE_ISSUER) throw new Error('wrong issuer');

  // `aud` is what stops a token minted for somebody else's app signing in to
  // ours. Apple sends a string; an array is accepted defensively.
  const auds = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  if (!auds.includes(audience)) throw new Error('wrong audience');

  const exp = Number(claims?.exp) * 1000;
  if (!Number.isFinite(exp) || exp <= now) throw new Error('token expired');

  if (!claims?.sub) throw new Error('no subject');

  return {
    sub: String(claims.sub),
    email: typeof claims.email === 'string' ? claims.email : null,
    // Apple sends these as booleans OR as the strings "true"/"false".
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    isPrivateRelay: claims.is_private_email === true || claims.is_private_email === 'true',
  };
}
