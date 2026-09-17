// The app in the reader's language.
//
// The app ships English. The phone asks this endpoint for its language and
// gets back a map {english → translated} for every string in its catalogue.
// Translation is machine (Workers AI, m2m100) and happens ONCE per string per
// language: the result is stored in num_translations as a `locale_string`,
// where a person can later replace it (status 'approved') and the app picks
// the human line up on its next load. English is never translated, and any
// string the engine mangles falls back to English rather than nonsense.
//
// Rules the site's translator (worker/site.mjs) taught us, kept here:
//   - brand words stay (NUM, 5arz, LINE, WhatsApp…): they are masked before
//     the engine sees them and put back after;
//   - a string that carries money or a percentage is never translated;
//   - `{name}` placeholders are masked the same way, and a translation that
//     loses one is rejected — a "Watching {flight}" with no {flight} is worse
//     than English.
// Same rules as worker/site.mjs, restated rather than imported so num-app
// does not bundle the site worker's entry file.
export const KEEP = Object.freeze([
  'NUM', 'Num', '5arz', 'LINE', 'WhatsApp', 'WeChat', 'Stripe', 'itsnum.com', 'Ticketmaster', 'Viator', 'Uber', 'Google', 'Apple',
]);
const CARRIES_A_NUMBER = /[$£€฿]\s?\d|\d+\s?%|\d+\.\d{2}/;
export const isTranslatable = (t) => {
  const s = String(t ?? '');
  if (!s.trim()) return false;
  if (CARRIES_A_NUMBER.test(s)) return false;
  if (KEEP.includes(s.trim())) return false;
  return /\p{L}/u.test(s);
};

/** The languages the app offers. `dir` because Arabic reads right to left. */
export const APP_LANGS = Object.freeze({
  en: { name: 'English', dir: 'ltr', engine: 'en', locale: 'en' },
  th: { name: 'ไทย', dir: 'ltr', engine: 'th', locale: 'th' },
  zh: { name: '中文', dir: 'ltr', engine: 'zh', locale: 'zh-Hans' },
  ja: { name: '日本語', dir: 'ltr', engine: 'ja', locale: 'ja' },
  ko: { name: '한국어', dir: 'ltr', engine: 'ko', locale: 'ko' },
  es: { name: 'Español', dir: 'ltr', engine: 'es', locale: 'es' },
  fr: { name: 'Français', dir: 'ltr', engine: 'fr', locale: 'fr' },
  de: { name: 'Deutsch', dir: 'ltr', engine: 'de', locale: 'de' },
  ar: { name: 'العربية', dir: 'rtl', engine: 'ar', locale: 'ar' },
});

const ENGINE = '@cf/meta/m2m100-1.2b';
const MAX_STRINGS = 900;
const CONCURRENCY = 10;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Stable id for an English string: short, safe in a key, no collisions that matter. */
export async function hashOf(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hide the parts the engine must not touch behind numbered tokens.
 * Tokens are digits-only-in-letters so m2m100 copies them through; it has
 * been seen to translate "NUM" into a word for "number" otherwise.
 */
export function mask(text) {
  const kept = [];
  const put = (s) => { kept.push(s); return ` QQ${kept.length - 1}QQ `; };
  let out = text.replace(/\{[a-zA-Z0-9_]+\}/g, put);
  for (const word of KEEP) out = out.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), put);
  return { masked: out, kept };
}

/** Put the kept parts back. Null if the engine dropped one. */
export function unmask(translated, kept) {
  let out = translated;
  for (let i = 0; i < kept.length; i++) {
    const re = new RegExp(`\\s*QQ\\s?${i}\\s?QQ\\s*`, 'g');
    if (!re.test(out)) return null;
    out = out.replace(re, (m) => {
      const lead = /^\s/.test(m) ? ' ' : '';
      const tail = /\s$/.test(m) ? ' ' : '';
      return `${lead}${kept[i]}${tail}`;
    });
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?;:)\]}’”])/g, '$1').replace(/([(\[{“‘])\s+/g, '$1').trim();
}

async function translateOne(env, text, lang) {
  const meta = APP_LANGS[lang];
  if (!meta || lang === 'en' || !env?.AI) return null;
  if (!isTranslatable(text)) return null;
  const { masked, kept } = mask(text);
  try {
    const out = await env.AI.run(ENGINE, { text: masked, source_lang: 'en', target_lang: meta.engine });
    const t = typeof out?.translated_text === 'string' ? out.translated_text.trim() : '';
    if (!t) return null;
    const back = unmask(t, kept);
    if (!back || back === text) return null;
    return back;
  } catch (err) {
    console.warn('[i18n] translate failed', lang, err?.message ?? err);
    return null;
  }
}

async function ensureTable(env) {
  // num_translations exists in production (STRICT, with a locales FK). A
  // fresh test database gets the columns this module reads and writes.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS num_translations (
    id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT NOT NULL,
    locale TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'machine', engine TEXT,
    source_locale TEXT, source_hash TEXT, back_translation TEXT, quality_bp INTEGER,
    status TEXT NOT NULL DEFAULT 'draft', reviewed_by TEXT, reviewed_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`).run();
}

/**
 * The map for one language: stored lines first (a human's approved line beats
 * the machine's), then the machine for whatever is new, saved for next time.
 */
export async function bundleFor(env, lang, strings) {
  const meta = APP_LANGS[lang];
  const map = {};
  if (!meta || lang === 'en' || !env?.DB) return map;
  await ensureTable(env);
  const locale = meta.locale;
  const ids = await Promise.all(strings.map(hashOf));
  const have = new Map();
  // D1 binds up to ~100 params comfortably; page the lookup.
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    const { results } = await env.DB.prepare(
      `SELECT entity_id, text, status FROM num_translations
        WHERE entity_type = 'locale_string' AND field = 'text' AND locale = ?1
          AND status IN ('machine','approved','needs_review','hybrid') AND entity_id IN (${slice.map((_, n) => `?${n + 2}`).join(',')})`,
    ).bind(locale, ...slice).all();
    for (const r of results ?? []) have.set(r.entity_id, r);
  }
  const missing = [];
  strings.forEach((s, n) => {
    const row = have.get(ids[n]);
    if (row) map[s] = row.text;
    else missing.push([s, ids[n]]);
  });

  // Translate what is new, a few at a time, and remember it.
  const now = Date.now();
  let cursor = 0;
  const rows = [];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, async () => {
    while (cursor < missing.length) {
      const [s, id] = missing[cursor++];
      const t = await translateOne(env, s, lang);
      if (!t) continue;
      map[s] = t;
      rows.push([`ls_${locale}_${id}`, id, locale, t, id, now]);
    }
  }));
  for (const r of rows) {
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO num_translations
           (id, entity_type, entity_id, field, locale, text, source, engine, source_locale, source_hash, status, created_at, updated_at)
         VALUES (?1, 'locale_string', ?2, 'text', ?3, ?4, 'machine', ?5, 'en', ?6, 'machine', ?7, ?7)`,
      ).bind(r[0], r[1], r[2], r[3], ENGINE, r[4], r[5]).run();
    } catch (err) { console.warn('[i18n] save failed', err?.message ?? err); }
  }
  return map;
}

/** POST /api/i18n {lang, strings[]} → {ok, lang, dir, map}. GET /api/i18n → the languages. */
export async function handleI18n(request, env) {
  if (request.method === 'GET') {
    return json({ ok: true, langs: Object.fromEntries(Object.entries(APP_LANGS).map(([k, v]) => [k, { name: v.name, dir: v.dir }])) });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'POST' }, 405);
  const body = await request.json().catch(() => ({}));
  const lang = String(body?.lang ?? '').toLowerCase().slice(0, 2);
  if (!APP_LANGS[lang]) return json({ ok: false, error: 'unknown language' }, 400);
  const strings = Array.isArray(body?.strings)
    ? [...new Set(body.strings.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= 600))].slice(0, MAX_STRINGS)
    : [];
  if (lang === 'en') return json({ ok: true, lang, dir: 'ltr', map: {} });
  const map = await bundleFor(env, lang, strings);
  return json({ ok: true, lang, dir: APP_LANGS[lang].dir, map, translated: Object.keys(map).length, asked: strings.length });
}
