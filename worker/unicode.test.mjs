// One rule, enforced across the whole codebase: \p{L} never travels alone.
//
// Most of the world does not write the way English does. Thai, Lao, Khmer,
// Arabic, Hebrew, Devanagari, Balinese and decomposed Vietnamese all carry
// vowels, tones and diacritics as COMBINING MARKS — Unicode category M, not
// L. A character class of [\p{L}\p{N}] therefore reads as "letters and
// digits" to whoever wrote it and behaves as "delete the vowels" for roughly
// half the planet.
//
// This is not theoretical. Five separate places in this repo had it, and
// every one of them was silently wrong for months:
//
//   growth/worker.js       ร้าน stored as "ร าน" — every Thai business name
//                          mangled on the way in
//   public/claim/index.html
//   growth/claim-uk.html   owners greeted with their own name misspelled
//   worker/index.mjs       Thai titles produced NO search words at all, so
//                          Thai place cards never got a photo
//   worker/answercache.mjs distinct Thai questions collapsing onto ONE cache
//                          key — the second person served the first person's
//                          answer
//
// None of it threw. None of it appeared in a log. It just quietly served
// worse answers to everyone who does not type in Latin script.
//
// So the rule is mechanical and the build enforces it. If you genuinely need
// letters without marks, say so with an explicit `unicode-marks-ok` comment
// on the same line and the reason next to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['worker', 'growth', 'public', 'src', 'scripts', 'server'];
const EXT = /\.(mjs|js|jsx|ts|tsx|html)$/;
// Backups and vendored code are not ours to police.
const SKIP = /node_modules|\.bak|\.pre-|\.orig|dist|build|\.min\./;

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch (e) { return; }
  for (const name of entries) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    let s;
    try { s = statSync(p); } catch (e) { continue; }
    if (s.isDirectory()) yield* walk(p);
    else if (EXT.test(name)) yield p;
  }
}

test('every \\p{L} in a character class is joined by \\p{M}', () => {
  const offenders = [];

  for (const file of DIRS.flatMap((d) => [...walk(join(ROOT, d))])) {
    // This file talks about the pattern rather than using it.
    if (/unicode\.test\.mjs$/.test(file)) return;
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      // Only a \p{L} inside a character class is a filter. A bare mention in
      // prose or in a string is not.
      if (!/\[[^\]]*\\?p\{L\}/.test(line)) return;
      if (line.includes('unicode-marks-ok')) return;
      // The line is a comment explaining the rule rather than applying it.
      if (/^\s*(\/\/|\*|--|<!--)/.test(line.trim())) return;
      if (line.includes('p{M}')) return;
      offenders.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 110)}`);
    });
  }

  assert.deepEqual(
    offenders, [],
    '\\p{L} without \\p{M} deletes the vowels in Thai, Arabic, Hindi and more:\n  ' +
      offenders.join('\n  '),
  );
});

/* ── and that the fixed call sites actually behave ──────────────────────── */

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Real names and questions in the scripts NUM actually serves. Balinese and
// Indonesian are here because the first business asking to self-register is
// in Bali.
const SAMPLES = [
  ['Thai', 'ร้านอาหารทะเลป่าตอง'],
  ['Thai (tone marks)', 'พ.บาติก สวนหลวง'],
  ['Vietnamese', 'Phở Hà Nội Quán'],
  ['Arabic', 'مَطعَم البَحر'],
  ['Devanagari', 'चाय की दुकान'],
  ['Balinese', 'ᬧᬲᭂᬃᬲᬾᬦᬶ'],
  ['Indonesian', 'Warung Makan Ibu Oka'],
  ['Korean (decomposed)', '가마'],
];

test('a name in any of these scripts survives the intake whitelist', () => {
  const m = read('growth/worker.js').match(/const SAFE = (\/\[\^[^\n]*\/gu);/);
  assert.ok(m, 'SAFE not found');
  // eslint-disable-next-line no-eval
  const safe = eval(m[1]);
  for (const [script, s] of SAMPLES) {
    assert.equal(s.replace(safe, ' ').trim(), s.trim(), `${script} must survive intact`);
  }
});

test('a name in any of these scripts still yields search words', () => {
  // The bug: [\p{L}\p{N}]{3,} split every Thai name into fragments shorter
  // than the floor, so `words` came back empty and the caller bailed before
  // it ever looked for a photo.
  const src = read('worker/index.mjs');
  const m = src.match(/const words = \(core\.match\((\/\[[^/]+\/gu)\)/);
  assert.ok(m, 'the word-extraction regex moved; update this test');
  // eslint-disable-next-line no-eval
  const re = eval(m[1]);
  for (const [script, s] of SAMPLES) {
    const words = s.match(re) ?? [];
    assert.ok(words.length > 0, `${script} produced no search words: ${s}`);
  }
});

test('two different questions in the same script get two different cache keys', async () => {
  // The worst of the five. A cache key that drops the vowels does not just
  // look wrong — it hands one person the answer to someone else's question.
  const { normalize } = await import('./answercache.mjs');
  const pairs = [
    ['Thai', 'ร้านอาหารที่ไหนดี', 'รานอาหารทีไหนดี'],
    ['Vietnamese', 'phở ở đâu ngon', 'pho o dau ngon'],
  ];
  for (const [script, a, b] of pairs) {
    assert.notEqual(normalize(a), normalize(b),
      `${script}: two distinct questions collapsed onto one cache key`);
  }
});
