// The lint, pointed at what NUM actually sends.
//
// A voice guardrail that only checks the copy module is checking the copy that
// was already written carefully. The value is in catching the OTHER 34 call
// sites — the ones written months apart, by whoever was closest to the feature,
// against no rules at all.
//
// This sweeps every notification string in worker/ and fails on a violation, so
// the voice applies to the whole product rather than to one tidy file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lint } from './notifyvoice.mjs';

const DIR = new URL('./', import.meta.url);

/** The call sites that actually reach a person. A `title:` in a console
 *  capability list is not a notification; sweeping it produced a false failure
 *  on 14 Sep 2026 and would have taught the next person to ignore this test. */
const SENDERS = /\b(notify|notifyAll|pushNative|sendApns|buildPayload)\s*\(/g;
/** notifycopy.mjs RETURNS its strings rather than passing them, so the call
 *  scan cannot see them. It is the copy module; every string in it is copy. */
const ALL_COPY = new Set(['notifycopy.mjs']);

/** The spans of source that are arguments to a notification call. */
function sendSpans(src) {
  const spans = [];
  for (const m of src.matchAll(SENDERS)) {
    let depth = 0, i = m.index + m[0].length - 1;
    const from = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    spans.push([from, i]);
  }
  return spans;
}

const LITERAL = /(^|[\s,{(])(title|body|subtitle):\s*(['"`])((?:\\.|[^\\])*?)\3/gm;

/** Every title/body literal handed to a notification, template strings included. */
export function harvest() {
  const out = [];
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.mjs') && !n.includes('.test.'))) {
    const src = readFileSync(new URL(f, DIR), 'utf8');
    const spans = ALL_COPY.has(f) ? [[0, src.length]] : sendSpans(src);
    if (!spans.length) continue;
    for (const m of src.matchAll(LITERAL)) {
      if (!spans.some(([a, b]) => m.index >= a && m.index <= b)) continue;
      const text = m[4];
      // A pure expression (`${x}`) has nothing to lint; its words live elsewhere.
      if (!/[a-z]{3}/i.test(text.replace(/\$\{[^}]*\}/g, ''))) continue;
      out.push({ file: f, field: m[2], text });
    }
  }
  return out;
}

/** Runtime values are unknown at rest — stand them in with something plausible
 *  rather than skipping the line, so length is still measured honestly. */
const resolved = (t) => t.replace(/\$\{[^}]*\}/g, 'Baan Rim Pa');

test('the sweep actually finds the copy — a scan that finds nothing proves nothing', () => {
  const all = harvest();
  assert.ok(all.length >= 25, `only found ${all.length} strings; the matcher has probably stopped matching`);
  const files = new Set(all.map((s) => s.file));
  assert.ok(files.size >= 5, 'copy should be spread across several modules');
});

test('no notification NUM sends breaks the voice rules', () => {
  const broken = [];
  for (const s of harvest()) {
    // Length is checked separately below — here we care about what it SAYS.
    const problems = lint({ [s.field]: resolved(s.text) })
      .filter((p) => p.id !== 'too-long' && p.id !== 'placeholder');
    if (problems.length) broken.push(`${s.file} [${s.field}] "${s.text}" → ${problems.map((p) => p.id).join(', ')}`);
  }
  assert.deepEqual(broken, [], 'these violate the voice:\n' + broken.join('\n'));
});

test('no notification carries an unresolved placeholder', () => {
  // The worst failure available: it lands on a lock screen and cannot be recalled.
  const broken = [];
  for (const s of harvest()) {
    if (/undefined|\[object|\{\{/.test(s.text)) broken.push(`${s.file} [${s.field}] "${s.text}"`);
  }
  assert.deepEqual(broken, []);
});

test('titles stay inside what a lock screen shows', () => {
  // Reported rather than asserted for bodies, because an existing long body is a
  // copy decision to revisit, not a build break. A truncated TITLE is different:
  // it is the half-second someone uses to decide whether to look at all.
  const long = [];
  for (const s of harvest().filter((x) => x.field === 'title')) {
    const t = resolved(s.text);
    if (lint({ title: t }).some((p) => p.id === 'too-long')) long.push(`${s.file}: "${s.text}" (${t.length})`);
  }
  assert.deepEqual(long, [], 'these titles get cut mid-thought:\n' + long.join('\n'));
});
