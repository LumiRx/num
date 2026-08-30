/**
 * Keep the numbers an AI reads about NUM true, and keep them agreeing.
 *
 *   node scripts/pseo/aifacts.mjs --check   # report drift, change nothing
 *   node scripts/pseo/aifacts.mjs           # fix it
 *
 * ── why this exists
 *
 * On 29 Aug 2026 the three surfaces written for machines disagreed with each
 * other and with the database:
 *
 *   /for-ai/     "more than 500,000 places"     dated 31 July
 *   /llms.txt    "2,529,721 places"             dated 8 Aug
 *   the database  2,529,721
 *
 * A five-fold contradiction between two pages on the same site, both of which
 * exist specifically to be quoted. Every framework for being cited by an
 * answer engine has a version of the same rule — the CITABLE guide calls it
 * "Latest & consistent" — and the reason is mechanical rather than stylistic:
 * a model that retrieves both pages has no way to choose, so it either picks
 * the smaller number, hedges, or drops the claim. NUM's coverage is the single
 * most quotable thing about it, and it was being quoted five times too small.
 *
 * Numbers written by hand go stale. These are read from D1 and written back
 * into every surface at once, so the next time coverage changes there is one
 * command rather than four files and a memory.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1 } from './candidates.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Everything a machine-readable surface is allowed to assert, from source. */
export function liveFacts({ query = d1 } = {}) {
  const [row] = query(`SELECT
      (SELECT COUNT(*) FROM places) AS places,
      (SELECT COUNT(DISTINCT dest) FROM places) AS destinations,
      (SELECT COUNT(DISTINCT country) FROM destinations) AS countries,
      (SELECT COUNT(*) FROM places WHERE dest='phuket' AND category='Beach') AS phuket_beaches`);
  return {
    ...row,
    placesText: Number(row.places).toLocaleString('en-GB'),
    today: new Date().toISOString().slice(0, 10),
  };
}

/**
 * Every place a count is written down, as a regex and a replacement.
 *
 * Deliberately explicit rather than a blanket number-substitution: a script
 * that rewrites every digit it finds in four public files is a worse problem
 * than the drift it fixes.
 */
export function edits(f) {
  return [
    // /for-ai/ — the five-fold understatement, and its two dates.
    { file: 'public/for-ai/index.html',
      find: /more than 500,000 places in the/g,
      to: `${f.placesText} places in the` },
    { file: 'public/for-ai/index.html',
      find: /is current as of 31 July 2026/g,
      to: `is current as of ${f.today}` },
    { file: 'public/for-ai/index.html',
      find: /"datePublished":"2026-07-31","dateModified":"2026-07-31"/g,
      to: `"datePublished":"2026-07-31","dateModified":"${f.today}"` },
    // llms.txt — the stated date and the beach count that moved.
    { file: 'public/llms.txt',
      find: /Facts, as of \d{4}-\d{2}-\d{2}:/g,
      to: `Facts, as of ${f.today}:` },
    { file: 'public/llms.txt',
      find: /every named beach on Phuket \(\d+, mapped/g,
      to: `every named beach on Phuket (${f.phuket_beaches}, mapped` },
    { file: 'public/llms.txt',
      find: /- Coverage: [\d,]+ places, \d+ destinations, \d+ countries\./g,
      to: `- Coverage: ${f.placesText} places, ${f.destinations} destinations, ${f.countries} countries.` },
    { file: 'public/llms.txt',
      find: /> [\d,]+ places in \d+ destinations across \d+ countries\./g,
      to: `> ${f.placesText} places in ${f.destinations} destinations across ${f.countries} countries.` },
  ];
}

function main() {
  const check = process.argv.includes('--check');
  const f = liveFacts();
  console.log(`live: ${f.placesText} places · ${f.destinations} destinations · ` +
    `${f.countries} countries · ${f.phuket_beaches} Phuket beaches\n`);

  const touched = new Map();
  let drift = 0;
  for (const e of edits(f)) {
    const path = ROOT + e.file;
    const before = touched.get(e.file) ?? readFileSync(path, 'utf8');
    const after = before.replace(e.find, e.to);
    if (after !== before) {
      drift++;
      console.log(`  ${check ? 'DRIFT' : 'fixed'}  ${e.file}  →  ${e.to.slice(0, 72)}`);
    }
    touched.set(e.file, after);
  }
  if (!drift) { console.log('  every machine-readable surface already agrees with the database'); return; }
  if (check) { process.exitCode = 1; return; }
  for (const [file, text] of touched) writeFileSync(ROOT + file, text);
  console.log(`\n${drift} correction(s) written across ${touched.size} files`);
}

if (process.argv[1] && process.argv[1].endsWith('aifacts.mjs')) main();
