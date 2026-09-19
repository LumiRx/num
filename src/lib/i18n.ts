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
  let s = map[en];
  if (s === undefined) { s = en; queueDynamic(en); }
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

// ── STRINGS THE CATALOGUE CANNOT SEE (19 Sep 2026) ────────────────────────
//
// The catalogue is every t('literal') in the source. A string that reaches
// t() by another road — a city name from the directory, a category the server
// sent, a label pulled out of a list — is not in it, and until today it stayed
// English on a Thai phone: "titles and cities are still in English". So a
// miss is now asked for: collected for half a second, sent once, merged into
// the map, remembered on the phone, and the app re-renders. Each string is
// asked once per launch, so a line the server cannot translate costs one
// request, not one per render. Never for English, never for what is not text.
const pendingDyn = new Set<string>();
const askedDyn = new Set<string>();
let dynFlush: ReturnType<typeof setTimeout> | null = null;
const dynKey = (lang: Lang) => `num-i18n-dyn:${lang}`;
const DYN_CAP = 600;

function queueDynamic(en: string) {
  if (current === 'en' || askedDyn.has(en) || pendingDyn.has(en)) return;
  if (en.length < 2 || en.length > 200 || !/\p{L}/u.test(en)) return;
  if (/^https?:|^\/|^[a-z0-9_.-]+$|^\d/.test(en)) return; // a url, a path, a key, a number
  pendingDyn.add(en);
  if (!dynFlush) dynFlush = setTimeout(() => { dynFlush = null; void flushDynamic(); }, 600);
}

async function flushDynamic(): Promise<void> {
  const lang = current;
  if (lang === 'en' || !pendingDyn.size) return;
  const strings = [...pendingDyn].slice(0, 200);
  for (const s of strings) { pendingDyn.delete(s); askedDyn.add(s); }
  try {
    const res = await fetch(apiUrl('/api/i18n'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, strings }),
    });
    const body = (await res.json()) as { ok: boolean; map?: Record<string, string> };
    if (!body.ok || !body.map || lang !== current) return;
    const got = Object.entries(body.map).filter(([k, v]) => v && v !== k);
    if (!got.length) return;
    for (const [k, v] of got) map[k] = v;
    try {
      const raw = localStorage.getItem(dynKey(lang));
      const dyn: Record<string, string> = raw ? JSON.parse(raw) : {};
      for (const [k, v] of got) dyn[k] = v;
      const keys = Object.keys(dyn);
      for (const k of keys.slice(0, Math.max(0, keys.length - DYN_CAP))) delete dyn[k];
      localStorage.setItem(dynKey(lang), JSON.stringify(dyn));
    } catch { /* quota */ }
    store.set((s) => ({ i18nTick: s.i18nTick + 1 }));
  } catch { /* offline — English stands */ }
  if (pendingDyn.size && !dynFlush) dynFlush = setTimeout(() => { dynFlush = null; void flushDynamic(); }, 600);
}

/** What this phone has already learned for a language, on top of the catalogue's map. */
function withDynamic(lang: Lang, m: Record<string, string>): Record<string, string> {
  try {
    const raw = localStorage.getItem(dynKey(lang));
    if (raw) return { ...(JSON.parse(raw) as Record<string, string>), ...m };
  } catch { /* fine */ }
  return m;
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

const retried = new Set<Lang>();
const cacheKey = (lang: Lang) => `num-i18n:${lang}:${catalog.hash}`;

function apply(lang: Lang, m: Record<string, string>) {
  if (lang !== current) { askedDyn.clear(); pendingDyn.clear(); }
  current = lang;
  map = lang === 'en' ? {} : withDynamic(lang, m);
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
    const body = (await res.json()) as { ok: boolean; map?: Record<string, string>; translated?: number; asked?: number };
    if (body.ok && body.map && Object.keys(body.map).length) {
      try { localStorage.setItem(cacheKey(lang), JSON.stringify(body.map)); } catch { /* quota */ }
      if (!cached || JSON.stringify(cached) !== JSON.stringify(body.map)) apply(lang, body.map);
      // The server answers with what it has stored and translates the rest
      // after the response (worker/i18n.mjs bundleFor → defer). New strings
      // from a fresh release arrive on the second ask, so ask once more soon
      // rather than leaving them English until tomorrow's launch.
      if ((body.translated ?? 0) < (body.asked ?? 0) && !retried.has(lang)) {
        retried.add(lang);
        setTimeout(() => { if (current === lang) void loadLang(lang); }, 20_000);
      }
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
