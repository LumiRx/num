/**
 * The gate every /api/admin/ route needs, in one place.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * Found 3 Sep 2026: `GET /api/admin/scout-usage` answered 200 to the open
 * internet. Anyone who guessed the path could read every scout's name, their
 * referral code, their commission terms and what they were owed. Not a leak
 * of guest data, but a leak of somebody's deal — and of ours.
 *
 * The route sat between two that DO check the key, and the check is one line,
 * so nothing about the code looked wrong. That is exactly why it is a shared
 * function now and why worker/adminroutes.test.mjs walks the router and fails
 * on any /api/admin/ route whose handler does not call it.
 *
 * Fails CLOSED when ADMIN_KEY is unset: an admin surface with no key
 * configured is open to everyone, which is worse than one that is switched
 * off.
 */

export const DENIED = { error: 'Not authorised.' };

/** True when this request carries the admin key. Never throws. */
export function adminOk(request, env) {
  try {
    const key = env?.ADMIN_KEY;
    if (!key) return false;
    return request.headers.get('X-Admin-Key') === key;
  } catch {
    return false;
  }
}

/**
 * `null` when the caller may proceed, otherwise the 401 to return.
 * Takes the CORS headers the route already uses so a refusal looks like every
 * other response from that endpoint.
 */
export function adminGuard(request, env, headers = {}) {
  if (adminOk(request, env)) return null;
  return new Response(JSON.stringify(DENIED), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
