/**
 * What a guest is allowed to read when something breaks.
 *
 * ── WHY (6 Sep 2026) ──────────────────────────────────────────────────────
 *
 * A customer sent Dre a screenshot of Num answering with code. Two separate
 * leaks put it there, and neither was anybody's mistake — they were the
 * default behaviour of code written for developers:
 *
 *   1. Every `fetch` wrapper in this app does
 *        `throw new Error(body.error || 'errand 500')`
 *      and every screen does `setNote(err.message)`. So whatever the server
 *      put in `error` — a D1 constraint, a vendor's billing message, a stack
 *      frame — is rendered verbatim to a paying guest. And when the server
 *      says nothing at all, the guest reads the literal string "errand 500".
 *   2. While the strong brain was out of credit the chain fell to
 *      unstructured models, which emit fenced code and thinking tokens.
 *      (worker/router.mjs guards that side.)
 *
 * This file closes the first one at the LAST possible moment — the point of
 * display — because that is the only place that catches every path at once,
 * including ones written after today.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * A message is shown to a guest only if it reads like a sentence a concierge
 * would say. Anything else becomes the caller's plain-English fallback. We
 * would rather say something slightly generic than something that makes a
 * customer feel they are looking at a broken machine.
 *
 * Diagnosis is not lost: the original goes to the console, where it belongs.
 */

/** Shapes that must never reach a guest, whatever else is true of them. */
const UNSAFE: RegExp[] = [
  /```/,                                   // a fenced code block
  /<\|[a-z_]+\|>/i,                        // model channel tokens
  /<\/?(?:think|thinking|reasoning)\b/i,   // exposed chain-of-thought
  /^\s*[{[]/,                              // starts as JSON
  /"(?:error|message|request_id|status_code)"\s*:/i,
  /\b(?:invalid_request_error|authentication_error|rate_limit_error|insufficient_quota)\b/i,
  /\bcredit balance is too low\b/i,
  /\bPlans\s*&\s*Billing\b/i,
  /\breq_[A-Za-z0-9]{16,}\b/,              // a vendor request id
  /\bsk-[A-Za-z0-9_-]{12,}\b/,             // an API key
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/,
  /\bat\s+(?:async\s+)?[\w.$]+\s+\(.*:\d+:\d+\)/,   // a stack frame
  /\b(?:undefined is not|null is not|Cannot read propert)/i,
  /(?:\bconsole\.log|\bfunction\s*\(|=>\s*[{(]|\brequire\()/,  // \b cannot precede `=>`
  /\bHTTP\s+\d{3}\b/i,
  /\b(?:SQLITE|D1_ERROR|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b/i,
  /\bFailed to fetch\b/i,                  // the browser's words, not ours
  /\bNetworkError\b/i,
  // The developer shorthand our own fetch wrappers invent when the server
  // sent no message at all: "errand 500", "profile 502", "tab 404".
  /^[a-z][a-z_ -]{0,18}\s+[45]\d{2}$/i,
  /^\s*[45]\d{2}\s*$/,                     // a bare status code
];

/** Does this read like something a person wrote for another person? */
export function isGuestSafe(text: unknown): boolean {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (s.length > 240) return false;         // a paragraph of anything is a dump
  for (const re of UNSAFE) if (re.test(s)) return false;
  // A sentence has letters and spaces. "err_x9::22" does not.
  if (!/[a-z]{3}/i.test(s)) return false;
  if (!/\s/.test(s) && s.length > 24) return false;  // one long unbroken token
  return true;
}

/**
 * The line to show a guest for a failure.
 *
 * @param err       whatever was caught — an Error, a string, anything
 * @param fallback  the caller's own plain sentence for this situation
 * @param where     optional label for the console, so diagnosis survives
 */
export function guestMessage(err: unknown, fallback: string, where?: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (raw) console.warn(`[num] ${where ?? 'error'}:`, raw);
  return isGuestSafe(raw) ? raw : fallback;
}
