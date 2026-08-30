/**
 * The invite must quote the fee the ledger will actually charge.
 *
 * This suite exists because it did not. Until 25 Aug 2026 the invite copy said
 * "10% only when a booking actually happens" in both the text part and the
 * HTML template, hardcoded, for every category. `commission.mjs` bills stays
 * at 15%. So every hotel NUM invited was told a rate a third below the one it
 * would be invoiced — the kind of error that is invisible until a merchant
 * reads their first statement, and unrecoverable afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateInvite, directLine, isFreemail, FREEMAIL } from './invite_gen.mjs';
import { feeSentence, RATES } from '../worker/commission.mjs';

const TEMPLATE = readFileSync(new URL('../campaign/invite_v2.html', import.meta.url), 'utf8');

const lead = (over = {}) => ({
  id: 'ld_1', name: 'The Royal Crescent Hotel', email: 'x@example.com',
  city: 'Bath', country: 'GB', category: 'Hotel', ...over,
});

test('a hotel is quoted the stay rate, not 10%', () => {
  const d = generateInvite(lead(), { template: TEMPLATE, token: 't' });
  assert.match(d.fee_line, /15%/);
  assert.match(d.text, /15% of the booking value/);
  assert.doesNotMatch(d.text, /10% only when a booking actually happens/);
  assert.doesNotMatch(d.html, /10% only when a booking actually happens/);
});

test('a restaurant is quoted BOTH numbers, never just one', () => {
  // Changed 26 Aug 2026, and this is the whole point of the file. A venue
  // quoted only "10% of the bill" and then invoiced $2 has been told one price
  // and charged another; a venue quoted only "$2" and later invoiced 10% of a
  // $300 dinner has been told a price a fifteenth of the real one. Both
  // numbers, in the same sentence, or the invite is lying either way.
  const d = generateInvite(lead({ id: 'ld_2', name: 'Sally Lunn\'s', category: 'Restaurant' }), { template: TEMPLATE, token: 't' });
  assert.match(d.fee_line, /10% of the bill/);
  assert.match(d.fee_line, /\$2 per confirmed table/);
});

test('a Thai restaurant is quoted the same thing as everyone else', () => {
  // It used to be a country override — TH alone got 10%, because Thai venues
  // were the only ones on the bill QR. The rule is now about whether the bill
  // can be seen at all, which is not a fact about Thailand.
  const th = generateInvite(lead({ id: 'ld_3', name: 'Suay', city: 'Phuket', country: 'TH', category: 'Restaurant' }), { template: TEMPLATE, token: 't' });
  const gb = generateInvite(lead({ id: 'ld_3b', name: 'The Longtail', city: 'London', country: 'GB', category: 'Restaurant' }), { template: TEMPLATE, token: 't' });
  assert.match(th.fee_line, /10% of the bill/);
  assert.equal(th.fee_line, gb.fee_line, 'the country override outlived its removal');
});

test('guesthouses, hostels and apartments are all stays', () => {
  for (const category of ['Guesthouse', 'Hostel', 'Apartment', 'Resort', 'Villa']) {
    const d = generateInvite(lead({ id: `ld_${category}`, category }), { template: TEMPLATE, token: 't' });
    assert.match(d.fee_line, /15%/, `${category} should be billed as a stay`);
  }
});

test('the rendered HTML carries the fee line and no unfilled placeholder', () => {
  const d = generateInvite(lead(), { template: TEMPLATE, token: 't' });
  assert.ok(d.html.includes('15% of the booking value'), 'fee line missing from HTML');
  assert.doesNotMatch(d.html, /\{\{fee_line\}\}/);
});

test('no fee number is hardcoded anywhere in the invite sources', () => {
  // A number typed into copy is a promise that drifts the day a rate changes.
  // Comments are stripped first: this file's own history explains WHY the old
  // "10%" line was wrong, and a guard that forbids recording the mistake is a
  // guard that deletes the reason the mistake is not repeated.
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  for (const f of ['./invite_gen.mjs', '../campaign/invite_v2.html']) {
    const src = strip(readFileSync(new URL(f, import.meta.url), 'utf8'));
    assert.doesNotMatch(src, /\d+% only when/, `${f} still hardcodes a fee`);
    assert.doesNotMatch(src, /Roughly half what the big travel sites take/, `${f} still claims a rate comparison`);
  }
});

test('feeSentence covers every rate the ledger can charge', () => {
  // A new RATES entry with no sentence would silently fall through to
  // "No fee." in an outbound email.
  for (const [key, r] of Object.entries(RATES)) {
    const s = feeSentence({ category: key === 'stay' ? 'Hotel' : key === 'activity' ? 'Tour' : key === 'appointment' ? 'Spa' : key === 'delivery' ? 'Delivery' : 'Restaurant' });
    assert.notEqual(s, 'No fee.', `${key} produced no sentence`);
    assert.ok(s.includes(r.note) || s.includes(r.note.replace('$2', '$2')), `${key}: sentence should quote the rate's own note`);
  }
});

test('the quoted percentage tracks the rate that will be billed', () => {
  // The mutation this catches: halve `stay.bp` and leave the sentence saying
  // 15%. That is not hypothetical — the first version of this fix quoted a
  // hand-written note beside the machine number and survived exactly that
  // edit, which is the same defect one layer down.
  for (const [key, r] of Object.entries(RATES)) {
    if (!r.bp) continue;
    assert.match(r.note, new RegExp(`^${r.bp / 100}%`), `${key}: note must state bp`);
  }
  // reservation carries both numbers, so its note must state both — the same
  // no-hand-written-prices rule, applied to a two-part sentence.
  assert.match(RATES.reservation.note, new RegExp(`${RATES.reservation.bp / 100}%`));
  assert.match(RATES.reservation.note, new RegExp(`\\$${RATES.reservation.flat_cs / 100}\\b`));
});

/* ── the direct-booking line ────────────────────────────────────────────── */

test('a hotel with a known booking engine is told which link we hold', () => {
  const d = generateInvite(lead({ booking_link: 'https://direct-book.com/properties/theyardbathdirect', engine: 'SiteMinder' }), { template: TEMPLATE, token: 't' });
  assert.match(d.direct_line, /direct-book\.com/);
  assert.match(d.direct_line, /SiteMinder/);
  assert.ok(d.text.includes(d.direct_line), 'the line must reach the text part');
});

test('no link means no sentence — never a gesture at a page we cannot name', () => {
  assert.equal(generateInvite(lead(), { template: TEMPLATE, token: 't' }).direct_line, '');
  assert.equal(directLine({ booking_link: 'not a url' }), '');
  // These PARSE as URLs, so the try/catch alone does not stop them. A mailto:
  // has no host at all and would render "your own booking page at ,".
  assert.equal(directLine({ booking_link: 'mailto:reservations@hotel.co.uk' }), '');
  assert.equal(directLine({ booking_link: 'tel:+441314770707' }), '');
  assert.equal(directLine({ booking_link: 'javascript:void(0)' }), '');
  assert.equal(directLine({ booking_link: '' }), '');
  assert.equal(directLine({}), '');
});

test('an engine vendor\'s marketing page is not a booking page', () => {
  // Observed live: Hotel Ceilidh-Donia's footer badge resolved to eviivo's own
  // product page. Quoting it back to the hotelier would prove nobody looked.
  assert.equal(directLine({ booking_link: 'https://eviivo.com/products/website-manager/?utm_source=website-builder&utm_medium=footer' }), '');
  assert.equal(directLine({ booking_link: 'https://www.siteminder.com/pricing/' }), '');
  // ...but a real property URL on the same vendor still works.
  assert.match(directLine({ booking_link: 'https://app.littlehotelier.com/properties/no32hotel' }), /littlehotelier\.com/);
});

test('every booking link in the UK sweep is either usable or correctly refused', () => {
  const rows = readFileSync(new URL('../campaign/data/uk-hotel-booking-engines.tsv', import.meta.url), 'utf8')
    .trim().split('\n').slice(1).map((l) => l.split('\t'));
  const withLink = rows.filter((r) => r[3]);
  assert.ok(withLink.length >= 15, `expected the swept links, got ${withLink.length}`);
  let usable = 0;
  for (const [name, , engine, booking_link] of withLink) {
    const line = directLine({ booking_link, engine });
    if (line) { usable++; assert.match(line, /booking page/, name); }
  }
  // 15 links swept, one of them eviivo's marketing page.
  assert.equal(usable, withLink.length - 1);
});

/* ── claims ─────────────────────────────────────────────────────────────── */

test('no invite variant asserts demand NUM cannot evidence', () => {
  // A cold email that says "travellers are asking for you" is disproved the
  // moment the recipient replies "send them over" and nothing arrives. Every
  // variant must survive being read on a day with zero traffic.
  const CLAIMS = [
    /travellers are (already )?asking/i,
    /travellers using NUM are already/i,
    /people are searching for you/i,
    /demand (for|in) your/i,
  ];
  // 40 ids exercises all three variants of each of the four sentence pools.
  for (let i = 0; i < 40; i++) {
    const d = generateInvite(lead({ id: `ld_claim_${i}` }), { template: TEMPLATE, token: 't' });
    for (const re of CLAIMS) {
      assert.doesNotMatch(d.subject, re, `subject variant ${i}`);
      assert.doesNotMatch(d.text, re, `text variant ${i}`);
    }
  }
});

test('LINE is offered where LINE is used, and nowhere else', () => {
  const gb = generateInvite(lead(), { template: TEMPLATE, token: 't' });
  assert.doesNotMatch(gb.text, /LINE|@799pyrus/, 'a Bath hotel has never installed LINE');
  assert.match(gb.text, /reply to this email/);
  const th = generateInvite(lead({ id: 'ld_th', country: 'TH', category: 'Restaurant' }), { template: TEMPLATE, token: 't' });
  assert.match(th.text, /@799pyrus/, 'Thailand runs on LINE');
});

test('the HTML contact block branches on country and escapes the name', () => {
  const gb = generateInvite(lead(), { template: TEMPLATE, token: 't' });
  assert.doesNotMatch(gb.html, /799pyrus/);
  assert.match(gb.html, /reply to this email/);
  assert.doesNotMatch(gb.html, /\{\{contact_block_html\}\}/);
  const th = generateInvite(lead({ id: 'ld_th2', country: 'TH', category: 'Restaurant' }), { template: TEMPLATE, token: 't' });
  assert.match(th.html, /line\.me\/R\/ti\/p\/@799pyrus/);
  // A `_html` field bypasses the merge loop's escaping, so anything
  // lead-derived inside it must already be escaped or it reaches the inbox as
  // markup — and `name` is attacker-controlled the moment a listing is scraped.
  const evil = generateInvite(lead({ id: 'ld_x', country: 'TH', name: '<script>alert(1)</script> Hotel', category: 'Restaurant' }), { template: TEMPLATE, token: 't' });
  assert.doesNotMatch(evil.html, /<script>alert/);
  assert.match(evil.html, /&lt;script&gt;/);
});

/* ── the "back to the website" link ────────────────────────────────────── */

test('every invite carries an attributed link back to itsnum.com/business/', () => {
  const d = generateInvite(lead({ dest: 'Bath' }), { template: TEMPLATE, token: 'TOK123' });
  assert.match(d.website_url, /^https:\/\/itsnum\.com\/business\/\?/);
  const qs = new URL(d.website_url).searchParams;
  assert.equal(qs.get('utm_source'), 'invite');
  assert.equal(qs.get('utm_medium'), 'email');
  assert.equal(qs.get('utm_campaign'), 'bath');
  assert.equal(qs.get('s'), 'TOK123');
  assert.ok(d.text.includes(d.website_url), 'website link missing from text part');
  assert.ok(d.html.includes(d.website_url), 'website link missing from HTML');
  assert.doesNotMatch(d.html, /\{\{website_url\}\}/);
});

test('the website link carries the lead\'s own destination and category, not a fixed default', () => {
  const d = generateInvite(lead({ id: 'ld_wl', dest: 'Los Angeles', category: 'Restaurant' }), { template: TEMPLATE, token: 't' });
  const qs = new URL(d.website_url).searchParams;
  assert.equal(qs.get('utm_campaign'), 'los-angeles');
  assert.equal(qs.get('utm_content'), 'Restaurant');
});

test('FREEMAIL is exported once and shared, not duplicated', () => {
  // The CLI sender used to carry its own copy of this list. A worker cannot
  // import a file that lives only inside a Node script, so the list moved
  // here — this guards against it being copy-pasted back into two places.
  const cliSrc = readFileSync(new URL('./send_invites.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(cliSrc, /const FREEMAIL = new Set/);
  assert.match(cliSrc, /isFreemail \} from '\.\/invite_gen\.mjs'/);
});
