// Where the guest is — asked, never assumed.
//
// The bug this exists to kill: Num told a user with no stated location that
// they were in Copenhagen, twice, with the confidence of a fact. It came from
// the edge's IP geolocation, which is a reasonable HINT and a terrible CLAIM —
// it is the datacentre's guess, it is wrong on VPNs, roaming and airport wifi,
// and it is exactly wrong for travellers, who are the entire user base.
//
// The rule now:
//   · A real GPS fix is knowledge. Use it.
//   · Anything the guest typed is knowledge. Use it.
//   · An IP guess is NOT knowledge. Never name that city as fact — ask.
//
// The ask is rationed: once per app open while we don't know, or at the moment
// a recommendation is requested and the guest still hasn't said where. Asking
// more than that is nagging; asking less means guessing, and guessing is what
// broke it.
import { store } from './store';

let askedThisSession = false;

/**
 * How long anything is willing to wait for the device to answer.
 *
 * Longer than getCurrentPosition's own 8s timeout so a slow-but-working fix
 * still lands, short enough that a guest who is ignoring a permission dialog
 * gets their answer instead of a frozen app.
 */
const HARD_TIMEOUT_MS = 10_000;

/** Has the browser already granted location, without prompting to find out? */
export async function locationGranted(): Promise<boolean> {
  try {
    const p = await (navigator.permissions as unknown as {
      query: (d: { name: string }) => Promise<{ state: string }>;
    }).query({ name: 'geolocation' });
    return p.state === 'granted';
  } catch {
    return false;
  }
}

/**
 * Ask the device where we are. Resolves to a coordinate or null; never
 * throws, and ALWAYS settles — see the deadline below for why that sentence
 * used to be false. `silent` only proceeds if permission already exists, so a
 * page load can refresh a known position without a prompt.
 */
export async function fixPosition(silent = false): Promise<{ lat: number; lng: number } | null> {
  if (!('geolocation' in navigator)) return null;
  if (silent && !(await locationGranted())) return null;

  return new Promise((resolve) => {
    // ── THE DEADLINE IS NOT OPTIONAL ────────────────────────────────────
    //
    // `getCurrentPosition`'s own `timeout` option does NOT cover the
    // permission prompt. While iOS is showing "Allow Num to use your
    // location?", the clock is not running — so a guest who ignores that
    // dialog, or a WebView where the prompt never appears at all, leaves this
    // promise pending FOREVER. Neither callback is ever invoked.
    //
    // That is not theoretical. `askNum` awaited this before echoing the
    // guest's message, so a typed question containing the word "dinner"
    // vanished out of the composer and never reached the thread, the server,
    // or the log. The starter chips appeared to work only because their
    // wording dodged the trigger.
    //
    // So: whatever the platform does, this settles. A recommendation without
    // a precise fix is a good answer; a question that disappears is not.
    let settled = false;
    const done = (v: { lat: number; lng: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(v);
    };
    const deadline = setTimeout(() => done(null), HARD_TIMEOUT_MS);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const at = { lat: +pos.coords.latitude.toFixed(5), lng: +pos.coords.longitude.toFixed(5) };
        // Held in app state and sent with the next question, so the concierge
        // grounds on a real fix instead of the edge's IP guess.
        //
        // Written even if the deadline already fired: a fix that arrives late
        // is still true, and it makes the NEXT question better. `done` is the
        // idempotent part, not this.
        store.set({ here: at });
        done(at);
      },
      () => done(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    );
  });
}

/**
 * Once per app open, and only while we genuinely don't know: refresh silently
 * if permission exists, otherwise leave it alone. No prompt on launch — a
 * permission dialog before the app has done anything for you is the fastest
 * way to a permanent "Don't allow".
 */
export async function onOpen(): Promise<void> {
  if (askedThisSession) return;
  askedThisSession = true;
  if (store.get().place) return;
  await fixPosition(true);
}

/**
 * The moment a recommendation is asked for and we still don't know where they
 * are. THIS is where a prompt is fair: they've asked for something local, so
 * the reason for the permission is self-evident and the answer is usually yes.
 * Returns true if we now know.
 */
export async function ensurePlaceForRecommendation(): Promise<boolean> {
  const s = store.get();
  if (s.place || s.here) return true;
  const at = await fixPosition(false);
  return !!at;
}

/** Does this message want somewhere-specific advice? */
export function wantsLocalAdvice(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(near|nearby|around here|close by|hungry|eat|dinner|lunch|breakfast|drink|bar|coffee|restaurant|book a table|things to do|tonight|what'?s open|where should i|recommend)\b/.test(t);
}
