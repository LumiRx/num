/**
 * NUM · /s/CODE — the page an NFC card opens.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * itsnum.com/s/FARMER returned 404 on the day Isaiah's card was printed.
 *
 * Two separate reasons, and both are worth writing down because the next
 * short link will hit them again:
 *
 *   1. `/s/` was wired into worker/index.mjs, which is num-app and answers
 *      ONLY on app.itsnum.com. The apex is served by num-console, an
 *      assets-only Worker with no code at all, so /s/FARMER met the static
 *      asset server, matched no file, and got public/404.html. Nothing was
 *      broken; the route was simply never on the hostname that was printed.
 *   2. Even when it resolved, it 302'd to /claim. That is one of the three
 *      things a card holder needs and it silently refused the other two: the
 *      restaurant owner got the right page, the tour guide and the traveller
 *      standing next to him got a business claim form.
 *
 * So: this renders a real page, on both hostnames, with three doors.
 *
 * ── AN UNKNOWN CODE IS NEVER A 404 ───────────────────────────────────────
 *
 * A card can be mistyped, a code can be paused, a scout can leave. In every
 * one of those cases the visitor is still a person standing in a shop who
 * wants to sign up. They get the same three doors with nobody attributed.
 * We lose the attribution, which is ours to lose; they lose nothing. This is
 * the same rule /go/ already follows for poster typos.
 *
 * ── THE THREE DOORS CARRY DIFFERENT CODES, ON PURPOSE ────────────────────
 *
 * This is the part that is easy to get wrong and expensive to unwind.
 *
 *   business → /claim/?scout=CODE     the SCOUT code (num_scouts.code)
 *   host     → /hosts/?scout=CODE     the SCOUT code
 *   person   → /app/?ref=MEMBERCODE   their MEMBER referral code
 *
 * A scout code and a member referral code live in different tables with
 * different namespaces and nothing stops the same string existing in both.
 * Passing FARMER as ?ref= would ask linkReferral to look up a member code
 * that does not exist — a silent no-attribution — or, worse, one day match a
 * DIFFERENT person's code and pay the wrong human. So the member code is
 * resolved here, server-side, from num_referral_codes, and the person door is
 * plain /app/ when the scout has no member account yet. An honest missing
 * link beats a confident wrong one.
 *
 * The cookie is belt and braces: the query string is what the forms read, and
 * `num_scout` catches the visitor who closes the tab and types the address by
 * hand an hour later.
 */

const CACHE = 'no-store';

/** Everything interpolated into the page passes through here. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The person door.
 *
 * Returns the scout's MEMBER referral code, or null. Never returns the scout
 * code as a fallback — see the header. A null here means the traveller signs
 * up unattributed, which is correct: nobody can be paid for them anyway,
 * because there is no member row to pay.
 */
export async function personRefFor(env, scout) {
  if (!env?.DB || !scout?.member_id) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT code FROM num_referral_codes
        WHERE owner_id = ?1 AND owner_type = 'member' AND active = 1
        ORDER BY created_at ASC LIMIT 1`,
    ).bind(scout.member_id).first();
    return row?.code ? String(row.code) : null;
  } catch {
    // A referral lookup that fails must never take the page down with it.
    return null;
  }
}

/** First name only. "Isaiah sent you" reads like a person; "Isaiah Farmer sent
 *  you, as an authorised representative of" reads like a summons. */
export function firstName(full) {
  const s = String(full ?? '').trim();
  if (!s) return '';
  return s.split(/\s+/)[0].slice(0, 24);
}

/** Where each door goes. Exported so a test can assert the codes never cross. */
export function doorsFor({ code = null, personRef = null } = {}) {
  const q = code ? `?scout=${encodeURIComponent(code)}` : '';
  return {
    business: `/claim/${q}`,
    host: `/hosts/${q}`,
    person: personRef ? `/app/?ref=${encodeURIComponent(personRef)}` : '/app/',
  };
}

const HEAD = (title, desc) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<!-- A personal invite link is not a page we want in a search index: it names a
     real person and it is meant to be tapped, not found. -->
<meta name="robots" content="noindex,follow">
<link rel="icon" href="https://itsnum.com/favicon.ico">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<!-- ABSOLUTE, not /assets/…: this same page is served on app.itsnum.com, where
     public/ does not exist and a root-relative stylesheet would 404 silently
     into an unstyled page. The inline block below is the floor if both fail. -->
<link rel="stylesheet" href="https://itsnum.com/assets/site.css">
<script src="https://itsnum.com/assets/translate.js" defer></script>`;

const STYLE = `<style>
:root{--pri:#0EA483;--pri-d:#0B7C63;--pri-l:#E7F6F1;--ink:#0A1A24;--slate:#586A74;
  --line:#E7ECEE;--bg:#F6FAF9;--card:#fff;--amber:#EFA43A;--amber-l:#FDF3E1;
  --disp:'Space Grotesk','Plus Jakarta Sans',sans-serif;
  --body:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);line-height:1.6;font-size:16px;
  -webkit-font-smoothing:antialiased;
  padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
a{color:inherit;text-decoration:none}
h1,h2,h3{font-family:var(--disp);margin:0;letter-spacing:-.02em;font-weight:600;line-height:1.12}
.s-wrap{max-width:640px;margin:0 auto;padding:28px 20px 56px}
.s-brand{display:flex;align-items:center;gap:9px;font-family:var(--disp);font-weight:700;
  font-size:17px;letter-spacing:-.01em;margin-bottom:30px}
.s-dot{width:11px;height:11px;border-radius:50%;background:var(--pri);flex:0 0 auto}
.s-brand small{font-weight:500;font-size:12px;color:var(--slate);font-family:var(--body);letter-spacing:0}
.s-from{display:inline-flex;align-items:center;gap:9px;background:var(--pri-l);color:var(--pri-d);
  font-weight:700;font-size:13.5px;padding:8px 15px;border-radius:999px;margin-bottom:16px}
.s-from.plain{background:#fff;color:var(--slate);border:1px solid var(--line)}
.s-av{width:22px;height:22px;border-radius:50%;background:var(--pri);color:#fff;font-size:11px;
  display:inline-flex;align-items:center;justify-content:center;font-weight:800;letter-spacing:0}
h1{font-size:34px;margin-bottom:12px}
.s-lede{color:var(--slate);font-size:16.5px;margin:0 0 30px}
.s-q{font-size:12.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--pri-d);
  font-weight:700;margin:0 0 12px}
.s-door{display:block;background:var(--card);border:1px solid var(--line);border-radius:16px;
  padding:19px 20px;margin-bottom:13px;position:relative;
  box-shadow:0 1px 2px rgba(10,26,36,.04),0 10px 30px rgba(10,26,36,.05);
  transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}
.s-door:hover{transform:translateY(-2px);border-color:#cbd6da;box-shadow:0 16px 38px rgba(10,26,36,.10)}
.s-door:focus-visible{outline:3px solid var(--pri);outline-offset:3px}
.s-door h2{font-size:19.5px;margin-bottom:5px;padding-right:28px}
.s-door p{margin:0;color:var(--slate);font-size:14.5px;line-height:1.55}
.s-tag{display:inline-block;font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;
  font-weight:800;color:var(--pri-d);background:var(--pri-l);padding:3px 9px;border-radius:999px;margin-bottom:9px}
.s-tag.amber{background:var(--amber-l);color:#96631a}
.s-arrow{position:absolute;right:20px;top:50%;transform:translateY(-50%);color:var(--slate);font-size:21px}
.s-note{margin-top:26px;padding:15px 17px;border:1px solid var(--line);border-radius:14px;
  background:#fff;color:var(--slate);font-size:13.5px;line-height:1.6}
.s-note b{color:var(--ink)}
.s-foot{margin-top:26px;font-size:12.5px;color:var(--slate);text-align:center}
.s-foot a{text-decoration:underline;text-underline-offset:2px}
@media(max-width:480px){
  .s-wrap{padding:22px 16px 44px}
  h1{font-size:28px}
  .s-door{padding:17px 17px}
  .s-door h2{font-size:18px}
}
@media(prefers-reduced-motion:reduce){.s-door{transition:none}.s-door:hover{transform:none}}
</style>`;

const NAV = `<div class="s-wrap">
<a class="s-brand" href="https://itsnum.com/"><span class="s-dot"></span>NUM <small>travel concierge</small></a>`;

/**
 * The page itself.
 *
 * Every door is a plain <a href>. No JavaScript decides where anybody goes:
 * a card tapped in a basement restaurant on a borrowed phone with a blocked
 * script still works, and the attribution is already in the href rather than
 * waiting on a fetch.
 */
export function renderScoutPage({ scout = null, personRef = null } = {}) {
  const doors = doorsFor({ code: scout?.code ?? null, personRef });
  const who = firstName(scout?.name);
  const initial = who ? who[0].toUpperCase() : '';

  const from = scout
    ? `<p class="s-from"><span class="s-av">${esc(initial)}</span>${esc(who)} sent you &middot; Num Expert</p>`
    : `<p class="s-from plain">Welcome to Num</p>`;

  const lede = scout
    ? `${esc(who)} is a Num Expert. Whichever of these you are, this link tells us you came from `
      + `${esc(who)} &mdash; you do not have to type a code anywhere.`
    : `This card&rsquo;s code did not match anyone, so nobody is credited for your sign-up. `
      + `Everything below still works exactly the same &mdash; pick the one that is you.`;

  const title = scout ? `${who} sent you to Num` : 'Join Num';

  return `${HEAD(title, 'Sign your business up, join as a host, or get the Num app.')}
${STYLE}
</head>
<body>
${NAV}
${from}
<h1>${scout ? `Three ways in.` : `Three ways in.`}</h1>
<p class="s-lede">${lede}</p>

<p class="s-q">Which one are you?</p>

<a class="s-door" href="${esc(doors.business)}">
  <span class="s-tag">Restaurant, bar, shop, spa</span>
  <h2>List my business</h2>
  <p>Free to list. Guests find you inside Num and book. You are paid by them as normal &mdash;
     Num charges you only on a booking we actually send.</p>
  <span class="s-arrow" aria-hidden="true">&rarr;</span>
</a>

<a class="s-door" href="${esc(doors.host)}">
  <span class="s-tag">Guide, driver, concierge, fixer</span>
  <h2>Become a host</h2>
  <p>Your clients stay yours. Num gives you the book, the arrivals and the prices &mdash;
     no commission on your own work, and no cap on how many people you look after.</p>
  <span class="s-arrow" aria-hidden="true">&rarr;</span>
</a>

<a class="s-door" href="${esc(doors.person)}">
  <span class="s-tag amber">Travelling, or just hungry</span>
  <h2>Get the app</h2>
  <p>Ask for anything in any city and get a real answer &mdash; a table tonight, a doctor who
     speaks your language, the last ferry. Free.</p>
  <span class="s-arrow" aria-hidden="true">&rarr;</span>
</a>

<p class="s-note">${scout
    ? `<b>Nothing is filled in by hand.</b> ${esc(who)}&rsquo;s code travels with you through whichever `
      + `form you open, so you are never asked who sent you and the credit cannot be lost by a typo.`
    : `<b>Nothing is filled in by hand.</b> These forms ask only for what they need. `
      + `If somebody gave you this card, ask them to check the code on it &mdash; we will happily `
      + `attach their name afterwards.`}</p>

<p class="s-foot">
  <a href="https://itsnum.com/what-we-do/">What Num is</a> &middot;
  <a href="https://itsnum.com/privacy/">Privacy</a> &middot;
  <a href="https://itsnum.com/terms/">Terms</a>
</p>
</div>
</body>
</html>`;
}

/**
 * GET /s/CODE.
 *
 * Served by BOTH num-growth (itsnum.com/s/*) and num-app (app.itsnum.com/s/*)
 * out of this one function, because a printed card cannot be re-printed when
 * somebody later decides the other hostname was the right one.
 */
export async function handleScoutLanding(request, env, rawCode) {
  let scout = null;
  try {
    const { scoutByCode } = await import('./scouts.mjs');
    scout = await scoutByCode(env, rawCode);
  } catch {
    // Database down, import failed, whatever it was: serve the unattributed
    // page. A visitor who came to sign up must never meet an error screen.
    scout = null;
  }
  const personRef = await personRefFor(env, scout);
  const html = renderScoutPage({ scout, personRef });

  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': CACHE,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  if (scout) {
    // First touch, 90 days. Long enough for an owner who says "I'll do it
    // tonight", short enough that a card tapped last spring is not still
    // claiming businesses. HttpOnly because no page needs to read it — the
    // query string is what the forms use, and this is only the fallback.
    headers.append(
      'Set-Cookie',
      `num_scout=${scout.code}; Path=/; Max-Age=7776000; SameSite=Lax; Secure; HttpOnly`,
    );
  }
  return new Response(html, { status: 200, headers });
}
