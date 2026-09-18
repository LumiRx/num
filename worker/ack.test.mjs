// The first line lands inside a second, says nothing that could be wrong,
// and the answer that follows is byte-for-byte what the single-JSON path
// would have sent. Pinned here so a "small cleanup" cannot make the app
// wait for the brain again.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ackLine, ACK_LANGS, wantsNdjson, streamNdjson } from './ack.mjs';

const INDEX = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

const readAll = async (res) => {
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const ctx = () => { const waits = []; return { waitUntil: (p) => waits.push(p), waits }; };

describe('the line itself', () => {
  test('every app language has both forms, and neither is empty', () => {
    for (const lang of ['en', 'th', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'ar', 'mn']) {
      assert.ok(ACK_LANGS.includes(lang), `${lang} is missing`);
      const withPlace = ackLine({ lang, place: 'Bangkok' });
      const without = ackLine({ lang });
      assert.ok(withPlace.length > 2 && without.length > 2, lang);
      assert.ok(withPlace.includes('Bangkok'), `${lang}: the place the guest gave us should be in the line`);
      assert.notEqual(withPlace, without);
    }
  });

  test('an unknown or regional language code falls back to English, never to nothing', () => {
    assert.equal(ackLine({ lang: 'en-GB', place: 'Lisbon' }), 'Looking at Lisbon for you…');
    assert.equal(ackLine({ lang: 'xx' }), 'On it…');
    assert.equal(ackLine({}), 'On it…');
    assert.equal(ackLine({ lang: null, place: null }), 'On it…');
  });

  test('a "place" that is really a sentence is not echoed back to the guest', () => {
    const leak = 'I need a table for four tonight somewhere quiet near the river please';
    assert.equal(ackLine({ lang: 'en', place: leak }), 'On it…');
    assert.equal(ackLine({ lang: 'en', place: 'Bang\nkok' }), 'On it…');
  });

  test('it promises nothing and quotes no number', () => {
    for (const lang of ACK_LANGS) {
      const l = ackLine({ lang, place: 'Seoul' }) + ackLine({ lang });
      assert.ok(!/\d/.test(l), `${lang}: a number in the first line is a claim`);
      assert.ok(!/book|reserv|confirm/i.test(l), `${lang}: the first line may not promise an action`);
    }
  });
});

describe('the two-line answer', () => {
  const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  test('only a client that asks gets it', () => {
    assert.equal(wantsNdjson(new Request('https://x/api/num', { headers: { Accept: 'application/x-ndjson, application/json' } })), true);
    assert.equal(wantsNdjson(new Request('https://x/api/num', { headers: { Accept: 'application/json' } })), false);
    assert.equal(wantsNdjson(new Request('https://x/api/num')), false);
    assert.equal(wantsNdjson(null), false);
  });

  test('ack first, then the answer with its status inside — and the stream itself is 200', async () => {
    const c = ctx();
    const res = streamNdjson(c, async (hooks) => {
      hooks.ack({ ack: 'Looking at Bangkok for you…', place: 'Bangkok' });
      await new Promise((r) => setTimeout(r, 5));
      return jsonRes(200, { reply: 'Three I would book tonight…', picks: [], place: 'Bangkok' });
    }, { headers: { 'Access-Control-Allow-Origin': '*' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /x-ndjson/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'CORS must survive the wrap');
    const lines = await readAll(res);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { kind: 'ack', ack: 'Looking at Bangkok for you…', place: 'Bangkok' });
    assert.equal(lines[1].kind, 'final');
    assert.equal(lines[1].status, 200);
    assert.equal(lines[1].reply, 'Three I would book tonight…');
    assert.equal(lines[1].place, 'Bangkok');
    assert.equal(c.waits.length, 1, 'the run is kept alive with waitUntil');
  });

  test('an early answer (cache, known, guard) has no ack — one line, and that is fine', async () => {
    const res = streamNdjson(ctx(), async () => jsonRes(200, { reply: 'cached' }));
    const lines = await readAll(res);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'final');
    assert.equal(lines[0].reply, 'cached');
  });

  test('a refusal keeps its status so the app can treat it as it always did', async () => {
    const res = streamNdjson(ctx(), async () => jsonRes(429, { error: 'Too many requests — give me a moment.' }));
    const [final] = await readAll(res);
    assert.equal(final.status, 429);
    assert.match(final.error, /Too many/);
  });

  test('a handler that throws still closes the stream with a final line', async () => {
    const res = streamNdjson(ctx(), async (hooks) => { hooks.ack({ ack: 'On it…' }); throw new Error('boom'); });
    const lines = await readAll(res);
    assert.equal(lines.at(-1).kind, 'final');
    assert.equal(lines.at(-1).status, 500);
  });
});

describe('wired, not just written', () => {
  test('fetch() routes /api/num through the wrap when asked, and to handleNum otherwise', () => {
    const i = INDEX.indexOf('if (wantsNdjson(request)) return streamNdjson(ctx, (hooks) => handleNum(request, env, ctx, hooks)');
    assert.ok(i > 0, 'the NDJSON branch is gone');
    assert.ok(INDEX.indexOf('return await handleNum(request, env, ctx);', i) > i, 'the plain path must remain, after it');
  });

  test('handleNum sends the ack AFTER the early paths and BEFORE the brain chain is asked', () => {
    const ack = INDEX.indexOf('hooks.ack({ ack: ackLine({ lang: chosenLang, place: placeName }), place: placeName })');
    const brains = INDEX.indexOf('let result = await askBrains(env, {');
    const cache = INDEX.indexOf("lane: 'cache', cached: true");
    assert.ok(ack > 0 && brains > 0 && cache > 0);
    assert.ok(cache < ack, 'a cache hit answers whole; it must not be preceded by an ack');
    assert.ok(ack < brains, 'the ack must be on the wire before the brain is asked, or it is not a first line');
  });

  test('handleNum accepts hooks as an optional fourth argument', () => {
    assert.match(INDEX, /export async function handleNum\(request, env, ctx, hooks = null\)/);
  });
});
