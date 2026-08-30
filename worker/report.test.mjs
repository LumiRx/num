/**
 * Reporting — Apple guideline 1.2.
 *
 * Num carries user-generated content between members: direct messages
 * (`num_dms`), comments on shared plans (`planComment`), and the name, bio and
 * avatar a friend can see. Guideline 1.2 asks a UGC app for four things:
 * filtering, a way to REPORT, a way to block, and published contact details.
 *
 * We had three. Blocking works and is enforced on every path that writes a
 * friendship row (worker/block.test.mjs); the contact address is published in
 * the privacy policy. There was no report — while `docs/store-submission-
 * checklist.md` §C told App Review "report/block via the shield icon in chat".
 * There was no shield icon either. A reviewer who reads that goes looking,
 * finds nothing, and has cause to doubt every other claim in the notes.
 *
 * Real SQLite, real handler, real Requests — same approach as
 * bookdesk.wiring.test.mjs, for the same reason: the properties here are
 * decided by which row a WHERE clause finds.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleAccount } from './account.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: stmt.all(...args), success: true };
      stmt.run(...args);
      return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
    },
  });
  return { prepare: (sql) => ({ bind: (...args) => shape(sql, args), ...shape(sql, []) }) };
}

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE IF NOT EXISTS num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS num_links (id TEXT PRIMARY KEY, a_id TEXT, b_id TEXT, state TEXT)`);
db.exec(`INSERT INTO num_members (id, name) VALUES ('mem_alice','Alice'), ('mem_bob','Bob'), ('mem_carol','Carol')`);
db.exec(`INSERT INTO num_links (id, a_id, b_id, state) VALUES ('lnk_1','mem_alice','mem_bob','accepted')`);

const env = { DB: d1(db) };

const post = async (path, body) => {
  const res = await handleAccount(
    new Request(`https://app.itsnum.com/api/account${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    env, path,
  );
  return { status: res.status, body: await res.json() };
};

const reports = () => db.prepare('SELECT * FROM num_reports').all();
const blocks = () => db.prepare('SELECT * FROM num_blocks').all();

describe('a member can report another member', () => {
  test('the endpoint exists at all', async () => {
    const { status } = await post('/report', { me: 'mem_alice', id: 'mem_bob', reason: 'harassment' });
    assert.notEqual(status, 404, 'there is no report endpoint — guideline 1.2 is unmet');
  });

  test('a report is recorded with its reason', async () => {
    const { status, body } = await post('/report', { me: 'mem_carol', id: 'mem_bob', reason: 'harassment', note: 'threats in DMs' });
    assert.equal(status, 200);
    assert.equal(body.reported, true);
    const r = reports().find((x) => x.reporter_id === 'mem_carol');
    assert.ok(r, 'nothing was written to the report register');
    assert.equal(r.reason, 'harassment');
    assert.equal(r.note, 'threats in DMs');
    assert.equal(r.state, 'open', 'a new report must land open, or nobody works it');
  });

  test('reporting twice does not stack duplicate open cases', async () => {
    const before = reports().length;
    await post('/report', { me: 'mem_alice', id: 'mem_bob', reason: 'harassment' });
    await post('/report', { me: 'mem_alice', id: 'mem_bob', reason: 'harassment' });
    assert.equal(reports().length, before, 'a repeated report created another open row');
  });

  test('coming back with more detail updates the case rather than losing it', async () => {
    // Somebody reports, then it gets worse and they report again with more to
    // say. One case, latest detail — dropping the second note would discard
    // exactly what a moderator most needs.
    await post('/report', { me: 'mem_alice', id: 'mem_bob', reason: 'harassment' });
    await post('/report', { me: 'mem_alice', id: 'mem_bob', reason: 'harassment', note: 'it escalated overnight' });
    const r = reports().find((x) => x.reporter_id === 'mem_alice' && x.subject_id === 'mem_bob');
    assert.equal(r.note, 'it escalated overnight', 'the added detail was thrown away');
  });

  test('an empty follow-up never wipes a note already given', async () => {
    await post('/report', { me: 'mem_alice', id: 'mem_bob', reason: 'harassment' });
    const r = reports().find((x) => x.reporter_id === 'mem_alice' && x.subject_id === 'mem_bob');
    assert.equal(r.note, 'it escalated overnight', 'a bare re-report erased the detail');
  });

  test('an invented reason is refused', async () => {
    // The reason drives triage. Free-text reasons make the queue unsortable.
    const { status } = await post('/report', { me: 'mem_alice', id: 'mem_bob', reason: 'because-i-said-so' });
    assert.equal(status, 400);
  });

  test('you cannot report yourself', async () => {
    const { status } = await post('/report', { me: 'mem_alice', id: 'mem_alice', reason: 'spam' });
    assert.equal(status, 400);
  });

  test('a report naming a stranger is refused, not filed', async () => {
    const before = reports().length;
    const { status } = await post('/report', { me: 'mem_alice', id: 'mem_nobody', reason: 'spam' });
    assert.equal(status, 404);
    assert.equal(reports().length, before, 'a report against a non-existent member reached the queue');
  });
});

describe('report and block are separate acts, offered together', () => {
  test('reporting without block leaves the friendship alone', async () => {
    assert.equal(blocks().length, 0);
    const { body } = await post('/report', { me: 'mem_bob', id: 'mem_alice', reason: 'spam' });
    assert.equal(body.blocked, false);
    assert.equal(blocks().length, 0, 'a plain report blocked somebody who did not ask for it');
  });

  test('report with block writes the same block every other path consults', async () => {
    const { body } = await post('/report', { me: 'mem_bob', id: 'mem_alice', reason: 'harassment', block: true });
    assert.equal(body.blocked, true);
    const b = blocks().find((x) => x.member_id === 'mem_bob' && x.blocked_id === 'mem_alice');
    assert.ok(b, 'the block was reported as done but never written — invite() would let them back in');
  });

  test('a blocking report also severs the link', async () => {
    const left = db.prepare("SELECT * FROM num_links WHERE (a_id='mem_alice' AND b_id='mem_bob') OR (a_id='mem_bob' AND b_id='mem_alice')").all();
    assert.equal(left.length, 0, 'they are still connected after a report-and-block');
  });
});

describe('the person reported is never told', () => {
  test('the response carries nothing that could reach the subject', async () => {
    const { body } = await post('/report', { me: 'mem_alice', id: 'mem_bob', reason: 'impersonation' });
    const text = JSON.stringify(body).toLowerCase();
    assert.ok(!text.includes('notified'), 'the response implies the subject was told');
    assert.match(body.note ?? '', /review/i, 'the person reporting is not told what happens next');
  });
});
