/**
 * Which (destination × set) pairs the directory can actually carry a page for.
 *
 *   node scripts/pseo/candidates.mjs            # rebuild candidates.json
 *   node scripts/pseo/candidates.mjs --summary  # just print the shape
 *
 * Reads production D1 through wrangler and writes scripts/pseo/candidates.json,
 * which is committed so the queue is reviewable in a diff rather than living in
 * somebody's terminal history.
 *
 * A candidate is NOT a page. It is a set that has cleared the two mechanical
 * tests — travel intent (taxonomy.mjs) and enumerability (MIN_SET..MAX_SET) —
 * and is therefore allowed to WAIT for the human line that generate.mjs
 * requires before anything ships.
 *
 * Why enumerability is the whole game: "every named beach on Phuket, with
 * coordinates" is a sentence no other page on the web can finish, because the
 * set is finite and we hold all of it. "Every restaurant in London" is 4,000
 * rows, which is not a page — it is a database dump, and it is the shape
 * Google's scaled-content-abuse policy was written about.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATEGORY_SETS, setsBySlug, MIN_SET, MAX_SET } from './taxonomy.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = HERE + 'candidates.json';

/**
 * One d1 execute, returning parsed rows.
 *
 * Retried, because D1 answers a long-running analytical query with a bare
 * `internal error; reference = …  [code: 7500]` often enough that a run over
 * the whole directory will hit one. Failing the build over a transient API
 * error would mean the candidate list only ever refreshes on a lucky day.
 */
export function d1(sql, { tries = 4 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const raw = execFileSync('npx', [
        'wrangler', 'd1', 'execute', 'num-db', '--remote', '--json', '--command', sql,
      ], { cwd: HERE + '../..', encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const start = raw.indexOf('[');
      if (start < 0) throw new Error(raw.slice(0, 400));
      return JSON.parse(raw.slice(start))[0]?.results ?? [];
    } catch (e) {
      last = e;
      const wait = 2000 * (i + 1);
      process.stderr.write(`  d1 retry ${i + 1}/${tries} in ${wait}ms\n`);
      execFileSync('sleep', [String(wait / 1000)]);
    }
  }
  throw last;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Count every destination × set pair, with the completeness numbers the page
 * template needs to know whether it can say anything beyond a name and a pin.
 */
export function buildCandidates({ query = d1 } = {}) {
  const sets = setsBySlug();

  // ONE query, not ninety-four. Each round trip to D1 is a chance at a
  // transient 7500, and a job made of ninety-four of them fails most of the
  // time by construction. The category→set mapping goes into the SQL as a
  // CASE so the grouping happens where the 2.5M rows already are.
  const cases = Object.entries(CATEGORY_SETS)
    .map(([cat, spec]) => `WHEN ${q(cat)} THEN ${q(spec.slug)}`).join('\n           ');
  const inList = Object.keys(CATEGORY_SETS).map(q).join(',');

  const found = query(`
    SELECT dest,
           CASE category
           ${cases}
           END AS slug,
           COUNT(*) AS n,
           SUM(CASE WHEN name_local IS NOT NULL AND name_local <> '' THEN 1 ELSE 0 END) AS local_names,
           SUM(CASE WHEN website IS NOT NULL AND website <> '' THEN 1 ELSE 0 END) AS websites,
           SUM(CASE WHEN hours_mask IS NOT NULL THEN 1 ELSE 0 END) AS hours,
           SUM(CASE WHEN area IS NOT NULL AND area <> '' THEN 1 ELSE 0 END) AS areas,
           COUNT(DISTINCT area) AS distinct_areas,
           SUM(CASE WHEN lat IS NOT NULL AND lng IS NOT NULL THEN 1 ELSE 0 END) AS coords
      FROM places
     WHERE category IN (${inList})
     GROUP BY dest, slug
    HAVING n BETWEEN ${MIN_SET} AND ${MAX_SET}`);

  const rows = found.map((r) => {
    const spec = sets.get(r.slug);
    return {
      dest: r.dest,
      slug: r.slug,
      title: spec.title,
      note: spec.note,
      categories: spec.categories,
      n: r.n,
      local_names: r.local_names,
      websites: r.websites,
      hours: r.hours,
      areas: r.areas,
      distinct_areas: r.distinct_areas,
      coords: r.coords,
      path: `/${r.dest}/${r.slug}/`,
    };
  });

  rows.sort((a, b) => (a.dest === b.dest ? b.n - a.n : a.dest.localeCompare(b.dest)));
  return rows;
}

/**
 * A candidate is only worth a writer's attention if the page could say
 * something. Coordinates on every row is the floor — that is what makes the
 * map real — and a set where we hold nothing else at all is a set where the
 * human line has to carry the entire page alone.
 */
export function rank(c) {
  const extras = (c.local_names + c.websites + c.hours) / Math.max(1, c.n * 3);
  const size = c.n >= 15 && c.n <= 80 ? 1 : 0.6;   // the comfortable page length
  return Math.round((extras * 0.6 + size * 0.4) * 100);
}

function main() {
  const rows = buildCandidates().map((c) => ({ ...c, score: rank(c) }));
  const byDest = new Map();
  for (const r of rows) byDest.set(r.dest, (byDest.get(r.dest) ?? 0) + 1);

  writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    min_set: MIN_SET,
    max_set: MAX_SET,
    sets_defined: setsBySlug().size,
    categories_mapped: Object.keys(CATEGORY_SETS).length,
    candidates: rows.length,
    destinations: byDest.size,
    rows,
  }, null, 2) + '\n');

  console.log(`${rows.length} candidate sets across ${byDest.size} destinations`);
  console.log(`written to ${OUT}`);
  const top = [...rows].sort((a, b) => b.score - a.score).slice(0, 15);
  console.log('\nbest-equipped sets (most to say beyond a name and a pin):');
  for (const t of top) {
    console.log(`  ${String(t.score).padStart(3)}  ${t.path.padEnd(34)} ${String(t.n).padStart(4)} places  ` +
      `${t.local_names} local names, ${t.websites} sites, ${t.hours} hours`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('candidates.mjs')) main();

export const loadCandidates = () => JSON.parse(readFileSync(OUT, 'utf8'));
