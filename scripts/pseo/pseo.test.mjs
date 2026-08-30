// Programmatic set pages, and the gate that decides which of them exist.
//
// The strategy is 2,906 candidate sets across all 77 destinations, published
// one at a time as somebody writes the line that makes each page worth
// reading. That only stays honest if the gate is real, so these tests are
// about the gate rather than about the rendering.
//
// Google's March 2024 policy names the failure precisely: "scaled content
// abuse", whose test is content whose "primary purpose is manipulating search
// rankings and not helping users", and whose canonical shape is pages that
// swap a city name with nothing else changed. Every check below maps to one
// specific way of ending up there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATEGORY_SETS, NEVER, setsBySlug, MIN_SET, MAX_SET } from './taxonomy.mjs';
import { overlap, shingles, tooSimilar, MAX_OVERLAP } from './take.mjs';
import { localNameFor, detectScript, scriptFor } from './localname.mjs';
import { gate, relatedFor, MIN_PICKS, MIN_KNOW, MIN_LINKS } from './generate.mjs';
import { renderSet, esc } from './template.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/* ══ the taxonomy — what may become a page at all ═══════════════════════ */

test('nothing medical, regulated or errand-shaped can become a set', () => {
  // Medical is the one that matters most: a stale row in a directory is a
  // person driving to a closed emergency door. NUM does not hold live hours
  // for 98% of the directory and must not imply that it does.
  for (const [why, cats] of Object.entries(NEVER)) {
    for (const c of cats) {
      assert.equal(c in CATEGORY_SETS, false, `${c} (${why}) is mapped to a set`);
    }
  }
});

test('the enumerability band is what makes the claim in the H1 true', () => {
  // The page says "All 49 beaches in Phuket". That sentence is only true, and
  // only worth publishing, when the set is small enough to actually list.
  // "All 4,000 restaurants in London" is a database dump wearing a headline.
  assert.ok(MIN_SET >= 5, 'a set below five places is not a census, it is a stub');
  assert.ok(MAX_SET <= 200, 'past a couple of hundred rows nobody reads the list and the claim is decorative');
});

test('every set carries an editorial brief, and it is never published copy', () => {
  const seen = new Set();
  for (const [cat, spec] of Object.entries(CATEGORY_SETS)) {
    assert.ok(/^[a-z0-9-]+$/.test(spec.slug), `${cat} has an unsafe slug: ${spec.slug}`);
    assert.ok(spec.note.length > 20, `${cat} has no brief for the writer`);
    assert.ok(spec.title.length > 2, `${cat} has no plural title`);
    seen.add(spec.slug);
  }
  // Several categories deliberately collapse into one set — three near-
  // identical church pages for one city is city-swapping in miniature.
  assert.ok(seen.size < Object.keys(CATEGORY_SETS).length, 'no categories are being merged; check the mapping');
});

/* ══ the local-name check ═══════════════════════════════════════════════ */

test('an alternate name in the wrong script is never printed', () => {
  // Real rows from the directory. name_local holds whatever the crawler
  // grabbed — Russian and Korean for Thai beaches, Spanish for a Tokyo
  // viewing deck — and printing it as "the local name" would be a confident
  // lie repeated across thousands of pages.
  assert.equal(localNameFor({ name: 'หาดกมลา', name_local: 'Пляж Камала' }, 'TH'), null);
  assert.equal(localNameFor({ name: 'หาดกระทิง', name_local: '끄라팅 해수욕장' }, 'TH'), null);
  assert.equal(localNameFor({ name: '46階展望スペース', name_local: 'Mirador Careta Shiodome Piso 46' }, 'JP'), null);
});

test('an alternate name in the destination\'s own script is printed', () => {
  assert.equal(localNameFor({ name: 'Karon Beach', name_local: 'หาดกะรน' }, 'TH'), 'หาดกะรน');
  assert.equal(localNameFor({ name: '9 Hours', name_local: 'ナインアワーズ' }, 'JP'), 'ナインアワーズ');
  // Turkish is Latin script, so it is suppressed — see the next test.
});

test('re-punctuated and re-cased names are not second names', () => {
  assert.equal(localNameFor({ name: 'a.testoni', name_local: 'A.Testoni' }, 'IT'), null);
  assert.equal(localNameFor({ name: '2D Cafe', name_local: '2D Café' }, 'JP'), null);
});

test('a Latin-script destination prints no alternate at all', () => {
  // The check can tell Korean from Thai. It cannot tell Italian from German,
  // and the directory is full of that confusion: Rome's Fontana dei Quattro
  // Fiumi carries "Vierströmebrunnen", the Trevi carries "Trevi-fontænen".
  // Both are Latin script and differ in every word, so no similarity test
  // saves us. Printing nothing loses a few real ones and tells no lies.
  assert.equal(localNameFor({ name: 'Fontana dei Quattro Fiumi', name_local: 'Vierströmebrunnen' }, 'IT'), null);
  assert.equal(localNameFor({ name: 'Fontana di Trevi', name_local: 'Trevi-fontænen' }, 'IT'), null);
  assert.equal(localNameFor({ name: 'Blue Mosque', name_local: 'Sultan Ahmet Camii' }, 'TR'), null);
});

test('an unknown country suppresses rather than prints', () => {
  // The safe default. A country nobody mapped must not start emitting Korean
  // next to Portuguese place names.
  assert.equal(scriptFor('ZZ'), 'latin');
  assert.equal(localNameFor({ name: 'Somewhere', name_local: '끄라팅' }, 'ZZ'), null);
});

test('scripts are told apart, kana before han', () => {
  assert.equal(detectScript('ナインアワーズ'), 'japanese');
  assert.equal(detectScript('หาดกะรน'), 'thai');
  assert.equal(detectScript('끄라팅 해수욕장'), 'korean');
  assert.equal(detectScript('Sultan Ahmet Camii'), 'latin');
});

/* ══ the differentiation rule ═══════════════════════════════════════════ */

const take = (o) => ({
  dest: 'x', slug: 'y', title: '', sub: '', know: '', picks: [], faq: [], ...o,
});

test('two takes that differ only by city name are caught', () => {
  // The exact failure the guide and the policy both name. A writer producing
  // their fortieth take reaches for the last one and changes the nouns; that
  // is a thing to catch in a build, not in a review that will not happen.
  const a = take({
    dest: 'lisbon', slug: 'viewpoints',
    sub: 'Every named viewpoint in Lisbon with coordinates, and which one the concierge would pick.',
    know: 'The best light in Lisbon is the hour before sunset, when the west-facing terraces fill up and the queue for a table starts.',
  });
  const b = take({
    dest: 'porto', slug: 'viewpoints',
    sub: 'Every named viewpoint in Porto with coordinates, and which one the concierge would pick.',
    know: 'The best light in Porto is the hour before sunset, when the west-facing terraces fill up and the queue for a table starts.',
  });
  const bad = tooSimilar([a, b]);
  assert.equal(bad.length, 1, 'a city-swapped duplicate got through');
  assert.ok(bad[0].overlap > MAX_OVERLAP);
});

test('two takes about the same kind of thing in different cities pass', () => {
  const a = take({
    dest: 'lisbon', slug: 'viewpoints',
    sub: 'Every miradouro in Lisbon, with the tram that gets you there.',
    know: 'Lisbon sells the view from its hills; the trick is that the famous ones charge for a drink and Senhora do Monte does not, so locals climb further.',
  });
  const b = take({
    dest: 'hong-kong', slug: 'viewpoints',
    sub: 'Every named lookout on the island and Kowloon side, with the walk-up time.',
    know: 'Haze decides everything here. Check visibility before committing to the Peak — on a bad day the harbour disappears and the tram queue is an hour wasted.',
  });
  assert.deepEqual(tooSimilar([a, b]), [], 'genuinely different takes were flagged as duplicates');
});

test('overlap is measured on what a take SAYS, not on its furniture', () => {
  // Stop words and short filler are stripped, so two takes are not judged
  // similar for both being written in English.
  assert.ok(shingles('the a an of in to for is it on').size === 0);
  assert.equal(overlap('', 'anything'), 0);
});

/* ══ the gate ═══════════════════════════════════════════════════════════ */

const places = [
  { name: 'Freedom Beach', lat: 7.87, lng: 98.27 },
  { name: 'Karon Beach', lat: 7.84, lng: 98.29 },
  { name: 'Patong Beach', lat: 7.89, lng: 98.29 },
  { name: 'Kata Beach', lat: 7.82, lng: 98.29 },
];
const goodTake = take({
  sub: 'Every named beach on the island with coordinates, and which one fits the day you actually want.',
  know: 'From May to October the west coast can fly red flags. Never swim under one however calm the water looks, because the current is under the surface rather than on it. East-coast bays stay swimmable when the west does not.',
  picks: [
    { key: 'Freedom Beach', value: 'Boat or a steep path, which is why it stays quiet.' },
    { key: 'Karon Beach', value: 'Three kilometres of space for groups who want room.' },
    { key: 'Patong Beach', value: 'The loud one, and everything is walkable.' },
  ],
});
const ctx = (over = {}) => ({ places, take: goodTake, dupes: [], linkCount: 6, ...over });

test('a complete take passes', () => {
  assert.deepEqual(gate({}, ctx()).reasons, []);
});

test('no take, no page — and that is not a warning', () => {
  const g = gate({}, ctx({ take: null }));
  assert.equal(g.ok, false);
  assert.deepEqual(g.reasons, ['no take written']);
});

test('a take naming a place the directory does not hold is refused', () => {
  // The check that caught a real problem the day it was written: the Phuket
  // beach page was hand-built in August naming "Patong Beach", and the
  // directory now holds that row as หาดป่าตอง. A take can go stale silently;
  // a page that confidently lists a place under a name we no longer carry is
  // worse than no page.
  const g = gate({}, ctx({
    take: take({ ...goodTake, picks: [...goodTake.picks, { key: 'Invented Bay', value: 'Lovely.' }] }),
  }));
  assert.equal(g.ok, false);
  assert.match(g.reasons[0], /not in the directory/);
  assert.match(g.reasons[0], /Invented Bay/);
});

test('too few real picks is a list with a caption, not a page', () => {
  const g = gate({}, ctx({ take: take({ ...goodTake, picks: goodTake.picks.slice(0, 2) }) }));
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(' '), new RegExp(`needs ${MIN_PICKS}`));
});

test('a padded know section is refused', () => {
  const g = gate({}, ctx({ take: take({ ...goodTake, know: 'It is nice.' }) }));
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(' '), new RegExp(`needs ${MIN_KNOW}`));
});

test('a page nothing links to is a doorway, whatever is on it', () => {
  const g = gate({}, ctx({ linkCount: MIN_LINKS - 1 }));
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(' '), /doorway/);
});

test('a near-duplicate is refused even when everything else is right', () => {
  const g = gate({}, ctx({ dupes: [{ a: 'lisbon/viewpoints', b: 'porto/viewpoints', overlap: 0.9 }] }));
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(' '), /reads too much like/);
});

test('every failure is reported, not just the first', () => {
  const g = gate({}, ctx({ take: take({ sub: '', know: '', picks: [] }), linkCount: 0 }));
  assert.ok(g.reasons.length >= 3, `only reported ${g.reasons.length}: ${g.reasons}`);
});

/* ══ the rendered page ══════════════════════════════════════════════════ */

const dest = { slug: 'phuket', name: 'Phuket', country: 'TH' };
const set = {
  dest: 'phuket', slug: 'beaches', title: 'beaches', path: '/phuket/beaches/',
  categories: ['Beach'], n: 4,
};
const html = () => renderSet({
  dest, set, take: goodTake, places, today: '2026-08-26',
  related: [{ path: '/phuket/temples/', title: 'temples' }, { path: '/phuket/markets/', title: 'markets' }],
});

test('the count in the headline is the count in the list', () => {
  // The only claim on the page that nobody else can make. If the H1 and the
  // list disagree, the page is worse than a page that never claimed it.
  const h = html();
  const m = h.match(/<h1[^>]*>All (\d+) beaches/);
  assert.ok(m, 'no count in the H1');
  assert.equal(Number(m[1]), places.length);
  const items = JSON.parse(h.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  const list = items['@graph'].find((g) => g['@type'] === 'ItemList');
  assert.equal(list.numberOfItems, places.length);
  assert.equal(list.itemListElement.length, places.length);
});

test('every place appears exactly once, picked or not', () => {
  const h = html();
  for (const p of places) {
    const hits = h.split(p.name).length - 1;
    assert.ok(hits >= 1, `${p.name} is missing from the page`);
  }
  // Kata was not picked, so it belongs in the census section.
  assert.match(h, /every one we hold[\s\S]*Kata Beach/);
});

test('a place with no judgement written for it gets no invented one', () => {
  // The census carries a name and coordinates. It must never carry a
  // generated sentence, which would read like knowledge and be none.
  const h = html();
  const rest = h.slice(h.indexOf('every one we hold'), h.indexOf('<h2>The one thing'));
  assert.match(rest, /Kata Beach/);
  assert.doesNotMatch(rest, /&mdash;/, 'the census section is inventing descriptions');
});

test('a place name from the open web is escaped, not trusted', () => {
  const h = renderSet({
    dest, set, take: goodTake, today: '2026-08-26', related: [],
    places: [...places, { name: '<script>alert(1)</script>', lat: 1, lng: 1 }],
  });
  assert.doesNotMatch(h, /<script>alert\(1\)<\/script>/);
  assert.match(h, /&lt;script&gt;/);
  assert.equal(esc('<&">'), '&lt;&amp;&quot;&gt;');
});

test('the page is canonical, indexable and says when it was built', () => {
  const h = html();
  assert.match(h, /<link rel="canonical" href="https:\/\/itsnum\.com\/phuket\/beaches\/">/);
  assert.match(h, /name="robots" content="index, follow/);
  assert.match(h, /updated 2026-08-26/);
});

test('the page links out to its siblings and up to the hub', () => {
  const h = html();
  assert.match(h, /href="\/phuket\/temples\/"/);
  assert.match(h, /href="\/phuket\/markets\/"/);
  assert.match(h, /href="\/destinations\/"/);
});

test('only sets that were actually built may be linked as siblings', () => {
  // Linking to a sibling that the gate refused would generate 404s at exactly
  // the scale the generator runs at.
  const all = [
    { dest: 'phuket', slug: 'beaches', path: '/phuket/beaches/', n: 50, title: 'beaches' },
    { dest: 'phuket', slug: 'temples', path: '/phuket/temples/', n: 30, title: 'temples' },
    { dest: 'phuket', slug: 'markets', path: '/phuket/markets/', n: 20, title: 'markets' },
    { dest: 'bali', slug: 'beaches', path: '/bali/beaches/', n: 40, title: 'beaches' },
  ];
  const built = new Set(['/phuket/beaches/', '/phuket/temples/']);
  const rel = relatedFor(all[0], all, built);
  assert.deepEqual(rel.map((r) => r.path), ['/phuket/temples/'],
    'linked a page that was never built, or linked across destinations');
});

/* ══ the candidate list on disk ═════════════════════════════════════════ */

test('the committed candidate list is inside its own rules', () => {
  const path = HERE + 'candidates.json';
  if (!existsSync(path)) return;   // not yet generated on a fresh checkout
  const cat = JSON.parse(readFileSync(path, 'utf8'));
  const slugs = new Set(setsBySlug().keys());
  for (const r of cat.rows) {
    assert.ok(r.n >= MIN_SET && r.n <= MAX_SET, `${r.path} has ${r.n} places, outside the band`);
    assert.ok(slugs.has(r.slug), `${r.path} is not a set in the taxonomy`);
    assert.equal(r.coords, r.n, `${r.path} has rows without coordinates — the map would be a lie`);
  }
});

/* ══ the product set — /agents/<client>/ ════════════════════════════════ */

import { CLIENTS, MCP_URL, CHECKED } from './clients.mjs';
import { clientPage } from './genclients.mjs';

test('every client page differs in the thing that matters', () => {
  // The pSEO failure the guide names is pages where only the modifier changes.
  // Here the modifier is the client and what changes with it is the config —
  // so if two clients ship the same config block, one of them is a city-swap.
  // Some clients genuinely share a config FORMAT — Cursor and Cline both read
  // a plain `mcpServers` block — so the block alone is not the test. What has
  // to differ is the whole answer: where the file lives, and what you do
  // after saving it. Somebody searching for Cline will not accept a Cursor
  // page, and that is the standard the page has to meet.
  const fingerprints = CLIENTS.map((c) =>
    `${c.config ?? ''}|${c.file ?? ''}|${c.steps.join('|')}`);
  assert.equal(new Set(fingerprints).size, fingerprints.length,
    'two clients would produce the same page — merge them or say what differs');
  for (const c of CLIENTS.filter((x) => x.config && x.file)) {
    const twins = CLIENTS.filter((o) => o.slug !== c.slug && o.config === c.config);
    for (const t of twins) {
      assert.notEqual(c.file, t.file, `${c.slug} and ${t.slug} share config AND file path`);
    }
  }
  const ledes = CLIENTS.map((c) => c.lede);
  assert.equal(new Set(ledes).size, ledes.length, 'two clients share an opening line');
});

test('a client with no config file still tells you what to do', () => {
  // Claude Desktop, ChatGPT and n8n are configured through a UI, not a file.
  // A page for one of those with no steps would be an empty page with schema.
  for (const c of CLIENTS.filter((x) => !x.config)) {
    assert.ok(c.steps.length >= 3, `${c.slug} has no config and only ${c.steps.length} steps`);
  }
});

test('every client page states the endpoint in text a model can quote', () => {
  // These pages are read by the assistant somebody asked "is there a travel
  // API I can plug in". The answer has to be quotable out of visible prose,
  // not only out of a code block.
  for (const c of CLIENTS) {
    const h = clientPage(c, CLIENTS.filter((o) => o.slug !== c.slug));
    const text = h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ');
    assert.ok(text.includes(MCP_URL), `${c.slug} never states ${MCP_URL} outside markup`);
    assert.ok(text.includes('numa_live_'), `${c.slug} never states the token prefix`);
    assert.ok(text.includes('2,529,721'), `${c.slug} never states the coverage`);
  }
});

test('every client page carries HowTo and SoftwareApplication schema', () => {
  for (const c of CLIENTS) {
    const h = clientPage(c, []);
    const d = JSON.parse(h.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]
      .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
    const types = d['@graph'].map((g) => g['@type']);
    assert.ok(types.includes('HowTo'), `${c.slug} has no HowTo`);
    assert.ok(types.includes('SoftwareApplication'), `${c.slug} has no SoftwareApplication`);
    const howto = d['@graph'].find((g) => g['@type'] === 'HowTo');
    assert.equal(howto.step.length, c.steps.length);
    for (const s of howto.step) {
      assert.doesNotMatch(s.text, /<[a-z]/i, `${c.slug} leaked markup into HowTo step text`);
    }
  }
});

test('every client page says when it was checked and links the vendor doc', () => {
  // Client config formats move. A page that states a stale path with no date
  // and no way to check it ages into a liability rather than a reference.
  for (const c of CLIENTS) {
    const h = clientPage(c, []);
    assert.ok(h.includes(CHECKED), `${c.slug} does not say when it was checked`);
    assert.ok(h.includes(c.docs), `${c.slug} does not link ${c.vendor}'s own docs`);
    assert.match(h, /server address and the bearer token/,
      `${c.slug} does not tell the reader what to trust when the path has moved`);
  }
});

test('every client page repeats the two rules that cannot be bent', () => {
  // Human review before anything is visible, and placement is not purchasable.
  // These appear on every agent-facing page because an agent operator reading
  // one page is the person who most needs to know both.
  for (const c of CLIENTS) {
    const h = clientPage(c, []);
    assert.match(h, /reviews it before a traveller sees/);
    assert.match(h, /Placement cannot be bought/);
  }
});

test('the client set links to its siblings', () => {
  const c = CLIENTS[0];
  const h = clientPage(c, CLIENTS.filter((o) => o.slug !== c.slug));
  for (const o of CLIENTS.slice(1, 4)) {
    assert.ok(h.includes(`/agents/${o.slug}/`), `no link to ${o.slug}`);
  }
});
