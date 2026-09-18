// What kind of thing a listing is, for a card that has no photo.
//
// "Street food · London" → "Street food". The feeds put the kind first in
// `sub` and the area after it, and the area is already printed lower down on
// the card, so the first segment is the only part worth putting on the cover.
//
// Nothing is invented and nothing is guessed: no `sub`, or a `sub` long
// enough to be a sentence rather than a category, returns null and the cover
// stays a plain square. A wrong label on a photo's place is worse than no
// label, because a person reads it as a fact about the venue.
//
// It lives here rather than in NearbyRail.tsx for the reason near() does: a
// rule worth testing should not need a renderer to reach it.
export const kindOf = (i: { sub?: string | null }): string | null => {
  const first = String(i?.sub ?? '').split('·')[0]?.trim() ?? '';
  return first && first.length <= 28 ? first : null;
};
