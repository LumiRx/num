// Anonymous attribution — the smallest thing that makes a funnel measurable.
//
// 4 of 283 asks carried a member id on 15 Aug. Not a bug: almost nobody
// asking Num is a member, and letting people ask without a signup wall is
// correct — the answer IS the demo. But it meant every question arrived from
// an indistinguishable NULL, so "did anyone come back", "how many questions
// before someone signs up" and "did that campaign send real users" had no
// answers at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAsk } from './asks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), 'utf8');

/** D1 stand-in that remembers the bound arguments of the insert. */
function db() {
  let stored = null;
  const stmt = {
    bind: (...a) => { stored = a; return stmt; },
    run: async () => ({ meta: { last_row_id: 1 } }),
  };
  return { last: () => stored, prepare: () => stmt, batch: async () => [] };
}

test('a well-formed anon id is stored', async () => {
  const env = { DB: db() };
  await recordAsk(env, { text: 'where should i eat', anonId: 'a_0123456789abcdef0123456789abcdef' });
  assert.equal(env.DB.last()[9], 'a_0123456789abcdef0123456789abcdef');
});

test('a crafted anon id cannot write arbitrary text', async () => {
  // The client sends this field, so it is untrusted input to a table we make
  // decisions from.
  for (const bad of ["'; DROP TABLE num_asks;--", 'a_' + 'x'.repeat(200), 'not-an-id', '', null, 42, { id: 'a_abc' }]) {
    const env = { DB: db() };
    await recordAsk(env, { text: 'hello there', anonId: bad });
    assert.equal(env.DB.last()[9], null, `accepted a malformed anon id: ${JSON.stringify(bad)}`);
  }
});

test('anon lives in its own column, never inside member_id', () => {
  // Anything joining member_id to num_members must keep meaning what it says.
  const s = src('asks.mjs');
  assert.match(s, /ALTER TABLE num_asks ADD COLUMN anon_id TEXT/);
  assert.ok(!/memberId \?\? anonId|anonId \?\? memberId/.test(s),
    'anon ids are falling back into member_id — every member-join now silently includes non-members');
});

test('the id is random, not derived from the device', () => {
  // A derived id would be a fingerprint: it would survive clearing site data
  // and could follow someone. This one cannot, because there is nothing to
  // derive it from.
  const a = src('../src/lib/anon.ts');
  assert.match(a, /crypto\.getRandomValues/);
  assert.ok(!/userAgent|screen\.|platform|language|timeZone|canvas/.test(a),
    'anon.ts reads a device property — that is a fingerprint, not an anonymous id');
  assert.match(a, /export function forgetAnon/,
    'nothing can forget the id — "clear your site data and it is gone" has to be true');
});

test('no storage is not an error', () => {
  // Safari private mode, locked-down webviews, embedded browsers. The turn
  // still attributes to itself; only the cross-session part is lost.
  const a = src('../src/lib/anon.ts');
  assert.match(a, /catch \{\s*\n\s*\/\/ No storage: hold it for this session only\.\s*\n\s*memo = mint\(\);/);
});

test('the uptime probe is excluded from the tables we decide from', () => {
  // One string was 65% of every question Num had ever been asked. It still
  // runs the full model path — that is the point of the probe — it just stops
  // pretending to be a guest.
  const i = src('index.mjs');
  assert.match(i, /const isProbe = request\.headers\.get\('X-Num-Probe'\) === '1';/);
  assert.match(i, /if \(!isProbe\) ctx\.waitUntil\(\s*\n\s*recordAsk\(env/);
  const probe = src('../scripts/uptime.mjs');
  assert.match(probe, /'X-Num-Probe': '1'/, 'the probe stopped identifying itself and is polluting analytics again');
  assert.match(probe, /url: 'https:\/\/app\.itsnum\.com\/api\/num'/,
    'the probe no longer exercises the real model path — that is the only reason it exists');
});

// ── THE SECOND ROBOT ─────────────────────────────────────────────────────
//
// The uptime probe was taught to identify itself on 15 Aug 2026, after one
// string turned out to be 65% of every question Num had ever been asked. The
// MCP integrity monitor then did the same thing through a different door:
// concierge_answer runs the FULL guest pipeline, so its one question landed
// in num_asks as a traveller's. 12 of the 30 real asks recorded between 31
// Aug and 3 Sep 2026 were that robot — on the most-used lane, inside every
// funnel number we look at.
test('the MCP integrity monitor names itself as a probe', () => {
  const integrity = readFileSync(new URL('../scripts/mcp-integrity.mjs', import.meta.url), 'utf8');
  assert.match(integrity, /'X-Num-Probe': '1'/,
    'the integrity monitor is asking as a guest again and polluting the analytics tables');
});

test('concierge_answer forwards a probe header but never invents one', () => {
  const mcp = readFileSync(new URL('./partnermcp.mjs', import.meta.url), 'utf8');
  assert.match(mcp, /request\.headers\.get\('X-Num-Probe'\) === '1'/,
    'the monitor header is dropped at the MCP surface, so /api/num cannot tell the robot from a traveller');
  // Partner traffic is a real person asking through somebody else's app. If
  // this tool marked everything a probe, every partner ask would vanish from
  // the numbers — the same damage in the other direction.
  assert.equal(/headers:\s*\{[^}]*'X-Num-Probe':\s*'1',/.test(mcp), false,
    'concierge_answer marks every call a probe — real partner asks would stop being counted');
});
