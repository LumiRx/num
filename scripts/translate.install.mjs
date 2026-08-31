#!/usr/bin/env node
/**
 * Put the language picker on every public page.
 *
 * ── WHAT WAS ACTUALLY WRONG ──────────────────────────────────────────────
 *
 * The Google Translate widget was already installed — on 4 of 48 pages:
 * the homepage, referral, privacy and terms. Every page a non-English
 * speaker would actually need was missing it: faq, about, contact, business,
 * destinations, list-your-business, sms, join, and all twelve agent pages.
 *
 * And where it was installed it carried `includedLanguages` with sixteen
 * entries, so a reader in Portuguese, Polish, Turkish, Indonesian, Bengali,
 * Swahili or Tagalog was offered nothing at all. Dropping that one parameter
 * gives every language Google supports, which is the ask.
 *
 * ── THE HONEST CAVEAT, KEPT NEXT TO THE CODE ─────────────────────────────
 *
 * Google discontinued this widget for new sites. Existing embeds still serve
 * — verified 30 Aug 2026, element.js returns HTTP 200 — but it is a
 * dependency that can be withdrawn without notice, and when it goes it will
 * go silently.
 *
 * So the durable half is `<html lang="en">`, which every page already has.
 * That is what lets Chrome, Safari and Edge offer their own translation,
 * needs no third party, cannot be discontinued, and already reaches more
 * readers than the widget does. The widget is the visible convenience on top.
 *
 * Idempotent: a page that already has it is left alone except for widening
 * the language list.
 *
 *   node scripts/translate.install.mjs --dry
 *   node scripts/translate.install.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry');
const ROOT = 'public';

/** The picker, as one block. No `includedLanguages` — that is the point. */
export const WIDGET = `<div id="gtx" class="gtx"></div>
<script>function gtInit(){try{new google.translate.TranslateElement({pageLanguage:'en',layout:google.translate.TranslateElement.InlineLayout.SIMPLE},'gtx')}catch(e){}}</script>
<script src="https://translate.google.com/translate_a/element.js?cb=gtInit" defer></script>`;

/** Matches the homepage's existing pill so the picker looks the same everywhere. */
export const STYLE = `<style>.gtx{position:fixed;right:14px;bottom:14px;z-index:9999;background:rgba(255,255,255,.92);border:1.5px solid #DDE0FB;border-radius:999px;padding:7px 14px;box-shadow:0 10px 30px rgba(76,81,161,.20);backdrop-filter:blur(10px);font-size:13px}
@media (prefers-color-scheme:dark){.gtx{background:rgba(26,29,34,.92);border-color:#2B2F36}}
.gtx .goog-te-gadget{font-size:0}.gtx .goog-te-combo{font:inherit;border:0;background:transparent;color:inherit}
body{top:0!important}.skiptranslate iframe{display:none!important}</style>`;

export function listHtml(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) listHtml(p, out);
    else if (entry.endsWith('.html')) out.push(p);
  }
  return out;
}

/**
 * @returns {{changed:boolean, why:string, html:string}}
 */
export function apply(html) {
  const hasScript = html.includes('translate_a/element.js');

  // Widen an existing install rather than duplicating it.
  if (hasScript) {
    if (!/includedLanguages/.test(html)) return { changed: false, why: 'already every language', html };
    const widened = html.replace(/includedLanguages:'[^']*',?/g, '');
    return { changed: true, why: 'widened to every language', html: widened };
  }

  if (!/<\/body>/i.test(html)) return { changed: false, why: 'no </body> to anchor to', html };

  // Style into <head> when there is one, so the pill is not restyled per page.
  let out = html;
  if (/<\/head>/i.test(out) && !out.includes('.gtx{position:fixed')) {
    out = out.replace(/<\/head>/i, `${STYLE}\n</head>`);
  }
  out = out.replace(/<\/body>/i, `${WIDGET}\n</body>`);
  return { changed: true, why: 'installed', html: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = listHtml(ROOT);
  let installed = 0;
  let widened = 0;
  let skipped = 0;
  for (const f of files) {
    const before = readFileSync(f, 'utf8');
    const r = apply(before);
    if (!r.changed) { skipped += 1; continue; }
    if (r.why === 'installed') installed += 1; else widened += 1;
    if (!DRY) writeFileSync(f, r.html);
    console.log(`  ${r.why.padEnd(28)} ${f}`);
  }
  console.log(`\n${DRY ? 'DRY RUN — ' : ''}${installed} installed, ${widened} widened, ${skipped} untouched, ${files.length} pages total`);
  if (DRY) console.log('Re-run without --dry to write.');
}
