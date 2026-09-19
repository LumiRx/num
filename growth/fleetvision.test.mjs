// What the model says, and what we are willing to write down.
//
// Every test here is about one of the three rules in fleetvision.mjs: a
// registration never reaches client copy, no price is ever invented, and no
// photograph is silently dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, parseVision, identify, buildPrompt, KINDS,
  groupByLikeness, jsonBody, identifyWithWorkersAi, visionReady,
  isPlaceholder, buildSmallPrompt, buildPresencePrompt } from './fleetvision.mjs';

/* ── the plate ─────────────────────────────────────────────────────────── */

test('a plate is removed however it was punctuated', () => {
  // The first version of scrub() compared whole words and caught only the
  // spelling nobody uses. These four are the spellings people and models
  // actually produce.
  assert.equal(scrub('Ferrari 296 GTB AB12 CDE', 'AB12CDE'), 'Ferrari 296 GTB');
  assert.equal(scrub('Ferrari 296 GTB AB12CDE', 'AB12 CDE'), 'Ferrari 296 GTB');
  assert.equal(scrub('Ferrari, reg ab12-cde, red', 'AB12CDE'), 'Ferrari, red');
  assert.equal(scrub('Tail number N550GX, seats 13.', 'n550gx'), 'Seats 13.');
});

test('a sentence is not left with a hole where the plate was', () => {
  // ", seats 13." tells a reader something was taken out and invites the
  // question. The whole point is that the copy reads as though the plate was
  // never there.
  const out = scrub('Tail number N550GX, seats 13.', 'N550GX');
  assert.ok(!out.startsWith(','), out);
  assert.ok(!/\s,/.test(out), out);
});

test('a short registration does not eat the sentence', () => {
  // Under four characters it is a word, not a plate.
  assert.equal(scrub('A red car with a red interior', 'red'), 'A red car with a red interior');
});

test('text with no plate in it is returned untouched', () => {
  const t = 'A blue Bentley Continental with cream hide.';
  assert.equal(scrub(t, 'AB12CDE'), t);
});

/* ── grouping ──────────────────────────────────────────────────────────── */

test('photographs of the same car become one group, 1-based in, 0-based out', () => {
  const g = parseVision('{"groups":[{"photos":[1,3],"kind":"car","name":"Ferrari 296 GTB"}]}', 3);
  assert.equal(g[0].photos.length, 2);
  assert.deepEqual(g[0].photos, [0, 2]);
});

test('NO PHOTOGRAPH IS SILENTLY DROPPED', () => {
  // The model placed two of four. The other two must come back as their own
  // drafts — a host who uploaded four and got two back has lost two and has no
  // way to know which.
  const g = parseVision('{"groups":[{"photos":[1,2],"kind":"car","name":"A car"}]}', 4);
  const seen = g.flatMap((x) => x.photos).sort();
  assert.deepEqual(seen, [0, 1, 2, 3]);
  assert.equal(g.filter((x) => !x.identified).length, 2);
});

test('a photograph claimed by two groups is only used once', () => {
  const g = parseVision('{"groups":[{"photos":[1,2],"kind":"car"},{"photos":[2,3],"kind":"boat"}]}', 3);
  const seen = g.flatMap((x) => x.photos);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(seen.sort(), [0, 1, 2]);
});

test('nothing usable back still yields one draft per photograph', () => {
  for (const bad of ['', 'sorry, I cannot help with that', '{"groups":', null]) {
    const g = parseVision(bad, 2);
    assert.equal(g.length, 2, JSON.stringify(bad));
    assert.equal(g.every((x) => x.identified === false), true);
  }
});

/* ── what it is allowed to say ─────────────────────────────────────────── */

test('the plate is kept privately and kept out of the name and the listing', () => {
  const g = parseVision(JSON.stringify({
    groups: [{
      photos: [1], kind: 'car', name: 'Ferrari 296 GTB AB12 CDE', registration: 'AB12CDE',
      listing: 'A red Ferrari, plate AB12 CDE, low mileage.', confidence: 'high',
    }],
  }), 1)[0];
  assert.equal(g.registration, 'AB12CDE');          // kept, privately
  assert.ok(!g.name.includes('AB12'), g.name);       // not in the name
  assert.ok(!g.listing.includes('AB12'), g.listing); // not in the copy
});

test('an unknown kind falls back to other rather than being invented', () => {
  const g = parseVision('{"groups":[{"photos":[1],"kind":"submarine","name":"Thing"}]}', 1)[0];
  assert.ok(KINDS.includes(g.kind));
  assert.equal(g.kind, 'other');
});

test('a nonsense year is dropped, not stored', () => {
  const g = parseVision('{"groups":[{"photos":[1],"kind":"car","name":"Car","year":3200}]}', 1)[0];
  assert.equal(g.year, null);
});

test('the prompt forbids inventing a price and forbids the plate in client copy', () => {
  const p = buildPrompt(3);
  assert.match(p, /Do not estimate a price/);
  assert.match(p, /Never put a registration/);
});

/* ── when the model cannot be reached ──────────────────────────────────── */

test('no brain at all: the photographs are still grouped, one each, and it says so', async () => {
  const r = await identify({}, [{ media_type: 'image/jpeg', data: 'x' }, { media_type: 'image/jpeg', data: 'y' }]);
  assert.equal(r.identified, false);
  assert.equal(r.reason, 'no_brain');
  assert.equal(r.groups.length, 2);
});

test('an API error loses nothing', async () => {
  const r = await identify(
    { ANTHROPIC_API_KEY: 'k' },
    [{ media_type: 'image/jpeg', data: 'x' }],
    { fetchImpl: async () => new Response('nope', { status: 529 }) },
  );
  assert.equal(r.reason, 'http_529');
  assert.equal(r.groups.length, 1);
});

test('a thrown fetch loses nothing either', async () => {
  const r = await identify(
    { ANTHROPIC_API_KEY: 'k' },
    [{ media_type: 'image/jpeg', data: 'x' }],
    { fetchImpl: async () => { throw new Error('socket'); } },
  );
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.groups.length, 1);
});

test('the key is sent as a header and never in the body', async () => {
  let seen = null;
  await identify(
    { ANTHROPIC_API_KEY: 'sk-secret' },
    [{ media_type: 'image/png', data: 'AAA' }],
    {
      fetchImpl: async (u, o) => {
        seen = { url: u, headers: o.headers, body: o.body };
        return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"groups":[]}' }] }), { status: 200 });
      },
    },
  );
  assert.equal(seen.headers['x-api-key'], 'sk-secret');
  assert.ok(!seen.body.includes('sk-secret'));
  assert.match(seen.url, /api\.anthropic\.com/);
});

/* ── THE SECOND BRAIN ──────────────────────────────────────────────────────
   Workers AI, one photograph per call, grouped afterwards. Dre's call on
   19 Sep 2026: no second API key. */

/* The mock answers TWO questions now: is anything there, then what is it.
   Which prompt arrived is read off the input, the same way the real models see
   it. */
const asked = (input) => (input.prompt || (input.messages || []).map((m) => m.content).join(' '));
const AI_OK = (answer, present = 'yes') => ({
  run: async (_model, input) => ({
    response: /one word: yes or no/.test(asked(input)) ? present : JSON.stringify(answer),
  }),
});

test('an AI binding counts as a brain, and is used when there is no key', async () => {
  assert.equal(visionReady({}), false);
  assert.equal(visionReady({ AI: {} }), true);
  assert.equal(visionReady({ ANTHROPIC_API_KEY: 'k' }), true);

  const r = await identify(
    { AI: AI_OK({ kind: 'car', colour: 'blue', seen: 'A blue saloon on a driveway.' }) },
    [{ media_type: 'image/jpeg', data: 'AAAA' }],
  );
  assert.equal(r.reason, 'workers_ai');
  assert.equal(r.groups[0].kind, 'car');
  assert.equal(r.groups[0].colour, 'blue');
  assert.equal(r.groups[0].by, '@cf/meta/llama-3.2-11b-vision-instruct');
});

test('prose around the JSON does not defeat it', () => {
  assert.match(jsonBody('Sure! Here you go:\n{"kind":"car"}\nHope that helps'), /^\{"photos":\[1\],"kind":"car"\}$/);
  assert.equal(jsonBody('no json here'), '');
});

test('the small prompt forbids a price, a name and anything painted on it', () => {
  assert.match(buildSmallPrompt(), /Do not guess a price/);
  assert.match(buildSmallPrompt(), /Do not name a make, a model or a year/);
  assert.match(buildSmallPrompt(), /Never write a number/);
});

test('TWO PHOTOGRAPHS OF ONE CAR MERGE — same kind, make and model', () => {
  const a = { photos: [0], kind: 'car', make: 'Ferrari', model: '296 GTB', colour: 'red', identified: true, year: null, guests: null, crew: null, listing: 'A red Ferrari.' };
  const b = { photos: [1], kind: 'car', make: 'ferrari', model: '296 gtb', colour: 'Red', identified: true, year: 2021, guests: null, crew: null, listing: '' };
  const g = groupByLikeness([a, b]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].photos, [0, 1]);
  assert.equal(g[0].year, 2021, 'the fuller answer is kept, not the first');
  assert.equal(g[0].listing, 'A red Ferrari.');
});

test('TWO OF THE SAME MODEL IN DIFFERENT COLOURS DO NOT MERGE', () => {
  // The expensive mistake: two cars in a fleet, one listing.
  const g = groupByLikeness([
    { photos: [0], kind: 'car', make: 'Ferrari', model: '296 GTB', colour: 'red', identified: true },
    { photos: [1], kind: 'car', make: 'Ferrari', model: '296 GTB', colour: 'black', identified: true },
  ]);
  assert.equal(g.length, 2);
});

test('an unknown make never merges, however alike the rest looks', () => {
  const g = groupByLikeness([
    { photos: [0], kind: 'boat', make: '', model: '', colour: 'white', identified: true },
    { photos: [1], kind: 'boat', make: '', model: '', colour: 'white', identified: true },
  ]);
  assert.equal(g.length, 2, 'merging on ignorance is how six things become one');
});

test("'other' is the could-not-tell bucket and never merges", () => {
  const g = groupByLikeness([
    { photos: [0], kind: 'other', make: 'X', model: 'Y', colour: 'grey', identified: true },
    { photos: [1], kind: 'other', make: 'X', model: 'Y', colour: 'grey', identified: true },
  ]);
  assert.equal(g.length, 2);
});

test('an undecodable photograph costs that photograph and not the batch', async () => {
  // atob throws on malformed base64. Built outside the try, one bad picture
  // took every other draft in the upload down with it.
  // Only the llava path decodes the bytes, so this is the model to force.
  const env = {
    AI: {
      run: async (model, input) => {
        if (model.includes('llama')) throw new Error('licence');
        return {
          response: /one word: yes or no/.test(asked(input))
            ? 'yes'
            : '{"kind":"car","colour":"blue","seen":"A blue saloon."}',
        };
      },
    },
  };
  const r = await identifyWithWorkersAi(env, [
    { media_type: 'image/jpeg', data: 'QUFB' },   // decodes
    { media_type: 'image/jpeg', data: 'A' },      // does not — atob throws
  ]);
  assert.equal(r.model, '@cf/llava-hf/llava-1.5-7b-hf');
  assert.equal(r.groups.length, 2);
  assert.equal(r.groups.filter((g) => g.identified).length, 1, 'the good one still read');
  assert.equal(r.groups.filter((g) => !g.identified).length, 1, 'the bad one is still its own draft');
});

test('a silent model still loses nothing', async () => {
  const r = await identifyWithWorkersAi(
    { AI: { run: async () => ({ response: 'I cannot help with that' }) } },
    [{ media_type: 'image/jpeg', data: 'A' }, { media_type: 'image/jpeg', data: 'B' }],
  );
  assert.equal(r.identified, false);
  assert.equal(r.groups.length, 2);
  assert.equal(r.groups.every((g) => g.photos.length === 1), true);
});

test('a model that throws falls through to the next one', async () => {
  const tried = [];
  const env = {
    AI: {
      run: async (model, input) => {
        tried.push(model);
        if (model.includes('llama')) throw new Error('403 must accept licence');
        return {
          response: /one word: yes or no/.test(asked(input))
            ? 'yes'
            : '{"kind":"yacht","colour":"white","seen":"A motor yacht at a berth."}',
        };
      },
    },
  };
  const r = await identifyWithWorkersAi(env, [{ media_type: 'image/jpeg', data: 'AAAA' }]);
  assert.equal(r.model, '@cf/llava-hf/llava-1.5-7b-hf');
  assert.equal(r.groups[0].kind, 'yacht');
  assert.ok(tried.length >= 2, 'it tried the preferred one first');
});

test('nothing a client reads survives from this tier', async () => {
  // Measured on 19 Sep 2026: asked for a make and model, it produced "volvo
  // b555" for a tram whose fleet number is 559. So it is no longer asked, and
  // anything it volunteers is dropped rather than trusted.
  const r = await identifyWithWorkersAi(
    { AI: AI_OK({ kind: 'car', make: 'Ferrari', model: '296 GTB', year: 2021, name: 'Ferrari 296 AB12 CDE', registration: 'AB12CDE', seen: 'A red sports car.' }) },
    [{ media_type: 'image/jpeg', data: 'AAAA' }],
  );
  const g = r.groups[0];
  assert.equal(g.make, null);
  assert.equal(g.model, null);
  assert.equal(g.year, null);
  assert.equal(g.registration, null);
  assert.ok(!/Ferrari/i.test(JSON.stringify(g)), JSON.stringify(g));
});

test('a key still wins: Anthropic is preferred when both are present', async () => {
  let calledAI = false;
  const r = await identify(
    { ANTHROPIC_API_KEY: 'k', AI: { run: async () => { calledAI = true; return {}; } } },
    [{ media_type: 'image/jpeg', data: 'A' }],
    { fetchImpl: async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"groups":[{"photos":[1],"kind":"jet","name":"A jet"}]}' }] }), { status: 200 }) },
  );
  assert.equal(calledAI, false);
  assert.equal(r.groups[0].name, 'A jet');
});

/* ── WHAT THE 19 SEPTEMBER TEST ACTUALLY RETURNED ─────────────────────────
   Two real photographs from NUM's own stock, through the live endpoint. Both
   answers are kept here verbatim as fixtures, because both were wrong in a way
   no synthetic test would have produced. */

test('A BEACH WITH NO BOAT IN IT IS NOT A BOAT', async () => {
  // The cove: sea, cliff, trees, no vessel anywhere. The first version of this
  // path returned kind "boat", "a blue yacht on the water". The presence check
  // is the whole fix.
  const r = await identifyWithWorkersAi(
    { AI: AI_OK({ kind: 'boat', colour: 'blue', seen: 'a blue yacht on the water' }, 'no') },
    [{ media_type: 'image/jpeg', data: 'AAAA' }],
  );
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].identified, false);
  assert.equal(r.groups[0].name, 'No vehicle in this one');
  assert.ok(!/yacht/i.test(JSON.stringify(r.groups[0])), 'no invented vessel anywhere in it');
});

test('"could not read it" and "there is nothing in it" are different answers', async () => {
  // One invites a host to type the name of a boat. The other tells them they
  // dragged in a photograph of the beach.
  const silent = await identifyWithWorkersAi(
    { AI: { run: async () => ({ response: '' }) } },
    [{ media_type: 'image/jpeg', data: 'AAAA' }],
  );
  const empty = await identifyWithWorkersAi(
    { AI: AI_OK({ kind: 'car' }, 'no') },
    [{ media_type: 'image/jpeg', data: 'AAAA' }],
  );
  assert.match(silent.groups[0].unsure, /could not make this one out/i);
  assert.match(empty.groups[0].unsure, /anything here to let out/i);
});

test('a schema echoed back is not a name', () => {
  // "what a client would read" came back as an actual value and would have
  // been saved as the name of somebody's boat.
  assert.equal(isPlaceholder('what a client would read'), true);
  assert.equal(isPlaceholder('one sentence describing only what is visible'), true);
  assert.equal(isPlaceholder('e.g. a red Ferrari'), true);
  assert.equal(isPlaceholder('M/Y Serenity'), false);
  assert.equal(isPlaceholder(''), false);
});

test('a placeholder never reaches the draft', async () => {
  const r = await identifyWithWorkersAi(
    { AI: AI_OK({ kind: 'boat', colour: '', seen: 'one sentence describing only what is visible' }) },
    [{ media_type: 'image/jpeg', data: 'AAAA' }],
  );
  const g = r.groups[0];
  assert.equal(g.seen, '');
  assert.ok(!/one sentence/i.test(JSON.stringify(g)), JSON.stringify(g));
});

test('the presence question is asked first, and one word is all it wants', async () => {
  const seen = [];
  await identifyWithWorkersAi(
    { AI: { run: async (_m, input) => { seen.push(input.prompt || input.messages[1].content); return { response: 'no' }; } } },
    [{ media_type: 'image/jpeg', data: 'AAAA' }],
  );
  assert.match(seen[0], /one word: yes or no/);
  assert.equal(seen.length, 1, 'a no costs one call, not two');
  assert.match(buildPresencePrompt(), /A beach, a view, a street, food or people alone are NOT/);
});

test('"White other" is not a name — an admission is', async () => {
  // Measured 19 Sep 2026: a Lisbon tram came back kind "other", and joining
  // that to a colour produced "White other", which reads like a reading and is
  // actually a shrug.
  const r = await identifyWithWorkersAi(
    { AI: AI_OK({ kind: 'tram', colour: 'white', seen: 'A white tram on a street.' }) },
    [{ media_type: 'image/jpeg', data: 'AAAA' }],
  );
  assert.equal(r.groups[0].kind, 'other');
  assert.equal(r.groups[0].name, 'Not yet named');
});

test('what it does keep is the kind, the colour and a plain observation', async () => {
  const r = await identifyWithWorkersAi(
    { AI: AI_OK({ kind: 'yacht', colour: 'white', seen: 'A white motor yacht moored at a marina.' }) },
    [{ media_type: 'image/jpeg', data: 'AAAA' }],
  );
  const g = r.groups[0];
  assert.equal(g.kind, 'yacht');
  assert.equal(g.colour, 'white');
  assert.equal(g.name, 'White yacht');
  assert.equal(g.seen, 'A white motor yacht moored at a marina.');
  assert.equal(g.confidence, 'low');
});
