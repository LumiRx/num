/**
 * The rules of hooks, enforced on the whole app — because on 5 Sep 2026 every
 * brand-new install crashed on arrival.
 *
 * `InviteSheet` kept a `useEffect` (the resend cooldown) BELOW
 * `if (!draft) return null`. Closed, the sheet rendered N hooks; the moment it
 * opened it rendered N+1, and React threw #310 — "rendered more hooks than
 * during the previous render". On a fresh device the name sheet opens by
 * itself 900 ms after first paint (bootSocial), so a person who had just added
 * Num to their home screen saw it die before saying a word, while every device
 * that had already signed up looked fine. It reached production because nothing
 * asked the question this file asks.
 *
 * What is checked, per component or custom hook (a capitalised or `use`-named
 * function), using TypeScript's own parser rather than regexes:
 *
 *   1. no hook call after a top-level statement that can return early;
 *   2. no hook call inside a top-level if / for / while / switch;
 *   3. no hook call inside a `cond ? useA() : useB()` / `cond && useX()`
 *      initialiser.
 *
 * Nested functions (callbacks, handlers) are skipped: a hook inside them is a
 * different bug, and one eslint already catches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
const isHook = (n) => ts.isCallExpression(n) && (
  (ts.isIdentifier(n.expression) && /^use[A-Z]/.test(n.expression.text))
  || (ts.isPropertyAccessExpression(n.expression) && /^use[A-Z]/.test(n.expression.name.text)));
function findIn(node, pred) {
  let found = null;
  const walk = (x) => { if (found) return; if (x !== node && isFn(x)) return; if (pred(x)) { found = x; return; } ts.forEachChild(x, walk); };
  walk(node);
  return found;
}

export function scan(root = join(ROOT, 'src')) {
  const out = [];
  for (const f of files(root)) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    const rel = f.slice(ROOT.length + 1);
    const check = (name, body) => {
      if (!body || !ts.isBlock(body)) return;
      let earlyReturn = null;
      for (const st of body.statements) {
        if (ts.isReturnStatement(st)) break;
        if (earlyReturn != null) {
          const h = findIn(st, isHook);
          if (h) out.push(`${rel}:${line(h)} ${name}: ${h.expression.getText()} after an early return at line ${earlyReturn}`);
          continue;
        }
        if ((ts.isIfStatement(st) || ts.isTryStatement(st)) && findIn(st, ts.isReturnStatement)) { earlyReturn = line(st); }
        if (ts.isIfStatement(st) || ts.isForStatement(st) || ts.isForOfStatement(st) || ts.isForInStatement(st) || ts.isWhileStatement(st) || ts.isSwitchStatement(st)) {
          const h = findIn(st, isHook);
          if (h) out.push(`${rel}:${line(h)} ${name}: ${h.expression.getText()} inside a conditional`);
        }
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (d.initializer && (ts.isConditionalExpression(d.initializer) || ts.isBinaryExpression(d.initializer))) {
              const h = findIn(d.initializer, isHook);
              if (h) out.push(`${rel}:${line(h)} ${name}: ${h.expression.getText()} in a conditional expression`);
            }
          }
        }
      }
    };
    const walk = (n) => {
      if (ts.isFunctionDeclaration(n) && n.name && /^(use|[A-Z])/.test(n.name.text)) check(n.name.text, n.body);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^(use|[A-Z])/.test(n.name.text) && n.initializer) {
        let init = n.initializer;
        while (ts.isCallExpression(init) && init.arguments.length) init = init.arguments[0];
        if (isFn(init)) check(n.name.text, init.body);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return out;
}

test('no component or hook calls a hook after an early return, or inside a conditional', () => {
  const bad = scan();
  assert.deepEqual(bad, [], `\n${bad.join('\n')}\n\nA hook below a return renders a different number of hooks per render — React #310, a crash on the very next open.`);
});

test('the InviteSheet cooldown effect sits above the early return, where it must stay', () => {
  const src = readFileSync(join(ROOT, 'src/components/app/InviteSheet.tsx'), 'utf8');
  const effect = src.indexOf('}, [cooling]);');
  const ret = src.indexOf('if (!draft) return null;');
  assert.ok(effect > 0 && ret > 0);
  assert.ok(effect < ret, 'the resend cooldown useEffect moved back below `if (!draft) return null`');
});
