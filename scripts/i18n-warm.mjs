// Warm the translation store: ask /api/i18n for the whole catalogue in every
// language NUM speaks, and keep asking until each one is complete, so no
// phone ever pays the first translation. Usage: node scripts/i18n-warm.mjs <base> [lang,lang]
import { readFileSync } from 'node:fs';

const [base, only, sliceArg] = process.argv.slice(2);
if (!base) { console.error('usage: node scripts/i18n-warm.mjs <base> [th,ja] [slice=120]'); process.exit(2); }
// --slice: send the catalogue in stretches of N, one after another. A whole
// catalogue in one request is the fast path once a language is mostly stored;
// a language nobody has asked for yet (Mongolian, 19 Sep) does better in
// stretches the model finishes in under a minute each.
const slice = sliceArg?.startsWith('slice=') ? Number(sliceArg.slice(6)) : 0;
const src = readFileSync(new URL('../src/i18n/catalog.ts', import.meta.url), 'utf8');
const cat = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
const langs = only ? only.split(',') : ['th', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'ar', 'mn'];

async function ask(lang, strings = cat.strings) {
  const t0 = Date.now();
  const r = await fetch(base + '/api/i18n', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lang, strings }) });
  const b = await r.json().catch(() => ({}));
  return { status: r.status, asked: b.asked ?? 0, translated: b.translated ?? 0, secs: ((Date.now() - t0) / 1000).toFixed(0) };
}

await Promise.all(langs.map(async (lang) => {
  if (slice) {
    let done = 0;
    for (let i = 0; i < cat.strings.length; i += slice) {
      const r = await ask(lang, cat.strings.slice(i, i + slice));
      done += r.translated;
      console.log(`${lang} ${i}-${Math.min(i + slice, cat.strings.length)}: ${r.translated}/${r.asked} (${r.secs}s) · ${done} so far`);
    }
    return;
  }
  for (let round = 1; round <= 12; round++) {
    const r = await ask(lang);
    console.log(`${lang} round ${round}: ${r.translated}/${r.asked} (${r.secs}s)`);
    if (r.status !== 200 || r.translated >= r.asked - 5) break;
    await new Promise((res) => setTimeout(res, 15_000));
  }
}));
