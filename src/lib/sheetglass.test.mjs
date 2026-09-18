// A sheet with no glass is a sheet with no background.
//
// `sheetBase` in derive.ts gives a sheet its position, its rounded top, its
// z-index and its safe-area padding. It deliberately does NOT give it a
// background, because the background in this app is the glass — a class, not
// a style object. So a sheet that spreads sheetBase and forgets the class
// renders perfectly: correct size, correct place, fully transparent, with
// whatever is underneath reading straight through the controls.
//
// That is not hypothetical. ResearchSheet shipped that way in 0.8.353 and was
// live for the time it took somebody to open it and look. It typechecked, and
// 5,963 tests passed, because nothing here knew the class was load-bearing.
//
// So: every sheet that presents itself as a dialog must carry a glass class on
// the same element it spreads sheetBase onto. The pairing is the rule, which is
// why this test looks for them together rather than for either one alone.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../components/app/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.tsx'));

/** The element that opens with `<div role="dialog"`, up to its closing `>`. */
function dialogElements(src) {
  const out = [];
  for (const m of src.matchAll(/<div\b(?=[^>]*\brole="dialog")/g)) {
    // Walk to the end of the opening tag, skipping `>` inside {...} and "..."
    let i = m.index, depth = 0, quote = '';
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

test('every dialog sheet that uses sheetBase also carries a glass class', () => {
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, DIR), 'utf8');
    for (const el of dialogElements(src)) {
      if (!/\bsheetBase\b/.test(el)) continue; // not a bottom sheet
      if (/className="[^"]*\bglass/.test(el)) continue;
      offenders.push(f);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these sheets spread sheetBase but have no glass class, so they render ` +
      `transparent over whatever is behind them: ${offenders.join(', ')}`,
  );
});

test('the check can actually fail', () => {
  // A guard that cannot fail is a guard that will be deleted by accident.
  const el = dialogElements('<div role="dialog" style={{ ...sheetBase }}>')[0];
  assert.ok(el, 'the dialog matcher found nothing in an obvious dialog');
  assert.ok(/\bsheetBase\b/.test(el));
  assert.ok(!/className="[^"]*\bglass/.test(el), 'a classless dialog must not pass');
});
