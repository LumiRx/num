// The app reads /api/num's answer in either shape — one JSON object, or the
// two-line NDJSON with a first line inside a second — so it works on both
// sides of a deploy and the first line never changes what the answer is.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readNumReply, parseLine, lines } from './numreply.ts';

const CONCIERGE = readFileSync(new URL('./concierge.ts', import.meta.url), 'utf8');
const THREAD = readFileSync(new URL('../components/app/ThreadView.tsx', import.meta.url), 'utf8');

const ndjson = (chunks, status = 200) => new Response(
  new ReadableStream({
    start(c) { const enc = new TextEncoder(); for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  }),
  { status, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } },
);
const plain = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('reading the answer', () => {
  test('plain JSON is read exactly as before, and no ack fires', async () => {
    let acks = 0;
    const out = await readNumReply(plain({ reply: 'hi', picks: [] }), () => { acks += 1; });
    assert.deepEqual(out, { reply: 'hi', picks: [] });
    assert.equal(acks, 0);
  });

  test('two lines: the ack fires first, the final payload is the answer without the envelope', async () => {
    const seen = [];
    const out = await readNumReply(
      ndjson(['{"kind":"ack","ack":"Looking at Bangkok for you…","place":"Bangkok"}\n', '{"kind":"final","status":200,"reply":"Three…","picks":[],"turn":{"lane":"moderate:haiku"}}\n']),
      (ack, place) => seen.push([ack, place]),
    );
    assert.deepEqual(seen, [['Looking at Bangkok for you…', 'Bangkok']]);
    assert.deepEqual(out, { reply: 'Three…', picks: [], turn: { lane: 'moderate:haiku' } });
    assert.equal('kind' in out, false);
    assert.equal('status' in out, false);
  });

  test('lines split across chunks anywhere are still whole lines', async () => {
    const seen = [];
    const out = await readNumReply(
      ndjson(['{"kind":"ack","a', 'ck":"On it…"}\n{"kind":"fi', 'nal","status":200,"reply":"ok"}', '\n']),
      (ack) => seen.push(ack),
    );
    assert.deepEqual(seen, ['On it…']);
    assert.equal(out.reply, 'ok');
  });

  test('a final line without a trailing newline still counts', async () => {
    const out = await readNumReply(ndjson(['{"kind":"final","status":200,"reply":"tail"}']));
    assert.equal(out.reply, 'tail');
  });

  test('a refusal inside the stream throws the same error the plain path throws', async () => {
    await assert.rejects(
      readNumReply(ndjson(['{"kind":"final","status":429,"error":"busy"}\n'])),
      /backend 429/,
    );
  });

  test('a stream that ends with no answer is an error, not an empty reply', async () => {
    await assert.rejects(readNumReply(ndjson(['{"kind":"ack","ack":"On it…"}\n'])), /without an answer/);
  });

  test('the ack fires at most once, and never with an empty line', async () => {
    const seen = [];
    await readNumReply(
      ndjson(['{"kind":"ack","ack":""}\n', '{"kind":"ack","ack":"first"}\n', '{"kind":"ack","ack":"second"}\n', '{"kind":"final","status":200,"reply":"ok"}\n']),
      (ack) => seen.push(ack),
    );
    assert.deepEqual(seen, ['first']);
  });

  test('garbage between lines is skipped, not fatal', async () => {
    const out = await readNumReply(ndjson(['not json\n', '\n', '{"kind":"final","status":200,"reply":"ok"}\n']));
    assert.equal(out.reply, 'ok');
    assert.equal(parseLine('   '), null);
    assert.equal(parseLine('[1,2]')?.length, 2);
  });

  test('lines() carries a torn tail to the next chunk', async () => {
    const body = new ReadableStream({ start(c) { const e = new TextEncoder(); c.enqueue(e.encode('a\nb')); c.enqueue(e.encode('c\n')); c.close(); } });
    const got = [];
    for await (const l of lines(body)) got.push(l);
    assert.deepEqual(got, ['a', 'bc']);
  });
});

describe('wired, not just written', () => {
  test('concierge.ts asks for the two-line answer and reads it through readNumReply', () => {
    assert.match(CONCIERGE, /Accept: 'application\/x-ndjson, application\/json'/);
    assert.match(CONCIERGE, /await readNumReply\(res, \(ack\) => store\.set\(\{ thinkingLine: ack \}\)\)/);
    assert.match(CONCIERGE, /store\.set\(\{ typing: true, thinkingLine: null,/, 'a new turn must clear the last turn\'s first line');
  });

  test('the thinking pill shows the first line, and "still on it" still wins after twelve seconds', () => {
    const i = THREAD.indexOf('function Thinking()');
    const body = THREAD.slice(i, i + 1600);
    assert.match(body, /useApp\(\(s\) => s\.thinkingLine\)/);
    const still = body.indexOf('secs >= 12');
    const ack = body.indexOf(': ack ? ack');
    assert.ok(still > 0 && ack > still, 'the twelve-second reassurance must be checked before the ack');
  });
});
