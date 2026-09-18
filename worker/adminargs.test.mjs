// isAdmin(env, request) — and never the other way round.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
//
// `isAdmin` is `(env, req)` and its first act is `!!env.ADMIN_KEY`. Called as
// `isAdmin(request, env)` it reads ADMIN_KEY off a Request, gets undefined,
// and short-circuits to false — for everyone, always, with a valid session.
//
// That is the worst shape a bug can have, because it FAILS CLOSED. Nothing
// errors. No log line appears. The endpoint simply refuses every caller, and
// refusing an admin looks exactly like an admin who has not signed in. It sat
// in two places for weeks: /api/expert-docs/review, where it meant no NDA or
// W-9 could ever be accepted and therefore no Expert could ever be paid, and
// /api/scouts/admin, where a false isAdmin fell through to the 404 at the
// bottom of the router so the endpoint answered "not found" rather than "not
// allowed" — which is why nobody chased it.
//
// Both were found on 18 Sep 2026, with two real paperwork packets waiting.
//
// A type system would catch this. This codebase does not have one on the
// worker, so the test does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const GROWTH = fileURLToPath(new URL('../growth/', import.meta.url));

const sources = (dir, ext) => {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) continue;
    if (!e.name.endsWith(ext)) continue;
    if (e.name.includes('.test.')) continue;
    out.push(join(dir, e.name));
  }
  return out;
};

const FILES = [...sources(HERE, '.mjs'), ...sources(GROWTH, '.js')];

test('isAdmin is defined as (env, req) — if this changes, the guard below must too', () => {
  const src = readFileSync(join(HERE, 'console.mjs'), 'utf8');
  assert.match(src, /export const isAdmin = async \(env, req\)/,
    'the signature moved; every call site and this test need revisiting');
});

test('every isAdmin call passes env first, never a Request', () => {
  const wrong = [];
  for (const f of FILES) {
    const src = readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      // Only the calls, not the definition.
      if (/export const isAdmin/.test(line)) return;
      const m = /\bisAdmin\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(line);
      if (!m) return;
      const first = m[1];
      // `env` is the only correct first argument. `request`/`req` is the bug.
      if (/^(request|req|r)$/.test(first)) {
        wrong.push(`${f.split('/').pop()}:${i + 1} — isAdmin(${first}, …)`);
      }
    });
  }
  assert.deepEqual(wrong, [],
    'isAdmin takes (env, request). Reversed it reads ADMIN_KEY off a Request, '
    + 'gets undefined, and silently refuses every admin:\n  ' + wrong.join('\n  '));
});

test('a Request in the env slot really does refuse everybody — the bug, demonstrated', async () => {
  const { isAdmin } = await import('./console.mjs');
  const request = new Request('https://app.itsnum.com/api/scouts/admin', {
    headers: { 'X-Admin-Session': 'whatever', Cookie: 'num_ops_session=whatever' },
  });
  const env = { ADMIN_KEY: 'a-real-key' };

  // Reversed: false, with no error, however good the credentials are.
  assert.equal(await isAdmin(request, env), false,
    'this is what shipped — it cannot ever return true, which is why it was invisible');

  // Right way round: it gets as far as actually grading the session, which is
  // all this test claims. A bad token is still false, but for the real reason.
  assert.equal(typeof await isAdmin(env, request), 'boolean');
});
