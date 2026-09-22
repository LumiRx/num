// A HANDOFF CODE IS A CREDENTIAL, AND IT WAS ON A PUBLIC LIST.
//
// 19 Sep 2026, confirmed live: GET https://app.itsnum.com/api/errands answered
// 200 to an unauthenticated caller with handoff_code in the rows. It had been
// flagged on two consecutive nights and was still open.
//
// The cause was not a missing check. It was `e.poster_id === meId` evaluated
// with no `me` parameter: null === null is true, so every errand with a null
// poster belonged to whoever asked for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'errands.mjs'), 'utf8');

/** Pull `visible` out and run it, so this tests behaviour and not wording. */
function loadVisible() {
  const same = src.match(/const same = [^\n]+/)[0];
  const vis = src.match(/function visible\(e, meId, opts\) \{[\s\S]*?\n\}/)[0];
  const coarse = src.match(/const coarse = \(addr\) => \{[\s\S]*?\n\};/)[0];
  return new Function(`${same}\n${coarse}\n${vis}\nreturn visible;`)();
}

const errand = (over = {}) => ({
  id: 'er_1', title: 'Pharmacy run', detail: 'd', where_from: 'w',
  deliver_to: '14 Sunset Road, Apt 3B, Los Angeles', bounty: 5, spend_cap: 20,
  state: 'open', place: 'la', poster_name: 'A', runner_name: null,
  created_at: 1, courier: null, poster_id: null, runner_id: null,
  handoff_code: 'SECRET7', ...over,
});

test('an anonymous caller never owns an errand with no poster', () => {
  const visible = loadVisible();
  const out = visible(errand(), null);
  assert.equal(out.handoff_code, undefined,
    'null === null made every unowned errand "mine" — the exact live leak');
  assert.equal(out.is_mine, false);
  assert.equal(visible(errand(), undefined).handoff_code, undefined);
  assert.equal(visible(errand(), '').handoff_code, undefined, 'an empty id is not an id');
});

test('the public board never carries a code, even for your own rows', () => {
  const visible = loadVisible();
  const mine = errand({ poster_id: 'mem_1' });
  assert.equal(visible(mine, 'mem_1', { list: true }).handoff_code, undefined,
    '`me` is an unauthenticated query parameter — one guessed id must not yield a list of codes');
  assert.equal(visible(mine, 'mem_1').handoff_code, 'SECRET7',
    'the owner can still read the code one errand at a time');
});

test('a runner sees the code for the errand they are running, and no other', () => {
  const visible = loadVisible();
  assert.equal(visible(errand({ runner_id: 'mem_9' }), 'mem_9').handoff_code, 'SECRET7');
  assert.equal(visible(errand({ runner_id: 'mem_9' }), 'mem_8').handoff_code, undefined);
});

test('a stranger is never given the door number', () => {
  const visible = loadVisible();
  const out = visible(errand({ poster_id: 'mem_1' }), null);
  assert.ok(!String(out.deliver_to).includes('Apt 3B'),
    'a board that publishes where strangers are staying is a different product');
  assert.equal(visible(errand({ poster_id: 'mem_1' }), 'mem_1').deliver_to,
    '14 Sunset Road, Apt 3B, Los Angeles');
});

test('ownership is compared by a named function, not by ===', () => {
  // Keeping `same` named is what stops the next ownership check quietly
  // reintroducing null === null.
  assert.match(src, /const same = \(a, b\) => !!a && !!b && String\(a\) === String\(b\)/);
  const vis = src.match(/function visible\(e, meId, opts\) \{[\s\S]*?\n\}/)[0];
  assert.ok(!/poster_id === meId|runner_id === meId/.test(vis),
    'a raw === is back in the ownership check');
});
