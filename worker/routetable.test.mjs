// THE ROUTE TABLE — the guard against the collision that has now happened
// three times.
//
// worker/index.mjs dispatches with a chain of `if (url.pathname === …)` and
// `if (url.pathname.startsWith(…))`, first match wins. That is fine until two
// prefixes are related by string containment, at which point the earlier one
// silently eats the later one and the later one's handler 404s on paths it has
// never heard of. It has happened three times:
//
//   1. `/api/book` swallowed `/api/book/link`.
//   2. `/api/book` swallowed `/api/book/platforms`.
//   3. `/api/book` swallowed `/api/booking` (Sabre air) — for weeks, because a
//      prefix does not look like a sibling.
//
// Each was found in production and rescued by hand, and each rescue left a
// comment asking the next person to remember. This file is that comment made
// executable. It does NOT enumerate the routes: it READS them out of the
// router, in the order the router tests them, so a route added tomorrow is
// covered tomorrow and a route deleted tomorrow disappears from the table with
// no test to update. There is nothing here to keep in sync.
//
// Two layers, because they fail differently:
//
//   · SHADOWING (static). For every registered prefix P, every OTHER route
//     whose path begins with P must be registered ABOVE P. This is the
//     property the three incidents violated, and it is decided entirely by
//     order, so it is checked by reading order.
//   · REACHABILITY (dynamic). Every registered route is driven at the real
//     Worker as a real Request, and must not come back as the router's
//     terminal fall-through 404. That catches what the static pass cannot: a
//     route registered after an earlier unconditional `return`, a route inside
//     a block that never executes, a guard that swallows the path before
//     dispatch. A handler answering 404, 405, 422 or 503 in its OWN voice is a
//     PASS here — reachable is the property, not happy.
//
// The parser is deliberately strict and the third test fails loudly if it ever
// stops recognising the router, so a refactor cannot turn this file into a
// suite that passes by finding nothing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'index.mjs'), 'utf8');

// ── reading the router ─────────────────────────────────────────────────────
//
// Only `if` statements at the router's own indentation (four spaces, inside
// `export default { async fetch(…) {`) whose condition is made ENTIRELY of
// `url.pathname` comparisons joined by `||`. That deliberately excludes the
// guards — `request.method === 'POST' && url.pathname.startsWith('/api/')`
// gates the rate limiter and dispatches nothing, and treating it as a route
// would report every /api path as shadowed by it.
const ROUTE_IF = /^ {4}if \((url\.pathname(?:[^)]|\([^)]*\))*?)\)\s*(?:\{|return|const)/;
const CLAUSE = /^url\.pathname(?: === '([^']+)'|\.startsWith\('([^']+)'\))$/;

/**
 * The dispatch chain, in the order the router tests it.
 * @returns {{path: string, kind: 'exact'|'prefix', line: number}[]}
 */
export function routeTable(src = SRC) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = ROUTE_IF.exec(lines[i]);
    if (!m) {
      // The terminal guard is written as a NEGATION — everything that reaches
      // it that is not POST /api/num falls through to the 404 — so it is the
      // one dispatch the positive form above cannot see. It is a route: it is
      // the AI endpoint, the busiest one in the product.
      const tail = / {4}if \(request\.method !== 'POST' \|\| url\.pathname !== '(\/api\/[^']+)'\)/.exec(lines[i]);
      if (tail) out.push({ path: tail[1], kind: 'exact', line: i + 1, method: 'POST' });
      continue;
    }
    const clauses = m[1].split('||').map((c) => c.trim());
    const parsed = clauses.map((c) => CLAUSE.exec(c));
    // One unrecognised clause and the whole condition is skipped rather than
    // half-read: a partially understood route is worse than an unknown one.
    if (parsed.some((p) => p === null)) continue;
    for (const p of parsed) {
      out.push({ path: p[1] ?? p[2], kind: p[1] ? 'exact' : 'prefix', line: i + 1 });
    }
  }
  return out.filter((r) => r.path.startsWith('/api/'));
}

const TABLE = routeTable();

describe('the /api route table', () => {
  test('no registered prefix swallows a route registered below it', () => {
    // For every prefix, every other route it string-contains must come FIRST.
    // Stated the other way: reaching a route must not require getting past a
    // prefix that already matches it.
    const shadowed = [];
    TABLE.forEach((earlier, i) => {
      if (earlier.kind !== 'prefix') return;
      TABLE.slice(i + 1).forEach((later) => {
        if (later.path === earlier.path) return;
        if (!later.path.startsWith(earlier.path)) return;
        shadowed.push(
          `${later.kind} ${later.path} (index.mjs:${later.line}) is unreachable — ` +
          `prefix ${earlier.path} (index.mjs:${earlier.line}) matches it first. ` +
          `Move ${later.path} ABOVE ${earlier.path}, longest prefix first.`,
        );
      });
    });
    assert.deepEqual(shadowed, [], `\n${shadowed.join('\n')}\n`);
  });

  test('every registered route reaches a handler, not the fall-through 404', async () => {
    // No DB, no keys, no network. A handler that answers "not configured" has
    // been REACHED, which is the only thing under test; a handler that throws
    // has been reached too. The one answer that fails is the router's own
    // terminal `new Response('not found', { status: 404 })`, which is what a
    // shadowed or unregistered path comes back as and is the exact signature
    // of all three incidents.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('no network in the route-table probe'); };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const env = { NUM_APP_ORIGIN: 'https://app.itsnum.com' };
    const dead = [];
    try {
      for (const r of TABLE) {
        // A prefix is probed BELOW itself, so the probe can only be answered
        // by that prefix's handler or by something registered above it.
        const path = r.kind === 'exact'
          ? r.path
          : `${r.path}${r.path.endsWith('/') ? '' : '/'}__routetable_probe`;
        const init = {
          method: r.method ?? 'GET',
          headers: { 'CF-Connecting-IP': `198.51.100.${(TABLE.indexOf(r) % 250) + 1}` },
        };
        if (init.method === 'POST') {
          init.headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify({ messages: [{ role: 'user', content: 'probe' }] });
        }
        let res;
        try {
          res = await worker.fetch(new Request(`https://app.itsnum.com${path}`, init), env, ctx);
        } catch {
          continue; // threw inside a handler — reached, which is the property
        }
        if (res.status !== 404) continue;
        const text = await res.text().catch(() => '');
        if (text === 'not found') {
          dead.push(`${r.kind} ${r.path} (index.mjs:${r.line}) — probed ${path}, got the terminal 404`);
        }
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(dead, [], `\n${dead.join('\n')}\n`);
  });

  test('the parser still recognises the router', () => {
    // Without this, a refactor of index.mjs that changes how routes are
    // written turns both tests above into tests of an empty list — passing,
    // green, and guarding nothing. That failure is silent and this one is not.
    assert.ok(TABLE.length >= 25, `only ${TABLE.length} /api routes parsed out of index.mjs — the router has been rewritten and routeTable() no longer reads it`);
    const paths = TABLE.map((r) => r.path);
    // The four prefixes the incidents were about, plus the AI endpoint that
    // is registered by negation and is the easiest one for a parser to lose.
    for (const anchor of ['/api/book', '/api/booking', '/api/travel', '/api/duffel', '/api/passengers', '/api/num']) {
      assert.ok(paths.includes(anchor), `${anchor} is not in the parsed route table — either it was deleted from the router or routeTable() stopped seeing it`);
    }
    assert.ok(TABLE.some((r) => r.kind === 'exact'), 'no exact routes parsed');
    assert.ok(TABLE.some((r) => r.kind === 'prefix'), 'no prefix routes parsed');
  });
});
