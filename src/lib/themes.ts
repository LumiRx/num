// Theme picking. A theme is a `data-theme` attribute on <html> and nothing
// else — every component reads the same tokens either way, so nothing here
// knows what any screen looks like.
import { store } from './store';
import type { ThemeId } from './types';

export const THEMES: Array<{ id: ThemeId; name: string; blurb: string; swatch: [string, string, string] }> = [
  { id: 'ember', name: 'Ember', blurb: 'The house colours — warm coral on cream', swatch: ['#faf7f4', '#ec3013', '#ffd8c2'] },
  { id: 'bloom', name: 'Bloom', blurb: 'Rose and lilac, soft and bright', swatch: ['#fdf6fa', '#d6337a', '#f3c7ff'] },
  { id: 'midnight', name: 'Midnight', blurb: 'Dark mode, easy at 2am', swatch: ['#14161c', '#ff7a45', '#4a2f5c'] },
  { id: 'neon', name: 'Neon', blurb: 'Futuristic — cyan and violet on black', swatch: ['#07080f', '#00e5ff', '#b14bff'] },
  { id: 'mono', name: 'Mono', blurb: 'Stripped back. White, black, one hairline', swatch: ['#ffffff', '#0a0a0a', '#e4e4e7'] },
  { id: 'heritage', name: 'Heritage', blurb: 'Old school — oxblood, brass and cream', swatch: ['#f6f1e6', '#8c2f23', '#b5893f'] },
  { id: 'forest', name: 'Forest', blurb: 'Deep green and brass, calm outdoors', swatch: ['#f2f5f1', '#1f7a4d', '#c9a227'] },
  { id: 'plain', name: 'Plain', blurb: 'No opinion. Grey with one blue', swatch: ['#f5f5f6', '#2563eb', '#e3e8f5'] },
];

/** Dark themes need a light status bar; iOS reads the meta tag, not the CSS. */
const DARK: ThemeId[] = ['midnight', 'neon'];

export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  if (id === 'ember') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);

  // Keep the browser chrome in step with the app, or the top of the screen
  // stays cream while the app goes black.
  const bar = getComputedStyle(root).getPropertyValue('--shell-bg').trim() || '#faf7f4';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', DARK.includes(id) ? bar : '#faf7f4');
  document
    .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute('content', DARK.includes(id) ? 'black-translucent' : 'default');
}

export function setTheme(id: ThemeId): void {
  store.set({ theme: id });
  applyTheme(id);
}
