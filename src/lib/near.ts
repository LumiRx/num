// How far away, in the unit a person would say out loud.
//
// It lived in NearbyRail, which is a .tsx component — and a rule that plain
// modules need (the event sheet, and whatever asks next) cannot be imported
// from a component without dragging React in, or tested without a renderer.
// So the rule is here and the rail re-exports it, which keeps every existing
// caller working and leaves one definition of "400 m".
export const near = (km: number | null | undefined): string | null =>
  km == null ? null : km < 1 ? `${Math.round(km * 1000)} m` : `${Math.round(km * 10) / 10} km`;
