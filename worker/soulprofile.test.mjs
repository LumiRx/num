import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIDENT_AT, DIMENSIONS, mergeAnon, nextQuestion, observe,
  askedAlready, profileFor, questionBlock, storable, subjectOf, topicOf, toPreference, _resetSchemaCache,
} from './soulprofile.mjs';

/** A D1 stand-in backed by a plain Map, so the SQL contract is exercised. */
function db() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...a) {
          return {
            async run() {
              if (/INSERT INTO num_soul_signals \(subject, key, value, seen, updated_at\)\s+VALUES/.test(sql)) {
                const [subject, key, value] = a;
                const k = `${subject}|${key}`;
                const prev = rows.get(k);
                rows.set(k, { subject, key, value, seen: prev && prev.value === value ? prev.seen + 1 : 1 });
              }
              if (/SELECT \?2, key, value/.test(sql)) {
                const [from, to] = a;
                let merged = 0;
                for (const r of [...rows.values()].filter((x) => x.subject === from)) {
                  const k = `${to}|${r.key}`;
                  if (!rows.has(k)) { rows.set(k, { ...r, subject: to }); merged += 1; }
                }
                return { meta: { changes: merged } };
              }
              return { meta: { changes: 0 } };
            },
            async all() {
              const [subject] = a;
              return { results: [...rows.values()].filter((r) => r.subject === subject) };
            },
          };
        },
        async run() { return {}; },
      };
    },
  };
}

test('THE LINE: the preference is kept, the reason is not', () => {
  // This is the whole privacy design in four assertions. A kitchen needs to
  // know "no shellfish"; nobody needs a medical record to seat someone.
  assert.equal(toPreference("no shellfish, because I'm allergic"), 'no shellfish');
  assert.equal(toPreference("I'm allergic to peanuts"), 'no peanuts');
  assert.equal(toPreference('no pork — as a Muslim'), 'no pork');
  assert.equal(toPreference('vegetarian'), 'vegetarian');

  // And once trimmed, the useful half survives the filter.
  assert.equal(storable('avoids', toPreference("no shellfish, because I'm allergic")), true);
  assert.equal(storable('avoids', toPreference("I'm allergic to peanuts")), true);
});

test('the sensitive half is refused even under a legitimate key', () => {
  // The model will happily emit {key:'dietary', value:'coeliac disease'} —
  // a perfectly reasonable key carrying a diagnosis.
  assert.equal(storable('dietary', 'coeliac disease'), false);
  assert.equal(storable('avoids', 'gluten - severe allergy'), false);
  // The shape rule, not the vocabulary: no blocklist finishes catching
  // abbreviations, but "somebody + possession verb + capitalised initials" is
  // never a taste preference.
  assert.equal(storable('crew', 'wife has MS'), false);
  assert.equal(storable('crew', 'he has PTSD'), false);
  assert.equal(storable('eats', 'partner suffers from IBS'), false);
  assert.equal(storable('crew', 'my son is on medication'), false);
  // …and the ordinary crew answers must survive it.
  assert.equal(storable('crew', 'two of us'), true);
  assert.equal(storable('crew', 'family with kids'), true);
  assert.equal(storable('eats', 'thai and BBQ'), true, 'a capitalised food name is not a diagnosis');
  assert.equal(storable('atmosphere', 'quiet, my anxiety is bad in crowds'), false);
  assert.equal(storable('eats', 'kosher because we are Jewish'), false);
  assert.equal(storable('budget', 'cannot afford much, in debt'), false);
  // …while the ordinary version of each is fine.
  assert.equal(storable('eats', 'kosher'), true);
  assert.equal(storable('atmosphere', 'quiet'), true);
  assert.equal(storable('budget', 'cheap eats'), true);
});

test('a fact is a phrase, never a transcript', () => {
  // An unbounded per-guest transcript is a retention liability nobody asked
  // for — memory.mjs says so explicitly and this table must not become one.
  assert.equal(storable('eats', 'x'.repeat(121)), false);
  assert.equal(storable('eats', 'x'.repeat(119)), true);
  assert.equal(storable('eats', ''), false);
  assert.equal(storable('', 'thai'), false);
});

test('the subject is the member when known, the device when not', () => {
  // 370 of 412 asks have no member. A member-keyed profile would be a feature
  // for 10% of traffic that looks broken to everybody else.
  assert.equal(subjectOf({ memberId: 'mem_1' }), 'mem_1');
  assert.equal(subjectOf({ anonId: 'a1' }), 'anon:a1');
  assert.equal(subjectOf({ memberId: 'mem_1', anonId: 'a1' }), 'mem_1', 'a member must never be filed under a device');
  assert.equal(subjectOf({}), null, 'with neither id there is no subject and nothing may be written');
});

test('one mention is a mood; three is a pattern', async () => {
  _resetSchemaCache();
  const env = { DB: db() };
  await observe(env, 'anon:a1', 'eats', 'thai');
  assert.deepEqual(await profileFor(env, { anonId: 'a1' }), {},
    'acted on a single observation — this is how "it thinks it knows me" happens');

  for (let i = 1; i < CONFIDENT_AT; i += 1) await observe(env, 'anon:a1', 'eats', 'thai');
  assert.deepEqual(await profileFor(env, { anonId: 'a1' }), { eats: 'thai' });
});

test('changing your mind resets the count, it does not average', async () => {
  _resetSchemaCache();
  const env = { DB: db() };
  for (let i = 0; i < CONFIDENT_AT; i += 1) await observe(env, 'anon:a2', 'atmosphere', 'lively');
  assert.equal((await profileFor(env, { anonId: 'a2' })).atmosphere, 'lively');
  await observe(env, 'anon:a2', 'atmosphere', 'quiet');
  assert.equal((await profileFor(env, { anonId: 'a2' })).atmosphere, undefined,
    'a new leaning inherited the old one\'s confidence');
});

test('what the guest SAID always beats what we noticed', async () => {
  _resetSchemaCache();
  const env = { DB: db() };
  for (let i = 0; i < CONFIDENT_AT; i += 1) await observe(env, 'mem_9', 'eats', 'steak');
  const p = await profileFor(env, { memberId: 'mem_9', stated: { eats: 'vegetarian' } });
  assert.equal(p.eats, 'vegetarian',
    'an observation overrode a stated fact — an observation that contradicts the guest is simply wrong');
});

test('signing up loses nothing, and never overwrites the account', async () => {
  _resetSchemaCache();
  const env = { DB: db() };
  for (let i = 0; i < CONFIDENT_AT; i += 1) await observe(env, 'anon:a3', 'pace', 'slow');
  for (let i = 0; i < CONFIDENT_AT; i += 1) await observe(env, 'anon:a3', 'crew', 'two of us');
  for (let i = 0; i < CONFIDENT_AT; i += 1) await observe(env, 'mem_7', 'crew', 'solo');

  const out = await mergeAnon(env, 'a3', 'mem_7');
  assert.equal(out.merged, 1, 'only the blank should have been filled');
  const p = await profileFor(env, { memberId: 'mem_7' });
  assert.equal(p.pace, 'slow', 'the device history was lost on signup');
  assert.equal(p.crew, 'solo', 'the device overwrote the account — the account is older and more trusted');
});

test('a refused value is never written at all', async () => {
  _resetSchemaCache();
  const env = { DB: db() };
  const r = await observe(env, 'anon:a4', 'avoids', 'gluten, I have coeliac disease');
  assert.equal(r.refused, true);
  assert.equal(env.DB.rows.size, 0, 'a sensitive value reached the table');
});

test('silence is the default — a question must earn its place', () => {
  // Returns null far more often than it returns a question.
  assert.equal(nextQuestion({}, { topic: null }), null,
    'asked something the current turn cannot even use');
  // `when: 'always'` means "any turn we understand", not "ask regardless".
  assert.equal(nextQuestion({}, { topic: 'venue' })?.key, 'crew');
  assert.equal(nextQuestion({ crew: 'solo' }, { topic: 'food' })?.key, 'eats');
  // Never re-ask what is known.
  assert.equal(nextQuestion({ crew: 'solo', eats: 'thai', avoids: 'none' }, { topic: 'food' }), null);
  // Never ask the same thing twice in one conversation.
  assert.equal(nextQuestion({}, { topic: 'food', asked: ['crew'] })?.key, 'eats');
  assert.equal(nextQuestion({}, { topic: 'food', asked: ['crew', 'eats', 'avoids'] }), null);
});

test('every dimension has a question a person would actually say aloud', () => {
  for (const d of DIMENSIONS) {
    assert.ok(d.ask.length > 12 && d.ask.includes('?'), `${d.key} has no real question`);
    assert.ok(!/^(what is your|please select|enter your|choose)/i.test(d.ask),
      `${d.key} reads like a form field, which is the thing this design is avoiding`);
  }
});

test('the block tells the model to answer first and shut up second', () => {
  const b = questionBlock({ key: 'eats', ask: 'What food makes you happiest when you travel?' });
  assert.match(b, /ONLY if/i);
  assert.match(b, /AFTER/);
  assert.match(b, /never ask more than\s*\nthis one|never ask more than this one/);
  assert.match(b, /remember action with\s*\nkey "eats"|key "eats"/);
  assert.equal(questionBlock(null), null);
});

// ── the topic gate and the wiring ────────────────────────────────────────

test('a question is gated on what the turn is actually about', () => {
  assert.equal(topicOf('where should we eat tonight'), 'food');
  assert.equal(topicOf('best rooftop bar for sunset'), 'venue');
  assert.equal(topicOf('what should we do tomorrow'), 'plan');
  assert.equal(topicOf('how much does that cost'), 'money');
  // Not everything is a topic, and that is the common case.
  assert.equal(topicOf('hello'), null);
  assert.equal(topicOf(''), null);
  assert.equal(topicOf(null), null);
  // A food question during a taxi conversation is an interruption.
  assert.equal(nextQuestion({ crew: 'solo' }, { topic: topicOf('is the airport far') }), null);
});

test('a question Num already put is never put again, answered or not', () => {
  // Scans what NUM said, not what the guest said. Ignoring a question IS an
  // answer; asking again is how a conversation becomes an interrogation.
  const asked = askedAlready([
    { role: 'user', content: 'somewhere for dinner' },
    { role: 'assistant', content: 'Try Sato San. Who am I planning for — just you, or a group?' },
    { role: 'user', content: 'anywhere with a view' },
  ]);
  assert.deepEqual(asked, ['crew']);
  assert.notEqual(nextQuestion({}, { topic: 'food', asked })?.key, 'crew');
  assert.deepEqual(askedAlready([{ role: 'user', content: 'who am I planning for' }]), [],
    'counted the GUEST saying it as Num having asked');
  assert.deepEqual(askedAlready([]), []);
});

test('the persona forbids the reason and the interrogation', async () => {
  const { PERSONA } = await import('./prompt.mjs');
  assert.match(PERSONA, /NOT A FORM/, 'nothing stops the model asking on every turn');
  assert.match(PERSONA, /One question per conversation/);
  assert.match(PERSONA, /NEVER THE REASON/, 'nothing stops a diagnosis being written to the profile');
  assert.match(PERSONA, /Store no pork, never Muslim/);
});

test('the live path builds a profile and can survive it failing', async () => {
  const { readFileSync } = await import('node:fs');
  const index = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  // Keyed on member OR device, or it is a feature for 10% of traffic.
  assert.match(index, /profileFor\(env, \{ stated, memberId, anonId \}\)/);
  // Observed for everyone, not just members.
  assert.match(index, /anon:\$\{parsed\.state\.anon\}/);
  // The earned question rides on the default call only.
  assert.match(index, /extraSystem = extraSystem \?\? earnedBlock/,
    'a quality retry would lose its own system note, or the question would never ship');
  // A profile is an enhancement; losing it must never cost somebody an answer.
  const block = index.slice(index.indexOf('const soul = await'), index.indexOf('const profile = soul'));
  assert.match(block, /catch \{ return stated; \}/, 'a profile read failure takes the whole turn down');
});

test('signing up carries the device history across', async () => {
  const { readFileSync } = await import('node:fs');
  const social = readFileSync(new URL('./social.mjs', import.meta.url), 'utf8');
  assert.match(social, /mergeAnon\(env, String\(b\.anon\)/,
    'verification does not fold in what Num learned before the account existed');
  const client = readFileSync(new URL('../src/lib/social.ts', import.meta.url), 'utf8');
  assert.match(client, /code, anon: anonId\(\)/,
    'the client never sends the device id, so the merge can never fire');
});
