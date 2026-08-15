/**
 * Affiliate tagging — money from traffic we already send away.
 *
 * ── THE FINDING ──────────────────────────────────────────────────────────
 *
 * `services.mjs` hands travellers to Delta, United, Emirates, Qatar,
 * Singapore, BA, Lufthansa, Grab, Bolt and about thirty others as **plain
 * URLs**. `booking.mjs` does the same for OpenTable, Resy, Tock and the rest.
 * Every one of those companies runs an affiliate programme. We send the
 * traffic today and are paid nothing for it.
 *
 * This is the cheapest revenue in the product: no new checkout, no new
 * screen, nobody has to buy anything they were not already buying, and the
 * money is a referral fee paid by the platform — it never touches us, so §8
 * is satisfied by construction rather than by process.
 *
 * ── WHY CONFIGURATION AND NOT CODE ───────────────────────────────────────
 *
 * Affiliate IDs arrive one programme at a time, weeks apart, each with its own
 * parameter name, and every one of them is an account credential of sorts.
 * Hard-coding them would mean a deploy per approval and secrets in git. So the
 * whole table lives in ONE secret, `NUM_AFFILIATES`, as JSON:
 *
 *   {
 *     "opentable.com": { "ref": "12345", "param": "ref" },
 *     "expedia.com":   { "ref": "num-01", "param": "affcid" },
 *     "*":             { "ref": "num",    "param": "utm_source" }
 *   }
 *
 * Add a programme by updating a secret. No deploy, no code review, no
 * credential in the repository.
 *
 * ── THE RULES THAT KEEP THIS HONEST ──────────────────────────────────────
 *
 * 1. **Tagging never changes which place is recommended.** This function runs
 *    at the very end, on a URL that has already been chosen on merit. There
 *    is no code path where an affiliate rate can influence ranking, and there
 *    must never be — the moment a recommendation is for sale, the product is
 *    worth nothing and no amount of commission buys the trust back.
 * 2. **Never overwrite an existing parameter.** If a URL already carries a
 *    partner's own tracking, that partner attributed it first and taking it
 *    is both wrong and a good way to lose a programme.
 * 3. **HTTPS only, and only hosts we have configured.** A tag appended to an
 *    arbitrary URL is an open redirect with our name on it.
 */

/**
 * Parse the affiliate table from its secret. Bad JSON disables tagging
 * entirely rather than half-applying it — a malformed table should cost us
 * revenue, never correctness.
 */
export function affiliates(env) {
  const raw = env?.NUM_AFFILIATES;
  if (!raw) return {};
  try {
    const t = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return t && typeof t === 'object' && !Array.isArray(t) ? t : {};
  } catch {
    console.warn('[affiliate] NUM_AFFILIATES is not valid JSON — tagging disabled');
    return {};
  }
}

/** Registrable-ish domain match: a rule for `resy.com` covers `www.resy.com`. */
function ruleFor(table, host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (table[h]) return table[h];
  // Walk up the labels so one rule can cover regional domains.
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    if (table[suffix]) return table[suffix];
  }
  return table['*'] ?? null;
}

/**
 * Tag an outbound URL, if we have a programme for it.
 *
 * @returns the tagged URL, or the ORIGINAL string unchanged when there is no
 * rule, the URL is malformed, or a parameter is already present. Never throws
 * and never returns null: a link a guest cannot follow is worse than a link
 * we are not paid for.
 */
export function tag(url, env, { extra = null } = {}) {
  const original = String(url ?? '');
  const table = affiliates(env);
  if (!original || !Object.keys(table).length) return original;
  let u;
  try {
    u = new URL(original);
  } catch {
    return original;
  }
  // http:// would strip the referrer on most browsers and leak the click in
  // clear text besides. Not worth a referral fee.
  if (u.protocol !== 'https:') return original;

  const rule = ruleFor(table, u.hostname);
  if (!rule?.ref) return original;
  const param = String(rule.param || 'ref');

  // Somebody else's attribution already on the link stays theirs.
  if (u.searchParams.has(param)) return original;
  u.searchParams.set(param, String(rule.ref));
  // Some programmes want a sub-id so a payout can be reconciled to a
  // destination or a campaign. Opt-in per rule; never carries anything about
  // the guest.
  if (rule.subparam && extra) u.searchParams.set(String(rule.subparam), String(extra).slice(0, 40));
  return u.toString();
}

/** Which hosts we currently earn on — for the ops page, not for ranking. */
export const programmes = (env) =>
  Object.entries(affiliates(env))
    .filter(([, v]) => v?.ref)
    .map(([host, v]) => ({ host, param: v.param || 'ref' }));
