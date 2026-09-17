// Theme picking. A theme is a `data-theme` attribute on <html> and nothing
// else — every component reads the same tokens either way, so nothing here
// knows what any screen looks like.
import { store } from './store';
import type { ThemeId } from './types';

/**
 * One brand, two lights. Verified (ink, paper, the checked green) by day and
 * its dark twin at night; Auto follows the phone. The nine colour themes of
 * the summer are retired — a concierge has one look, like a good hotel.
 */
export const THEMES: Array<{ id: ThemeId; name: string; blurb: string; swatch: [string, string, string] }> = [
  { id: 'auto', name: 'Auto', blurb: 'Follows your phone — light by day, dark at night', swatch: ['#f6faf9', '#0ea483', '#0a1a24'] },
  { id: 'verified', name: 'Light', blurb: 'Ink on paper, the checked green', swatch: ['#f6faf9', '#0ea483', '#d5f2e8'] },
  { id: 'verified-dark', name: 'Dark', blurb: 'Paper on ink, easy at 2am', swatch: ['#0a1a24', '#2cc49f', '#112631'] },
];

const KNOWN: ThemeId[] = ['auto', 'verified', 'verified-dark'];
/** Anything saved by an older build (ember, bloom, midnight…) becomes Auto. */
export const normaliseTheme = (id: unknown): ThemeId => (KNOWN.includes(id as ThemeId) ? (id as ThemeId) : 'auto');

const systemDark = () => { try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; } };
/** What actually goes on <html> for a chosen theme. */
export const resolveTheme = (id: ThemeId): 'verified' | 'verified-dark' => (id === 'verified-dark' || (id === 'auto' && systemDark()) ? 'verified-dark' : 'verified');

let watching = false;
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  const on = resolveTheme(normaliseTheme(id));
  root.setAttribute('data-theme', on);
  const dark = on === 'verified-dark';

  // Keep the browser chrome in step with the app, or the top of the screen
  // stays cream while the app goes black.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#06121a' : '#f6faf9');
  document
    .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute('content', dark ? 'black-translucent' : 'default');

  // Auto follows the phone while the app is open, not only at launch.
  if (!watching) {
    watching = true;
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get().theme));
    } catch { /* no matchMedia */ }
  }
}

export function setTheme(id: ThemeId): void {
  store.set({ theme: id });
  applyTheme(id);
}
