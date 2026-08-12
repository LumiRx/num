// The reply a guest must never see.
//
// 9 Aug 2026, caught on camera while shooting App Store screenshots: a
// weak-model turn wrote its half-finished draft INTO the reply field —
// garbled prose, html artifacts, "Wait I need to output JSON only, not text
// like this. Let me produce final answer..{" — and the app rendered all of
// it, plus a junk card with a CANCELLED badge. Structured output constrains
// the SHAPE of the answer, not its sanity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardReply } from './router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('the actual leaked draft is rejected', () => {
  // Verbatim fragments from the incident. If any of these pass the guard,
  // the exact thing that happened can happen again.
  const leaks = [
    "easy walk back after too..]}[continply mention I lack certainty—should be fine.]}}(assresponse<br><br>Wait I need to output JSON only, not text like this. Let me produce final answer..{",
    'fine so far<br><br>then the rest of a draft',
    'Let me produce final answer..{',
    'Wait I need to output JSON only, not text like this.',
  ];
  for (const s of leaks) {
    assert.equal(guardReply(s).ok, false, `leaked draft passed the guard: "${s.slice(0, 50)}…"`);
  }
});

test('normal concierge prose still passes', () => {
  // The guard exists to stop drafts, not answers. Real (short) replies —
  // including ones with a quote, brackets, or an emoji — must sail through.
  const fine = [
    'Chekhoff — 290m, 4.8★, easy walk. Want a table?',
    'Promthep Cape by 18:00 is the move. Car at 17:45?',
    'They call it the "three-bay view" [Karon Viewpoint] — worth the stop. 👍',
  ];
  for (const s of fine) {
    assert.equal(guardReply(s).ok, true, `a clean reply was rejected: "${s}"`);
  }
});

test('a garbled reply is discarded whole and retried strong', () => {
  // The junk card rendered too — so the fix must throw away the whole parsed
  // object, not just patch the prose, and must retry on the strong model.
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /guardReply\(parsed\.reply\)/,
    'the structured path no longer checks replies — drafts will render again');
  assert.match(index, /GARBLED REPLY suppressed/,
    'a suppressed leak is no longer logged loudly — it would be invisible');
  assert.match(index, /NUM_MODEL_STRONG \|\| 'claude-opus-5'/,
    'the retry no longer escalates to the strong model');
  assert.match(index, /ask me that once more\?/,
    'the last-resort clean miss is gone — a double failure would throw at the guest');
});

test('the app itself carries the OpenStreetMap attribution', () => {
  // ODbL obliges attribution wherever the data is USED. The website's /privacy
  // and /terms carried it; the app did not — and a guest in the app is not
  // reading our privacy page. This is a licence obligation, not a nicety.
  const profile = readFileSync(join(HERE, '..', 'src', 'components', 'app', 'ProfileView.tsx'), 'utf8');
  assert.match(profile, /©\s*OpenStreetMap contributors/,
    'the OSM credit is gone from the app — ODbL attribution is a licence term, not decoration');
  assert.match(profile, /openstreetmap\.org\/copyright/,
    'the OSM copyright link is gone — attribution must be traceable to the licence');
  assert.match(profile, /<SourcesLine \/>/,
    'SourcesLine is defined but never rendered — an attribution nobody sees is no attribution');
});
