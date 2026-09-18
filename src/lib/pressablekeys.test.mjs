// A keystroke in a field is not a tap on the card around it.
//
// Found on 18 Sep 2026 while testing the send gate on a real preview build:
// pressing Enter in the composer would not open the sign-in sheet, while
// TAPPING send opened it every time — the same function, two outcomes. The
// keydown was bubbling out of the input and activating an ancestor that
// carries pressable(), whose own action then replaced the sheet the composer
// had just opened.
//
// It was never specific to the composer. Every text field inside a pressable
// card had it: a space typed in a name field, Enter in a join code.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(spec)) {
      const base = ctx.parentURL ? dirname(fileURLToPath(ctx.parentURL)) : process.cwd();
      for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
        const p = resolvePath(base, spec + ext);
        if (existsSync(p)) return next(pathToFileURL(p).href, ctx);
      }
    }
    return next(spec, ctx);
  },
});

const { pressable } = await import('./a11y.ts');

/** A keydown as React would hand it over. */
const key = (k, target = {}) => {
  let prevented = false;
  return { key: k, target, preventDefault: () => { prevented = true; }, wasPrevented: () => prevented };
};

describe('a control still activates from the keyboard', () => {
  for (const k of ['Enter', ' ']) {
    test(`${k === ' ' ? 'Space' : k} on the control itself activates it`, () => {
      let fired = 0;
      const e = key(k, { tagName: 'DIV' });
      pressable(() => { fired += 1; }).onKeyDown(e);
      assert.equal(fired, 1);
      assert.equal(e.wasPrevented(), true, 'Space must not scroll the page');
    });
  }

  test('any other key does nothing', () => {
    let fired = 0;
    pressable(() => { fired += 1; }).onKeyDown(key('a', { tagName: 'DIV' }));
    pressable(() => { fired += 1; }).onKeyDown(key('Escape', { tagName: 'DIV' }));
    assert.equal(fired, 0);
  });

  test('the role and the tab stop are unchanged', () => {
    const p = pressable(() => {});
    assert.equal(p.role, 'button');
    assert.equal(p.tabIndex, 0);
    assert.equal(pressable(() => {}, 'tab').role, 'tab');
  });
});

describe('but a keystroke inside a field belongs to the field', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    test(`Enter in a ${tag.toLowerCase()} does not activate the card around it`, () => {
      let fired = 0;
      const e = key('Enter', { tagName: tag });
      pressable(() => { fired += 1; }).onKeyDown(e);
      assert.equal(fired, 0, `${tag} keystrokes must stay in the field`);
      assert.equal(e.wasPrevented(), false, 'and the field must still get its own Enter');
    });
  }

  test('a space typed in a name field types a space', () => {
    let fired = 0;
    pressable(() => { fired += 1; }).onKeyDown(key(' ', { tagName: 'INPUT' }));
    assert.equal(fired, 0);
  });

  test('contenteditable counts as a field too', () => {
    let fired = 0;
    pressable(() => { fired += 1; }).onKeyDown(key('Enter', { tagName: 'DIV', isContentEditable: true }));
    assert.equal(fired, 0);
  });

  test('a missing target is treated as the control, not as a field', () => {
    let fired = 0;
    pressable(() => { fired += 1; }).onKeyDown(key('Enter', null));
    assert.equal(fired, 1, 'no target must not silently disable the keyboard');
  });
});
