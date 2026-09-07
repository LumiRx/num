// The homepage's job is to let a stranger USE Num before it asks for anything.
//
// The page this replaces asked for an install, a signup or an app-store trip
// before the product had said a word. On 1 Sep 2026 `first_message_sent` — an
// event that has existed in num-track.js since the beginning — had fired ZERO
// times, from any page, ever, because there was nowhere on itsnum.com a person
// could send a message from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The ads landing page lives at /ask/, NOT at the root. It was written as the
// home page on 1 Sep 2026 and went live by accident on 2 Sep, when a console
// deploy for an unrelated fix carried it. Dre had not asked for the home page
// to change, and the landing page has no navigation — which is right for a
// page paid traffic lands on and wrong for the front door of the site. The
// home page is the site again; this page is what the ads point at.
const page = readFileSync(new URL('../public/ask/index.html', import.meta.url), 'utf8');
const head = page.slice(0, page.indexOf('</head>'));
// Everything a visitor meets before scrolling: the hero, the box, the chips.
const aboveFold = page.slice(0, page.indexOf('id="earned"'));

test('the concierge is on the page, not a picture of it', () => {
  assert.match(page, /https:\/\/app\.itsnum\.com\/api\/num/, 'the homepage cannot reach the concierge');
  assert.match(page, /id="composer"/, 'there is no way to ask anything');
  assert.match(page, /data-q=/, 'no one-tap questions — a blank box is a wall on a phone');
});

test('nothing above the fold sends people to an app store or a signup', () => {
  // The words matter less than the DEMANDS. "No signup, no app store" is a
  // reassurance and belongs here; a link to an app store or a button that says
  // "Sign up" does not. So check the interactive elements, not the prose.
  const stores = /href="[^"]*(apps\.apple\.com|play\.google\.com|itunes\.apple\.com)/i;
  assert.ok(!stores.test(aboveFold), 'the page sends people to an app store before Num has answered anything');

  const controls = aboveFold.match(/<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/gi) || [];
  for (const c of controls) {
    const text = c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.ok(
      !/sign ?up|create an account|download/i.test(text),
      `a control above the fold asks the visitor to "${text}" before Num has answered anything`,
    );
  }
});

test('the ways to add or message Num are visible on arrival, under the ask box', () => {
  // ── A DECISION, RECORDED ──────────────────────────────────────────────
  // The first version of this page hid every "add Num" control until Num had
  // answered twice, on the theory that an exit before the first message costs
  // a Lead. Dre overruled that on 3 Sep 2026: an ads page with no visible way
  // to add Num or message it is not acceptable, whatever the theory says.
  //
  // The compromise that keeps both true: the row is ALWAYS visible, and it
  // sits UNDER the composer — so the ask box is still the first thing a paid
  // visitor meets, and the campaign still bids on the first message.
  const box = page.indexOf('id="composer"');
  const ways = page.indexOf('id="ways"');
  assert.ok(ways > 0, 'the add/message row is gone from the ads page');
  assert.ok(box > 0 && ways > box, 'the add/message row sits above the ask box — the box must come first');
  const row = page.slice(ways, page.indexOf('</div>', ways));
  assert.match(row, /href="\/app\/"/, 'no way to add Num — and /app/ is the page that knows how to explain an in-app browser');
  assert.match(row, /line\.me/, 'no way to message Num on LINE');
  assert.match(row, /id="waLine"/, 'no WhatsApp control on the page at all');
  assert.ok(!/<section[^>]*id="ways"/.test(page), 'the row must not be gated behind "earned" — it is meant to show on arrival');
});

test('the WhatsApp button never opens a dead chat', () => {
  // The button ships hidden and is revealed by the API, not by a number typed
  // into this file. /api/version publishes `whatsapp_number` ONLY when
  // WHATSAPP_ENABLED and TWILIO_WHATSAPP_FROM are both set and valid
  // (worker/index.mjs), so the button cannot appear before there is a sender
  // to answer it — and turning the channel on needs no site deploy. A visible
  // button to nowhere is worse than none: it spends the one click a stranger
  // was ever going to give us.
  assert.match(page, /id="waLine"[^>]*\bhidden\b/, 'the WhatsApp button is visible with no number behind it');
  assert.match(page, /whatsapp_number/, 'the button no longer asks the API whether the line is live');
  assert.match(page, /app\.itsnum\.com\/api\/version/,
    'the check must hit the app Worker — this page is served by the console Worker, which has no /api');
  assert.match(page, /wa\.me\/' \+ n/, 'the button does not build a wa.me link from the number');
  assert.match(page, /\/\^\\d\{8,15\}\$\/\.test\(n\)/, 'an unvalidated number would build a broken wa.me link');
  // Hard-coding it here again would put the reveal one deploy out of step with
  // the channel it advertises.
  assert.ok(!/var WA_NUMBER\s*=/.test(page), 'the number is hard-coded in the page again');
});

test('the install invitation is gated on Num having actually answered', () => {
  // Matched loosely on purpose. An earlier version pinned the exact one-line
  // form and broke the moment a Meta event was added INSIDE the same block —
  // a test that fails when the behaviour is unchanged teaches people to delete
  // tests. What must hold: reveal() is reachable only under `answered >= 2`.
  const gate = page.match(/if \(answered >= 2\)[\s\S]{0,400}?reveal\(\);/);
  assert.ok(gate, 'the home-screen ask is no longer gated on two real answers — asking on arrival is what lost 89% of the old page');
  const reveals = (page.match(/(?<!function )\breveal\(\)/g) || []).length;
  assert.equal(reveals, 1, 'reveal() is called from somewhere other than the two-answer gate');
  assert.match(page, /\.earned\{display:none/, 'the invitation is visible before it is earned');
});

test('first_message_sent finally fires', () => {
  const block = page.match(/if \(!answered\)[\s\S]{0,500}?first_message_sent/);
  assert.ok(block, "the one event that measures whether anybody used Num isn't wired up, or fires on every ask instead of the first");
});

test('the page measures behaviour, not just arrival', () => {
  // num-capture.js sends page_view and landing_view and NOTHING else. The
  // scroll depth, CTA taps and install events live in num-track.js, which was
  // never on this page — so 577 paid visitors in August produced arrival rows
  // and no way to tell whether one of them read a word.
  assert.match(head, /src="\/num-track\.js"/, 'num-track.js is missing — the homepage measures nothing but arrival');
  assert.match(head, /src="\/num-capture\.js"/, 'num-capture.js was dropped — consent and referral capture go with it');
});

test('no install button is shown where an install is impossible', () => {
  // Reddit, Instagram and LINE open links in their own webview, which cannot
  // install a PWA. The old install page showed the prompt to 1,805 people and
  // reached 3 of them.
  assert.match(page, /FBAN\|FBAV\|Instagram\|Line\\\/\|Twitter\|Reddit/,
    'in-app browsers are not detected — the install button will be dead for most paid traffic');
  assert.match(page, /btn\.hidden = true;/, 'a button that cannot work is still being rendered');
});

test('the campaign survives the hop into the app', () => {
  assert.match(page, /indexOf\('utm_'\)/, 'utm parameters are dropped when a visitor continues to the app');
});

// ── the page has to be able to CLOSE, and Meta has to be able to see it ──
const track = readFileSync(new URL('../public/js/track.js', import.meta.url), 'utf8');

test('the pixel harness is on the page paid traffic actually lands on', () => {
  // It shipped on /sms/ and /get/ only. A Meta campaign pointed at the
  // homepage would have reported nothing and had nothing to optimise towards.
  assert.match(head, /src="\/js\/track\.js"/, 'the Meta pixel harness is not on the homepage');
});

test('Meta is given a real conversion, not a page load', () => {
  // Optimising on PageView buys the cheapest human on the internet. `Lead`
  // fires when a stranger actually asks Num something — which, until this
  // page existed, had never happened once.
  assert.match(page, /numMetaEvent\('Lead'/, 'the first ask is not reported as a conversion');
  assert.match(page, /numMetaEvent\('ViewContent'/, 'a two-answer conversation is not reported');
  assert.match(page, /numMetaEvent\('CompleteRegistration'/, 'the home-screen add is not reported');
});

test('reporting an event never depends on the pixel being ready', () => {
  // A page that must ask "is the pixel on?" before every call is a page where
  // somebody eventually forgets to ask — and the visitor who converts BEFORE
  // accepting the consent banner is the best one we would lose.
  assert.match(track, /window\.numMetaEvent = function/, 'there is no safe way for a page to report an event');
  assert.match(track, /if \(queue\.length < 20\) queue\.push/, 'pre-consent events are dropped instead of queued');
  assert.match(track, /flush\(\);/, 'queued events are never sent after consent is given');
});

test('consent still gates the pixel', () => {
  assert.match(track, /if \(!PIXEL_ID\) return;/, 'the pixel no longer fails closed on a missing id');
  assert.match(track, /num_ads_consent/, 'the consent gate is gone');
});

test('the page uses its own photography, and it is not decoration', () => {
  for (const img of ['/assets/hero.jpg', '/assets/p1.jpg', '/assets/p2.jpg', '/assets/p3.jpg']) {
    assert.ok(page.includes(img), `${img} is unused — the page is text on a white background`);
  }
  // Every image earns its alt text and its dimensions; a paid-traffic page
  // that reflows while it loads has already lost the visitor.
  const imgs = page.match(/<img\b[^>]*>/g) || [];
  for (const i of imgs) {
    assert.match(i, /alt="/, `an image has no alt text: ${i.slice(0, 70)}`);
    assert.match(i, /width="\d+"\s+height="\d+"/, `an image has no intrinsic size (causes layout shift): ${i.slice(0, 70)}`);
  }
});

// ── THE WAY HOME, AND THE SHAPE OF THE PAGE (3 Sep 2026) ─────────────────
//
// Dre, looking at the built page: "this has no nav bar... lets make sure they
// can get to the home page." The page had no site navigation by design — it is
// what paid traffic lands on and every exit is a click that cost money — but
// "no nav" had quietly become "no wordmark, no way home, and nothing that says
// which company this is". A stranger's first impression was a bare headline.
/** Just the top bar — not the <head>, whose preconnects and stylesheet are
 *  links too and made the first version of the count below read 8. */
function topbar() {
  const i = page.indexOf('<header class="topbar">');
  return page.slice(i, page.indexOf('</header>', i) + 9);
}

test('the ads page has a way home and says whose page it is', () => {
  const head = topbar();
  assert.match(head, /class="topbar"/, 'the header is gone — the page opens on a bare headline again');
  assert.match(head, /class="topbrand" href="\/"/, 'the wordmark does not go home');
  assert.match(head, /NUM/, 'the page does not say whose it is');
});

test('but it still does not grow the site navigation', () => {
  // Two exits, both deliberate. Six is a different page.
  assert.equal(page.includes('class="nv"'), false, 'the shared site nav landed on the ads page');
  const head = topbar();
  const links = [...head.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length <= 2, `the header has ${links.length} links: ${links.join(', ')}`);
});

test('a button with nothing behind it cannot be on screen', () => {
  // [hidden] loses to any class that sets `display`, and .btn sets it — so the
  // WhatsApp button was visible and linked to "#" on the one page whose whole
  // job is a single click.
  assert.match(page, /\[hidden\]\{display:none!important\}/,
    'the hidden attribute is overridable again — the dead WhatsApp button comes back');
});

test('the page has one left edge', () => {
  // Three containers at 720 / 960 / 720 gave the hero, the cards and the proof
  // section three different left edges down one page.
  const widths = [...page.matchAll(/\.(askwrap|asks|proof)\{[^}]*max-width:(\d+)px/g)].map((m) => [m[1], m[2]]);
  const byName = Object.fromEntries(widths);
  assert.equal(byName.asks, '1080', '.asks drifted off the page grid');
  assert.equal(byName.proof, '1080', '.proof drifted off the page grid');
  assert.match(page, /\.askwrap\{max-width:1080px\}/, 'the hero container is no longer 1080 on desktop');
});

test('the photo cannot outgrow the thing people came to use', () => {
  // At 720px the ask column was ~345px and the photo was the biggest element
  // on the screen. The composer is the product; the photo is the reason to
  // believe it.
  const m = /grid-template-columns:([\d.]+)fr ([\d.]+)fr/.exec(page);
  assert.ok(m, 'the hero grid is gone');
  assert.ok(Number(m[1]) > Number(m[2]), 'the photo column is wider than the ask column');
  assert.match(page, /max-height:620px/, 'the photo has no ceiling');
});

test('the install invitation is still earned, and now gets seen', () => {
  assert.match(page, /scrollIntoView/, 'the card appears below the fold and nobody reads it');
  assert.match(page, /class="earned" id="earned"/);
  assert.match(page, /\.earned\{display:none/, 'the invitation shows on arrival — it must be earned');
});

// ── THE DAY THE ADS ARRIVED (3 Sep 2026) ────────────────────────────────
//
// The campaign moved to itsnum.com/ask/, so every pound NUM spends now lands
// here. These pin the two things that make that survivable: the page reports
// what happened to the people who arrive, and nothing on a third-party host
// can hold up its first paint.
test('the page reports both halves of an ask, not just the ask', () => {
  assert.match(page, /track\('num_answered'/, 'nothing records that Num actually answered');
  assert.match(page, /track\('ask_failed'/,
    'the failure branch is silent — if the API broke for real visitors every dashboard would show a quiet page and no reason');
});

test('the home-screen moment is measured, per browser', () => {
  // 95% of this traffic is inside Reddit's in-app browser, where a home screen
  // icon is not available at all. One averaged install rate would read as a
  // persuasion problem and argue for better copy, which is not the fix.
  assert.match(page, /track\('install_prompt_shown', path\)/, 'the invitation itself is unmeasured');
  assert.match(page, /var path = window\.numDeferredPrompt \? 'native'/);
  assert.match(page, /'inapp'/); assert.match(page, /'ios-safari'/);
  assert.match(page, /install_dismissed/, 'only the accepts are counted — the refusals vanish');
  // The iOS path shows instructions instead of a button; somebody reading them
  // is the closest thing to intent that path has, and it used to record nothing.
  assert.match(page, /ios-instructions-shown/);
});

test('"keep going in the app" is not filed as an install', () => {
  assert.match(page, /track\('primary_cta_click', 'earned-open-app'\)/,
    'a tap on "open the app" is being counted as home-screen intent, flattering the install number');
});

test('a font host cannot hold up the first paint', () => {
  // A stylesheet in the head blocks rendering until it arrives. On Thai mobile
  // data inside an in-app browser, a slow fonts.googleapis.com was a white
  // screen for as long as it took to fail.
  assert.match(page, /media="print" onload="this\.media='all'/,
    'the webfont stylesheet is render-blocking again');
  assert.match(page, /<noscript><link rel="stylesheet"/, 'no fallback with JavaScript off');
  assert.match(page, /display=swap/, 'text would be invisible while the font loads');
});
