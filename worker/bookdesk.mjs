// Closed-loop bookings: the table is confirmed THROUGH Num, not hoped for.
//
// Until now Num recommended and a human still had to call. This closes the
// loop: the request goes to the venue by SMS, the venue answers by tapping a
// link, and the guest's phone buzzes with the answer. Num stops being advice
// and starts being infrastructure.
//
// ── Why the partner side is a LINK and not an account ────────────────────
//
// A Phuket restaurant will not download an app, remember a password, or
// attend an onboarding call to accept one table. The bar for a partner's
// first confirmed booking has to be: read a text, tap once. The signed link
// IS the auth — it proves the tap came from the phone we texted, which is
// exactly as much identity as the fax machine it replaces ever had.
//
// The token is HMAC-signed over (request id, verdict), so a partner can
// confirm or decline only the one booking we asked them about, and a guest
// who inspects their own URL can't forge a confirmation. Ten-minute-old
// links still work — restaurants answer when service quiets down.
//
// ── States ───────────────────────────────────────────────────────────────
//
//   requested → confirmed | declined | expired
//
// One transition, one direction. Only 'requested' can move: a second tap on
// yesterday's link cannot un-confirm a table, because Stripe taught us that
// at-least-once delivery is a property of the universe, not of Stripe.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_booking_requests (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  venue_phone TEXT,
  party_size INTEGER,
  on_date TEXT,
  at_time TEXT,
  note TEXT,
  state TEXT NOT NULL DEFAULT 'requested',
  plan_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookreq_member ON num_booking_requests(member_id, created_at);
`;
let ready = false;
async function ensure(env) {
  if (ready || !env.DB) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  ready = true;
}

/** HMAC over exactly (id, verdict) — a confirm token cannot decline. */
async function sign(env, id, verdict) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.ADMIN_KEY ?? 'dev'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`book:${id}:${verdict}`));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function smsPartner(env, to, text) {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM || !to) return false;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text }),
  }).catch(() => null);
  return !!r?.ok;
}

export async function handleBooking(request, env, path) {
  await ensure(env);
  const url = new URL(request.url);
  const origin = env.NUM_APP_ORIGIN || 'https://app.itsnum.com';

  // ── Guest asks for a table ───────────────────────────────────────────
  if (path === '/request' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const me = clip(b.me, 40);
    const venue = clip(b.venue_name, 120);
    if (!me || !venue) return json({ error: 'Who, and where?' }, 400);
    const member = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(me).first();
    if (!member) return json({ error: 'sign up first' }, 404);

    const id = `bk_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
    const partySize = Math.min(Math.max(Number(b.party_size) || 2, 1), 40);
    await env.DB.prepare(
      `INSERT INTO num_booking_requests (id, member_id, venue_name, venue_phone, party_size, on_date, at_time, note, plan_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(
      id, me, venue, clip(b.venue_phone, 20), partySize,
      clip(b.on_date, 20), clip(b.at_time, 8), clip(b.note, 200), clip(b.plan_id, 40),
    ).run();

    // Text the venue, if we have a number for it. If we don't, the request
    // still exists — the concierge (or Dre, in the pilot) works the phone and
    // answers through the same link a partner would have tapped.
    let texted = false;
    if (b.venue_phone) {
      const yes = await sign(env, id, 'confirmed');
      const no = await sign(env, id, 'declined');
      texted = await smsPartner(
        env,
        clip(b.venue_phone, 20),
        `Num booking request: table for ${partySize}, ${b.on_date ?? 'tonight'}${b.at_time ? ` ${b.at_time}` : ''}, ` +
        `for ${member.name ?? 'a guest'}.${b.note ? ` (${clip(b.note, 80)})` : ''}\n` +
        `CONFIRM: ${origin}/api/book/answer?id=${id}&v=confirmed&t=${yes}\n` +
        `DECLINE: ${origin}/api/book/answer?id=${id}&v=declined&t=${no}`,
      );
    }
    return json({
      ok: true, id, state: 'requested', texted,
      note: texted
        ? 'The venue has it — you’ll hear the moment they answer.'
        : 'Request logged — our desk is on it, you’ll hear as soon as it’s confirmed.',
    });
  }

  // ── Venue answers (the tapped link) ──────────────────────────────────
  if (path === '/answer') {
    const id = clip(url.searchParams.get('id'), 40);
    const verdict = url.searchParams.get('v');
    const token = clip(url.searchParams.get('t'), 40);
    if (!id || !['confirmed', 'declined'].includes(verdict) || !token) return json({ error: 'bad link' }, 400);
    if (token !== (await sign(env, id, verdict))) return json({ error: 'bad link' }, 403);

    // Only 'requested' moves. Yesterday's link, tapped again, changes nothing.
    const flip = await env.DB.prepare(
      "UPDATE num_booking_requests SET state=?2, answered_at=datetime('now') WHERE id=?1 AND state='requested'",
    ).bind(id, verdict).run();
    const row = await env.DB.prepare('SELECT * FROM num_booking_requests WHERE id=?1').bind(id).first();
    if (!row) return json({ error: 'not found' }, 404);

    if (flip.meta.changes > 0) {
      const { notify } = await import('./push.mjs');
      await notify(env, {
        memberId: row.member_id,
        kind: 'plan',
        title: verdict === 'confirmed'
          ? `${row.venue_name} — confirmed ✓`
          : `${row.venue_name} couldn’t take it`,
        body: verdict === 'confirmed'
          ? `Table for ${row.party_size}${row.on_date ? `, ${row.on_date}` : ''}${row.at_time ? ` at ${row.at_time}` : ''}. It’s in your plan.`
          : 'Want me to find you somewhere just as good?',
        url: '/?go=plan',
        tag: `book:${id}`,
      }).catch(() => {});
    }

    // The partner sees a page, not JSON — they tapped this on a phone.
    return new Response(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#faf7f5">` +
      `<div style="text-align:center;padding:24px"><div style="font-size:40px">${verdict === 'confirmed' ? '✓' : '—'}</div>` +
      `<h2 style="margin:8px 0 4px">${verdict === 'confirmed' ? 'Confirmed' : 'Declined'}</h2>` +
      `<p style="color:#777">${row.venue_name} · party of ${row.party_size}${row.on_date ? ` · ${row.on_date}` : ''}` +
      `${flip.meta.changes === 0 ? '<br>(already answered)' : '<br>The guest has been told.'}</p></div>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  // ── Guest checks their requests ──────────────────────────────────────
  if (path === '/mine') {
    const me = clip(url.searchParams.get('me'), 40);
    if (!me) return json({ requests: [] });
    const { results } = await env.DB.prepare(
      'SELECT id, venue_name, party_size, on_date, at_time, state, created_at, answered_at FROM num_booking_requests WHERE member_id=?1 ORDER BY created_at DESC LIMIT 20',
    ).bind(me).all();
    return json({ requests: results ?? [] });
  }

  return json({ error: 'not found' }, 404);
}
