// Sharing to X, without the X API.
//
// ── WHY THERE IS NO KEY IN THIS FILE ─────────────────────────────────────
//
// A share button is a Web Intent: a plain link that opens X's own compose box
// with the text already filled in. The person posts it themselves from their own
// account. No API key, no OAuth, no app review, and no per-post cost.
//
// That last point is not a small one. Checked 12 Sep 2026: X's free API tier
// closed to new developers in February, pay-per-use is $0.015 a post — and
// $0.20 for a post CONTAINING A LINK. Every post NUM would make contains a
// link. Routing member sharing through the API would therefore cost $200 per
// thousand shares to do worse than this file does for nothing, because a post
// from NUM's account is an advert and a post from the member's account is a
// recommendation.
//
// ── THE LINK WE SHARE IS NOT THE LINK WE TEXT ────────────────────────────
//
// `connectLink()` carries the member's own id, and opening it CONNECTS the
// opener to them. That is exactly right for a QR held across a table or a link
// texted to a friend. Broadcast publicly it is something else: an open
// invitation for any stranger scrolling past to attach themselves to a named
// person's account.
//
// So a public post uses `referralLink()` — credit without connection. The
// member is still attributed; nobody is auto-connected by a post.
/**
 * The documented intent endpoint.
 *
 * `twitter.com/intent/tweet` is what X's own Web Intent documentation still
 * specifies, and it serves X. It redirects to x.com, which costs one hop and is
 * the price of using the form that is actually documented rather than the one
 * guessed from the current UI. Kept as a single constant so a change is one
 * edit, not a search.
 */
export const X_INTENT = 'https://twitter.com/intent/tweet';

/** X's post limit. */
export const X_LIMIT = 280;

/**
 * What a link costs inside a post, whatever its real length.
 *
 * Every URL is rewritten to t.co and counted as a fixed 23 characters. Budget
 * by the real length instead and a long link makes the text appear to fit when
 * it does not — X then rejects the whole post rather than trimming it, and the
 * member sees a compose box with an error instead of something to send.
 */
export const X_URL_COST = 23;

/** Room for the text once a link and the space before it are paid for. */
export const X_TEXT_BUDGET = X_LIMIT - X_URL_COST - 1;

/**
 * Trim to the budget on a word boundary.
 *
 * Cutting mid-word reads as a bug rather than a limit. An ellipsis is added
 * only when something was actually removed, and it is paid for out of the
 * budget rather than added on top of it.
 */
export function fitText(text: string, budget: number = X_TEXT_BUDGET): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (budget <= 0) return '';
  if (t.length <= budget) return t;
  const room = budget - 1;                       // the ellipsis costs one
  const cut = t.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  // Only fall back to a hard cut when there is no space worth breaking at —
  // a single very long word, where breaking early would delete most of it.
  const body = lastSpace > room * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * Build the compose URL.
 *
 * `url` is passed as its own parameter rather than pasted into the text, so X
 * builds a link preview card. Inside the text it is just characters.
 */
type XPost = { text: string; url?: string | null; via?: string | null };
type XPlace = { name?: string | null; city?: string | null } | null;

export function xShareUrl(o: XPost): string {
  const { text, url, via } = o;
  const q = new URLSearchParams();
  const body = fitText(text, url ? X_TEXT_BUDGET : X_LIMIT);
  if (body) q.set('text', body);
  // Only ever an https link of ours. A post is public and permanent; a
  // malformed or non-https URL reaching it is not something to tidy up later.
  if (url && /^https:\/\//.test(url)) q.set('url', url);
  if (via) q.set('via', String(via).replace(/^@/, ''));
  return `${X_INTENT}?${q.toString()}`;
}

/**
 * The member's own "I use NUM" post.
 *
 * Written in the member's own voice rather than NUM's — the whole value of a
 * share over an advert is that a person is saying it. No name in the text: the
 * poster's account already says who they are, and "It's Dre." reads as a text
 * message that wandered into a public post.
 *
 * `link` is passed in rather than built here so this module stays free of
 * `./links`, which touches `window` at import time. That keeps it a pure
 * function module the tests can load and RUN, instead of asserting against a
 * re-implementation that can drift from it. Pass a REFERRAL link, never a
 * connect link — see the note at the top of this file.
 */
export function shareNumOnX(link: string): string {
  return xShareUrl({
    text: 'NUM is a concierge in one thread — dinner, cars, tables, whole weekends.',
    url: link,
  });
}

/**
 * Share a place NUM recommended.
 *
 * The venue is named and the city is given, because "a great place" shared
 * without either is a post that helps nobody and reflects on nothing.
 */
export function sharePlaceOnX(place: XPlace, link: string): string {
  const name = String(place?.name ?? '').trim();
  if (!name) return '';
  const where = String(place?.city ?? '').trim();
  const text = where
    ? `${name} in ${where} — found by my concierge, NUM.`
    : `${name} — found by my concierge, NUM.`;
  return xShareUrl({ text, url: link });
}
