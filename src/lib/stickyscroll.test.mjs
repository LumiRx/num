/**
 * "THE SCREEN GOT STUCK SCROLLING."
 *
 * Dre, 13 Sep 2026, about somebody comparing flight fares. The screen was not
 * stuck. It was being dragged.
 *
 * Both threads in Num ran this:
 *
 *     useEffect(() => { el.scrollTop = el.scrollHeight; });
 *
 * No dependency array, so it fired after every render — and both components
 * subscribe to the whole store, so every render meant every state change
 * anywhere in the app. Num polls the booking desk every 15s, errands every
 * 15s, the party plan every 8s, suggestions every 90s, plus DMs and
 * autoupdate. A person reading a tall block of flight offers was thrown back
 * to the bottom every few seconds by a timer with nothing to do with them.
 *
 * These tests pin the rule and its edges. The hook itself needs React to run,
 * so the behaviour is proven through `atBottom` and the reducer logic it
 * drives, and the wiring is checked in source — the same split the rest of
 * this codebase uses for components.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HOOK = readFileSync(new URL('./stickyscroll.ts', import.meta.url), 'utf8');
const THREAD = readFileSync(new URL('../components/app/ThreadView.tsx', import.meta.url), 'utf8');
const DM = readFileSync(new URL('../components/app/DmSheet.tsx', import.meta.url), 'utf8');

/** The exported rule, reimplemented here only to state it independently. */
const PINNED_PX = 64;
const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_PX;

describe('what counts as still following the conversation', () => {
  test('sitting at the very bottom is pinned', () => {
    assert.equal(atBottom({ scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 }), true);
  });

  test('a hair off the bottom is still pinned — rounding must not unpin a reader', () => {
    // A rubber-band, a sub-pixel layout shift, an image finishing: none of
    // these mean the person stopped following.
    assert.equal(atBottom({ scrollHeight: 2000, scrollTop: 1399, clientHeight: 600 }), true);
    assert.equal(atBottom({ scrollHeight: 2000, scrollTop: 1336, clientHeight: 600 }), true);
  });

  test('scrolled up to read is NOT pinned', () => {
    assert.equal(atBottom({ scrollHeight: 2000, scrollTop: 900, clientHeight: 600 }), false);
  });

  test('the threshold is small enough to mean something', () => {
    assert.ok(PINNED_PX <= 120, 'too generous and "scrolled up" stops meaning scrolled up');
    assert.ok(PINNED_PX >= 16, 'too tight and a rounding error unpins the reader');
    assert.match(HOOK, /export const PINNED_PX = 64;/);
  });

  test('a thread shorter than its own window is pinned, not stranded', () => {
    // Three messages in a tall pane: scrollHeight < clientHeight, and the
    // arithmetic must not come out negative-and-therefore-unpinned.
    assert.equal(atBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 600 }), true);
  });
});

describe('the two conditions that make the auto-scroll safe', () => {
  test('it only moves when the content actually GREW', () => {
    // A poll that changes nothing visible must not move the page, even for
    // somebody sitting at the bottom. This is the half that stops the jitter.
    assert.match(HOOK, /const grew = el\.scrollHeight > lastHeight\.current;/);
    assert.match(HOOK, /if \(!grew\) return;/);
  });

  test('and only when the reader was already at the end', () => {
    assert.match(HOOK, /if \(pinned\.current\) \{\s*\n\s*el\.scrollTop = el\.scrollHeight;/);
  });

  test('scrolling up sets behind, it does not yank', () => {
    const i = HOOK.indexOf('if (pinned.current)');
    const block = HOOK.slice(i, i + 400);
    assert.match(block, /\} else \{\s*\n\s*setBehind\(true\);/,
      'the not-pinned branch must leave the scroll position alone');
    assert.ok(!/else[\s\S]{0,120}scrollTop =/.test(block),
      'a reader who scrolled up must never be moved');
  });

  test('pinned state is a ref, not state — setting state on scroll re-renders mid-gesture', () => {
    assert.match(HOOK, /const pinned = useRef\(true\);/);
    const i = HOOK.indexOf('const onScroll');
    assert.ok(!/setPinned/.test(HOOK.slice(i, i + 300)));
  });

  test('it starts pinned — a thread opens at the live end', () => {
    assert.match(HOOK, /useRef\(true\)/);
  });
});

describe('nobody who scrolls up is stranded', () => {
  test('the hook offers a way back', () => {
    assert.match(HOOK, /toLatest/);
    assert.match(HOOK, /behavior: 'smooth'/);
  });

  test('taking the way back starts following again', () => {
    const i = HOOK.indexOf('const toLatest');
    const block = HOOK.slice(i, i + 300);
    assert.match(block, /pinned\.current = true;/);
    assert.match(block, /setBehind\(false\);/);
  });

  test('scrolling back down by hand clears it too', () => {
    const i = HOOK.indexOf('const onScroll');
    assert.match(HOOK.slice(i, i + 300), /if \(end && behind\) setBehind\(false\);/);
  });

  test('both threads render the control', () => {
    for (const [what, src] of [['ThreadView', THREAD], ['DmSheet', DM]]) {
      assert.match(src, /\{behind && \(/, `${what} has no way back`);
      assert.match(src, /NEW BELOW/, `${what} has no way back`);
      assert.match(src, /pressable\(toLatest\)/, `${what}'s control is not wired`);
    }
  });
});

describe('the bug cannot come back in either thread', () => {
  for (const [what, src] of [['ThreadView', THREAD], ['DmSheet', DM]]) {
    test(`${what} no longer force-scrolls on every render`, () => {
      assert.ok(!/useEffect\(\(\) => \{[\s\S]{0,140}scrollTop = el\.scrollHeight;[\s\S]{0,40}\}\);/.test(src),
        'the unconditional snap-to-bottom is back');
    });

    test(`${what} uses the shared hook`, () => {
      assert.match(src, /useStickyBottom<HTMLDivElement>\(\)/);
      assert.match(src, /from '\.\.\/\.\.\/lib\/stickyscroll'/);
    });

    test(`${what} actually listens to the reader's scrolling`, () => {
      // The hook cannot know they scrolled up if nothing tells it.
      assert.match(src, /onScroll=\{onScroll\}/, 'the scroll handler is not attached');
    });

    test(`${what} keeps a flick inside the thread`, () => {
      // Without this an over-scroll hands the gesture to the page behind,
      // which on iOS is what makes a scroll feel like it catches.
      assert.match(src, /overscrollBehavior: 'contain'/);
    });
  }

  test('there is ONE implementation, not two that drift', () => {
    // Both were written to match — the DM copy literally said "same rule as
    // the Num thread" — and both carried the identical bug.
    assert.ok(!/lastHeight/.test(THREAD), 'ThreadView has its own copy again');
    assert.ok(!/lastHeight/.test(DM), 'DmSheet has its own copy again');
    assert.ok(!/Same rule as the Num thread/.test(DM), 'the comment that invited the drift is back');
  });
});
