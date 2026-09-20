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
import type { InviteDraft } from './types';
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

/**
 * THE FIRST ANSWER IS FREE. (18 Sep 2026, Dre's call.)
 *
 * The gate above was briefly the whole story: nothing proved, nothing sent.
 * It was set in response to "we are getting a ton of users and they're just
 * closing the sign-in box", and the instinct was right — but the numbers were
 * not. Over the fourteen days to 18 Sep, roughly FOUR people a day reached the
 * code box at all, and nearly every one of them finished (two failures in the
 * whole period). Nobody was closing the box, because almost nobody got to it.
 *
 * What was actually happening sat much earlier: 1,903 visitors in a week
 * produced 18 first messages, and an X campaign that spent $529.05 driving 842
 * clicks produced 98 arrivals, 0 messages and 0 accounts. A stranger was being
 * asked to prove a phone number before NUM had been useful even once.
 *
 * So the ceiling is gated and the core is not — the rule membership.mjs has
 * stated all along. One real answer, free, to anybody. After that, being
 * reachable is the price of continuing, which is fair: by then they have been
 * given something, and everything past this point either costs money to serve
 * or has to reach them later.
 */
export const FREE_ANSWERS = 1;

/** Questions this person has already asked. The transcript is the counter. */
export function asksSpent(msgs: ReadonlyArray<{ who: string }> | null | undefined): number {
  let n = 0;
  for (const m of msgs ?? []) if (m?.who === 'u') n += 1;
  return n;
}

/**
 * May this person send right now?
 *
 * Takes both halves explicitly so a component can compute it from the values
 * it already subscribes to. Reading the store inside a render instead would
 * give an answer that never updates when the transcript grows.
 */
export const gateOpen = (
  me: Member | null | undefined,
  msgs: ReadonlyArray<{ who: string }> | null | undefined,
): boolean => canSend(me) || asksSpent(msgs) < FREE_ANSWERS;

/**
 * LOOKING IS NOT SENDING. (20 Sep 2026, Dre's call.)
 *
 * The gate above was written for messages, and then it caught the widgets.
 * Dre, testing: "if you don't invite a friend it doesn't search on the
 * widgets. I tried flights and hotels, same thing." He was right, and the bug
 * was worse than it looked: a feature page composes its question and hands it
 * to askNum(), so filling in a flight search WAS sending a message, the gate
 * refused it, and the app opened the sheet whose first screen is about
 * inviting people. Somebody who wanted a flight time was asked for a friend.
 *
 * So the rule keeps its own reason. The gate exists because an answer NUM
 * cannot deliver is work that can never be finished — a table held for a
 * stranger, a confirmation with nowhere to go. A SEARCH has nothing to
 * deliver. It is read on the screen it was asked from and it is over. The
 * things that do create an obligation — a booking, a bill, a plan, an invite,
 * a reminder that has to fire — are gated at their own sheets and stay gated
 * (BookSheet, PaySheet, TravelSheet, PartySheet, ErrandSheet all call
 * needAccount()), so opening this door does not open those.
 *
 * `me` is still required. An opaque device is not a person yet, and the
 * server refuses an ask with no member id anyway (worker/sendgate.mjs).
 */
export const mayBrowse = (me: Member | null | undefined): boolean => !!me?.id;

/** The same question, asked of current state. */
export const mayAsk = (opts?: { browse?: boolean }): boolean => {
  const s = store.get();
  if (opts?.browse && mayBrowse(s.me)) return true;
  return gateOpen(s.me, s.msgs);
};

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
  // `intent: 'account'` and not a bare `{}`: the bare draft lands the person
  // on the invite-a-friend screen, which is how "the widget won't search
  // unless I invite a friend" came to be true. What is being asked for here
  // is a number or an address, so that is the screen that opens.
  store.set({ pendingAsk: held || null, inviteOpen: { intent: 'account' }, threadOpen: true });
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

/**
 * THE HELD QUESTION FIRES THE MOMENT THE PERSON BECOMES REACHABLE — by any
 * door (18 Sep 2026).
 *
 * The first version fired it only at the end of verifyCode(), which is the
 * SMS and email path. Dre filled in a feature page, met the sheet, signed in,
 * watched it close — "and nothing happens". Sign in with Apple, a recovered
 * account and the review grant all make a member sendable without ever
 * reaching verifyCode(), so the question sat in `pendingAsk` for ever.
 *
 * So the rule is a subscription, not a call site: whenever `me` goes from
 * not-sendable to sendable and a question is waiting, it goes — thread open,
 * sheet closed, NUM answering. One place, every door, and no future sign-in
 * path has to remember to do it. concierge.ts is imported late because it
 * imports this module.
 */
let wasSendable = canSend(store.get().me);
store.subscribe(() => {
  const now = canSend(store.get().me);
  if (now && !wasSendable) {
    const held = takeHeldAsk();
    if (held) {
      store.set({ inviteOpen: null, threadOpen: true, unread: 0 });
      void import('./concierge').then(({ askNum }) => askNum(held)).catch(() => store.set({ pendingAsk: held }));
    }
  }
  wasSendable = now;
});


/**
 * Open the account sheet BECAUSE something needed it, remembering where the
 * person was. `returnTo` is the sheet to put back when the account sheet
 * closes — signed in or not — so a tap on "set up my account" in the middle
 * of a plan lands back in that plan. Never in the thread, unless that is
 * where they were.
 */
export function needAccount(returnTo: InviteDraft['returnTo'] = {}, intent: InviteDraft['intent'] = 'account'): void {
  dropKeyboard();
  store.set({ inviteOpen: { intent, returnTo } });
}

/**
 * Close the invite/account sheet and put back whatever it interrupted.
 * A held ask outranks the return: the person asked NUM for something, and
 * gate.ts is about to send it, so the thread is where they need to be.
 */
export function closeInvite(): void {
  store.set((s) => {
    const back = s.inviteOpen?.returnTo ?? {};
    const held = !!s.pendingAsk;
    return { inviteOpen: null, ...(held ? {} : back) };
  });
}
