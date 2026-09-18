/**
 * TEXT SIZE — one setting that makes everything legible for someone who
 * cannot see as well.
 *
 * Dre, 18 Sep: "the text is a little small lets offer size options for the
 * text for people that cant see as well. also just make the font 1 size
 * bigger."
 *
 * Every type size in the app is an inline `fontSize: 12.5` — some two
 * thousand of them — so a scale cannot be a variable those sizes multiply.
 * The one lever that reaches all of them at once is CSS `zoom` on the app's
 * root: text, icons, tap targets and spacing grow together, the way a phone's
 * own Display Zoom works, and percentage layouts (two cards across, a sheet
 * at the bottom) keep their shape because a percentage is still of the
 * parent. `zoom` is in every WebKit and Chromium, and Firefox since 126.
 *
 * STANDARD is already one step up from what shipped before today (1.0 →
 * 1.07, about a point on body text), because that was the second half of the
 * ask. LARGE and EXTRA LARGE are for the person who needs them.
 *
 * Applied as `data-text` on <html> (glass.css holds the three values) and
 * kept in the app state, so it survives a reload like the theme does.
 */
import { store } from './store';

export type TextSize = 'standard' | 'large' | 'xl';

export const TEXT_SIZES: Array<{ id: TextSize; name: string; blurb: string; zoom: number }> = [
  { id: 'standard', name: 'Standard', blurb: 'The everyday size', zoom: 1.07 },
  { id: 'large', name: 'Large', blurb: 'Easier on the eyes', zoom: 1.18 },
  { id: 'xl', name: 'Extra large', blurb: 'For reading without glasses', zoom: 1.3 },
];

const KNOWN: TextSize[] = ['standard', 'large', 'xl'];
export const normaliseTextSize = (v: unknown): TextSize => (KNOWN.includes(v as TextSize) ? (v as TextSize) : 'standard');

export function applyTextSize(id: TextSize): void {
  try { document.documentElement.setAttribute('data-text', normaliseTextSize(id)); } catch { /* no DOM */ }
}

export function setTextSize(id: TextSize): void {
  store.set({ textSize: id });
  applyTextSize(id);
}
