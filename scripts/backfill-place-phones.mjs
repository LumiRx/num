#!/usr/bin/env node
/**
 * NUM · places.phone → E.164 backfill.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * bookdesk.mjs will not text a venue whose number is not E.164 (see
 * `venueE164`, worker/bookdesk.mjs:59). That refusal is correct — a bare
 * ten-digit number is a different restaurant on a different continent
 * depending on which country you assume — but it means the concierge cannot
 * book the venues our own directory ranks highest. In Phuket the top of the
 * ranked list is almost entirely `source = 'google_places'` rows, and Google
 * hands us Thai national format ("076 360 333"), not "+6676360333".
 *
 * The fix is not to loosen bookdesk. It is to store what bookdesk needs.
 *
 * ── WHY THIS IS SAFE, AND WHERE IT STOPS ─────────────────────────────────
 *
 * It is not a guess: every row in `places` carries its own ISO country code
 * (`places.country`, populated on 100% of rows as of 2026-08-18), set by the
 * ingest that fetched it — not inferred here. The country supplies the calling
 * code; this script only removes the national trunk prefix and prepends it.
 *
 * Everything that is not that is REFUSED and logged, never mangled:
 *
 *   · a value that already parses as E.164            → skipped, untouched
 *   · a value that starts with '+' but does NOT parse → refused, untouched
 *     (a bad international number is a data-quality bug for a human, not
 *      something to overwrite with a differently-wrong guess)
 *   · a country with no rule in the table below       → refused
 *   · a national number whose length or leading digits do not fit that
 *     country's numbering plan                        → refused
 *   · a value that is ambiguous — it parses two ways, e.g. German
 *     "0491805996633" is both Leer (area 0491) and shared-cost 01805 →
 *                                                       refused
 *   · extensions, second numbers, letters, short codes, freephone ranges
 *     that cannot be reached from outside the country → refused
 *
 * A refusal is a row a human can look at. A mangled number is a text message
 * to a stranger.
 *
 * ── THE PARSER IS NOT REIMPLEMENTED HERE ─────────────────────────────────
 *
 * The final step of every conversion goes through `venueE164` from
 * worker/bookdesk.mjs, which itself wraps `normalisePhone` from
 * claim/verify.mjs. So the exact predicate this script optimises for is the
 * exact predicate that gates a booking at runtime. If bookdesk's rule changes,
 * this script changes with it, because it is the same function.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────
 *
 *   # dry run (the default; touches nothing, writes nothing)
 *   node scripts/backfill-place-phones.mjs
 *   node scripts/backfill-place-phones.mjs --dest=phuket --samples=10
 *   node scripts/backfill-place-phones.mjs --country=TH --show-refusals
 *
 *   # emit the UPDATE statements to a file — still writes nothing to D1
 *   node scripts/backfill-place-phones.mjs --apply --out=scripts/backfill-place-phones.sql
 *
 *   # Andre applies them, deliberately, by hand:
 *   npx wrangler d1 execute num-db --remote --file scripts/backfill-place-phones.sql
 *
 * There is no flag on this script that writes to D1. That is on purpose.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { venueE164 } from '../worker/bookdesk.mjs';

const DB = 'num-db';
const argv = process.argv.slice(2);
const flag = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has = (k) => argv.includes(`--${k}`);

// ──────────────────────────────────────────────────────────────────────────
// The numbering plans.
//
// `cc`    ITU calling code, without '+'.
// `trunk` the national trunk prefix that is DROPPED before the calling code
//         is prepended. '' where the country has none (Spain, Denmark, Hong
//         Kong, Czechia, Greece, Portugal, Singapore, Mexico, Iceland,
//         Mauritius, Maldives) — and, importantly, ITALY, which is the famous
//         exception that KEEPS its leading 0 in E.164 (+39 06 …).
// `nsn`   predicate: is this a plausible national significant number for this
//         country? Length alone where length is decisive; leading digits too
//         where the data showed length is not enough.
// `reject` ranges that are valid nationally but unreachable from abroad —
//         freephone, shared-cost, premium, short codes. Converting them yields
//         a syntactically perfect number that no SMS will ever arrive at, so
//         they are refused rather than silently written.
//
// Every entry below was checked against the shape histogram of the live
// directory (country × digit-length × first two digits) so the lengths are the
// ones the data actually contains, not the ones a spec implies.
// ──────────────────────────────────────────────────────────────────────────
const len = (...ns) => { const s = new Set(ns); return (n) => s.has(n.length); };

export const RULES = {
  // ── Asia-Pacific ───────────────────────────────────────────────────────
  // Thailand: geographic NSN is 8 digits (2xxxxxxx Bangkok, 76xxxxxx Phuket);
  // mobile is 9 and begins 6, 8 or 9. A 9-digit NSN starting 7 is a truncated
  // mobile, not a long landline, so it is refused instead of dialled.
  TH: { cc: '66', trunk: '0', nsn: (n) => (/^[2-7]\d{7}$/.test(n) || /^[689]\d{8}$/.test(n)), reject: [/^1/] },
  JP: { cc: '81', trunk: '0', nsn: len(9, 10), reject: [/^(120|800|570|990)/] },
  KR: { cc: '82', trunk: '0', nsn: len(8, 9, 10, 11), reject: [/^(15|16|18|80|60)\d{2}$/, /^(15|16|18)\d{2}\d{4}$/] },
  HK: { cc: '852', trunk: '', nsn: len(8), reject: [/^900/] },
  TW: { cc: '886', trunk: '0', nsn: len(8, 9), reject: [/^80/] },
  SG: { cc: '65', trunk: '', nsn: len(8), reject: [/^1[89]/] },
  MY: { cc: '60', trunk: '0', nsn: len(8, 9, 10), reject: [/^1[3578]00/] },
  ID: { cc: '62', trunk: '0', nsn: len(8, 9, 10, 11, 12), reject: [/^(800|177)/] },
  PH: { cc: '63', trunk: '0', nsn: (n) => (n.length === 9 && /^[2-8]/.test(n)) || (n.length === 10 && /^9/.test(n)), reject: [/^1800/] },
  VN: { cc: '84', trunk: '0', nsn: len(9, 10), reject: [/^1[89]00/] },
  KH: { cc: '855', trunk: '0', nsn: len(8, 9), reject: [] },
  IN: { cc: '91', trunk: '0', nsn: len(10), reject: [/^1800/] },
  LK: { cc: '94', trunk: '0', nsn: len(9), reject: [] },
  MV: { cc: '960', trunk: '', nsn: len(7), reject: [] },

  // ── Europe ─────────────────────────────────────────────────────────────
  GB: { cc: '44', trunk: '0', nsn: len(9, 10), reject: [/^(80|84|87|9)/] },
  IE: { cc: '353', trunk: '0', nsn: len(7, 8, 9), reject: [/^(15|18)/] },
  // Germany: NSN length genuinely runs 6–13 (Rufnummer + Durchwahl), so length
  // cannot disambiguate on its own — hence the ambiguity guard below matters
  // most here. 0800/0180/0900/0137 do not accept calls from abroad.
  DE: { cc: '49', trunk: '0', nsn: (n) => n.length >= 6 && n.length <= 13, reject: [/^(800|900|180|137|138|1801|1802)/] },
  AT: { cc: '43', trunk: '0', nsn: (n) => n.length >= 4 && n.length <= 13, reject: [/^(800|802|804|810|820|821|828|900|930|931|939)/] },
  CH: { cc: '41', trunk: '0', nsn: len(9), reject: [/^(800|900|906)/] },
  FR: { cc: '33', trunk: '0', nsn: len(9), reject: [/^8/] },
  // Italy keeps the trunk 0. Mobiles never carry it and use a known prefix
  // block; that block is what tells "39 06 …" (country code, no plus) apart
  // from a genuine 39x mobile.
  IT: {
    cc: '39', trunk: '',
    nsn: (n) => (/^0\d{5,10}$/.test(n)) || (/^3(2\d|3\d|4\d|5[01]|6[0-8]|7[0-37]|8[0-289]|9[1237])\d{6,7}$/.test(n)),
    reject: [/^(800|199|892|166|178)/],
  },
  ES: { cc: '34', trunk: '', nsn: (n) => /^[5-9]\d{8}$/.test(n), reject: [/^(80|90)/] },
  PT: { cc: '351', trunk: '', nsn: len(9), reject: [/^80/] },
  NL: { cc: '31', trunk: '0', nsn: len(9), reject: [/^(800|900|906|909)/] },
  SE: { cc: '46', trunk: '0', nsn: len(7, 8, 9), reject: [/^(20|900|939)/] },
  DK: { cc: '45', trunk: '', nsn: len(8), reject: [/^90/] },
  IS: { cc: '354', trunk: '', nsn: len(7), reject: [/^9/] },
  CZ: { cc: '420', trunk: '', nsn: len(9), reject: [/^9[0-6]/, /^800/] },
  HU: { cc: '36', trunk: '06', nsn: len(8, 9), reject: [/^80/] },
  HR: { cc: '385', trunk: '0', nsn: len(8, 9), reject: [/^(6|800)/] },
  GR: { cc: '30', trunk: '', nsn: len(10), reject: [/^(80|90)/] },
  TR: { cc: '90', trunk: '0', nsn: len(10), reject: [/^(800|900|444)/] },

  // ── Americas / NANP ────────────────────────────────────────────────────
  // NANP: area code and exchange both start 2–9. That single rule throws out
  // postcodes, house numbers and truncated strings that a length check keeps.
  US: { cc: '1', trunk: '1', nsn: (n) => /^[2-9]\d{2}[2-9]\d{6}$/.test(n), reject: [] },
  BB: { cc: '1', trunk: '1', nsn: (n) => /^246[2-9]\d{6}$/.test(n), reject: [] },
  BS: { cc: '1', trunk: '1', nsn: (n) => /^242[2-9]\d{6}$/.test(n), reject: [] },
  MX: { cc: '52', trunk: '', nsn: (n) => /^[2-9]\d{9}$/.test(n), reject: [/^80[05]/] },

  // ── Middle East / Africa / Indian Ocean ────────────────────────────────
  // UAE: 8-digit landline (4xxxxxxx Dubai), 9-digit mobile (5xxxxxxxx).
  // 600 and 800 are national-only ranges — a guest abroad cannot reach them.
  AE: { cc: '971', trunk: '0', nsn: (n) => (/^[2-49]\d{7}$/.test(n) || /^5\d{8}$/.test(n)), reject: [/^(600|800)/] },
  MU: { cc: '230', trunk: '', nsn: len(7, 8), reject: [] },
};

// Anything that means "there is more here than one dialable number".
const EXTENSION = /(\bext\b|\bext\.|x\d|extension|,|;|\/| or |&|\||\bthen\b)/i;
// Bidi and formatting marks the crawlers picked up from Arabic and Hebrew
// pages. They are invisible, they are not digits, and they must not survive
// into a Twilio payload — so they are stripped before anything else looks at
// the string, and are NOT by themselves a reason to refuse a good number.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿ ]/g;
// What a phone number is allowed to be made of once the invisibles are gone.
// Anything else — a letter, a Thai character, "S/N", an emoji — means this
// field is not a phone number and no amount of parsing will make it one.
const ALLOWED = /^[\d\s+()‐-―.\-]*$/;

/**
 * Decide what a single row's phone should become.
 *
 * Returns one of:
 *   { verdict: 'skip',    reason }              already E.164 — do not touch
 *   { verdict: 'convert', e164, reason }        rewrite to this
 *   { verdict: 'refuse',  reason }              leave alone, log it
 *
 * `country` is the row's own `places.country`. If it is absent the row is
 * refused: this function will not pick a country for a number.
 */
export function planPhone(raw, country) {
  if (raw == null || String(raw).trim() === '') return { verdict: 'refuse', reason: 'empty' };

  const original = String(raw);
  const cleaned = original.normalize('NFKC').replace(INVISIBLE, '').trim();

  // Already good? bookdesk's own gate is the arbiter, so the answer here and
  // the answer at booking time can never disagree.
  if (cleaned.startsWith('+')) {
    return venueE164(cleaned)
      ? { verdict: 'skip', reason: 'already_e164' }
      : { verdict: 'refuse', reason: 'plus_but_unparseable' };
  }

  if (EXTENSION.test(cleaned)) return { verdict: 'refuse', reason: 'extension_or_multiple' };
  if (!ALLOWED.test(cleaned)) return { verdict: 'refuse', reason: 'non_numeric' };

  const digits = cleaned.replace(/\D/g, '');
  if (!digits) return { verdict: 'refuse', reason: 'no_digits' };

  const cty = String(country || '').trim().toUpperCase();
  if (!cty) return { verdict: 'refuse', reason: 'no_country_on_row' };
  const rule = RULES[cty];
  if (!rule) return { verdict: 'refuse', reason: `no_rule_for_country:${cty}` };

  const blocked = (nsn) => rule.reject.some((r) => r.test(nsn));
  const finish = (nsn, why) => {
    const e164 = venueE164(`+${rule.cc}${nsn}`);
    return e164 ? { verdict: 'convert', e164, reason: why } : { verdict: 'refuse', reason: 'failed_venueE164' };
  };

  // ── 00 = the other international prefix ────────────────────────────────
  // "0066076396842" is 00 + 66 + a Thai number that still carries its trunk 0.
  // Stripping only the 00 would produce +66076396842, which is not a Thai
  // number at all. So after the 00 the same national rules are applied again.
  if (digits.startsWith('00')) {
    const rest = digits.slice(2);
    if (rest.startsWith(rule.cc)) {
      const after = rest.slice(rule.cc.length);
      if (rule.nsn(after)) return finish(after, 'intl_00');
      if (rule.trunk && after.startsWith(rule.trunk)) {
        const stripped = after.slice(rule.trunk.length);
        if (rule.nsn(stripped)) return finish(stripped, 'intl_00_with_trunk');
      }
      return { verdict: 'refuse', reason: 'intl_00_bad_nsn' };
    }
    // 00 followed by somebody ELSE's country code. We have no numbering plan
    // for it, but the '00' is unambiguous, so pass it through the same
    // length gate normalisePhone applies and no further.
    const e164 = venueE164(`+${rest}`);
    return e164 ? { verdict: 'convert', e164, reason: 'intl_00_foreign' } : { verdict: 'refuse', reason: 'intl_00_bad_length' };
  }

  // ── The readings of a bare national string ─────────────────────────────
  //   A. a national number, with or without its trunk prefix
  //   B. an international number that lost its '+'
  //   C. a trunk prefix followed by our OWN calling code — the German
  //      "0" + "49" + number case, which is how a badly merged import looks
  const national = (rule.trunk && digits.startsWith(rule.trunk)) ? digits.slice(rule.trunk.length) : digits;

  // Unreachable ranges are checked on the national form BEFORE validity: an
  // 0800 is well-formed nationally, so a length check will not catch it, and
  // "this number will never receive our text" is a more useful refusal reason
  // for a human than "no valid reading".
  if (blocked(national)) return { verdict: 'refuse', reason: 'not_reachable_from_abroad' };

  const cand = [];                                     // [nsn, why]
  if (rule.nsn(national)) {
    cand.push([national, rule.trunk && digits.startsWith(rule.trunk) ? 'trunk_dropped' : 'bare_national']);
  }
  if (digits.startsWith(rule.cc)) {
    const after = digits.slice(rule.cc.length);
    if (rule.nsn(after)) cand.push([after, 'cc_without_plus']);
    else if (rule.trunk && after.startsWith(rule.trunk) && rule.nsn(after.slice(rule.trunk.length))) {
      cand.push([after.slice(rule.trunk.length), 'cc_without_plus']);
    }
  }
  if (rule.trunk && digits.startsWith(rule.trunk) && national.startsWith(rule.cc)) {
    const after = national.slice(rule.cc.length);
    if (rule.nsn(after)) cand.push([after, 'trunk_then_cc']);
  }

  // Two readings that AGREE are not an ambiguity — "12125551234" is the same
  // American number whether you read the 1 as a trunk prefix or as the
  // country code. Only genuinely different answers are refused.
  const distinct = [...new Set(cand.map(([n]) => n))];
  if (distinct.length > 1) return { verdict: 'refuse', reason: `ambiguous:${distinct.length}_readings` };
  if (!cand.length) return { verdict: 'refuse', reason: 'no_valid_reading' };
  if (blocked(distinct[0])) return { verdict: 'refuse', reason: 'not_reachable_from_abroad' };
  return finish(cand[0][0], cand[0][1]);
}

// ──────────────────────────────────────────────────────────────────────────
// Everything below this line is the CLI. The decision logic is above and is
// what the test file exercises.
// ──────────────────────────────────────────────────────────────────────────

const sql = (q) => {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', q], {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  return JSON.parse(out)[0].results;
};
const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function main() {
  const DEST = flag('dest');
  const COUNTRY = flag('country');
  const APPLY = has('apply');
  const OUT = flag('out') || 'scripts/backfill-place-phones.sql';
  const SAMPLES = Number(flag('samples') || 3);
  const SHOW_REFUSALS = has('show-refusals');
  const PAGE = Number(flag('page') || 20000);

  const where = ["phone IS NOT NULL", "TRIM(phone) <> ''"];
  if (DEST) where.push(`dest = ${q(DEST)}`);
  if (COUNTRY) where.push(`country = ${q(COUNTRY.toUpperCase())}`);

  console.log(`NUM · places.phone → E.164   ${APPLY ? 'APPLY (writes SQL to a file)' : 'DRY RUN (default — nothing is written)'}`);
  console.log(`  scope: ${DEST ? `dest=${DEST}` : 'whole directory'}${COUNTRY ? ` country=${COUNTRY}` : ''}\n`);

  const per = new Map();   // country → tallies + samples
  const reasons = new Map();
  const updates = [];
  let scanned = 0, cursor = '';

  for (;;) {
    const rows = sql(
      `SELECT id, country, phone FROM places WHERE ${where.join(' AND ')}` +
      `${cursor ? ` AND id > ${q(cursor)}` : ''} ORDER BY id LIMIT ${PAGE}`,
    );
    if (!rows.length) break;
    for (const r of rows) {
      scanned++;
      const plan = planPhone(r.phone, r.country);
      const key = r.country || '(none)';
      if (!per.has(key)) per.set(key, { skip: 0, convert: 0, refuse: 0, samples: [], refusals: [] });
      const t = per.get(key);
      t[plan.verdict]++;
      if (plan.verdict === 'convert') {
        if (t.samples.length < SAMPLES) t.samples.push(`${r.phone}  →  ${plan.e164}   (${plan.reason})`);
        updates.push(`UPDATE places SET phone = ${q(plan.e164)}, updated_at = datetime('now') WHERE id = ${q(r.id)} AND phone = ${q(r.phone)};`);
      } else if (plan.verdict === 'refuse') {
        reasons.set(plan.reason, (reasons.get(plan.reason) || 0) + 1);
        if (t.refusals.length < SAMPLES) t.refusals.push(`${r.phone}   (${plan.reason})`);
      }
    }
    cursor = rows[rows.length - 1].id;
    process.stderr.write(`  …${scanned} rows scanned\r`);
    if (rows.length < PAGE) break;
  }
  process.stderr.write('\n');

  const tot = { skip: 0, convert: 0, refuse: 0 };
  const table = [...per.entries()].sort((a, b) => b[1].convert - a[1].convert);
  console.log('country   already E.164      → convert        refused');
  console.log('────────────────────────────────────────────────────────');
  for (const [c, t] of table) {
    tot.skip += t.skip; tot.convert += t.convert; tot.refuse += t.refuse;
    console.log(`${c.padEnd(9)} ${String(t.skip).padStart(12)} ${String(t.convert).padStart(14)} ${String(t.refuse).padStart(14)}`);
    for (const s of t.samples) console.log(`            ${s}`);
    if (SHOW_REFUSALS) for (const s of t.refusals) console.log(`            ✗ ${s}`);
  }
  console.log('────────────────────────────────────────────────────────');
  console.log(`${'TOTAL'.padEnd(9)} ${String(tot.skip).padStart(12)} ${String(tot.convert).padStart(14)} ${String(tot.refuse).padStart(14)}`);
  console.log(`\n${scanned} rows with a phone examined.`);
  console.log(`${tot.convert} would become bookable. ${tot.refuse} refused — listed by reason:`);
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(7)}  ${r}`);

  if (!APPLY) {
    console.log(`\nNothing was written. Re-run with --apply to emit the UPDATE statements to ${OUT}.`);
    return;
  }

  // The guard `AND phone = <old value>` is not decoration: it makes the whole
  // file idempotent and makes a re-run after a partial failure a no-op on the
  // rows that already moved. It also means a row somebody edited by hand
  // between the dry run and the apply is skipped rather than clobbered.
  const header = [
    '-- NUM · places.phone → E.164 backfill',
    `-- generated ${new Date().toISOString()} by scripts/backfill-place-phones.mjs`,
    `-- scope: ${DEST ? `dest=${DEST}` : 'whole directory'}${COUNTRY ? ` country=${COUNTRY}` : ''}`,
    `-- ${updates.length} rows. Every statement is guarded on the OLD value, so`,
    '-- running this file twice changes nothing the second time.',
    '--',
    `-- apply:  npx wrangler d1 execute ${DB} --remote --file ${OUT}`,
    '',
  ].join('\n');
  writeFileSync(OUT, header + updates.join('\n') + '\n');
  console.log(`\nWrote ${updates.length} UPDATE statements to ${OUT}.`);
  console.log(`Nothing has been written to D1. To apply, run:\n  npx wrangler d1 execute ${DB} --remote --file ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
