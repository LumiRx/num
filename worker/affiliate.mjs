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
 * ── TWO MECHANISMS, AND WHY THE SECOND ONE HAD TO EXIST ──────────────────
 *
 * Everything above assumes a programme is a PARAMETER you add to the
 * merchant's own URL. That is how OpenTable and the smaller engines work, and
 * for two years it was the only shape this file knew.
 *
 * The hotel chains do not work that way. Marriott and Hilton run on
 * impact.com; IHG runs on Partnerize. Both are CLICK-REDIRECT networks: the
 * cookie that earns the commission is set by the network's own domain, which
 * the guest must actually pass through. A ref parameter appended to
 * `hilton.com/...` sets nothing, is ignored by Hilton, and pays nothing —
 * while looking, in our own click log, exactly like a tagged link that works.
 *
 * That is the worst possible failure: an affiliate table that reports revenue
 * we are not earning. So a rule may instead carry a `wrap` template:
 *
 *   {dest} — the destination URL, percent-encoded
 *   {sub}  — a short attribution string (see `extra` below)
 *
 *   "hilton.com": {
 *     "wrap": "https://hilton.sjv.io/c/MPID/ADID/CAMPID?subId1={sub}&u={dest}"
 *   },
 *   "ihg.com": {
 *     "wrap": "https://prf.hn/click/camref:CAMREF/pubref:{sub}/destination:{dest}"
 *   }
 *
 * One placeholder mechanism covers both networks — Impact puts its sub-id in
 * the query and Partnerize puts it in the path, and neither needs a line of
 * network-specific code here. If a third network appears, it is a string in a
 * secret, not a deploy.
 *
 * ── WHAT {sub} IS FOR, AND WHY IT MATTERS MORE THAN THE FEE ──────────────
 *
 * `subId1` (Impact, 64 chars) and `pubref` (Partnerize, 100 chars) come back
 * on the network's own payout report. So putting a scout's code there means
 * the question "was this booking one of Adam's?" is answered by HILTON'S
 * statement, not only by our database. Two independent records that have to
 * agree is what makes a commission owed to a real person checkable rather
 * than assertable.
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

import { appendParams } from './urlparam.mjs';

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

/**
 * Registrable-ish domain match: a rule for `resy.com` covers `www.resy.com`.
 * Returns the KEY as well as the rule, because the key is the programme name
 * we write into the click log — `booking.com` and `*` earn very different
 * money and a log that cannot tell them apart is not worth keeping.
 */
function ruleFor(table, host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (table[h]) return { key: h, rule: table[h] };
  // Walk up the labels so one rule can cover regional domains.
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    if (table[suffix]) return { key: suffix, rule: table[suffix] };
  }
  return table['*'] ? { key: '*', rule: table['*'] } : { key: null, rule: null };
}

/**
 * Build a click-redirect URL from a template.
 *
 * @param template  carries `{dest}` and optionally `{sub}`.
 * @param dest      the destination, already validated as https by the caller.
 * @param sub       attribution string, or null.
 *
 * Returns null — never a half-built URL — when anything is wrong, so the
 * caller falls back to the untagged link. A guest who cannot reach the hotel
 * is a worse outcome than a commission we did not earn, every time.
 *
 * ── THE ENCODING IS THE WHOLE JOB ────────────────────────────────────────
 *
 * `{dest}` is a URL going INSIDE another URL. Its `?`, `&`, `=` and `:` must
 * be percent-encoded or the network reads the destination's own query string
 * as its own parameters and sends the guest to the chain's home page — an
 * error that looks like a working link right up until nobody can find their
 * hotel. `encodeURIComponent` is correct here and `appendParams` is not,
 * because this value is a path or parameter of somebody else's URL rather
 * than a parameter appended to our own.
 *
 * Partnerize is the reason `{dest}` is also allowed in a PATH segment
 * (`/destination:https%3A%2F%2F…`). Same encoding either way.
 */
export function wrap(template, dest, sub = null) {
  const t = String(template ?? '');
  const d = String(dest ?? '');
  if (!t || !d) return null;
  // A template that does not say where the destination goes would silently
  // send every guest to the network's own landing page.
  if (!t.includes('{dest}')) return null;
  // The template is a credential-bearing string typed by hand into a secret.
  // If it is not itself an https URL, something is wrong with the secret and
  // guessing is not the right response.
  if (!/^https:\/\//i.test(t)) return null;

  // Sub-ids are reporting keys, not free text: both networks expect something
  // short and alphanumeric, and a stray `/` would end a Partnerize path
  // segment early. 64 is Impact's subId1 limit, the smaller of the two.
  const s = sub == null ? '' : String(sub).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

  const out = t
    .replace(/\{sub\}/g, encodeURIComponent(s))
    .replace(/\{dest\}/g, encodeURIComponent(d));

  // Prove it survived templating. A malformed result is a link a guest cannot
  // follow, which is the one thing this file must never produce.
  try {
    const u = new URL(out);
    if (u.protocol !== 'https:') return null;
    // Never wrap a link that is already on this network. A double redirect
    // through the same tracker overwrites the first click's attribution with
    // the second — which, when a partner sent us the wrapped link in the
    // first place, is taking a commission that was already theirs.
    if (new URL(d).hostname.toLowerCase() === u.hostname.toLowerCase()) return null;
  } catch {
    return null;
  }
  return out;
}

/**
 * Tag an outbound URL and say what happened to it.
 *
 * `tag()` below is this function's `.url`, and is what every caller that only
 * wants a link should use. This one exists because the click log needs the
 * three facts `tag()` throws away: which host we handed traffic to, which
 * programme (if any) matched, and whether a ref actually landed on the link.
 *
 * Without `host`, a log of untagged clicks cannot tell us which programme to
 * apply for next — which is the single most useful thing it can tell us while
 * NUM_AFFILIATES is still mostly empty.
 *
 * @returns {{url: string, host: string|null, programme: string|null,
 *            tagged: boolean, reason: string}}
 * `reason` is 'tagged' when a ref parameter landed, 'wrapped' when the link
 * was rewritten through a click-redirect network, and otherwise says why
 * neither happened. The two earn money by different mechanisms and a report
 * that cannot tell them apart cannot be reconciled against a payout.
 * `url` is the tagged URL, or the ORIGINAL string unchanged when there is no
 * rule, the URL is malformed, or a parameter is already present. Never throws
 * and never returns null: a link a guest cannot follow is worse than a link
 * we are not paid for.
 */
export function tagged(url, env, { extra = null } = {}) {
  const original = String(url ?? '');
  const no = (reason, host = null, programme = null) =>
    ({ url: original, host, programme, tagged: false, reason });

  if (!original) return no('empty');
  let u;
  try {
    u = new URL(original);
  } catch {
    return no('malformed');
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  const table = affiliates(env);
  if (!Object.keys(table).length) return no('no_table', host);
  // http:// would strip the referrer on most browsers and leak the click in
  // clear text besides. Not worth a referral fee.
  if (u.protocol !== 'https:') return no('not_https', host);

  const { key, rule } = ruleFor(table, u.hostname);
  if (!rule) return no('no_programme', host);

  // ── the click-redirect networks ────────────────────────────────────────
  //
  // Checked BEFORE the parameter path, because a rule that has both is a
  // configuration mistake and the wrap is the one that actually earns.
  //
  // The KEY is what signals intent, not its value. A rule whose `wrap` is an
  // empty string or a typo is a broken programme, and saying so beats
  // reporting 'no_programme' — which sends whoever is debugging it hunting
  // for a missing rule that is in fact present and wrong.
  if (Object.prototype.hasOwnProperty.call(rule, 'wrap')) {
    const wrapped = wrap(rule.wrap, original, extra);
    return wrapped
      ? { url: wrapped, host, programme: key, tagged: true, reason: 'wrapped' }
      : no('bad_wrap', host, key);
  }

  if (!rule.ref) return no('no_programme', host);
  const param = String(rule.param || 'ref');

  // Somebody else's attribution already on the link stays theirs.
  if (u.searchParams.has(param)) return no('already_attributed', host, key);

  // Appended, not re-serialised — see worker/urlparam.mjs for why that
  // distinction cost a real bug. Everything the provider wrote stays
  // byte-for-byte.
  const pairs = [[param, String(rule.ref)]];
  // Some programmes want a sub-id so a payout can be reconciled to a
  // destination or a campaign. Opt-in per rule; never carries anything about
  // the guest.
  if (rule.subparam && extra) pairs.push([String(rule.subparam), String(extra).slice(0, 40)]);
  return { url: appendParams(original, pairs), host, programme: key, tagged: true, reason: 'tagged' };
}

/**
 * Tag an outbound URL, if we have a programme for it.
 *
 * @returns the tagged URL, or the ORIGINAL string unchanged when there is no
 * rule, the URL is malformed, or a parameter is already present. Never throws
 * and never returns null: a link a guest cannot follow is worse than a link
 * we are not paid for.
 */
export const tag = (url, env, opts = {}) => tagged(url, env, opts).url;

/** Which hosts we currently earn on — for the ops page, not for ranking. */
export const programmes = (env) =>
  Object.entries(affiliates(env))
    // A wrap rule is a live programme with no `ref` field at all. Filtering on
    // `ref` alone made every chain invisible on the ops page — reporting that
    // NUM earns on nothing while it was earning.
    .filter(([, v]) => v?.ref || v?.wrap)
    .map(([host, v]) => (v.wrap
      ? { host, mode: 'wrap', sub: /\{sub\}/.test(String(v.wrap)) }
      : { host, mode: 'param', param: v.param || 'ref' }));
