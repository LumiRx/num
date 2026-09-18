// No sheet reopens itself.
//
// `persistable()` in data.ts strips the overlay flags before the state is
// written to localStorage, under a rule its own comment states plainly: the
// page that is open is this launch's business only. The list is hand-written,
// so adding a sheet means remembering to add its flag — and the cost of
// forgetting is invisible in every test and in every build.
//
// What it looks like when you forget: `researchOpen` was left off the list, so
// a guest who opened "Look into it" and closed the app was ambushed by the
// sheet on next launch, hours later, over a thread they had moved on from.
// Writing this test found two more that had been missed long before — and one
// of them, `deleteOpen`, is the confirmation on "Delete my account". A guest
// who opened it, thought better of it and closed the app came back INTO the
// confirmation. That is the screen App Review opens for 5.1.1(v).
//
// So the list stops being hand-checked. Any field in AppState whose name ends
// in `Open` is a sheet, and no sheet survives a reload.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function appStateBlock() {
  const t = src('./types.ts');
  const start = t.indexOf('export interface AppState {');
  assert.ok(start > 0, 'AppState moved — this test needs to find it');
  return t.slice(start, t.indexOf('\n}', start));
}

/** The destructuring head of persistable(), where fields are dropped. */
function stripList() {
  const d = src('./data.ts');
  const start = d.indexOf('export function persistable');
  assert.ok(start > 0, 'persistable() moved — this test needs to find it');
  const end = d.indexOf('...keep } = s;', start);
  assert.ok(end > start, 'persistable() no longer ends in `...keep } = s;`');
  return d.slice(start, end);
}

test('every AppState field ending in Open is dropped before saving', () => {
  const opens = [...new Set(
    [...appStateBlock().matchAll(/^ {2}([a-zA-Z]*Open)\??:/gm)].map((m) => m[1]),
  )].sort();
  assert.ok(opens.length > 10, `expected many overlay flags, found ${opens.length}`);

  const strip = stripList();
  const kept = opens.filter((name) => !new RegExp(`\\b${name}\\b`).test(strip));
  assert.deepEqual(
    kept,
    [],
    `these sheets would reopen themselves on next launch because persistable() ` +
      `does not strip them: ${kept.join(', ')}`,
  );
});

test('a run in flight is deliberately kept, so resumeResearch has something to resume', () => {
  // The opposite mistake — stripping everything — would silently break the
  // one thing deep research promises: close the app, get the answer anyway.
  const strip = stripList();
  assert.ok(
    !/\bresearch\b\s*[,}]/.test(strip),
    'the research RUN must survive a reload; only its sheet flag is transient',
  );
});
