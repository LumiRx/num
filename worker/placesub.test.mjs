// A business we do not already hold, describing itself.
//
// `places` covers 2.5M venues crawled off the open web and is still not
// everyone. Before this, an owner we had no listing for typed their name into
// the claim form and the claim landed bound to nothing — no address, no
// coordinates, nothing a concierge could ever recommend.
//
// The load-bearing decision, asserted below: what they type does NOT go into
// `places`. It is held, geocoded and reviewed first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = (p) => fileURLToPath(new URL(p, import.meta.url));
const SQL = readFileSync(HERE('./migrations/0007_place_submissions.sql'), 'utf8');
const WORKER = readFileSync(HERE('../growth/worker.js'), 'utf8');
const PAGE = readFileSync(HERE('../public/claim/index.html'), 'utf8');

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(SQL);
  return d;
}
const refuses = (d, sql) => assert.throws(() => d.exec(sql));
const allows = (d, sql) => assert.doesNotThrow(() => d.exec(sql));

const SUB = (id, extra = '') =>
  `INSERT INTO num_place_submissions (id,name${extra ? ',' + extra[0] : ''})
   VALUES ('${id}','Kata Rocks'${extra ? ',' + extra[1] : ''})`;

/* ── the table ──────────────────────────────────────────────────────────── */

test('a submission needs only a name — the rest can come later', () => {
  // An owner on a phone outside their own shop should be able to finish. Every
  // required field is one more chance for them to stop.
  const d = db();
  allows(d, SUB('s1'));
  const r = d.prepare('SELECT * FROM num_place_submissions').get();
  assert.equal(r.status, 'new');
  assert.equal(r.lat, null);
  assert.equal(r.lng, null);
});

test('coordinates are nullable here, which is the whole reason it exists', () => {
  // places.lat/lng are NOT NULL. A typed address is not coordinates, and
  // writing 0,0 to satisfy that constraint puts a pin in the Gulf of Guinea —
  // and into cell_lat/cell_lng, the index the concierge searches by proximity.
  const cols = db().prepare('PRAGMA table_info(num_place_submissions)').all();
  for (const c of cols.filter((x) => x.name === 'lat' || x.name === 'lng')) {
    assert.equal(c.notnull, 0, `${c.name} must be nullable`);
  }
});

test('a status outside the known set is refused', () => {
  const d = db();
  allows(d, SUB('s1', ['status', "'geocoded'"]));
  refuses(d, SUB('s2', ['status', "'live'"]));
  refuses(d, SUB('s3', ['status', "'approved'"]));
});

test('a promoted submission must say which place it became', () => {
  // Otherwise the table can report work it did not do, and a review queue that
  // lies about its own output is worse than no queue.
  const d = db();
  refuses(d, SUB('s1', ['status', "'promoted'"]));
  refuses(d, SUB('s2', ['status', "'duplicate'"]));
  allows(d, SUB('s3', ['status,place_id', "'promoted','PLACE_A'"]));
  allows(d, SUB('s4', ['status,place_id', "'duplicate','PLACE_B'"]));
});

test('rejected needs no place, because it never became one', () => {
  allows(db(), SUB('s1', ['status', "'rejected'"]));
});

test('no payment instrument anywhere', () => {
  const banned = /card|pan\b|cvv|cvc|iban|swift|routing|account_number|bank|wallet|stripe_|paypal/i;
  for (const c of db().prepare('PRAGMA table_info(num_place_submissions)').all()) {
    assert.doesNotMatch(c.name, banned, c.name);
  }
});

/* ── the worker ─────────────────────────────────────────────────────────── */

const cleanUrlFn = () => {
  const i = WORKER.indexOf('function cleanUrl(');
  assert.ok(i > 0, 'cleanUrl not found in worker.js');
  const j = WORKER.indexOf('\n}', i);
  // eslint-disable-next-line no-new-func
  return new Function(`${WORKER.slice(i, j + 2)}\nreturn cleanUrl;`)();
};

test('a website survives being cleaned', () => {
  // clean() would have mangled it: ':' is not on its whitelist, so
  // "https://x.com" came back as "https //x.com" — no longer a link at all.
  const u = cleanUrlFn();
  assert.equal(u('https://katarocks.com'), 'https://katarocks.com/');
  assert.equal(u('http://katarocks.com/rooms'), 'http://katarocks.com/rooms');
  // Owners type the bare host far more often than the scheme.
  assert.equal(u('katarocks.com'), 'https://katarocks.com/');
  assert.equal(u('  www.katarocks.co.th  '), 'https://www.katarocks.co.th/');
});

test('a website that is not a website is dropped, not stored', () => {
  const u = cleanUrlFn();
  // This is the one that matters: an owner's "website" is shown back to
  // people. A javascript: or data: string stored here and later rendered as a
  // link is a stored XSS with a business name on it.
  assert.equal(u('javascript:alert(1)'), '');
  assert.equal(u('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(u('mailto:me@x.com'), '');
  assert.equal(u('file:///etc/passwd'), '');
  // Not a public hostname.
  assert.equal(u('localhost'), '');
  assert.equal(u('http://intranet/'), '');
  assert.equal(u(''), '');
  assert.equal(u(null), '');
  assert.equal(u('https://x.com/' + 'a'.repeat(400)), '', 'over the length cap');
});

test('the submission is written only when no listing was picked', () => {
  // If they selected their real listing we already hold the address, the
  // coordinates and the category — better than anything typed into a form.
  assert.match(WORKER, /if \(!placeId && \(/);
  const cond = WORKER.slice(WORKER.indexOf('if (!placeId && ('));
  assert.match(cond.slice(0, 120), /^if \(!placeId && \([^)]*\)\) \{/);
});

test('the submission never writes to places', () => {
  const i = WORKER.indexOf('const subAddress');
  const block = WORKER.slice(i, WORKER.indexOf('if (email) {', i));
  assert.match(block, /INSERT INTO num_place_submissions/);
  assert.doesNotMatch(block, /INSERT INTO places/i);
  assert.doesNotMatch(block, /UPDATE places/i);
});

test('the submission is tied to the claim it came in on', () => {
  // There is no anonymous "add a business" path. A listing with nobody behind
  // it is the thing this is trying not to create more of.
  const i = WORKER.indexOf('const subAddress');
  const block = WORKER.slice(i, WORKER.indexOf('if (email) {', i));
  assert.match(block, /claim_id/);
  assert.match(block, /ins\?\.meta\?\.last_row_id/);
});

/* ── the page ───────────────────────────────────────────────────────────── */

test('the fields appear only after a lookup came back empty', () => {
  // Showing them upfront doubles the apparent length of the form at the exact
  // moment someone decides whether to start.
  const picker = PAGE.slice(PAGE.indexOf('---- listing picker'));
  assert.match(picker, /if \(!rows\.length\) showNewbiz\(true\);/);
  assert.match(PAGE, /<div id="newbiz" class="newbiz hidden">/);
});

test('picking a listing hides them again', () => {
  const picker = PAGE.slice(PAGE.indexOf('---- listing picker'));
  const chip = picker.slice(picker.indexOf('function showChip'));
  assert.match(chip.slice(0, 400), /showNewbiz\(false\)/);
});

test('"not this one" brings them back', () => {
  const picker = PAGE.slice(PAGE.indexOf('---- listing picker'));
  const clear = picker.slice(picker.indexOf('clearBtn.addEventListener'));
  assert.match(clear.slice(0, 400), /showNewbiz\(true\)/);
});

test('with no destination the fields are offered straight away', () => {
  // Without ?d= the lookup can never run — a printed flyer, or someone typing
  // the address in. Leaving them a name box and no way to say where they are
  // would be the old behaviour with extra steps.
  const picker = PAGE.slice(PAGE.indexOf('---- listing picker'));
  assert.match(picker, /else if \(!dest\) showNewbiz\(true\);/);
});

test('the page sends what the server reads', () => {
  const submit = PAGE.slice(PAGE.indexOf('var payload = {'));
  for (const f of ['address', 'website', 'category']) {
    assert.match(submit.slice(0, 1400), new RegExp(`${f}:\\s+\\$\\("${f}"\\)\\.value`));
  }
});

test('none of the new fields can block a submit', () => {
  // Same rule as the listing picker. A business that will not tell us its
  // address is still a business, and refusing it buys nothing.
  const submit = PAGE.slice(PAGE.indexOf('form.addEventListener("submit"'));
  const guards = submit.slice(
    submit.indexOf('if (!payload.business_name)'),
    submit.indexOf('sending = true'),
  );
  for (const f of ['address', 'website', 'category']) {
    assert.doesNotMatch(guards, new RegExp(`payload\\.${f}`), `${f} must not gate submit`);
  }
});

/* ── every language, every key ──────────────────────────────────────────── */

// Read the language codes off the LANGS table rather than hardcoding them, so
// adding a language to the page automatically widens what this file demands.
const LANG_CODES = (() => {
  const block = PAGE.slice(PAGE.indexOf('var LANGS = ['), PAGE.indexOf('function langDef'));
  const codes = [...block.matchAll(/code:\s*"([a-z]{2})"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 3, 'expected at least th, id and en');
  return codes;
})();

test('every language block carries every key the page reads', () => {
  // A missing key is not a crash — it is `undefined` printed into a label, in
  // front of the one person who cannot read the language it fell back from.
  const copy = PAGE.slice(PAGE.indexOf('var COPY = {'), PAGE.indexOf('var MONEY = {'));
  const keys = [...copy.matchAll(/^\s{6}([a-zA-Z]+):/gm)].map((m) => m[1]);
  const counts = keys.reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {});
  const short = Object.entries(counts).filter(([, n]) => n !== LANG_CODES.length);
  assert.deepEqual(short, [],
    `these keys are not present in all ${LANG_CODES.length} languages: ` +
      short.map(([k, n]) => `${k} (${n})`).join(', '));
});

test('the language switcher offers every language, each in its own script', () => {
  // A person who cannot read English cannot find "Indonesian" in a list
  // written in English — the one case the switcher exists for.
  const bar = PAGE.slice(PAGE.indexOf('<div class="langs"'), PAGE.indexOf('</header>'));
  for (const code of LANG_CODES) {
    assert.match(bar, new RegExp(`data-lang="${code}"`), `no button for ${code}`);
  }
  assert.match(bar, /data-lang="th" lang="th">ไทย</);
  assert.match(bar, /data-lang="id" lang="id">Bahasa</);
});

test('Indonesia resolves to Indonesian by country and by clock', () => {
  const block = PAGE.slice(PAGE.indexOf('var LANGS = ['), PAGE.indexOf('function langDef'));
  const id = block.slice(block.indexOf('code: "id"'));
  assert.match(id, /iso: \["ID"\]/);
  // Bali is UTC+8 — Asia/Makassar, not Asia/Jakarta. Listing only Jakarta
  // would miss the exact business this was built for.
  assert.match(id, /Asia\/Makassar/);
  assert.match(id, /Asia\/Jakarta/);
});

test('English is last, so it is what everything falls back to', () => {
  assert.equal(LANG_CODES[LANG_CODES.length - 1], 'en');
});

test('every language declares a text direction', () => {
  // Carried per language rather than assumed, so the day this list gets Arabic
  // or Hebrew the form lays out right-to-left instead of half-remembering to.
  const block = PAGE.slice(PAGE.indexOf('var LANGS = ['), PAGE.indexOf('function langDef'));
  const dirs = [...block.matchAll(/dir:\s*"(ltr|rtl)"/g)];
  assert.equal(dirs.length, LANG_CODES.length);
  assert.match(PAGE, /\$\("name_local"\)\.setAttribute\("dir", def\.dir\)/);
});

/* ── the name on the sign ───────────────────────────────────────────────── */

test('the local-name field is sent, stored, and never transliterated', () => {
  assert.match(PAGE, /name_local:\s+\$\("name_local"\)\.value\.trim\(\)/);
  assert.match(WORKER, /const subLocal = clean\(b\.name_local, 120\)/);
  assert.match(WORKER, /INSERT INTO num_place_submissions\s*\n\s*\(id,name,name_local,lang,/);
  // No romanisation, no normalisation, no "correction" anywhere near it.
  const i = WORKER.indexOf('const subLocal');
  const block = WORKER.slice(i, i + 900);
  assert.doesNotMatch(block, /translit|romani[sz]|normalize\(|toLowerCase|toUpperCase/i);
});

test('the local name alone is enough to record a submission', () => {
  // An owner who gives us only the name on their sign has still told us
  // something we did not have. Requiring an address too would throw it away.
  assert.match(WORKER, /if \(!placeId && \(subAddress \|\| subWebsite \|\| subLocal\)\) \{/);
});

test('the field is tagged with the language it collects', () => {
  // So the browser offers the right keyboard and a screen reader uses the
  // right voice.
  assert.match(PAGE, /\$\("name_local"\)\.setAttribute\("lang", lang\)/);
});

test('English does not ask an English speaker for their English name', () => {
  assert.match(PAGE, /var localOn = lang !== "en";/);
});

test('the language the form was in is stored with the submission', () => {
  // Indonesian and English share an alphabet, so the characters tell you
  // nothing about which language to write back in.
  assert.match(WORKER, /const subLang = \/\^\[a-z\]\{2\}\$\/\.test/);
  const cols = db().prepare('PRAGMA table_info(num_place_submissions)').all().map((c) => c.name);
  assert.ok(cols.includes('lang'));
  assert.ok(cols.includes('name_local'));
});

test('the page names one support address, and it is the sending one', () => {
  // A business checking whether the email that brought them here is real
  // reads both. Two different addresses is the tell that reads as phishing.
  const addrs = [...PAGE.matchAll(/mailto:([^"']+)/g)].map((m) => m[1]);
  assert.ok(addrs.length > 0);
  assert.deepEqual([...new Set(addrs)], ['info@itsnum.com']);
});
