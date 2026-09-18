/**
 * privy.mjs — a member's own crypto wallet, created for them without ever
 * asking them to understand one.
 *
 * ── WHY PRIVY, AND WHY IT IS NOT A NEW VENDOR DECISION ───────────────────
 *
 * Stripe acquired Privy in June 2025. Privy's fiat on-ramp already routes
 * through Stripe and its bank rails through Bridge, and Stripe Issuing
 * documents spending just-in-time from a Privy wallet. NUM's entire money
 * stack is already Stripe — pay.mjs, flightpay.mjs, billpay.mjs, Connect —
 * so this keeps one vendor rather than adding a second.
 *
 * ── THE FOUR RULES, AND THEY ARE THE WHOLE FILE ──────────────────────────
 *
 * 1. NUM NEVER HOLDS THE KEY. Privy splits key material and signs inside a
 *    TEE; this module stores a public address and two Privy ids. There is no
 *    private key in this codebase, in D1, or in a Worker secret. That is what
 *    keeps an embedded wallet out of custody — and out of the money
 *    transmitter definition that cashout.mjs is written around.
 *
 * 2. NUM NEVER FUNDS A WALLET. There is deliberately no function here that
 *    moves value in. A member funds it from their own bank through Privy's
 *    licensed on-ramp, or receives earned payouts. Selling a member USDC, or
 *    letting purchased Stars become USDC, is cash-in-cash-out — the exact
 *    shape worker/cashout.mjs exists to refuse. One convenience function here
 *    would undo that reasoning silently.
 *
 * 3. STARS AND THIS WALLET ARE NEVER ONE NUMBER. balances.mjs already refuses
 *    to net `held` against `owed` for the same reason: two different assets
 *    added together produce a figure nobody can check. A member sees ★ and
 *    USDC as two lines, always.
 *
 * 4. A WALLET NEEDS A VERIFIED HUMAN. Only a phone-verified member gets one,
 *    checked here rather than assumed by the caller. The 5arz ledger already
 *    has two members sharing one address (defect #8 in the CTO handoff), and
 *    5arz publishes both an EIP-191 wallet challenge and an on-chain
 *    `isVerifiedHuman(wallet)` on Base. Binding this address to a
 *    Proof-of-Personhood credential through those is the next step and is NOT
 *    done here; the phone gate is the floor, not the ceiling.
 *
 * ── READINESS IS DERIVED ─────────────────────────────────────────────────
 * This codebase has been bitten twice by a configured-but-not-working
 * credential. `privyReady` asks whether both halves are present; a call that
 * fails says which half is missing rather than throwing an opaque 401.
 */

const API = 'https://api.privy.io/v1';

/** USDC on Base. Six decimals, not eighteen — payouts/chain.mjs says the same. */
export const USDC_BASE = Object.freeze({
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC', chain: 'base', chainId: 8453,
});

export const privyReady = (env) => !!(env?.PRIVY_APP_ID && env?.PRIVY_APP_SECRET);
export const privyNeeds = (env) => [
  !env?.PRIVY_APP_ID && 'PRIVY_APP_ID (Privy dashboard → App settings)',
  !env?.PRIVY_APP_SECRET && 'PRIVY_APP_SECRET',
].filter(Boolean);

/**
 * One HTTP client, so there is one opinion about auth, timeouts and errors.
 * Privy wants BOTH Basic auth and the app id as a header — a request missing
 * either is rejected, which is a 401 that looks like bad credentials when it
 * is actually a missing header.
 */
export async function privyCall(env, path, body = null, method = 'POST', idem = null) {
  if (!privyReady(env)) {
    const err = new Error(`privy is not configured: ${privyNeeds(env).join('; ')}`);
    err.status = 503;
    throw err;
  }
  const auth = btoa(`${env.PRIVY_APP_ID}:${env.PRIVY_APP_SECRET}`);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'privy-app-id': env.PRIVY_APP_ID,
      'Content-Type': 'application/json',
      ...(idem ? { 'privy-idempotency-key': String(idem).slice(0, 128) } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(parsed?.error || parsed?.message || `Privy ${res.status}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

/** The embedded wallet inside a Privy user payload. Privy returns it as a linked account. */
export function addressFromUser(user) {
  const w = (user?.linked_accounts ?? []).find(
    (a) => a?.type === 'wallet' && a?.wallet_client === 'privy' && a?.address,
  ) ?? (user?.linked_accounts ?? []).find((a) => a?.type === 'wallet' && a?.address);
  if (!w?.address) return null;
  return { address: String(w.address), chain_type: String(w.chain_type || 'ethereum') };
}

/** What NUM has on file. Read-only, and the only thing most callers want. */
export async function walletFor(env, memberId) {
  if (!env?.DB || !memberId) return null;
  const row = await env.DB.prepare(
    `SELECT member_id, address, chain, chain_type, privy_user_id, privy_wallet_id, state, created_at
       FROM num_member_wallets WHERE member_id = ?1 AND state = 'active'`,
  ).bind(String(memberId)).first().catch(() => null);
  return row ?? null;
}

/**
 * Give this member a wallet, once.
 *
 * Pregenerated: Privy creates the user and the wallet from the phone number
 * NUM already verified, before the member has ever heard the word wallet. The
 * idempotency key is the member id, so a double tap, a retry, or two devices
 * racing produce ONE Privy user and ONE address — without it, a retry after a
 * dropped response would leave a member with two wallets and NUM pointing at
 * the empty one.
 *
 * Returns `{ ok, wallet }` or `{ ok: false, reason }`. Never throws for the
 * ordinary refusals, because the caller is usually rendering a screen.
 */
export async function ensureWalletFor(env, memberId) {
  if (!env?.DB || !memberId) return { ok: false, reason: 'missing member' };

  const existing = await walletFor(env, memberId);
  if (existing) return { ok: true, wallet: existing, already: true };

  if (!privyReady(env)) return { ok: false, reason: 'wallets are not switched on yet', needs: privyNeeds(env) };

  // RULE 4, enforced here rather than trusted from the caller.
  const m = await env.DB.prepare(
    'SELECT id, phone, phone_verified FROM num_members WHERE id = ?1',
  ).bind(String(memberId)).first().catch(() => null);
  if (!m) return { ok: false, reason: 'no such member' };
  if (Number(m.phone_verified) !== 1 || !m.phone) {
    return { ok: false, reason: 'verify your number first — a wallet belongs to one confirmed person' };
  }

  let user;
  try {
    user = await privyCall(env, '/users', {
      linked_accounts: [{ type: 'phone', number: String(m.phone) }],
      wallets: [{ chain_type: 'ethereum' }],
    }, 'POST', `num-wallet-${memberId}`);
  } catch (e) {
    console.warn('[privy] create user', e?.status, e?.message);
    return { ok: false, reason: 'could not create a wallet just now', status: e?.status ?? 0 };
  }

  const w = addressFromUser(user);
  if (!w) return { ok: false, reason: 'Privy created no wallet on that account' };

  // INSERT OR IGNORE, then re-read: two requests that got past the check above
  // still end with one row, and the row that wins is the one everybody reads.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO num_member_wallets
       (member_id, privy_user_id, privy_wallet_id, address, chain, chain_type)
     VALUES (?1, ?2, ?3, ?4, 'base', ?5)`,
  ).bind(String(memberId), user?.id ?? null, null, w.address, w.chain_type).run();

  const saved = await walletFor(env, memberId);
  return saved ? { ok: true, wallet: saved } : { ok: false, reason: 'wallet was created but not saved' };
}

/**
 * What is actually in it, asked of the chain.
 *
 * READ ONLY. One `eth_call` to USDC's `balanceOf`. There is no signer here and
 * no transaction is ever sent from this file — the worst a lying RPC endpoint
 * can do is show a wrong number on a screen, which is why this is safe to call
 * from an app route and why growth/rpc.mjs states the same rule.
 *
 * Returns null rather than 0 when it cannot ask. A zero a member reads as
 * "my money is gone" is worse than "we cannot see it right now".
 */
export async function usdcBalance(env, address) {
  const a = String(address ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  const rpc = env?.USDC_RPC_URL || 'https://mainnet.base.org';
  // balanceOf(address) selector + 32-byte padded address
  const data = `0x70a08231${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC_BASE.address, data }, 'latest'] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body.error || typeof body.result !== 'string') return null;
    const units = BigInt(body.result);
    return {
      units: units.toString(),
      display: (Number(units) / 10 ** USDC_BASE.decimals).toFixed(2),
      symbol: USDC_BASE.symbol,
      chain: USDC_BASE.chain,
    };
  } catch {
    return null;
  }
}

/**
 * A spending policy for one bill, and the reason this is not just a nicety.
 *
 * "NUM just pays" on a card is a Stripe mandate a bank can refuse. On a chain
 * there is no bank to refuse anything and no reversal, so the limit has to be
 * enforced where the signing happens: Privy evaluates policies inside the
 * enclave, so a wallet carrying this policy CANNOT send to any address but
 * the venue's, whatever asks it to — including a compromised NUM Worker.
 *
 * Scoped to one recipient and one token, which is exactly what a bill code
 * already is: billqr.mjs inherits the destination from the venue's own sticker
 * and never takes it from the caller. Same rule, enforced twice.
 *
 * NOT wired to a wallet by default. A member opts in, once, and the policy id
 * is attached to their wallet — an always-on spending policy nobody asked for
 * is a standing instruction to move somebody's money.
 */
export async function createBillPolicy(env, { venueAddress, label = 'NUM bill' } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(venueAddress ?? ''))) {
    return { ok: false, reason: 'that is not a wallet address' };
  }
  try {
    const p = await privyCall(env, '/policies', {
      version: '1.0',
      name: String(label).slice(0, 50),
      chain_type: 'ethereum',
      rules: [{
        name: 'Only this venue',
        method: 'eth_sendTransaction',
        conditions: [{
          field_source: 'ethereum_transaction',
          field: 'to',
          operator: 'eq',
          value: String(venueAddress).toLowerCase(),
        }],
        action: 'ALLOW',
      }],
    }, 'POST', `num-billpolicy-${String(venueAddress).toLowerCase()}`);
    return { ok: true, policy_id: p?.id ?? null };
  } catch (e) {
    console.warn('[privy] policy', e?.status, e?.message);
    return { ok: false, reason: e?.message ?? 'Privy refused the policy', status: e?.status ?? 0 };
  }
}

/* ── routes: /api/wallet/… ─────────────────────────────────────────────────
   Anonymous callers get nothing. The member id is the caller's own, taken
   from the query the app already signs its other calls with. */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function handleWallet(request, env, path) {
  const url = new URL(request.url);
  const me = String(url.searchParams.get('me') ?? '').slice(0, 64);
  if (!me) return json({ error: 'who?' }, 401);

  if (path === '/' || path === '') {
    const w = await walletFor(env, me);
    if (!w) {
      return json({
        wallet: null,
        available: privyReady(env),
        // Said plainly, because "no wallet" and "wallets are off" are
        // different sentences and a guest deserves the right one.
        why: privyReady(env) ? null : 'wallets are not switched on yet',
      });
    }
    const balance = await usdcBalance(env, w.address);
    return json({
      wallet: { address: w.address, chain: w.chain, created_at: w.created_at },
      balance,
      note: 'This is yours, not NUM\'s. Stars are separate and are never added to this.',
    });
  }

  if (path === '/create' && request.method === 'POST') {
    const out = await ensureWalletFor(env, me);
    if (!out.ok) return json({ error: out.reason, needs: out.needs ?? undefined }, out.status === 503 ? 503 : 422);
    return json({ wallet: { address: out.wallet.address, chain: out.wallet.chain }, already: !!out.already });
  }

  return json({ error: 'not found' }, 404);
}
