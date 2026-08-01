// Compartmented capability tokens.
//
// The problem this solves: every member endpoint in social.mjs and pay.mjs
// establishes identity by reading `b.me` or `?me=` out of the request. There
// is no proof of possession, so a member ID *is* the credential — and member
// IDs are handed to other members by design (tab and plan rosters return
// them). Anyone you have shared a tab with can act as you, permanently, with
// no way to revoke it short of deleting the account. See security/THREAT_MODEL.md
// SEC-001.
//
// The shape of the fix, and why each piece is here:
//
//   • One root secret, never used to sign. Five compartment keys derived from
//     it with HKDF. A `social` token cannot verify against `money` — not
//     because a policy check refuses it, but because the money verifier
//     derives a different key and has never held the social one. Extracting
//     one compartment's key yields nothing about the others or the root.
//
//   • Keys are a function of (root, epoch), epoch = floor(now / 30d). So they
//     rotate on their own, on schedule, with no deploy and no key
//     distribution. A stolen token stops working whether or not we noticed it
//     was stolen. Verification accepts the previous epoch too, or rotation day
//     would log out every member at once.
//
//   • The algorithm is deliberately boring — HMAC-SHA256 and HKDF, both
//     standard, both analysed for decades. Rotation is what changes; the
//     primitive is not. A scheme that mutated its own algorithm would be a
//     scheme nobody has attacked, which is the opposite of trustworthy.
//
// Deliberately NOT here: a KV denylist for `jti`. Single-token revocation
// needs a KV binding that num-app does not have yet. `jti` is minted and
// signed now so the field exists when the binding lands — revokeAll (via the
// member's token_epoch) works today and covers the urgent case.

const ROOT_VAR = 'NUM_ROOT_KEY';

/** Rooms in the building. A token names exactly one. */
export const COMPARTMENTS = Object.freeze({
  identity: 'identity',
  social: 'social',
  money: 'money',
  travel: 'travel',
  admin: 'admin',
});

/**
 * How long a token lives, by compartment.
 *
 * money/travel are minutes, not hours, because those are the compartments
 * where a replayed token spends real money. They are also the compartments a
 * user passes through deliberately (confirming a payment, confirming a
 * booking), so a short life costs nothing in practice — the token is minted,
 * used, and discarded inside one interaction.
 */
export const TTL_SECONDS = Object.freeze({
  identity: 24 * 3600,
  social: 24 * 3600,
  money: 15 * 60,
  travel: 15 * 60,
  admin: 3600,
});

/** 30 days. Rotation is automatic; this is the only knob. */
export const EPOCH_MS = 30 * 24 * 3600 * 1000;

export const epochFor = (now = Date.now()) => Math.floor(now / EPOCH_MS);

const enc = new TextEncoder();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
};

/**
 * Constant-time compare.
 *
 * Not because a timing oracle over Cloudflare's network jitter is a practical
 * forgery path — it is not — but because there should be exactly one way to
 * compare a secret in this codebase. Today ADMIN_KEY is compared five
 * different ways across five files (SEC-002), which is how the one that
 * matters eventually gets it wrong.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * K_compartment[epoch] = HKDF-SHA256(root, salt = epoch, info = "num.v1.<compartment>")
 *
 * Derived per call rather than cached. A Worker isolate can live for hours and
 * serve many members; holding five keys in module scope for that whole time
 * widens what a memory-disclosure bug would hand over, and HKDF over 32 bytes
 * is not a cost worth that trade.
 */
async function compartmentKey(env, compartment, epoch) {
  const root = env?.[ROOT_VAR];
  if (!root) throw new Error(`${ROOT_VAR} is not configured on this Worker`);
  if (!COMPARTMENTS[compartment]) throw new Error(`unknown compartment: ${compartment}`);

  const base = await crypto.subtle.importKey('raw', enc.encode(root), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(String(epoch)), info: enc.encode(`num.v1.${compartment}`) },
    base,
    256,
  );
  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const sign = async (key, data) => b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));

/**
 * Mint a token.
 *
 * @param {object} env
 * @param {object} claims
 * @param {string} claims.sub          member id — an identifier now, not a credential
 * @param {string} claims.compartment  one of COMPARTMENTS
 * @param {string[]} [claims.scope]    actions within the compartment, e.g. ['tab:settle']
 * @param {number} [claims.memberEpoch] bump per-member to revoke all their tokens
 * @returns {Promise<string>}
 */
export async function mint(env, { sub, compartment, scope = [], memberEpoch = 0 }, now = Date.now()) {
  if (!sub) throw new Error('sub is required');
  if (!COMPARTMENTS[compartment]) throw new Error(`unknown compartment: ${compartment}`);

  const epoch = epochFor(now);
  const payload = b64url(
    enc.encode(
      JSON.stringify({
        sub,
        scope,
        me: memberEpoch,
        exp: Math.floor(now / 1000) + TTL_SECONDS[compartment],
        jti: crypto.randomUUID(),
      }),
    ),
  );

  const signed = `v1.${compartment}.${epoch}.${payload}`;
  return `${signed}.${await sign(await compartmentKey(env, compartment, epoch), signed)}`;
}

/**
 * Verify a token against ONE compartment.
 *
 * The caller names the compartment it is protecting. A token minted for
 * another compartment fails here with `wrong_compartment` — the verifier never
 * derives the key that would validate it. That is the whole isolation
 * property, and it is why `compartment` is a required argument rather than
 * something read out of the token and trusted.
 *
 * @returns {Promise<{ok: true, sub: string, scope: string[], jti: string, epoch: number}
 *                 | {ok: false, reason: string}>}
 */
export async function verify(env, token, compartment, { now = Date.now(), memberEpoch = 0 } = {}) {
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 5) return { ok: false, reason: 'malformed' };
  const [ver, tokenCompartment, epochStr, payload, sig] = parts;

  if (ver !== 'v1') return { ok: false, reason: 'bad_version' };
  if (tokenCompartment !== compartment) return { ok: false, reason: 'wrong_compartment' };

  const epoch = Number(epochStr);
  if (!Number.isInteger(epoch)) return { ok: false, reason: 'malformed' };

  // Current epoch or the one before it. Anything older is expired by
  // rotation; anything newer is a clock-skew forgery attempt.
  const current = epochFor(now);
  if (epoch !== current && epoch !== current - 1) return { ok: false, reason: 'stale_epoch' };

  const signed = `${ver}.${tokenCompartment}.${epochStr}.${payload}`;
  const expected = await sign(await compartmentKey(env, compartment, epoch), signed);
  if (!safeEqual(sig, expected)) return { ok: false, reason: 'bad_signature' };

  // Only parse AFTER the signature holds. Parsing attacker-controlled JSON
  // before verifying it is how a forged token reaches the JSON parser.
  let claims;
  try {
    claims = JSON.parse(b64urlDecode(payload));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof claims?.exp !== 'number' || claims.exp < Math.floor(now / 1000)) {
    return { ok: false, reason: 'expired' };
  }

  // Per-member revocation: bump num_members.token_epoch and every token this
  // member holds stops verifying, without touching anyone else.
  if ((claims.me ?? 0) < memberEpoch) return { ok: false, reason: 'revoked' };

  return { ok: true, sub: claims.sub, scope: claims.scope ?? [], jti: claims.jti, epoch };
}

/** Does a verified token carry this scope? Compartment gets you in the room. */
export const hasScope = (result, scope) => !!result?.ok && result.scope.includes(scope);

/**
 * Migration bridge.
 *
 * Accepts a signed token OR the legacy `?me=` / `body.me` parameter, and says
 * which one it got. This is what makes the rollout safe to deploy today:
 * nothing is rejected that works now, so no live session breaks, but every
 * legacy call is counted.
 *
 * Read `legacy: true` in the caller as "this request was unauthenticated" —
 * because it was. When the daily legacy count reaches zero, `allowLegacy` goes
 * false and `?me=` becomes a forgery signal instead of a supported path.
 *
 * @returns {Promise<{sub: string|null, legacy: boolean, scope: string[], reason?: string}>}
 */
export async function identify(env, request, compartment, { body = null, allowLegacy = true, memberEpoch = 0 } = {}) {
  const header = request.headers.get('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (bearer) {
    const result = await verify(env, bearer, compartment, { memberEpoch });
    if (result.ok) return { sub: result.sub, legacy: false, scope: result.scope };
    // A malformed or forged token is never silently downgraded to the legacy
    // path — that would hand an attacker a way to skip verification by sending
    // garbage. Presenting a token means being judged on it.
    return { sub: null, legacy: false, scope: [], reason: result.reason };
  }

  if (!allowLegacy) return { sub: null, legacy: false, scope: [], reason: 'token_required' };

  const url = new URL(request.url);
  const legacyId = (body?.me ?? url.searchParams.get('me') ?? '').toString().slice(0, 40) || null;
  if (legacyId) {
    console.warn(`[capability] legacy unauthenticated identity on ${compartment}: ${url.pathname}`);
    return { sub: legacyId, legacy: true, scope: [] };
  }

  return { sub: null, legacy: false, scope: [], reason: 'no_identity' };
}
