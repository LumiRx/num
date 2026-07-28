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

/* ── GET /i.gif?t= ─────────────────────────────────────────────────────── */

export async function handleOpenPixel(env, url) {
  const token = url.searchParams.get('t');
  if (token) {
    try {
      await env.DB.prepare(
        `UPDATE num_invites
            SET open_count = open_count + 1,
                opened_at  = COALESCE(opened_at, datetime('now'))
          WHERE token = ?`
      ).bind(token).run();
    } catch (e) { /* a tracking miss must never break the image */ }
  }
  return new Response(PIXEL, {
    headers: { 'Content-Type': 'image/gif', 'Content-Length': String(PIXEL.length), ...noStore },
  });
}

/* ── GET /claim?t= ─────────────────────────────────────────────────────── */

export async function handleClaimClick(env, url) {
  const token = url.searchParams.get('t');
  /* Trailing slash is deliberate. /claim is a directory index, so the assets
     runtime answers /claim with a 307 to /claim/ — harmless, but it puts an
     extra hop between a business clicking the invite and the page loading,
     and some corporate link scanners only follow the first response. */
  let dest = `${SITE}/claim/`;
  if (token) {
    try {
      await env.DB.prepare(
        `UPDATE num_invites
            SET click_count = click_count + 1,
                clicked_at  = COALESCE(clicked_at, datetime('now')),
                opened_at   = COALESCE(opened_at,  datetime('now'))
          WHERE token = ?`
      ).bind(token).run();
      const row = await env.DB.prepare(
        'SELECT lead_id, business_name FROM num_invites WHERE token = ?'
      ).bind(token).first();
      if (row) {
        const p = new URLSearchParams({ ref: token });
        if (row.business_name) p.set('b', row.business_name);
        if (row.lead_id) p.set('lead', row.lead_id);
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
