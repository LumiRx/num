/**
 * NUM — invite endpoints (unsubscribe, open pixel, claim click)
 * =============================================================
 * Mounted on the num-accounts Worker so they ride the /api/accounts* route
 * that is already live on itsnum.com. No new Cloudflare route to add.
 *
 *   GET /api/accounts/unsubscribe?t=TOKEN   → suppress + a human page
 *   GET /api/accounts/i.gif?t=TOKEN         → record open, return 1x1
 *   GET /api/accounts/claim?t=TOKEN         → record click, 302 to /claim
 *
 * Nothing here requires a session: these run from an email client, before
 * anyone has signed in. The token IS the authorisation, and all three are
 * idempotent — a mail client that prefetches links cannot cause damage.
 */

const SITE = 'https://itsnum.com';

// 1x1 transparent GIF
const PIXEL = Uint8Array.from([
  0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,0x00,0x00,0x00,
  0xff,0xff,0xff,0x21,0xf9,0x04,0x01,0x00,0x00,0x00,0x00,0x2c,0x00,0x00,0x00,0x00,
  0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,0x01,0x00,0x3b,
]);

const noStore = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
};

/* ── A SCANNER IS NOT A READER ────────────────────────────────────────────
 *
 * growth/botfilter.test.mjs records this lesson from 3 Sep, when 302 crawlers
 * sat in the denominator of the landing page's conversion rate and made it
 * read as "nobody who arrives is interested". The invite counters below never
 * got the same treatment, and on 19 Sep they told the same lie twice as loudly.
 *
 * Of 77 recorded clicks on September's invites, 54 arrived under sixty seconds
 * after the mail was sent, each URL fetched an average of 2.1 times. Over the
 * same eleven days the claim page — whose analytics DO filter bots — logged
 * zero human arrivals, while the rest of the site's event log ran at 300-700
 * events a day. The clicks were corporate mail-security appliances opening
 * every link the instant it landed. A whole afternoon's analysis was built on
 * them before the contradiction between the two counters gave it away.
 *
 * So: the COUNTS still increment for everything, because a scanner touching a
 * URL is real information and throwing it away would be its own blindness. The
 * TIMESTAMPS are what people read and reason about, so they are now set only
 * for something that looks like a browser a person is holding.
 *
 * Rows written before this date have machine touches in opened_at/clicked_at
 * and cannot be cleaned retroactively — the user agent was never stored.
 *
 * Kept deliberately in step with BOT_UA in growth/worker.js. Two Workers that
 * cannot import from each other will drift; a copy that says so drifts slower
 * than a copy that pretends to be original.
 */
const BOT_UA = /bot\b|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|facebot|ia_archiver|semrush|ahrefs|mj12|dotbot|petalbot|yandex|baiduspider|duckduckbot|applebot|headlesschrome|phantomjs|puppeteer|playwright|python-requests|curl\/|wget|scrapy|go-http-client|axios\/|node-fetch|okhttp|java\/|httpclient|monitoring|uptime|pingdom|statuscake|gtmetrix|lighthouse|chrome-lighthouse/i;

/** True when the fetch plausibly came from a person's browser. */
export function looksHuman(req) {
  const ua = req?.headers?.get?.('user-agent') || '';
  // No user-agent at all is not a browser a person is holding.
  if (!ua) return false;
  return !BOT_UA.test(ua);
}

/* ── GET /i.gif?t= ─────────────────────────────────────────────────────── */

export async function handleOpenPixel(env, url, req) {
  const token = url.searchParams.get('t');
  if (token) {
    try {
      // An open pixel is fetched by mail-client image proxies more often than
      // by anything else, so `opened_at` only means a person if the fetch
      // looks like one. `open_count` keeps counting every fetch.
      const human = looksHuman(req);
      await env.DB.prepare(
        `UPDATE num_invites
            SET open_count = open_count + 1,
                opened_at  = CASE WHEN ?2 THEN COALESCE(opened_at, datetime('now'))
                                  ELSE opened_at END
          WHERE token = ?1`
      ).bind(token, human ? 1 : 0).run();
    } catch (e) { /* a tracking miss must never break the image */ }
  }
  return new Response(PIXEL, {
    headers: { 'Content-Type': 'image/gif', 'Content-Length': String(PIXEL.length), ...noStore },
  });
}

/* ── GET /claim?t= ─────────────────────────────────────────────────────── */

export async function handleClaimClick(env, url, req) {
  const token = url.searchParams.get('t');
  /* Trailing slash is deliberate. /claim is a directory index, so the assets
     runtime answers /claim with a 307 to /claim/ — harmless, but it puts an
     extra hop between a business clicking the invite and the page loading,
     and some corporate link scanners only follow the first response. */
  let dest = `${SITE}/claim/`;
  if (token) {
    try {
      // A click implies an open, but only when a person did the clicking —
      // otherwise one scanner fetch would stamp BOTH timestamps and a machine
      // would appear in the funnel twice.
      const human = looksHuman(req);
      await env.DB.prepare(
        `UPDATE num_invites
            SET click_count = click_count + 1,
                clicked_at  = CASE WHEN ?2 THEN COALESCE(clicked_at, datetime('now'))
                                   ELSE clicked_at END,
                opened_at   = CASE WHEN ?2 THEN COALESCE(opened_at,  datetime('now'))
                                   ELSE opened_at END
          WHERE token = ?1`
      ).bind(token, human ? 1 : 0).run();
      const row = await env.DB.prepare(
        'SELECT lead_id, business_name, dest FROM num_invites WHERE token = ?'
      ).bind(token).first();
      if (row) {
        /* THE PARAMETER NAMES HAVE TO MATCH WHAT THE PAGE READS.
         *
         * /claim/ reads exactly three things off the query string:
         *   qp("t") || qp("ref") || qp("token")   -> the invite token
         *   qp("d") || qp("dest")                 -> the destination
         *   qp("p")                               -> the place id
         *
         * This handler used to send `ref`, `b` and `lead`. Two of those land;
         * `lead` is read by nothing. So an invited business arrived with no
         * destination and no place, and the listing picker begins:
         *
         *     if (!dest || q.length < 3) return hideList();
         *
         * — it never even calls /api/claims/lookup, which applies the same
         * guard itself. No listing can be picked, so place_id stays null, so
         * /api/claims/start refuses with "place_id required". A claim could
         * not be started from an invite by anybody. Between 29 Aug, when the
         * picker shipped, and 7 Sep, 74 people reached that page; no listing
         * was ever picked, claim_place_picked has never once fired, and all
         * four rows in num_claims were created by hand from the admin side.
         *
         * Both values were already in the row. `dest` is a column on
         * num_invites, set on all 3,538 sends, and `lead_id` IS a place id —
         * every one of the 3,538 matches a row in `places`. Sending them under
         * the names the page reads turns this into the ?p= path the lookup's
         * own comment calls "exact and costs no query at all": the owner lands
         * with their listing already bound and types nothing.
         */
        const p = new URLSearchParams({ ref: token });
        if (row.business_name) p.set('b', row.business_name);
        if (row.lead_id) p.set('p', row.lead_id);
        if (row.dest) p.set('d', row.dest);
        dest = `${SITE}/claim/?${p.toString()}`;
      }
    } catch (e) { /* fall through to the plain claim page */ }
  }
  return new Response(null, { status: 302, headers: { Location: dest, ...noStore } });
}

/* ── GET /unsubscribe?t= ───────────────────────────────────────────────── */

export async function handleUnsubscribe(env, request, url) {
  const token = url.searchParams.get('t');
  let name = null;

  if (token) {
    try {
      const row = await env.DB.prepare(
        'SELECT email, business_name FROM num_invites WHERE token = ?'
      ).bind(token).first();

      if (row && row.email) {
        name = row.business_name;
        await env.DB.prepare(
          `UPDATE num_invites
              SET status = 'unsubscribed',
                  unsubscribed_at = COALESCE(unsubscribed_at, datetime('now'))
            WHERE token = ?`
        ).bind(token).run();
        await env.DB.prepare(
          `INSERT INTO num_suppressions (email, reason, note)
           VALUES (?, 'unsub', ?)
           ON CONFLICT(email) DO NOTHING`
        ).bind(String(row.email).toLowerCase(), name || null).run();
        // Take the listing out of outreach rotation too — we promised that.
        await env.DB.prepare(
          `UPDATE leads SET status = 'opted_out', updated_at = datetime('now')
            WHERE lower(email) = ?`
        ).bind(String(row.email).toLowerCase()).run();
      }
    } catch (e) { /* still show the confirmation — never argue with an opt-out */ }
  }

  return new Response(page(name), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...noStore },
  });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(name) {
  const who = name ? esc(name) : 'You';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Unsubscribed — NUM</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#EEF0FA;font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;padding:24px}
  .c{background:#fff;border-radius:20px;max-width:440px;width:100%;padding:40px 34px;text-align:center;
     box-shadow:0 20px 60px rgba(45,50,110,.12)}
  .m{font-family:Georgia,serif;font-style:italic;font-size:24px;font-weight:700;color:#4A4F86}
  h1{font-size:23px;font-weight:800;color:#181B3C;margin:20px 0 10px;letter-spacing:-.02em}
  p{font-size:15px;line-height:1.65;color:#5E6485;margin:0 0 14px}
  a{color:#6366F1;font-weight:600;text-decoration:none}
  .s{font-size:12.5px;color:#9AA0C4;margin-top:22px}
</style></head><body>
<div class="c">
  <div class="m">NuM</div>
  <h1>Done — you're off the list.</h1>
  <p>${who} won't receive another email from us, and we've taken the listing out of our outreach.</p>
  <p>If this was a mistake, or you'd like the profile back later, just write to
     <a href="mailto:info@5arz.com">info@5arz.com</a> and a person will sort it.</p>
  <div class="s">NUM · by 5arz · <a href="${SITE}">itsnum.com</a></div>
</div></body></html>`;
}
