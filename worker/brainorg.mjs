/**
 * WHICH ANTHROPIC ACCOUNT IS ANSWERING OUR GUESTS?
 *
 * ── Why this file exists (7 Sep 2026) ─────────────────────────────────────
 *
 * The two brains at the top of the chain — `claude` and `haiku` — are the only
 * ones that emit `picks`, so they are the difference between a guest getting a
 * restaurant card with a link, a map and a phone number and a guest getting a
 * paragraph. When they stop, the product visibly degrades.
 *
 * They stopped on 5 Sep at 04:30Z, for two and a half days, because an
 * Anthropic account ran out of credit. And the question "WHICH account?" could
 * not be answered from inside the system. Nobody could read the Cloudflare
 * secret, so the honest answer was a guess: probably the same organisation
 * that pays for everything else.
 *
 * A dependency you cannot name is a dependency you cannot bill, cap, alert on,
 * or move. So this asks Anthropic directly, with the key the Worker already
 * holds:
 *
 *     GET https://api.anthropic.com/v1/organizations/me
 *
 * and it answers with the organisation's id and name. An ordinary API key is
 * enough — this is not an Admin-key endpoint.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────────
 *
 * It never returns the key, and it never returns a balance. There is no public
 * endpoint that reports remaining credit, so anything claiming to would be a
 * guess dressed as a fact — and a wrong "you have credit" reading is worse
 * than no reading, because it stops the person checking.
 *
 * `key_tail` is the last four characters, and only that. It exists for one
 * job: telling two keys apart when the answer to "did the new key actually
 * ship?" has to be yes or no. Same reason a bank prints the last four of a
 * card. The whole response is admin-gated regardless.
 *
 * ── Standing on its own ───────────────────────────────────────────────────
 *
 * "Host the brain on its own" is an account action, not a code change: a
 * dedicated Anthropic workspace with its own key and its own spend limit, so
 * that a spike anywhere else in the business can never again take the
 * concierge down. Code cannot create that. What code CAN do is verify it
 * afterwards, which is what `brainOrg()` is for — and `matchesExpected()`
 * turns the answer into a yes/no by comparing against BRAIN_ORG_EXPECT.
 */

const ORG_URL = 'https://api.anthropic.com/v1/organizations/me';
const API_VERSION = '2023-06-01';
const TTL_MS = 10 * 60 * 1000;

let cache = null; // { at, value }

/** Last four characters of a key, or null. Never more than four. */
export function keyTail(key) {
  const s = String(key ?? '');
  return s.length >= 4 ? s.slice(-4) : null;
}

/**
 * Ask Anthropic who owns the key this Worker is using.
 *
 * Tries `x-api-key` first because that is Anthropic's own header, then
 * `Authorization: Bearer` once on a 401 — some keys are issued for the Bearer
 * form. Two attempts, then it stops; a retry loop against an auth failure is
 * how a key gets rate-limited on top of being wrong.
 */
export async function brainOrg(env, { fetchImpl, now = Date.now, force = false } = {}) {
  const doFetch = fetchImpl ?? ((...a) => fetch(...a));
  const key = env?.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      ok: false,
      configured: false,
      note: 'This Worker has no Anthropic key, so the two brains that produce place cards cannot run at all.',
    };
  }

  if (!force && cache && now() - cache.at < TTL_MS && cache.value.key_tail === keyTail(key)) {
    return { ...cache.value, cached: true };
  }

  const attempt = async (headers) => {
    const res = await doFetch(ORG_URL, { headers: { 'anthropic-version': API_VERSION, ...headers } });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };

  let r;
  try {
    r = await attempt({ 'x-api-key': key });
    if (r.status === 401) r = await attempt({ authorization: `Bearer ${key}` });
  } catch (err) {
    return {
      ok: false,
      configured: true,
      key_tail: keyTail(key),
      note: `Could not reach Anthropic to ask: ${String(err?.message ?? err).slice(0, 120)}`,
    };
  }

  if (r.status !== 200 || !r.body?.id) {
    const value = {
      ok: false,
      configured: true,
      key_tail: keyTail(key),
      status: r.status,
      note: r.status === 401
        ? 'Anthropic rejected the key. It is expired, revoked, or belongs to a workspace that no longer exists.'
        : `Anthropic answered ${r.status} instead of naming the organisation.`,
    };
    return value;
  }

  const value = {
    ok: true,
    configured: true,
    id: String(r.body.id),
    name: String(r.body.name ?? ''),
    type: String(r.body.type ?? 'organization'),
    key_tail: keyTail(key),
    // Said plainly so nobody reads an org name as proof of isolation. The org
    // is the billing account; the workspace is what actually ring-fences
    // spend, and it is chosen when the key is minted, not visible from here.
    note: 'This names the billing organisation. Whether the key is scoped to its own workspace is set when the key is created and cannot be read back from this endpoint.',
  };
  cache = { at: now(), value };
  return value;
}

/**
 * Is the brain on the account we expect?
 *
 * Set BRAIN_ORG_EXPECT to the organisation id once the dedicated account is in
 * place, and this becomes a yes/no that a health check can act on instead of a
 * name a person has to recognise.
 */
export function matchesExpected(org, expected) {
  if (!expected) return { checked: false, note: 'BRAIN_ORG_EXPECT is not set, so there is nothing to compare against.' };
  if (!org?.ok) return { checked: true, match: false, note: 'Could not read the organisation, so it cannot be confirmed.' };
  const match = org.id === String(expected).trim();
  return {
    checked: true,
    match,
    note: match
      ? 'The brain is running on the account it is supposed to be running on.'
      : 'The brain is answering on a DIFFERENT Anthropic account than the one it was moved to. A spend spike elsewhere can take the concierge down.',
  };
}

/** Test seam: forget what we learned. */
export function resetOrgCache() { cache = null; }
