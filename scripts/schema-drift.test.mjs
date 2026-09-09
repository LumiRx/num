/**
 * The drift checker, checked.
 *
 * The two production failures this exists to catch are both fixtures below,
 * reproduced exactly: a column declared inside a CREATE TABLE IF NOT EXISTS
 * that a live database never got, and a column added by a later ALTER.
 *
 * The negative cases matter as much. A checker that fires on a comment, on a
 * CHECK constraint, or on a column the database has and the migrations do not,
 * is a checker everyone learns to scroll past.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredColumns, drift, RETIRED } from './schema-drift.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'worker', 'migrations');
const live = (o) => new Map(Object.entries(o).map(([t, c]) => [t, new Set(c)]));

test('columns in a CREATE TABLE are declared', () => {
  const d = declaredColumns([`CREATE TABLE IF NOT EXISTS t (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      booking_fee_minor INTEGER NOT NULL DEFAULT 0
    );`]);
  assert.deepEqual([...d.get('t')].sort(), ['booking_fee_minor', 'host_id', 'id']);
});

test('a table-level constraint is not mistaken for a column', () => {
  const d = declaredColumns([`CREATE TABLE t (
      id TEXT PRIMARY KEY,
      kind TEXT,
      PRIMARY KEY (id),
      UNIQUE (kind),
      CHECK (kind IN ('a','b','c')),
      CONSTRAINT ck CHECK (id <> '')
    );`]);
  assert.deepEqual([...d.get('t')].sort(), ['id', 'kind']);
});

test('a comma inside a CHECK does not split a column in half', () => {
  // CHECK (status IN ('new','sent','done')) carries commas that are not
  // column boundaries. Splitting naively invents columns called "'sent'".
  const d = declaredColumns([`CREATE TABLE t (
      id TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','sent','done')),
      note TEXT
    );`]);
  assert.deepEqual([...d.get('t')].sort(), ['id', 'note', 'status']);
});

test('a column named only inside a comment is prose, not schema', () => {
  const d = declaredColumns([`
    -- booking_fee_minor used to live here and was removed on 7 Sep 2026
    /* also mentions ghost_column in a block comment */
    CREATE TABLE t (id TEXT);`]);
  assert.deepEqual([...d.get('t')], ['id']);
});

test('ALTER TABLE ADD COLUMN is declared too', () => {
  const d = declaredColumns([
    'CREATE TABLE t (id TEXT);',
    'ALTER TABLE t ADD COLUMN requires_proof INTEGER NOT NULL DEFAULT 0;',
  ]);
  assert.deepEqual([...d.get('t')].sort(), ['id', 'requires_proof']);
});

test('THE REAL BUG: a column the live database never got is reported', () => {
  // num_host_requests existed before 0014 ran, so its CREATE TABLE IF NOT
  // EXISTS was a no-op and booking_fee_minor only ever reached fresh
  // databases. Every call to /api/host/requests 500'd for weeks.
  const d = declaredColumns([
    'CREATE TABLE IF NOT EXISTS num_host_requests (id TEXT, host_id TEXT, booking_fee_minor INTEGER DEFAULT 0);',
  ]);
  const found = drift(d, live({ num_host_requests: ['id', 'host_id'] }));
  assert.deepEqual(found, [{ table: 'num_host_requests', missing: ['booking_fee_minor'] }]);
});

test('a whole missing table is reported as such', () => {
  const d = declaredColumns(['CREATE TABLE num_jobs (id TEXT);']);
  assert.deepEqual(drift(d, live({})), [{ table: 'num_jobs', missing: null }]);
});

test('a database that matches reports nothing', () => {
  const d = declaredColumns(['CREATE TABLE t (id TEXT, name TEXT);']);
  assert.deepEqual(drift(d, live({ t: ['id', 'name'] })), []);
});

test('extra columns in the database are NOT reported', () => {
  // Another worker, an older migration or a hand-run ALTER can legitimately
  // put a column there. Reporting those trains everyone to ignore the output,
  // and then the real one scrolls past too.
  const d = declaredColumns(['CREATE TABLE t (id TEXT);']);
  assert.deepEqual(drift(d, live({ t: ['id', 'legacy_col', 'another'] })), []);
});

test('case never causes a false alarm', () => {
  const d = declaredColumns(['CREATE TABLE t (ID TEXT, Host_Id TEXT);']);
  assert.deepEqual(drift(d, live({ t: ['id', 'host_id'] })), []);
});

test('the LIVE stored schema parses exactly — comments, CHECKs, ALTERs and all', () => {
  // This is the real sqlite_master.sql for num_host_requests, copied from
  // production. It is the hardest input this parser will ever see:
  //   - inline "--" comments, one containing an em dash
  //   - CHECK (status IN ('new','drafted',...)) with commas that are not
  //     column boundaries
  //   - seven columns appended by ALTER, which SQLite splices onto the end of
  //     the stored CREATE TABLE after a bare newline and comma
  //   - no trailing semicolon
  //
  // The checker reads the live side through this same parser, so if it drifts
  // the comparison silently starts agreeing with itself about the wrong thing.
  const stored = `CREATE TABLE num_host_requests (
  id             TEXT PRIMARY KEY,
  host_id        TEXT NOT NULL,
  service_key    TEXT NOT NULL,             -- car|reservation|stay|activity
  starts_at      TEXT,                      -- ISO8601 local to the request
  quote_only     INTEGER NOT NULL DEFAULT 0 CHECK (quote_only IN (0,1)),
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','drafted','awaiting_host','confirmed','declined','done','cancelled')),
  -- Host-to-host: set when this request is fulfilled by ANOTHER host's
  -- service. The client never learns this \u2014 the two hosts settle between them.
  network_host_id TEXT,
  network_fee_minor INTEGER NOT NULL DEFAULT 0,  -- NUM's flat fee
  confirmed_at   TEXT
, source TEXT NOT NULL DEFAULT 'host', host_notified_at TEXT, booking_fee_minor INTEGER NOT NULL DEFAULT 0)`;

  const d = declaredColumns([stored.trim().replace(/;?$/, ';')]);
  assert.deepEqual([...d.get('num_host_requests')].sort(), [
    'booking_fee_minor', 'confirmed_at', 'host_id', 'host_notified_at', 'id',
    'network_fee_minor', 'network_host_id', 'quote_only', 'service_key',
    'source', 'starts_at', 'status',
  ]);
});

test('a table SQLite has rebuilt, and therefore quoted, is still found', () => {
  // This one cost a false alarm on a real deploy. SQLite writes
  // CREATE TABLE "name" when a table has been rebuilt, and the parser skipped
  // every quoted name — so num_business_settings, which was plainly in
  // production, was reported as a whole missing table.
  //
  // A checker that cries wolf about a table you can see with your own eyes is
  // worse than no checker, because the next real finding gets waved away too.
  const d = declaredColumns(['CREATE TABLE "num_business_settings" (\n  business_id TEXT PRIMARY KEY,\n  f_bookings INTEGER\n);']);
  assert.ok(d.has('num_business_settings'), 'a quoted table name was skipped');
  assert.deepEqual([...d.get('num_business_settings')].sort(), ['business_id', 'f_bookings']);
  assert.deepEqual(drift(d, live({ num_business_settings: ['business_id', 'f_bookings'] })), []);
});

test('a column added by a quoted ALTER is found too', () => {
  const d = declaredColumns([
    'CREATE TABLE `t` (id TEXT);',
    'ALTER TABLE "t" ADD COLUMN "note" TEXT;',
  ]);
  assert.deepEqual([...d.get('t')].sort(), ['id', 'note']);
});

test('a retired declaration is not reported, and its reason is stated', () => {
  // 0004 declared a dispatch design that 0019 replaced. Nothing references
  // those tables, they will never be applied, and reporting them every deploy
  // trains everyone to scroll past the output.
  const d = declaredColumns([
    'CREATE TABLE IF NOT EXISTS num_dispatch_requests (id TEXT);',
    'CREATE TABLE IF NOT EXISTS num_jobs (id TEXT);',
  ]);
  const found = drift(d, live({ num_jobs: ['id'] }));
  assert.deepEqual(found, [], 'a retired table was reported as drift');
  for (const [t, why] of Object.entries(RETIRED)) {
    assert.ok(why.length > 30, `${t} is retired without a stated reason`);
  }
});

test('a table missing from BOTH the database and the retired list IS reported', () => {
  // The rule that keeps the retired list honest: silence has to be a decision
  // somebody wrote down, never a default.
  const d = declaredColumns(['CREATE TABLE num_something_new (id TEXT);']);
  assert.deepEqual(drift(d, live({})), [{ table: 'num_something_new', missing: null }]);
});

test('the real migrations parse, and every host table is covered', () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length > 10, 'the migrations directory looks wrong');
  const d = declaredColumns(files.map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')));

  // The tables today's outages lived in.
  assert.ok(d.has('num_host_requests'), 'num_host_requests is not declared anywhere');
  assert.ok(d.get('num_host_requests').has('booking_fee_minor'),
    'the column that caused the 500 is no longer declared — the ALTER has been lost');
  assert.ok(d.has('num_host_areas'), 'num_host_areas is not declared anywhere');
  assert.ok(d.get('num_host_areas').has('lat') && d.get('num_host_areas').has('lng'),
    'coverage coordinates are not declared');
  assert.ok(d.has('num_jobs') && d.get('num_jobs').has('settle_status'),
    'the supplier layer is not declared');

  // Nothing absurd got parsed out of the SQL.
  for (const [table, cols] of d) {
    for (const c of cols) {
      assert.match(c, /^[a-z_][a-z0-9_]*$/, `${table}.${c} is not a column name`);
    }
  }
});
