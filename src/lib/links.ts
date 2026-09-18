// Every link NUM hands to another person, built in one place.
//
// The rule, learned the hard way twice in one day:
//
//   A link you SHOW yourself may use the current origin.
//   A link you GIVE somebody else must be the canonical branded host.
//
// window.location.origin is right for neither case reliably. Open the app from
// a preview deploy, a workers.dev URL, or localhost, and every invite you send
// carries that host — which is how a share link reads
// "num-app.thatislumi.workers.dev", looks like nothing to do with NUM, and in
// one earlier version pointed at a domain we do not own and got flagged as
// phishing.
//
// So the canonical host is a constant. It is overridden only in local
// development, where a canonical link would be unclickable.

/** Where the app really lives. Everything shareable is built from this. */
export const APP_ORIGIN = 'https://app.itsnum.com';

/**
 * Localhost is the one place a canonical link is useless — nothing to test.
 *
 * BUT THE INSTALLED APP IS ALSO "LOCALHOST" (18 Sep 2026). A bundled
 * Capacitor build serves itself from capacitor://localhost on iOS and
 * http://localhost on Android, so this test read the phone as a developer's
 * laptop and every QR, connect and referral link in the app said
 * `capacitor://localhost/c/…` — a link nobody can open, and the one Dre
 * tried to send. A dev server always runs on a PORT (5173, 8787…); the
 * app's own origin never has one, and its scheme is not http(s) on iOS.
 * Both have to look like a laptop before a link is allowed to.
 */
const isLocal = /^(localhost|127\.|\[::1\])/.test(window.location.hostname)
  && /^https?:$/.test(window.location.protocol)
  && window.location.port !== '';
const origin = isLocal ? window.location.origin : APP_ORIGIN;

/**
 * A referral, as short as this domain allows.
 *
 * `/r/CODE` rather than `/?ref=CODE` because a shared link gets read aloud,
 * typed from a screenshot and printed on things. The Worker resolves the short
 * path, so this is one hop and no third party.
 */
export const referralLink = (code: string): string => `${origin}/r/${encodeURIComponent(code)}`;

/** An invite token — the recipient joins a plan and connects in one tap. */
export const inviteLink = (token: string): string => `${origin}/i/${encodeURIComponent(token)}`;

/** A "connect with me" code, for a QR somebody scans across a table. */
export const connectLink = (memberId: string, ref?: string | null): string =>
  `${origin}/c/${encodeURIComponent(memberId)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;

/**
 * A request to be paid in Stars.
 *
 * Amount and note stay as query parameters: they vary per request, and a path
 * segment holding a number is a path nobody can read back.
 */
export function payLink(memberId: string, amount?: number, note?: string): string {
  const q = new URLSearchParams({ p: memberId });
  if (amount && amount > 0) q.set('a', String(Math.floor(amount)));
  if (note) q.set('n', note);
  return `${origin}/?${q.toString()}`;
}

/** What we show a human, with the scheme and trailing noise stripped. */
export const pretty = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '');
