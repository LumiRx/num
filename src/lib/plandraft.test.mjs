// Plan drafts: kept per plan on this phone, cleared when the thing is sent,
// and never a reason for the sheet to break when storage is missing.
// Run: node --test src/lib/plandraft.test.mjs
import { test, before, beforeEach } from 'node:test';
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

const mem = new Map();
globalThis.localStorage = {
  getItem(k) { return mem.has(k) ? mem.get(k) : null; },
  setItem(k, v) { mem.set(k, String(v)); },
  removeItem(k) { mem.delete(k); },
};

let D;
before(async () => { D = await import('./plandraft.ts'); });
beforeEach(() => mem.clear());

test('a title typed for a new plan comes back under NEW; a comment for a plan comes back under that plan only', () => {
  D.saveDraft(D.NEW, { title: 'Sam’s birthday' });
  D.saveDraft('pl_1', { say: 'can we do Saturday' });
  assert.equal(D.loadDraft(null).title, 'Sam’s birthday');
  assert.equal(D.loadDraft('pl_1').say, 'can we do Saturday');
  assert.equal(D.loadDraft('pl_1').title, undefined);
  assert.equal(D.loadDraft('pl_2'), null);
});

test('clearing one field keeps the others; clearing the last one removes the draft', () => {
  D.saveDraft('pl_1', { idea: 'rooftop bar', say: 'thoughts?' });
  D.clearDraft('pl_1', 'idea');
  assert.deepEqual(Object.keys(D.loadDraft('pl_1')).sort(), ['at', 'say']);
  D.clearDraft('pl_1', 'say');
  assert.equal(D.loadDraft('pl_1'), null);
  assert.equal(mem.size, 0);
});

test('typing a field back to empty is the same as clearing it', () => {
  D.saveDraft(D.NEW, { title: 'x' });
  D.saveDraft(D.NEW, { title: '' });
  assert.equal(D.loadDraft(D.NEW), null);
});

test('a draft older than two weeks is stale and dropped on read', () => {
  mem.set('num.plandraft.new', JSON.stringify({ title: 'old', at: Date.now() - D.KEEP_MS - 1 }));
  assert.equal(D.loadDraft(D.NEW), null);
  assert.equal(mem.size, 0);
});

test('draftLine says what is worth picking up, title first', () => {
  assert.equal(D.draftLine(null), null);
  assert.equal(D.draftLine({ at: 1, idea: 'a boat' }), 'a boat');
  assert.equal(D.draftLine({ at: 1, title: 'Lisbon', idea: 'a boat' }), 'Lisbon');
});

test('with no storage at all, nothing throws and nothing is remembered', () => {
  const saved = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
  try {
    assert.doesNotThrow(() => D.saveDraft(D.NEW, { title: 'x' }));
    assert.equal(D.loadDraft(D.NEW), null);
    assert.doesNotThrow(() => D.clearDraft(D.NEW));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: saved, configurable: true, writable: true });
  }
});
