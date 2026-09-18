// Does every button actually reach something?
//
// A control in this app can fail in three places, and only the first is
// visible in review:
//
//   1. the control has no handler at all          → nothing happens on tap
//   2. the handler calls an /api path             → that no worker route serves
//   3. the worker serves a route                  → nothing in the app calls
//
// (2) is the one that ships. It typechecks, because a path is just a string.
// It passes every test, because no test asks the worker whether it would
// answer. The guest taps, a request 404s, and the catch swallows it.
//
// So this walks both sides and matches them: every /api path the client
// mentions, against every path the worker's routing actually compares against.
//
// Run: node scripts/deadends.mjs        (human report)
//      node scripts/deadends.mjs --json (machine)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Strip comments before scanning. This file's own prose says `/api/...` twice,
 * and apibase.ts documents "all 39 /api/... calls in the app" — read as code,
 * documentation becomes a finding. Block comments and doc-star lines are where
 * prose lives; `//` is only treated as a comment when it OPENS the line, so a
 * `https://` inside real code is left alone.
 */
export function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

function walk(dir, test, out = []) {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, test, out);
    else if (test(e)) out.push(rel);
  }
  return out;
}

const clientFiles = walk('src', (f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
const workerFiles = walk('worker', (f) => /\.mjs$/.test(f) && !/\.test\./.test(f));

/**
 * Every /api path the client names. Covers '…', "…" and `…${x}` — for a
 * template the static prefix is what we can check, so `/api/plans/${id}`
 * is recorded as the prefix `/api/plans/`.
 */
export function clientPaths() {
  const found = new Map(); // path -> Set(file)
  for (const f of clientFiles) {
    const src = code(readFileSync(join(ROOT, f), 'utf8'));
    for (const m of src.matchAll(/['"`](\/api\/[A-Za-z0-9/_.:-]*)/g)) {
      const p = m[1];
      if (!found.has(p)) found.set(p, new Set());
      found.get(p).add(f);
    }
  }
  return found;
}

/**
 * Every path the worker's routing compares against. Two shapes, and the
 * difference matters: `===` serves exactly one path, `.startsWith()` serves a
 * whole subtree (the sub-router then strips the prefix and routes the rest).
 */
export function workerRoutes() {
  const exact = new Set(), prefix = new Set();
  for (const f of workerFiles) {
    const src = code(readFileSync(join(ROOT, f), 'utf8'));
    for (const m of src.matchAll(/===\s*['"`](\/api\/[A-Za-z0-9/_.-]*)['"`]/g)) exact.add(m[1]);
    for (const m of src.matchAll(/['"`](\/api\/[A-Za-z0-9/_.-]*)['"`]\s*===/g)) exact.add(m[1]);
    // `if (request.method !== 'POST' || url.pathname !== '/api/num') return 404`
    // is a route too — the guard IS the dispatch. Missing this shape reported
    // the concierge endpoint itself as unserved, which would have been a
    // spectacular thing to hand somebody as a finding.
    for (const m of src.matchAll(/!==\s*['"`](\/api\/[A-Za-z0-9/_.-]*)['"`]/g)) exact.add(m[1]);
    for (const m of src.matchAll(/['"`](\/api\/[A-Za-z0-9/_.-]*)['"`]\s*!==/g)) exact.add(m[1]);
    for (const m of src.matchAll(/\.startsWith\(\s*['"`](\/api\/[A-Za-z0-9/_.-]*)['"`]/g)) {
      // `startsWith('/api/')` is the POST rate-limit gate at index.mjs:1778,
      // not a route. Counted as one, it serves every path in the app and this
      // whole report turns into a green light that checks nothing. A real
      // sub-router always names at least one segment: '/api/host/', '/api/events'.
      if (/^\/api\/?$/.test(m[1])) continue;
      prefix.add(m[1]);
    }
  }
  return { exact, prefix };
}

export function audit() {
  const client = clientPaths();
  const { exact, prefix } = workerRoutes();

  const served = (p) => {
  if (exact.has(p)) return 'exact';
  for (const pre of prefix) if (p.startsWith(pre)) return `prefix ${pre}`;
  // A client template prefix like /api/plans/ is served if any exact route
  // sits beneath it — the dynamic tail is the id.
  if (p.endsWith('/')) for (const e of exact) if (e.startsWith(p)) return `exact under ${p}`;
  return null;
};

  const dead = [], live = [];
for (const [p, files] of [...client].sort()) {
  if (/^\/api\/?$/.test(p)) continue; // a bare prefix from a template, not a call
  const how = served(p);
  (how ? live : dead).push({ path: p, files: [...files].sort(), how });
}

// Routes the worker serves that nothing in the app calls. Not a defect on its
// own — webhooks, MCP endpoints and partner APIs have no client caller by
// design — but a feature that was built and never wired up looks exactly
// like this, which is worth being able to see.
const clientPrefixes = [...client.keys()].filter((c) => !/^\/api\/?$/.test(c));
const orphans = [...exact].filter((e) =>
  !clientPrefixes.some((c) => c === e || (c.endsWith('/') && e.startsWith(c)))).sort();

  return { dead, live, orphans, exact, prefix, client };
}

// Only when run as a command. A test importing audit() must not print a
// report or, worse, call process.exit(1) and take the suite down with it.
const isCli = !!process.argv[1] && process.argv[1].endsWith('deadends.mjs');
if (isCli) main();

function main() {
const { dead, live, orphans, client, exact, prefix } = audit();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ dead, live: live.length, orphans }, null, 2));
} else {
  console.log(`client /api paths: ${client.size}   worker routes: ${exact.size} exact + ${prefix.size} prefix\n`);
  if (dead.length) {
    console.log(`✘ ${dead.length} path(s) the app calls that no worker route serves:\n`);
    for (const d of dead) console.log(`    ${d.path}\n        called from ${d.files.join(', ')}`);
  } else {
    console.log('✓ every /api path the app calls is served by a worker route');
  }
  console.log(`\n· ${orphans.length} worker route(s) with no caller in the app`);
  console.log(`  (webhooks, MCP and partner endpoints belong here; a half-wired feature also does)`);
  for (const o of orphans) console.log(`    ${o}`);
}
process.exit(dead.length ? 1 : 0);
}
