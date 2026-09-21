// A tiny D1 stand-in over node:sqlite, for tests only. Same surface the
// worker uses: prepare().bind().run()/first()/all(), batch(), exec().
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function d1(schemaFiles = []) {
  const db = new DatabaseSync(':memory:');
  for (const f of schemaFiles) db.exec(readFileSync(f, 'utf8'));
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  function stmt(sql, args = []) {
    return {
      bind: (...a) => stmt(sql, a.map(norm)),
      async run() {
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      async first(col) {
        const row = db.prepare(sql).get(...args);
        if (!row) return null;
        const plain = { ...row };
        return col ? plain[col] : plain;
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })) };
      },
      _run() { return db.prepare(sql).run(...args); },
    };
  }
  return {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => { const r = s._run(); return { success: true, meta: { changes: Number(r.changes) } }; });
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
    raw: db,
  };
}
