// The Num Expert paperwork, against a real SQLite.
//
// The rule this file protects: NUM NEVER HOLDS A TAXPAYER NUMBER. A W-9
// carries an SSN, and the schema has no column for one. These tests assert
// that, because the tempting shortcut — "just store the TIN so the 1099 run is
// easier" — is one migration away and would turn any ordinary incident into a
// notifiable breach in most US states.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  W9_URL, W9_ABOUT, NEC_THRESHOLD_USD, NDA_VERSION, MAX_UPLOAD_BYTES, ALLOWED_TYPES,
  ndaBody, sha256Hex, packFor, docsComplete, signNda, receiveW9, review,
} from './expertdocs.mjs';

const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
const SCHEMA = read('./migrations/0006_scouts.sql') + '\n' + read('./migrations/0030_expert_docs.sql');
const SCHEMA_REF = read('./migrations/0032_scout_referrals.sql') + '\n' + read('./migrations/0030_expert_docs.sql');

function makeEnv({ bucket = true } = {}) {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.exec(SCHEMA_REF);
  d.exec(`INSERT INTO num_scout_terms (version, body, effective_at) VALUES ('v1','T','2026-08-01')`);
  d.exec(`INSERT INTO num_scouts (id,name,email,email_lc,code,country,terms_version,agreed_at)
          VALUES ('sc1','Isaiah Farmer','z@n.test','z@n.test','FARMER','US','v1','2026-09-15')`);
  d.exec(`INSERT INTO num_scouts (id,name,email,email_lc,code,country,terms_version,agreed_at)
          VALUES ('sc2','Amara Obi','a@n.test','a@n.test','AMARA','KE','v1','2026-09-15')`);
  const put = [];
  const prep = (sql) => {
    let args = [];
    const api = {
      bind: (...a) => { args = a; return api; },
      first: async () => d.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: d.prepare(sql).all(...args) }),
      run: async () => { const r = d.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    };
    return api;
  };
  return {
    DB: { prepare: prep, batch: async () => {} },
    PHOTOS: bucket ? { put: async (k, b, o) => { put.push({ k, size: b.length ?? b.byteLength, o }); } } : undefined,
    _raw: d,
    _put: put,
  };
}

const NOW = new Date('2026-09-15T12:00:00Z');

describe('the correction: a W-9 is not a 1099', () => {
  test('the pack asks for a W-9, which is what lets Num pay them', () => {
    const src = read('./expertdocs.mjs');
    assert.match(src, /A \*\*W-9\*\* is what THEY fill in/);
    assert.match(src, /A \*\*1099-NEC\*\* is what NUM sends THEM/);
    assert.match(src, /Nobody signs a 1099/);
  });

  test('the reporting threshold is $2,000, not the $600 everybody remembers', () => {
    // Raised for tax years beginning after 2025 by the One Big Beautiful Bill.
    assert.equal(NEC_THRESHOLD_USD, 2000);
  });

  test('and the threshold lives in one place so prose cannot drift from it', async () => {
    const env = makeEnv();
    const pack = await packFor(env, 'sc1');
    assert.match(pack.tax.why, new RegExp(`\\$${NEC_THRESHOLD_USD}`));
    assert.match(pack.tax.why, /It is not the 1099/);
  });
});

describe('Num does not copy a government form', () => {
  test('the W-9 is linked from irs.gov and nowhere else', async () => {
    const env = makeEnv();
    const pack = await packFor(env, 'sc1');
    assert.equal(pack.tax.url, W9_URL);
    assert.equal(new URL(W9_URL).host, 'www.irs.gov');
    assert.equal(new URL(W9_ABOUT).host, 'www.irs.gov');
  });

  test('every link in the file is https and on an IRS host', () => {
    const src = read('./expertdocs.mjs');
    for (const l of src.match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
      assert.match(l, /^https:\/\//, l);
      assert.equal(new URL(l).host, 'www.irs.gov', l);
    }
  });

  test('and it says out loud that Num hosts no copy', async () => {
    const env = makeEnv();
    const pack = await packFor(env, 'sc1');
    assert.match(pack.tax.how, /never will/);
  });

  test('somebody outside the US is not handed the wrong form', async () => {
    // A Kenyan Expert files a W-8 series form, which is a different form and a
    // different conversation.
    const env = makeEnv();
    const pack = await packFor(env, 'sc2');
    assert.equal(pack.tax.url, null);
    assert.match(pack.tax.how, /wrong form for you/);
  });
});

describe('the taxpayer number never enters Num', () => {
  test('the table has no column that could hold one', () => {
    const env = makeEnv();
    const cols = env._raw.prepare('PRAGMA table_info(num_expert_docs)').all().map((c) => c.name.toLowerCase());
    for (const bad of ['tin', 'ssn', 'ein', 'tax_id', 'taxpayer_id', 'social']) {
      assert.equal(cols.includes(bad), false, `num_expert_docs has a ${bad} column`);
    }
  });

  test('nothing in the module reads inside the uploaded file', () => {
    const src = read('./expertdocs.mjs');
    for (const bad of ['parse', 'ocr', 'extractText', 'pdfjs']) {
      assert.equal(new RegExp(`\\b${bad}\\b`).test(src), false, `the module ${bad}s the W-9`);
    }
  });

  test('the file is stored under a key, never a url', () => {
    const env = makeEnv();
    const cols = env._raw.prepare('PRAGMA table_info(num_expert_docs)').all().map((c) => c.name);
    assert.ok(cols.includes('object_key'));
    assert.equal(cols.includes('object_url'), false);
  });

  test('the key is unguessable and namespaced away from anything public', async () => {
    const env = makeEnv();
    await receiveW9(env, { scoutId: 'sc1', bytes: new Uint8Array(200), contentType: 'application/pdf', now: NOW });
    assert.match(env._put[0].k, /^expert-tax\/sc1\/[0-9a-f-]{36}$/);
  });

  test('the Expert is told where their form goes', async () => {
    const env = makeEnv();
    const pack = await packFor(env, 'sc1');
    assert.match(pack.tax.privacy, /never copied into Num’s database/);
  });
});

describe('signing the NDA in the browser', () => {
  test('a typed name is the signature and the exact text is hashed', async () => {
    // ESIGN needs intent, consent, and a record tying the signature to the
    // document. The hash is that record — a later edit to the template cannot
    // silently change what somebody agreed to.
    const env = makeEnv();
    const r = await signNda(env, { scoutId: 'sc1', typedName: 'Isaiah Farmer', now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.state, 'signed');
    assert.equal(r.hash, await sha256Hex(ndaBody({ name: 'Isaiah Farmer', date: '2026-09-15' })));
  });

  test('the hash changes if the template changes', async () => {
    const a = await sha256Hex(ndaBody({ name: 'A', date: '2026-09-15' }));
    const b = await sha256Hex(ndaBody({ name: 'A', date: '2026-09-16' }));
    assert.notEqual(a, b);
  });

  test('signing with somebody else’s name is not a signature', async () => {
    const env = makeEnv();
    const r = await signNda(env, { scoutId: 'sc1', typedName: 'Dre', now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.why, /sign with the name on your account/);
  });

  test('punctuation and case are forgiven, because people are not consistent', async () => {
    const env = makeEnv();
    const r = await signNda(env, { scoutId: 'sc1', typedName: '  isaiah farmer.  ', now: NOW });
    assert.equal(r.ok, true);
  });

  test('an empty signature is refused', async () => {
    const env = makeEnv();
    assert.equal((await signNda(env, { scoutId: 'sc1', typedName: '   ', now: NOW })).ok, false);
  });

  test('the ip and browser are kept, because that is the rest of the record', async () => {
    const env = makeEnv();
    await signNda(env, { scoutId: 'sc1', typedName: 'Isaiah Farmer', ip: '203.0.113.7', ua: 'Safari', now: NOW });
    const row = env._raw.prepare("SELECT * FROM num_expert_docs WHERE scout_id='sc1' AND kind='nda'").get();
    assert.equal(row.signed_ip, '203.0.113.7');
    assert.equal(row.signed_ua, 'Safari');
    assert.equal(row.doc_version, NDA_VERSION);
  });

  test('re-signing replaces the record and clears a rejection', async () => {
    const env = makeEnv();
    await signNda(env, { scoutId: 'sc1', typedName: 'Isaiah Farmer', now: NOW });
    await review(env, { scoutId: 'sc1', kind: 'nda', accept: false, reason: 'illegible', now: NOW });
    await signNda(env, { scoutId: 'sc1', typedName: 'Isaiah Farmer', now: NOW });
    const row = env._raw.prepare("SELECT * FROM num_expert_docs WHERE scout_id='sc1' AND kind='nda'").get();
    assert.equal(row.state, 'signed');
    assert.equal(row.reject_reason, null);
  });

  test('the NDA covers the thing that actually matters — other people’s data', () => {
    const body = ndaBody({ name: 'X', date: '2026-09-15' });
    assert.match(body, /Member and business data/);
    assert.match(body, /has no expiry/);
  });

  test('and is short enough that somebody will read it', () => {
    const body = ndaBody({ name: 'X', date: '2026-09-15' });
    assert.ok(body.length < 2500, 'nobody reads four pages before walking a street');
  });
});

describe('taking the file', () => {
  test('a pdf is accepted', async () => {
    const env = makeEnv();
    const r = await receiveW9(env, { scoutId: 'sc1', bytes: new Uint8Array(500), contentType: 'application/pdf', now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.state, 'uploaded');
  });

  test('a photo of the signed form is accepted, because that is what people send', async () => {
    const env = makeEnv();
    for (const t of ALLOWED_TYPES) {
      const e = makeEnv();
      assert.equal((await receiveW9(e, { scoutId: 'sc1', bytes: new Uint8Array(100), contentType: t, now: NOW })).ok, true, t);
    }
  });

  test('a content-type with a charset still works', async () => {
    const env = makeEnv();
    const r = await receiveW9(env, { scoutId: 'sc1', bytes: new Uint8Array(100), contentType: 'application/pdf; charset=binary', now: NOW });
    assert.equal(r.ok, true);
  });

  test('anything else is refused', async () => {
    const env = makeEnv();
    for (const t of ['text/html', 'application/zip', 'application/x-msdownload', '']) {
      assert.equal((await receiveW9(env, { scoutId: 'sc1', bytes: new Uint8Array(100), contentType: t, now: NOW })).ok, false, t);
    }
  });

  test('an empty file is refused rather than recorded', async () => {
    const env = makeEnv();
    assert.equal((await receiveW9(env, { scoutId: 'sc1', bytes: new Uint8Array(0), contentType: 'application/pdf' })).ok, false);
  });

  test('an oversized file is refused', async () => {
    const env = makeEnv();
    const r = await receiveW9(env, { scoutId: 'sc1', bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1), contentType: 'application/pdf' });
    assert.equal(r.ok, false);
    assert.match(r.why, /too big/);
  });

  test('with no bucket bound it refuses rather than claiming a form arrived', async () => {
    // Recording an upload that did not happen is how somebody waits three
    // weeks for a payment that was never going to come.
    const env = makeEnv({ bucket: false });
    const r = await receiveW9(env, { scoutId: 'sc1', bytes: new Uint8Array(100), contentType: 'application/pdf' });
    assert.equal(r.ok, false);
    assert.equal(env._raw.prepare("SELECT COUNT(*) n FROM num_expert_docs WHERE kind='w9'").get().n, 0);
  });
});

describe('what the paperwork gates', () => {
  test('nothing is payable until both documents are accepted', async () => {
    const env = makeEnv();
    assert.equal(await docsComplete(env, 'sc1'), false);
    await signNda(env, { scoutId: 'sc1', typedName: 'Isaiah Farmer', now: NOW });
    await review(env, { scoutId: 'sc1', kind: 'nda', accept: true, now: NOW });
    assert.equal(await docsComplete(env, 'sc1'), false, 'the NDA alone was enough');
    await receiveW9(env, { scoutId: 'sc1', bytes: new Uint8Array(100), contentType: 'application/pdf', now: NOW });
    await review(env, { scoutId: 'sc1', kind: 'w9', accept: true, now: NOW });
    assert.equal(await docsComplete(env, 'sc1'), true);
  });

  test('signed is not accepted — a person still looks at it', async () => {
    const env = makeEnv();
    await signNda(env, { scoutId: 'sc1', typedName: 'Isaiah Farmer', now: NOW });
    await receiveW9(env, { scoutId: 'sc1', bytes: new Uint8Array(100), contentType: 'application/pdf', now: NOW });
    assert.equal(await docsComplete(env, 'sc1'), false);
  });

  test('a rejection takes payability away again', async () => {
    const env = makeEnv();
    await signNda(env, { scoutId: 'sc1', typedName: 'Isaiah Farmer', now: NOW });
    await review(env, { scoutId: 'sc1', kind: 'nda', accept: true, now: NOW });
    await receiveW9(env, { scoutId: 'sc1', bytes: new Uint8Array(100), contentType: 'application/pdf', now: NOW });
    await review(env, { scoutId: 'sc1', kind: 'w9', accept: true, now: NOW });
    assert.equal(await docsComplete(env, 'sc1'), true);
    await review(env, { scoutId: 'sc1', kind: 'w9', accept: false, reason: 'unsigned', now: NOW });
    assert.equal(await docsComplete(env, 'sc1'), false);
  });

  test('the dashboard says earnings continue even while paperwork is outstanding', async () => {
    // Blocking accrual would punish somebody for a form. Blocking payment is
    // what the form is for.
    const src = read('./scouts.mjs');
    assert.match(src, /Earnings ACCRUE while it is outstanding/);
    assert.match(src, /You still earn — nothing is lost/);
  });

  test('reviewing a document nobody submitted changes nothing', async () => {
    const env = makeEnv();
    assert.equal((await review(env, { scoutId: 'sc1', kind: 'nda', accept: true })).ok, false);
  });

  test('an unknown document kind is refused', async () => {
    const env = makeEnv();
    assert.equal((await review(env, { scoutId: 'sc1', kind: 'passport', accept: true })).ok, false);
  });
});

describe('the schema will not hold a half-built shape', () => {
  test('an NDA cannot carry a file', () => {
    const env = makeEnv();
    assert.throws(() => env._raw.exec(
      `INSERT INTO num_expert_docs (id,scout_id,kind,object_key) VALUES ('d','sc1','nda','k')`));
  });

  test('a W-9 cannot carry a typed signature', () => {
    const env = makeEnv();
    assert.throws(() => env._raw.exec(
      `INSERT INTO num_expert_docs (id,scout_id,kind,signed_name) VALUES ('d','sc1','w9','X')`));
  });

  test('nothing reaches a terminal state without its evidence', () => {
    const env = makeEnv();
    assert.throws(() => env._raw.exec(
      `INSERT INTO num_expert_docs (id,scout_id,kind,state) VALUES ('d','sc1','nda','signed')`));
    assert.throws(() => env._raw.exec(
      `INSERT INTO num_expert_docs (id,scout_id,kind,state) VALUES ('e','sc1','w9','uploaded')`));
  });

  test('one live row per document per Expert', () => {
    const env = makeEnv();
    env._raw.exec(`INSERT INTO num_expert_docs (id,scout_id,kind) VALUES ('d','sc1','nda')`);
    assert.throws(() => env._raw.exec(`INSERT INTO num_expert_docs (id,scout_id,kind) VALUES ('e','sc1','nda')`));
  });
});
