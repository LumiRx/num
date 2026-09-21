#!/usr/bin/env node
/**
 * VOICE LINT — the rules from the voice research, made enforceable.
 *
 * Sits in the same family as travelspeak-lint and head-price-lint, and for the
 * same reason: a rule written in a document is a rule until somebody is busy.
 * A rule that fails `npm test` is a rule.
 *
 * ── WHY ONLY STRING LITERALS, AND WHY NEGATIONS ARE ALLOWED ──────────────
 *
 * Borrowed wholesale from travelspeak-lint, which learned it the hard way:
 * this codebase comments heavily and honestly, and linting comments produces a
 * wall of noise that gets the whole rule switched off inside a week. So only
 * string literals are scanned, using that file's own `literals()` walker.
 *
 * One addition it did not need. The house VOICE has to TEACH these rules to
 * the model, and teaching "never say you should" requires writing the phrase.
 * So a hit inside a negation — never, not, no, don't, avoid, instead of — is
 * allowed. The window is deliberately small (48 characters) so it cannot be
 * used to smuggle a real violation in behind a distant "never".
 *
 * Honest about the limit: this is a regex over strings, not comprehension. It
 * catches the phrasings we know are wrong. It cannot catch a warm sentence
 * that quietly upsells, and nothing here replaces reading the copy.
 *
 * Usage:  node scripts/voice-lint.mjs [--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { literals } from './travelspeak-lint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every file whose strings the model reads as instruction, or a guest reads on
 * a screen. Adding a voice surface and NOT adding it here is adding an
 * unlinted place to sound like a salesman.
 */
export const LINTED = [
  // The eSIM listing, pages, texts and emails a traveller reads (21 Sep).
  'worker/esimcopy.mjs',
  'worker/esimpages.mjs',
  'worker/specialists.mjs',
  'worker/prompt.mjs',
  'worker/brains.mjs',
  'worker/register.mjs',
  'worker/goodnews.mjs',
  'worker/repair.mjs',
  'worker/nudge.mjs',
  'worker/lastresort.mjs',
];

/**
 * Each rule is one failure mode from the research, with the finding attached
 * so that whoever trips it can decide whether the rule or the copy is wrong.
 */
export const RULES = [
  {
    id: 'instructing',
    pattern: /\byou (?:should|must|need to|have to|ought to)\b|\bmake sure you\b/i,
    why: 'Controlling language reliably produces resistance (reactance r≈.20 across 33 studies). Say what you would do and leave the choice theirs.',
  },
  {
    id: 'accounting',
    pattern: /\b(?:as part of your (?:plan|package|tier|membership)|requests? remaining|included in your (?:plan|tier|membership)|your (?:current )?(?:plan|tier) (?:includes|allows)|you have \w+ (?:requests?|bookings?|credits?) left|upgrade to (?:unlock|get)|since you'?re (?:on|a) \w+ (?:tier|member))\b/i,
    why: 'Exchange language inside a warm frame is punished far harder than inside a transactional one (Aggarwal 2004: 3.33 vs 6.04). Accounting belongs on the billing page, not in a conversation.',
  },
  {
    id: 'claiming-friendship',
    pattern: /\b(?:i'?m your (?:friend|best friend)|we'?re in this together|i'?ve got you\b|i miss(?:ed)? you|i'?ve had a long day|you always (?:cheer|make) me)\b/i,
    why: 'Friendship is concluded by the member, never asserted — and asserting it while invoicing is the exact norm mismatch that reads as fake.',
  },
  {
    id: 'taking-credit',
    pattern: /\b(?:glad i could help|that'?s what i'?m here for|happy to help!?|i went ahead and|i took care of (?:it|that) for you|i'?ve sorted (?:it|that) for you)\b/i,
    why: 'Help the recipient notices as help was worse than no help at all (Bolger & Amarel 2007, d=0.63–1.09); ~55% of the damage ran through perceived inefficacy. Do the work, do not narrate the rescue.',
  },
  {
    id: 'closing-good-news',
    pattern: /\b(?:glad (?:it|that) (?:went well|worked out)|so glad to hear|that'?s (?:great|lovely) to hear)\b/i,
    why: 'Passive-constructive responding predicts POORER outcomes than you would expect (Gable et al. 2004) — a mild acknowledgement closes the subject. Ask them about it instead.',
  },
];

const NEGATION = /\b(?:never|not|no|don'?t|do not|avoid|without|instead of|rather than|ban|banned|forbid|forbidden|refuse|stop)\b/i;
const WINDOW = 48;

/** Is this hit inside a sentence that is forbidding the thing? */
function negated(text, index) {
  return NEGATION.test(text.slice(Math.max(0, index - WINDOW), index));
}

/**
 * Lint source text directly. Split out from lintFile so the rules can be
 * tested against fixtures rather than only against whatever happens to be on
 * disk — a lint proved only by passing is not proved at all.
 */
export function lintSource(src, rel = '<source>') {
  const findings = [];
  for (const lit of literals(src)) {
    const text = lit.text ?? lit.value ?? '';
    if (!text) continue;
    for (const rule of RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
      for (const m of text.matchAll(re)) {
        if (negated(text, m.index)) continue;
        findings.push({
          file: rel,
          line: lit.line ?? 0,
          rule: rule.id,
          match: m[0],
          why: rule.why,
          sentence: text.slice(Math.max(0, m.index - 70), m.index + 90).replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }
  return findings;
}

export function lintFile(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return { file: rel, missing: true, findings: [] };
  return { file: rel, missing: false, findings: lintSource(readFileSync(abs, 'utf8'), rel) };
}

export function lintAll(files = LINTED) {
  return files.flatMap((f) => lintFile(f).findings);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = lintAll();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2));
  } else if (findings.length) {
    console.error(`\nvoice lint: ${findings.length} violation${findings.length === 1 ? '' : 's'}\n`);
    for (const f of findings) {
      console.error(`  ${relative('.', f.file)}:${f.line}  [${f.rule}] "${f.match}"`);
      console.error(`      ...${f.sentence}...`);
      console.error(`      ${f.why}\n`);
    }
    console.error('A hit inside a negation ("never say ...") is allowed — this is a real use.\n');
  } else {
    console.log(`voice lint: clean across ${LINTED.length} files`);
  }
  process.exit(findings.length ? 1 : 0);
}
