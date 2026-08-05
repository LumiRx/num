// A store selector must never build a new object.
//
// `useApp` is `useSyncExternalStore`, so the selector IS getSnapshot and React
// compares results BY REFERENCE. A selector ending in .filter() returns a fresh
// array on every read, so React sees a change every render, re-renders, reads
// again — React error #185, "Maximum update depth exceeded", and the screen
// goes blank.
//
// This shipped once. TypeScript was happy, the build was clean, the bundle
// contained every string I grepped for, and the Profile tab was a black
// rectangle. Only running it in a browser caught it — so this test runs
// instead of a person remembering to.
//
// The first version of this test PASSED on the broken code, and the second
// flagged a `.find()` that was perfectly safe. Both failures are recorded here
// because a guard nobody has watched fail — in both directions — is not a
// guard. It is now pinned against known-bad and known-good samples below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../', import.meta.url).pathname; // …/src/

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

/**
 * Pull the body of every `useApp(...)` call by matching parens, because the
 * bodies contain arrow functions full of their own parens and a regex cannot
 * count. The regex version of this is what let the bug through.
 */
function selectorBodies(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf('useApp(', i)) !== -1) {
    let depth = 0;
    let j = i + 'useApp'.length;
    const start = j;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')' && --depth === 0) break;
    }
    out.push(src.slice(start + 1, j));
    i = j + 1;
  }
  return out;
}

/** What does this selector actually hand back to React? */
function returned(body) {
  const arrow = body.indexOf('=>');
  if (arrow === -1) return body.trim();
  const rhs = body.slice(arrow + 2).trim();
  if (!rhs.startsWith('{')) return rhs; // expression body
  // Block body — the last `return` is what React receives.
  const rets = [...rhs.matchAll(/\breturn\s+([\s\S]+?);/g)];
  return rets.length ? rets[rets.length - 1][1].trim() : rhs;
}

// Calls that build a NEW array. `.find()` is absent on purpose: it returns an
// element that lives in the store, so its identity is stable across reads.
const ALLOCATOR = /\.(filter|map|slice|sort|concat|flatMap|reverse)\s*\(/;

// Allocating mid-expression is fine if what comes back is a primitive or a
// reference the store owns: `.filter(...).length` is a number, `[0]` is the
// store's own object.
const SETTLES = /(\.(length|size)|\]|\.[a-zA-Z_$][\w$]*)$/;

const offends = (expr) =>
  /^[[{]/.test(expr) || (ALLOCATOR.test(expr) && !SETTLES.test(expr));

test('the check catches the bug that actually shipped', () => {
  assert.ok(offends("s.friends.filter((f) => f.state === 'active' && !!f.id)"));
  assert.ok(offends('s.bookings.map((b) => b.id)'));
  assert.ok(offends('[s.a, s.b]'));
});

test('the check clears the shapes that are genuinely safe', () => {
  assert.ok(!offends('s.me'));
  assert.ok(!offends("s.friends.filter((f) => f.state === 'active').length"));
  assert.ok(!offends('s.planItems.find((i) => norm(i.title) === norm(title))'));
  assert.ok(!offends('s.friends.filter(Boolean)[0]'));
});

test('no store selector in the app allocates on every read', () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    for (const body of selectorBodies(readFileSync(file, 'utf8'))) {
      const expr = returned(body);
      if (offends(expr)) offenders.push(`${file.replace(SRC, '')}: ${expr.slice(0, 90)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these spin React until the screen blanks — select the raw value and derive in the render body:\n  ' +
      offenders.join('\n  '),
  );
});
