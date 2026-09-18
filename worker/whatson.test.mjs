// What's on this week: the feed reader, the fetch discipline, and the rule
// that nothing but a headline, a link, a date and a credit is ever kept.
// Run: node --test worker/whatson.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeed, refreshSource, refreshWhatsOn, whatsOnFor, SOURCES, FETCH_EVERY_H } from './whatson.mjs';

const RSS = `<?xml version="1.0"?><rss><channel><title>Londonist</title>
<item><title>Ten things to do this weekend &amp; more</title><link>https://londonist.com/london/things-to-do/weekend</link><pubDate>Thu, 17 Sep 2026 09:00:00 +0000</pubDate><description><p>Lots of body text that must never be stored</p></description></item>
<item><title><![CDATA[Open House London returns]]></title><link>https://londonist.com/london/open-house</link><pubDate>Fri, 18 Sep 2026 07:30:00 +0000</pubDate></item>
<item><title>Dup</title><link>https://londonist.com/london/open-house</link><pubDate>Fri, 18 Sep 2026 07:31:00 +0000</pubDate></item>
<item><title>No link</title></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Berlin Art Week</title><link href="https://www.tip-berlin.de/kunst/art-week"/><updated>2026-09-16T10:00:00Z</updated></entry></feed>`;

test('parseFeed: RSS → title, link, date; CDATA and entities unwrapped; newest first; duplicate links and linkless items dropped', () => {
  const items = parseFeed(RSS);
  assert.deepEqual(items.map((i) => i.title), ['Open House London returns', 'Ten things to do this weekend & more']);
  assert.equal(items[0].url, 'https://londonist.com/london/open-house');
  assert.equal(items[0].published, '2026-09-18T07:30:00.000Z');
  for (const i of items) assert.deepEqual(Object.keys(i).sort(), ['published', 'title', 'url'], 'nothing but title, url, date');
});

test('parseFeed: Atom with href links', () => {
  const [i] = parseFeed(ATOM);
  assert.equal(i.title, 'Berlin Art Week');
  assert.equal(i.url, 'https://www.tip-berlin.de/kunst/art-week');
});

test('the sources are the independents with public RSS — never the Secret pages, Time Out or RA', () => {
  const src = readFileSync(new URL('./whatson.mjs', import.meta.url), 'utf8');
  for (const s of SOURCES) {
    assert.match(s.feed, /^https:\/\//);
    assert.doesNotMatch(s.feed, /secret|timeout\.com|ra\.co|feverup/i, `${s.id} is not a source NUM may read`);
  }
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /timeout\.com|ra\.co\/|secretldn|secretnyc|feverup\.com/i, 'no gated host in code');
  assert.ok(SOURCES.every((s) => s.dest && s.name && s.home));
});

function fakeDb() {
  const rows = new Map(); const fetches = new Map(); const log = [];
  return {
    rows, fetches, log,
    // Like D1, bind() returns a NEW statement: one prepared INSERT is bound
    // once per headline and batched, so the bindings must not accumulate.
    prepare(sql, b = []) {
      const self = this;
      const st = {
        bind(...a) { return self.prepare(sql, a); },
        async first() { log.push(sql); if (/FROM num_whatson_fetch/.test(sql)) return fetches.get(b[0]) ?? null; return null; },
        async all() {
          log.push(sql);
          if (/FROM num_whatson WHERE dest/.test(sql)) return { results: [...rows.values()].filter((r) => r.dest === b[0]).sort((x, y) => String(y.published_at).localeCompare(String(x.published_at))).slice(0, b[2]) };
          return { results: [] };
        },
        async run() {
          log.push(sql);
          if (/INSERT INTO num_whatson_fetch/.test(sql)) { fetches.set(b[0], { fetched_at: b[1], ok: b[2], note: b[3] }); return { meta: { changes: 1 } }; }
          if (/INSERT OR IGNORE INTO num_whatson /.test(sql)) { if (rows.has(b[4])) return { meta: { changes: 0 } }; rows.set(b[4], { id: b[0], dest: b[1], source: b[2], title: b[3], url: b[4], published_at: b[5] }); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        },
      };
      return st;
    },
  };
}
const londonist = SOURCES.find((s) => s.id === 'londonist');
const okFetch = async () => new Response(RSS, { status: 200 });

test('refreshSource stores headlines with the source and dest, and a second run within six hours does not fetch', async () => {
  const db = fakeDb(); let calls = 0;
  const f = async (...a) => { calls++; return okFetch(...a); };
  const r1 = await refreshSource({ DB: db }, londonist, { fetchImpl: f, now: new Date('2026-09-18T12:00:00Z') });
  assert.equal(r1.ok, true); assert.equal(r1.stored, 2);
  assert.ok([...db.rows.values()].every((r) => r.dest === 'london' && r.source === 'londonist'));
  const r2 = await refreshSource({ DB: db }, londonist, { fetchImpl: f, now: new Date('2026-09-18T14:00:00Z') });
  assert.equal(r2.skipped, 'fresh'); assert.equal(calls, 1);
  const r3 = await refreshSource({ DB: db }, londonist, { fetchImpl: f, now: new Date(`2026-09-18T${12 + FETCH_EVERY_H + 1}:00:00Z`) });
  assert.equal(r3.ok, true); assert.equal(r3.stored, 0, 'the same links are not stored twice'); assert.equal(calls, 2);
});

test('a failing feed is recorded and skipped; the other sources still run', async () => {
  const db = fakeDb();
  const f = async (url) => (url.includes('londonist') ? new Response('nope', { status: 503 }) : okFetch());
  const out = await refreshWhatsOn({ DB: db }, { fetchImpl: f, now: new Date('2026-09-18T12:00:00Z') });
  const l = out.find((x) => x.source === 'londonist');
  assert.equal(l.ok, false); assert.match(l.note, /HTTP 503/);
  assert.equal(db.fetches.get('londonist').ok, 0);
  assert.ok(out.filter((x) => x.ok === true).length >= 4, 'the rest fetched');
});

test('WHATSON_OFF switches a source off without a deploy — for fetching and for showing', async () => {
  const db = fakeDb();
  const out = await refreshWhatsOn({ DB: db, WHATSON_OFF: 'londonist, skint' }, { fetchImpl: okFetch, now: new Date('2026-09-18T12:00:00Z') });
  assert.equal(out.find((x) => x.source === 'londonist').skipped, 'WHATSON_OFF');
  assert.equal(out.find((x) => x.source === 'skint').skipped, 'WHATSON_OFF');
  // Rows already stored for a switched-off source are not shown either.
  db.rows.set('https://londonist.com/x', { id: 'a', dest: 'london', source: 'londonist', title: 'x', url: 'https://londonist.com/x', published_at: '2026-09-18T00:00:00Z' });
  assert.deepEqual(await whatsOnFor({ DB: db, WHATSON_OFF: 'londonist' }, 'london'), []);
});

test('whatsOnFor returns credited, linked headlines for the destination only', async () => {
  const db = fakeDb();
  await refreshSource({ DB: db }, londonist, { fetchImpl: okFetch, now: new Date('2026-09-18T12:00:00Z') });
  const rows = await whatsOnFor({ DB: db }, 'london');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'Londonist');
  assert.equal(rows[0].source_url, 'https://londonist.com/');
  assert.match(rows[0].url, /^https:\/\/londonist\.com\//);
  assert.deepEqual(await whatsOnFor({ DB: db }, 'paris'), []);
});

test('the request names NUM in its User-Agent', () => {
  const src = readFileSync(new URL('./whatson.mjs', import.meta.url), 'utf8');
  assert.match(src, /'User-Agent': UA/);
  assert.match(src, /const UA = 'NUM\/1\.0 \(\+https:\/\/itsnum\.com/);
});

test('every source is fetched at once — the sixth feed is not waiting on the first five', async () => {
  // Each fetch parks until ALL sources have started; sequential code would
  // deadlock here (the first fetch never resolves), so a result at all is
  // proof of concurrency, and `peak` says how many were in flight together.
  const db = fakeDb();
  let inFlight = 0, peak = 0, started = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = async () => {
    inFlight++; peak = Math.max(peak, inFlight); started++;
    if (started === SOURCES.length) release();
    await gate;
    inFlight--;
    return new Response(RSS, { status: 200 });
  };
  const out = await refreshWhatsOn({ DB: db }, { fetchImpl: f, now: new Date('2026-09-18T12:00:00Z') });
  assert.equal(peak, SOURCES.length);
  assert.equal(out.filter((o) => o.ok).length, SOURCES.length);
  assert.ok(SOURCES.every((s) => db.fetches.has(s.id)), 'every source, Bali included, has a fetch record');
});

test('headlines land in one batch per source, not one round trip each', async () => {
  const db = fakeDb();
  let batches = 0;
  db.batch = async (stmts) => { batches++; return Promise.all(stmts.map((s) => s.run())); };
  const out = await refreshSource({ DB: db }, londonist, { fetchImpl: okFetch, now: new Date('2026-09-18T12:00:00Z') });
  assert.equal(batches, 1);
  assert.equal(out.stored, 2);
});
