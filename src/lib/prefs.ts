// How this user likes to be talked to — learned from what they do, not from a
// settings screen nobody opens.
//
// Two signals feed it:
//
//   1. Emoji reactions on Num's suggestions. A reaction is a rating with no
//      typing, so people actually give it, and it tells us both *how they feel
//      about the suggestion* (drop it, or find more like it) and *how they feel
//      about the answer* (too long, too many options).
//   2. Their own behaviour: how long their messages are, whether they take the
//      first pick or ask for alternatives.
//
// The result is a compact `style` object sent up with each turn, which the
// server turns into a short instruction block (worker/specialists.mjs).
// Deliberately small — it rides in every request, and a style guide longer
// than the reply is a tax on every message.
import { store } from './store';
import type { AppState, Reaction, StyleProfile } from './types';

/** The five reactions, in the order they're shown. */
export const REACTIONS: Array<{ id: Reaction; emoji: string; label: string; weight: number }> = [
  { id: 'love', emoji: '😍', label: 'Perfect — more like this', weight: 2 },
  { id: 'like', emoji: '👍', label: 'Good', weight: 1 },
  { id: 'meh', emoji: '😐', label: 'Not quite', weight: 0 },
  { id: 'no', emoji: '👎', label: 'No — don’t suggest this again', weight: -2 },
  { id: 'long', emoji: '🥱', label: 'Too much text', weight: 0 },
];

const MAX_REMEMBERED = 12;

/**
 * Record a reaction against a message and fold it into the style profile.
 * `subject` is what was actually being rated — the card title where there is
 * one, otherwise the opening clause of the reply.
 */
export function react(index: number, reaction: Reaction, subject: string): void {
  store.set((s) => {
    const reactions = { ...s.reactions, [index]: reaction };
    const style: StyleProfile = { ...s.style };
    const trimmed = subject.slice(0, 70).trim();

    if (reaction === 'love' || reaction === 'like') {
      style.loved = dedupe([...(style.loved ?? []), trimmed]).slice(-MAX_REMEMBERED);
      // A thing they liked is no longer a thing they rejected.
      style.rejected = (style.rejected ?? []).filter((r) => r !== trimmed);
    } else if (reaction === 'no') {
      style.rejected = dedupe([...(style.rejected ?? []), trimmed]).slice(-MAX_REMEMBERED);
      style.loved = (style.loved ?? []).filter((l) => l !== trimmed);
    } else if (reaction === 'long') {
      // The clearest signal we get. One 🥱 is enough to shorten everything.
      style.length = 'short';
      style.pace = 'fast';
    }

    // Consistent enthusiasm for single picks means stop offering menus.
    const positives = Object.values(reactions).filter((r) => r === 'love' || r === 'like').length;
    const negatives = Object.values(reactions).filter((r) => r === 'no' || r === 'meh').length;
    if (positives >= 3 && positives > negatives * 2) style.decisiveness = 'one';
    else if (negatives >= 3) style.decisiveness = 'options';

    return { reactions, style };
  });
}

const dedupe = (a: string[]) => [...new Set(a.filter(Boolean))];

/**
 * Passive signals, folded in after each message the user sends. Cheap and
 * quiet: no reaction needed, and it corrects itself as their habits change.
 */
export function observeUserMessage(text: string): void {
  store.set((s) => {
    const style: StyleProfile = { ...s.style };
    const lens = [...(style.lengths ?? []), text.length].slice(-8);
    style.lengths = lens;
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    // Terse users want terse answers; people who write paragraphs read them.
    if (lens.length >= 4) style.length = avg < 40 ? 'short' : avg > 140 ? 'long' : style.length;
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) style.emoji = 'yes';
    else if ((style.lengths?.length ?? 0) >= 6 && style.emoji !== 'yes') style.emoji = 'no';
    if (/^(?:yes|yep|do it|book it|go|sure|ok)\b/i.test(text.trim())) style.decisiveness = 'one';
    if (/\b(?:other options?|alternatives?|what else|something else)\b/i.test(text)) style.decisiveness = 'options';
    return { style };
  });
}

/** The slice sent to the server — never the raw message lengths. */
export function styleForRequest(s: AppState): StyleProfile | undefined {
  const { lengths, ...rest } = s.style ?? {};
  void lengths;
  return Object.keys(rest).length ? rest : undefined;
}

/**
 * The trip check, computed here rather than by the model: gaps, collisions and
 * expiring holds are arithmetic on the user's own plan, and arithmetic is
 * exactly what a language model should not be trusted to do unaided. The model
 * gets the findings and does what it is good at — deciding what matters and
 * saying it well.
 */
export function tripCheck(s: AppState): string[] {
  const live = s.bookings.filter((b) => b.status !== 'cancelled').sort((a, b) => a.mo - b.mo || a.day - b.day || a.time.localeCompare(b.time));
  const out: string[] = [];
  if (!live.length) return ['Nothing is booked yet — the plan is empty.'];

  const mins = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const dayKey = (b: { mo: number; day: number }) => `${b.mo}-${b.day}`;
  const label = (b: { title: string; time: string }) => `${b.title} at ${b.time}`;

  for (let i = 1; i < live.length; i++) {
    const prev = live[i - 1];
    const cur = live[i];
    if (dayKey(prev) !== dayKey(cur)) continue;
    const gap = mins(cur.time) - (mins(prev.time) + (prev.dur || 60));
    if (gap < 0) out.push(`CLASH: ${label(prev)} overlaps ${label(cur)} on ${prev.mo}/${prev.day}.`);
    else if (gap < 30) out.push(`TIGHT: only ${gap} min between ${label(prev)} and ${label(cur)} on ${prev.mo}/${prev.day}.`);
    if (prev.place && cur.place && prev.place !== cur.place && gap < 60) {
      out.push(`TRANSFER: ${prev.place} → ${cur.place} with ${Math.max(gap, 0)} min — check it is walkable.`);
    }
  }

  const holds = live.filter((b) => b.status === 'hold');
  holds.forEach((h) => out.push(`HOLD EXPIRES: ${h.title}${h.holdBy ? ` — confirm by ${h.holdBy}` : ' — no deadline recorded'}.`));

  const days = new Set(live.map(dayKey));
  const first = live[0];
  const last = live[live.length - 1];
  const span = (last.mo - first.mo) * 31 + (last.day - first.day);
  if (span > 1 && days.size < span) out.push(`EMPTY DAYS: ${span + 1 - days.size} day(s) between ${first.mo}/${first.day} and ${last.mo}/${last.day} have nothing on them.`);

  const cities = new Set(live.map((b) => b.grp));
  if (cities.size > 1) out.push(`MULTI-CITY: ${cities.size} cities on this trip — check every hop between them has transport booked.`);
  if (s.planId) out.push('This trip has a shared group plan — anything that changes reaches the others automatically.');

  return out.length ? out : ['No clashes, no expiring holds, no empty days — the trip is clean.'];
}
