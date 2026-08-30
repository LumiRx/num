#!/usr/bin/env node
/**
 * TRAVEL-SPEAK LINT — layer one of two. This one BLOCKS.
 *
 * Runs worker/travelspeak.mjs over the STRING LITERALS of the files that
 * teach or show travel language: the persona and prompt files the model reads
 * on every turn, and the UI copy a traveller reads on the screen. A hit exits
 * non-zero, which fails `npm test`, which fails the build.
 *
 * ── WHY ONLY STRING LITERALS ─────────────────────────────────────────────
 *
 * Comments never reach a user, and this codebase comments heavily and
 * honestly — worker/booking.mjs alone explains at length why it does NOT book
 * anything, using the word "book" eleven times to say so. Linting comments
 * would produce a wall of noise that gets the whole rule switched off inside a
 * week, which is the real failure mode of a compliance lint.
 *
 * ── WHY A HARD FAIL HERE AND A REWRITE AT RUNTIME ────────────────────────
 *
 * Static copy is written once by a person who is there to fix it. A false
 * positive costs thirty seconds and an allowlist entry. Generated prose is
 * written by a model in front of a waiting guest, where a false positive costs
 * that guest their answer — so the runtime layer rewrites instead. Same rules,
 * opposite failure modes, on purpose.
 *
 * ── ADDING A TRAVEL SURFACE ──────────────────────────────────────────────
 *
 * Add the file to LINTED below. If you are adding a surface and NOT adding it
 * here, you are adding an unlinted place for the model or a designer to say
 * "booked".
 *
 * Usage:  node scripts/travelspeak-lint.mjs [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../worker/travelspeak.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file whose strings a traveller or the model can end up reading. */
export const LINTED = [
  // The model's own instructions — the highest-leverage place to get it wrong.
  'worker/prompt.mjs',
  'worker/services.mjs',
  'worker/specialists.mjs',
  'worker/router.mjs',
  'worker/lastresort.mjs',
  'worker/grounding.mjs',
  'worker/brains.mjs',
  // Membership copy: a paid tier must not advertise travel access (§17550.27).
  'worker/membership.mjs',
  'src/components/app/MembershipCard.tsx',
  // The travel surfaces themselves.
  'src/components/app/ThreadView.tsx',
  'src/lib/flights.ts',
  'src/lib/services.ts',
  'src/components/app/PassengerSheet.tsx',
];

/**
 * Pull the string literals out of a JS/TS source, dropping comments.
 *
 * A character walk rather than a parser: no dependency, no build step, and it
 * only has to be right about quotes and comments.
 */
export function literals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const startLine = line;
      const start = i;
      let buf = '';
      i++;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { buf += src[i + 1] ?? ''; i += 2; continue; }
        if (d === quote) { i++; break; }
        if (d === '\n') line++;
        // `${...}` is code, not copy — skip the expression, keep the text.
        if (quote === '`' && d === '$' && src[i + 1] === '{') {
          let depth = 1; i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            else if (src[i] === '\n') line++;
            i++;
          }
          buf += ' ';
          continue;
        }
        buf += d; i++;
      }
      if (buf.trim()) {
        // Adjacent literals joined only by `+` and whitespace are ONE piece of
        // copy in the source — this codebase builds most of its prompts that
        // way — so they are merged before scanning. Without this, `'… Never
        // say ' + '"booked" …'` splits the negation off its own sentence and
        // the file's own prohibition lints as a violation.
        const prev = out[out.length - 1];
        if (prev && /^[\s+]*$/.test(src.slice(prev.end, start))) {
          prev.text += ' ' + buf;
          prev.end = i;
        } else {
          out.push({ text: buf, line: startLine, start, end: i });
        }
      }
      continue;
    }
    i++;
  }
  return out;
}

export function lintFile(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return { file: rel, missing: true, findings: [] };
  const findings = [];
  for (const lit of literals(readFileSync(abs, 'utf8'))) {
    // No `context`. At runtime the context is the guest's own message and it
    // is genuinely about one thing; here it would be an eight-thousand-
    // character persona that is about everything, and a "hotel" at the far end
    // of it would condemn a sentence about a calendar. Static copy with no
    // travel word anywhere near it is left alone — the runtime layer still
    // sees it in situ. `mode: 'prompt'` makes "you" mean Num, which is who
    // these files address.
    const { hits } = scan(lit.text, { mode: 'prompt' });
    for (const h of hits) findings.push({ file: rel, line: lit.line, ...h });
  }
  return { file: rel, missing: false, findings };
}

export function lintAll(files = LINTED) {
  return files.flatMap((f) => lintFile(f).findings);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = lintAll();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2));
  } else if (findings.length) {
    console.error(`\ntravel-speak lint: ${findings.length} forbidden term${findings.length === 1 ? '' : 's'}\n`);
    for (const f of findings) {
      console.error(`  ${relative('.', f.file)}:${f.line}  [${f.rule}] "${f.match}"`);
      console.error(`      ${f.sentence.slice(0, 160)}`);
    }
    console.error('\nCalifornia B&P §17550.1(a) catches anyone who "arranges, or advertises that he or she');
    console.error('can or may arrange" travel. Say what the partner does, not what Num does.');
    console.error('Permitted: "LetsGo2Trip can issue this ticket — want me to take you there?"\n');
  } else {
    console.log(`travel-speak lint: clean across ${LINTED.length} files`);
  }
  process.exit(findings.length ? 1 : 0);
}
