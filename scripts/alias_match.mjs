#!/usr/bin/env node
/**
 * NUM · pull the OTHER names out of the research notes, so they can match.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * scripts/load_editorial.mjs matches an editorial row to a directory row on
 * an exact folded name, and that will not change. The Bangkok park research
 * showed why in one query: the directory holds twenty "Lumpini …" rows and
 * every one of them is a condominium. Anything looser attaches a flagship
 * park designation to a block of flats.
 *
 * It also showed the cost: 4 of 24 Bangkok outdoor rows matched, because the
 * research says "Lumphini Park" and the directory says "Lumpini Park".
 *
 * The researchers already wrote the alternatives down — Thai script, the
 * BMA's own romanisation, the name locals use — in the free-text `note`,
 * where nothing could use them. This lifts them into a column, and each one
 * is then matched by the SAME exact equality. More names, not looser rules.
 *
 * Usage:
 *   node scripts/alias_match.mjs --print          # what it would extract
 *   node scripts/alias_match.mjs --sql            # UPDATEs to run
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SQL_FOLD, fold } from './load_editorial.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * The alternatives inside one note.
 *
 * Deliberately narrow. It reads the two shapes the research actually used and
 * nothing else, because a greedy parser here invents names, and an invented
 * name is a wrong match with extra steps:
 *
 *   "Thai สวนลุมพินี."                        -> the script after "Thai "
 *   "Also listed as 'X', 'Y'"  /  "also 'Z'"  -> every quoted run after "also"
 *   "BMA spells it 'X'"                       -> the same, after "spells it"
 *
 * A quoted phrase that is a SENTENCE rather than a name is dropped: names do
 * not contain a full stop followed by a space, and "do not confuse with …"
 * is guidance, not an alias.
 */
/**
 * Is this a NAME, or is it wreckage?
 *
 * A quoted name containing an apostrophe cannot be parsed out of prose that
 * uses apostrophes as its quote marks: "spells it 'Hotel Barriere Fouquet's
 * New York'" shreds into "Hotel Barriere Fouquet", "; the property also
 * appears as" and "s New York". The first of those would match nothing; the
 * middle one is a sentence fragment; and the day one of them DOES match
 * something is the day a Michelin Key lands on the wrong building.
 *
 * So the bar is deliberately mean, and it rejects in the safe direction: a
 * dropped alias is a miss, and a miss is what this whole loader prefers.
 */
export function isName(v) {
  const s = String(v ?? '').trim();
  if (s.length < 2 || s.length > 60) return false;
  if (/[;:]/.test(s)) return false;                 // clause wreckage
  if (/\.\s/.test(s)) return false;                  // a sentence
  if (/^[a-z]/.test(s)) return false;               // names start capitalised
  if (/^(the|a|an|and|or|also)$/i.test(s)) return false;
  // "s New York", "the property also appears as" -- the two shapes the
  // apostrophe break actually produced, and anything like them.
  if (/^\S{1,2}\s/.test(s) && !/^(St|Mt|Dr|Ft|El|La|Le|Il|De|Da)\b/.test(s)) return false;
  if (/\b(appears|listed|spelled|spells|known|confuse|distinct|formerly)\b/i.test(s)) return false;
  // A BARE COMMON NOUN IS NOT A NAME. "Queen's Park" loses its tail to the
  // same apostrophe break and arrives here as "Queen" -- which is short,
  // capitalised, and passes everything above. One word like that will
  // eventually match some bar called Queen, and a park's designation will
  // land on it. Multi-word aliases and invented-looking single words
  // ("Wachirabenjatat") are fine; these are not.
  if (!/\s/.test(s) && /^(queen|king|prince|princess|royal|park|beach|garden|bridge|island|forest|lake|city|central|the)$/i.test(s)) return false;
  return true;
}

export function aliasesFrom(note) {
  const s = String(note ?? '');
  if (!s.trim()) return [];
  const out = [];

  // Thai (or any non-Latin) name, introduced by "Thai ". Ends at the full
  // stop that closes the clause, which in these notes is always ASCII.
  const thai = s.match(/\bThai\s+([^.;]+)/);
  if (thai) {
    const t = thai[1].trim();
    if (t && /[^\x00-\x7F]/.test(t)) out.push(t);
  }

  // Quoted alternatives, but only from the clauses that introduce one.
  for (const m of s.matchAll(/(?:(?:also|better|commonly|widely|locally|usually|still|often)(?:\s+\w+){0,2}?\s+(?:listed|known|written|spelled|called)(?:\s+as)?|also|spells it|listed by the county as)\s*([^.]*)/gi)) {
    for (const q of String(m[1]).matchAll(/['‘’"“”]([^'‘’"“”]{2,60})['‘’"“”]/g)) {
      const v = q[1].trim();
      if (!isName(v)) continue;
      out.push(v);
    }
  }

  // Unique on the folded form WHERE THERE IS ONE. fold() keeps only [a-z0-9],
  // so every Thai name folds to the empty string — and the first version of
  // this dropped all of them as "empty", throwing away the single most useful
  // alias in the Bangkok set. Non-Latin names de-duplicate on themselves.
  // They are matched raw (see matchSql), so nothing downstream needs a fold.
  const seen = new Set();
  return out.filter((v) => {
    const f = fold(v) || v.trim().toLowerCase();
    if (!f || seen.has(f)) return false;
    seen.add(f);
    return true;
  });
}

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/** One UPDATE per row that has aliases, keyed on the row's own id. */
/**
 * A single word off the front of the real name is a TRUNCATION, not an alias.
 *
 * LA County lists its beaches by short form -- "Listed by the county as
 * 'Zuma'" -- and the same apostrophe break that produced "Queen" produced
 * "Mother" from "Mother's Beach". Every one of those is a bare word that is
 * also a Los Angeles neighbourhood: Venice, Manhattan, Topanga, Torrance,
 * Redondo, Hermosa. Exact-matching "Venice" in LA will one day find a bar
 * called Venice and hand it a county beach designation.
 *
 * Multi-word prefixes are kept -- "Point Dume", "Nicholas Canyon", "Hotel
 * Barriere Fouquet" are distinctive enough that an exact match is the place.
 * What is dangerous is the one word that has had its disambiguating noun
 * removed.
 */
export function isTruncation(alias, primary) {
  const a = fold(alias), p = fold(primary);
  if (!a || !p) return false;
  if (a.includes(' ')) return false;            // multi-word: distinctive enough
  // EQUALITY IS NOT TRUNCATION. fold() strips accents and punctuation, so an
  // alias that folds to the same thing as the name IS the accent variant --
  // 'Mirate' for 'Mírate' -- and that is the most useful alias there is,
  // because SQLite cannot fold accents and the primary match therefore
  // cannot find it. Dropping it would undo the one gap the fold admits to.
  if (p === a) return false;
  // The possessive has already lost its apostrophe to fold(), so
  // "Mother's Beach" is "mothers beach" and the truncation "Mother" is not a
  // clean prefix of it. Allow the stray 's'.
  return p.startsWith(a + ' ') || p.startsWith(a + 's ');
}

export function updatesFor(seed) {
  const out = [];
  for (const r of seed.rows) {
    const a = aliasesFrom(r.note).filter((v) => !isTruncation(v, r.name));
    if (!a.length) continue;
    out.push({ name: r.name, dest: r.dest, aliases: a });
  }
  return out;
}

/**
 * The matching UPDATE.
 *
 * Every alias is compared with SQL_FOLD on both sides — the same equality the
 * primary match uses, never a LIKE against the directory name. The list is
 * newline-delimited, so the membership test wraps both the column and the
 * candidate in newlines: without that, an alias "Rot Fai Park" would also be
 * satisfied by a stored "Rot Fai Park Extension".
 */
export function matchSql(dest) {
  const D = `'${String(dest).replace(/'/g, "''")}'`;
  return `UPDATE num_editorial SET place_id = (
  SELECT p.id FROM places p
   WHERE p.dest = ${D}
     AND instr(
           char(10) || num_editorial.aliases || char(10),
           char(10) || p.name || char(10)
         ) > 0
   LIMIT 1)
 WHERE place_id IS NULL AND dest = ${D} AND aliases IS NOT NULL AND aliases <> '';`;
}

const argv = process.argv.slice(2);
const isCli = !!process.argv[1] && process.argv[1].endsWith('alias_match.mjs');
if (isCli) {
  const files = readdirSync(join(ROOT, 'data/editorial')).filter((f) => f.endsWith('.json'));
  const rows = [];
  for (const f of files) {
    const seed = JSON.parse(readFileSync(join(ROOT, 'data/editorial', f), 'utf8'));
    rows.push(...updatesFor(seed));
  }
  if (argv.includes('--sql')) {
    for (const r of rows) {
      // char(10) rather than a literal newline inside the quotes: the value
      // IS newline-delimited, but a statement that spans lines cannot be
      // piped, grepped or pasted one at a time without being cut in half.
      const lit = r.aliases.map((a) => q(a)).join(" || char(10) || ");
      console.log(`UPDATE num_editorial SET aliases = ${lit} WHERE dest = ${q(r.dest)} AND name = ${q(r.name)};`);
    }
    for (const d of [...new Set(rows.map((r) => r.dest))]) console.log(matchSql(d));
  } else {
    for (const r of rows) console.log(`${r.dest}  ${r.name}\n    ${r.aliases.join(' | ')}`);
    console.error(`\n${rows.length} rows carry at least one alias. --sql to print the statements.`);
  }
}
void SQL_FOLD;
