// WHO MAY SEND A MESSAGE.
//
// 18 Sep 2026. The app was fully usable without an account — deliberately,
// since 0.8.323 stopped forcing the sheet on launch — and the result at scale
// was a lot of people asking NUM things and then closing the sign-in box, so
// NUM answered strangers it could never reach again. No booking can be
// confirmed to a stranger, no table held, no plan shared, no notification
// sent. An answer to somebody NUM cannot reach back is the one kind of work
// this product cannot finish.
//
// The rule now: LOOK FREELY, SEND ONCE REACHABLE. Every screen, every rail,
// every feature page and every event stays open to a visitor — that is the
// shop window and it is also what App Review 5.1.1(v) expects of a browse
// surface. Sending a message needs a proved number or a proved address,
// because that is the thing that makes an answer deliverable.
//
// ONE RULE, IN ONE PLACE. It is written here rather than in the composer
// because the composer is not the only door: a starter chip, a feature page,
// a rail card, the event sheet and a deep link all reach askNum(), and a gate
// that lives on one of six doors is a gate on none of them.
import { store } from './store';
import type { Member } from './types';

/**
 * May this member send?
 *
 * A proved phone, a proved address, or the App Store Connect review grant.
 *
 * THE REVIEW GRANT IS NOT AN AFTERTHOUGHT. `worker/social.mjs` hands the
 * reviewer a member id without setting `phone_verified`, on purpose: we never
 * texted that number, so claiming we proved it would be a lie in our own
 * database. A gate that only read `phone_verified` would therefore hand Apple
 * an app where the concierge cannot be used at all — a rejection, earned by
 * our own honesty about a flag. So the grant is named here explicitly.
 */
export const canSend = (me: Member | null | undefined): boolean =>
  !!me && (
    // The server's own verdict, from the one function that knows every way a
    // member can be reachable (worker/membercontact.hasVerifiedContact). An
    // Apple sign-in is reachable with neither flag below set, so reading only
    // the flags would refuse every Apple member.
    me.verified === true
    || me.phone_verified === true
    || me.email_verified === true
    || me.review_access === true
  );

/** The same question, asked of current state. */
export const mayAsk = (): boolean => canSend(store.get().me);

/**
 * Hold the question, open the door.
 *
 * The text is kept rather than dropped. Somebody who typed "table for four at
 * 8" and met a sign-in sheet has already told us what they want; making them
 * type it again after verifying is a second toll on the same person. It is
 * held for THIS launch only — a question from three days ago must not fire
 * itself off at a stranger's account, so it is not persisted.
 */
export function holdAndAsk(text: string): void {
  const held = String(text ?? '').trim();
  dropKeyboard();
  store.set({ pendingAsk: held || null, inviteOpen: {}, threadOpen: true });
}

/**
 * Let go of the focused field before a sheet opens over it.
 *
 * Not politeness — arithmetic. App.tsx publishes the keyboard height as
 * `--kb` and the shell absorbs it, so every sheet's maxHeight is a percentage
 * of what is left ABOVE the keyboard (see sheetBase in lib/derive.ts). Open a
 * sheet while a text field still holds focus and that ceiling is computed
 * against a shrunken shell: on 18 Sep 2026 the sign-in sheet opened from the
 * composer and rendered with no visible height at all, so pressing Enter
 * looked like nothing happening while TAPPING send — which blurs the field on
 * its way down — worked every time.
 *
 * Nobody can type in the composer while a sheet covers it, so there is
 * nothing to lose by dropping focus first.
 */
export function dropKeyboard(): void {
  try {
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) el.blur();
  } catch { /* no document: tests, SSR */ }
}

/** Whatever was held, once. Returns null when there is nothing waiting. */
export function takeHeldAsk(): string | null {
  const held = store.get().pendingAsk;
  if (!held) return null;
  store.set({ pendingAsk: null });
  return held;
}
