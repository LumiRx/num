/**
 * Build the set pages that are allowed to exist.
 *
 *   node scripts/pseo/generate.mjs            # build every set that has a take
 *   node scripts/pseo/generate.mjs --queue    # what is waiting for a writer
 *   node scripts/pseo/generate.mjs --check    # gate only, write nothing
 *
 * There are 2,906 candidate sets across all 77 destinations. This script will
 * build every one of them — and it will build none of them until somebody
 * writes the line. That is the whole design: the machinery scales to the full
 * directory, and the throttle is a person having something to say.
 *
 * ── THE GATE
 *
 * Seven checks, and every one of them exists because of a specific way this
 * kind of page goes wrong:
 *
 *   1. ON THE CANDIDATE LIST     — travel intent and enumerability, decided in
 *                                  taxonomy.mjs and candidates.mjs.
 *   2. A TAKE EXISTS             — no human line, no page. Not a warning.
 *   3. PICKS ARE REAL PLACES     — every name in the take must be a place the
 *                                  directory actually holds in that set. A
 *                                  writer working from memory, or a take that
 *                                  went stale when the data moved, produces a
 *                                  page that is confidently wrong, which costs
 *                                  more trust than the traffic is worth.
 *   4. ENOUGH PICKS              — three, or the page is a list with a caption.
 *   5. THE KNOW SECTION IS REAL  — 200 characters of something specific. This
 *                                  is the section that cannot be templated and
 *                                  the first one a tired writer will pad.
 *   6. NOT A NEAR-DUPLICATE      — no two takes may share more than 30% of
 *                                  what they say. This is the mechanical form
 *                                  of "pages that only swap a city name",
 *                                  which is the exact failure Google's
 *                                  scaled-content-abuse policy describes.
 *   7. THREE INTERNAL LINKS      — a page nothing links to and which links
 *                                  nowhere is a doorway, whatever is on it.
 *
 * A set that fails any of these is REPORTED, not silently skipped, and no file
 * is written for it. There is no --force.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1 } from './candidates.mjs';
import { readTake, allTakes, tooSimilar, MAX_OVERLAP } from './take.mjs';
import { renderSet } from './template.mjs';
import { hubPage, guidesSitemap, sitemapIndex } from './hub.mjs';
import { readFileSync } from 'node:fs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = HERE + '../../';
const PUBLIC = ROOT + 'public/';

export const MIN_PICKS = 3;
export const MIN_KNOW = 200;
export const MIN_LINKS = 3;

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Sibling sets in the same destination — the hub-and-spoke links. */
export function relatedFor(candidate, all, built, limit = 6) {
  return all
    .filter((c) => c.dest === candidate.dest && c.slug !== candidate.slug && built.has(c.path))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

/**
 * Run the gate over one set.
 * @returns {{ok:boolean, reasons:string[], take:object|null}}
 */
export function gate(candidate, { places, take, dupes, linkCount }) {
  const reasons = [];
  if (!take) return { ok: false, reasons: ['no take written'], take: null };
  if (take.error) return { ok: false, reasons: [`take unreadable: ${take.error}`], take };

  const names = new Set(places.map((p) => p.name));
  const ghosts = take.picks.filter((p) => !names.has(p.key)).map((p) => p.key);
  if (ghosts.length) {
    reasons.push(`names ${ghosts.length} place(s) not in the directory for this set: ${ghosts.join(', ')}`);
  }

  const realPicks = take.picks.filter((p) => names.has(p.key));
  if (realPicks.length < MIN_PICKS) {
    reasons.push(`${realPicks.length} usable picks, needs ${MIN_PICKS}`);
  }
  if (!take.sub || take.sub.length < 40) reasons.push('sub is missing or too short');
  if ((take.know || '').length < MIN_KNOW) {
    reasons.push(`know section is ${(take.know || '').length} chars, needs ${MIN_KNOW}`);
  }
  if (dupes.length) {
    reasons.push(`reads too much like ${dupes.map((d) => d.b || d.a).join(', ')} (>${MAX_OVERLAP * 100}% overlap)`);
  }
  if (linkCount < MIN_LINKS) {
    reasons.push(`${linkCount} internal links, needs ${MIN_LINKS} — a page that links nowhere is a doorway`);
  }
  return { ok: reasons.length === 0, reasons, take };
}

/** Every place in one set, straight from the directory. */
export function placesFor(candidate, { query = d1 } = {}) {
  const cats = candidate.categories.map(q).join(',');
  return query(`SELECT id, name, name_local, lat, lng, area, website
                  FROM places
                 WHERE dest = ${q(candidate.dest)} AND category IN (${cats})
                   AND lat IS NOT NULL AND lng IS NOT NULL
                 ORDER BY name`);
}

function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const queueOnly = argv.includes('--queue');
  const only = (argv.find((a) => a.startsWith('--only=')) || '').slice(7);

  const cat = JSON.parse(readFileSync(HERE + 'candidates.json', 'utf8'));
  const dests = new Map(d1('SELECT slug, name, country FROM destinations').map((d) => [d.slug, d]));
  const takes = allTakes();
  const takeKeys = new Set(takes.map((t) => `${t.dest}/${t.slug}`));

  if (queueOnly) {
    const withTake = cat.rows.filter((c) => takeKeys.has(`${c.dest}/${c.slug}`));
    console.log(`${cat.rows.length} candidate sets · ${withTake.length} have a take · ` +
      `${cat.rows.length - withTake.length} waiting for a writer\n`);
    const byDest = new Map();
    for (const c of cat.rows) {
      if (takeKeys.has(`${c.dest}/${c.slug}`)) continue;
      byDest.set(c.dest, (byDest.get(c.dest) ?? 0) + 1);
    }
    console.log('best-equipped sets still waiting:');
    for (const c of [...cat.rows]
      .filter((x) => !takeKeys.has(`${x.dest}/${x.slug}`))
      .sort((a, b) => b.score - a.score).slice(0, 25)) {
      console.log(`  ${c.path.padEnd(34)} ${String(c.n).padStart(4)} places   ${c.note}`);
    }
    return;
  }

  // The duplicate check is global: it is the one rule that cannot be decided
  // by looking at a single page.
  const dupePairs = tooSimilar(takes);

  const wanted = cat.rows.filter((c) => takeKeys.has(`${c.dest}/${c.slug}`))
    .filter((c) => !only || c.path.includes(only));

  const passed = [];
  const failed = [];
  const today = new Date().toISOString().slice(0, 10);

  // Two passes: decide what passes, then render — so "Also in <city>" can only
  // ever link to a page that actually got built.
  const staged = [];
  for (const c of wanted) {
    const take = readTake(c.dest, c.slug);
    const places = placesFor(c);
    const dupes = dupePairs.filter((d) => d.a === `${c.dest}/${c.slug}` || d.b === `${c.dest}/${c.slug}`);
    staged.push({ c, take, places, dupes });
  }
  const willBuild = new Set(staged.map((s) => s.c.path));

  for (const s of staged) {
    const related = relatedFor(s.c, cat.rows, willBuild);
    const linkCount = related.length + 3;  // + nav, destinations, how-it-works
    const g = gate(s.c, { places: s.places, take: s.take, dupes: s.dupes, linkCount });
    if (!g.ok) { failed.push({ path: s.c.path, reasons: g.reasons }); continue; }

    const dest = dests.get(s.c.dest) ?? { slug: s.c.dest, name: s.c.dest, country: '' };
    const html = renderSet({ dest, set: s.c, take: s.take, places: s.places, related, today });

    if (!checkOnly) {
      const dir = PUBLIC + s.c.dest + '/' + s.c.slug;
      mkdirSync(dir, { recursive: true });
      writeFileSync(dir + '/index.html', html);
    }
    passed.push({
      path: s.c.path, dest: s.c.dest, slug: s.c.slug, title: s.c.title,
      places: s.places.length, bytes: html.length,
    });
  }

  // The hub and the sitemaps are written from what actually BUILT, never from
  // the candidate list. A sitemap that lists a page the gate refused is a
  // stream of 404s handed straight to Google at exactly the scale this
  // generator runs at.
  if (!checkOnly && !only) {
    mkdirSync(PUBLIC + 'guides', { recursive: true });
    writeFileSync(PUBLIC + 'guides/index.html', hubPage(passed, cat.rows.length, dests, today));
    writeFileSync(PUBLIC + 'sitemap-guides.xml', guidesSitemap(passed, today));
    writeFileSync(PUBLIC + 'sitemap_index.xml', sitemapIndex(today));
    console.log(`  hub      /guides/  ${passed.length} guides`);
    console.log(`  sitemap  /sitemap-guides.xml, /sitemap_index.xml`);
  }

  console.log(`${cat.rows.length} candidates · ${wanted.length} with a take · ` +
    `${passed.length} ${checkOnly ? 'would build' : 'built'} · ${failed.length} refused\n`);
  for (const p of passed) console.log(`  built    ${p.path.padEnd(34)} ${p.places} places, ${(p.bytes / 1024).toFixed(0)}kb`);
  for (const f of failed) {
    console.log(`  REFUSED  ${f.path}`);
    for (const r of f.reasons) console.log(`             ${r}`);
  }
  if (failed.length && !checkOnly) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('generate.mjs')) main();
