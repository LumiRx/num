/**
 * num-console — the marketing site, with local prices and local language.
 *
 * ── WHY THIS FILE NOW EXISTS ─────────────────────────────────────────────
 *
 * num-console was an ASSETS-ONLY Worker: wrangler.jsonc named a directory
 * and no script, so Cloudflare served public/ verbatim and there was nowhere
 * to put logic. (It is also why `workers_get_worker_code` returns an empty
 * body for num-console — there is no code to get. That looked like a broken
 * API for a while. It wasn't.)
 *
 * Two things asked for on 17 Sep cannot be done by a static file:
 *
 *   1. PRICE — a plan costs ฿349 in Phuket and $9.99 in Miami, and a file
 *      on disk can only say one of those. The page now carries a MARKER and
 *      this worker substitutes the price for the country the request came
 *      from, reading worker/planprice.mjs — the same table the checkout and
 *      the Stripe webhook read. Three surfaces, one number.
 *
 *   2. LANGUAGE — 84 pages in 9 languages is 756 documents. Maintaining
 *      them as files is a permanent tax on every copy change, so they are
 *      translated here, at the edge, and cached.
 *
 * ── WHAT IS NEVER TRANSLATED, AND WHY THAT MATTERS MORE THAN IT SOUNDS ───
 *
 * NUM's Brand Book carries a red list: no invented claims, no altered rate
 * card, and prices that must never be quoted in one currency alone. A
 * machine translator does not know that. Left alone it will cheerfully turn
 * "10% of the bill" into a different number's worth of words, localise
 * "$2.00" into a currency we do not charge, translate the brand name, and
 * rewrite a legal sentence into an approximation of one.
 *
 * So translation is FENCED, not global:
 *   · anything marked translate="no" (every price marker already is)
 *   · anything that looks like money, a percentage or a plan name
 *   · the brand vocabulary in KEEP below
 *   · <script>, <style>, and every attribute except the few in ATTRS
 *
 * A fence that is too tight leaves an English word in a Thai sentence. A
 * fence that is too loose changes what NUM charges. Tight is the safe
 * failure, so the list errs that way on purpose.
 *
 * ── CACHING ──────────────────────────────────────────────────────────────
 *
 * A translated page is deterministic for (path, lang, currency), so the
 * first visitor pays for the model and everyone after reads the Cache API.
 * Without this, every request would re-translate a page and the site would
 * be slower than it has any right to be.
 */
import { currencyForRequest, priceFor, formatPrice } from './planprice.mjs';

/**
 * The languages NUM serves, chosen against its markets (Thailand and the UK
 * are deepest; the Gulf and Europe are the live front doors) rather than
 * against a list of the world's biggest languages.
 *
 * `dir` exists because Arabic is right-to-left and a translated page that
 * keeps `dir="ltr"` is unreadable in a way no amount of good translation
 * fixes.
 */
export const LANGS = Object.freeze({
  en: { name: 'English', dir: 'ltr' },
  th: { name: 'ไทย', dir: 'ltr' },
  zh: { name: '中文', dir: 'ltr' },
  ja: { name: '日本語', dir: 'ltr' },
  ko: { name: '한국어', dir: 'ltr' },
  es: { name: 'Español', dir: 'ltr' },
  fr: { name: 'Français', dir: 'ltr' },
  de: { name: 'Deutsch', dir: 'ltr' },
  ar: { name: 'العربية', dir: 'rtl' },
});
const DEFAULT_LANG = 'en';

/** Words that stay in English in every language. */
export const KEEP = Object.freeze([
  'NUM', 'Num', '5arz', 'LINE', 'WhatsApp', 'WeChat', 'Stripe', 'itsnum.com',
  'Listed', 'Small Business', 'Pro', 'Full', 'Enterprise',
]);

/** The only attributes worth translating. `alt` and `title` are read aloud. */
const ATTRS = Object.freeze(['alt', 'title', 'placeholder']);

/**
 * Does this text carry a number a customer could act on?
 *
 * Money, percentages and bare decimals are refused translation outright.
 * m2m100 will happily reformat "9.99" or turn "10%" into words, and a rate
 * card that changes when you switch language is a rate card NUM cannot
 * stand behind.
 */
const CARRIES_A_NUMBER = /[$£€฿]\s?\d|\d+\s?%|\d+\.\d{2}/;

export const isTranslatable = (t) => {
  const s = String(t ?? '');
  if (!s.trim()) return false;
  if (CARRIES_A_NUMBER.test(s)) return false;
  // A string that is ONLY a brand word has nothing to translate.
  if (KEEP.includes(s.trim())) return false;
  return /\p{L}/u.test(s);
};

/* ────────────────────────────────────────────────────────── price markers */

/**
 * `<b data-num-price="biz:small">$9.99<span>/mo</span></b>`
 *
 * The element's FIRST text node is replaced and everything else (the "/mo"
 * span) is left alone, so a marker keeps its markup. The file on disk keeps
 * the USD price as the written fallback: if this worker is ever bypassed,
 * the page still states a real, honest price rather than an empty box.
 */
class PriceRewriter {
  constructor(cur) { this.cur = cur; this.pending = null; }
  element(el) {
    const spec = el.getAttribute('data-num-price') || '';
    const [kind, tier] = spec.split(':');
    const cents = priceFor(kind, tier, this.cur);
    this.pending = cents == null ? null : formatPrice(cents, this.cur);
    this.done = false;
  }
  text(chunk) {
    if (this.pending && !this.done && chunk.text.trim()) {
      chunk.replace(this.pending);
      this.done = true;
    }
  }
}

/* ──────────────────────────────────────────────────────────── translation */

/**
 * Translate one string with Workers AI.
 *
 * Returns the ORIGINAL on any failure, deliberately. A page that shows an
 * English sentence is a page; a page that shows an error or an empty node
 * is not. Translation is an enhancement and it fails soft.
 */
async function translateOne(env, text, target) {
  if (!env.AI) return text;
  try {
    const out = await env.AI.run('@cf/meta/m2m100-1.2b', {
      text, source_lang: 'en', target_lang: target,
    });
    const t = out?.translated_text;
    return typeof t === 'string' && t.trim() ? t : text;
  } catch (err) {
    console.warn('[site] translation failed, serving English for this string', err?.message ?? err);
    return text;
  }
}

/**
 * Translate many strings with a bounded number in flight.
 *
 * Unbounded Promise.all over a page's worth of nodes opens dozens of
 * subrequests at once and trips the Workers limit; one at a time makes the
 * first view of a page take seconds. Eight is the compromise.
 */
async function translateAll(env, strings, target) {
  const out = new Array(strings.length);
  const LIMIT = 8;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(LIMIT, strings.length) }, async () => {
    while (i < strings.length) {
      const mine = i++;
      out[mine] = await translateOne(env, strings[mine], target);
    }
  }));
  return out;
}

/**
 * Collect every translatable string, translate them, then put them back.
 *
 * Two passes over the HTML rather than one, because HTMLRewriter streams and
 * a translation is asynchronous and slow: doing it inline would hold every
 * text chunk open. Pass one reads, pass two writes from a filled-in map.
 */
async function translatePage(env, html, lang) {
  const found = [];
  const seen = new Set();
  const collector = new HTMLRewriter()
    .on('[translate="no"], script, style, code, pre', {
      element(el) { el.setAttribute('data-no-tx', '1'); },
    })
    .on('*', {
      text(chunk) {
        const t = chunk.text;
        if (isTranslatable(t) && !seen.has(t.trim())) { seen.add(t.trim()); found.push(t.trim()); }
      },
    });
  await collector.transform(new Response(html)).text();

  if (!found.length) return html;
  const translated = await translateAll(env, found, lang);
  const map = new Map(found.map((k, n) => [k, translated[n]]));

  // Fenced regions are skipped by tracking depth: HTMLRewriter has no
  // "and all its descendants" selector, so the writer counts its way in and
  // out of any element that pass one marked.
  let fence = 0;
  const writer = new HTMLRewriter()
    .on('[data-no-tx], [translate="no"], script, style, code, pre', {
      element(el) {
        fence += 1;
        el.onEndTag(() => { fence -= 1; });
        el.removeAttribute('data-no-tx');
      },
    })
    .on('*', {
      element(el) {
        if (fence > 0) return;
        for (const a of ATTRS) {
          const v = el.getAttribute(a);
          if (v && map.has(v.trim())) el.setAttribute(a, map.get(v.trim()));
        }
      },
      text(chunk) {
        if (fence > 0) return;
        const key = chunk.text.trim();
        if (!key || !map.has(key)) return;
        // Whitespace around a text node is layout, not content. Replacing the
        // whole chunk would glue words to their neighbours' tags.
        chunk.replace(chunk.text.replace(key, map.get(key)));
      },
    });
  return await writer.transform(new Response(html)).text();
}

/* ───────────────────────────────────────────────────── head and switcher */

export const langHref = (path, lang) => (lang === DEFAULT_LANG ? path : `/${lang}${path}`);

/** hreflang for every language, so Google indexes nine pages, not one. */
export function headLinks(path) {
  const rows = Object.keys(LANGS).map(
    (l) => `<link rel="alternate" hreflang="${l}" href="https://itsnum.com${langHref(path, l)}">`,
  );
  rows.push(`<link rel="alternate" hreflang="x-default" href="https://itsnum.com${path}">`);
  return rows.join('');
}

/** The picker, injected at the end of every page. */
export function switcher(path, current) {
  const opts = Object.entries(LANGS).map(([code, meta]) =>
    `<option value="${langHref(path, code)}"${code === current ? ' selected' : ''}>${meta.name}</option>`).join('');
  return `<div id="num-lang" translate="no" style="position:fixed;right:14px;bottom:14px;z-index:9999">
    <select aria-label="Language" onchange="location.href=this.value"
      style="font:14px -apple-system,'Segoe UI',Inter,sans-serif;padding:7px 10px;border-radius:9px;border:1px solid #e0ddd4;background:#faf8f4;color:#131a16;box-shadow:0 2px 10px rgba(0,0,0,.08)">
      ${opts}
    </select></div>`;
}

/* ──────────────────────────────────────────────────────────────── handler */

export default {
  /**
   * `run_worker_first` means EVERY page on itsnum.com now comes through
   * here. That is what makes the rewriting possible and it is also the risk:
   * before this file, a bug could not take the marketing site down, because
   * there was no code to have a bug in.
   *
   * So the whole of it is wrapped. Anything unexpected — a bad path, a
   * translation the model mangled into a throw, a change made later by
   * someone who has not read this comment — serves the plain asset instead.
   * The worst failure is now an English page with a dollar price, which is
   * exactly what the site served yesterday. It is never a 500.
   */
  async fetch(request, env, ctx) {
    try {
      return await render(request, env, ctx);
    } catch (err) {
      console.error('[site] falling back to the unmodified asset', err?.stack ?? err);
      return env.ASSETS.fetch(request);
    }
  },
};

async function render(request, env, ctx) {
  {
    const url = new URL(request.url);

    // /th/business/pricing/ → lang "th", asset "/business/pricing/".
    // A path prefix, not a cookie or a query flag, because it is the only
    // form Google will index as a separate page — which is the whole point
    // of translating a marketing site rather than an app.
    const seg = url.pathname.split('/').filter(Boolean);
    const lang = seg.length && Object.hasOwn(LANGS, seg[0]) && seg[0] !== DEFAULT_LANG ? seg[0] : DEFAULT_LANG;
    const path = lang === DEFAULT_LANG ? url.pathname : `/${seg.slice(1).join('/')}${url.pathname.endsWith('/') ? '/' : ''}`;

    const assetUrl = new URL(url);
    assetUrl.pathname = path || '/';
    const asset = await env.ASSETS.fetch(new Request(assetUrl, request));

    const type = asset.headers.get('content-type') || '';
    if (!type.includes('text/html')) return asset;

    // Translated pages are cached per path+lang+currency. English pages are
    // still rewritten for price, which is cheap, so they skip the cache and
    // stay as fresh as the assets behind them.
    const cacheKey = new Request(`${url.origin}${url.pathname}?__tx=${lang}`, { method: 'GET' });
    const cache = caches.default;
    if (lang !== DEFAULT_LANG) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    let html = await asset.text();
    if (lang !== DEFAULT_LANG) html = await translatePage(env, html, lang);

    const cur = currencyForRequest(request, env);
    let out = new HTMLRewriter()
      .on('[data-num-price]', new PriceRewriter(cur))
      .on('html', {
        element(el) {
          el.setAttribute('lang', lang);
          el.setAttribute('dir', LANGS[lang].dir);
        },
      })
      .on('head', { element(el) { el.append(headLinks(path), { html: true }); } })
      .on('body', { element(el) { el.append(switcher(path, lang), { html: true }); } })
      .transform(new Response(html, {
        status: asset.status,
        headers: { ...Object.fromEntries(asset.headers), 'content-type': 'text/html; charset=utf-8' },
      }));

    if (lang !== DEFAULT_LANG && asset.status === 200) {
      out = new Response(out.body, out);
      out.headers.set('Cache-Control', 'public, max-age=86400');
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
    }
    return out;
  }
}
