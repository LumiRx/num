/**
 * Cross-analysis: what the cheap brains agree on.
 *
 * The three things these tests exist to hold down:
 *   1. This job can NEVER spend Anthropic credit — the reason it was built.
 *   2. A voter can never name a place it was not shown.
 *   3. A vote count is never stored without its denominator.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  voters, ballotFor, readVotes, tally, strength, pending, candidatesFor,
  record, runConsensus, consensusFor,
  MIN_AGREEMENT, MIN_ROUNDS, MAX_PICKS, BALLOT_SIZE,
} from './consensus.mjs';
import { BRAINS } from './brains.mjs';

let db; let env;
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
});

const PLACES = [
  ['p1', 'Bestia', 'los-angeles', 'restaurant', 'Italian', 'Arts District', 'ffffff'],
  ['p2', 'Gjelina', 'los-angeles', 'restaurant', 'Californian', 'Venice', 'ffff'],
  ['p3', 'Don Dae Gam', 'los-angeles', 'restaurant', 'Korean', 'Koreatown', 'fff'],
  ['p4', 'Road to Seoul', 'los-angeles', 'restaurant', 'Korean', 'Koreatown', 'ff'],
  ['p5', 'Republique', 'los-angeles', 'restaurant', 'French', 'Mid-City', 'f'],
  ['p6', 'Guelaguetza', 'los-angeles', 'restaurant', 'Oaxacan', 'Koreatown', null],
];

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, dest TEXT, category TEXT, cuisine TEXT, area TEXT, hours_mask TEXT, alive INTEGER)`);
  for (const p of PLACES) {
    db.prepare('INSERT INTO places VALUES (?,?,?,?,?,?,?,NULL)').run(...p);
  }
  db.exec(`CREATE TABLE num_asks (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, category TEXT, dest TEXT, synthetic INTEGER NOT NULL DEFAULT 0)`);
  db.prepare('INSERT INTO num_asks (text, category, dest, synthetic) VALUES (?,?,?,?)')
    .run('where should we eat tonight in koreatown', 'restaurant', 'los-angeles', 0);
  env = { DB: d1(db) };
});

describe('the Anthropic guarantee', () => {
  test('no Anthropic brain is ever eligible to vote', () => {
    const all = { NUM_LLM_BASE_URL: 'https://api.deepseek.com/v1', AI: {}, ANTHROPIC_API_KEY: 'x', NUM_OPENAI_BASE_URL: 'https://api.openai.com/v1' };
    const panel = voters(all);
    assert.ok(panel.length > 0, 'a fully configured env should produce voters');
    assert.equal(panel.filter((b) => b.kind === 'anthropic').length, 0);
  });

  test('the guarantee is structural: callProse has no anthropic branch', () => {
    // Not a style check. If someone adds an Anthropic path to callProse, this
    // job silently starts spending the credit Dre needs to ship, and the only
    // symptom is a bill. The filter in voters() is the second line of defence;
    // this is the first.
    const src = readFileSync(new URL('./brains.mjs', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function callProse'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    assert.ok(!/anthropic/i.test(fn), 'callProse must contain no anthropic path');
    assert.ok(/has no prose path/.test(fn), 'callProse must still throw for kinds it cannot serve');
  });

  test('every voter is a kind callProse can actually serve', () => {
    const panel = voters({ NUM_LLM_BASE_URL: 'https://x.example/v1', AI: {}, NUM_OPENAI_BASE_URL: 'https://y.example/v1' });
    for (const b of panel) {
      assert.ok(['workers-ai', 'openai-compatible'].includes(b.kind), `${b.id} is ${b.kind}`);
    }
  });

  test('an env with only an Anthropic key produces no panel at all', () => {
    assert.deepEqual(voters({ ANTHROPIC_API_KEY: 'sk-x' }), []);
  });
});

describe('the ballot', () => {
  test('numbers the candidates and keeps the ids server-side', () => {
    const b = ballotFor({ question: 'dinner', dest: 'los-angeles', rows: PLACES.map((p) => ({ id: p[0], name: p[1], category: p[3], cuisine: p[4], area: p[5] })) });
    assert.match(b.text, /1\. Bestia/);
    assert.match(b.text, /3\. Don Dae Gam/);
    assert.deepEqual(b.ids, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    // The id never appears in the prompt: a model that cannot see an
    // identifier cannot invent one.
    assert.ok(!b.text.includes('p1'));
  });

  test('caps the ballot so the prompt stays tiny', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, name: `Place ${i}` }));
    const b = ballotFor({ question: 'q', dest: 'd', rows: many });
    assert.equal(b.size, BALLOT_SIZE);
    assert.equal(b.ids.length, BALLOT_SIZE);
  });

  test('drops rows with no id or no name rather than numbering a hole', () => {
    const b = ballotFor({ question: 'q', dest: 'd', rows: [{ id: 'a', name: 'A' }, { id: null, name: 'B' }, { id: 'c', name: '' }] });
    assert.deepEqual(b.ids, ['a']);
  });

  test('a long question cannot blow up the prompt', () => {
    const b = ballotFor({ question: 'x'.repeat(5000), dest: 'd', rows: [{ id: 'a', name: 'A' }] });
    assert.ok(b.text.length < 900);
  });
});

describe('reading a vote', () => {
  test('plain numbers', () => {
    assert.deepEqual(readVotes('3, 1, 5', 6), [3, 1, 5]);
  });

  test('a number outside the ballot is discarded, not clamped', () => {
    // Clamping would turn an invented candidate into a vote for a real one.
    assert.deepEqual(readVotes('99, 2', 6), [2]);
  });

  test('repeats do not become agreement', () => {
    assert.deepEqual(readVotes('4 4 4', 6), [4]);
  });

  test('prose around the numbers still reads', () => {
    assert.deepEqual(readVotes('I would go with 2 then 5.', 6), [2, 5]);
  });

  test('a refusal casts no votes', () => {
    assert.deepEqual(readVotes("I can't help with that.", 6), []);
  });

  test('never more than MAX_PICKS', () => {
    assert.equal(readVotes('1,2,3,4,5,6', 6).length, MAX_PICKS);
  });

  test('zero is not a position', () => {
    assert.deepEqual(readVotes('0, 1', 6), [1]);
  });
});

describe('tallying', () => {
  test('counts distinct brains, not votes', () => {
    const t = tally({ a: [1, 2], b: [2, 3], c: [2] });
    assert.equal(t.get(2), 3);
    assert.equal(t.get(1), 1);
  });

  test('one brain repeating itself is still one brain', () => {
    // Guards the failure that would make this table worthless: a retry
    // counting as a second opinion.
    const t = tally({ a: [1, 1, 1] });
    assert.equal(t.get(1), 1);
  });

  test('an empty panel tallies nothing', () => {
    assert.equal(tally({}).size, 0);
    assert.equal(tally({ a: [], b: [] }).size, 0);
  });
});

describe('strength refuses to guess', () => {
  test('null below MIN_ROUNDS, however good the record looks', () => {
    assert.equal(strength({ rounds: MIN_ROUNDS - 1, agreements: MIN_ROUNDS - 1 }), null);
  });

  test('a rate once there is enough to rate', () => {
    assert.equal(strength({ rounds: 10, agreements: 5 }), 0.5);
  });

  test('never converged is 0, never looked is null — they are different facts', () => {
    assert.equal(strength({ rounds: 10, agreements: 0 }), 0);
    assert.equal(strength({ rounds: 0, agreements: 0 }), null);
  });
});

describe('the round', () => {
  test('appearances are recorded for every candidate, votes only for the chosen', async () => {
    await runConsensus({ DB: env.DB }, { limit: 0 }).catch(() => {});
    await record(env, {
      askId: 1, dest: 'los-angeles', cat: 'restaurant',
      ids: ['p1', 'p2', 'p3'], counts: new Map([[3, 2]]), voterCount: 3,
    });
    const rows = db.prepare('SELECT place_id, rounds, votes, agreements FROM num_place_consensus ORDER BY place_id').all();
    assert.equal(rows.length, 3, 'every candidate gets a denominator');
    assert.deepEqual({ ...rows.find((r) => r.place_id === 'p1') }, { place_id: 'p1', rounds: 1, votes: 0, agreements: 0 });
    assert.deepEqual({ ...rows.find((r) => r.place_id === 'p3') }, { place_id: 'p3', rounds: 1, votes: 2, agreements: 1 });
  });

  test('a single brain naming a place is a vote but not an agreement', async () => {
    await runConsensus({ DB: env.DB }, { limit: 0 }).catch(() => {});
    await record(env, { askId: 2, dest: 'los-angeles', cat: '', ids: ['p1'], counts: new Map([[1, 1]]), voterCount: 1 });
    const r = db.prepare("SELECT votes, agreements FROM num_place_consensus WHERE place_id='p1'").get();
    assert.equal(r.votes, 1);
    assert.equal(r.agreements, 0, `one voice is not agreement (MIN_AGREEMENT=${MIN_AGREEMENT})`);
  });

  test('rounds accumulate across ticks', async () => {
    await runConsensus({ DB: env.DB }, { limit: 0 }).catch(() => {});
    for (let i = 0; i < 3; i++) {
      await record(env, { askId: 10 + i, dest: 'los-angeles', cat: 'restaurant', ids: ['p1'], counts: new Map([[1, 2]]), voterCount: 2 });
    }
    const r = db.prepare("SELECT rounds, votes, agreements FROM num_place_consensus WHERE place_id='p1'").get();
    assert.deepEqual({ ...r }, { rounds: 3, votes: 6, agreements: 3 });
  });

  test('the same ask is never replayed', async () => {
    await runConsensus({ DB: env.DB }, { limit: 0 }).catch(() => {});
    assert.equal((await pending(env, 10)).length, 1);
    await record(env, { askId: 1, dest: 'los-angeles', cat: 'restaurant', ids: [], counts: new Map(), voterCount: 0 });
    assert.equal((await pending(env, 10)).length, 0);
  });

  test('probe traffic is never replayed', async () => {
    await runConsensus({ DB: env.DB }, { limit: 0 }).catch(() => {});
    db.prepare('INSERT INTO num_asks (text, category, dest, synthetic) VALUES (?,?,?,1)')
      .run('my group needs dinner ideas in patong tonight', 'restaurant', 'phuket');
    const rows = await pending(env, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dest, 'los-angeles');
  });

  test('an ask with no destination is not replayable', async () => {
    await runConsensus({ DB: env.DB }, { limit: 0 }).catch(() => {});
    db.prepare('INSERT INTO num_asks (text, category, dest, synthetic) VALUES (?,?,NULL,0)').run('how do i say thank you', null);
    assert.equal((await pending(env, 10)).length, 1);
  });
});

describe('candidates', () => {
  test('come from the destination, ranked by what we actually know', async () => {
    const rows = await candidatesFor(env, { dest: 'los-angeles', cat: 'restaurant' });
    assert.equal(rows.length, 6);
    assert.equal(rows[0].name, 'Bestia', 'most complete hours first — the column we verified has coverage');
    assert.equal(rows.at(-1).name, 'Guelaguetza', 'no hours known, so last');
  });

  test('a dead venue is never on a ballot', async () => {
    db.prepare("UPDATE places SET alive=0 WHERE id='p1'").run();
    const rows = await candidatesFor(env, { dest: 'los-angeles', cat: 'restaurant' });
    assert.ok(!rows.some((r) => r.id === 'p1'));
  });

  test('another city is another ballot', async () => {
    assert.equal((await candidatesFor(env, { dest: 'phuket', cat: '' })).length, 0);
  });
});

describe('runConsensus end to end', () => {
  test('with no voters configured it does nothing and says so', async () => {
    const out = await runConsensus(env);
    assert.equal(out.rounds, 0);
    assert.match(out.why, /no voters/);
  });

  test('with no database it returns a shape rather than throwing', async () => {
    const out = await runConsensus({});
    assert.equal(out.rounds, 0);
  });

  test('a thin candidate list is closed out, not voted on', async () => {
    db.prepare("DELETE FROM places WHERE id IN ('p3','p4','p5')").run();
    // AI:{} makes Workers AI brains "ready"; env.AI.run does not exist, so
    // every vote throws and returns []. The round must still complete.
    const out = await runConsensus({ DB: env.DB, AI: {} });
    assert.equal(out.rounds, 1);
    assert.equal(out.agreed, 0);
    const r = db.prepare('SELECT candidates, voters FROM num_consensus_rounds WHERE ask_id=1').get();
    assert.equal(r.candidates, 0, 'nothing was put to a vote');
  });

  test('every voter being down still closes the round', async () => {
    const out = await runConsensus({ DB: env.DB, AI: {} });
    assert.equal(out.rounds, 1);
    assert.equal(out.agreed, 0);
    const r = db.prepare('SELECT voters, candidates FROM num_consensus_rounds WHERE ask_id=1').get();
    assert.equal(r.voters, 0);
    assert.equal(r.candidates, 6, 'the ballot went out; nobody answered');
    // Appearances still counted: "shown six times, chosen never" is a real
    // and useful fact, and it is the denominator everything else needs.
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_place_consensus').get().n, 6);
  });
});

describe('reading the consensus back', () => {
  test('nothing is published below MIN_ROUNDS', async () => {
    await runConsensus({ DB: env.DB }, { limit: 0 }).catch(() => {});
    for (let i = 0; i < MIN_ROUNDS - 1; i++) {
      await record(env, { askId: 100 + i, dest: 'los-angeles', cat: '', ids: ['p3'], counts: new Map([[1, 3]]), voterCount: 3 });
    }
    assert.equal((await consensusFor(env, { dest: 'los-angeles' })).length, 0);
  });

  test('published once there is enough, best agreement first', async () => {
    await runConsensus({ DB: env.DB }, { limit: 0 }).catch(() => {});
    for (let i = 0; i < MIN_ROUNDS; i++) {
      await record(env, {
        askId: 200 + i, dest: 'los-angeles', cat: '',
        ids: ['p1', 'p3'], counts: new Map(i < 2 ? [[1, 2], [2, 3]] : [[2, 3]]), voterCount: 3,
      });
    }
    const out = await consensusFor(env, { dest: 'los-angeles' });
    assert.equal(out[0].place_id, 'p3');
    assert.equal(out[0].strength, 1);
    assert.equal(out[1].place_id, 'p1');
    assert.equal(out[1].strength, 2 / MIN_ROUNDS);
  });
});
