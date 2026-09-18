// The app in the reader's language.
//
// Every string a person can read goes through t('English text'). English is
// the key: the source stays readable, the copy-guard tests keep working, and
// a missing translation shows English rather than a blank. The map itself
// comes from /api/i18n (machine once, stored, a human can replace any line)
// and is cached on the phone, so a second launch in Thai is Thai before the
// network answers.
//
// Which language: the one chosen in Profile; else the phone's; else English.
// A change swaps the map and remounts the app (state lives in the store, so
// nothing is lost) — components do not each subscribe.
import { store, useApp } from './store';
import { apiUrl } from './apibase';
import { CATALOG as catalog } from '../i18n/catalog';

export const LANGS = {
  en: { name: 'English', dir: 'ltr' },
  th: { name: 'ไทย', dir: 'ltr' },
  zh: { name: '中文', dir: 'ltr' },
  ja: { name: '日本語', dir: 'ltr' },
  ko: { name: '한국어', dir: 'ltr' },
  es: { name: 'Español', dir: 'ltr' },
  fr: { name: 'Français', dir: 'ltr' },
  de: { name: 'Deutsch', dir: 'ltr' },
  ar: { name: 'العربية', dir: 'rtl' },
  // Mongolian, 17 Sep 2026, for the Ulaanbaatar launch. Nothing else to do:
  // /api/i18n translates the catalogue on first ask and caches it in
  // num_translations, so a Mongolian phone gets Mongolian on its next load.
  mn: { name: 'Монгол', dir: 'ltr' },
} as const;
export type Lang = keyof typeof LANGS;
export const isLang = (v: unknown): v is Lang => typeof v === 'string' && v in LANGS;

let current: Lang = 'en';
let map: Record<string, string> = {};

/** Translate one string. `{name}` placeholders are filled after translation. */
export function t(en: string, vars?: Record<string, string | number>): string {
  let s = map[en] ?? en;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export const currentLang = (): Lang => current;

export { T } from './i18nmark';

/** The phone's language, if NUM speaks it. */
export function phoneLang(): Lang {
  try {
    for (const l of navigator.languages ?? [navigator.language]) {
      const two = String(l).toLowerCase().slice(0, 2);
      if (isLang(two)) return two;
    }
  } catch { /* no navigator */ }
  return 'en';
}

export function pickLang(): Lang {
  const chosen = store.get().lang;
  return isLang(chosen) ? chosen : phoneLang();
}

const cacheKey = (lang: Lang) => `num-i18n:${lang}:${catalog.hash}`;

function apply(lang: Lang, m: Record<string, string>) {
  current = lang;
  map = m;
  try {
    document.documentElement.lang = lang;
    document.documentElement.dir = LANGS[lang].dir;
  } catch { /* SSR-ish */ }
  store.set((s) => ({ i18nTick: s.i18nTick + 1 }));
}

/** Load a language: cached map first, then the network, then English. */
export async function loadLang(lang: Lang): Promise<void> {
  if (lang === 'en') { apply('en', {}); return; }
  let cached: Record<string, string> | null = null;
  try { const raw = localStorage.getItem(cacheKey(lang)); if (raw) cached = JSON.parse(raw); } catch { /* fine */ }
  if (cached) apply(lang, cached);
  try {
    const res = await fetch(apiUrl('/api/i18n'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, strings: catalog.strings }),
    });
    const body = (await res.json()) as { ok: boolean; map?: Record<string, string> };
    if (body.ok && body.map && Object.keys(body.map).length) {
      try { localStorage.setItem(cacheKey(lang), JSON.stringify(body.map)); } catch { /* quota */ }
      if (!cached || JSON.stringify(cached) !== JSON.stringify(body.map)) apply(lang, body.map);
    } else if (!cached) apply('en', {});
  } catch {
    if (!cached) apply('en', {});
  }
}

export function setLang(lang: Lang | null): void {
  store.set({ lang });
  void loadLang(lang ?? phoneLang());
}

/** Subscribe to the remount tick — used by the root only. */
export const useI18nTick = () => useApp((s) => s.i18nTick);

/** Dates in the reader's language: "Thu 17 Sept" / "พฤ. 17 ก.ย." */
export function fmtDate(d: Date, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  try {
    // ICU's en-GB abbreviates September as "Sept" (the only four-letter
    // month), which sits oddly beside "Fri 18" in a header. Every phone's
    // own calendar says Sep; so does NUM.
    return d.toLocaleDateString(current === 'en' ? 'en-GB' : current, opts).replace(/\bSept\b/, 'Sep');
  } catch { return d.toDateString(); }
}
