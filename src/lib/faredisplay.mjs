/**
 * Reading a fare without being misled by it.
 *
 * ── WHY THIS IS .mjs AND NOT .ts ─────────────────────────────────────────
 *
 * Same reason as worker/qr.mjs: this arithmetic decides what a traveller
 * believes about their flight, and it should be executed by its tests rather
 * than pattern-matched as text. Plain JavaScript with a .d.mts beside it can
 * be imported by `node --test` directly and by the TypeScript app unchanged —
 * one implementation, actually run.
 *
 * ── THE BUG THAT PUT THIS FILE HERE ──────────────────────────────────────
 *
 * 13 Sep 2026. The fare card printed each segment's DEPARTURE time and
 * nothing else. A live Sabre result for LAX→JFK on 4 Oct was B6 3677,
 * departing 17:59 and landing 05:40 — the next morning. The card said
 * "B63677 17:59". A traveller comparing it against a one-stop that gets in
 * the same evening could not see the only difference that mattered, and
 * would find out on landing.
 */

/**
 * How many calendar days pass between wheels-up and wheels-down.
 *
 * Sabre returns LOCAL airport time with no zone ("2026-10-04T17:59"), so the
 * only honest comparison is the date portion — and that is also the right
 * answer, because what a traveller needs is which day they arrive in the
 * place they are arriving.
 *
 * Never negative. A westbound flight can land at a local clock time earlier
 * than it left, and "−1 day" on a card is nonsense; silence is the honest
 * output when the arithmetic has nothing useful to say.
 */
export function dayShift(departs, arrives) {
  if (!departs || !arrives) return 0;
  const a = Date.parse(`${String(departs).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(arrives).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** '17:59 → 05:40 +1' — the whole journey on one line, arrival included. */
export function legWindow(leg) {
  const segs = leg?.segments ?? [];
  if (!segs.length) return '';
  const off = segs[0]?.departs;
  const on = segs[segs.length - 1]?.arrives;
  if (!off || !on) return '';
  const shift = dayShift(off, on);
  return `${String(off).slice(11, 16)} → ${String(on).slice(11, 16)}${shift > 0 ? ` +${shift}` : ''}`;
}

/**
 * How long this price is still a price.
 *
 * An offer carries `validUntil` and past it the number on screen is a
 * memory. Saying the remaining time turns a greyed-out card from something
 * that looks broken into a fact the traveller can act on.
 */
export function heldFor(validUntil, now = Date.now()) {
  if (!validUntil) return '';
  const left = Date.parse(validUntil) - now;
  if (Number.isNaN(left)) return '';
  if (left <= 0) return 'expired';
  const mins = Math.floor(left / 60_000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** '2h 45m' — minutes are how the API talks and not how anybody thinks. */
export function duration(mins) {
  if (!mins || mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

/** 'non-stop' | '1 stop' | '2 stops' — said the way a person says it. */
export const stopsLabel = (stops) => (!stops ? 'non-stop' : `${stops} stop${stops === 1 ? '' : 's'}`);
