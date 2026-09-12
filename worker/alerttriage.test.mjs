/**
 * A JUDGE IN THE ALERT PATH, AND THE ONE THING IT MUST NEVER DO.
 *
 * Dre, 12 Sep 2026, hours after his phone said "🔴 NUM IS DOWN" over one
 * bounced outreach email: "lets make sure that when num is texting me udpates
 * theyre accurate we have our agents anazlyze it befoer texting me to make
 * sure its serious."
 *
 * Putting a model in the alert path is a genuinely dangerous thing to do. The
 * alert path's job is to work when other things do not — and the model is one
 * of the other things. So the property these tests exist to defend is not
 * "does it filter well". It is:
 *
 *     THERE IS EXACTLY ONE WAY TO REACH SILENCE, AND IT IS A JUDGE THAT
 *     ANSWERED, IN TIME, IN THE SHAPE ASKED FOR, SAYING SO.
 *
 * Every other path — no brain, slow brain, broken brain, rambling brain, dead
 * database, anything that throws — sends the text. Most of what follows is
 * one failure mode each, checking the alert still goes.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  triage, mustPage, digestText, markDigested, NEVER_GATED, TRIAGE_TIMEOUT_MS, __resetReady,
} from './alerttriage.mjs';

const HEALTH = readFileSync(new URL('./health.mjs', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const TRIAGE_SRC = readFileSync(new URL('./alerttriage.mjs', import.meta.url), 'utf8');

let db; let env;
const binding = () => ({
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...a) { bound = a; return api; },
      async run() { const r = db.prepare(sql).run(...bound); return { meta: { changes: r.changes } }; },
      async first() { const r = db.prepare(sql).get(...bound); return r ? { ...r } : null; },
      async all() { return { results: db.prepare(sql).all(...bound).map((r) => ({ ...r })) }; },
    };
    return api;
  },
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

beforeEach(() => {
  __resetReady();
  db = new DatabaseSync(':memory:');
  // A hosted openai-compatible brain, which `voters()` accepts and which is
  // NOT Anthropic — the same structural rule the consensus engine uses.
  env = {
    DB: binding(),
    NUM_LLM_BASE_URL: 'https://judge.example',
    NUM_LLM_KEY: 'k',
    NUM_LLM_MODEL: 'test-judge',
  };
});

/** Make the hosted brain answer with one line. */
const judgeSays = (line) => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: line } }] }),
  });
};

const ALERT = { text: '[biz] 1 NEW web signup(s): Some Cafe — console → Claims.', kind: 'alert', subject: 'biz signup' };

describe('the four classes that never reach the judge', () => {
  test('all four Dre chose are on the list', () => {
    for (const k of ['alert_undelivered', 'brain_down', 'd1_write', 'pay']) {
      assert.ok(NEVER_GATED.includes(k), `${k} must never be gated`);
    }
  });

  test('anything critical bypasses, whatever it says', () => {
    assert.ok(mustPage({ severity: 'critical', text: 'anything at all' }));
  });

  test('"nobody was told" bypasses — the judge might be the broken thing', () => {
    assert.ok(mustPage({ kind: 'alert', text: 'no channel accepted an alert' }));
    assert.ok(mustPage({ kind: 'alert_undelivered', text: 'x' }));
  });

  test('the brain being down bypasses — asking a dead model if it is dead', () => {
    assert.ok(mustPage({ kind: 'brain_down', text: 'x' }));
    assert.ok(mustPage({ kind: 'alert', text: '🔴 brains_state: no structured brain left' }));
  });

  test('database and money bypass', () => {
    assert.ok(mustPage({ kind: 'alert', text: '🔴 NUM IS DOWN — d1_write' }));
    assert.ok(mustPage({ kind: 'alert', text: '[pay] renewal failed: sub_123' }));
  });

  test('an ordinary business notice does not bypass', () => {
    assert.equal(mustPage(ALERT), null);
  });

  test('a bypass is sent WITHOUT consulting anything', async () => {
    let asked = false;
    globalThis.fetch = async () => { asked = true; throw new Error('should never be called'); };
    const out = await triage(env, { text: '[pay] renewal failed', kind: 'alert' });
    assert.equal(out.send, true);
    assert.ok(out.bypass);
    assert.equal(asked, false, 'a bypass must not depend on a brain being up');
  });
});

describe('two ways the filter could have swallowed the wrong thing', () => {
  test('the morning digest is never itself judged', async () => {
    // The only verdict that path could produce is "hold it for tomorrow's
    // digest", which is how nothing is ever told. Caught on review.
    assert.ok(NEVER_GATED.includes('digest'));
    judgeSays('DIGEST this can wait');
    const out = await triage(env, { text: '🗒 Num overnight — 3 things held back', kind: 'digest' });
    assert.equal(out.send, true);
    assert.ok(out.bypass);
  });

  test('an all-clear goes out if the alarm it answers went out', async () => {
    // Being texted at 2am that Num is down and finding out at breakfast that
    // it recovered is worse than the original alert.
    judgeSays('PAGE real outage');
    await triage(env, { text: '🔴 something broke', kind: 'alert' });
    judgeSays('DIGEST good news can wait');
    const out = await triage(env, { text: '✅ Num is healthy again.', kind: 'alert' });
    assert.equal(out.send, true, 'the all-clear must follow the alarm');
    assert.match(out.bypass, /all-clear/);
  });

  test('but an all-clear for an alarm nobody heard is judged like anything else', async () => {
    judgeSays('DIGEST nothing was ever escalated');
    const out = await triage(env, { text: '✅ Num is healthy again.', kind: 'alert' });
    assert.equal(out.send, false, 'no page went out, so there is nothing to reassure anyone about');
  });
});

describe('every failure mode sends the text', () => {
  test('no brain configured → sends', async () => {
    const out = await triage({ DB: binding() }, ALERT);
    assert.equal(out.send, true);
    assert.match(out.why, /no judge answered/);
  });

  test('the brain errors → sends', async () => {
    globalThis.fetch = async () => { throw new Error('network gone'); };
    assert.equal((await triage(env, ALERT)).send, true);
  });

  test('the brain returns an HTTP error → sends', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    assert.equal((await triage(env, ALERT)).send, true);
  });

  test('the brain rambles instead of answering → sends', async () => {
    judgeSays('Well, it depends. On balance I would say this is probably DIGEST.');
    assert.equal((await triage(env, ALERT)).send, true,
      'a verdict we have to go hunting for is one we must not act on');
  });

  test('the brain answers something that is neither word → sends', async () => {
    judgeSays('MAYBE — not sure');
    assert.equal((await triage(env, ALERT)).send, true);
  });

  test('an empty answer → sends', async () => {
    judgeSays('');
    assert.equal((await triage(env, ALERT)).send, true);
  });

  test('the database is gone → sends', async () => {
    judgeSays('DIGEST just a signup');
    const broken = { ...env, DB: { prepare() { throw new Error('no d1'); } } };
    assert.equal((await triage(broken, ALERT)).send, true);
  });

  test('there is a timeout, and it is short enough to matter', () => {
    assert.ok(TRIAGE_TIMEOUT_MS <= 10000, 'an outage cannot wait ten seconds for an opinion');
    assert.match(TRIAGE_SRC, /Promise\.race/);
  });
});

describe('the one path to silence', () => {
  test('a clean DIGEST verdict holds the alert', async () => {
    judgeSays('DIGEST one business signed up, nobody is affected');
    const out = await triage(env, ALERT);
    assert.equal(out.send, false);
    assert.match(out.why, /nobody is affected/);
    assert.equal(out.judge, 'hosted');
  });

  test('a clean PAGE verdict sends it', async () => {
    judgeSays('PAGE guests cannot get answers');
    assert.equal((await triage(env, ALERT)).send, true);
  });

  test('the judge can promote — Dre asked for upgrades, not only quiet', async () => {
    // Nothing in the code forbids PAGE on a low-looking alert, and the prompt
    // tells the judge to escalate a pattern.
    judgeSays('PAGE fourth bounce to the same domain today');
    assert.equal((await triage(env, { text: 'one email bounced', kind: 'alert' })).send, true);
    assert.match(TRIAGE_SRC, /held back \$\{held\} time\(s\)/,
      'the judge is not told how often this was held, so it cannot spot a pattern');
  });

  test('a held alert is still written down', async () => {
    judgeSays('DIGEST routine');
    await triage(env, ALERT);
    const row = db.prepare('SELECT * FROM num_alert_triage ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.decision, 'digest');
    assert.equal(row.sent, 0);
    assert.ok(row.body.includes('NEW web signup'),
      'a held alert with no trace is the product deciding what its owner may know');
  });

  test('a sent alert is written down too', async () => {
    judgeSays('PAGE this matters');
    await triage(env, ALERT);
    assert.equal(db.prepare('SELECT sent FROM num_alert_triage ORDER BY id DESC LIMIT 1').get().sent, 1);
  });
});

describe('it does not lean on the Anthropic account', () => {
  test('the panel comes from voters(), which excludes anthropic', () => {
    assert.match(TRIAGE_SRC, /import \{ voters \} from '\.\/consensus\.mjs'/);
    const consensus = readFileSync(new URL('./consensus.mjs', import.meta.url), 'utf8');
    assert.match(consensus, /b\.kind !== 'anthropic'/);
  });

  test('and nothing here reaches for an Anthropic key', () => {
    // The CODE, not the prose — this file explains at length why it avoids
    // Anthropic, and a grep that cannot tell a comment from a call would fail
    // on its own reasoning.
    const code = TRIAGE_SRC.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    assert.ok(!/ANTHROPIC_API_KEY|env\.ANTHROPIC/i.test(code),
      'maxed Anthropic tokens is one of the things Dre most needs telling about');
  });
});

describe('nothing held back is lost', () => {
  test('the digest lists what was held', async () => {
    judgeSays('DIGEST routine');
    await triage(env, ALERT);
    await triage(env, { text: '[biz] listing needs a look: Somewhere', kind: 'alert', subject: 'listing' });
    const d = await digestText(env);
    assert.equal(d.count, 2);
    assert.match(d.text, /held back, none urgent/);
    // Listed by SUBJECT, which is the readable label a caller passes — or the
    // head of the alert text when it does not pass one.
    assert.match(d.text, /biz signup/);
    assert.match(d.text, /listing/);
  });

  test('it never carries something that WAS sent', async () => {
    judgeSays('PAGE real problem');
    await triage(env, ALERT);
    assert.equal(await digestText(env), null);
  });

  test('nothing to say means no message at all', async () => {
    assert.equal(await digestText(env), null, 'a daily "nothing" is a digest people stop opening');
  });

  test('yesterday\'s digest does not repeat in today\'s', async () => {
    judgeSays('DIGEST routine');
    await triage(env, ALERT);
    const first = await digestText(env);
    await markDigested(env, first.ids);
    assert.equal(await digestText(env), null);
  });

  test('the cron sends it once a day, in Dre\'s morning', () => {
    assert.match(INDEX, /t\.getUTCHours\(\) === 15 && t\.getUTCMinutes\(\) < 5/,
      '15:00 UTC is 08:00 in Los Angeles');
    assert.match(INDEX, /m\.sendDigest\(env\)/);
  });
});

describe('where it sits in health.mjs', () => {
  test('the ledger is written BEFORE the judge is asked', () => {
    const recordAt = HEALTH.indexOf('await record(env, {');
    const triageAt = HEALTH.indexOf("await import('./alerttriage.mjs')");
    assert.ok(recordAt > 0 && triageAt > recordAt,
      'a held alert must still be on the record — that is the whole bargain');
  });

  test('the judge is asked BEFORE any channel is tried', () => {
    const triageAt = HEALTH.indexOf("await import('./alerttriage.mjs')");
    const firstSend = HEALTH.indexOf('if (env.ALERT_WEBHOOK)');
    assert.ok(triageAt > 0 && firstSend > triageAt, 'otherwise it is not filtering anything');
  });

  test('a held alert is NOT marked told', () => {
    // Marking it told would hide it from the very check that catches an
    // alerting system that has gone quiet.
    const i = HEALTH.indexOf('if (!call.send) {');
    assert.ok(i > 0);
    const block = HEALTH.slice(i, i + 400);
    assert.ok(!/markTold/.test(block));
    assert.match(block, /return \{ carried: null, held: true/);
  });

  test('the whole triage call is inside a try that falls through to sending', () => {
    const i = HEALTH.indexOf("const { triage } = await import('./alerttriage.mjs')");
    assert.ok(i > 0);
    assert.match(HEALTH.slice(i - 200, i), /try \{/);
    assert.match(HEALTH.slice(i, i + 900), /catch[\s\S]{0,160}triage unavailable, sending/);
  });
});
