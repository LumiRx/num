// The plan board's arithmetic — days, hours, order, money formatting — kept
// apart from the React so it can be tested on its own (planboard.test.mjs).
import type { PlanItem } from './types';

/** "$12.50" / "€8" / "฿1,200" in the plan's currency. Whole units when there are no cents. */
export function fmtMinor(minor: number, currency: string): string {
  const n = Number(minor) || 0;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: n % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(n / 100);
  } catch {
    return `${currency} ${(n / 100).toFixed(2)}`;
  }
}

/** YYYY-MM-DD + n days, in UTC so a DST night never eats a day. */
export const addDays = (day: string, n: number): string => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Every day between two dates inclusive, capped so a typo can't draw a year. */
export function spanDays(from: string | null | undefined, to: string | null | undefined, cap = 21): string[] {
  if (!from) return [];
  const out = [from];
  let cur = from;
  while (to && cur < to && out.length < cap) { cur = addDays(cur, 1); out.push(cur); }
  return out;
}

/** "Fri 2 Oct" — never "Sept", never a locale surprise. */
export const dayLabel = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${wd} ${d} ${mo}`;
};

/** The hours a day on the board shows: 7am to 11pm, then midnight and 1am. */
export const HOURS: string[] = [...Array.from({ length: 17 }, (_, i) => String(i + 7).padStart(2, '0')), '00', '01'];

/** "19:30" → "19"; anything that is not HH:MM → null (lands in Anytime). */
export const hourOf = (time: string | null | undefined): string | null => (time && /^\d{2}:\d{2}$/.test(time) ? time.slice(0, 2) : null);

export const hourLabel = (hh: string): string => {
  const h = Number(hh);
  return h === 0 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`;
};

export const initials = (name: string | null | undefined): string => (name || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

/** Items in one slot, in board order: by time, then the saved order, then the title. */
export const inOrder = (a: PlanItem, b: PlanItem): number =>
  (a.time ?? '').localeCompare(b.time ?? '') || (a.sort ?? 0) - (b.sort ?? 0) || a.title.localeCompare(b.title);

/**
 * Where a dropped card lands, and the order the whole target slot takes.
 *
 * `slot` is "<day>|<hour>" ("any|" for no day, "<day>|" for no time). The
 * moved card keeps its minutes when it stays inside its own hour and lands on
 * :00 otherwise; it goes before `before` when that card is in the slot, else
 * at the end. Returns one move per card in the slot, with sequential sorts,
 * and whether anything actually changed — a shuffle that lands where it
 * started is not a write.
 */
export function landing(
  items: PlanItem[],
  movingId: string,
  slot: string,
  before: string | null,
): { moves: Array<{ id: string; sort: number; day?: string | null; time?: string | null }>; changed: boolean } {
  const moving = items.find((i) => i.id === movingId);
  if (!moving) return { moves: [], changed: false };
  const [toDay, toHour] = slot.split('|');
  const targetDay = toDay === 'any' ? null : toDay;
  const sameHour = hourOf(moving.time) === toHour && (moving.day ?? null) === targetDay;
  const targetTime = toHour === '' ? null : sameHour ? moving.time ?? `${toHour}:00` : `${toHour}:00`;
  const live = items.filter((i) => i.status !== 'cancelled');
  const slotItems = live
    .filter((i) => i.id !== movingId && (i.day ?? null) === targetDay && (toHour === '' ? !hourOf(i.time) : hourOf(i.time) === toHour))
    .sort(inOrder);
  const at = before ? slotItems.findIndex((i) => i.id === before) : -1;
  const ordered = at >= 0 ? [...slotItems.slice(0, at), moving, ...slotItems.slice(at)] : [...slotItems, moving];
  const moves = ordered.map((i, n) => ({ id: i.id, sort: n, ...(i.id === movingId ? { day: targetDay, time: targetTime } : {}) }));
  const changed = moves.some((m) => {
    const cur = items.find((i) => i.id === m.id);
    return !cur || (cur.sort ?? 0) !== m.sort || (m.id === movingId && ((cur.day ?? null) !== targetDay || (cur.time ?? null) !== targetTime));
  });
  return { moves, changed };
}
