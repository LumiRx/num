// "IS IT OPEN" FOR 124,117 MORE PLACES.
//
// 175,304 places carry an hours string; 51,187 had ever been parsed. The rest
// sat as text nobody looked at while guests got `open_now: null` on venues
// whose hours were in the row the whole time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { backfillHours, progress, UNPARSEABLE } from './hoursbackfill.mjs';
import { fromHex, openNow } from './hours.mjs';

function reorder(sql, args) {
  const idx = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  if (!idx.length) return args;
  return idx.map((i) => (args[i - 1] === undefined ? null : args[i - 1]));
}
function d1(db) {
  const wrap = (sql) => {
    const st = { sql, args: [] };
    st.bind = (...a) => { st.args = a; return st; };
    const run = (fn) => fn(db.prepare(st.sql.replace(/\?(\d+)/g, '?')), reorder(st.sql, st.args));
    st.run = async () => ({ meta: { changes: run((s, a) => s.run(...a)).changes } });
    st.first = async () => run((s, a) => s.get(...a)) ?? null;
    st.all = async () => ({ results: run((s, a) => s.all(...a)) });
    return st;
  };
  return { prepare: wrap, batch: async (stmts) => { for (const s of stmts) await s.run(); return []; } };
}
function fresh(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE places (id TEXT PRIMARY KEY, hours TEXT, hours_mask TEXT)');
  const ins = db.prepare('INSERT INTO places VALUES (?,?,?)');
  rows.forEach(([id, hours, mask]) => ins.run(id, hours, mask ?? null));
  return { DB: d1(db), _db: db };
}

test('hours text becomes a mask a guest can be told about', async () => {
  const env = fresh([['a', 'Mo-Su 11:00-23:00'], ['b', 'PH,Mo-Su 00:00-23:59+'], ['c', 'Fr-Sa 13:00-00:00']]);
  const out = await backfillHours(env);
  assert.equal(out.parsed, 3);
  assert.equal(out.refused, 0);
  const a = env._db.prepare('SELECT hours_mask FROM places WHERE id = ?').get('a').hours_mask;
  assert.ok(fromHex(a), 'the stored mask is not readable back');
  assert.notEqual(openNow(a, 'Asia/Bangkok'), null, 'the parsed venue still cannot say whether it is open');
});

test('what the parser refuses is marked, not retried forever', async () => {
  const env = fresh([['x', 'Mo-Su 12:00'], ['y', 'Mon-Fri 9am-5pm']]);
  const out = await backfillHours(env);
  assert.equal(out.refused, 2);
  const x = env._db.prepare('SELECT hours_mask FROM places WHERE id = ?').get('x').hours_mask;
  assert.equal(x, UNPARSEABLE);
  // And every reader still sees "unknown" — never "closed".
  assert.equal(openNow(x, 'Asia/Bangkok'), null);
  assert.equal(fromHex(x), null);
  // Second tick: nothing left to do.
  assert.equal((await backfillHours(env)).done, true);
});

test('already-parsed rows and rows with no hours are never touched', async () => {
  const env = fresh([['keep', 'Mo-Su 09:00-17:00', 'ff'.repeat(21)], ['none', null], ['empty', '']]);
  const out = await backfillHours(env);
  assert.equal(out.scanned, 0);
  assert.equal(env._db.prepare('SELECT hours_mask FROM places WHERE id = ?').get('keep').hours_mask, 'ff'.repeat(21));
});

test('a tick is bounded, and says whether it finished', async () => {
  const env = fresh(Array.from({ length: 7 }, (_, i) => [`p${i}`, 'Mo-Su 10:00-20:00']));
  const first = await backfillHours(env, { limit: 5 });
  assert.equal(first.scanned, 5);
  assert.equal(first.done, false);
  const second = await backfillHours(env, { limit: 5 });
  assert.equal(second.scanned, 2);
  assert.equal(second.done, true);
});

test('progress reports the three states', async () => {
  const env = fresh([['a', 'Mo-Su 11:00-23:00'], ['b', 'Mo-Su 12:00'], ['c', 'x', 'ff'.repeat(21)]]);
  await backfillHours(env);
  assert.deepEqual(await progress(env), { todo: 0, refused: 1, parsed: 2 });
});

test('the cron runs it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(src, /backfillHours\(env\)/, 'the backfill exists and nothing calls it — 124,117 places stay unknown');
});
