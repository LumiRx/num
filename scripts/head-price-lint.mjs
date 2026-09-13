/**
 * NO PRICE, RATE OR CURRENCY FIGURE IN ANY HEAD METADATA.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * On 13 Sep 2026 Dre sent a screenshot of an iMessage he had just sent a
 * prospective venue. The link preview under it read:
 *
 *     NUM for Business — free listing, more bookings, 10% commission
 *
 * His words: "it should never be in the link. That scared business away."
 *
 * He is right, and the reason is structural rather than cosmetic. A link
 * preview renders <title> / og:* / twitter:* — and a Google result renders the
 * meta description — in a box with room for about a dozen words and no room at
 * all for the condition that makes a rate fair. "10% commission" in that box is
 * read as a tax on everything the venue earns. The same venue reading the rate
 * table on the page, with the market band printed beside each line, signs.
 *
 * The number was also wrong in that box three ways over: a room is 15%, an
 * activity 20%, and a guest who was already theirs is a flat fee. One figure
 * cannot carry a rate card, and a preview cannot carry the exceptions.
 *
 * So the head sells the SHAPE of the deal — free to list, paid only on results,
 * nothing on a no-show. The page carries the arithmetic.
 *
 * ── WHAT COUNTS ──────────────────────────────────────────────────────────
 *
 * Any percentage, any currency symbol followed by a digit, any bare currency
 * code with an amount. The word "free" is fine and is the point. "$0" is not —
 * write it as "free", which reads better and trips nothing.
 *
 * This is the fourth pricing-copy drift caught in three weeks (25 Aug hotels
 * quoted 10% and billed 15%; 12 Sep walk-ins promised free; 13 Sep the flat 10%
 * across the site; 13 Sep the og.jpg coverage number). Every one had the same
 * cause: a figure retyped into a surface nothing checks. This checks one of
 * them.
 *
 *   node scripts/head-price-lint.mjs
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = join(ROOT, 'public');

/** A figure a merchant would read as a price. `free` and `no fee` are not. */
export const PRICE = /(\d+(?:\.\d+)?\s*%|[$£€฿]\s?\d|\b\d[\d,.]*\s?(?:USD|GBP|EUR|THB)\b)/i;

/** The fields a link preview or a search result actually renders. */
export const HEAD_FIELDS = [
  ['<title>', /<title>([\s\S]*?)<\/title>/g],
  ['meta description', /name="description"\s+content="([\s\S]*?)"/g],
  ['og:title', /property="og:title"\s+content="([\s\S]*?)"/g],
  ['og:description', /property="og:description"\s+content="([\s\S]*?)"/g],
  ['twitter:title', /name="twitter:title"\s+content="([\s\S]*?)"/g],
  ['twitter:description', /name="twitter:description"\s+content="([\s\S]*?)"/g],
];

/** Only the head. A price in the body is the whole point of the page. */
const HEAD_BYTES = 8000;

export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_') || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

export function offences(html) {
  const head = html.slice(0, HEAD_BYTES);
  const found = [];
  for (const [label, re] of HEAD_FIELDS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(head))) {
      const value = m[1].trim();
      const hit = value.match(PRICE);
      if (hit) found.push({ field: label, figure: hit[0].trim(), value });
    }
  }
  return found;
}

export function run(dir = PUB) {
  const bad = [];
  for (const file of walk(dir)) {
    for (const o of offences(readFileSync(file, 'utf8'))) {
      bad.push({ file: file.replace(ROOT, ''), ...o });
    }
  }
  return bad;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bad = run();
  if (!bad.length) {
    console.log('[head-price] ok — no rate or price figure in any link preview');
    process.exit(0);
  }
  console.error('[head-price] %d head field(s) carry a price a link preview would show:\n', bad.length);
  for (const b of bad) {
    console.error('  %s\n    %s  contains  %s\n    "%s"\n', b.file, b.field, b.figure, b.value.slice(0, 150));
  }
  console.error('The head sells the shape of the deal. The page carries the arithmetic.');
  console.error('Move the figure into the page body and say "paid only on results" here.');
  process.exit(1);
}
