/**
 * Append query parameters to a URL without rewriting the rest of it.
 *
 * ── WHY THIS IS NOT `searchParams.set()` ─────────────────────────────────
 *
 * `new URL(u).searchParams.set(k, v)` followed by `.toString()` does not
 * append a parameter — it re-serialises the ENTIRE query string through the
 * URLSearchParams encoder:
 *
 *   in   https://m.uber.com/ul/?…&dropoff[formatted_address]=Kata%20Beach
 *   out  https://m.uber.com/ul/?…&dropoff%5Bformatted_address%5D=Kata+Beach
 *
 * Both are legal encodings and a general-purpose server decodes them the same
 * way. Num's outbound links are not aimed at general-purpose servers: they are
 * deep links into native apps (Uber's /ul/ universal link, Grab, Bolt) and
 * into partner checkout flows, whose parsers are hand-rolled. A link that
 * opens the app to the wrong place is worse than a link we are not paid for.
 *
 * This was caught by scripts/affiliate-dryrun.mjs the first time it was
 * pointed at an affiliate table — before any real ID existed, which is exactly
 * what a dry-run is for. It would otherwise have shipped silently and broken
 * every provider link at once on the day the first programme was configured.
 *
 * So both callers that add a parameter to somebody else's URL — affiliate
 * tagging and the partner handoff reference — go through here, and there is
 * one implementation to be right rather than two to drift.
 */

/**
 * @param url    the original URL, as a string. Returned unchanged if empty.
 * @param pairs  `[[name, value], …]`. Names and values are percent-encoded;
 *               a value containing `&` or `=` cannot invent a second
 *               parameter, which matters because affiliate IDs are typed by
 *               hand into a secret.
 * @returns the URL with the pairs appended before any fragment.
 *
 * Never throws and never parses the URL — everything the caller wrote is
 * preserved byte for byte.
 */
export function appendParams(url, pairs = []) {
  const original = String(url ?? '');
  if (!original || !pairs.length) return original;

  const query = pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  // A fragment is not part of the query and must stay at the end. `#` cannot
  // appear unescaped inside a URL's query, so the first one is the fragment.
  const hash = original.indexOf('#');
  const head = hash === -1 ? original : original.slice(0, hash);
  const tail = hash === -1 ? '' : original.slice(hash);
  // A URL ending in `?` or `&` already has its separator; adding another
  // produces an empty parameter that some parsers reject.
  const sep = head.includes('?') ? (head.endsWith('?') || head.endsWith('&') ? '' : '&') : '?';
  return `${head}${sep}${query}${tail}`;
}
