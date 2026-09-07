// The other half of a promise we made in writing.
//
// bizsubmit tells an owner, on their screen: "we will email you the moment
// your listing is live." Promoting the submission wrote the places row and
// returned JSON to the admin who pressed the button. Nobody told the person
// who filled in the form.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { goLiveEmail, goLiveSweep, untold } from './bizgolive.mjs';
import { SUBMISSION_STATE } from './bizsubmit.mjs';

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
const env = { DB: d1(db), BIZ_ONBOARD_EMAIL: 'on', NUM_APP_ORIGIN: 'https://app.itsnum.com' };

before(() => {
  db.exec(`CREATE TABLE num_place_submissions (id TEXT PRIMARY KEY, name TEXT, email TEXT,
    status TEXT NOT NULL DEFAULT 'new', place_id TEXT, created_at TEXT, reviewed_at TEXT,
    golive_at TEXT, golive_ref TEXT)`);
  db.exec(`CREATE TABLE num_biz_signin_links (token_hash TEXT PRIMARY KEY, place_id TEXT NOT NULL,
    business_id TEXT, purpose TEXT, expires_at TEXT NOT NULL, used_at TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
});

beforeEach(() => {
  db.exec('DELETE FROM num_place_submissions');
  db.exec('DELETE FROM num_biz_signin_links');
  db.exec(`INSERT INTO num_place_submissions (id,name,email,status,place_id,created_at) VALUES
    ('sub_1','Baan Rim Nam','owner@baanrimnam.example','promoted','p_abc','2026-09-01')`);
});

const ok = () => { const sent = []; return { sent, mailer: async (_e, m) => { sent.push(m); return { ok: true, id: 'msg_1' }; } }; };

describe('the message', () => {
  test('it says the three things true of THEM today, and promises nothing else', () => {
    const { subject, text } = goLiveEmail({ business: 'Baan Rim Nam', contact: 'Nok', signinLink: 'https://x/t' });
    assert.match(subject, /Baan Rim Nam is live/);
    assert.match(text, /Hi Nok,/);
    assert.match(text, /https:\/\/x\/t/);
    assert.match(text, /opening hours/i, 'it does not say the one thing worth doing first');
    // The same refusals as the onboarding email: the desk returns 503 and
    // num_paylinks is empty, so neither may be promised here.
    assert.ok(!/we will send you (bookings|reservations)/i.test(text));
    assert.ok(!/take payment|QR/i.test(text));
    assert.ok(!/\d+%/.test(text), 'a fee figure in a first email is a contract dispute later');
    assert.match(text, /for sale at any price/i);
  });

  test('a duplicate is told plainly it was already there, and why that is better', () => {
    const { subject, text } = goLiveEmail({ business: 'Baan Rim Nam', duplicate: true });
    assert.match(subject, /already had a listing/i);
    assert.match(text, /rather than making a second copy/i);
    assert.match(text, /older/, 'it does not explain why the old listing is the better one');
  });

  test('a missing sign-in link falls back to the console rather than sending nothing', () => {
    const { text } = goLiveEmail({ business: 'X' });
    assert.match(text, /app\.itsnum\.com\/api\/biz\/console/);
    assert.ok(!/undefined|null/.test(text));
  });

  test('a single-use link is described as single-use, so a forward is not a surprise', () => {
    const { text } = goLiveEmail({ business: 'X', signinLink: 'https://x/t' });
    assert.match(text, /works once/i);
  });
});

describe('the sweep', () => {
  test('it tells a promoted business, once', async () => {
    const { sent, mailer } = ok();
    const out = await goLiveSweep(env, { mailer });
    assert.equal(out.sent, 1);
    assert.equal(sent[0].to, 'owner@baanrimnam.example');
    const again = await goLiveSweep(env, { mailer });
    assert.equal(again.sent, 0, 'a business was told twice');
  });

  test('a FAILED send is never recorded as delivered — this is how Fingal was lost', async () => {
    const failing = async () => ({ ok: false, error: 'resend down' });
    const out = await goLiveSweep(env, { mailer: failing });
    assert.equal(out.failed, 1);
    assert.equal(db.prepare("SELECT golive_at FROM num_place_submissions WHERE id='sub_1'").get().golive_at, null);
    // And it retries when the mailer comes back, rather than being skipped forever.
    const { mailer } = ok();
    assert.equal((await goLiveSweep(env, { mailer })).sent, 1);
  });

  test('nothing reaches a business until the switch is thrown', async () => {
    const { sent, mailer } = ok();
    const out = await goLiveSweep({ ...env, BIZ_ONBOARD_EMAIL: undefined }, { mailer });
    assert.equal(out.sent, 0);
    assert.match(out.skipped, /BIZ_ONBOARD_EMAIL/);
    assert.equal(sent.length, 0);
  });

  test('a submission still in review, or with no email, is left alone', async () => {
    db.exec(`INSERT INTO num_place_submissions (id,name,email,status,place_id,created_at) VALUES
      ('sub_2','Still Reviewing','a@b.example','geocoded',NULL,'2026-09-01'),
      ('sub_3','No Email',NULL,'promoted','p_def','2026-09-01')`);
    const { sent, mailer } = ok();
    await goLiveSweep(env, { mailer });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'owner@baanrimnam.example');
  });

  test('the email carries a real single-use link, minted per send', async () => {
    const { sent, mailer } = ok();
    await goLiveSweep(env, { mailer });
    assert.match(sent[0].text, /\/api\/biz\/console\?t=[0-9a-f]{64}/);
    const row = db.prepare('SELECT place_id, purpose FROM num_biz_signin_links').get();
    assert.equal(row.place_id, 'p_abc');
    assert.equal(row.purpose, 'golive');
  });

  test('it goes out as external mail only — a binding that reaches nobody must not "accept" it', async () => {
    let opts = null;
    await goLiveSweep(env, { mailer: async (_e, _m, o) => { opts = o; return { ok: true }; } });
    assert.equal(opts?.audience, 'external');
  });

  test('who is live and still in the dark is answerable', async () => {
    assert.equal((await untold(env)).length, 1);
    const { mailer } = ok();
    await goLiveSweep(env, { mailer });
    assert.equal((await untold(env)).length, 0);
  });
});

describe('the promise and the keeping of it', () => {
  test('what bizsubmit promised is what bizgolive delivers', () => {
    assert.match(SUBMISSION_STATE.new, /email you the moment your listing is live/i);
    assert.match(src('bizgolive.mjs'), /goLiveSweep/);
  });

  test('the cron runs it, in its own failure domain', () => {
    const idx = src('index.mjs');
    assert.match(idx, /goLiveSweep\(env\)/, 'a listing goes live and nobody is told');
    assert.match(idx, /go-live email\(s\) failed/, 'a failure to tell anybody is silent');
  });
});
