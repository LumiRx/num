// The first thing a stranger reads, and the ad that sent them.
//
// ── WHAT THIS EXISTS TO FIX ──────────────────────────────────────────────
//
// On 18 Sep 2026 the X campaign `flight-one` had spent $529.05 for 842 link
// clicks, 98 recorded arrivals, ZERO messages and ZERO accounts. The ad was
// about watching a flight. The app opened with a paragraph about knowing the
// good tables and remembering you don't eat shellfish, and ended:
//
//     "Let's start with your name."
//
// Two failures in one screen. The promise in the ad appeared nowhere, and the
// first thing asked of a stranger was their identity — before NUM had been
// useful even once. Ninety-eight people read that and left.
//
// ── THE RULE ─────────────────────────────────────────────────────────────
//
// The cold open asks for a TASK, never for an identity. Name, number and
// account come later, at the point where they buy the guest something (a
// booking needs a way to reach them). A stranger who has been given nothing
// owes us nothing, least of all their phone number.
//
// `noIdentityQuestion` in coldopen.test.mjs holds that line, because the
// temptation to move the ask earlier never really goes away.
import { T } from './i18nmark';

export interface ColdOpen {
  /** The concierge's opening message. */
  text: string;
  /** Starter chip to place first, so the screen answers the ad it came from. */
  lead: 'flight' | 'stay' | 'table' | null;
}

/**
 * Which promise brought them. Matched loosely on purpose: campaigns get named
 * by whoever set them up, so `flight-one`, `flights_us` and `FlightWatch-Sep`
 * must all land on the same opening rather than silently falling back to the
 * generic one — a miss here is invisible, and its cost is the whole screen.
 */
export function promiseOf(hint: string | null | undefined): ColdOpen['lead'] {
  const h = String(hint ?? '').toLowerCase();
  if (!h) return null;
  if (/flight|fly|air|depart|landing/.test(h)) return 'flight';
  if (/stay|hotel|room|sleep|accom/.test(h)) return 'stay';
  if (/table|dinner|eat|restaurant|food|book/.test(h)) return 'table';
  return null;
}

/**
 * The opening message. Every variant ends in a question the guest can answer
 * from what is already in their head — a flight number, a city, a mood — and
 * none of them asks who the guest is.
 */
export function coldOpen(hint: string | null | undefined): ColdOpen {
  const lead = promiseOf(hint);
  if (lead === 'flight') {
    return {
      lead,
      text: T('Hi, I’m NUM. Give me your flight and I’ll watch it — delays, gate changes, and a car that turns up when you actually land.\n\nWhich flight are you on?'),
    };
  }
  if (lead === 'stay') {
    return {
      lead,
      text: T('Hi, I’m NUM. Tell me where you’re going and I’ll find three real places to stay, with the trade-offs said plainly and the one I’d pick.\n\nWhich city, and which nights?'),
    };
  }
  if (lead === 'table') {
    return {
      lead,
      text: T('Hi, I’m NUM. Say the mood, the time and how many, and I’ll find the room and hold it.\n\nWhere are you, and what do you feel like?'),
    };
  }
  return {
    lead: null,
    text: T('Hi, I’m NUM. Tell me what you want, in any language — dinner tonight, a driver at six, a whole weekend for eight. I’ll find three real places and book the one you pick.\n\nWhere are you, and what do you feel like?'),
  };
}

/**
 * The campaign hint from this launch, or from the first one.
 *
 * Read from the URL before `bootSocial` scrubs the query string, and falling
 * back to the `num-utm` blob it persisted on an earlier visit — someone who
 * clicked a flight ad on Tuesday and came back on Thursday clicked a flight
 * ad, and the screen should still know it. Every access is guarded: private
 * mode throws on localStorage, and a greeting is never worth a broken boot.
 */
export function readHint(): string | null {
  let hint = '';
  try {
    const q = new URLSearchParams(window.location.search);
    hint = [q.get('utm_campaign'), q.get('utm_source'), q.get('utm_content')].filter(Boolean).join(' ');
  } catch { /* no URL to read */ }
  if (hint) return hint;
  try {
    const raw = localStorage.getItem('num-utm');
    if (!raw) return null;
    const u = JSON.parse(raw) as { campaign?: string; source?: string };
    return [u?.campaign, u?.source].filter(Boolean).join(' ') || null;
  } catch { return null; }
}
