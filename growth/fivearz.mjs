/**
 * Verifying a 5arz Proof-of-Personhood credential.
 *
 * ── THE TRAP AT THE CENTRE OF THIS FILE ──────────────────────────────────
 *
 * From the 5arz team, 12 Sep 2026:
 *
 *   "reject test:true and sample:true at every production gate — SANDBOX
 *    CREDENTIALS ARE SIGNED BY THE PRODUCTION KEY AND VERIFY."
 *
 * So the signature checking out proves the credential was issued by 5arz. It
 * does not prove a human was verified. Anyone who can hit
 * `POST /api/agents/register` with `mode:"test"` — no auth required — gets a
 * sandbox key, and a credential from it is cryptographically indistinguishable
 * from a real one except for two booleans in the payload.
 *
 * A verifier that stops at "signature valid" therefore hands a human badge to
 * anybody who read the docs. Every other check in this file is ordinary
 * diligence; `test` and `sample` are the ones that decide whether the badge
 * means anything, and they are checked LAST so that no earlier `return`
 * can skip past them.
 *
 * ── AND THE ONE WE MUST NOT REPEAT ───────────────────────────────────────
 *
 * 5arz's own exec review has killing `hmac-v0` on its Tier 2 list, because a
 * symmetric key means *every verifier can forge a credential*. This file
 * therefore accepts **ES256 and nothing else**, resolved against the published
 * JWKS. `alg: "none"` and any HMAC algorithm are rejected before a key is
 * even fetched — that is the oldest JWT vulnerability there is and it is
 * live-adjacent here.
 *
 * ── WHAT WE DELIBERATELY DO NOT BUILD ON ─────────────────────────────────
 *
 *   · `unique_human` — the 5arz team say not to. Not used, not surfaced.
 *   · `liveness` — a literal in the payload today, not a measurement. Passed
 *     through as `liveness_claimed` so nobody reads it as a fact.
 */

export const ISSUER = 'https://5arz.com';          // not api.5arz.com
export const VCT = 'https://5arz.com/credentials/proof-of-personhood';
export const TYP = 'vi+jwt';                        // not "JWT"
export const JWKS_URL = 'https://api.5arz.com/.well-known/jwks.json';
export const API_BASE = 'https://api.5arz.com';

/**
 * The only `env` a production gate accepts.
 *
 * Proven live on 12 Sep: a sandbox credential carries `env: "test"` and the
 * public sample carries `env: "sample"`. Neither is production. We have never
 * seen a live credential, so we do not know whether it carries
 * `env: "production"` or omits the field — therefore this rejects `env` only
 * when it is PRESENT and wrong. If it were required outright, a live
 * credential that simply omits it would be refused and no host could ever
 * verify. `test` and `sample` remain the gates that actually decide.
 */
export const ENV_PRODUCTION = 'production';

/**
 * A polite, identifiable client name on the JWKS fetch.
 *
 * 5arz's edge 403'd the default `Python-urllib` across the whole origin. Our
 * Worker would not be caught by that rule today, but an anonymous fetch is one
 * edge-rule change away from breaking every verification we do, with no error
 * we could read.
 */
export const USER_AGENT = 'num-host-board (+https://itsnum.com)';

/** Small clock allowance, both directions. Servers disagree. */
export const SKEW_S = 120;

const b64urlToBytes = (s) => {
  const pad = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const jsonPart = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

const no = (why, extra = {}) => ({ ok: false, why, ...extra });

/**
 * Split and read a compact JWS without trusting any of it yet.
 *
 * Header and payload are attacker-controlled until the signature is checked.
 * Nothing in here decides anything; it only makes the bytes readable.
 */
export function peek(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return no('not a compact JWS');
  try {
    return { ok: true, header: jsonPart(parts[0]), payload: jsonPart(parts[1]), parts };
  } catch {
    return no('header or payload is not JSON');
  }
}

/**
 * Which key signed this, if we are allowed to look for one at all.
 *
 * The algorithm is checked BEFORE the key is fetched. `alg: "none"` and the
 * HMAC family are the classic forgeries, and with a symmetric path existing
 * elsewhere in this ecosystem they are not hypothetical.
 */
export function checkHeader(header) {
  if (!header || typeof header !== 'object') return no('no header');
  if (header.alg !== 'ES256') return no(`alg is ${header.alg ?? 'missing'}, and only ES256 is accepted`);
  if (!header.kid) return no('no kid, so no key can be resolved');
  // The team's note is explicit: typ is vi+jwt, so do not assert JWT.
  if (header.typ && header.typ !== TYP) return no(`typ is ${header.typ}, expected ${TYP}`);
  return { ok: true };
}

/** JWKS, cached briefly. A rotation must be picked up without a deploy. */
let JWKS = { at: 0, keys: [], refetched: 0 };
export const JWKS_TTL_MS = 10 * 60 * 1000;

/**
 * How rarely an unknown `kid` may force a fresh fetch.
 *
 * An unknown kid is the shape of a key rotation, and we must pick one up
 * without a deploy. It is ALSO the shape of an attacker feeding us made-up kids
 * to make us hammer 5arz — so the rescue is allowed at most once a day, as
 * 5arz asked. Retired public keys stay published indefinitely, so a kid that is
 * genuinely theirs will be in a day-old key set anyway.
 */
export const JWKS_REFETCH_MIN_MS = 24 * 60 * 60 * 1000;

export async function jwks(fetchImpl = fetch, now = Date.now(), { force = false } = {}) {
  if (!force && JWKS.keys.length && now - JWKS.at < JWKS_TTL_MS) return JWKS.keys;
  if (force && JWKS.refetched && now - JWKS.refetched < JWKS_REFETCH_MIN_MS) return JWKS.keys;
  const res = await fetchImpl(JWKS_URL, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = await res.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  JWKS = { at: now, keys, refetched: force ? now : JWKS.refetched };
  return keys;
}

/** Only for tests — the module-level cache would otherwise leak between them. */
export const __resetJwks = () => { JWKS = { at: 0, keys: [], refetched: 0 }; };

async function verifySignature(parts, jwk) {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
}

/**
 * The whole check.
 *
 * Returns a reason on every failure, because a host told only "not verified"
 * has nothing to fix and will assume the badge is broken.
 */
export async function verifyPersonhood(token, { fetchImpl = fetch, now = Date.now() } = {}) {
  const read = peek(token);
  if (!read.ok) return read;

  const head = checkHeader(read.header);
  if (!head.ok) return head;

  let keys;
  try {
    keys = await jwks(fetchImpl, now);
  } catch (e) {
    // Fail CLOSED. A JWKS we cannot reach means we cannot verify anybody, and
    // "cannot verify" is never "verified".
    return no(`could not reach the 5arz key set (${e?.message ?? e})`, { retryable: true });
  }
  let jwk = keys.find((k) => k.kid === read.header.kid);
  if (!jwk) {
    // Could be a rotation we have not seen. One forced refetch, rate-limited to
    // daily, then we give up — an unknown kid is never "probably fine".
    try { jwk = (await jwks(fetchImpl, now, { force: true })).find((k) => k.kid === read.header.kid); }
    catch { /* keep the original rejection below; a failed rescue is not a pass */ }
  }
  if (!jwk) return no(`kid ${read.header.kid} is not in the 5arz key set`);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return no('the resolved key is not a P-256 key');

  let good = false;
  try { good = await verifySignature(read.parts, jwk); } catch { good = false; }
  if (!good) return no('the signature does not check out');

  const p = read.payload ?? {};
  if (p.iss !== ISSUER) return no(`iss is ${p.iss ?? 'missing'}, expected ${ISSUER}`);
  if (p.vct !== VCT) return no(`vct is ${p.vct ?? 'missing'}, expected ${VCT}`);

  const nowS = Math.floor(now / 1000);
  if (Number.isFinite(p.exp) && nowS > p.exp + SKEW_S) return no('that credential has expired');
  if (Number.isFinite(p.nbf) && nowS + SKEW_S < p.nbf) return no('that credential is not valid yet');

  /* ── LAST, AND THE ONLY ONES THAT DECIDE WHETHER THE BADGE MEANS ANYTHING ──
   *
   * Everything above proves 5arz issued this. Neither of these is implied by
   * that, because sandbox credentials are signed by the production key.
   * Checked last so no earlier branch can return past them. */
  if (p.test === true) return no('that is a sandbox credential, not a real one', { sandbox: true });
  if (p.sample === true) return no('that is a sample credential, not a real one', { sandbox: true });
  if (p.env !== undefined && p.env !== ENV_PRODUCTION) {
    return no(`that credential is marked env "${p.env}", not production`, { sandbox: true });
  }

  return {
    ok: true,
    /**
     * `sub_hash`, never a member id.
     *
     * Proven live on 12 Sep: the payload has NO `sub` claim at all — reading
     * one gave `null` every time, which would have looked like a credential
     * without a subject. `sub_hash` is SHA-256 of the 5arz member id, so it
     * identifies the same human across credentials while being safe to put in
     * a receipt a third party will read.
     */
    sub_hash: typeof p.sub_hash === 'string' ? p.sub_hash : null,
    /** The revocation handle. A consent receipt without this cannot be undone. */
    jti: typeof p.jti === 'string' ? p.jti : null,
    issued_at: p.iat ?? null,
    expires_at: p.exp ?? null,
    kid: read.header.kid,
    /**
     * The one assertion 5arz say is actually measured: a document check
     * happened. Either spelling, because their payloads have used both.
     */
    id_verified: p.id_verified === true || p.identity_verified === true,
    method: typeof p.method === 'string' ? p.method : null,
    assurance: typeof p.assurance === 'string' ? p.assurance : null,
    /**
     * Claimed, not measured. 5arz's own 4 Sep audit lists `liveness` and
     * `verified` as bare literals written into the payload rather than computed
     * — so they are renamed here. A field called `liveness_claimed` cannot end
     * up rendered to a member as "liveness verified" by a later careless edit;
     * a field called `liveness` can, and would be a lie in our UI about our
     * parent company's product.
     */
    liveness_claimed: p.liveness === true,
    verified_claimed: p.verified === true,
    /** Likewise: 5arz return `sybil_checked:false` today. Never shown as a pass. */
    sybil_checked_claimed: p.sybil_checked === true,
    // `unique_human` is deliberately absent. The 5arz team say not to build
    // on it, so it is not read and not surfaced — a field that is not here
    // cannot be depended on by accident later.
  };
}

/** Ask 5arz to mint a credential for one of our hosts. */
export async function mintPersonhood(env, memberId, fetchImpl = fetch) {
  if (!env?.FIVEARZ_API_KEY) return no('no 5arz key configured on this Worker');
  if (!memberId) return no('memberId is required');
  const res = await fetchImpl(`${API_BASE}/api/agents/verify-personhood`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.FIVEARZ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ memberId: String(memberId) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return no(`5arz said ${res.status}: ${body?.error ?? 'no reason given'}`);
  /**
   * The field is `pop_jwt`.
   *
   * Proven against live production on 12 Sep 2026. Both our earlier guess
   * (`credential` / `jwt` / `token`) and the 5arz handoff's own documented
   * shape (`jwt` / `pohf_jwt`) were WRONG: the live 200 response carries
   * `pop_jwt`, plus `attestationId` and a top-level `testMode`. Reading the
   * wrong field yields `null` with `ok:true` — a silent pass with no credential
   * to verify, which is the worst possible failure here. The fallbacks stay in
   * case they rename it, but `pop_jwt` leads because it is the one we have
   * actually seen.
   */
  const credential = body.pop_jwt ?? body.pohf_jwt ?? body.jwt ?? body.credential ?? body.token ?? null;
  if (!credential) return no('5arz returned no credential field we recognise', { raw: body });
  return {
    ok: true,
    credential,
    /** Their own id for the attestation — the audit trail on their side. */
    attestation_id: body.attestationId ?? body.attestation_id ?? null,
    /**
     * Their top-level sandbox flag, separate from the `test` claim inside the
     * payload. Surfaced so a caller can refuse before verifying, but the gate
     * that decides is still inside verifyPersonhood.
     */
    test_mode: body.testMode === true,
    raw: body,
  };
}

/**
 * Bind a verified human to a payment.
 *
 * This is 5arz revenue surface #3 and the reason the board exists in this
 * shape. Called AFTER the payment settles — binding an unpaid job records a
 * human behind money that never moved.
 */
export async function bindTransaction(env, { paymentRef, memberId, sessionId, workRef }, fetchImpl = fetch) {
  if (!env?.FIVEARZ_API_KEY) return no('no 5arz key configured on this Worker');
  if (!paymentRef) return no('paymentRef is required');
  if (!memberId && !sessionId) return no('one of memberId or sessionId is required');
  const res = await fetchImpl(`${API_BASE}/api/agents/bind-transaction`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.FIVEARZ_API_KEY}`,
      'content-type': 'application/json',
    },
    // `test` is never sent from here. A production binding marked test is a
    // record that looks real in our database and is not one in theirs.
    body: JSON.stringify({ paymentRef, ...(sessionId ? { sessionId } : { memberId }), ...(workRef ? { workRef } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return no(`5arz said ${res.status}: ${body?.error ?? 'no reason given'}`);
  return { ok: true, binding: body };
}
