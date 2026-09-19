/**
 * Whose fault is it, actually.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Every failure on the ask path — a 500 from our own worker, a 502 from the
 * edge, a stream that ended mid-answer, a rate limit, a genuinely offline
 * phone — produced one sentence:
 *
 *   "I didn't manage to get that — looks like we've dropped the line."
 *
 * "We've dropped the line" reads as *your* line. A guest standing in a
 * foreign city reads that and starts hunting for wifi, switches off the VPN,
 * pays for a data pass, gives up. Meanwhile NUM is down and nobody has said
 * so. The comment above that line even claimed it "fires when the request did
 * not leave the device at all" — which was never true: `fetch` resolves
 * happily on a 500, and the JSON parse is what threw.
 *
 * Telling somebody their connection is broken when ours is, is a lie that
 * costs them money. So this module refuses to guess: it names the one thing
 * we actually know, and when we do not know, it says that instead.
 *
 * ── THE FOUR THINGS WE CAN KNOW ──────────────────────────────────────────
 *
 *   offline      the browser says there is no network. Their side, certainly.
 *   down         our server answered, and what it answered was a failure.
 *                5xx, or a stream that ended without a final line. Ours.
 *   busy         429. Ours too, and temporary, and worth saying plainly
 *                rather than dressing up as an outage.
 *   unreachable  the request never got an answer and the browser thinks it
 *                is online. Could be us, could be a captive portal, could be
 *                a train tunnel. We DON'T KNOW, and the message says so.
 *
 * `navigator.onLine === true` means almost nothing — a hotel wifi that has
 * not been paid for is "online" — which is exactly why `unreachable` exists
 * as a separate answer rather than being folded into either neighbour.
 */

export type Outage = 'offline' | 'down' | 'busy' | 'unreachable';

/** True only when the browser is certain. Absent API (SSR, old webview) is not certain. */
export function browserOffline(nav: { onLine?: boolean } | undefined = globalThis.navigator): boolean {
  return nav ? nav.onLine === false : false;
}

/**
 * Classify a failed ask.
 *
 * `res` is the Response if one arrived — a 500 IS a response, and that is the
 * whole point. `err` is what was thrown, which on this path is either a fetch
 * rejection (nothing arrived) or numreply's own 'backend NNN' / 'stream ended
 * without an answer'.
 */
/**
 * The thrown thing's text, FOR MATCHING ONLY.
 *
 * lib/saferr.ts exists because `err instanceof Error ? err.message : …` used
 * to be how raw errors reached guests — "Failed to fetch", stack frames, an
 * upstream's HTTP status. That guard is right and it stays.
 *
 * What happens to this string is the difference: it is tested against two
 * fixed patterns and then discarded. Nothing derived from it is ever shown.
 * The guest sees one of the four sentences in SAY, which are written here and
 * contain no interpolation at all — asserted in outage.test.mjs, because
 * "trust me, it does not leak" is not a guarantee.
 */
function reasonOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown ?? '');
}

export function classify(res: Response | null | undefined, err?: unknown, nav = globalThis.navigator): Outage {
  if (res) {
    if (res.status === 429) return 'busy';
    if (res.status >= 500) return 'down';
  }
  const m = reasonOf(err);
  // numreply.ts throws these two, and both mean our server answered badly.
  if (/^backend (5\d\d)$/.test(m)) return 'down';
  if (/stream ended without an answer/i.test(m)) return 'down';
  if (/^backend 429$/.test(m)) return 'busy';
  // Nothing came back. Only now does the browser's opinion get a say.
  if (browserOffline(nav)) return 'offline';
  return 'unreachable';
}

/**
 * What to put in the thread.
 *
 * Every one of these ends with what happens next, because "something went
 * wrong" with no next step is just an apology. None of them blames the guest
 * for a fault we cannot prove is theirs, and the two that ARE ours say so in
 * the first clause rather than burying it.
 */
export const SAY: Record<Outage, string> = {
  offline: 'Your phone says it has no connection right now. Nothing is lost — send it again the moment you are back and I will pick it straight up.',
  down: 'That one is on us — NUM is having trouble at our end, not yours. Nothing is wrong with your connection. We are on it; send it again in a minute and it should go through.',
  busy: 'We are getting more questions than we can answer this second. Give it thirty seconds and send it again — nothing is lost.',
  unreachable: 'I could not reach NUM just then. It might be us and it might be the network you are on — I honestly cannot tell from here. Send it again and we will find out.',
};

/** The banner line, when one is worth showing at all. */
export const BANNER: Partial<Record<Outage, string>> = {
  down: 'NUM is having trouble at our end. Not your connection.',
  busy: 'NUM is busy — answers are slower than usual.',
};

/**
 * Ask our own health endpoint whether it agrees.
 *
 * Only called after a failure, never on a good path, and never awaited by the
 * answer: this is for the banner, and a banner is not worth a second of a
 * guest's time. `/api/health` answers 503 when the worker itself knows it is
 * unhealthy (worker/index.mjs), so a clean 200 here turns a `down` into an
 * `unreachable` — our server is up, so whatever failed was between us.
 */
export async function confirmDown(apiUrl: (p: string) => string, fetchImpl = globalThis.fetch): Promise<boolean> {
  try {
    const r = await fetchImpl(apiUrl('/api/health'), { method: 'GET', cache: 'no-store' });
    return !r.ok;
  } catch {
    // Health is unreachable too. That is consistent with being down, but it
    // is not proof, so it does not upgrade anything — the caller already has
    // its answer and this only ever confirms.
    return true;
  }
}
