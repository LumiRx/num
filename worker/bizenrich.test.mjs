// Filling in a listing without putting words in a business's mouth.
//
// The property that matters most here is a refusal: a search engine's opening
// hours never reach a listing on their own. bizonboard.mjs calls hours "the
// single thing that matters most… the detail people act on", and a stale panel
// hour sends a traveller to a locked door that NUM told them to walk to. An
// empty field costs a business nothing; a wrong one costs it a guest.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  enrich, pendingFor, decide, declinedFields, enrichSweep, fromJsonLd,
  TRUSTED_TO_APPLY, FIELD_LABEL,
} from './bizenrich.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: st.all(...args), success: true };
      st.run(...args); return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = { DB: d1(db), SERPAPI_KEY: 'test-key' };

/** A site that publishes proper LocalBusiness markup, and a panel that lies. */
const OWN_SITE_HTML = `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Restaurant',
  name: 'Suay Restaurant', telephone: '+66 76 000 111',
  url: 'https://suay.example',
  address: { '@type': 'PostalAddress', streetAddress: '50 Takua Pa Rd', addressLocality: 'Phuket Town', postalCode: '83000' },
  openingHours: ['Mo-Sa 17:00-23:00', 'Su 17:00-22:00'],
  servesCuisine: 'Modern Thai',
})}</script></head><body>Suay</body></html>`;

const fakeFetch = ({ site = OWN_SITE_HTML, panel = {} } = {}) => async (url) => {
  if (String(url).includes('serpapi.com')) {
    return { ok: true, json: async () => ({ knowledge_graph: panel }) };
  }
  if (site === null) return { ok: false, status: 404, text: async () => '' };
  return { ok: true, text: async () => site };
};

before(() => {
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, dest TEXT, country TEXT,
    phone TEXT, website TEXT, address TEXT, hours TEXT, cuisine TEXT)`);
  db.exec(`CREATE TABLE num_place_owners (place_id TEXT PRIMARY KEY, business_id TEXT,
    verified_at TEXT, revoked_at TEXT)`);
  db.exec(`CREATE TABLE num_business_field_proposals (id TEXT PRIMARY KEY, business_id TEXT NOT NULL,
    place_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL,
    evidence TEXT, state TEXT NOT NULL DEFAULT 'proposed', decided_by TEXT, decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
});

beforeEach(() => {
  for (const t of ['places', 'num_place_owners', 'num_business_field_proposals']) db.exec(`DELETE FROM ${t}`);
  db.exec(`INSERT INTO places (id,name,dest,country,website) VALUES
    ('pl_suay','Suay Restaurant','phuket','TH','https://suay.example')`);
  db.exec(`INSERT INTO num_place_owners (place_id,business_id,verified_at) VALUES ('pl_suay','biz_1','2026-08-01')`);
});

describe('reading a business own website', () => {
  test('LocalBusiness markup becomes real fields', () => {
    const out = fromJsonLd(OWN_SITE_HTML);
    assert.equal(out.phone, '+66 76 000 111');
    assert.equal(out.address, '50 Takua Pa Rd, Phuket Town, 83000');
    assert.equal(out.hours, 'Mo-Sa 17:00-23:00; Su 17:00-22:00');
    assert.equal(out.cuisine, 'Modern Thai');
  });

  test('an Organization is not a venue — its address is often a head office', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Organization', name: 'Suay Group', telephone: '+66 2 999 9999',
      address: { streetAddress: '1 Head Office Rd', addressLocality: 'Bangkok' },
    })}</script>`;
    assert.deepEqual(fromJsonLd(html), {},
      'a head office address would be given to a traveller as the restaurant');
  });

  test('unreadable or absent markup is nothing, never a guess from the visible text', () => {
    assert.deepEqual(fromJsonLd('<html><body>Open daily 5pm til late! Call 076 000111</body></html>'), {});
    assert.deepEqual(fromJsonLd('<script type="application/ld+json">{not json</script>'), {});
    assert.deepEqual(fromJsonLd(''), {});
    assert.deepEqual(fromJsonLd(null), {});
  });

  test('an opening-hours shape it cannot read for certain is skipped, not approximated', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Restaurant', name: 'X', openingHours: { weird: true },
    })}</script>`;
    assert.equal(fromJsonLd(html).hours, undefined);
  });
});

describe('what may write, and what must ask', () => {
  test('only the business own site can write unattended', () => {
    assert.deepEqual([...TRUSTED_TO_APPLY], ['own_site'],
      'a source was added to the set that writes to live listings without asking');
  });

  test('their own published details land in empty fields', async () => {
    const out = await enrich(env, 'biz_1', { fetchImpl: fakeFetch() });
    const fields = out.applied.map((a) => a.field).sort();
    assert.deepEqual(fields, ['address', 'cuisine', 'hours', 'phone']);
    const row = db.prepare("SELECT * FROM places WHERE id='pl_suay'").get();
    assert.equal(row.hours, 'Mo-Sa 17:00-23:00; Su 17:00-22:00');
    assert.equal(row.phone, '+66 76 000 111');
  });

  test('a search panel NEVER writes hours on its own — it asks', async () => {
    db.exec("UPDATE places SET website = NULL WHERE id = 'pl_suay'"); // no own site to read
    const out = await enrich(env, 'biz_1', {
      fetchImpl: fakeFetch({ panel: { hours: { monday: '09:00-17:00' }, phone: '+66 76 999 999' } }),
    });
    assert.deepEqual(out.applied, [], 'a knowledge panel wrote straight to a live listing');
    assert.ok(out.proposed.some((p) => p.field === 'hours'));
    const row = db.prepare("SELECT hours, phone FROM places WHERE id='pl_suay'").get();
    assert.equal(row.hours, null, 'a traveller would have been sent on unverified hours');
    assert.equal(row.phone, null);
  });

  test('nothing overwrites what the owner already wrote', async () => {
    db.exec("UPDATE places SET hours = 'Daily 18:00-01:00 (holiday hours)' WHERE id='pl_suay'");
    await enrich(env, 'biz_1', { fetchImpl: fakeFetch() });
    assert.equal(db.prepare("SELECT hours FROM places WHERE id='pl_suay'").get().hours,
      'Daily 18:00-01:00 (holiday hours)',
      'an owner had their own hours reverted by a crawler');
  });

  test('a dead website is a null, not a crash and not an empty value written in', async () => {
    const out = await enrich(env, 'biz_1', { fetchImpl: fakeFetch({ site: null, panel: {} }) });
    assert.deepEqual(out.applied, []);
    assert.equal(db.prepare("SELECT hours FROM places WHERE id='pl_suay'").get().hours, null);
  });

  test('a business with no listing is skipped rather than half-processed', async () => {
    const out = await enrich(env, 'biz_nope', { fetchImpl: fakeFetch() });
    assert.equal(out.skipped, 'no listing');
  });
});

describe('the owner answer', () => {
  test('accepting writes it; declining keeps it off and stops us asking again', async () => {
    db.exec("UPDATE places SET website = NULL WHERE id = 'pl_suay'");
    await enrich(env, 'biz_1', { fetchImpl: fakeFetch({ panel: { phone: '+66 76 999 999', address: '9 Wrong Rd' } }) });
    const open = await pendingFor(env, 'biz_1');
    assert.equal(open.length, 2);
    assert.ok(open.every((p) => p.label && FIELD_LABEL[p.field] === p.label));

    const phone = open.find((p) => p.field === 'phone');
    assert.equal((await decide(env, { id: phone.id, accept: true })).ok, true);
    assert.equal(db.prepare("SELECT phone FROM places WHERE id='pl_suay'").get().phone, '+66 76 999 999');

    const addr = open.find((p) => p.field === 'address');
    await decide(env, { id: addr.id, accept: false });
    assert.equal(db.prepare("SELECT address FROM places WHERE id='pl_suay'").get().address, null);
    assert.ok((await declinedFields(env, 'biz_1')).has('address'));

    // And the next sweep must not ask again — a page that re-asks a question
    // you already answered is one you learn to dismiss.
    await enrich(env, 'biz_1', { fetchImpl: fakeFetch({ panel: { address: '9 Wrong Rd' } }) });
    assert.equal((await pendingFor(env, 'biz_1')).some((p) => p.field === 'address'), false);
  });

  test('answering twice is refused rather than applied twice', async () => {
    db.exec("UPDATE places SET website = NULL WHERE id = 'pl_suay'");
    await enrich(env, 'biz_1', { fetchImpl: fakeFetch({ panel: { phone: '+66 1' } }) });
    const [p] = await pendingFor(env, 'biz_1');
    assert.equal((await decide(env, { id: p.id, accept: true })).ok, true);
    assert.equal((await decide(env, { id: p.id, accept: true })).ok, false);
  });

  test('a sweep never stacks duplicate questions for the same field', async () => {
    db.exec("UPDATE places SET website = NULL WHERE id = 'pl_suay'");
    for (let i = 0; i < 3; i++) {
      await enrich(env, 'biz_1', { fetchImpl: fakeFetch({ panel: { phone: '+66 76 999 999' } }) });
    }
    assert.equal((await pendingFor(env, 'biz_1')).filter((p) => p.field === 'phone').length, 1);
  });
});

describe('the sweep', () => {
  test('it only visits listings that actually have holes, and is capped', async () => {
    db.exec(`INSERT INTO places (id,name,dest,phone,address,hours) VALUES
      ('pl_full','Complete','phuket','+66 1','1 Rd','Daily')`);
    db.exec(`INSERT INTO num_place_owners (place_id,business_id,verified_at) VALUES ('pl_full','biz_full','2026-08-01')`);
    const out = await enrichSweep(env, { limit: 10, fetchImpl: fakeFetch() });
    assert.equal(out.seen, 1, 'a complete listing was re-fetched for nothing');
  });

  test('a business looked at this week is not looked at again — each visit is metered', async () => {
    await enrichSweep(env, { limit: 10, fetchImpl: fakeFetch() });
    const second = await enrichSweep(env, { limit: 10, fetchImpl: fakeFetch() });
    assert.equal(second.seen, 0);
  });
});
