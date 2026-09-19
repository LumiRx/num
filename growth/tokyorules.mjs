/**
 * Official Rules — the Tokyo trip.
 *
 * ── WHY THIS DOCUMENT EXISTS AT ALL ──────────────────────────────────────
 *
 * A prize draw whose entries are earned by bringing people in can be treated
 * as requiring CONSIDERATION, and a prize draw with consideration is a
 * lottery, which a private company may not run in most US states. The cure is
 * a free route in that asks nothing of anybody, published where an entrant
 * can read it. Clause 3 is that route, and it is the clause that must never
 * be quietly dropped to make the referral ladder look better.
 *
 * Same sponsor, same territories and same age as the Friday draw, because
 * they are the same company running to the same rules — and the stylesheet is
 * literally the same export, so the two documents cannot drift into looking
 * like they came from different places.
 *
 * Every figure comes from PRIZE and LADDER in growth/tokyodraw.mjs, which is
 * also what the card in the app and the ambassador console render from. One
 * object, so the rules and the advert cannot describe different draws.
 */
import { RULES, RULES_CSS } from './fridayrules.mjs';
import { PRIZE, LADDER, CAMPAIGN } from './tokyodraw.mjs';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function tokyoRulesHtml() {
  const r = RULES;
  const p = PRIZE;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)} — Official Rules · ${esc(r.product)}</title>
<meta name="description" content="Official Rules for the ${esc(r.product)} ${esc(p.title)} draw. No purchase necessary. US and UK, 18+. Void where prohibited.">
<meta name="robots" content="index,follow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,600&display=swap">
${RULES_CSS}
</head><body><main>

<h1>${esc(p.title)}</h1>
<p class="lede">Official Rules. No purchase necessary. A purchase or referral will not increase
your chances of winning. Void where prohibited.</p>

<section class="enter">
  <p class="enter-eyebrow">How to enter free — no referrals, ten seconds</p>
  <ol class="steps">
    <li><span>Open ${esc(r.product)} and go to Giveaways in your profile.</span></li>
    <li><span>Tap <b class="code">Enter</b> on ${esc(p.title)}.</span></li>
  </ol>
  <p class="enter-note">That is one entry, free, with nothing asked of you. You can also enter free
  by writing to <a href="mailto:${esc(r.contact)}">${esc(r.contact)}</a> — you do not need
  a ${esc(r.product)} account to do that. Bringing people to ${esc(r.product)} earns
  <em>additional</em> entries, and clause 4 says exactly how many.</p>
</section>

<div class="rules">

<h2><span class="n">1</span><span>Sponsor</span></h2>
<p>${esc(r.sponsor)}, operator of ${esc(r.product)} (${esc(r.site)}). Questions:
<a href="mailto:${esc(r.contact)}">${esc(r.contact)}</a>.</p>

<h2><span class="n">2</span><span>Eligibility</span></h2>
<p>Open to legal residents of ${esc(r.countries.join(' and '))} who are ${esc(r.minAge)} or older at the
time of entry. Employees of the Sponsor and their immediate families are not eligible. Void where
prohibited. Entrants are responsible for holding, or being able to obtain, any travel documents
required for the prize; the Sponsor cannot obtain a passport or a visa on anybody's behalf.</p>

<h2><span class="n">3</span><span>How to enter — the free route</span></h2>
<p><strong>No purchase is necessary and no referral is necessary.</strong> There are two free ways in,
and both give one entry:</p>
<p>(a) Tap <b class="code">Enter</b> on the ${esc(p.title)} card in the ${esc(r.product)} app.
(b) Write to <a href="mailto:${esc(r.contact)}">${esc(r.contact)}</a> with your name and a contact
address, stating that you wish to enter the ${esc(p.title)} draw. No account is required.</p>
<p>One free entry per person for the whole draw, by either route. A person who has entered free and
also brought people to ${esc(r.product)} keeps both — the free entry is never deducted.</p>

<h2><span class="n">4</span><span>Additional entries</span></h2>
<p>A person who brings others to ${esc(r.product)} through their own referral link receives
additional entries: <strong>${LADDER.first}</strong> people is one additional entry,
<strong>${LADDER.second}</strong> is two, and one further entry for every
<strong>${LADDER.step}</strong> people after that.</p>
<p>Only people who complete signup on ${esc(r.product)} are counted, and each person is counted once,
for whoever brought them in first. Entries are computed from those signups at the moment of the
draw and are not stored, so they can be recounted by anyone with access to the figures.</p>
<p>A signup does <strong>not</strong> count if it came from the same device as the person who
referred it, if several signups came from one device (one of those counts and the rest do not), if
the person has not verified a phone number or an email address, or if they have not yet used
${esc(r.product)} for anything. Sharing a wifi network is not by itself a reason for a signup not to
count. A referrer can see, in their own console, how many of their signups counted and the reason
for each one that did not.</p>
<p><strong>One person, one set of entries.</strong> Where the Sponsor can tell that two accounts
belong to the same person, they are treated as one entrant and their entries are merged rather than
added together.</p>

<h2><span class="n">5</span><span>Entry period</span></h2>
<p>Entries are accepted until 23:59 UTC on 31 December 2026. The draw takes place within fourteen
days of that date. The Sponsor will publish the result on this page.</p>

<h2><span class="n">6</span><span>Prize</span></h2>
<p>${esc(p.what)} Approximate retail value: USD ${esc(p.arvUsd)}. ${p.winners} winner.</p>
<p>Travel dates are agreed with the winner and are subject to availability. The prize covers return
flights and ${esc(p.nights)} nights of accommodation only: meals, transfers, insurance, visas and anything else are not included. The prize is not
transferable and may not be exchanged for cash. If the prize cannot be provided as described, the
Sponsor may substitute a prize of equal or greater value. Any tax on the prize is the winner's
responsibility.</p>

<h2><span class="n">7</span><span>Odds of winning</span></h2>
<p>Odds depend on the total number of entries received. Each entry has an equal chance; a person
holding four entries has four chances, not a better chance per entry.</p>

<h2><span class="n">8</span><span>How the winner is chosen</span></h2>
<p>The draw is a random selection run by computer. A random seed is generated once, before the draw,
and recorded together with the full list of entries. The selection is a shuffle driven by that seed,
so feeding the same seed and the same list back in produces the same winner — on any machine, at any
time. The Sponsor will provide the seed and the entry list on request, so the result can be checked
rather than taken on trust. The seed is never derived from the entry list.</p>

<h2><span class="n">9</span><span>Notification, verification and claim</span></h2>
<p>The winner is contacted on the details held by ${esc(r.product)} within seven days of the draw.
A winner who cannot be reached, or who does not respond within fourteen days, forfeits the prize and
a replacement is drawn from the same recorded entry list using a new recorded seed.</p>
<p><strong>Before the prize is released, the winner must complete identity verification with 5arz,
the Sponsor.</strong> This is free, it is done inside ${esc(r.product)}, and it exists so that a
prize of this size goes to a real person who entered once. One 5arz identity may be linked to only
one ${esc(r.product)} account. A winner who declines to verify, or whose verification shows the
account to be a duplicate of one already entered, forfeits, and a replacement is drawn in the same
way. Verification is not required to enter or to hold entries — only to receive the prize.</p>

<h2><span class="n">10</span><span>Your information</span></h2>
<p>Entry details are used to run the draw and to contact a winner, and for nothing else. They are not
sold and not shared with any third party except as needed to book the prize itself.</p>

<h2><span class="n">11</span><span>Publicity</span></h2>
<p>The winner may be announced by first name and city only. No full name, account handle, email
address or travel itinerary is published. A winner may ask not to be named and still receive the
prize.</p>

<h2><span class="n">12</span><span>Changes</span></h2>
<p>The Sponsor may suspend or end the draw, and will say so on this page. Any change applies from the
date it is published and never retrospectively to a draw that has already taken place. The free
routes in clause 3 will remain available for as long as the draw is open.</p>

</div>

<hr>
<p class="fine">${esc(r.sponsor)} · ${esc(r.site)} · Campaign reference ${esc(CAMPAIGN)} ·
These rules were last updated 19 September 2026.</p>

</main></body></html>`;
}

/** The route. Cached briefly — read far more often than it changes. */
export function tokyoRules() {
  return new Response(tokyoRulesHtml(), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
