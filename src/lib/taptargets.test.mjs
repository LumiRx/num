/**
 * THE RATCHET.
 *
 * 13 Sep 2026 UI sweep. Dre: "lets work through teh ui/ux and make sure
 * everything is working."
 *
 * Two findings that only show up if you measure instead of reading:
 *
 * 1. SCROLL CHAINING. Twenty-one scroll containers; two had
 *    `overscroll-behavior: contain`, and both of those had been fixed by
 *    hand after a complaint. Reaching the end of an inner list handed the
 *    gesture to whatever was behind it — the sheet lurches, or the page
 *    under the sheet moves while the sheet stands still. One CSS rule now
 *    covers every container, present and future, because it keys on the
 *    overflow itself rather than on a class someone has to remember.
 *
 * 2. TAP TARGETS. No control in this app sets an explicit height, so no
 *    naive audit finds anything wrong. Height comes from padding plus font
 *    size, and measured that way 82 controls sit under Apple's 44pt floor.
 *
 * The second one cannot be fixed in a single commit without shipping layout
 * changes nobody has looked at. So this file makes it a RATCHET instead: the
 * census below is the number as of the sweep, and the test fails if it goes
 * UP. New controls must be born at 44; old ones get fixed as their screens
 * are touched, and each fix lowers the number here.
 *
 * The measurement is deliberately the same crude arithmetic in both places:
 * padding*2 + round(fontSize * 1.25). It is not a browser. It does not need
 * to be — it needs to be consistent, so the direction of change is true.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const CSS = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8');
const COMPONENTS = fileURLToPath(new URL('../components/', import.meta.url));

const sourceFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? sourceFiles(join(dir, e.name)) : (e.name.endsWith('.tsx') ? [join(dir, e.name)] : []));

/** Every JSX opening tag of `name`, brace-aware so `style={{ ... }}` is not cut in half. */
function openingTags(src, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0; let j = m.index;
    while (j < src.length) {
      const c = src[j];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
      j += 1;
    }
    out.push({ at: m.index, tag: src.slice(m.index, j + 1) });
  }
  return out;
}

function census() {
  const short = [];
  for (const file of sourceFiles(COMPONENTS)) {
    const src = readFileSync(file, 'utf8');
    for (const name of ['button', 'a', 'div', 'span']) {
      for (const { at, tag } of openingTags(src, name)) {
        const interactive = tag.includes('onClick') || tag.includes('pressable(')
          || name === 'button' || (name === 'a' && tag.includes('href'));
        if (!interactive) continue;
        if (/\btap\b/.test((/className="([^"]*)"/.exec(tag) ?? [, ''])[1])) continue;
        if (/(min)?[Hh]eight:\s*\d+/.test(tag)) continue;
        const pad = /padding:\s*'(\d+)px/.exec(tag) ?? /padding:\s*(\d+)\b/.exec(tag);
        if (!pad) continue;
        const fs = /fontSize:\s*([\d.]+)/.exec(tag);
        const height = Number(pad[1]) * 2 + Math.round((fs ? Number(fs[1]) : 14) * 1.25);
        if (height < 44) short.push({ file: file.split('/').pop(), line: src.slice(0, at).split('\n').length, height });
      }
    }
  }
  return short;
}

describe('tap targets only get better', () => {
  // Measured 13 Sep 2026, immediately after tagging the five worst rows.
  const CEILING = 78;

  test('the count of sub-44px controls never rises', () => {
    const short = census();
    const worst = [...short].sort((a, b) => a.height - b.height).slice(0, 5)
      .map((s) => `${s.file}:${s.line} (${s.height}px)`).join(', ');
    assert.ok(short.length <= CEILING,
      `sub-44px controls went from ${CEILING} to ${short.length}. New controls must be 44px tall `
      + `or wear the "tap" class. Smallest right now: ${worst}`);
  });

  test('when the count drops, lower the ceiling in this file', () => {
    const n = census().length;
    assert.ok(n >= CEILING - 12,
      `${CEILING - n} controls were fixed since the sweep — good. Set CEILING to ${n} `
      + 'so the ratchet keeps holding.');
  });

  test('the five controls fixed in the sweep still carry the class', () => {
    const expected = {
      'app/DashView.tsx': 3,
      'app/InviteSheet.tsx': 2,
      'app/ShareSheet.tsx': 1,
    };
    for (const [rel, count] of Object.entries(expected)) {
      const src = readFileSync(join(COMPONENTS, rel), 'utf8');
      const found = (src.match(/className="[^"]*\btap\b[^"]*"/g) ?? []).length;
      assert.equal(found, count, `${rel} should keep ${count} "tap" control(s)`);
    }
  });
});

describe('the class does what the comment says', () => {
  test('.tap is a real 44px floor', () => {
    const block = /\.tap\s*\{([^}]*)\}/.exec(CSS);
    assert.ok(block, '.tap is missing from app.css');
    assert.match(block[1], /min-height:\s*44px/);
    assert.match(block[1], /box-sizing:\s*border-box/,
      'without border-box the padding is added ON TOP of the 44 and the pill overshoots');
    assert.match(block[1], /align-items:\s*center/, 'otherwise the label sits at the top of the taller box');
  });
});

describe('no scroll container hands the gesture to its parent', () => {
  const rule = () => {
    const i = CSS.indexOf('[style*="overflow-y: auto"]');
    assert.ok(i > -1, 'the inline-overflow selector is gone from app.css');
    const open = CSS.indexOf('{', i);
    return { selectors: CSS.slice(i, open), body: CSS.slice(open, CSS.indexOf('}', open)) };
  };

  test('it contains the chain and keeps momentum scrolling on iOS', () => {
    const { body } = rule();
    assert.match(body, /overscroll-behavior:\s*contain/);
    assert.match(body, /-webkit-overflow-scrolling:\s*touch/);
  });

  test('it matches both spellings React and hand-written CSS produce', () => {
    const { selectors } = rule();
    for (const s of ['overflow-y: auto', 'overflow-y:auto', 'overflow: auto', 'overflow:auto']) {
      assert.ok(selectors.includes(s), `a container written as "${s}" would be missed`);
    }
    assert.ok(selectors.includes('.no-scrollbar'), 'the rail class is how most inner lists scroll');
  });

  test('the containers it covers are still written the way it expects', () => {
    // The rule reaches these because the overflow is an INLINE style, which
    // lands in the style attribute the selector matches. That is what makes
    // it cover a container written next month without anyone remembering.
    // It is also the one assumption that can quietly stop being true: move
    // these declarations into a CSS class and the rule stops reaching them
    // with no error anywhere. So count them, and notice if they leave.
    const scrolling = sourceFiles(COMPONENTS)
      .filter((f) => /overflowY:\s*'auto'/.test(readFileSync(f, 'utf8')));
    assert.ok(scrolling.length >= 20,
      `only ${scrolling.length} components still declare overflowY inline (21 at the sweep). `
      + 'If scrolling moved into a CSS class, add that class to the rule in app.css.');
  });
});
