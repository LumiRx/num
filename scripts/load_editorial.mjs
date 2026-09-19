#!/usr/bin/env node
/**
 * NUM · load a verified editorial seed into num_editorial.
 *
 * The seed files in data/editorial/ are the output of a research pass: what a
 * critic said, when, and which source said it. This puts them in the database
 * the ranking reads.
 *
 * Two things it does that a naive loader would not:
 *
 *   · IDEMPOTENT. Re-running the same seed must not double a venue's score.
 *     The id is derived from (dest, name, source, awarded_on, accolade) —
 *     exactly the table's UNIQUE — so a second load of the same research is a
 *     no-op rather than a duplicate. Research gets re-run; that is the point.
 *
 *     ONE EXCEPTION, AND ONLY ONE: a row that is in the database with no url
 *     gets the seed's url. Nothing else is ever overwritten — not the weight,
 *     not the accolade, not the date — so the score a venue had before a
 *     re-load is the score it has after, which is the property that matters.
 *
 *     It exists because a citation is the one field that legitimately arrives
 *     LATE. On 19 Sep 2026, 67 rows were loaded with a source name and no url,
 *     because the pages behind them were unreachable that day: Michelin's own
 *     site returns an empty document to the fetcher, the LA Times is blocked,
 *     the NYT is paywalled and the Bangkok Post geo-blocks at 451. When those
 *     pages were reached later and the rows re-verified, INSERT OR IGNORE
 *     meant the urls went into the seed file and never into the database —
 *     the version a guest is served would have stayed the uncited one for
 *     ever, and only a hand-written migration could have fixed it.
 *
 *     What NUM says out loud is "<accolade>, <year> (<source>)". The url is
 *     what makes that checkable by anyone who doubts it. It should not need a
 *     migration to arrive.
 *
 *   · IT MATCHES, LOOSELY, AND SAYS SO. A critic writes "Sühring"; the places
 *     table may hold "Suhring" or "Sühring Restaurant". Matching is done on a
 *     folded name within the destination, and anything unmatched is REPORTED
 *     rather than dropped — an unmatched accolade is still true, and the list
 *     of them is the next piece of work.
 *
 * Usage:
 *   node scripts/load_editorial.mjs --dry
 *   node scripts/load_editorial.mjs --file=data/editorial/2026-09-19.json --sql
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (n) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  return hit === undefined ? null : (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true);
};

/** Stable id from the natural key, so a re-load collides instead of duplicating. */
export function idFor(r) {
  return createHash('sha256')
    .update([r.dest, r.name, r.source, r.awarded_on, r.accolade].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * The SAME fold, written in SQLite, for the matching UPDATE below.
 *
 * These two must agree or the loader lies about its own results. They did not
 * agree: fold() stripped every non-alphanumeric, the SQL stripped only
 * hyphens, dots and apostrophes — so the seed's "The Standard Hollywood"
 * never met the places row "The Standard, Hollywood", and a hotel that shut
 * in 2021 stayed eligible to be recommended. A comma.
 *
 * SQLite has no regex and no accent folding, so this is nested replace() and
 * the divergence that remains is accents: 'Mírate' folds to 'mirate' in JS
 * and stays 'mírate' here. That is a MISS, never a wrong match, which is the
 * direction this whole loader errs in deliberately. foldsMatch() in the test
 * pins the agreement on everything else.
 */
/**
 * The substitutions, in order. One list, used to BUILD the nested replace()
 * rather than hand-written into it — the hand-written version had twelve
 * pairs and eleven replace( calls, which closes lower() early and fails at
 * the database with an arity error rather than anywhere a reader would look.
 */
export const FOLD_SUBS = Object.freeze([
  ['&', ' and '], [',', ' '], ['-', ' '], ['.', ' '], ['/', ' '],
  ["'", ''], ['\u2019', ''], ['(', ' '], [')', ' '],
  ['  ', ' '], ['  ', ' '], ['  ', ' '],
]);

export const SQL_FOLD = (col) => {
  const lit = (v) => `'${v.replace(/'/g, "''")}'`;
  let out = col;
  for (const [a, b] of FOLD_SUBS) out = `replace(${out}, ${lit(a)}, ${lit(b)})`;
  return `trim(lower(${out}))`;
};

/** The same substitutions applied in JS, so a test can check the two agree. */
export const sqlFoldInJs = (s) => {
  let v = String(s ?? '');
  for (const [a, b] of FOLD_SUBS) v = v.split(a).join(b);
  return v.toLowerCase().trim();
};

/** Fold a venue name for matching: accents, punctuation and case are noise. */
export function fold(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Apostrophes are DELETED, not spaced: "Martiny's" must fold to the same
    // thing as "Martinys", and a stray " s " token would match neither. This
    // is also what SQL_FOLD does, and the two agreeing is asserted in
    // editorialseed.test.mjs.
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

export function statementsFor(seed) {
  const out = [];
  for (const r of seed.rows) {
    out.push(
      `INSERT OR IGNORE INTO num_editorial (id, dest, place_id, name, bucket, accolade, kind, weight, source, url, awarded_on, note) VALUES (` +
      [q(idFor(r)), q(r.dest), 'NULL', q(r.name), q(r.bucket ?? null), q(r.accolade), q(r.kind),
       String(Number(r.weight)), q(r.source), q(r.url ?? null), q(r.awarded_on), q(r.note ?? null)].join(', ') +
      // OR IGNORE stays, and the upsert is on the PRIMARY KEY only. The table
      // has a second constraint -- UNIQUE (dest, name, source, awarded_on,
      // accolade) -- and an upsert clause only handles the conflict it names.
      // A row already in the database under an older id but the same natural
      // key would therefore raise instead of being skipped, and one such row
      // would abort the whole load. Verified against SQLite 3.45: without
      // OR IGNORE that case throws; with it, it is skipped exactly as before.
      `) ON CONFLICT(id) DO UPDATE SET url = excluded.url ` +
      `WHERE (num_editorial.url IS NULL OR num_editorial.url = '') AND excluded.url IS NOT NULL;`,
    );
  }
  // Match on a folded name inside the destination. Deliberately conservative:
  // an exact folded equality only. A fuzzy match that attaches a Michelin star
  // to the wrong restaurant is far worse than one that attaches it to nothing.
  out.push(
    `UPDATE num_editorial SET place_id = (
       SELECT p.id FROM places p
        WHERE p.dest = num_editorial.dest
          AND ${SQL_FOLD('p.name')} = ${SQL_FOLD('num_editorial.name')}
        LIMIT 1)
     WHERE place_id IS NULL;`,
  );
  return out;
}

const files = flag('file')
  ? [String(flag('file'))]
  : readdirSync(join(ROOT, 'data/editorial')).filter((f) => f.endsWith('.json')).map((f) => `data/editorial/${f}`);

const isCli = !!process.argv[1] && process.argv[1].endsWith('load_editorial.mjs');
if (isCli) {
  const all = [];
  for (const f of files) {
    const seed = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
    all.push(...statementsFor(seed));
    console.error(`${f}: ${seed.rows.length} rows`);
  }
  if (flag('sql')) console.log(all.join('\n'));
  else console.error(`\n${all.length} statements. Re-run with --sql to print them, then execute against num-db.`);
}
