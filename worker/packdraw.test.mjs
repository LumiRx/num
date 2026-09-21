// Entering the Friday draw by texting a code.
//
// The two failures worth guarding: entering somebody who only asked a question
// with the word in it, and telling somebody they are in when the write failed.
// The second is the expensive one — a member who believes they entered and is
// absent from the draw is worse off than one who was told nothing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  ENTRY_CODE, NEEDS_ACCOUNT_REPLY, entryCount, entryReply, isEntry,
  recordEntry, weekKeyFor,
} from './packdraw.mjs';

const M23 = readFileSync(new URL('./migrations/0023_giveaway.sql', import.meta.url), 'utf8');
const M26 = readFileSync(new URL('./migrations/0026_giveaway_entrant_key.sql', import.meta.url), 'utf8');

/* The REAL migration schema, and a harness that lets a bad statement throw.
   The version this replaces caught every error and returned null or an empty
   list — which is how `no such column: week_key` passed its tests and failed
   in production on every single in-app entry. A test harness that hides a
   schema error is testing a database nobody has. */
function db() {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0);');
  for (const raw of (M23 + '\n' + M26).split(';')) {
    const stmt = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (stmt) d.exec(stmt + ';');
  }
  const DB = {
    prepare(sql) {
      const b = [];
      const api = {
        bind(...a) { b.push(...a); return api; },
        async first() { return d.prepare(sql).get(...b) ?? null; },
        async all() { return { results: d.prepare(sql).all(...b) }; },
        async run() { const r = d.prepare(sql).run(...b); return { meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
    async batch(st) { const o = []; for (const s of st) o.push(await s.run()); return o; },
  };
  return { d, env: { DB } };
}

describe('what counts as an entry', () => {
  test('the code, however it is typed', () => {
    for (const t of ['PACKS', 'packs', 'Packs', ' packs ', 'PACKS!', '"packs"', 'packs?', '  Packs.  ']) {
      assert.equal(isEntry(t), true, `${JSON.stringify(t)} should enter`);
    }
  });

  test('a QUESTION containing the word does not enter anybody', () => {
    // These are real questions about the thing we just built a card-shop search
    // for. Entering them in a prize draw because a word appeared is the same
    // class of error as the bridal shop, one layer up.
    for (const t of [
      'what are booster packs', 'where can I buy packs in Bangkok',
      'do any shops near me sell packs', 'packs of what?', 'I love packs',
      'PACKS PLEASE', 'send me packs',
    ]) {
      assert.equal(isEntry(t), false, `${JSON.stringify(t)} should NOT enter`);
    }
  });

  test('nothing at all is not an entry', () => {
    for (const t of ['', '  ', null, undefined, '!!!', 0]) assert.equal(isEntry(t), false);
  });

  test('the code matches the one the rules page publishes', () => {
    // A rules page naming one word while the service accepts another is a
    // promotion whose published terms are false.
    const rules = readFileSync(new URL('../growth/fridayrules.mjs', import.meta.url), 'utf8');
    assert.match(rules, new RegExp(`entryCode: '${ENTRY_CODE}'`),
      'fridayrules.mjs publishes a different entry code');
  });
});

describe('which week an entry lands in', () => {
  test('Friday and the following Wednesday are the SAME draw', () => {
    // The period runs Friday 00:00 UTC to the following Thursday 23:59 UTC, so
    // the closing Thursday names it. Getting this wrong splits one week's
    // entrants across two draws.
    const fri = weekKeyFor(new Date('2026-09-18T00:01:00Z'));
    const wed = weekKeyFor(new Date('2026-09-23T18:00:00Z'));
    assert.equal(fri, wed);
  });

  test('Thursday closes its own week; Friday opens the next', () => {
    assert.equal(weekKeyFor(new Date('2026-09-17T23:59:00Z')), '2026-09-17');
    assert.equal(weekKeyFor(new Date('2026-09-18T00:00:00Z')), '2026-09-24');
  });
});

describe('recording it', () => {
  test('an entry is written once, however many times it is sent', async () => {
    const { d, env } = db();
    const now = new Date('2026-09-16T10:00:00Z');
    const a = await recordEntry(env, { memberId: 'mem_1', now });
    const b = await recordEntry(env, { memberId: 'mem_1', now });
    const c = await recordEntry(env, { memberId: 'mem_1', now: new Date('2026-09-17T09:00:00Z') });
    assert.equal(a.already, false);
    assert.equal(b.already, true, 'a repeat must say so, not imply a second chance');
    assert.equal(c.already, true, 'still the same week');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM num_giveaway_entrants').get().n, 1);
  });

  test('the next week is a fresh entry', async () => {
    const { d, env } = db();
    await recordEntry(env, { memberId: 'mem_1', now: new Date('2026-09-16T10:00:00Z') });
    await recordEntry(env, { memberId: 'mem_1', now: new Date('2026-09-23T10:00:00Z') });
    assert.equal(d.prepare('SELECT COUNT(*) n FROM num_giveaway_entrants').get().n, 2);
  });

  test('no account is a clear refusal, not a silent miss', async () => {
    const { env } = db();
    const out = await recordEntry(env, { memberId: null });
    assert.equal(out.ok, false);
    assert.equal(out.needsAccount, true);
    assert.match(NEEDS_ACCOUNT_REPLY, /sign in|account/i);
    assert.match(NEEDS_ACCOUNT_REPLY, new RegExp(ENTRY_CODE), 'it must say what to send after signing in');
  });

  test('a broken database does not report success', async () => {
    // The expensive failure: somebody told they are in, who is not.
    const dead = { DB: { prepare() { throw new Error('down'); }, batch() { throw new Error('down'); } } };
    const out = await recordEntry(dead, { memberId: 'mem_1' });
    assert.equal(out.ok, false);
    assert.notEqual(out.already, false, 'a failure must not look like a fresh entry');
  });

  test('the count is of this week only', async () => {
    const { env } = db();
    const now = new Date('2026-09-16T10:00:00Z');
    for (const m of ['mem_1', 'mem_2', 'mem_3']) await recordEntry(env, { memberId: m, now });
    await recordEntry(env, { memberId: 'mem_9', now: new Date('2026-09-30T10:00:00Z') });
    assert.equal(await entryCount(env, now), 3);
  });
});

describe('what Num says back', () => {
  test('every reply carries the terms and the rules link', () => {
    // The reply IS the moment somebody enters, and the only place we can be
    // sure they see the conditions.
    for (const r of [entryReply({}), entryReply({ already: true, count: 4, weekKey: '2026-09-17' })]) {
      assert.match(r, /18/);
      assert.match(r, /US and UK/);
      assert.match(r, /itsnum\.com\/friday-rules/);
    }
  });

  test('a repeat says you are already in, not that you entered again', () => {
    assert.match(entryReply({ already: true }), /already in/i);
    assert.doesNotMatch(entryReply({ already: true }), /You're in\./);
  });

  test('the count is only shown when there is one', () => {
    assert.doesNotMatch(entryReply({ count: 0 }), /have entered|has entered/);
    assert.match(entryReply({ count: 1 }), /1 person has entered/);
    assert.match(entryReply({ count: 7 }), /7 people have entered/);
  });
});

describe('how it is wired into the message path', () => {
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

  test('the code is checked BEFORE a model is called', () => {
    // A model asked "PACKS" answers something plausible about card packs and
    // the entry is silently never recorded — the member believes they entered.
    const entryAt = src.indexOf('if (isEntry(lastUser)');
    const knownAt = src.indexOf('const known = knownAnswer(');
    assert.ok(entryAt > 0, 'the entry check has gone from index.mjs');
    assert.ok(entryAt < knownAt, 'the entry check must run before the answer path');
  });

  test('a failed write never replies "you\'re in"', () => {
    const block = src.slice(src.indexOf('if (isEntry(lastUser)'), src.indexOf('const prevAssistant'));
    assert.match(block, /Something went wrong recording that entry/);
    assert.match(block, /entry\.ok/, 'the reply must branch on whether the write succeeded');
  });
});
