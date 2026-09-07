// EVERY /api/admin/ ROUTE IS GATED — walked, not remembered.
//
// Found 3 Sep 2026: GET /api/admin/scout-usage answered 200 to the open
// internet, carrying every scout's name, referral code, commission terms and
// money owed. It sat in the router between two routes that DO check the key,
// and the check is one line, so nothing about the code looked wrong.
//
// A checklist would have missed it the same way a human did. This walks the
// router instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
const code = (s) => s.replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every `url.pathname === '/api/admin/...'` branch, with the block it guards. */
function adminBranches() {
  const src = code(index);
  const out = [];
  const re = /url\.pathname === '(\/api\/admin\/[^']+)'\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    // The branch body, to its matching close brace.
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push([m[1], src.slice(re.lastIndex, i)]);
  }
  return out;
}

const BRANCHES = adminBranches();

test('the router actually has admin routes to check', () => {
  assert.ok(BRANCHES.length >= 5, `found only ${BRANCHES.length} admin routes — the walker is broken`);
});

test('every admin route checks the key, inline or in its handler', () => {
  const unguarded = [];
  for (const [path, body] of BRANCHES) {
    if (/X-Admin-Key/.test(body)) continue;                 // gated right here
    const handler = /import\('\.\/([\w.]+\.mjs)'\)/.exec(body);
    if (handler) {
      const src = code(readFileSync(join(HERE, handler[1]), 'utf8'));
      if (/adminGuard\(|adminOk\(|X-Admin-Key/.test(src)) continue;  // gated in the module
      unguarded.push(`${path} (handler ${handler[1]})`);
      continue;
    }
    unguarded.push(path);
  }
  assert.deepEqual(unguarded, [], `admin routes readable by anyone: ${unguarded.join(', ')}`);
});

test('the gate fails closed when no key is configured', async () => {
  const { adminOk } = await import('./adminkey.mjs');
  const req = { headers: { get: () => 'anything' } };
  assert.equal(adminOk(req, {}), false, 'no ADMIN_KEY set and the door is open');
  assert.equal(adminOk(req, { ADMIN_KEY: '' }), false, 'an empty key is not a key');
});

test('the gate compares the whole key', async () => {
  const { adminOk } = await import('./adminkey.mjs');
  const env = { ADMIN_KEY: 'secret-value' };
  const with_ = (v) => ({ headers: { get: (h) => (h === 'X-Admin-Key' ? v : null) } });
  assert.equal(adminOk(with_('secret-value'), env), true);
  assert.equal(adminOk(with_('secret'), env), false, 'a prefix was accepted');
  assert.equal(adminOk(with_(null), env), false);
});

test('a refusal is a 401 with no detail in it', async () => {
  const { adminGuard } = await import('./adminkey.mjs');
  const res = adminGuard({ headers: { get: () => null } }, { ADMIN_KEY: 'k' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['error'], 'the refusal says more than it needs to');
});

// ── the funnel itself ────────────────────────────────────────────────────
const funnel = readFileSync(join(HERE, 'installfunnel.mjs'), 'utf8');

test('the funnel never reports one install rate across three browsers', () => {
  // 95% of this traffic is inside an in-app browser, which cannot add a home
  // screen icon at all. Averaging it with Chrome produces a number that argues
  // for better copy when the problem is the browser.
  assert.match(funnel, /by_path/);
  assert.match(funnel, /inapp/);
  assert.match(funnel, /ios-safari/);
  assert.match(funnel, /native/);
});

test('every funnel step names the events that prove it', async () => {
  const { STEPS } = await import('./installfunnel.mjs');
  const names = STEPS.map(([n]) => n);
  for (const need of ['arrived', 'asked', 'answered', 'failed', 'offered', 'installed']) {
    assert.ok(names.includes(need), `the funnel has no ${need} step`);
  }
  // Every event a step depends on must be one the worker will accept, or the
  // step is permanently zero and reads as "nobody did this".
  const worker = readFileSync(join(HERE, '..', 'growth', 'worker.js'), 'utf8');
  const allow = worker.slice(worker.indexOf('const EVENTS'), worker.indexOf(']);', worker.indexOf('const EVENTS')));
  for (const [, events] of STEPS) {
    for (const ev of events) {
      assert.ok(allow.includes(`"${ev}"`), `${ev} is not in growth/worker.js EVENTS — the step will always read zero`);
    }
  }
});

test('the ads page reports both halves of an ask', () => {
  const page = readFileSync(join(HERE, '..', 'public', 'ask', 'index.html'), 'utf8');
  assert.match(page, /track\('num_answered'/, 'nothing records that Num actually answered');
  assert.match(page, /track\('ask_failed'/, 'the failure branch is silent again');
  assert.match(page, /track\('install_prompt_shown', path\)/, 'the home-screen invitation is unmeasured');
  assert.match(page, /install_dismissed/, 'only accepts are counted — the refusals vanish');
});
