/**
 * Posting to X from Num's own account.
 *
 * ── WHAT THIS FILE WILL NOT DO ───────────────────────────────────────────
 *
 * It will not post unless THREE separate things are true: a bearer token is
 * configured, `NUM_X_POSTING` is exactly `1`, and a caller asks it to. Nothing
 * in here is wired to a schedule, and wiring one is a separate decision that
 * should be made out loud — an agent that posts publicly on a timer is a
 * different product from a tool that posts when asked.
 *
 * The reason for the belt and braces is not caution for its own sake. A post is
 * public, it is permanent enough to be screenshotted, and it is attributed to
 * Num. A bug in a posting loop is not a log line, it is a thing strangers read.
 *
 * ── THE COST, WHICH IS NOT WHAT ANYONE ASSUMES ───────────────────────────
 *
 * Checked against X's published pricing, 12 Sep 2026:
 *
 *   · The free tier closed to NEW developers in February 2026.
 *   · Pay-per-use is $0.015 a post…
 *   · …and $0.20 for a post CONTAINING A LINK.
 *
 * That thirteenfold difference is the whole economics of this file. Every post
 * Num would naturally make carries a link, so the honest planning number is
 * $0.20, not $0.015 — a thousand posts is $200, not $15. Anybody estimating
 * from the headline rate is out by more than an order of magnitude, which is
 * exactly the kind of error that is noticed on an invoice.
 *
 * So the cost is computed from the post's OWN TEXT rather than assumed, and a
 * cap is checked before the call rather than after.
 *
 * ── WHY MEMBER SHARING DOES NOT COME THROUGH HERE ────────────────────────
 *
 * `src/lib/xshare.ts` opens X's compose box and the member posts it themselves:
 * free, no key, no approval. It is also simply better — a recommendation from a
 * person outperforms an advert from a brand. This file is only for the posts
 * that have to come from Num's own account.
 */

/** Tenth-cents, so $0.015 is an integer and no cost is ever a float. */
export const COST_PLAIN_TC = 15;    // $0.015
export const COST_LINK_TC = 200;    // $0.20
export const TC_PER_DOLLAR = 1000;

/** X's post limit, and what a link costs inside one whatever its length. */
export const LIMIT = 280;
export const URL_COST = 23;

/**
 * Does this post contain a link?
 *
 * Deliberately GENEROUS: anything that could plausibly be read as a URL counts
 * as one. Being wrong in this direction over-estimates the bill by 18.5 cents;
 * being wrong the other way under-estimates it thirteenfold and the cap stops
 * working. A cost guard that errs cheap is not a guard.
 */
export function hasLink(text) {
  const t = String(text ?? '');
  return /https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.(com|net|org|io|co|ai|app|me|gg|xyz|link|th|uk|dev)\b/i.test(t);
}

/** What one post will cost, in tenth-cents, from its own text. */
export const costOf = (text) => (hasLink(text) ? COST_LINK_TC : COST_PLAIN_TC);

/**
 * Tenth-cents as something a human reads, WITHOUT under-stating it.
 *
 * Two decimals turned $0.015 into "$0.01" — JavaScript rounds it down, because
 * 0.015 is not exactly representable. A budget message that reports a cost as
 * lower than it is, is the same class of error as the $0.015-vs-$0.20
 * assumption this whole file exists to stop. So a sub-cent amount keeps its
 * third decimal and a whole-cent amount stays clean.
 */
export const dollars = (tc) => {
  const n = Math.max(0, Math.floor(Number(tc) || 0));
  return `$${(n / TC_PER_DOLLAR).toFixed(n % 10 === 0 ? 2 : 3)}`;
};

/**
 * May we post this, inside this budget?
 *
 * FAILS CLOSED on every branch, and says which one. A refusal with no reason
 * gets worked around rather than understood.
 *
 * @param {object} o
 * @param {string} o.text       the post
 * @param {number} o.spentTc    already spent this period, tenth-cents
 * @param {number} o.capTc      the period cap, tenth-cents. 0 means no posting.
 */
export function canPost({ text, spentTc = 0, capTc = 0 } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, why: 'nothing to post' };

  // Counted the way X counts it: a link is 23 characters regardless of length.
  const counted = hasLink(body)
    ? body.replace(/https?:\/\/\S+/gi, 'x'.repeat(URL_COST)).length
    : body.length;
  if (counted > LIMIT) return { ok: false, why: `${counted} characters — X refuses anything over ${LIMIT}` };

  const cost = costOf(body);
  const cap = Math.max(0, Math.floor(Number(capTc) || 0));
  const spent = Math.max(0, Math.floor(Number(spentTc) || 0));
  // A cap of zero is not "unlimited". An unset budget must mean no spending,
  // or forgetting to set one is the same as approving everything.
  if (cap <= 0) return { ok: false, why: 'no posting budget is set' };
  if (spent + cost > cap) {
    return {
      ok: false,
      why: `this post costs ${dollars(cost)} and only ${dollars(Math.max(0, cap - spent))} is left of ${dollars(cap)}`,
      capped: true,
    };
  }
  return { ok: true, cost_tc: cost, has_link: hasLink(body), counted };
}

/**
 * Post it.
 *
 * Returns a refusal rather than throwing, because the caller is usually a
 * background task and an exception there is a silent failure.
 */
export async function postToX(env, { text, spentTc = 0, capTc = null, idempotencyKey = null } = {},
  fetchImpl = fetch) {
  if (!env?.NUM_X_BEARER) return { ok: false, why: 'no X token configured on this Worker' };
  // The switch is separate from the token on purpose: a token can be added to
  // test that the credentials work without that act also turning on posting.
  if (env.NUM_X_POSTING !== '1') return { ok: false, why: 'posting is off (NUM_X_POSTING is not 1)' };

  const cap = capTc == null ? Number(env.NUM_X_BUDGET_TC ?? 0) : capTc;
  const gate = canPost({ text, spentTc, capTc: cap });
  if (!gate.ok) return gate;

  const res = await fetchImpl('https://api.x.com/2/tweets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.NUM_X_BEARER}`,
      'content-type': 'application/json',
      // A retried POST must not become a second public post.
      ...(idempotencyKey ? { 'x-idempotency-key': String(idempotencyKey).slice(0, 120) } : {}),
    },
    body: JSON.stringify({ text: String(text).trim() }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      why: `X said ${res.status}: ${body?.detail ?? body?.title ?? 'no reason given'}`,
      status: res.status,
      // 429 is worth retrying later; 401/403 is a credential problem that
      // retrying will not fix and will keep costing attempts.
      retryable: res.status === 429 || res.status >= 500,
    };
  }
  return { ok: true, id: body?.data?.id ?? null, cost_tc: gate.cost_tc, has_link: gate.has_link };
}
