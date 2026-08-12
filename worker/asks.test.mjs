// The questions are the roadmap — and they must arrive scrubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubAsk, recordAsk } from './asks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('identifiers never reach the table', () => {
  assert.equal(scrubAsk('book under john@x.com please'), 'book under [email] please');
  assert.equal(scrubAsk('call me +66 81 234 5678 about the villa'), 'call me [number] about the villa');
  assert.equal(scrubAsk('table for 4 at 8pm'), 'table for 4 at 8pm', 'ordinary numbers were mangled — party sizes and times are the content');
});

test('the scrub lives inside record, not in the caller', async () => {
  // A caller that forgets to scrub must not be able to store raw text.
  let stored = null;
  const stmt = { bind: (...a) => { stored = a; return stmt; }, run: async () => ({}) };
  await recordAsk({ DB: { prepare: () => stmt, batch: async () => [] } }, { text: 'my email is a@b.co' });
  assert.ok(stored && stored[0].includes('[email]'), 'raw identifier reached the insert — the scrub is optional');
});

test('both reply paths keep the question', () => {
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  const hits = index.match(/recordAsk\(env/g) ?? [];
  assert.ok(hits.length >= 2, 'a reply path drops the question again — cache hits or model answers are invisible to the Asks view');
  // Variable name changed on 11 Aug when recordAsk moved above logUsage so the
  // two could be joined by ask_id; the REQUIREMENT is unchanged — an ask that
  // does not record whether its answer was degraded loses the quality signal.
  assert.match(index, /degraded: !!(result\._degraded|_degraded)/,
    'asks no longer carry whether the answer was degraded — the quality signal is gone');
});
