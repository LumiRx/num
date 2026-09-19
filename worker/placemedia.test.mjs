/**
 * Place media (19 Sep 2026): a pick's picture and socials, from the venue's
 * own page, stored once found. Parsers on real-shaped HTML; the fill on
 * node:sqlite with a fetch that hands back fixed pages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ogImageFrom, socialsFrom, mediaFor, handlePlaceMedia, MAX_IDS } from './placemedia.mjs';
import { socialOf, placeContact } from './placelink.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => ({ results: /^\s*(SELECT|PRAGMA|WITH)/i.test(sql) ? db.prepare(sql).all(...args) : (db.prepare(sql).run(...args), []), success: true }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; },
  });
  return { prepare(sql) { const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) }); return bound([]); }, batch: async (s) => Promise.all(s.map((x) => x.run())) };
}

const PAGE = `<html><head>
<meta name="twitter:image" content="/img/twitter-card.jpg">
<meta property="og:image" content="https://cdn.ramiro.pt/uploads/terrace-night.jpg?w=1200&amp;h=630">
<meta property="og:title" content="Cervejaria Ramiro">
</head><body>
<a href="https://www.instagram.com/cervejariaramiro/">Instagram</a>
<a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
<a href="https://www.facebook.com/CervejariaRamiro">Facebook</a>
<a href="https://www.tiktok.com/@ramiro.lisboa?lang=en">TikTok</a>
<a href="https://www.instagram.com/p/Cxyz/">a post</a>
</body></html>`;

test('og:image wins over twitter:image; entities are decoded; a relative image is made absolute', () => {
  assert.equal(ogImageFrom(PAGE, 'https://www.cervejariaramiro.pt/'), 'https://cdn.ramiro.pt/uploads/terrace-night.jpg?w=1200&h=630');
  assert.equal(ogImageFrom('<meta content="/pics/front.jpg" property="og:image">', 'https://x.example/menu/'), 'https://x.example/pics/front.jpg');
});

test('a logo by its name is not a photo of the place; an http image is refused on a https page; nothing → null', () => {
  assert.equal(ogImageFrom('<meta property="og:image" content="https://x.example/assets/logo.png">', 'https://x.example/'), null);
  assert.equal(ogImageFrom('<meta property="og:image" content="http://x.example/a.jpg">', 'https://x.example/'), null);
  assert.equal(ogImageFrom('<html><body>hello</body></html>', 'https://x.example/'), null);
});

test('socials: profile-shaped links only — a post, a sharer and a lang query are not handles', () => {
  assert.deepEqual(socialsFrom(PAGE), {
    instagram: 'https://www.instagram.com/cervejariaramiro/',
    tiktok: 'https://www.tiktok.com/@ramiro.lisboa',
    facebook: 'https://www.facebook.com/CervejariaRamiro',
  });
  assert.deepEqual(socialsFrom('<a href="https://www.instagram.com/p/abc/">x</a>'), { instagram: null, tiktok: null, facebook: null });
});

test('a row whose website IS an Instagram page has told us its Instagram — and gets no Website pill', () => {
  assert.equal(socialOf({ website: 'https://www.instagram.com/baanrimpa/?hl=en' }).instagram, 'https://www.instagram.com/baanrimpa/');
  assert.equal(socialOf({ website: 'instagram.com/reel/abc' }).instagram, null);
  const c = placeContact({ id: 'x', name: 'Baan', website: 'https://www.instagram.com/baanrimpa/', lat: 7.8, lng: 98.3 });
  assert.equal(c.instagram, 'https://www.instagram.com/baanrimpa/');
  assert.equal(c.website, null);
  assert.equal(c.photo, null, 'no photo_url → no photo, never a placeholder');
});

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, website TEXT, photo_url TEXT, photo_attr TEXT, photo_source TEXT, photo_checked_at TEXT)`);
db.prepare("INSERT INTO places VALUES ('pl_ram','Ramiro','https://www.cervejariaramiro.pt/',NULL,NULL,NULL,NULL)").run();
db.prepare("INSERT INTO places VALUES ('pl_has','Has Photo','https://has.example/','https://has.example/og.jpg','© Has',NULL,'2026-09-01 00:00:00')").run();
db.prepare("INSERT INTO places VALUES ('pl_ig','IG Only','https://www.instagram.com/igonly/',NULL,NULL,NULL,NULL)").run();
db.prepare("INSERT INTO places VALUES ('pl_dead','Dead Site','https://dead.example/',NULL,NULL,NULL,NULL)").run();
const env = { DB: d1(db) };
let fetches = [];
const fakeFetch = async (url) => {
  fetches.push(url);
  if (String(url).startsWith('https://www.cervejariaramiro.pt')) return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
  if (String(url).startsWith('https://dead.example')) return new Response('nope', { status: 503 });
  return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
};

test('the fill: a bare row gets its own preview image and socials, and they are stored; a row with a photo is not fetched; an Instagram-only row is answered from the row', async () => {
  const now = new Date('2026-09-19T12:00:00Z');
  const media = await mediaFor(env, ['pl_ram', 'pl_has', 'pl_ig', 'pl_dead'], { fetchImpl: fakeFetch, now });
  assert.equal(media.pl_ram.photo, 'https://cdn.ramiro.pt/uploads/terrace-night.jpg?w=1200&h=630');
  assert.equal(media.pl_ram.instagram, 'https://www.instagram.com/cervejariaramiro/');
  assert.equal(media.pl_has.photo, 'https://has.example/og.jpg');
  assert.equal(media.pl_has.photo_attr, '© Has');
  assert.equal(media.pl_ig.instagram, 'https://www.instagram.com/igonly/');
  assert.equal(media.pl_ig.photo, null);
  assert.equal(media.pl_dead.photo, null);
  assert.ok(!fetches.some((u) => String(u).includes('instagram.com')), 'never fetches a social site');
  assert.ok(fetches.some((u) => String(u).includes('has.example')), 'a row with a photo but no stored socials is read once for its socials');

  const row = db.prepare("SELECT photo_url, photo_source, photo_checked_at FROM places WHERE id='pl_ram'").get();
  assert.equal(row.photo_url, 'https://cdn.ramiro.pt/uploads/terrace-night.jpg?w=1200&h=630');
  assert.equal(row.photo_source, 'website');
  assert.equal(row.photo_checked_at, '2026-09-19 12:00:00');
  const soc = db.prepare("SELECT * FROM num_place_social WHERE place_id='pl_ram'").get();
  assert.equal(soc.tiktok, 'https://www.tiktok.com/@ramiro.lisboa');
  const dead = db.prepare("SELECT photo_url, photo_checked_at FROM places WHERE id='pl_dead'").get();
  assert.equal(dead.photo_url, null);
  assert.equal(dead.photo_checked_at, '2026-09-19 12:00:00', 'an unreadable site is marked checked so it is not retried every answer');
});

test('the second ask reads everything from the table — no fetch at all', async () => {
  fetches = [];
  const media = await mediaFor(env, ['pl_ram', 'pl_has', 'pl_dead'], { fetchImpl: fakeFetch });
  assert.equal(fetches.length, 0);
  assert.equal(media.pl_ram.facebook, 'https://www.facebook.com/CervejariaRamiro');
});

test('the door: ids required, at most eight, GET only', async () => {
  const mk = (q, method = 'GET') => handlePlaceMedia(new Request(`https://app.itsnum.com/api/places/media${q}`, { method }), env, new URL(`https://app.itsnum.com/api/places/media${q}`));
  assert.equal((await mk('')).status, 400);
  assert.equal((await mk('?ids=pl_ram', 'POST')).status, 405);
  const many = Array.from({ length: 12 }, (_, i) => `pl_${i}`).join(',');
  const res = await mk(`?ids=${many},pl_has`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Object.keys(body.media).length <= MAX_IDS);
});
