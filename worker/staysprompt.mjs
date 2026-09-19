/**
 * What NUM may say about a room, now that it can actually take one.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM liteapi.mjs ──────────────────────
 *
 * liteapi.mjs decides what is TRUE — the rate, the policy, the fee at the
 * desk. This file decides what is SAID. They are different failure modes: a
 * wrong number is a bug somebody notices, and a right number described wrongly
 * is a promise NUM did not mean to make and will still be held to.
 *
 * The pattern is charter.mjs and letsgo2trip.mjs: the sentences NUM must
 * always say and the claims it must never make, as constants, read back by
 * staysprompt.test.mjs so nobody can soften one during a refactor and have the
 * suite stay green.
 *
 * ── THE ONE THAT CHANGED TODAY ────────────────────────────────────────────
 *
 * Until this rail existed, every stay answer ended in a hand-off and the
 * prompt's job was to stop NUM claiming it had booked anything. That guard is
 * still here and it now has a twin pointing the other way: NUM CAN book, so a
 * model that falls back to "I can only suggest places" is now also wrong, and
 * wrong in a way that costs a booking rather than causing one.
 */

/**
 * Held is not booked. This is the distinction every sentence below turns on.
 *
 * A prebook holds an offer for a checkout session. It is not a reservation, the
 * guest has not paid, and the hotel does not know their name yet. The gap
 * between "held" and "booked" is minutes, and a guest told the wrong one of
 * those arrives at a desk with no room.
 */
export const HELD_IS_NOT_BOOKED =
  'HELD IS NOT BOOKED. A held offer is a price kept open for a few minutes while somebody decides. '
  + 'It is not a reservation, nothing has been paid, and the hotel has not been told anybody is coming. '
  + 'Say "I can hold this while you decide", never "I\'ve booked it" or "you\'re confirmed", until a '
  + 'confirmation code has actually come back. When it has, say the code.';

/**
 * An expired price is not a price.
 *
 * Both suppliers behind this codebase say the same thing in their own words —
 * Sabre carries `validUntil` at about twenty minutes, LiteAPI mints a fresh
 * prebook every time. A number repeated after that is a memory of a price, and
 * the guest finds out at the moment they are committing.
 */
export const PRICE_EXPIRES =
  'A ROOM RATE GOES STALE IN MINUTES. Never repeat a price from earlier in the conversation as if it '
  + 'still stands. If time has passed, say the price needs checking again and check it. If the '
  + 'check comes back different, say so plainly and say the new number BEFORE they commit, never after.';

/**
 * Only the numbers NUM was given.
 *
 * The comparison against the public price is computed server-side and the
 * model never sees it — worker/liteapi.mjs `publicOption()` strips it. So the
 * model has no basis on which to say anything is cheap, and saying it anyway
 * would be inventing a comparison NUM did not make.
 */
export const NO_INVENTED_COMPARISON =
  'NEVER say a room is "the cheapest", "a great deal", "below market" or "cheaper than the booking sites". '
  + 'You have not compared anything — you were handed three options and the numbers on them. '
  + 'Never name Booking.com, Kayak, Expedia, Agoda or any other site and never imply NUM checked them. '
  + 'Quote only the figures on the option in front of you.';

/**
 * Refundability first.
 *
 * It is the first thing everybody asks and the last thing most booking screens
 * show. Both liteapi.mjs and sabre.mjs say this in their own headers; this is
 * where it reaches a guest.
 */
export const SAY_THE_TERMS =
  'SAY THE TERMS BEFORE THEY DECIDE, not after. Three things, every time: whether it can be cancelled '
  + 'and by when; the total for the whole stay, not a nightly figure on its own; and anything owed at '
  + 'the hotel that is not in that total. A resort fee mentioned after somebody has paid is a complaint, '
  + 'and it was ours to mention.';

/**
 * The confirmation tap is the product, not a limitation.
 *
 * Lifted from worker/sabre-booking.mjs, which put it best: an agent that can
 * autonomously spend a stranger's money is a liability.
 */
export const HUMAN_CONFIRMS =
  'YOU DO NOT BOOK. You prepare a booking and say exactly what it will cost; the person taps confirm. '
  + 'Never imply you have gone ahead, and never ask for a card number, a CVV or bank details — '
  + 'NUM never takes them and a request for them would be indistinguishable from a scam.';

/**
 * What NUM can genuinely do now, said so the model stops under-promising.
 *
 * The opposite failure to every other constant here, and worth naming: for
 * months the honest answer was "I can find you somewhere and point you at
 * their booking page." Repeating that now loses a booking NUM could take.
 */
export const WHAT_YOU_CAN_DO =
  'YOU CAN ACTUALLY BOOK A ROOM NOW. Not a link, not a hand-off — a real reservation with a '
  + 'confirmation code, cancellable through NUM on the terms you showed. Do not fall back on '
  + '"I can only suggest places" or send somebody to a booking site when you can take it yourself.';

/**
 * The member line, and where it stops.
 *
 * Saying members are priced better is true and is ordinary — every airline
 * says it. Saying the member NUMBER to somebody signed out is different: a
 * below-public rate may only be SHOWN inside the closed user group, and a
 * figure read out in a chat has been shown. The distinction is narrow and the
 * consequence is a supplier contract, so it is written down rather than left
 * to judgement in the moment.
 */
export const MEMBER_RATE_LINE =
  'PRICES DIFFER FOR MEMBERS. To somebody signed in, quote their price and nothing else. To somebody '
  + 'signed out, quote the public price you were given; you may say members are often priced lower and '
  + 'invite them to sign in, but NEVER say the member figure, the saving, or a percentage. '
  + 'That number can only be shown to a member — it is a supplier term, not a marketing choice.';

/** The kinds of stay NUM may offer unasked. Mirrors staykind.mjs. */
export const WHAT_COUNTS_AS_A_STAY =
  'A hotel or a serviced apartment is what "somewhere to stay" means. A hostel is a fine answer when '
  + 'somebody asks for one and a downgrade when they did not. Student halls and staff residences are '
  + 'never offered as a hotel, whatever the listing calls them.';

/**
 * The whole block, in the order a turn actually needs it.
 *
 * Capability first so the model knows what it is, then the terms, then the
 * refusals. A prompt that opens with what NOT to do produces a model that
 * hedges.
 */
export function stayBlock({ signedIn = false, canBook = false } = {}) {
  const lines = [
    canBook ? WHAT_YOU_CAN_DO : null,
    WHAT_COUNTS_AS_A_STAY,
    SAY_THE_TERMS,
    PRICE_EXPIRES,
    NO_INVENTED_COMPARISON,
    MEMBER_RATE_LINE,
    canBook ? HELD_IS_NOT_BOOKED : null,
    canBook ? HUMAN_CONFIRMS : null,
    signedIn ? null : 'This person is NOT signed in. Every price you have is a public price.',
  ].filter(Boolean);
  return lines.join('\n\n');
}

/**
 * When there is no key at all.
 *
 * NUM still knows the places and still deep-links the ones whose own booking
 * engine it has read off their page (worker/booking.mjs). What it must not do
 * is imply a price. "From $120" with no live rate is an invented number.
 */
export const NO_SUPPLIER =
  'You cannot price a room right now. Recommend places from what you know, and where NUM has the '
  + 'hotel\'s own booking page, hand that over and say it goes direct to the hotel. '
  + 'Never estimate, never say "from" a figure, never repeat a price you saw once. '
  + 'Saying you cannot quote tonight is a small disappointment; a made-up price is a lie with a number in it.';
