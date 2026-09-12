/**
 * The Friday pack draw — Official Rules, at itsnum.com/friday-rules.
 *
 * ── WHY THIS PAGE IS THE FEATURE, NOT THE PAPERWORK ──────────────────────
 *
 * A prize draw with free entry is lawful in the US as a sweepstakes and in the
 * UK as a free draw. But "entry is free" is only a defence if it is stated in
 * public, alongside who may enter, when, how a winner is picked, the odds and
 * the sponsor. Without this page the promotion is a stranger on the internet
 * promising prizes, which is the shape of every scam a person has learned to
 * scroll past — so the page is also the thing that makes the offer believable.
 *
 * Every post about the draw links here. If this page is down, the posts should
 * stop.
 *
 * ── THAILAND IS DELIBERATELY EXCLUDED ────────────────────────────────────
 *
 * Thailand requires a licence under section 8 of its Gambling Act for a prize
 * draw, and the requirement applies to FREE-entry promotions where the business
 * benefits. Processing takes at least 15 working days; running one without a
 * licence carries up to a year's imprisonment. Num has Thai members and a Thai
 * venue, so this is not theoretical. Clause 10 says so plainly rather than
 * leaving Thai members to discover it when they try to claim.
 *
 * ── NOT LEGAL ADVICE ─────────────────────────────────────────────────────
 *
 * Written from primary sources on 12 Sep 2026 and NOT reviewed by a lawyer. The
 * Thailand clause and the age gate should be before it runs.
 */

/** One place, so a post and the page can never quote different numbers. */
export const RULES = Object.freeze({
  sponsor: '5arz Inc.',
  product: 'Num',
  site: 'itsnum.com',
  countries: ['United States', 'United Kingdom'],
  minAge: 18,
  winnersPerWeek: 10,
  packsPerWinner: 1,
  // Stated as a range because it is what a pack actually costs at retail, and a
  // single made-up figure in an Official Rules is a made-up figure in a legal
  // document.
  arvEachUsd: '4-8',
  opensDay: 'Friday',
  // The word a member sends. Kept HERE and imported by the entry code, so the
  // page and the thing that accepts entries can never name different words.
  entryCode: 'PACKS',
  contact: 'info@itsnum.com',
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function rulesHtml() {
  const r = RULES;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Friday Pack Draw — Official Rules · Num</title>
<meta name="description" content="Official Rules for the Num Friday Pack Draw. No purchase necessary. US and UK, 18+. Void where prohibited.">
<meta name="robots" content="index,follow">
<style>
:root{color-scheme:light dark;--ink:#14162e;--ink60:#5a5e7d;--bg:#fbfbfe;--line:#e5e7f5;--accent:#ec3013}
@media(prefers-color-scheme:dark){:root{--ink:#eef0ff;--ink60:#a3a7c9;--bg:#0d0e1c;--line:#262a45}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
 font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
 padding-block:32px;padding-left:20px;padding-right:20px}
main{max-width:720px;margin:0 auto}
.brand{font-size:11px;letter-spacing:.16em;color:var(--accent);font-weight:800}
h1{font-size:26px;line-height:1.25;margin:8px 0 4px}
.lede{color:var(--ink60);margin:0 0 26px}
.key{border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 28px}
.key b{display:block;font-size:15px}
h2{font-size:15px;margin:26px 0 6px}
p,li{color:var(--ink);margin:0 0 10px}
ol{padding-left:20px}
small,.fine{color:var(--ink60);font-size:13px;line-height:1.6}
a{color:var(--accent)}
hr{border:0;border-top:1px solid var(--line);margin:28px 0}
</style>
</head><body><main>

<div class="brand">NUM</div>
<h1>Friday Pack Draw — Official Rules</h1>
<p class="lede">Last updated 12 September 2026.</p>

<div class="key">
  <b>No purchase necessary. No payment of any kind will improve your chance of winning.</b>
  <span class="fine">Open to residents of the ${esc(r.countries.join(' and '))} aged ${r.minAge} or over.
  Void where prohibited. Not open to residents of Thailand — see clause 10.</span>
</div>

<h2>1. Sponsor</h2>
<p>${esc(r.sponsor)}, operator of ${esc(r.product)} (${esc(r.site)}). Questions:
<a href="mailto:${esc(r.contact)}">${esc(r.contact)}</a>.</p>

<h2>2. Eligibility</h2>
<p>Legal residents of the ${esc(r.countries.join(' or '))}, aged ${r.minAge} or over at the time of
entry. Employees of ${esc(r.sponsor)}, their immediate families and members of their households are
not eligible. Void where prohibited or restricted by law.</p>

<h2>3. How to enter</h2>
<p><strong>No purchase or payment is required, and none will improve your chance of winning.</strong>
To enter a given week's draw, during that week's entry period:</p>
<ol>
  <li>hold a registered ${esc(r.product)} account, and</li>
  <li>send ${esc(r.product)} the message <strong>${esc(r.entryCode)}</strong>.</li>
</ol>
<p>${esc(r.product)} will confirm your entry immediately. <strong>One entry per person per entry
period</strong>, however many times you send it — sending it again tells you that you are already
entered and does not add a second chance. Creating more than one account does not create more than
one entry and may disqualify you. Simply using ${esc(r.product)} for other things does not enter you:
the draw is opt-in, so nobody receives a prize they did not ask to be in the running for.</p>

<h2>4. Entry period</h2>
<p>Each weekly entry period runs from ${esc(r.opensDay)} 00:00 UTC to the following Thursday 23:59
UTC. A draw takes place each ${esc(r.opensDay)}.</p>

<h2>5. Prize</h2>
<p>${r.winnersPerWeek} winners per entry period. Each winner receives ${r.packsPerWinner} sealed
Pokémon trading card pack. Approximate retail value US$${esc(r.arvEachUsd)} each; approximate total
retail value per week US$${r.winnersPerWeek * 4}–${r.winnersPerWeek * 8}. Prizes are not
transferable. No cash alternative is offered, except at the Sponsor's discretion where a prize cannot
be delivered.</p>

<h2>6. Odds of winning</h2>
<p>Odds depend on the number of eligible entrants in that entry period. ${r.winnersPerWeek} prizes are
awarded each week regardless of how many people enter, so odds improve when fewer people enter and
lengthen when more do.</p>

<h2>7. How winners are chosen</h2>
<p>Winners are drawn at random from all eligible entries by an automated process. The random seed and
the resulting list of winners are recorded at the time of the draw and retained by the Sponsor, so
any draw can be reproduced and checked afterwards. No person selects the winners.</p>

<h2>8. Notification and claim</h2>
<p>Winners are notified in the ${esc(r.product)} app within 48 hours of the draw and must provide a
delivery address within 14 days. The Sponsor may ask a winner to confirm their age and country of
residence before shipping. A prize that is not claimed within 14 days is redrawn.</p>

<h2>9. Delivery</h2>
<p>Free, to addresses in the ${esc(r.countries.join(' and '))} only.</p>

<h2>10. Thailand</h2>
<p>Residents of Thailand are <strong>not currently eligible</strong> for this draw. Thai law requires a
licence for prize draws, including free-entry promotions, and the Sponsor does not yet hold one.
${esc(r.product)} members in Thailand receive a separate benefit that does not depend on chance, and
this clause will be updated if a licence is obtained.</p>

<h2>11. Not affiliated with Nintendo or The Pokémon Company</h2>
<p>This promotion is not sponsored, endorsed, administered by or associated with Nintendo, The Pokémon
Company, Creatures Inc. or GAME FREAK Inc. "Pokémon" is their trademark. Prizes are genuine sealed
product purchased at retail by the Sponsor.</p>

<h2>12. Your information</h2>
<p>Entry uses only your existing ${esc(r.product)} account and your use of the service — there is no
separate form. A winner's delivery address is used only to send the prize and is deleted once it has
arrived.</p>

<h2>13. Publicity</h2>
<p>Winners may be announced by first name and city only. No full name, account handle, email address
or delivery address is ever published. A winner may ask not to be named and still receive the prize.</p>

<h2>14. Changes</h2>
<p>The Sponsor may suspend or end the draw, and will say so on this page. Any change applies from the
next entry period, never retrospectively to a draw that has already taken place.</p>

<hr>
<p class="fine">${esc(r.sponsor)} · ${esc(r.site)} · These rules were last updated 12 September 2026.</p>

</main></body></html>`;
}

/** The route. Cached briefly — it is read far more often than it changes. */
export function fridayRules() {
  return new Response(rulesHtml(), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
