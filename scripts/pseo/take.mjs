/**
 * The human line, and how it is stored.
 *
 * A take is the part of a set page that a machine cannot produce: which of
 * these places to send somebody to, and why. Everything else on the page —
 * the census, the coordinates, the local names, the schema — comes out of the
 * directory. The take is the reason the page deserves to exist.
 *
 * It is a markdown file per set, in scripts/pseo/takes/<dest>__<slug>.md, for
 * three reasons: a writer who is not a programmer can fill one in, it shows up
 * in a diff so it can be reviewed like any other change, and a set with no
 * file is visibly a set with no page rather than a page that quietly shipped
 * empty.
 *
 *   ---
 *   title: All 49 beaches in Phuket, mapped
 *   sub:   One sentence under the headline.
 *   know_heading: The one thing to know in monsoon season
 *   cta:   Ask NUM which beach fits today
 *   ---
 *
 *   ## picks
 *   Freedom Beach :: Reachable only by longtail — which is why it stays quiet.
 *   Karon Beach :: Three kilometres of space, for groups who want room.
 *
 *   ## know
 *   A paragraph of something actually useful and specific to this place.
 *
 *   ## faq
 *   What is the best beach in Phuket? :: It depends on the day you want…
 *
 * `picks` names must match places that are really in the set. generate.mjs
 * refuses a take that names one that is not — a writer working from memory,
 * or a take that went stale when the directory changed, is exactly the kind of
 * confidently-wrong page that costs more trust than the traffic is worth.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TAKES_DIR = fileURLToPath(new URL('./takes/', import.meta.url));

export const takePath = (dest, slug) => `${TAKES_DIR}${dest}__${slug}.md`;

/** Split "Name :: judgement" lines, keeping "::" inside the judgement intact. */
function pairs(block) {
  return (block || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('::');
      if (i < 0) return null;
      return { key: l.slice(0, i).trim(), value: l.slice(i + 2).trim() };
    })
    .filter(Boolean);
}

/**
 * Read one take. Returns null when there is no file — which is the normal
 * state for most of the queue and is not an error.
 */
export function readTake(dest, slug) {
  const path = takePath(dest, slug);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');

  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { dest, slug, path, error: 'no frontmatter block' };

  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }

  const body = m[2];
  const section = (name) => {
    // `$(?![\\s\\S])` and not `\\Z`: JavaScript has no \\Z anchor, and the literal
    // it degrades into meant the LAST section in every take file — usually the
    // faq — silently parsed as empty.
    const re = new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm');
    const s = body.match(re);
    return s ? s[1].trim() : '';
  };

  return {
    dest, slug, path,
    title: meta.title || '',
    sub: meta.sub || '',
    knowHeading: meta.know_heading || '',
    cta: meta.cta || '',
    picks: pairs(section('picks')),
    know: section('know'),
    faq: pairs(section('faq')),
    raw,
    body,
  };
}

/** Every take on disk, for the duplicate check and the queue report. */
export function allTakes() {
  if (!existsSync(TAKES_DIR)) return [];
  return readdirSync(TAKES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const [dest, slug] = f.replace(/\.md$/, '').split('__');
      return readTake(dest, slug);
    })
    .filter(Boolean);
}

/* ── the differentiation check ───────────────────────────────────────────── */

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'to', 'for', 'is',
  'it', 'on', 'at', 'with', 'that', 'this', 'you', 'your', 'from', 'but', 'not',
  'are', 'was', 'be', 'if', 'as', 'by', 'one', 'which', 'what', 'when', 'where']);

/** Content words only — so two takes are compared on what they SAY. */
export function shingles(text, n = 3) {
  const words = String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/** Jaccard overlap of two takes, 0..1. */
export function overlap(a, b) {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const s of A) if (B.has(s)) hit++;
  return hit / (A.size + B.size - hit);
}

/**
 * The guide's "30% differentiated" rule, made mechanical and inverted: two
 * takes may not share more than this much of what they say.
 *
 * It exists to catch the specific failure the guide names — "pages that only
 * swap a city name while everything else stays identical". A writer producing
 * their fortieth take is exactly the person who reaches for the last one and
 * changes the nouns, and that is a thing to catch in a build rather than in a
 * manual review that will not happen.
 */
export const MAX_OVERLAP = 0.30;

/** @returns {Array<{a:string,b:string,overlap:number}>} pairs that are too alike. */
export function tooSimilar(takes, max = MAX_OVERLAP) {
  const bad = [];
  for (let i = 0; i < takes.length; i++) {
    for (let j = i + 1; j < takes.length; j++) {
      const t = takes[i];
      const u = takes[j];
      const text = (x) => `${x.sub} ${x.know} ${x.picks.map((p) => p.value).join(' ')}`;
      const o = overlap(text(t), text(u));
      if (o > max) {
        bad.push({ a: `${t.dest}/${t.slug}`, b: `${u.dest}/${u.slug}`, overlap: Math.round(o * 100) / 100 });
      }
    }
  }
  return bad;
}
