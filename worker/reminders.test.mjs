/**
 * Reminders (19 Sep 2026): a member's own note that comes back at a time.
 * Driven through handleReminders and sendDueReminders against node:sqlite,
 * so the SQL is the SQL that ships. The push side is notify() — checked
 * here by the num_notifications row it always writes first.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleReminders, sendDueReminders, MIN_AHEAD_MS } from './reminders.mjs';

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
  return {
    prepare(sql) {
      const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) });
      return bound([]);
    },
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
  };
}

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0)');
const env = { DB: d1(db) };

const post = (path, body) => handleReminders(
  new Request(`https://app.itsnum.com/api/reminders${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  env, path,
);
const get = (path, q) => handleReminders(new Request(`https://app.itsnum.com/api/reminders${path}?${new URLSearchParams(q)}`), env, path);
const read = async (res) => ({ status: res.status, body: await res.json() });

await get('/', { me: 'mem_warm' }); // builds the schema (ensured is module-wide)

const inMs = (ms) => new Date(Date.now() + ms).toISOString();

beforeEach(() => {
  db.exec('DELETE FROM num_reminders');
  db.exec('DELETE FROM num_members');
  try { db.exec('DELETE FROM num_notifications'); } catch { /* not built yet */ }
  db.prepare("INSERT INTO num_members (id, name, phone, phone_verified) VALUES ('mem_dre','Dre','+15550001',1)").run();
});

test('set one: it comes back in mine, in due order, with the time it was given', async () => {
  const later = inMs(2 * 3600e3), sooner = inMs(3600e3);
  const a = await read(await post('/', { me: 'mem_dre', text: 'Call the hotel', due_at: later, source: 'voice' }));
  assert.equal(a.status, 200);
  assert.equal(a.body.reminder.text, 'Call the hotel');
  assert.equal(a.body.reminder.source, 'voice');
  assert.equal(a.body.reminder.due_at, later);
  await post('/', { me: 'mem_dre', text: 'Passports', due_at: sooner, plan_id: 'pl_1' });
  const mine = await read(await get('/', { me: 'mem_dre' }));
  assert.deepEqual(mine.body.reminders.map((r) => r.text), ['Passports', 'Call the hotel']);
  assert.equal(mine.body.reminders[0].plan_id, 'pl_1');
});

test('refused: a time already gone, a year and more out, a stranger, a missing field', async () => {
  assert.equal((await post('/', { me: 'mem_dre', text: 'x', due_at: inMs(MIN_AHEAD_MS - 5000) })).status, 400);
  assert.equal((await post('/', { me: 'mem_dre', text: 'x', due_at: inMs(400 * 86400e3) })).status, 400);
  assert.equal((await post('/', { me: 'mem_ghost', text: 'x', due_at: inMs(3600e3) })).status, 404);
  assert.equal((await post('/', { me: 'mem_dre', due_at: inMs(3600e3) })).status, 400);
  assert.equal((await post('/', { me: 'mem_dre', text: 'x', due_at: 'six-ish' })).status, 400);
  assert.equal((await get('/', {})).status, 400);
});

test('cancel: mine only, once, and never after it fired', async () => {
  const a = await read(await post('/', { me: 'mem_dre', text: 'Call the hotel', due_at: inMs(3600e3) }));
  const id = a.body.reminder.id;
  assert.equal((await read(await post('/cancel', { me: 'mem_sam', id }))).body.cancelled, false);
  assert.equal((await read(await post('/cancel', { me: 'mem_dre', id }))).body.cancelled, true);
  assert.equal((await read(await post('/cancel', { me: 'mem_dre', id }))).body.cancelled, false);
  const mine = await read(await get('/', { me: 'mem_dre' }));
  assert.equal(mine.body.reminders.length, 0);
  // Fired ones cannot be cancelled: the buzz has happened.
  const b = await read(await post('/', { me: 'mem_dre', text: 'Gone', due_at: inMs(3600e3) }));
  db.prepare("UPDATE num_reminders SET sent_at = datetime('now') WHERE id = ?").run(b.body.reminder.id);
  assert.equal((await read(await post('/cancel', { me: 'mem_dre', id: b.body.reminder.id }))).body.cancelled, false);
});

test('the cron: due ones go once, each writes a notification, cancelled and future ones wait', async () => {
  const soon = await read(await post('/', { me: 'mem_dre', text: 'Call the hotel', due_at: inMs(90_000) }));
  const later = await read(await post('/', { me: 'mem_dre', text: 'Passports', due_at: inMs(3 * 3600e3) }));
  const gone = await read(await post('/', { me: 'mem_dre', text: 'Nope', due_at: inMs(90_000) }));
  await post('/cancel', { me: 'mem_dre', id: gone.body.reminder.id });

  const now = new Date(Date.now() + 120_000);
  const first = await sendDueReminders(env, { now });
  assert.equal(first.sent, 1);
  const again = await sendDueReminders(env, { now });
  assert.equal(again.sent, 0, 'a reminder buzzes once');

  const rows = db.prepare('SELECT id, sent_at FROM num_reminders ORDER BY due_at').all();
  assert.ok(rows.find((r) => r.id === soon.body.reminder.id).sent_at, 'due one marked sent');
  assert.equal(rows.find((r) => r.id === later.body.reminder.id).sent_at, null, 'future one waits');
  assert.equal(rows.find((r) => r.id === gone.body.reminder.id).sent_at, null, 'cancelled one never fires');

  const notes = db.prepare("SELECT kind, body, tag FROM num_notifications WHERE member_id = 'mem_dre'").all();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'reminder');
  assert.equal(notes[0].body, 'Call the hotel');
  assert.equal(notes[0].tag, 'reminder:' + soon.body.reminder.id);

  // Sent ones still show in mine for a day, so the app can say "reminded you at 6".
  const mine = await read(await get('/', { me: 'mem_dre' }));
  assert.deepEqual(mine.body.reminders.map((r) => r.text), ['Call the hotel', 'Passports']);
});
