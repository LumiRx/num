// The screen after the table.
//
// worker/aftertable.mjs was written, tested, and left with no call sites: no
// guest had ever been asked how it was and `num_ratings` was an empty table
// with an index on it. This file is the path from a scan to those functions,
// so the tests here are about the three things that path can get wrong:
//
//   1. letting somebody rate or tip a booking that is not theirs,
//   2. asking for a tip at a venue that never agreed tips reach its staff,
//   3. giving the guest the impression NUM is taking their money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  issueAfter, resolveAfter, afterState, tipRail, afterToken, AFTER_TTL_S,
  _resetSchemaCache,
} from './aftervisit.mjs';
import { _resetSchemaCache as _resetAfterTable } from '../worker/aftertable.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER = readFileSync(join(HERE, 'worker.js'), 'utf8');

function env({ tips = 0, paylink = null, category = 'Restaurant' } = {}) {
  _resetSchemaCache();
  _resetAfterTable();
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, category TEXT);
    CREATE TABLE num_business_settings (business_id TEXT PRIMARY KEY, f_tips INTEGER DEFAULT 0);
    CREATE TABLE num_paylinks (token TEXT PRIMARY KEY, business_id TEXT, state TEXT,
      one_time INTEGER DEFAULT 0, amount TEXT, created_at TEXT);
    INSERT INTO businesses VALUES ('biz_1','Bang Tao Seafood','${category}');`);
  d.prepare('INSERT INTO num_business_settings (business_id,f_tips) VALUES (?,?)').run('biz_1', tips);
  if (paylink) {
    d.prepare(`INSERT INTO num_paylinks (token,business_id,state,one_time,amount,created_at)
               VALUES (?,?,?,?,?,?)`).run(
      paylink.token, 'biz_1', paylink.state ?? 'active',
      paylink.one_time ?? 0, paylink.amount ?? null, paylink.created_at ?? '2026-01-01');
  }
  const DB = {
    prepare(q) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        run: async () => { d.prepare(q).run(...args.map((v) => v ?? null)); return { meta: {} }; },
        first: async () => d.prepare(q).get(...args.map((v) => v ?? null)) ?? null,
        all: async () => ({ results: d.prepare(q).all(...args.map((v) => v ?? null)) }),
      };
      return stmt;
    },
    batch: async (ss) => { for (const x of ss) await x.run(); return []; },
  };
  return { DB, raw: d };
}

const BOOK = { bookingId: 'bk_1', businessId: 'biz_1', placeId: 'pl_1', memberRef: 'm_1' };

/* ══ the token is the only proof a guest has ════════════════════════════ */

test('a token is long enough that guessing one is not a strategy', () => {
  const t = afterToken();
  assert.ok(t.length >= 20, `token is only ${t.length} characters`);
  // 31 symbols to the power of 22 is a number nobody brute-forces through a
  // rate-limited endpoint, and the alphabet has no 0/o/1/l to misread.
  assert.match(t, /^[a-hj-km-np-z2-9]+$/);
  assert.notEqual(t, afterToken());
});

test('an unknown token resolves to nothing at all', async () => {
  const e = env();
  await issueAfter(e, BOOK);
  assert.equal(await resolveAfter(e, 'zzzzzzzzzzzzzzzzzzzzzz'), null);
});

test('a short or empty token never reaches the database', async () => {
  const e = env();
  for (const bad of ['', null, 'abc', 'x'.repeat(15)]) {
    assert.equal(await resolveAfter(e, bad), null, JSON.stringify(bad));
  }
});

test('a link that rates a restaurant does not still work in November', async () => {
  const e = env();
  const t0 = 1_780_000_000;
  const tok = await issueAfter(e, { ...BOOK, now: t0 });
  assert.equal((await resolveAfter(e, tok, { now: t0 + 3600 })).expired, false);
  assert.equal((await resolveAfter(e, tok, { now: t0 + AFTER_TTL_S + 1 })).expired, true);
  const st = await afterState(e, tok, { now: t0 + AFTER_TTL_S + 1 });
  assert.deepEqual(st, { ok: false, error: 'expired' });
});

test('a second scan of the same booking keeps the link already on the phone', async () => {
  // A guest who scanned twice may have the first link open. Handing out a new
  // token would leave them on a page that still works but is not the one the
  // venue's records point at.
  const e = env();
  const a = await issueAfter(e, BOOK);
  const b = await issueAfter(e, BOOK);
  assert.equal(a, b);
  assert.equal(e.raw.prepare('SELECT COUNT(*) AS n FROM num_after_tokens').get().n, 1);
});

test('issuing never throws into the scan path', async () => {
  // venueArrive calls this after a guest has already been marked as arrived.
  // A missing table must not turn a successful check-in into a 500.
  const broken = { DB: { prepare() { throw new Error('D1 down'); } } };
  assert.equal(await issueAfter(broken, BOOK), null);
  assert.equal(await issueAfter({}, BOOK), null);
  assert.equal(await issueAfter(env(), { bookingId: null }), null);
});

/* ══ tips are the venue's promise, not ours ═════════════════════════════ */

test('a venue that never switched tips on is never presented as taking them', async () => {
  const e = env({ tips: 0 });
  const st = await afterState(e, await issueAfter(e, BOOK));
  assert.equal(st.ok, true);
  assert.equal(st.tips, false);
});

test('a venue that switched tips on is', async () => {
  const e = env({ tips: 1 });
  const st = await afterState(e, await issueAfter(e, BOOK));
  assert.equal(st.tips, true);
});

test('a hotel is never asked for a tip even with the flag set', async () => {
  const e = env({ tips: 1, category: 'Hotel' });
  const st = await afterState(e, await issueAfter(e, BOOK));
  assert.equal(st.tips, false);
});

/* ══ where the money actually goes ══════════════════════════════════════ */

test('a tip is paid on the venue\'s own link, never through NUM', async () => {
  const e = env({ tips: 1, paylink: { token: 'PAYTOK1' } });
  const r = await tipRail(e, 'biz_1');
  assert.equal(r.rail, 'paylink');
  assert.equal(r.url, '/p/PAYTOK1');
});

test('a fixed-amount link is never used for a tip', async () => {
  // It would charge the guest the wrong number — the table's bill, not what
  // they chose to leave.
  const e = env({ tips: 1, paylink: { token: 'FIXED', amount: '450' } });
  assert.deepEqual(await tipRail(e, 'biz_1'), { rail: 'venue', url: null });
});

test('a one-time link is never used for a tip', async () => {
  const e = env({ tips: 1, paylink: { token: 'ONCE', one_time: 1 } });
  assert.deepEqual(await tipRail(e, 'biz_1'), { rail: 'venue', url: null });
});

test('a retired link is never used for a tip', async () => {
  const e = env({ tips: 1, paylink: { token: 'OLD', state: 'revoked' } });
  assert.deepEqual(await tipRail(e, 'biz_1'), { rail: 'venue', url: null });
});

test('no rail is a sentence, not a broken button', async () => {
  const e = env({ tips: 1 });
  const st = await afterState(e, await issueAfter(e, BOOK));
  assert.equal(st.rail.rail, 'venue');
  assert.equal(st.rail.url, null);
  const page = WORKER.slice(WORKER.indexOf('async function afterPage('));
  assert.match(page.slice(0, 4000), /tell your server, or add it to the bill/);
});

/* ══ the wiring ═════════════════════════════════════════════════════════ */

test('the completing scan mints the link and hands it back', () => {
  const fn = WORKER.slice(WORKER.indexOf('async function venueArrive('),
                          WORKER.indexOf('async function venueConfirm('));
  assert.match(fn, /issueAfter\(env, \{/);
  assert.match(fn, /after: afterTok \? "\/a\/" \+ afterTok : null/);
  // Only on the branch that completed a booking. A walk-in with no booking has
  // nothing to rate, and an already-completed scan already got its link.
  const idx = fn.indexOf('issueAfter');
  assert.ok(idx > fn.indexOf('outcome: "completed"'),
    'the link must be minted after the booking is completed, not before');
});

test('the after routes are public and split by method', () => {
  assert.match(WORKER, /p\.startsWith\("\/a\/"\)\) return afterPage/);
  assert.match(WORKER, /p\.startsWith\("\/api\/after\/rate"\) && req\.method === "POST"/);
  assert.match(WORKER, /p\.startsWith\("\/api\/after\/tip"\) && req\.method === "POST"/);
});

test('every after route checks origin and the write routes are rate limited', () => {
  for (const h of ['afterStateRoute', 'afterRateRoute', 'afterTipRoute']) {
    const body = WORKER.slice(WORKER.indexOf(`async function ${h}(`));
    assert.match(body.slice(0, 400), /badOrigin\(req\)/, `${h} skips the origin check`);
  }
  for (const h of ['afterRateRoute', 'afterTipRoute']) {
    const body = WORKER.slice(WORKER.indexOf(`async function ${h}(`));
    assert.match(body.slice(0, 500), /overLimit\("after:"/, `${h} is not rate limited`);
  }
});

test('the tip route re-checks the venue switch on the server', () => {
  // The page hides the prompt when tipping is off. A hidden control is a
  // suggestion; the server is where it becomes a rule.
  const body = WORKER.slice(WORKER.indexOf('async function afterTipRoute('),
                            WORKER.indexOf('async function afterPage('));
  assert.match(body, /if \(!st\.ok \|\| !st\.tips\) return J\(/);
  assert.match(body, /tips_not_offered/);
});

test('the guest is told, in the page, that NUM takes nothing', () => {
  const page = WORKER.slice(WORKER.indexOf('async function afterPage('));
  assert.match(page.slice(0, 5000), /NUM takes nothing from it and never/);
});

test('a rating can never be bought, and the page says so', () => {
  const page = WORKER.slice(WORKER.indexOf('async function afterPage('));
  assert.match(page.slice(0, 5000), /rating can never be bought/);
  // And there is no code path from the tip amount to the rating.
  const body = WORKER.slice(WORKER.indexOf('async function afterTipRoute('),
                            WORKER.indexOf('async function afterPage('));
  assert.doesNotMatch(body, /afterRate|stars/);
});

test('a guest comment is stored as prose, not scrubbed into nonsense', () => {
  // clean() strips punctuation, which would turn "Great — but the terrace was
  // closed?" into something the venue reads as broken.
  const body = WORKER.slice(WORKER.indexOf('async function afterRateRoute('),
                            WORKER.indexOf('async function afterTipRoute('));
  assert.doesNotMatch(body, /clean\(b\.comment/);
  assert.match(body, /String\(b\.comment\)\.slice\(0, 2000\)/);
});

test('the venue name is escaped where it is printed', () => {
  // These names were crawled off the open web. They are not ours and they are
  // not markup.
  const page = WORKER.slice(WORKER.indexOf('async function afterPage('));
  assert.match(page.slice(0, 5000), /esc\(st\.venue\)/);
});
