// The booking surface, held to the promises a guest gets.
//
// A human using BookSheet gets four guarantees: the venue decides, the kill
// switch works, an undialable number is refused, and Num only books for someone
// it already knows. An agent must get exactly the same four, or "an AI booked
// it" becomes a category of booking with weaker safety than the app — which is
// the only version of this feature that is worse than not shipping it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleConciergeMcp, conciergeIndex, TOOLS_FOR_TEST } from './conciergemcp.mjs';
import { TOOLS_FOR_TEST as PARTNER_TOOLS } from './partnermcp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = { 'X-Partner-Key': 'lg2t_test123' };
const post = (body, headers = {}) =>
  new Request('https://app.itsnum.com/api/concierge/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
const rpcJson = async (res) => JSON.parse(await res.text());
const call = (name, args, headers = KEY) =>
  post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers);
/** Tool payloads come back as a JSON string inside content[0].text. */
const payload = (j) => JSON.parse(j.result.content[0].text);

/* ── a booking desk, in memory ─────────────────────────────────────────────
 * bookdesk.mjs talks to D1 and Twilio. Neither exists in a test, and mocking
 * the HTTP layer would test the mock. This is the smallest D1 that satisfies
 * the queries bookdesk actually runs, so the real handler executes.
 * -------------------------------------------------------------------- */
function fakeEnv({ enabled = true, members = ['m_1'] } = {}) {
  const rows = [];
  const run = async (sql, binds) => {
    if (/^INSERT INTO num_booking_requests/i.test(sql)) {
      const [id, member_id, venue_name, venue_phone, party_size, on_date, at_time, note, plan_id, place_id] = binds;
      rows.push({ id, member_id, venue_name, venue_phone, party_size, on_date, at_time, note, plan_id, place_id,
        state: 'requested', created_at: '2026-08-18 09:00:00', answered_at: null });
    }
    return { meta: { changes: 0 } };
  };
  const prepare = (sql) => {
    let binds = [];
    const api = {
      bind: (...b) => { binds = b; return api; },
      run: () => run(sql, binds),
      first: async () => {
        if (/FROM num_members/i.test(sql)) return members.includes(binds[0]) ? { id: binds[0], name: 'Test Guest' } : null;
        return null;
      },
      all: async () => ({
        results: /FROM num_booking_requests/i.test(sql) ? rows.filter((r) => r.member_id === binds[0]) : [],
      }),
    };
    return api;
  };
  return {
    env: { DB: { prepare, batch: async () => [] }, BOOKDESK_ENABLED: enabled ? 'true' : 'false', ADMIN_KEY: 'test' },
    rows,
  };
}

test('the handshake says what it is and, twice, what it is not', async () => {
  const j = await rpcJson(await handleConciergeMcp(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), {}));
  assert.equal(j.result.serverInfo.name, 'num-concierge');
  assert.match(j.result.instructions, /NEVER confirms a booking/i,
    'the handshake does not say a request is not a confirmation — an agent will announce a table that does not exist');
  assert.match(j.result.instructions, /X-Partner-Key/,
    'the handshake does not state that a key is required, so the first call an integrator makes will fail unexplained');
});

test('initialize echoes a protocol version it actually speaks', async () => {
  // num-partners announces 2024-11-05 no matter what the client asked for.
  // A new file should not inherit that.
  for (const want of ['2025-06-18', '2025-03-26', '2024-11-05']) {
    const j = await rpcJson(await handleConciergeMcp(
      post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: want } }), {}));
    assert.equal(j.result.protocolVersion, want, `asked for ${want} and was told something else`);
  }
  const j = await rpcJson(await handleConciergeMcp(
    post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }), {}));
  assert.equal(j.result.protocolVersion, '2025-06-18', 'an unknown client version should be answered with ours, not echoed');
});

test('discovery is open, work is not', async () => {
  // An integrator must be able to read the shape of this before asking for a
  // key. Nobody signs blind, and a surface you cannot inspect gets skipped.
  const list = await rpcJson(await handleConciergeMcp(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {}));
  assert.deepEqual(list.result.tools.map((t) => t.name), ['request_table', 'booking_status']);

  const unkeyed = await handleConciergeMcp(call('request_table', { member_id: 'm_1', venue_name: 'X' }, {}), fakeEnv().env);
  assert.equal(unkeyed.status, 401);
  const j = await rpcJson(unkeyed);
  assert.equal(j.error.code, -32001);
  assert.match(j.error.message, /X-Partner-Key/,
    'the refusal does not name the header that would fix it');
  assert.match(j.error.message, /Nothing was changed/,
    'a refusal on a booking surface must say nothing happened, or the agent retries and the venue is texted twice');
});

test('request_table never returns a confirmation', async () => {
  const { env, rows } = fakeEnv();
  const out = payload(await rpcJson(await handleConciergeMcp(
    call('request_table', { member_id: 'm_1', venue_name: 'Baan Rim Pa', party_size: 4, on_date: '2026-08-20', at_time: '19:30' }), env)));

  assert.equal(out.state, 'requested');
  assert.equal(out.booked, false);
  assert.equal(out.confirmed, false);
  assert.ok(out.booking_id, 'no id came back, so booking_status can never be called');
  assert.match(out.must_not_say, /Do not tell the guest the table is booked/);
  assert.equal(rows.length, 1, 'the request was not recorded — the desk has nothing to work');
  assert.equal(rows[0].state, 'requested');
  // There is no argument, in any order, that makes this return confirmed.
  assert.ok(!('confirmation' in out) && out.confirmed === false);
});

test('the kill switch stops agents exactly as it stops the app', async () => {
  const { env, rows } = fakeEnv({ enabled: false });
  const j = await rpcJson(await handleConciergeMcp(call('request_table', { member_id: 'm_1', venue_name: 'Baan Rim Pa' }), env));
  const out = payload(j);
  assert.equal(j.result.isError, true, 'a closed desk returned a success envelope; the agent will report a table was requested');
  assert.equal(out.booking_desk_closed, true);
  assert.equal(out.booked, false);
  assert.equal(rows.length, 0, 'BOOKDESK_ENABLED=false and a row was still written — the switch does not stop the write');
  assert.match(out.error, /booking desk is closed/i,
    'the guest-facing sentence was replaced with something an agent cannot read out');
});

test('a venue number without a country code is refused, not guessed', async () => {
  // Guessing +1 because most of the directory is American texts a stranger in
  // Ohio about a table in Phuket.
  const { env, rows } = fakeEnv();
  const out = payload(await rpcJson(await handleConciergeMcp(
    call('request_table', { member_id: 'm_1', venue_name: 'Baan Rim Pa', venue_phone: '212-555-1234' }), env)));
  assert.equal(out.bad_phone, true);
  assert.equal(rows.length, 0, 'an undialable number was stored anyway');

  // ...and a properly international one goes through, digits intact.
  const ok = payload(await rpcJson(await handleConciergeMcp(
    call('request_table', { member_id: 'm_1', venue_name: 'Baan Rim Pa', venue_phone: '+66 81 234 5678' }), env)));
  assert.equal(ok.state, 'requested');
  assert.equal(rows[0].venue_phone, '+66812345678');
});

test('an agent cannot book for someone Num does not know', async () => {
  const { env, rows } = fakeEnv({ members: ['m_1'] });
  const out = payload(await rpcJson(await handleConciergeMcp(
    call('request_table', { member_id: 'm_stranger', venue_name: 'Baan Rim Pa' }), env)));
  assert.ok(out.error, 'a booking was accepted for a member that does not exist');
  assert.equal(rows.length, 0);

  const missing = payload(await rpcJson(await handleConciergeMcp(call('request_table', { venue_name: 'X' }), env)));
  assert.match(missing.error, /member_id/, 'the missing-argument error does not name what is missing');
});

test('booking_status reports pending as pending', async () => {
  const { env } = fakeEnv();
  const made = payload(await rpcJson(await handleConciergeMcp(
    call('request_table', { member_id: 'm_1', venue_name: 'Baan Rim Pa' }), env)));
  const out = payload(await rpcJson(await handleConciergeMcp(call('booking_status', { member_id: 'm_1' }), env)));
  assert.equal(out.requests.length, 1);
  assert.equal(out.requests[0].state, 'requested');
  assert.equal(out.requests[0].confirmed, false,
    'a pending request reads as confirmed — the guest is sent to a restaurant that is not expecting them');
  assert.equal(out.requests[0].booking_id, made.booking_id);

  const narrowed = payload(await rpcJson(await handleConciergeMcp(
    call('booking_status', { member_id: 'm_1', booking_id: 'bk_nope' }), env)));
  assert.deepEqual(narrowed.requests, [], 'booking_id does not narrow, so an agent reads someone else\'s table as its own');
});

test('there is no tool that can flip a state the venue owns', () => {
  // bookdesk allows exactly one transition, made by the venue. An agent-facing
  // confirm or cancel would be a second source of truth about whether a table
  // exists, and the venue would be the one to find out it lost.
  const names = TOOLS_FOR_TEST.map((t) => t.name);
  for (const forbidden of ['confirm_table', 'cancel_table', 'confirm_booking', 'update_booking']) {
    assert.ok(!names.includes(forbidden), `${forbidden} exists — only the venue may move a booking's state`);
  }
});

test('every tool description forbids the sentence that would matter', () => {
  for (const t of TOOLS_FOR_TEST) {
    assert.ok(t.description.length > 200, `${t.name}: description too thin for a model to choose safely`);
    assert.match(t.description, /NEVER|never|MUST NOT|not\b/, `${t.name}: says what it does but not what it refuses`);
  }
  const rt = TOOLS_FOR_TEST.find((t) => t.name === 'request_table');
  assert.match(rt.description, /THIS DOES NOT CONFIRM A TABLE/);
  assert.match(rt.description, /MUST NOT tell anyone a table is held/);
  assert.match(rt.description, /country code/, 'nothing warns that a bare national number is refused');
  const bs = TOOLS_FOR_TEST.find((t) => t.name === 'booking_status');
  assert.match(bs.description, /Only `confirmed` means a table exists/);
});

test('the booking boundary between the two surfaces holds', () => {
  // partnermcp.mjs tells every caller it never books and takes no personal
  // data. That sentence stops being true the moment a booking tool appears in
  // its array, and this is the assertion that notices.
  const partnerNames = PARTNER_TOOLS.map((t) => t.name);
  assert.ok(!partnerNames.includes('request_table'),
    'request_table is on the read-only partner surface, which promises callers it never books');
  const partnerSrc = readFileSync(join(HERE, 'partnermcp.mjs'), 'utf8');
  assert.match(partnerSrc, /never book, charge, or accept personal data/i,
    'the partner handshake dropped the refusal — either put it back or move its booking tools here');
});

test('the concierge surface is wired into the worker', () => {
  const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');
  assert.match(index, /'\/api\/concierge\/mcp'/, 'the MCP endpoint is not routed — this file is not an integration, it is a file');
  assert.match(index, /conciergeIndex\(env\)/, 'the front door is not routed');
  assert.match(index, /isSelfLimitedMcp/,
    'the MCP routes are back under the blanket limiter, whose 429 is not JSON-RPC and which throttles the handshake');
});

test('the front door publishes a tool list mcp-integrity can diff', async () => {
  const j = JSON.parse(await conciergeIndex({ BOOKDESK_ENABLED: 'true' }).text());
  assert.deepEqual(j.tools.map((t) => t.name), ['request_table', 'booking_status'],
    'the index no longer lists tools, so nothing can be compared against it and drift becomes invisible again');
  assert.match(j.auth, /REQUIRED/);
  assert.equal(j.accepting_requests, true);

  const off = JSON.parse(await conciergeIndex({ BOOKDESK_ENABLED: 'false' }).text());
  assert.equal(off.accepting_requests, false,
    'the index claims to be taking requests while the desk is switched off');
});
