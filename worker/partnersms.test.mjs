// Businesses and hosts opting in to text updates.
//
// The thing under test is not "does a boolean get set". It is whether, after
// somebody ticks a box, `reachable()` says yes — because for hosts that has
// been false since migration 0013 and nobody noticed, since a switch wired to
// nothing looks exactly like a switch.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  KIND, SCOPE, PARTNER_CONSENT_TEXT, consentCheckbox, ensure, optIn, optOut, reachable,
} from './partnersms.mjs';

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
const env = { DB: d1(db) };

before(async () => {
  // Created here, not left to the first optIn: beforeEach clears these tables,
  // and a DELETE against a table the module has not built yet is the same
  // class of failure this file exists to catch.
  await ensure(env);
  db.exec(`CREATE TABLE num_sms_consent (
    id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, first_name TEXT,
    consent_text TEXT NOT NULL, consent_version TEXT, page TEXT, ip TEXT,
    user_agent TEXT, country TEXT,
    created_at INTEGER NOT NULL, revoked_at INTEGER)`);
  db.exec(`CREATE TABLE num_optouts (contact_hash TEXT PRIMARY KEY, created_at INTEGER)`);
});
beforeEach(() => {
  db.exec('DELETE FROM num_sms_consent');
  db.exec("DELETE FROM num_partner_sms WHERE 1=1");
});

const ok = { kind: KIND.BUSINESS, partnerId: 'biz_1', phone: '+18186676918', ticked: true };

describe('taking the opt-in', () => {
  test('a ticked box with a number makes the partner reachable', async () => {
    const out = await optIn(env, ok);
    assert.equal(out.ok, true);
    assert.equal(out.optedIn, true);
    const r = await reachable(env, { kind: KIND.BUSINESS, partnerId: 'biz_1' });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.phone, '+18186676918');
  });

  test('an unticked box is a decision, not a failure', async () => {
    const out = await optIn(env, { ...ok, ticked: false });
    assert.equal(out.ok, true, 'declining is not an error to show a person');
    assert.equal(out.optedIn, false);
    assert.equal(out.reason, 'not_ticked');
    const r = await reachable(env, { kind: KIND.BUSINESS, partnerId: 'biz_1' });
    assert.equal(r.ok, false);
  });

  test('ticking with no number is refused, and says which field', async () => {
    // hostintegrity.mjs already reports this as live drift: hosts with text
    // alerts on and nothing to text. Recording consent against nothing is how
    // that list got made.
    const out = await optIn(env, { ...ok, phone: '' });
    assert.equal(out.ok, false);
    assert.equal(out.optedIn, false);
    assert.match(out.error, /number/i);
  });

  test('a number without a country code is never guessed into one', async () => {
    const out = await optIn(env, { ...ok, phone: '818 667 6918' });
    assert.equal(out.ok, false, 'a guessed country code texts a stranger');
  });

  test('hosts and businesses are separate partners, not one namespace', async () => {
    await optIn(env, ok);
    const host = await reachable(env, { kind: KIND.HOST, partnerId: 'biz_1' });
    assert.equal(host.ok, false, 'a business opting in must not opt in a host with the same id');
  });

  test('opting in twice keeps the first consent, not the newest', async () => {
    // The FIRST record is the one that matters if it is ever challenged.
    await optIn(env, ok);
    const first = db.prepare('SELECT created_at, consent_text FROM num_sms_consent').get();
    await optIn(env, { ...ok, page: '/somewhere-else' });
    const after = db.prepare('SELECT created_at, consent_text FROM num_sms_consent').get();
    assert.equal(after.created_at, first.created_at);
    assert.equal(after.consent_text, first.consent_text, 'rewriting the evidence destroys the trail');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_sms_consent').get().n, 1);
  });
});

describe('what gets written down', () => {
  test('the sentence recorded is the sentence shown — not a paraphrase', async () => {
    await optIn(env, ok);
    const row = db.prepare('SELECT consent_text FROM num_sms_consent').get();
    assert.ok(row.consent_text.includes(PARTNER_CONSENT_TEXT),
      'the register has to hold the words they actually read');
    assert.ok(consentCheckbox().includes(PARTNER_CONSENT_TEXT),
      'the label and the record must be one string, or they drift');
  });

  test('the scope is recorded, so nobody has to reconstruct it later', async () => {
    await optIn(env, ok);
    const row = db.prepare('SELECT scope FROM num_partner_sms').get();
    assert.equal(row.scope, SCOPE.UPDATES);
    const consentText = db.prepare('SELECT consent_text FROM num_sms_consent').get().consent_text;
    assert.match(consentText, /business\/updates/,
      'a row that could mean marketing or transactional means neither');
  });

  test('the disclosure carries all five things a disclosure has to carry', () => {
    assert.match(PARTNER_CONSENT_TEXT, /NUM/, 'who is texting');
    assert.match(PARTNER_CONSENT_TEXT, /listing|requests/i, 'what about');
    assert.match(PARTNER_CONSENT_TEXT, /a month|frequen/i, 'how often');
    assert.match(PARTNER_CONSENT_TEXT, /rates may apply/i, 'that it may cost them');
    assert.match(PARTNER_CONSENT_TEXT, /STOP/, 'the way out');
  });

  test('the box is never pre-ticked', () => {
    assert.ok(!consentCheckbox().includes('checked'),
      'a pre-ticked box is not express consent, in any jurisdiction that has looked at it');
  });
});

describe('stopping', () => {
  test('a STOP on the dashboard is a STOP everywhere', async () => {
    await optIn(env, ok);
    await optOut(env, { kind: KIND.BUSINESS, partnerId: 'biz_1' });

    const r = await reachable(env, { kind: KIND.BUSINESS, partnerId: 'biz_1' });
    assert.equal(r.ok, false);
    assert.match(r.why, /opted out/);

    const reg = db.prepare('SELECT revoked_at FROM num_sms_consent WHERE phone = ?').get('+18186676918');
    assert.ok(reg.revoked_at, 'the register did not hear about it, so another sender still would have');
  });

  test('a STOP sent by text is honoured even though the partner row looks fine', async () => {
    await optIn(env, ok);
    // Revoked in the register only — the shape a texted STOP leaves behind.
    db.prepare("UPDATE num_sms_consent SET revoked_at = unixepoch()").run();
    const r = await reachable(env, { kind: KIND.BUSINESS, partnerId: 'biz_1' });
    assert.equal(r.ok, false, 'the partner row alone must never be enough to send');
  });

  test('opting back in after a stop works', async () => {
    await optIn(env, ok);
    await optOut(env, { kind: KIND.BUSINESS, partnerId: 'biz_1' });
    await optIn(env, ok);
    const r = await reachable(env, { kind: KIND.BUSINESS, partnerId: 'biz_1' });
    assert.equal(r.ok, true, r.why);
  });
});

describe('the doors show it', () => {
  test('the business signup form asks', () => {
    const c = src('bizconsole.mjs');
    assert.match(c, /consentCheckbox/, 'a business signs up and is never asked');
  });

  test('the host profile asks with the same words', () => {
    // Compared with whitespace collapsed: the label is wrapped across lines in
    // the HTML, and how it is indented is not what is being tested.
    const flat = (t) => t.replace(/\s+/g, ' ');
    const h = readFileSync(join(HERE, '..', 'public', 'host', 'index.html'), 'utf8');
    assert.ok(flat(h).includes(flat(PARTNER_CONSENT_TEXT)),
      'the host box shows different words from the ones recorded against it');
  });

  test('the growth worker copy has not drifted from this one', () => {
    // growth/worker.js is a separate bundle and cannot import from here, so
    // the sentence is duplicated. Two copies of a legal disclosure that are
    // allowed to differ WILL differ, and the day they do, the register stops
    // holding what the person read.
    const g = readFileSync(join(HERE, '..', 'growth', 'worker.js'), 'utf8');
    const m = /const PARTNER_CONSENT_TEXT =\s*([\s\S]*?);\n/.exec(g);
    assert.ok(m, 'growth/worker.js has no PARTNER_CONSENT_TEXT to compare');
    assert.equal(eval(m[1]), PARTNER_CONSENT_TEXT,
      'the host and business disclosures have drifted apart');
  });

  test('a host ticking the box now reaches the consent register', () => {
    // The bug: since migration 0013 sms_opt_in set a boolean nobody read, and
    // every sender asks num_sms_consent first and fails closed. The box was
    // wired to nothing for a year.
    const g = readFileSync(join(HERE, '..', 'growth', 'worker.js'), 'utf8');
    const save = g.slice(g.indexOf('const smsOptIn ='), g.indexOf('await syncHostAreas'));
    assert.match(save, /INSERT INTO num_sms_consent/,
      'ticking the box still does not record consent, so nothing may be sent');
    assert.match(save, /UPDATE num_sms_consent SET revoked_at/,
      'unticking the box has to travel to the register too');
  });
});
