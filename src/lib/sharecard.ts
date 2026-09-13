/**
 * Sharing a thing you are looking at — into a friend's chat, or into a plan.
 *
 * ── WHY THIS IS ONE FILE AND NOT TWO BUTTONS ─────────────────────────────
 *
 * Two different things a person wants to do with something Num just showed
 * them, and until now neither was possible:
 *
 *   "look at this fare"      → a message to a friend
 *   "put that on the list"   → an idea on the group plan
 *
 * They feel like separate features and they are the same gesture: take the
 * thing on screen, choose a destination, send it. Writing them separately
 * produces two share sheets that drift apart, two ways of wording the same
 * fare, and a third one the day somebody shares a restaurant. So the payload
 * is a small shape any card can produce, and the destinations are a list.
 *
 * ── WHAT ACTUALLY TRAVELS ────────────────────────────────────────────────
 *
 * TEXT, not a live object. A fare that is shared is a fare as it stood at
 * that moment — the price can move ten minutes later, and a card that
 * silently updates in someone else's chat would be lying about what was
 * sent. `summary` is written to still make sense read cold tomorrow, which
 * is why it carries the date and the route and not just "this one".
 *
 * The plan item is created as an IDEA, never a booking. Adding a fare to a
 * plan is a suggestion to the group; only a person confirming it makes it
 * real, and `confirmPlanItem` is the only thing that says otherwise.
 */
import { store } from './store';
import { sendDm } from './dm';
import { addPlanItem, refreshPlans } from './social';
import { messageFor, planItemFor } from './sharepayload.mjs';

export interface SharePayload {
  /** What kind of thing this is — decides the wording, not the mechanism. */
  kind: 'flight' | 'idea';
  /** Short enough to be a plan-item title on one line. */
  title: string;
  /** The full line that goes into a message. Must read cold, days later. */
  summary: string;
  place?: string | null;
  /** ISO date, when the thing has one. */
  day?: string | null;
  cost?: string | null;
  link?: string | null;
}

/* The two functions that decide what actually lands on the other side live
   in sharepayload.mjs, in plain JavaScript, so their tests execute them —
   see the note there about why "idea, never booking" is worth running. */
export { messageFor, planItemFor } from './sharepayload.mjs';

/** Open the picker over whatever is on screen. */
export function openShareCard(payload: SharePayload): void {
  store.set({ shareCard: payload });
  // The plan list can be stale on a cold open — a picker that shows no plans
  // when the user has three is a feature that looks broken on first use.
  void refreshPlans();
}

export function closeShareCard(): void {
  store.set({ shareCard: null });
}

export async function shareToFriend(friendId: string): Promise<boolean> {
  const p = store.get().shareCard;
  if (!p) return false;
  return await sendDm(friendId, messageFor(p));
}

export async function shareToPlan(planId: string): Promise<boolean> {
  const p = store.get().shareCard;
  if (!p) return false;
  const item = await addPlanItem({ plan_id: planId, ...planItemFor(p) } as never);
  return !!item;
}
