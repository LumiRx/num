/**
 * A stable, opaque id for a device that has not signed up.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * On 15 Aug, 4 of 283 recorded questions carried a member id. Not because
 * attribution was broken — the client sends `me.id` correctly — but because
 * almost nobody asking Num is a member. People land, ask something, and
 * leave, and letting them do that without a signup wall is the right product
 * decision: the answer is the demo.
 *
 * The cost of that decision was that every question arrived from nobody. Not
 * "an unknown person" — literally NULL, indistinguishable from every other
 * NULL. So none of these could be answered:
 *
 *   · did anyone come back a second time?
 *   · how many questions does someone ask before they sign up?
 *   · which first question predicts a signup?
 *   · did that Reddit campaign send us people who actually used it?
 *
 * Those are the only questions that tell you whether the funnel works, and
 * all four need one thing: knowing that two questions came from the same
 * place. Not who. Just *same*.
 *
 * ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────
 *
 * It is 16 bytes of `crypto.getRandomValues`, kept in localStorage. It is not
 * derived from anything about the device, the browser, the network or the
 * person — it cannot be, because it is random. It is not a fingerprint: it
 * dies with the site data, it does not follow anyone to another site, and two
 * people sharing a laptop share it.
 *
 * It carries no name, no phone, no email. When somebody does sign up, the
 * server links this id to their member id ONCE and then stops needing it —
 * the member id is better in every way.
 *
 * Storage can be unavailable — Safari private mode, a locked-down webview,
 * an embedded browser. That is not an error and must never cost a guest an
 * answer, so the failure mode is a per-session id held in memory: the turn
 * still attributes to itself, and only the cross-session part is lost.
 */

const KEY = 'num.anon';
let memo: string | null = null;

const mint = (): string => {
  try {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return `a_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    // Ancient or hardened environment with no crypto. Still unique enough to
    // separate one session from another, which is all it is being asked for.
    return `a_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
};

/** The device's anonymous id. Stable across sessions where storage allows. */
export function anonId(): string {
  if (memo) return memo;
  try {
    const found = localStorage.getItem(KEY);
    if (found && /^a_[a-z0-9]{8,64}$/.test(found)) {
      memo = found;
      return memo;
    }
    const made = mint();
    localStorage.setItem(KEY, made);
    memo = made;
    return memo;
  } catch {
    // No storage: hold it for this session only.
    memo = mint();
    return memo;
  }
}

/**
 * Forget this device.
 *
 * Exists because a promise you cannot keep is worse than one you never made:
 * "clear your site data and it's gone" has to be true, and a user-facing
 * control has to have something to call.
 */
export function forgetAnon(): void {
  memo = null;
  try { localStorage.removeItem(KEY); } catch { /* nothing to forget */ }
}
