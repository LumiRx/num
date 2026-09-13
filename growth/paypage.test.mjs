// What the guest actually has to do to pay.
//
// Every one of these was a number somebody had to transcribe by hand into a
// different app, one-handed, often in bad light and often not in their first
// language — a 10-to-13 digit PromptPay ID, a decimal amount, or a
// 42-character wallet address sitting one line above the words "cannot be
// reversed". The page had no copy affordance of any kind, and told PromptPay
// guests to scan a printed card using the phone they were reading it on.
//
// Each assertion was checked by removing the thing it guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The payPage body, comments removed — a grep that reads its own explanation
 *  proves nothing, and this repo has made that mistake three times. */
function payBody() {
  // The WHOLE function. The crypto rail is an early return ABOVE `const inner`,
  // so a window starting there silently excluded it — and the first version of
  // this file passed on four rails while checking three.
  const i = SRC.indexOf('function payPage(');
  assert.ok(i > 0, 'payPage must exist');
  const end = SRC.indexOf('return payShell(inner,', i);
  assert.ok(end > i, 'payPage must still end by rendering the shell');
  return strip(SRC.slice(i, end));
}

test('the PromptPay guest is given a code they can actually use', () => {
  const b = payBody();
  // They are HOLDING the phone. "Scan the printed card" is the fast path when
  // the card is readable and no path at all when it is not — and the EMV route
  // that renders the exact same code, amount included, already existed and was
  // only ever used on the venue's print sheet.
  assert.match(b, /\/api\/pay\/emv\/\$\{esc\(o\.token\)\}\.svg/,
    'the guest page must render the venue QR, not only point at a printed one');
  assert.match(b, /Scan from gallery/i,
    'and say how to use it from a phone that cannot scan its own screen');
  assert.match(b, /alt="PromptPay QR for /,
    'an image that IS the payment instruction needs alt text');
});

test('nothing has to be retyped by hand', () => {
  const b = payBody();
  for (const id of ['ppid', 'cryptoaddr']) {
    assert.ok(b.includes(`data-copy="${id}"`), `${id} has no copy button`);
    assert.ok(b.includes(`id="${id}"`), `${id} has nothing for the button to copy`);
  }
  assert.ok(b.includes('data-copy="ppamt"'), 'the amount is transcribed too');
});

test('a copy button that cannot copy says so instead of lying', () => {
  const sh = strip(SRC.slice(SRC.indexOf('function payShell')));
  assert.match(sh, /navigator\.clipboard && navigator\.clipboard\.writeText/,
    'clipboard access is not guaranteed — an unguarded call throws on older browsers');
  assert.match(sh, /Select it and copy/,
    'a refused clipboard must tell the guest what to do, not silently do nothing');
  assert.match(sh, /'Copied'/, 'and a success has to be visible or it gets pressed twice');
});

test('the url rail names the domain it is about to send you to', () => {
  const b = payBody();
  // A stranger scanned a sticker on a table and is one tap from a third-party
  // domain. That is the shape of a quishing attack, and this was the only rail
  // giving the guest nothing to check — the other two name the bank and chain.
  assert.match(b, /\$\{o\.payHost \? `<div class="ppbox">You will be taken to/,
    'the destination must be SHOWN, not merely available to the template');
  assert.match(b, /Continue\$\{o\.payHost \? ` to \$\{esc\(o\.payHost\)\}`/,
    'and named on the button, which is what a thumb is actually aimed at');
  assert.match(b, /don't pay, and tell staff/,
    'and the page must say what to do when it looks wrong');
  const i = SRC.indexOf('function hostOf(u)');
  assert.ok(i > 0, 'hostOf must exist');
  assert.match(SRC.slice(i, i + 260), /catch \{ return null; \}/,
    'a target that will not parse must not break the page a guest is paying on');
});

test('the copy script cannot stop a guest paying', () => {
  const sh = strip(SRC.slice(SRC.indexOf('function payShell')));
  // The values are rendered as text either way. The script is an accelerator,
  // never a dependency — if it throws, everything above it is still readable.
  assert.ok(sh.lastIndexOf('<script>') > sh.indexOf('${inner}'),
    'the script must come after the content, so a parse error cannot blank the page');
});
