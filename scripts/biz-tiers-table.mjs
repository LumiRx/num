/**
 * The public pricing table, generated from the tiers the product actually
 * enforces.
 *
 * ── WHY THIS SCRIPT EXISTS ───────────────────────────────────────────────
 *
 * On 3 Sep 2026 the two pages a business reads before paying said three things
 * the product does not do:
 *
 *   1. /pricing/ and /business/ both sell "API keys and AI agent access" as
 *      the $50 Full tier. Nothing gates the API. bizbilling.mjs says so in its
 *      own header: the numbiz_ key IS the claim mechanism, the free dashboard
 *      calls through it, and gating it would break the free tier. A business
 *      upgrading for that is paying $50 a month for something it already has.
 *   2. /pricing/ puts promotions on Pro at $19.99. The code grants them on
 *      Small at $9.99.
 *   3. /business/ says Pro "adds multi-location". Small already carries three.
 *
 * None of those were lies anyone told on purpose. They are what happens when a
 * marketing table is typed by hand next to a DEFAULT_BIZ_TIERS object that
 * moved. So the table is generated now, and `bizpages.test.mjs` fails if the
 * file on disk stops matching this output.
 *
 *   node scripts/biz-tiers-table.mjs            # print the table
 *   node scripts/biz-tiers-table.mjs --check    # exit 1 if /pricing/ has drifted
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BIZ_TIERS } from '../worker/bizbilling.mjs';
import { tierMatrix } from '../worker/bizpages.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PRICING_PAGE = join(HERE, '..', 'public', 'pricing', 'index.html');

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (c) => (c > 0 ? `$${c % 100 ? (c / 100).toFixed(2) : c / 100} / month` : 'Free');

/** Markers in the HTML. Everything between them is generated; nothing else is touched. */
export const BEGIN = '<!-- BEGIN generated tiers: node scripts/biz-tiers-table.mjs -->';
export const END = '<!-- END generated tiers -->';

export function tiersTable(tiers = DEFAULT_BIZ_TIERS) {
  const rows = tierMatrix(tiers).map((t) => {
    const gets = t.gets.map((g) => `<li>${esc(g)}</li>`).join('');
    return `<tr>
  <td><b>${esc(t.name)}</b></td>
  <td>${esc(usd(t.price_cents))}</td>
  <td>${esc(t.blurb)}
    <ul class="tierlist">${gets}</ul></td>
</tr>`;
  }).join('\n');

  // Stated once, above the table, because repeating it in every row is how a
  // reader concludes it must be conditional on something.
  const always = tierMatrix(tiers)[0].always.map((a) => `<li>${esc(a)}</li>`).join('');

  return `${BEGIN}
<p class="sub" style="max-width:70ch">Every plan, including the free one, includes:</p>
<ul class="tierlist">${always}</ul>
<table class="tbl">
<tr><th style="width:26%">Plan</th><th style="width:20%">Price</th><th>What it adds</th></tr>
${rows}
</table>
<p class="sub" style="margin-top:18px;max-width:70ch">Prices are in US dollars and every paid plan cancels
monthly. Cancelling never removes your listing &mdash; the free plan is the floor, not a trial.
Placement in a recommendation is not for sale on any plan.</p>
${END}`;
}

/** Read the generated block out of a page, or null if it has none. */
export function blockIn(html) {
  const a = html.indexOf(BEGIN);
  const b = html.indexOf(END);
  return a === -1 || b === -1 ? null : html.slice(a, b + END.length);
}

if (process.argv[1] && process.argv[1].endsWith('biz-tiers-table.mjs')) {
  const table = tiersTable();
  if (process.argv.includes('--check')) {
    const html = readFileSync(PRICING_PAGE, 'utf8');
    const found = blockIn(html);
    if (found === table) { console.log('pricing page matches the tiers the product enforces'); process.exit(0); }
    console.error(found === null
      ? 'pricing page has no generated block — paste the output of this script into it'
      : 'pricing page has DRIFTED from DEFAULT_BIZ_TIERS');
    process.exit(1);
  }
  console.log(table);
}
