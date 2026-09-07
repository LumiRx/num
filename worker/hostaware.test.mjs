// Two complete, tested, disconnected worlds — the app and the host programme —
// joined by a column that never held a real member id. These pin the bridge:
// the lookup, the self-heal, the prompt rule, the relay, and the watchman that
// tells the host once and files a failure when it cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { hostFor, hostBlock, relayToHost, notifyHosts, hostRequestEmail, ensure, HOST_SERVICES } from './hostaware.mjs';
import { open } from './failures.mjs';

function reorder(sql, args) {
  const idx = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  if (!idx.length) return args;
  return idx.map((i) => (args[i - 1] === undefined ? null : args[i - 1]));
}
function d1(db) {
  return {
    prepare(sql) {
      const st = { sql, args: [] };
      st.bind = (...a) => { st.args = a; return st; };
      const run = (fn) => fn(db.prepare(st.sql.replace(/\?(\d+)/g, '?')), reorder(st.sql, st.args));
      st.run = async () => ({ meta: { changes: run((s, a) => s.run(...a)).changes } });
      st.first = async () => run((s, a) => s.get(...a)) ?? null;
      st.all = async () => ({ results: run((s, a) => s.all(...a)) });
      return st;
    },
  };
}
function fresh({ hostTables = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, phone TEXT, phone_verified INTEGER DEFAULT 0)`);
  db.exec(`INSERT INTO num_members VALUES ('mem_1','+447700900123',1), ('mem_2','+447700900999',0)`);
  if (hostTables) {
    db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, email TEXT, status TEXT, services_json TEXT DEFAULT '[]', console_key TEXT)`);
    db.exec(`CREATE TABLE num_host_clients (id TEXT PRIMARY KEY, host_id TEXT, name TEXT, phone TEXT, member_id TEXT, status TEXT, updated_at TEXT)`);
    db.exec(`CREATE TABLE num_host_requests (id TEXT PRIMARY KEY, host_id TEXT, client_id TEXT, service_key TEXT, title TEXT, detail TEXT, city TEXT, starts_at TEXT, party_size INTEGER, status TEXT, created_at TEXT)`);
    db.exec(`INSERT INTO num_hosts VALUES ('h_1','Priya','priya@example.com','active','["car","reservation"]','k_priya')`);
    db.exec(`INSERT INTO num_hosts VALUES ('h_2','Old Host','old@example.com','ended','[]','k_old')`);
    // The intro path minted 'm_abc' — a string that is not a member. The phone
    // is the only thing the two worlds share.
    db.exec(`INSERT INTO num_host_clients VALUES ('hc_1','h_1','Dre','+447700900123','m_abc','active',NULL)`);
    db.exec(`INSERT INTO num_host_clients VALUES ('hc_2','h_2','Someone','+447700900999','mem_2','active',NULL)`);
  }
  return { DB: d1(db), _db: db, SITE: 'https://itsnum.com' };
}

test('a phone-verified member is matched to their host by phone, and the bridge heals itself', async () => {
  const env = fresh();
  const host = await hostFor(env, 'mem_1');
  assert.ok(host, 'the member IS this host\'s client — the intro just never knew their member id');
  assert.equal(host.hostName, 'Priya');
  assert.equal(host.clientId, 'hc_1');
  assert.deepEqual(host.services, ['car', 'reservation']);
  const row = env._db.prepare('SELECT member_id FROM num_host_clients WHERE id=?').get('hc_1');
  assert.equal(row.member_id, 'mem_1', 'the synthetic m_abc is replaced with the real member id');
  // Second ask: matched by id now, phone no longer needed.
  env._db.prepare('UPDATE num_members SET phone_verified=0 WHERE id=?').run('mem_1');
  assert.equal((await hostFor(env, 'mem_1'))?.hostId, 'h_1');
});

test('an unverified phone never matches — a typed number is not an identity', async () => {
  const env = fresh();
  env._db.prepare('UPDATE num_host_clients SET member_id=NULL WHERE id=?').run('hc_2');
  env._db.prepare('UPDATE num_hosts SET status=? WHERE id=?').run('active', 'h_2');
  assert.equal(await hostFor(env, 'mem_2'), null);
});

test('an ended host, or a removed client, is not anybody\'s host', async () => {
  const env = fresh();
  assert.equal(await hostFor(env, 'mem_2'), null, 'h_2 has status ended');
  env._db.prepare('UPDATE num_host_clients SET status=? WHERE id=?').run('removed', 'hc_1');
  assert.equal(await hostFor(env, 'mem_1'), null);
});

test('no host tables at all (a database the migrations have not reached) is null, not a crash', async () => {
  const env = fresh({ hostTables: false });
  assert.equal(await hostFor(env, 'mem_1'), null);
  assert.deepEqual(await notifyHosts(env), { sent: 0, failed: 0 });
});

test('the prompt block names the host, lists their services, and forbids claiming a confirmation', () => {
  const block = hostBlock({ hostName: 'Priya', services: ['car', 'reservation'] });
  assert.match(block, /PERSONAL HOST/);
  assert.match(block, /Priya/);
  assert.match(block, /a car or transfer, a restaurant reservation/);
  assert.match(block, /offer ONCE/);
  assert.match(block, /ask_host/);
  assert.match(block, /NEVER say Priya has confirmed/);
  assert.equal(hostBlock(null), '', 'no host, no block — the prompt must not mention hosts to a guest without one');
});

test('an ask_host action becomes a NEW request in the host\'s console, in the guest\'s own words', async () => {
  const env = fresh();
  const host = await hostFor(env, 'mem_1');
  const out = await relayToHost(env, {
    memberId: 'mem_1', host, userText: 'can you ask Priya for a car to the airport at 6am friday',
    actions: [
      { type: 'remember', payload: '{"key":"x","value":"y"}' },
      { type: 'ask_host', request: { service_key: 'car', title: 'Car to the airport', detail: 'Friday 06:00 from the hotel', city: 'London', starts_at: '2026-09-11T06:00', party_size: 2 } },
    ],
  });
  assert.equal(out.relayed, 1);
  const r = env._db.prepare('SELECT * FROM num_host_requests').get();
  assert.equal(r.host_id, 'h_1');
  assert.equal(r.client_id, 'hc_1');
  assert.equal(r.service_key, 'car');
  assert.equal(r.status, 'new', 'new until a human in the console says otherwise');
  assert.equal(r.source, 'client', 'the column the watchman keys on');
  assert.equal(r.party_size, 2);
  assert.match(r.detail, /Guest's words: "can you ask Priya/);
  assert.equal(r.host_notified_at, null, 'the writer never emails — the sweep does');
});

test('a service the console does not know is filed as an appointment rather than refused', async () => {
  const env = fresh();
  const host = await hostFor(env, 'mem_1');
  await relayToHost(env, { memberId: 'mem_1', host, actions: [{ type: 'ask_host', payload: JSON.stringify({ service_key: 'helicopter', title: 'Heli to Monaco' }) }] });
  assert.equal(env._db.prepare('SELECT service_key FROM num_host_requests').get().service_key, 'appointment');
  assert.ok(HOST_SERVICES.includes('appointment'));
});

test('nothing to relay, or no host, writes nothing', async () => {
  const env = fresh();
  assert.deepEqual(await relayToHost(env, { memberId: 'mem_1', host: null, actions: [{ type: 'ask_host', request: { title: 'x' } }] }), { relayed: 0, ids: [] });
  assert.deepEqual(await relayToHost(env, { memberId: 'mem_1', host: { hostId: 'h_1', clientId: 'hc_1' }, actions: [{ type: 'remember' }] }), { relayed: 0, ids: [] });
  assert.equal(env._db.prepare('SELECT COUNT(*) n FROM num_host_requests').get().n, 0);
});

test('the watchman tells the host once, by email, and stamps the receipt', async () => {
  const env = fresh();
  const host = await hostFor(env, 'mem_1');
  await relayToHost(env, { memberId: 'mem_1', host, actions: [{ type: 'ask_host', request: { service_key: 'reservation', title: 'Table for 4 at Gymkhana', starts_at: '2026-09-12 20:00', party_size: 4 } }] });
  const sent = [];
  const sendImpl = async (_env, m, opts) => { sent.push({ m, opts }); return { ok: true, via: 'resend', id: 're_1' }; };
  assert.deepEqual(await notifyHosts(env, { sendImpl }), { sent: 1, failed: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].m.to, 'priya@example.com');
  assert.equal(sent[0].opts.audience, 'external', 'a host is outside the company — Resend only, never the internal binding');
  assert.match(sent[0].m.subject, /Dre asked for a restaurant reservation/);
  assert.match(sent[0].m.text, /Table for 4 at Gymkhana/);
  assert.match(sent[0].m.text, /\/host\/\?k=k_priya/);
  assert.match(sent[0].m.text, /nothing has been promised to your client yet/i);
  assert.ok(env._db.prepare('SELECT host_notified_at FROM num_host_requests').get().host_notified_at, 'receipt stamped');
  // Second tick: nothing to do. A retry that mails a host twice about one
  // request is how a useful notification becomes noise they filter.
  assert.deepEqual(await notifyHosts(env, { sendImpl }), { sent: 0, failed: 0 });
  assert.equal(sent.length, 1);
});

test('a host the mailer cannot reach is a named failure on the board, and is retried next tick', async () => {
  const env = fresh();
  env._db.exec(`CREATE TABLE IF NOT EXISTS num_suppressions (email TEXT)`);
  const host = await hostFor(env, 'mem_1');
  await relayToHost(env, { memberId: 'mem_1', host, actions: [{ type: 'ask_host', request: { service_key: 'car', title: 'Car' } }] });
  const sendImpl = async () => ({ ok: false, error: 'RESEND_KEY unset' });
  assert.deepEqual(await notifyHosts(env, { sendImpl }), { sent: 0, failed: 1 });
  assert.equal(env._db.prepare('SELECT host_notified_at FROM num_host_requests').get().host_notified_at, null, 'no receipt for a message nobody accepted');
  const f = (await open(env)).find((x) => x.kind === 'host_request_unsent');
  assert.ok(f, 'the failure ledger has it');
  assert.match(f.subject, /Priya <priya@example.com>/);
});

test('requests the host typed themselves are never emailed back to them', async () => {
  const env = fresh();
  await ensure(env);
  env._db.prepare(`INSERT INTO num_host_requests (id,host_id,client_id,service_key,title,status,source,created_at) VALUES ('hr_own','h_1','hc_1','car','Typed in console','new','host','2026-09-04 00:00:00')`).run();
  const sent = [];
  await notifyHosts(env, { sendImpl: async (_e, m) => { sent.push(m); return { ok: true }; } });
  assert.equal(sent.length, 0);
});

test('the email says what was asked, for whom, and where to act', () => {
  const m = hostRequestEmail({ host: { name: 'Priya' }, request: { service_key: 'stay', title: 'Two nights in Lisbon', detail: 'near Alfama', starts_at: '2026-10-01', party_size: 2 }, client: { name: 'Dre' }, consoleUrl: 'https://itsnum.com/host/?k=abc' });
  assert.equal(m.subject, 'Dre asked for a place to stay');
  assert.match(m.text, /^Priya,/);
  assert.match(m.text, /for 2026-10-01 \(2 people\)/);
  assert.match(m.text, /near Alfama/);
  assert.match(m.text, /https:\/\/itsnum\.com\/host\/\?k=abc/);
});
