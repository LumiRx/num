// A block is only a block if EVERY door is locked.
//
// This exists because connect() shipped without the check invite() had: you
// could remove and block someone, and they could walk straight back in by
// scanning your QR code. The bug was invisible in review — invite() looked
// right, so the feature looked right.
//
// So this test does not read the two functions we happen to remember. It
// enumerates every function that writes a friendship row and demands each one
// consult isBlocked. A new path added later fails here rather than in the wild.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./social.mjs', import.meta.url), 'utf8');

/** Split the file into `async function name(...) { ... }` bodies. */
function functions(text) {
  const out = {};
  const re = /(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m;
  const starts = [];
  while ((m = re.exec(text))) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) => {
    out[s.name] = text.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : text.length);
  });
  return out;
}

const fns = functions(src);

// Anything that INSERTs into num_links is a door into someone's friend list.
const doors = Object.entries(fns).filter(([, body]) =>
  /INSERT\s+INTO\s+num_links/i.test(body),
);

test('there is at least one way to become friends (guards the guard)', () => {
  assert.ok(doors.length > 0, 'found no num_links INSERT — this test has gone blind');
});

test('every path that creates a friendship checks isBlocked', () => {
  const unguarded = doors.filter(([, body]) => !/isBlocked\s*\(/.test(body)).map(([n]) => n);
  assert.deepEqual(
    unguarded,
    [],
    `these can befriend someone who blocked them: ${unguarded.join(', ')}`,
  );
});

test('a block refuses without saying it is a block', () => {
  // Telling someone "you have been blocked" hands them the confrontation the
  // block was avoiding. The refusal must stay flat.
  const refusals = doors
    .flatMap(([, body]) => body.match(/isBlocked[\s\S]{0,300}?json\(\s*\{[^}]*\}/g) ?? []);
  assert.ok(refusals.length > 0, 'no refusal found next to an isBlocked check');
  for (const r of refusals) {
    assert.ok(
      !/block/i.test(r.replace(/isBlocked/g, '')),
      `refusal leaks that a block exists: ${r.slice(0, 120)}`,
    );
  }
});
