/**
 * Is Google keeping these pages, or dropping them?
 *
 *   node scripts/pseo/indexation.mjs
 *
 * The single number that decides whether this strategy is working. Everything
 * else — traffic, rankings, conversions — is months away and noisy. Indexation
 * rate is readable in weeks and it is the direct read on the only question
 * that matters at this scale: does Google think these pages are worth having.
 *
 * The rule of thumb the industry uses is 50%. Below that, Google is telling
 * you the pages are thin, and the correct response is to STOP GENERATING and
 * fix the template — not to publish more of them faster. Above ~80%, the gate
 * is doing its job and the queue can move.
 *
 * This script does not call the Search Console API — that needs OAuth and a
 * verified property, which is a setup step for Dre rather than a thing a
 * script can do unattended. What it does is check what is actually live and
 * print the exact queries to run, so the weekly check is thirty seconds.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = HERE + '../../public/';

function liveSetPages() {
  const cat = JSON.parse(readFileSync(HERE + 'candidates.json', 'utf8'));
  return cat.rows.filter((r) => existsSync(`${PUBLIC}${r.dest}/${r.slug}/index.html`));
}

const main = () => {
  const cat = JSON.parse(readFileSync(HERE + 'candidates.json', 'utf8'));
  const live = liveSetPages();
  const takes = existsSync(HERE + 'takes')
    ? readdirSync(HERE + 'takes').filter((f) => f.endsWith('.md')).length : 0;

  console.log('NUM set guides\n');
  console.log(`  candidate sets       ${String(cat.candidates).padStart(6)}   mapped, in the band, travel intent`);
  console.log(`  takes written        ${String(takes).padStart(6)}   the throttle`);
  console.log(`  pages live           ${String(live.length).padStart(6)}   passed the gate and were written`);
  console.log(`  places covered       ${String(live.reduce((a, b) => a + b.n, 0)).padStart(6)}`);

  const bytes = live.reduce((a, r) => a + statSync(`${PUBLIC}${r.dest}/${r.slug}/index.html`).size, 0);
  if (live.length) console.log(`  median page          ${String(Math.round(bytes / live.length / 1024)).padStart(6)}kb`);

  console.log('\nweekly check — paste into Search Console, or run as a site: query:\n');
  console.log('  indexed guides   site:itsnum.com inurl:/guides/');
  for (const dest of [...new Set(live.map((r) => r.dest))].slice(0, 6)) {
    console.log(`  ${dest.padEnd(16)} site:itsnum.com/${dest}/`);
  }
  console.log('\n  Search Console → Pages → filter by sitemap "sitemap-guides.xml"');
  console.log('  indexation rate = indexed ÷ submitted. Below 50% for two weeks:');
  console.log('  stop generating and fix the template. More pages will not fix thin pages.');
};

if (process.argv[1] && process.argv[1].endsWith('indexation.mjs')) main();
export { liveSetPages };
