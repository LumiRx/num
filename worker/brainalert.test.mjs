/**
 * The sentence that was missing.
 *
 * Detection has worked since August; nobody was ever told. These tests hold
 * down the three things that make an alert worth having: it fires when the
 * product is actually broken, it stays silent when the chain is doing its
 * job, and it says when it is over.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assess, windowFor, messageFor, alertOnBrains, NEEDS_HUMAN } from './brainalert.mjs';

let db; let env; let sent;
const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text, args: order.map((n) => st.binds[n]) };
    };
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.run = async () => { const { text, args } = run(); const r = database.prepare(text).run(...args); return { meta: { changes: r.changes } }; };
    return st;
  },
  batch: async (sts) => { for (const s of sts) await s.run(); return []; },
});

const down = (brain, cls, until) =>
  db.prepare('INSERT OR REPLACE INTO num_brain_state (brain, fails, class, last_error, cooldown_until, updated_at) VALUES (?,?,?,?,?,?)')
    .run(brain, 3, cls, `${brain} HTTP 401`, until, Math.floor(Date.now() / 1000));

const SOON = Math.floor(Date.now() / 1000) + 600;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_brain_state (brain TEXT PRIMARY KEY, fails INTEGER, class TEXT, last_error TEXT, cooldown_until INTEGER, updated_at INTEGER)`);
  db.exec(`CREATE TABLE num_brain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, brain TEXT, class TEXT, error TEXT, ts INTEGER)`);
  sent = [];
  env = { DB: d1(db), ANTHROPIC_API_KEY: 'sk-x', NUM_OPENAI_BASE_URL: 'https://o/v1', NUM_LLM_BASE_URL: 'https://d/v1' };
});
const spy = async (t) => { sent.push(t); return true; };

describe('assessing', () => {
  const S = (id) => ({ id, structured: true });
  const P = (id) => ({ id, structured: false });

  test('every structured brain cooling is a blackout', () => {
    const a = assess({ brains: [{ brain: 'claude', cooling: true, class: 'quota' }] }, [S('claude'), P('jan')]);
    assert.equal(a.level, 'blackout');
    assert.ok(a.blackout);
  });

  test('one structured brain still up is NOT a blackout', () => {
    // The whole point of a second structured brain. If this ever reported a
    // blackout, the alert would fire on the day the fallback WORKED.
    const a = assess({ brains: [{ brain: 'claude', cooling: true, class: 'quota' }] }, [S('claude'), S('openai')]);
    assert.notEqual(a.level, 'blackout');
    assert.deepEqual(a.structured_up, ['openai']);
  });

  test('a dead key is needs_human even while other brains carry the traffic', () => {
    const a = assess({ brains: [{ brain: 'claude', cooling: true, class: 'auth' }] }, [S('claude'), S('openai')]);
    assert.equal(a.level, 'needs_human');
    assert.equal(a.stuck[0].brain, 'claude');
  });

  test('a timeout is degraded, not needs_human — waiting fixes it', () => {
    const a = assess({ brains: [{ brain: 'hosted', cooling: true, class: 'transient' }] }, [S('claude'), P('hosted')]);
    assert.equal(a.level, 'degraded');
    assert.equal(a.stuck.length, 0);
  });

  test('nothing cooling is ok', () => {
    assert.equal(assess({ brains: [] }, [S('claude')]).level, 'ok');
  });

  test('a deployment with no structured brain is a configuration, not an outage', () => {
    // Never page someone about a choice they made.
    const a = assess({ brains: [{ brain: 'jan', cooling: true, class: 'transient' }] }, [P('jan')]);
    assert.equal(a.blackout, false);
  });

  test('the classes a human must fix are exactly auth and model', () => {
    assert.deepEqual([...NEEDS_HUMAN].sort(), ['auth', 'model']);
  });
});

describe('the message', () => {
  test('a blackout says the product is broken, not that a brain is slow', () => {
    const m = messageFor({ level: 'blackout', stuck: [{ brain: 'claude', class: 'quota' }], cooling: ['claude'], structured_up: [] });
    assert.match(m, /BRAIN DOWN/);
    assert.match(m, /cannot produce cards or bookings/);
  });

  test('needs_human says retrying will not help, and what is still up', () => {
    const m = messageFor({ level: 'needs_human', stuck: [{ brain: 'claude', class: 'auth', last_error: 'HTTP 401 invalid key' }], cooling: ['claude'], structured_up: ['openai'] });
    assert.match(m, /needs you \(auth\)/);
    assert.match(m, /retrying will not fix this/);
    assert.match(m, /1 structured brain\(s\) still up/);
  });

  test('fits in a text', () => {
    const m = messageFor({ level: 'needs_human', stuck: [{ brain: 'claude', class: 'auth', last_error: 'x'.repeat(500) }], cooling: [], structured_up: [] });
    assert.ok(m.length < 320, `${m.length} chars`);
  });
});

describe('how often it fires', () => {
  test('a blackout texts once an hour, not once a tick', async () => {
    down('claude', 'quota', SOON); down('haiku', 'quota', SOON); down('openai', 'quota', SOON);
    const now = new Date('2026-09-08T10:05:00Z');
    await alertOnBrains(env, { now, alertFn: spy });
    await alertOnBrains(env, { now: new Date('2026-09-08T10:55:00Z'), alertFn: spy });
    assert.equal(sent.length, 1, 'the second tick in the same hour is silent');
    await alertOnBrains(env, { now: new Date('2026-09-08T11:05:00Z'), alertFn: spy });
    assert.equal(sent.length, 2, 'the next hour speaks again');
  });

  test('needs_human texts once a day per brain', async () => {
    down('claude', 'auth', SOON);
    const now = new Date('2026-09-08T10:00:00Z');
    await alertOnBrains(env, { now, alertFn: spy });
    await alertOnBrains(env, { now: new Date('2026-09-08T22:00:00Z'), alertFn: spy });
    assert.equal(sent.length, 1);
    await alertOnBrains(env, { now: new Date('2026-09-09T09:00:00Z'), alertFn: spy });
    assert.equal(sent.length, 2);
  });

  test('a transient wobble is never texted at all', async () => {
    // The chain is doing its job. An alert here trains its reader to ignore
    // the next one, which is the real cost.
    down('hosted', 'transient', SOON);
    const out = await alertOnBrains(env, { alertFn: spy });
    assert.equal(out.level, 'degraded');
    assert.equal(sent.length, 0);
  });

  test('a healthy chain is silent', async () => {
    const out = await alertOnBrains(env, { alertFn: spy });
    assert.equal(out.level, 'ok');
    assert.equal(sent.length, 0);
  });

  test('the window is claimed before the send, so a throwing send cannot double-fire', async () => {
    down('claude', 'auth', SOON);
    const boom = async () => { throw new Error('twilio down'); };
    await alertOnBrains(env, { alertFn: boom }).catch(() => {});
    await alertOnBrains(env, { alertFn: spy });
    assert.equal(sent.length, 0, 'the window was already spent');
  });
});

describe('recovery', () => {
  test('a brain coming back sends exactly one all-clear', async () => {
    down('claude', 'auth', SOON);
    await alertOnBrains(env, { alertFn: spy });
    assert.equal(sent.length, 1);
    db.prepare("UPDATE num_brain_state SET cooldown_until = 0 WHERE brain='claude'").run();
    await alertOnBrains(env, { alertFn: spy });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /back up: claude/);
    await alertOnBrains(env, { alertFn: spy });
    assert.equal(sent.length, 2, 'and only one');
  });

  test('after recovery the next outage alerts again from scratch', async () => {
    down('claude', 'auth', SOON);
    await alertOnBrains(env, { now: new Date('2026-09-08T10:00:00Z'), alertFn: spy });
    db.prepare("UPDATE num_brain_state SET cooldown_until = 0 WHERE brain='claude'").run();
    await alertOnBrains(env, { now: new Date('2026-09-08T11:00:00Z'), alertFn: spy });
    down('claude', 'auth', SOON);
    await alertOnBrains(env, { now: new Date('2026-09-08T12:00:00Z'), alertFn: spy });
    assert.equal(sent.length, 3, 'same day, but it had recovered in between');
  });
});

describe('the point of the whole file', () => {
  test('it never calls a model, so it works when the model is what broke', () => {
    // If this ever needs a brain to tell you the brains are down, it is
    // useless on the only day it matters.
    const src = readFileSync(new URL('./brainalert.mjs', import.meta.url), 'utf8');
    assert.ok(!/\bask\(/.test(src), 'must not call brains.ask');
    assert.ok(!/callProse|callStructuredJson|env\.AI\.run/.test(src));
  });

  test('with no database it returns a shape rather than throwing', async () => {
    assert.deepEqual(await alertOnBrains({}), { level: 'ok', sent: [] });
  });
});
