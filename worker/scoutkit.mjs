/**
 * NUM · the Expert's kit — the paper a person carries into a shop.
 *
 * ── WHY THIS IS SERVER-RENDERED AND PERSONALISED ──────────────────────────
 *
 * public/flyers/business/ has been live for weeks: a good A4 leave-behind
 * with the real prices on it. It is also generic, and a generic leave-behind
 * is the one thing a commissioned rep must not hand over. The owner keeps the
 * paper, thinks about it for a week, signs up on their own — and is credited
 * to nobody. Tyler did the work and the ledger has no idea.
 *
 * So every sheet here carries ONE code and ONE link, printed and scannable,
 * and they come off the same `/s/CODE` path the NFC card uses. The QR is drawn
 * by worker/qr.mjs — the same encoder as a venue's code and a member's code,
 * so the thing on the paper cannot drift from the thing in the database, and
 * it needs no image request, no third party, and works once printed.
 *
 * ── THE PRICES ARE NOT WRITTEN HERE, AND MUST NOT BE ──────────────────────
 *
 * They come from worker/commission.mjs — the module the ledger itself bills
 * from — through feeSentence() and paymentOnlySentence(), which is exactly how
 * the merchant invite email renders them. Paper and email now say the same
 * words because they ask the same function.
 *
 * This file used to copy public/flyers/business/index.html instead, reasoning
 * that copying beats inventing. It does, but only if the thing copied is
 * right. That flyer said "$2 flat per confirmed table. Flat, not a
 * percentage." A table is priced two ways:
 *
 *     10% of the bill      when NUM can see what the guest spent
 *     $2 per table         when it cannot — a FLOOR, not an alternative
 *
 * So the flyer quoted the floor as if it were the whole price and then
 * explicitly denied the percentage. A venue on a POS that reads "$2, not a
 * percentage" and is invoiced 10% of a $100 bill has been told one price and
 * charged another — the precise failure commission.mjs says feeSentence()
 * exists to prevent. It had been fixed there on 26 Aug and the flyer never
 * caught up.
 *
 * commission.mjs also says why a price typed into merchant copy by hand is
 * wrong on principle: it drifts the day the number changes, silently, in an
 * artefact nobody re-reads. A rep's leave-behind is the worst possible such
 * artefact, because it is already in somebody's hand.
 *
 * The one deliberate difference: the sample answer names no real venues. The
 * live flyer names three. Naming a business in a mocked-up recommendation
 * before it has a signed listing is the rule the posting SOP already applies
 * to video, and paper handed to a rival venue owner is no safer than video.
 */
import { qrSvg } from './qr.mjs';
// The ledger's own words for what a venue pays. Never retyped here.
import { feeSentence, paymentOnlySentence, RATES } from './commission.mjs';

/**
 * The rate card, rendered from RATES rather than typed.
 *
 * `country` is the venue's, because the flat floor is quoted in the currency
 * the venue will actually be invoiced in — a US sheet says $2.00, a Thai one
 * ฿70. A rep in Honolulu and a rep in Phuket get different paper from the
 * same function, which is the point.
 */
function rateRows(country = 'US') {
  const row = (label, sentence) =>
    `<tr><td class="n">${label}</td><td class="p">${H(sentence)}</td></tr>`;
  return [
    row('Free listing &mdash; claimed, verified, bookable', '$0'),
    row('A table NUM sent you', feeSentence({ category: 'Restaurant', country })),
    row('A room', feeSentence({ category: 'Hotel', country })),
    row('An appointment', feeSentence({ category: 'Spa', country })),
    row('An activity or tour', feeSentence({ category: 'Tour', country })),
    row('Your own guest, settling through NUM', paymentOnlySentence({ country })),
    row('No-shows, declines, walk-ins who do not pay through NUM', '$0'),
  ].join('\n  ');
}

/** The four numbers across the top, also from RATES. */
function headlineStats(country = 'US') {
  const table = RATES.reservation;
  const pct = `${(table.bp / 100).toFixed(0)}%`;
  return `<div class="stats">
  <div><b>$0</b><span>To list. Forever. No setup fee.</span></div>
  <div><b>${pct}</b><span>Of the bill on a table NUM sent you, when we can see what they spent.</span></div>
  <div><b>$2</b><span>Per table instead, if we cannot see the bill. A floor, not an alternative.</span></div>
  <div><b>$0</b><span>On no-shows, declines and anyone who just walks in.</span></div>
</div>`;
}

const H = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

/**
 * One visual world, print-committed.
 *
 * Colours are painted explicitly and never inherited: this is paper, so it
 * must not follow the viewer's dark mode, and print-color-adjust keeps the
 * greens from being helpfully removed by a printer driver.
 */
const CSS = `
@page{size:A4;margin:0}
*{margin:0;padding:0;box-sizing:border-box}
:root{--paper:#faf8f4;--ink:#131a16;--pine:#1f3a34;--green:#1e7a4d;--line:#ded9cf;--slate:#5f675c}
html{background:#e9e7e1}
body{font:11pt/1.45 "Helvetica Neue",Helvetica,Arial,sans-serif;color:var(--ink);
 -webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{width:210mm;min-height:297mm;padding:14mm 14mm 10mm;display:flex;flex-direction:column;
 background:#fff;margin:14px auto;box-shadow:0 10px 40px rgba(10,23,18,.16)}
.sheet>*{flex-shrink:0}
.mast{display:flex;align-items:center;gap:11px;padding-bottom:9px;border-bottom:3px solid var(--pine)}
.logo{display:flex;align-items:center;font-size:23pt;font-weight:800;letter-spacing:.05em;color:var(--pine);line-height:1}
.tag{font-size:9pt;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:var(--green)}
.mast .r{margin-left:auto;font-size:8pt;color:var(--slate);text-align:right;line-height:1.4}
h1{font-size:34pt;line-height:1.03;letter-spacing:-.025em;color:var(--pine);font-weight:800;margin:16px 0 9px}
.sub{font-size:12pt;line-height:1.4;color:#38413a;max-width:54ch}
.stats{display:grid;grid-template-columns:repeat(4,1fr);margin-top:16px;
 border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.stats div{padding:11px 12px 12px;border-left:1px solid var(--line)}
.stats div:first-child{border-left:0;padding-left:0}
.stats b{display:block;font-size:25pt;font-weight:800;color:var(--green);line-height:1;letter-spacing:-.02em}
.stats span{display:block;font-size:8.4pt;color:var(--slate);line-height:1.32;margin-top:6px}
h2{font-size:8.6pt;font-weight:800;letter-spacing:.17em;text-transform:uppercase;color:var(--green);margin:17px 0 9px}
.bens{display:grid;grid-template-columns:1fr 1fr;gap:10px 22px}
.ben h3{font-size:12pt;color:var(--pine);font-weight:800;margin-bottom:2px;letter-spacing:-.01em}
.ben p{font-size:9.6pt;color:#4a524a;line-height:1.4}
.chat{background:var(--paper);border-radius:9px;padding:12px 14px}
.chat .q{font-size:9.6pt;color:var(--slate);font-style:italic}
.chat .a{font-size:9.6pt;margin-top:4px;line-height:1.42}
.price{width:100%;border-collapse:collapse;font-size:10pt}
.price td{padding:6.5px 0;border-bottom:1px solid #eeebe4}
.price td.p{text-align:right;font-weight:800;color:var(--pine);white-space:nowrap}
.price tr:last-child td{border-bottom:0}
.price td.n{color:#3d453d}
.cta{background:var(--pine);border-radius:11px;padding:15px 18px;margin-top:auto;
 display:flex;align-items:center;gap:16px}
.cta h3{color:#fff;font-size:14.5pt;font-weight:800;line-height:1.15;letter-spacing:-.015em}
.cta p{color:#a9ceb8;font-size:9pt;margin-top:4px}
.cta .qr{background:#fff;border-radius:8px;padding:6px;line-height:0;flex:none}
.cta .go{margin-left:auto;text-align:right;color:#fff;font-size:12pt;font-weight:800;white-space:nowrap}
.cta .go small{display:block;font-size:8pt;font-weight:400;color:#a9ceb8;margin-top:3px}
.by{margin-top:9px;font-size:8.4pt;color:var(--slate);text-align:center}
.by b{color:var(--pine)}
.foot{margin-top:6px;font-size:7.8pt;color:var(--slate);text-align:center}

/* the counter card — four to a sheet, cut on the dashed line */
.cards{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:8mm;flex:1}
.card{border:1px dashed #c9c4b8;padding:9mm 8mm;display:flex;flex-direction:column;
 align-items:center;text-align:center;justify-content:center;gap:7px}
.card .k{font-size:7.6pt;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--green)}
.card h3{font-size:13pt;color:var(--pine);font-weight:800;line-height:1.15;letter-spacing:-.01em}
.card p{font-size:8.8pt;color:#4a524a;line-height:1.4}
.card .qr{line-height:0}
.card .code{font-size:10pt;font-weight:800;letter-spacing:.14em;color:var(--pine)}
.card .url{font-size:8.4pt;color:var(--slate)}

/* the pitch card — for the rep, never handed over */
.say{background:var(--paper);border-left:3px solid var(--green);border-radius:0 8px 8px 0;
 padding:11px 14px;font-size:11pt;line-height:1.5;color:#22302a}
.say em{display:block;font-style:normal;font-size:7.4pt;font-weight:800;letter-spacing:.14em;
 text-transform:uppercase;color:var(--green);margin-bottom:4px}
.obj{margin-top:9px;border-top:1px solid var(--line);padding-top:9px}
.obj:first-of-type{border-top:0}
.obj h3{font-size:11pt;color:var(--pine);font-weight:800;margin-bottom:3px}
.obj p{font-size:9.8pt;color:#4a524a;line-height:1.45}
.obj p.never{color:#8a3a2a;font-size:9pt;margin-top:4px}
.steps{counter-reset:s;display:grid;gap:7px}
.steps li{list-style:none;display:flex;gap:10px;font-size:10pt;line-height:1.42;color:#3d453d}
.steps li b{flex:none;width:19px;height:19px;border-radius:999px;background:var(--green);color:#fff;
 font-size:8.5pt;display:flex;align-items:center;justify-content:center;font-weight:800;margin-top:1px}

/* the toolbar, which is the only thing that does not print */
.bar{position:sticky;top:0;z-index:5;background:var(--pine);color:#fff;padding:10px 16px;
 display:flex;align-items:center;gap:14px;font:600 13px/1.4 "Helvetica Neue",Helvetica,Arial,sans-serif}
.bar a,.bar button{color:#fff;background:rgba(255,255,255,.14);border:0;border-radius:8px;
 padding:7px 13px;font:inherit;cursor:pointer;text-decoration:none}
.bar a:hover,.bar button:hover{background:rgba(255,255,255,.24)}
.bar .sp{margin-left:auto;font-weight:400;color:#a9ceb8;font-size:12px}
@media print{.bar{display:none}.sheet{margin:0;box-shadow:none;min-height:auto}html{background:#fff}}
@media(max-width:820px){.sheet{width:auto;min-height:auto;padding:18px;margin:10px}
 h1{font-size:26pt}.stats{grid-template-columns:1fr 1fr}.bens{grid-template-columns:1fr}
 .cards{grid-template-columns:1fr}.cta{flex-wrap:wrap}}
`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${H(title)}</title>
<style>${CSS}</style></head>
<body>${body}
<script>
// Print is the download. Every phone and desktop browser turns a print into a
// PDF, which is one less file for somebody to lose track of and one less
// renderer for Num to run.
document.querySelectorAll('[data-print]').forEach(function (b) {
  b.addEventListener('click', function () { window.print(); });
});
</script>
</body></html>`;

const bar = (who, code, extra = '') => `<div class="bar">
  <button data-print type="button">Print or save as PDF</button>
  ${extra}
  <span class="sp">${H(who)} &middot; ${H(code)}</span>
</div>`;

const MAST = (tag) => `<div class="mast">
  <div class="logo"><svg width="10" height="10" viewBox="0 0 10 10" style="margin-right:5px"><circle cx="5" cy="5" r="5" fill="#1e7a4d"/></svg>NUM</div>
  <div class="tag">${H(tag)}</div>
  <div class="r">itsnum.com/claim<br>info@itsnum.com</div>
</div>`;

const FOOT = '<div class="foot">NUM is a 5arz company &middot; 5arz verifies a real, unique, live person is '
  + 'behind every account &middot; Placement is never for sale</div>';

/* ── 1. the leave-behind ───────────────────────────────────────────────────
 *
 * What the owner keeps. Prices verbatim from the live flyer; the CTA block is
 * the only part that differs from it, because this one names the Expert and
 * carries their QR. That swap is the entire reason this file exists.
 */
export function onePager(scout, link) {
  const who = firstName(scout.name);
  // ~30mm on printed A4. Sized up from 104 after a test scan: this is the one
  // that gets read off a counter in bad light, and a QR nobody can scan is a
  // leave-behind that credits nobody.
  const qr = qrSvg(link, { size: 118, margin: 0, dark: '#1f3a34', light: '#ffffff' });
  return `<div class="sheet">
${MAST('For Business')}
<h1>More covers.<br>No monthly fee.</h1>
<p class="sub">NUM sends you real guests who asked for a place like yours &mdash; and you pay nothing until one of them actually turns up.</p>
${headlineStats(scout.country)}
<h2>What you get</h2>
<div class="bens">
  <div class="ben"><h3>Fill slow nights</h3><p>Buy an hour of promotion for $20. Your offer reaches guests nearby who are asking right now.</p></div>
  <div class="ben"><h3>Get paid direct</h3><p>Your own QR code, per table or per zone. Guests pay you on your own rails. You keep 100%.</p></div>
  <div class="ben"><h3>Real guests only</h3><p>Every guest is identity-verified. No bots, no scraped lists, no fake bookings.</p></div>
  <div class="ben"><h3>Priority seating</h3><p>Guests pay $20 to hold a table. You keep $10 and the cover. Switch it on when you are full.</p></div>
</div>
<h2>How a boost works &mdash; ranking is never for sale</h2>
<div class="chat">
  <div class="q">&ldquo;Anywhere good for a drink near here tonight?&rdquo;</div>
  <div class="a">Three within ten minutes of you, all open now and all verified this month.</div>
</div>
<h2>What it costs</h2>
<table class="price">
  ${rateRows(scout.country)}
  <tr><td class="n">Dashboard &mdash; optional, cancel anytime</td><td class="p">from $9.99/mo</td></tr>
</table>
<div class="cta">
  <div class="qr">${qr}</div>
  <div>
    <h3>Claim your listing. It is free.</h3>
    <p>You are probably already in the directory. Claiming takes two minutes.</p>
  </div>
  <div class="go">itsnum.com/s/${H(scout.code)}<small>Scan the code, or type the address</small></div>
</div>
<p class="by">Brought to you by <b>${H(who)}</b>, NUM Expert &middot; code <b>${H(scout.code)}</b></p>
${FOOT}
</div>`;
}

/* ── 2. the counter card ───────────────────────────────────────────────────
 *
 * For the owner who says "leave it with me". Four to a sheet, cut on the
 * dashed line. Deliberately almost empty: a card that tries to make the whole
 * argument is a card nobody reads, and the argument was already made out loud.
 */
export function counterCard(scout, link) {
  const who = firstName(scout.name);
  const qr = qrSvg(link, { size: 132, margin: 0, dark: '#1f3a34', light: '#ffffff' });
  const one = `<div class="card">
    <div class="k">Num Expert</div>
    <h3>Your listing is<br>already written.</h3>
    <div class="qr">${qr}</div>
    <div class="code">${H(scout.code)}</div>
    <div class="url">itsnum.com/s/${H(scout.code)}</div>
    <p>Scan to claim it free. Two minutes, no monthly fee, and nothing at all until a guest NUM sent you turns up.</p>
    <p class="url">${H(who)} &middot; NUM Expert</p>
  </div>`;
  return `<div class="sheet">
${MAST('Counter cards')}
<p class="sub" style="margin-top:12px">Print, cut on the dashed lines, leave one on the counter. Every card carries ${H(who)}&rsquo;s code, so a venue that signs up next week is still credited to them.</p>
<div class="cards">${one}${one}${one}${one}</div>
${FOOT}
</div>`;
}

/* ── 3. the pitch card ─────────────────────────────────────────────────────
 *
 * For the rep, never handed over. Every answer below is one Num can stand
 * behind, and the two "never say this" lines are the point of the sheet: the
 * fastest way to lose a venue for good is to promise it ranking or traffic,
 * and a rep under pressure at a counter will reach for exactly those two.
 */
export function pitchCard(scout) {
  const who = firstName(scout.name);
  return `<div class="sheet">
${MAST('Sixty seconds at the counter')}
<h1 style="font-size:27pt">What to say.<br>And what never to.</h1>
<p class="sub">Yours, ${H(who)} &mdash; not for the owner. Your code is <b>${H(scout.code)}</b>.</p>

<h2>Open with the ask, not the product</h2>
<div class="say"><em>Say this</em>&ldquo;Someone staying nearby tonight is going to ask their phone where to eat. Right now it answers with ads. Num answers with three real places that are open, and I can put you in that answer. It is free to be in it, and you pay nothing at all until one of those guests actually turns up.&rdquo;</div>

<h2>Then hand over the sheet and stop talking</h2>
<ul class="steps">
  <li><b>1</b><span>Give them the one-pager. Let them read the four numbers across the top.</span></li>
  <li><b>2</b><span>&ldquo;You are probably already in there &mdash; claiming it just proves it is yours.&rdquo;</span></li>
  <li><b>3</b><span>Scan your own QR with them so they watch the page open. Two minutes, on their phone, while you are standing there, is the whole job.</span></li>
  <li><b>4</b><span>If they will not do it now, leave a counter card. It carries your code, so next week still counts as yours.</span></li>
</ul>

<h2>The three that come back every time</h2>
<div class="obj">
  <h3>&ldquo;What does it cost me?&rdquo;</h3>
  <p>Nothing to list, ever. Then, word for word off the rate card: <b>${H(feeSentence({ category: 'Restaurant', country: scout.country }))}</b> A room or an appointment is 15%, an activity 20%. Nothing on a no-show, a decline, or anyone who just walks in. And ${H(paymentOnlySentence({ country: scout.country }))}</p>
  <p class="never">Never say: two dollars a table, full stop. The $2 is the FLOOR, for when Num cannot see what the guest spent. A venue on a till that reports the bill pays ten percent, will read that on the website the same evening, and will remember who told them otherwise.</p>
</div>
<div class="obj">
  <h3>&ldquo;Who actually sees it?&rdquo;</h3>
  <p>Travellers already in their area who asked Num for a place like theirs, in whatever language they speak. Every one is identity-verified by 5arz &mdash; a real, unique, live person behind every account.</p>
  <p class="never">Never say: a number of guests, views, or covers. Nobody has promised them a figure and you must not be the first.</p>
</div>
<div class="obj">
  <h3>&ldquo;Can I pay to come up first?&rdquo;</h3>
  <p>No. Placement is never for sale. A boost buys an offer shown to people nearby who are already asking &mdash; it does not move them up the answer. Say this plainly: it is the reason the answer is worth being in.</p>
  <p class="never">Never say: that money moves ranking, or that you can have a word with someone. It is not true, and a venue that believes it will say so out loud to the next venue.</p>
</div>

<h2>What you get paid, so you can answer that one too</h2>
<p class="sub" style="font-size:10pt">$5 once that business has produced its first $5 of real revenue to Num &mdash; not for a signature. Then 20% of Num&rsquo;s commission and 20% of subscription revenue from your businesses, for 24 months. Your rates were locked the day you signed up and do not change if the programme does.</p>
${FOOT}
</div>`;
}

/* ── the three sheets, and the page that hands them out ────────────────────
 *
 * Each sheet is its own URL so a rep can send one to a phone or a shop's
 * printer without the other two. The index is what the dashboard links to.
 */
const SHEETS = Object.freeze({
  onepager: { title: 'Business one-pager', make: onePager,
    what: 'The A4 you leave with the owner. Prices, what they get, and your QR on the bottom.' },
  cards: { title: 'Counter cards', make: counterCard,
    what: 'Four to a page, cut them up. For the owner who says leave it with me.' },
  pitch: { title: 'Sixty seconds at the counter', make: pitchCard,
    what: 'Yours, not theirs. What to say, the three objections, and the two things never to promise.' },
});

function index(scout, origin) {
  const who = firstName(scout.name);
  const link = `${origin}/s/${scout.code}`;
  const rows = Object.entries(SHEETS).map(([k, s]) => `
    <div class="obj">
      <h3><a href="?code=${encodeURIComponent(scout.code)}&sheet=${k}" style="color:var(--pine)">${H(s.title)} &rarr;</a></h3>
      <p>${H(s.what)}</p>
    </div>`).join('');
  return `<div class="sheet">
${MAST('Your kit')}
<h1 style="font-size:27pt">Everything you<br>carry, ${H(who)}.</h1>
<p class="sub">Every sheet below already has your code <b>${H(scout.code)}</b> and your link on it. Open one and print it, or save it as a PDF &mdash; a business that scans any of them is credited to you.</p>
<h2>Your link</h2>
<div class="chat"><div class="a" style="font-size:12pt;font-weight:700">${H(link)}</div>
<div class="q" style="margin-top:4px">The same address as your card. Send it, scan it, or write it on a napkin.</div></div>
<h2>The sheets</h2>
${rows}
<h2>Before you hand anything over</h2>
<p class="sub" style="font-size:10pt">Two things are true and both matter: it is free for the venue to be listed, and placement is never for sale. Everything else you can look up. Nothing on these sheets promises a venue a number of guests, because nobody has promised them one.</p>
${FOOT}
</div>`;
}

/**
 * GET /api/scouts/kit?code=CODE[&sheet=onepager|cards|pitch]
 *
 * An unknown or paused code gets a plain refusal rather than a blank sheet:
 * printing a stack of leave-behinds that credit nobody is worse than printing
 * none, because the rep finds out weeks later, from a missing payment.
 */
export async function handleScoutKit(request, env, origin) {
  const url = new URL(request.url);
  const { scoutByCode } = await import('./scouts.mjs');
  const scout = await scoutByCode(env, url.searchParams.get('code'));

  if (!scout) {
    return new Response(page('Num Expert kit', `<div class="sheet">
${MAST('Your kit')}
<h1 style="font-size:26pt">That code is not<br>an active Expert.</h1>
<p class="sub">Check it against your card, or sign up at itsnum.com/scout to get one. Nothing is printed without a live code, because paper that credits nobody is worse than no paper.</p>
${FOOT}</div>`), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const link = `${origin}/s/${scout.code}`;
  const want = url.searchParams.get('sheet');
  const sheet = SHEETS[want];
  const body = sheet ? sheet.make(scout, link) : index(scout, origin);
  const title = sheet ? `${sheet.title} — ${scout.code}` : `Your kit — ${scout.code}`;
  const back = sheet
    ? `<a href="?code=${encodeURIComponent(scout.code)}">All sheets</a>`
    : '';

  return new Response(page(title, bar(firstName(scout.name), scout.code, back) + body), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Personalised and semi-private: one Expert's code should not be served
      // to another from a shared cache.
      'Cache-Control': 'private, no-store',
    },
  });
}
