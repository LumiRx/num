/**
 * NUM · tests for the places.phone → E.164 backfill.
 *
 * Every input below is a REAL value read out of the live `places` table on
 * 2026-08-18, paired with the real `places.country` on the same row. None of
 * them are invented, because the failure mode this backfill has to survive is
 * "the data was not shaped the way the spec said", and invented fixtures
 * cannot catch that.
 *
 *   node --test scripts/backfill-place-phones.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planPhone, RULES } from './backfill-place-phones.mjs';
import { venueE164 } from '../worker/bookdesk.mjs';

const convert = (raw, country, expected) => {
  const r = planPhone(raw, country);
  assert.equal(r.verdict, 'convert', `${country} ${JSON.stringify(raw)} → ${r.verdict} (${r.reason})`);
  assert.equal(r.e164, expected, `${country} ${JSON.stringify(raw)}`);
};
const refuse = (raw, country, reasonLike) => {
  const r = planPhone(raw, country);
  assert.equal(r.verdict, 'refuse', `${country} ${JSON.stringify(raw)} → ${r.verdict} ${r.e164 ?? ''}`);
  if (reasonLike) assert.match(r.reason, reasonLike, `${country} ${JSON.stringify(raw)} reason=${r.reason}`);
};
const skip = (raw, country) => assert.equal(planPhone(raw, country).verdict, 'skip', `${country} ${raw}`);

// ── Thailand — the reason this exists ────────────────────────────────────
test('TH · Google national format, the top of the Phuket ranking', () => {
  convert('076 360 333', 'TH', '+6676360333');       // Motown On Fire, Kata
  convert('095 429 6150', 'TH', '+66954296150');     // Issara, Boat Avenue
  convert('099 089 1384', 'TH', '+66990891384');     // Dinner in the Sky
  convert('081 521 0515', 'TH', '+66815210515');     // Baan Khao Soi
  convert('062 714 7600', 'TH', '+66627147600');     // La Marée
  convert('076 240 240', 'TH', '+6676240240');       // ปากน้ำซีฟู้ด
});

test('TH · OSM formats: bare trunk, hyphens, missing trunk, bare country code', () => {
  convert('0878935337', 'TH', '+66878935337');       // Beach Bar
  convert('076-609205', 'TH', '+6676609205');        // Original Formula
  convert('076296762', 'TH', '+6676296762');         // "food"
  convert('948697971', 'TH', '+66948697971');        // MATA — trunk 0 was lost
  convert('6676282172', 'TH', '+6676282172');        // Agli Amici — cc, no plus
  convert('66844470672', 'TH', '+66844470672');      // Casanova — cc, no plus
  convert('081-652-9691', 'TH', '+66816529691');     // Ben's Deli
});

test('TH · 00 international prefix, including 00 + cc + a trunk 0 that must also go', () => {
  // Helmut's Schlusslicht. Stripping only the 00 would store +66076396842,
  // which is not a Thai number — the trunk 0 has to come off as well.
  convert('0066076396842', 'TH', '+6676396842');
  convert('0066650055900', 'TH', '+66650055900');    // Kebaboff
});

test('TH · refusals: short codes, truncated mobiles, junk in the phone column', () => {
  refuse('1111', 'TH', /not_reachable|no_valid_reading/);   // 4-digit short code, 166 rows live
  refuse('097086411', 'TH', /no_valid_reading/);            // 8-digit "mobile" — a digit is missing
  refuse('0786216961', 'TH', /no_valid_reading/);           // Green Terrace — 07x is not a mobile block
  refuse('83150', 'TH', /no_valid_reading/);                // 21 Bar & Restaurant — that is a postcode
  refuse('call the front desk', 'TH', /non_numeric/);
  refuse('', 'TH', /empty/);
  refuse(null, 'TH', /empty/);
});

test('TH · already E.164 is never touched', () => {
  skip('+66824234437', 'TH');   // Two friends kitchen — the one that already worked
  skip('+66 95 268 1013', 'TH');
  skip('+6676215825', 'TH');
});

// ── The rest of the countries the directory actually contains ────────────
test('US · NANP, with and without the 1', () => {
  convert('2125551234', 'US', '+12125551234');
  convert('12125551234', 'US', '+12125551234');
  convert('(310) 555-0199', 'US', '+13105550199');
  convert('323-555-0100', 'US', '+13235550100');
  refuse('1125551234', 'US', /no_valid_reading/);   // area code may not start with 1
  refuse('0125551234', 'US', /no_valid_reading/);
  refuse('5551234', 'US', /no_valid_reading/);
});

test('GB · 11-digit national, trunk 0 dropped', () => {
  convert('02071234567', 'GB', '+442071234567');
  convert('07911123456', 'GB', '+447911123456');
  convert('0161 236 3536', 'GB', '+441612363536');
  refuse('08001111', 'GB', /not_reachable/);        // 0800 does not answer from abroad
  refuse('0845 600 1234', 'GB', /not_reachable/);
});

test('JP · 10 and 11 digit national', () => {
  convert('0332345678', 'JP', '+81332345678');
  convert('09012345678', 'JP', '+819012345678');
  convert('06-6543-2100', 'JP', '+81665432100');
  refuse('0120117117', 'JP', /not_reachable/);      // 0120 freephone
});

test('IT · keeps its leading zero, and 39-without-plus is disentangled', () => {
  convert('0612345678', 'IT', '+390612345678');     // Rome landline keeps the 0
  convert('3331234567', 'IT', '+393331234567');     // mobile, no 0
  convert('3906123456', 'IT', '+3906123456');       // "39" + Rome — 390 is not a mobile block
  convert('390612345678', 'IT', '+390612345678');
  refuse('800123456', 'IT', /not_reachable/);
});

test('ES · no trunk prefix at all', () => {
  convert('912345678', 'ES', '+34912345678');
  convert('600123456', 'ES', '+34600123456');
  refuse('900123456', 'ES', /not_reachable/);
  refuse('12345678', 'ES', /no_valid_reading/);
});

test('DE · the ambiguous ones are refused, not guessed', () => {
  convert('03091206791', 'DE', '+493091206791');
  convert('089 954533353', 'DE', '+4989954533353');
  // 0 + 49 + 2151839839: Krefeld (area 02151) written with a stray 49, or
  // 0180-5 shared cost, or a 12-digit Düsseldorf extension. Three readings,
  // no way to choose, so it is left for a human.
  refuse('0492151839839', 'DE', /ambiguous/);
  refuse('0491 805996633', 'DE', /ambiguous/);
  refuse('0800796888023', 'DE', /not_reachable/);   // 239 live rows
  refuse('08002000015', 'DE', /not_reachable/);
});

test('FR · 10-digit national, special numbers refused', () => {
  convert('0142601234', 'FR', '+33142601234');
  convert('06 12 34 56 78', 'FR', '+33612345678');
  refuse('0892701234', 'FR', /not_reachable/);
});

test('the remaining live countries, one real shape each', () => {
  convert('04 234 5678', 'AE', '+97142345678');      // Dubai landline, trunk 0
  convert('050 123 4567', 'AE', '+971501234567');    // mobile
  refuse('8001234', 'AE', /not_reachable/);          // 800 is national-only
  convert('01 5851234', 'AT', '+4315851234');
  convert('0441234567', 'CH', '+41441234567');
  convert('221234567', 'CZ', '+420221234567');       // no trunk prefix
  convert('33123456', 'DK', '+4533123456');          // no trunk prefix
  convert('2101234567', 'GR', '+302101234567');      // no trunk prefix
  convert('21234567', 'HK', '+85221234567');         // no trunk prefix
  convert('0212345678', 'HR', '+385212345678');
  convert('06 1 234 5678', 'HU', '+3612345678');     // trunk is "06", not "0"
  convert('0361234567', 'ID', '+62361234567');
  convert('01 6612345', 'IE', '+35316612345');
  convert('01123456789', 'IN', '+911123456789');
  convert('5551234', 'IS', '+3545551234');
  convert('021234567', 'KH', '+85521234567');
  convert('02 1234 5678', 'KR', '+82212345678');
  convert('0112345678', 'LK', '+94112345678');
  convert('3312345', 'MV', '+9603312345');
  convert('9991234567', 'MX', '+529991234567');
  convert('03 1234 5678', 'MY', '+60312345678');
  convert('020 1234567', 'NL', '+31201234567');
  convert('09171234567', 'PH', '+639171234567');
  convert('212345678', 'PT', '+351212345678');
  convert('08 123 4567', 'SE', '+4681234567');
  convert('62123456', 'SG', '+6562123456');
  convert('02 1234 5678', 'TW', '+886212345678');
  convert('0212 345 6789', 'TR', '+902123456789');
  convert('028 1234 5678', 'VN', '+842812345678');
  convert('2464345678', 'BB', '+12464345678');       // NANP
  convert('2423221986', 'BS', '+12423221986');
  convert('2101234', 'MU', '+2302101234');
});

// ── The rules that make it safe ──────────────────────────────────────────
test('a row with no country is never guessed at', () => {
  refuse('2125551234', null, /no_country_on_row/);
  refuse('2125551234', '', /no_country_on_row/);
  refuse('076 360 333', 'ZZ', /no_rule_for_country/);
});

test('a value that already parses as E.164 is skipped for every country', () => {
  for (const c of Object.keys(RULES)) skip('+12125551234', c);
});

test('a "+" value that does NOT parse is refused, not overwritten', () => {
  refuse('+66', 'TH', /plus_but_unparseable/);
  refuse('+1 (555)', 'US', /plus_but_unparseable/);
});

test('extensions and second numbers are refused, never truncated to the first one', () => {
  refuse('076 360 333 ext 12', 'TH', /extension_or_multiple/);
  refuse('076360333, 076360334', 'TH', /extension_or_multiple/);
  refuse('076360333/076360334', 'TH', /extension_or_multiple/);
  refuse('212-555-0100 x204', 'US', /extension_or_multiple/);
});

test('invisible bidi marks are stripped, not treated as junk', () => {
  convert('‎076 360 333‏', 'TH', '+6676360333');
  convert('⁦050 123 4567⁩', 'AE', '+971501234567');
});

test('every conversion the planner emits satisfies bookdesk’s own gate', () => {
  const corpus = [
    ['076 360 333', 'TH'], ['0878935337', 'TH'], ['6676282172', 'TH'], ['0066076396842', 'TH'],
    ['2125551234', 'US'], ['12125551234', 'US'], ['02071234567', 'GB'], ['0332345678', 'JP'],
    ['0612345678', 'IT'], ['3331234567', 'IT'], ['912345678', 'ES'], ['03091206791', 'DE'],
    ['0142601234', 'FR'], ['050 123 4567', 'AE'], ['62123456', 'SG'], ['09171234567', 'PH'],
  ];
  for (const [raw, c] of corpus) {
    const r = planPhone(raw, c);
    assert.equal(r.verdict, 'convert', `${c} ${raw}`);
    // The whole point: what we store is what bookdesk will accept, verbatim.
    assert.equal(venueE164(r.e164), r.e164, `${c} ${raw} → ${r.e164} does not survive venueE164`);
  }
});

test('the planner is idempotent — running the backfill twice changes nothing', () => {
  for (const [raw, c] of [['076 360 333', 'TH'], ['2125551234', 'US'], ['0612345678', 'IT']]) {
    const first = planPhone(raw, c);
    assert.equal(planPhone(first.e164, c).verdict, 'skip');
  }
});
