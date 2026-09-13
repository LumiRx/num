/**
 * What a shared card turns into on the other side.
 *
 * Two tiny functions, in plain JavaScript rather than TypeScript, for the
 * same reason as faredisplay.mjs: one of them decides whether a fare someone
 * forwarded to their group shows up as an IDEA or as a BOOKING, and that is
 * a property worth executing in a test rather than reading in a diff.
 *
 * Sharing is proposing. A person sending "look at this fare" to a plan has
 * not bought anything, and a plan row that says BOOKED because somebody
 * forwarded a price is a lie the group will act on — someone stops looking,
 * or turns up expecting a seat. Only confirmPlanItem may say booked.
 */

/** The lead-in on a shared message. A bare fare with no sentence reads as spam. */
export function messageFor(p) {
  const opener = p?.kind === 'flight' ? 'Look at this fare' : 'Look at this';
  const body = [`${opener} — ${p?.summary ?? ''}`.trim()];
  if (p?.link) body.push(p.link);
  return body.join('\n');
}

/** What the plan sees. Always an idea; see the note above. */
export function planItemFor(p) {
  return {
    kind: 'idea',
    title: p?.title ?? '',
    ...(p?.place ? { place: p.place } : {}),
    ...(p?.day ? { day: p.day } : {}),
    ...(p?.cost ? { cost: p.cost } : {}),
    note: p?.summary ?? '',
  };
}
