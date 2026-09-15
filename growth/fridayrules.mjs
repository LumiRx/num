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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,600&display=swap">
<style>
:root{
  color-scheme:light dark;
  --ink:#14162e;--ink60:#5a5e7d;--ink40:#8b8fae;
  --bg:#fbfbfe;--surface:#ffffff;--line:#e5e7f5;
  --accent:#ec3013;--accent-ink:#c42408;--accent-soft:#fff1ee;
  --shadow:0 1px 2px rgba(20,22,46,.05),0 10px 30px -20px rgba(20,22,46,.45);
}
@media(prefers-color-scheme:dark){:root{
  --ink:#eef0ff;--ink60:#a3a7c9;--ink40:#7b7fa3;
  --bg:#0d0e1c;--surface:#151731;--line:#262a45;
  --accent:#ff6a4d;--accent-ink:#ff927c;--accent-soft:#2a1410;
  --shadow:0 1px 2px rgba(0,0,0,.5),0 10px 30px -20px rgba(0,0,0,.9);
}}
*{box-sizing:border-box}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  padding-block:0 72px;padding-left:20px;padding-right:20px;
  -webkit-font-smoothing:antialiased;
}
main{max-width:680px;margin:0 auto}

/* masthead */
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding-block:22px;border-bottom:1px solid var(--line);margin-bottom:34px}
.brand{font-size:17px;font-weight:800;letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.brand i{font-style:normal;color:var(--accent)}
.eyebrow{font-size:10.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--ink40)}

h1{font-family:Newsreader,Georgia,"Times New Roman",serif;
  font-size:clamp(30px,6.5vw,42px);font-weight:600;line-height:1.1;
  letter-spacing:-.015em;margin:0 0 8px;text-wrap:balance}
.lede{color:var(--ink60);margin:0 0 30px;font-size:14.5px}

/* eligibility banner */
.key{border:1px solid var(--line);border-left:3px solid var(--accent);
  background:var(--surface);border-radius:0 14px 14px 0;padding:18px 20px;margin:0 0 22px;
  box-shadow:var(--shadow)}
.key b{display:block;font-size:15.5px;line-height:1.45;margin-bottom:7px}

/* how to enter — lifted out of clause 3, which is where it was buried */
.enter{background:var(--accent-soft);border:1px solid var(--line);border-radius:16px;
  padding:24px 22px;margin:0 0 40px}
.enter-eyebrow{font-size:10.5px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;
  color:var(--accent-ink);margin:0 0 16px}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.steps li{display:grid;grid-template-columns:26px 1fr;gap:14px;align-items:baseline;
  margin:0;color:var(--ink);font-size:16px}
.steps li::before{content:counter(step);counter-increment:step;
  font-variant-numeric:tabular-nums;font-weight:800;font-size:13px;color:var(--accent);
  border:1.5px solid var(--accent);border-radius:50%;width:26px;height:26px;
  display:grid;place-items:center;align-self:start}
.steps{counter-reset:step}
.code{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:19px;font-weight:700;letter-spacing:.1em;color:var(--ink);
  background:var(--surface);border:2px solid var(--accent);border-radius:9px;
  padding:2px 12px;margin-left:2px}
.steps li>span{line-height:1.9}
.enter-note{margin:18px 0 0;font-size:13.5px;color:var(--ink60);line-height:1.6}

/* the rules */
.rules{counter-reset:none;margin-top:8px}
h2{font-family:Newsreader,Georgia,serif;font-size:19px;font-weight:600;letter-spacing:-.01em;
  margin:34px 0 8px;display:grid;grid-template-columns:36px 1fr;gap:12px;align-items:baseline}
h2 .n{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:700;
  font-variant-numeric:tabular-nums;color:var(--accent);padding-top:4px}
h2+p,h2~p,h2~ol{margin-left:48px}
p,li{color:var(--ink);margin:0 0 11px}
ol{padding-left:20px}
small,.fine{color:var(--ink60);font-size:13px;line-height:1.6}
a{color:var(--accent-ink);font-weight:600}
hr{border:0;border-top:1px solid var(--line);margin:40px 0 20px}
strong{font-weight:700}
@media(max-width:520px){
  h2{grid-template-columns:28px 1fr;gap:9px}
  h2+p,h2~p,h2~ol{margin-left:0}
  ol{padding-left:18px}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head><body><main>

<div class="top">
  <a class="brand" href="https://itsnum.com/">NUM<i>.</i></a>
  <span class="eyebrow">Official Rules</span>
</div>
<h1>The Friday Pack Draw</h1>
<p class="lede">Last updated 15 September 2026.</p>

<div class="key">
  <b>No purchase necessary. No payment of any kind will improve your chance of winning.</b>
  <span class="fine">Open to residents of the ${esc(r.countries.join(' and '))} aged ${r.minAge} or over.
  Void where prohibited. Not open to residents of Thailand — see clause 10.</span>
</div>

<section class="enter">
  <p class="enter-eyebrow">How to enter — free, takes ten seconds</p>
  <ol class="steps">
    <li><span>Open ${esc(r.product)}, or find any text ${esc(r.product)} has sent you.</span></li>
    <li><span>Send back the word <b class="code">${esc(r.entryCode)}</b></span></li>
  </ol>
  <p class="enter-note">In the app or by text — both count, and both are free.
  One entry per person per week whichever way you send it. The entry period runs
  ${esc(r.opensDay)} 00:00 UTC to Thursday 23:59 UTC, and the draw happens each
  ${esc(r.opensDay)}. Full terms below.</p>
</section>

<div class="rules">
<h2><span class="n">1</span><span>Sponsor</span></h2>
<p>${esc(r.sponsor)}, operator of ${esc(r.product)} (${esc(r.site)}). Questions:
<a href="mailto:${esc(r.contact)}">${esc(r.contact)}</a>.</p>

<h2><span class="n">2</span><span>Eligibility</span></h2>
<p>Legal residents of the ${esc(r.countries.join(' or '))}, aged ${r.minAge} or over at the time of
entry. Employees of ${esc(r.sponsor)}, their immediate families and members of their households are
not eligible. Void where prohibited or restricted by law.</p>

<h2><span class="n">3</span><span>How to enter</span></h2>
<p><strong>No purchase or payment is required, and none will improve your chance of winning.</strong>
To enter a given week's draw, send ${esc(r.product)} the word <strong>${esc(r.entryCode)}</strong>
during that week's entry period. There are two ways to do it and they count exactly the same:</p>
<ol>
  <li><strong>In the app</strong>, if you hold a registered ${esc(r.product)} account; or</li>
  <li><strong>By text</strong>, as a reply to a message ${esc(r.product)} has sent you.</li>
</ol>
<p>If you enter by text, standard message and data rates may apply and message frequency varies. You
can reply HELP for help or STOP to opt out at any time. <strong>Agreeing to receive messages is not a
condition of entering or of winning</strong> — the app route requires no messages at all.</p>
<p>${esc(r.product)} confirms your entry in the app. If you entered by text and no confirmation
reaches you, <strong>your entry still stands</strong> — it is recorded when your message arrives, and
a confirmation that fails to send does not undo it.</p>
<p><strong>One entry per person per entry period</strong>, however many times you send it and
whichever way you send it — sending it again tells you that you are already entered and does not add
a second chance. Entering in the app and by text from your own number is still one entry. Creating
more than one account does not create more than one entry and may disqualify you. Simply using
${esc(r.product)} for other things does not enter you: the draw is opt-in, so nobody receives a prize
they did not ask to be in the running for.</p>

<h2><span class="n">4</span><span>Entry period</span></h2>
<p>Each weekly entry period runs from ${esc(r.opensDay)} 00:00 UTC to the following Thursday 23:59
UTC. A draw takes place each ${esc(r.opensDay)}.</p>

<h2><span class="n">5</span><span>Prize</span></h2>
<p>${r.winnersPerWeek} winners per entry period. Each winner receives ${r.packsPerWinner} sealed
Pokémon trading card pack. Approximate retail value US$${esc(r.arvEachUsd)} each; approximate total
retail value per week US$${r.winnersPerWeek * 4}–${r.winnersPerWeek * 8}. Prizes are not
transferable. No cash alternative is offered, except at the Sponsor's discretion where a prize cannot
be delivered.</p>

<h2><span class="n">6</span><span>Odds of winning</span></h2>
<p>Odds depend on the number of eligible entrants in that entry period. ${r.winnersPerWeek} prizes are
awarded each week regardless of how many people enter, so odds improve when fewer people enter and
lengthen when more do.</p>

<h2><span class="n">7</span><span>How winners are chosen</span></h2>
<p>Winners are drawn at random from all eligible entries by an automated process. The random seed and
the resulting list of winners are recorded at the time of the draw and retained by the Sponsor, so
any draw can be reproduced and checked afterwards. No person selects the winners.</p>

<h2><span class="n">8</span><span>Notification and claim</span></h2>
<p>Winners are notified within 48 hours of the draw — in the ${esc(r.product)} app, and by text where
the entry came from a phone number — and must provide a delivery address within 14 days. The Sponsor may ask a winner to confirm their age and country of
residence before shipping. A prize that is not claimed within 14 days is redrawn.</p>

<h2><span class="n">9</span><span>Delivery</span></h2>
<p>Free, to addresses in the ${esc(r.countries.join(' and '))} only.</p>

<h2><span class="n">10</span><span>Thailand</span></h2>
<p>Residents of Thailand are <strong>not currently eligible</strong> for this draw. Thai law requires a
licence for prize draws, including free-entry promotions, and the Sponsor does not yet hold one.
${esc(r.product)} members in Thailand receive a separate benefit that does not depend on chance, and
this clause will be updated if a licence is obtained.</p>

<h2><span class="n">11</span><span>Not affiliated with Nintendo or The Pokémon Company</span></h2>
<p>This promotion is not sponsored, endorsed, administered by or associated with Nintendo, The Pokémon
Company, Creatures Inc. or GAME FREAK Inc. "Pokémon" is their trademark. Prizes are genuine sealed
product purchased at retail by the Sponsor.</p>

<h2><span class="n">12</span><span>Your information</span></h2>
<p>Entry uses only your existing ${esc(r.product)} account and your use of the service — there is no
separate form. A winner's delivery address is used only to send the prize and is deleted once it has
arrived.</p>

<h2><span class="n">13</span><span>Publicity</span></h2>
<p>Winners may be announced by first name and city only. No full name, account handle, email address
or delivery address is ever published. A winner may ask not to be named and still receive the prize.</p>

<h2><span class="n">14</span><span>Changes</span></h2>
<p>The Sponsor may suspend or end the draw, and will say so on this page. Any change applies from the
next entry period, never retrospectively to a draw that has already taken place.</p>

</div>

<hr>
<p class="fine">${esc(r.sponsor)} · ${esc(r.site)} · These rules were last updated 15 September 2026.</p>

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
