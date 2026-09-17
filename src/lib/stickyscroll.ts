// Following a conversation without taking the scroll away from a reader.
//
// ── THE BUG THIS EXISTS TO PREVENT ──────────────────────────────────────
// Dre, 13 Sep 2026: "we had someone looking at flights and the screen got
// stuck scrolling."
//
// It was not stuck. It was being dragged. Both threads in NUM — the concierge
// thread and direct messages — did this:
//
//     useEffect(() => { el.scrollTop = el.scrollHeight; });
//
// No dependency array, so it ran after EVERY render. And both components
// subscribe to the whole store, so every render meant every state change
// anywhere in the app. NUM polls constantly — the booking desk every 15s,
// errands every 15s, the party plan every 8s, suggestions every 90s, DMs,
// autoupdate — so somebody reading a list of flight fares was thrown back to
// the bottom every few seconds by a timer that had nothing to do with them.
//
// Flight results are the worst case and that is why they surfaced it: a tall
// block of several offers is exactly the thing you scroll back through to
// compare.
//
// ── THE RULE ────────────────────────────────────────────────────────────
// Follow the live end only while the reader is ALREADY at it. The moment they
// scroll up they have said "I am reading this", and nothing may move them
// until they ask.
//
// ── WHY A SHARED HOOK AND NOT TWO FIXES ─────────────────────────────────
// The DM version carried the comment "Same rule as the NUM thread" — the two
// were written to match and had already drifted into the same bug twice. One
// implementation is the only way that stays true.
import { useEffect, useRef, useState } from 'react';

/**
 * How close to the bottom still counts as following along.
 *
 * Not zero: a thread that only re-pins at an exact scrollTop unpins itself on
 * a rounding error, a rubber-band, or a one-pixel shift when an image loads.
 * 64px is about a line and a half — plainly still at the live end.
 */
export const PINNED_PX = 64;

/** True when this element is scrolled to (or within `PINNED_PX` of) its end. */
export const atBottom = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_PX;

export interface StickyBottom<T extends HTMLElement> {
  /**
   * Put this on the scrolling element.
   *
   * Typed as React's own MutableRefObject so it can be handed straight to a
   * `ref=` prop — `RefObject<T | null>` is what useRef infers and it is NOT
   * assignable to `LegacyRef<T>`, which is a compile error at every call site.
   */
  ref: React.MutableRefObject<T | null>;
  /** Put this on the same element's onScroll. */
  onScroll: () => void;
  /** True when the reader is scrolled up AND something new arrived below. */
  behind: boolean;
  /** Take them back to the live end, and start following again. */
  toLatest: () => void;
}

/**
 * Keep a scroll container pinned to its end — but only for a reader who is
 * already there.
 *
 * The effect runs on every render deliberately (no dependency array): a
 * thread's height changes for reasons no dependency list can name — a flight
 * card resolving, an image loading, a card growing when its fare is
 * rechecked. Measuring is cheap. **The guard, not the schedule, is what makes
 * this safe**, and the guard is two conditions:
 *
 *   the content GREW   a redraw from a poll that changed nothing visible must
 *                      not move the page at all, even for somebody at the end
 *   they were PINNED   scrolled up means reading; leave them alone
 */
export function useStickyBottom<T extends HTMLElement>(): StickyBottom<T> {
  const ref = useRef<T | null>(null);
  // Refs, not state: onScroll fires on every frame of a gesture, and setting
  // state there would re-render mid-scroll — which is its own kind of stutter
  // and the other thing people call "stuck".
  const pinned = useRef(true);
  const lastHeight = useRef(0);
  const [behind, setBehind] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const grew = el.scrollHeight > lastHeight.current;
    lastHeight.current = el.scrollHeight;
    if (!grew) return;
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
      // Whatever arrived was seen — they were looking straight at it.
      if (behind) setBehind(false);
    } else {
      setBehind(true);
    }
  });

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const end = atBottom(el);
    pinned.current = end;
    if (end && behind) setBehind(false);
  };

  const toLatest = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setBehind(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return { ref, onScroll, behind, toLatest };
}
