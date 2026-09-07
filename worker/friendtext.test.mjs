// NUM texts your friend the plan — with every rule that keeps it lawful and
// welcome pinned: a verified human asks, one invite per plan per number,
// caps, STOP honoured before anything, follow-ups only to people who wrote
// back, delivery tracked rather than assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { textInvite, textPlanUpdate, textingAvailable, handleTextInvite, LIMITS } from './friendtext.mjs';
import { recordStop, recordStart, optedOut } from './optout.mjs';

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
function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE num_invite_links (token TEXT PRIMARY KEY, code TEXT, sender_id TEXT, sender_name TEXT, to_phone TEXT, to_name TEXT, message TEXT, channel TEXT, sent_at TEXT)`);
  db.exec(`CREATE TABLE num_links (id TEXT PRIMARY KEY, a_id TEXT, b_id TEXT, b_phone TEXT, token TEXT, plan_id TEXT, state TEXT DEFAULT 'pending')`);
  db.exec(`CREATE TABLE num_plans (id TEXT PRIMARY KEY, title TEXT)`);
  db.exec(`CREATE TABLE num_sms_consent (id TEXT PRIMARY KEY, phone TEXT UNIQUE, revoked_at INTEGER)`);
  db.exec(`INSERT INTO num_members VALUES ('m_dre','Dre','+13105550100',1), ('m_anon','Nobody','+13105550101',0)`);
  db.exec(`INSERT INTO num_plans VALUES ('p1','Phi Phi weekend')`);
  db.exec(`INSERT INTO num_invite_links VALUES ('tok1','YT2P6J','m_dre','Dre','+447700900123','Sam','Sam — it''s Dre. I started “Phi Phi weekend” on NUM: https://app.itsnum.com/i/tok1','share',NULL)`);
  db.exec(`INSERT INTO num_links VALUES ('l1','m_dre',NULL,'+447700900123','tok1','p1','pending')`);
  db.exec(`INSERT INTO num_invite_links VALUES ('tok_nophone','YT2P6J','m_dre','Dre',NULL,'Alex','hi','share',NULL)`);
  db.exec(`INSERT INTO num_invite_links VALUES ('tok_anon','ZZZZZZ','m_anon','Nobody','+447700900555','Kim','hi','share',NULL)`);
  const env = { DB: d1(db), _db: db, TWILIO_SID: 'AC' + 'a'.repeat(32), TWILIO_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'b'.repeat(32) };
  return env;
}
function twilio(calls, { ok = true } = {}) {
  return async (url, init) => {
    calls.push({ url, params: Object.fromEntries(new URLSearchParams(init.body)) });
    return ok
      ? { ok: true, status: 201, json: async () => ({ sid: 'SM' + calls.length }), text: async () => '' }
      : { ok: false, status: 400, json: async () => ({}), text: async () => 'bad number' };
  };
}

test('a verified member can have NUM text the invite; the message names them and carries STOP', async () => {
  const env = fresh(); const calls = [];
  const out = await textInvite(env, { token: 'tok1', from: 'm_dre', fetchImpl: twilio(calls) });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.To, '+447700900123');
  assert.equal(calls[0].params.MessagingServiceSid, 'MG' + 'b'.repeat(32), 'A2P approval comes through the Messaging Service, never a bare From');
  assert.match(calls[0].params.Body, /it's Dre\. I started/);
  assert.match(calls[0].params.Body, /Sent by NUM for Dre\. Reply STOP to opt out\.$/);
  assert.match(calls[0].params.StatusCallback, /\/api\/sms\/status$/, 'delivery is tracked, not assumed');
  const row = env._db.prepare('SELECT * FROM num_friend_texts').get();
  assert.equal(row.kind, 'invite'); assert.equal(row.plan_id, 'p1'); assert.equal(row.message_sid, 'SM1');
  assert.equal(env._db.prepare('SELECT channel FROM num_invite_links WHERE token=?').get('tok1').channel, 'num_sms');
  assert.equal(out.to, '+447…23', 'the app is shown a masked number, never the full one back');
});

test('an unverified sender cannot make NUM text anyone', async () => {
  const env = fresh(); const calls = [];
  const out = await textInvite(env, { token: 'tok_anon', from: 'm_anon', fetchImpl: twilio(calls) });
  assert.equal(out.ok, false); assert.equal(out.status, 403);
  assert.equal(calls.length, 0);
});

test('somebody else\'s token, or an invite with no number, is refused', async () => {
  const env = fresh(); const calls = [];
  assert.equal((await textInvite(env, { token: 'tok1', from: 'm_anon', fetchImpl: twilio(calls) })).status, 404);
  assert.equal((await textInvite(env, { token: 'tok_nophone', from: 'm_dre', fetchImpl: twilio(calls) })).status, 400);
  assert.equal(calls.length, 0);
});

test('one invite per token: a second tap does not text them twice', async () => {
  const env = fresh(); const calls = [];
  await textInvite(env, { token: 'tok1', from: 'm_dre', fetchImpl: twilio(calls) });
  const again = await textInvite(env, { token: 'tok1', from: 'm_dre', fetchImpl: twilio(calls) });
  assert.equal(again.ok, true); assert.equal(again.already, true);
  assert.equal(calls.length, 1);
});

test('one invite per plan per number, whoever sends it', async () => {
  const env = fresh(); const calls = [];
  env._db.exec(`INSERT INTO num_members VALUES ('m_viv','Vivian','+13105550102',1)`);
  env._db.exec(`INSERT INTO num_invite_links VALUES ('tok2','VIVCODE','m_viv','Vivian','+447700900123','Sam','hi again','share',NULL)`);
  env._db.exec(`INSERT INTO num_links VALUES ('l2','m_viv',NULL,'+447700900123','tok2','p1','pending')`);
  await textInvite(env, { token: 'tok1', from: 'm_dre', fetchImpl: twilio(calls) });
  const second = await textInvite(env, { token: 'tok2', from: 'm_viv', fetchImpl: twilio(calls) });
  assert.equal(second.status, 409);
  assert.equal(calls.length, 1);
});

test('STOP is honoured before anything else, even from a number we never held consent for', async () => {
  const env = fresh(); const calls = [];
  assert.equal(await optedOut(env, '+447700900123'), false);
  await recordStop(env, '+447700900123', { evidence: 'STOP' });
  assert.equal(await optedOut(env, '+447700900123'), true);
  const out = await textInvite(env, { token: 'tok1', from: 'm_dre', fetchImpl: twilio(calls) });
  assert.equal(out.status, 403); assert.match(out.error, /asked not to be texted/);
  assert.equal(calls.length, 0);
  await recordStart(env, '+447700900123');
  assert.equal(await optedOut(env, '+447700900123'), false);
});

test('a revocation recorded in the consent register counts too', async () => {
  const env = fresh();
  env._db.exec(`INSERT INTO num_sms_consent VALUES ('c1','+447700900123',1700000000)`);
  assert.equal(await optedOut(env, '+447700900123'), true);
});

test('caps: a sender gets twenty a day; a number gets three invites a month', async () => {
  const env = fresh(); const calls = [];
  const { ensure } = await import('./friendtext.mjs'); await ensure(env);
  for (let i = 0; i < LIMITS.senderPerDay; i++) {
    env._db.prepare(`INSERT INTO num_friend_texts (id,kind,token,plan_id,sender_id,to_phone,body) VALUES (?,?,?,?,?,?,?)`)
      .run('ft' + i, 'invite', 't' + i, 'px' + i, 'm_dre', '+4477009001' + String(i).padStart(2, '0'), 'x');
  }
  const capped = await textInvite(env, { token: 'tok1', from: 'm_dre', fetchImpl: twilio(calls) });
  assert.equal(capped.status, 429); assert.match(capped.error, /20 today/);
  env._db.exec('DELETE FROM num_friend_texts');
  for (let i = 0; i < LIMITS.recipientInvitesPer30d; i++) {
    env._db.prepare(`INSERT INTO num_friend_texts (id,kind,token,plan_id,sender_id,to_phone,body) VALUES (?,?,?,?,?,?,?)`)
      .run('fr' + i, 'invite', 'q' + i, 'py' + i, 'm_other' + i, '+447700900123', 'x');
  }
  const tired = await textInvite(env, { token: 'tok1', from: 'm_dre', fetchImpl: twilio(calls) });
  assert.equal(tired.status, 429); assert.match(tired.error, /a few invites this month/);
  assert.equal(calls.length, 0);
});

test('Twilio refusing the send is reported as not sent — nothing is recorded as texted', async () => {
  const env = fresh(); const calls = [];
  const out = await textInvite(env, { token: 'tok1', from: 'm_dre', fetchImpl: twilio(calls, { ok: false }) });
  assert.equal(out.ok, false); assert.equal(out.status, 503); assert.match(out.error, /twilio 400/);
  assert.equal(env._db.prepare('SELECT COUNT(*) n FROM num_friend_texts').get().n, 0);
  assert.equal(env._db.prepare('SELECT channel FROM num_invite_links WHERE token=?').get('tok1').channel, 'share');
});

test('texting switched off (no Twilio) is a plain 503, and the app is told up front', async () => {
  const env = fresh(); delete env.TWILIO_MESSAGING_SERVICE_SID;
  const out = await textInvite(env, { token: 'tok1', from: 'm_dre' });
  assert.equal(out.status, 503); assert.match(out.error, /not switched on/);
  assert.equal(textingAvailable(env, { phone_verified: 1 }), false);
  assert.equal(textingAvailable(fresh(), { phone_verified: 1 }), true);
  assert.equal(textingAvailable(fresh(), { phone_verified: 0 }), false);
});

test('plan updates reach ONLY friends who wrote back, at most once per six hours', async () => {
  const env = fresh(); const calls = [];
  // Sam has not replied; Jo has.
  env._db.exec(`INSERT INTO num_links VALUES ('l3','m_dre',NULL,'+447700900777','tok3','p1','pending')`);
  const consented = new Set(['+447700900777']);
  const args = { planId: 'p1', kind: 'item_added', summary: 'Dre added Boat day, Sat 08:00', byName: 'Dre', fetchImpl: twilio(calls), consentCheck: async (p) => consented.has(p) };
  let out = await textPlanUpdate(env, args);
  assert.deepEqual(out, { sent: 1, skipped: 1 });
  assert.equal(calls[0].params.To, '+447700900777');
  assert.match(calls[0].params.Body, /Dre updated “Phi Phi weekend”: Dre added Boat day/);
  assert.match(calls[0].params.Body, /app\.itsnum\.com\/i\/tok3/);
  assert.match(calls[0].params.Body, /Reply STOP to opt out\.$/);
  out = await textPlanUpdate(env, args);
  assert.deepEqual(out, { sent: 0, skipped: 2 }, 'six-hour gap: three changes in an hour are one text, not three');
  // A kind that is not worth a text sends nothing.
  out = await textPlanUpdate(env, { ...args, kind: 'joined' });
  assert.deepEqual(out, { sent: 0, skipped: 0 });
  assert.equal(calls.length, 1);
});

test('a friend who said STOP after consenting gets no update', async () => {
  const env = fresh(); const calls = [];
  await recordStop(env, '+447700900123');
  const out = await textPlanUpdate(env, { planId: 'p1', kind: 'booked', summary: 'x', byName: 'Dre', fetchImpl: twilio(calls), consentCheck: async () => true });
  assert.deepEqual(out, { sent: 0, skipped: 1 });
  assert.equal(calls.length, 0);
});

test('the HTTP shape: status follows the outcome, body never carries the full number', async () => {
  const env = fresh();
  const req = new Request('https://app.itsnum.com/api/social/invite/text', { method: 'POST', body: JSON.stringify({ token: 'tok_nophone', from: 'm_dre' }) });
  const res = await handleTextInvite(env, req);
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.ok, false); assert.equal('status' in j, false);
});
