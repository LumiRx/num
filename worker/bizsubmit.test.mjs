// A business NUM has never heard of, getting in.
//
// The gap this closes: all three claim doors require a `places` row before
// anything can happen, and `places` — 2.5M rows off OSM and Google — is not
// everyone. The public /claim/ form learned to handle that in August. The
// self-serve /business/ console, which is the door new businesses are actually
// pointed at, still answered "no listing found" and stopped.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { validate, submit, statusOf, SUBMISSION_STATE } from './bizsubmit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), 'utf8');

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
      st.run(...args); return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes ?? 0) } }),
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const db = new DatabaseSync(':memory:');
const alerts = [];
const env = { DB: d1(db), ALERT_WEBHOOK: null };

before(() => {
  db.exec(`CREATE TABLE num_place_submissions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_local TEXT, lang TEXT, address TEXT,
    website TEXT, category TEXT, phone TEXT, email TEXT, country TEXT, dest TEXT,
    lat REAL, lng REAL, claim_id INTEGER,
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new','geocoded','promoted','duplicate','rejected')),
    place_id TEXT, review_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT)`);
});
beforeEach(() => { db.exec('DELETE FROM num_place_submissions'); alerts.length = 0; });

const good = {
  name: 'Baan Rim Nam', address: '12 Soi Romanee, Phuket Old Town',
  email: 'owner@baanrimnam.example',
};

describe('what a submission must carry', () => {
  test('a name alone is not a business — it is a word', () => {
    const out = validate({ name: 'Baan Rim Nam' });
    assert.equal(out.ok, false);
    assert.match(out.error, /address/i);
  });

  test('no way to reach them means nobody can ever be told it went live', () => {
    const out = validate({ name: 'Baan Rim Nam', address: '12 Soi Romanee' });
    assert.equal(out.ok, false);
    assert.match(out.error, /email or a phone/i);
  });

  test('either an email or a phone is enough — we do not demand both', () => {
    assert.equal(validate({ ...good, email: null, phone: '+66 76 000 111' }).ok, true);
    assert.equal(validate({ ...good, phone: null }).ok, true);
  });

  test('a name in the owner own script survives exactly as typed', () => {
    // A great many businesses have two names — one on the sign, one for
    // foreigners. Holding only the second means NUM answers a Thai guest with
    // a name they have never seen.
    const out = validate({ ...good, name_local: 'บ้านริมน้ำ' });
    assert.equal(out.value.name_local, 'บ้านริมน้ำ');
  });

  test('a website without a scheme is still a website', () => {
    assert.match(validate({ ...good, website: 'baanrimnam.example' }).value.website, /^https:\/\//);
    assert.equal(validate({ ...good, website: 'not a url at all !!' }).value.website, null);
  });

  test('a made-up email is dropped rather than stored as contactable', () => {
    const out = validate({ ...good, email: 'definitely-not-an-email', phone: '+66 1' });
    assert.equal(out.value.email, null);
  });
});

describe('recording it', () => {
  test('it lands in the review queue, never in places', async () => {
    const out = await submit(env, good);
    assert.equal(out.ok, true);
    assert.equal(out.status, 'new');
    const row = db.prepare('SELECT * FROM num_place_submissions').get();
    assert.equal(row.name, 'Baan Rim Nam');
    assert.equal(row.lat, null, 'a typed address is not coordinates');
    assert.equal(row.place_id, null);
  });

  test('pressing the button twice is not a mistake worth a red message', async () => {
    const first = await submit(env, good);
    const second = await submit(env, good);
    assert.equal(second.ok, true);
    assert.equal(second.already, true);
    assert.equal(second.id, first.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_place_submissions').get().n, 1);
  });

  test('two branches of one chain are two businesses', async () => {
    await submit(env, good);
    await submit(env, { ...good, address: '9 Thalang Road, Phuket Old Town' });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_place_submissions').get().n, 2,
      'a chain owner was told their second branch was a duplicate of their first');
  });

  test('every state says what happens next, not just what it is called', () => {
    for (const [state, text] of Object.entries(SUBMISSION_STATE)) {
      assert.ok(text.length > 40, `${state} is too short to tell anyone anything`);
      assert.ok(!/^pending/i.test(text), `${state} says "pending", which answers nothing`);
    }
    assert.match(SUBMISSION_STATE.new, /couple of days|email you/i,
      'the first state does not say when or how they hear back');
  });

  test('an owner can read their own submission back', async () => {
    const { id } = await submit(env, good);
    const st = await statusOf(env, id);
    assert.equal(st.name, 'Baan Rim Nam');
    assert.equal(st.message, SUBMISSION_STATE.new);
    assert.equal(await statusOf(env, 'sub_nope'), null);
  });

  test('an alert that cannot send never loses the submission', async () => {
    // The alert path is best-effort by design. A business that told us it
    // exists must be recorded even if every notification channel is down —
    // that is the exact shape of the August failure.
    const broken = { DB: env.DB, get ALERT_WEBHOOK() { throw new Error('down'); } };
    const out = await submit(broken, good);
    assert.equal(out.ok, true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_place_submissions').get().n, 1);
  });
});

describe('the door offers it', () => {
  test('an empty search offers to add the business instead of stopping', () => {
    const c = src('bizconsole.mjs');
    assert.match(c, /addYourBusiness/, 'the console has no add-a-business path');
    assert.match(c, /action" value="submit"/);
    // And it has to be on the results page too — the right listing may not be
    // among the ones we did find.
    assert.match(c, /None of these is you\?/);
  });

  test('the console never writes a submission straight into places', () => {
    const c = src('bizconsole.mjs');
    const block = c.slice(c.indexOf("action === 'submit'"), c.indexOf("action === 'confirm'"));
    assert.ok(!/INSERT INTO places/i.test(block),
      'a typed address would go into the index the concierge searches by proximity');
  });
});
