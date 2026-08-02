/**
 * The model ids we ship, pinned.
 *
 * WHY THIS FILE EXISTS
 * Cloudflare retired `@cf/meta/llama-3.1-8b-instruct` on 30 May 2026. num-ai
 * used it in two places: tier t1 (the cheap reply path) and MEM_MODEL (the
 * guest brain). Every call threw. Every throw was caught and console.log'd.
 * Nothing else happened, so the platform looked healthy while two features
 * were dead — for two months.
 *
 * It was fixed on 29 July over the script API, and reverted TWICE by deploys
 * built from this tree, which had never carried the fix. The evidence is in
 * num_llm_calls: tier t1 has two successes in its entire history, both inside
 * the 90-minute window on 30 July when the corrected id was live.
 *
 * A comment would have been reverted just as quietly. A failing test cannot be.
 * When Cloudflare retires the next one, add its id to RETIRED and this suite
 * names every file still holding it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SMALL_MODEL, BIG_MODEL } from './router.js';

const RETIRED = [
  '@cf/meta/llama-3.1-8b-instruct',   // retired 2026-05-30 — the `-fast` variant replaces it
];

const HERE = new URL('.', import.meta.url);

test('no source file ships a retired model id', () => {
  const offenders = [];
  for (const f of readdirSync(HERE).filter(n => n.endsWith('.js'))) {
    const src = readFileSync(new URL(f, HERE), 'utf8');
    for (const bad of RETIRED) {
      // Match the exact quoted literal. `...-instruct-fast` is a different,
      // live model and must not trip this — a substring check would.
      if (src.includes(`'${bad}'`) || src.includes(`"${bad}"`)) offenders.push(`${f} → ${bad}`);
    }
  }
  assert.deepEqual(offenders, [],
    `retired model id(s) still in source:\n  ${offenders.join('\n  ')}`);
});

test('the shipped model ids are the live ones', () => {
  assert.equal(SMALL_MODEL, '@cf/meta/llama-3.1-8b-instruct-fast');
  assert.equal(BIG_MODEL,   '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
});

test('the guest brain has a fallback model, not a single point of failure', () => {
  const src = readFileSync(new URL('worker.js', HERE), 'utf8');
  assert.match(src, /for \(const model of \[MEM_MODEL, BIG_MODEL\]\)/,
    'updateMemory must fall back to BIG_MODEL when MEM_MODEL yields no JSON');
  assert.match(src, /tier:'mem'/,
    'updateMemory must record its outcome to num_llm_calls, not only to console');
});
