// One client, everything about them.
//
// WHAT A HOST ACTUALLY HAS. A name, an email, a city and one notes field — and
// everything else in their head: she will not fly before nine, he is allergic
// to shellfish, her trip is already in her own calendar, that October dinner
// has not been paid for. A host who cannot look one person up cannot be
// organised for sixty of them, and "your clients stay yours" is a promise that
// costs nothing if the file we keep for them is thinner than the one in their
// phone.
//
// THE SHAPE. One read, one write, one import:
//
//   GET  /api/host/client?id=        the whole file, in the order it is read
//   POST /api/host/client            save, event, invoice, portal
//   POST /api/host/client-import     an .ics their client sent
//
// EVERY QUERY IS SCOPED BY host_id AND NOTHING IS TAKEN ON TRUST FROM THE
// BODY. A client id in a request body is a claim. Each handler re-derives
// ownership from num_host_clients WHERE id = ? AND host_id = ?, every time,
// rather than checking once and passing the id along — a check that happens
// once is a check somebody later adds a path around.

import { rows, readFailedResponse, isReadFailed } from './readfail.mjs';
import { parseIcs, MAX_EVENTS } from './icsparse.mjs';

const nid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const today = () => now().slice(0, 10);

// An .ics for one trip is a few KB. A whole exported calendar is megabytes and
// is not what this feature is for.
export const MAX_ICS_BYTES = 512 * 1024;

/** Interests are short tags, not sentences. Twenty is more than anybody needs
 *  and few enough that the list stays readable. */
export function tidyInterests(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(',');
  const out = [];
  for (const raw of arr) {
    const t = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!t) continue;
    if (out.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

const safeArr = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

/** The client as the console reads them. `consent_text` is deliberately not in
 *  here: it is a legal record, not a field, and it is shown once where it was
 *  given rather than echoed into every view. */
export function clientFile(c) {
  return {
    id: c.id,
    name: c.name,
    email: c.email || '',
    phone: c.phone || '',
    company: c.company || '',
    home_city: c.home_city || '',
    home_country: c.home_country || '',
    languages: c.languages || '',
    likes: c.likes || '',
    dislikes: c.dislikes || '',
    interests: safeArr(c.interests),
    dietary: c.dietary || '',
    access_needs: c.access_needs || '',
    birthday: c.birthday || '',
    notes: c.notes || '',
    status: c.status,
    source: c.source,
    created_at: c.created_at,
    portal_trips: !!c.portal_trips,
  };
}

async function ownClient(env, hostId, clientId) {
  if (!clientId) return null;
  return env.DB.prepare(
    "SELECT * FROM num_host_clients WHERE id = ?1 AND host_id = ?2 AND status <> 'removed'"
  ).bind(clientId, hostId).first().catch(() => null);
}

/**
 * GET /api/host/client?k=KEY&id=hc_…
 *
 * Everything in one response rather than five. A client page that loads in
 * five requests shows a host five different half-answers on a bad connection.
 */
export async function hostClient(req, env, url, D) {
  const { J, clean, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'GET') return J({ ok: false, error: 'method' }, 405);

  const id = clean(url.searchParams.get('id'), 40);
  const c = await ownClient(env, host.id, id);
  if (!c) return J({ ok: false, error: 'not_your_client' }, 404);

  try {
    const [work, events] = await Promise.all([
      rows(env.DB.prepare(
        `SELECT id, service_key, title, detail, city, country, starts_at, ends_at, party_size,
                price_minor, currency, unit, status, source, created_at, confirmed_at,
                invoiced_at, paid_at, invoice_ref, booking_fee_minor
           FROM num_host_requests
          WHERE host_id = ?1 AND client_id = ?2
          ORDER BY COALESCE(starts_at, created_at) DESC LIMIT 200`
      ).bind(host.id, c.id).all(), 'their bookings'),
      rows(env.DB.prepare(
        `SELECT id, source, uid, title, detail, location, starts_at, ends_at, all_day, tz,
                repeats, request_id, created_at
           FROM num_client_events
          WHERE host_id = ?1 AND client_id = ?2
          ORDER BY starts_at ASC LIMIT 400`
      ).bind(host.id, c.id).all(), 'their calendar'),
    ]);

    /* AHEAD AND BEHIND, split here rather than in the console.
     *
     * The split is by date string comparison, which works because every
     * timestamp in this system is stored in the same sortable shape. An
     * all-day event stored as '2026-09-20' sorts correctly against
     * '2026-09-20 19:00:00' because the date part comes first. */
    const t = today();
    const ahead = (r) => String(r.starts_at || r.created_at || '') >= t;

    // Money. Only what was confirmed — a request that was logged and declined
    // is work that did not happen, and counting it would flatter the number.
    const billable = work.filter((w) => w.status === 'confirmed' || w.status === 'done');
    const sum = (list) => list.reduce((n, w) => n + Number(w.price_minor || 0), 0);
    const unpaid = billable.filter((w) => !w.paid_at);

    return J({
      ok: true,
      client: clientFile(c),
      // Their own page. Minted for every client since 0015, so this is a link
      // that already works rather than something switched on here.
      portal: c.member_token
        ? {
          url: (env.SITE || 'https://itsnum.com') + '/my-host/?t=' + c.member_token,
          calendar: (env.SITE || 'https://itsnum.com') + '/api/host/client-calendar.ics?t=' + c.member_token,
          trips: !!c.portal_trips,
        }
        : null,
      bookings: work.filter(ahead),
      history: work.filter((w) => !ahead(w)),
      calendar: {
        ahead: events.filter((e) => String(e.starts_at) >= t),
        past: events.filter((e) => String(e.starts_at) < t).slice(-60),
      },
      money: {
        currency: billable[0] ? billable[0].currency : (host.currency || 'GBP'),
        confirmed_minor: sum(billable),
        unpaid_minor: sum(unpaid),
        unpaid_count: unpaid.length,
        // Every confirmed booking is an invoice line. There is no invoices
        // table on purpose — see the head of 0038.
        invoices: billable.map((w) => ({
          id: w.id,
          title: w.title,
          when: w.starts_at || w.confirmed_at || w.created_at,
          price_minor: w.price_minor,
          currency: w.currency,
          invoice_ref: w.invoice_ref || '',
          invoiced_at: w.invoiced_at,
          paid_at: w.paid_at,
          state: w.paid_at ? 'paid' : (w.invoiced_at ? 'sent' : 'unbilled'),
        })),
      },
    });
  } catch (e) {
    if (isReadFailed(e)) return readFailedResponse(J, e);
    throw e;
  }
}

/**
 * POST /api/host/client?k=KEY
 * { action: 'save' | 'event' | 'event-delete' | 'invoice' | 'portal', id, … }
 */
export async function hostClientWrite(req, env, url, D) {
  const { J, clean, readJSON, badOrigin, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== 'active') return J({ ok: false, error: 'host_not_active' }, 403);

  let b;
  try { b = await readJSON(req, 32768); } catch { return J({ ok: false, error: 'bad_body' }, 400); }

  const c = await ownClient(env, host.id, clean(b.id, 40));
  if (!c) return J({ ok: false, error: 'not_your_client' }, 404);
  const action = String(b.action || 'save');

  if (action === 'save') {
    const interests = JSON.stringify(tidyInterests(b.interests));
    await env.DB.prepare(
      `UPDATE num_host_clients
          SET likes = ?1, dislikes = ?2, interests = ?3, dietary = ?4, access_needs = ?5,
              company = ?6, birthday = ?7, notes = ?8, languages = ?9,
              home_city = ?10, home_country = ?11, updated_at = ?12
        WHERE id = ?13 AND host_id = ?14`
    ).bind(
      clean(b.likes, 2000) || null, clean(b.dislikes, 2000) || null, interests,
      clean(b.dietary, 1000) || null, clean(b.access_needs, 1000) || null,
      clean(b.company, 120) || null, clean(b.birthday, 40) || null,
      clean(b.notes, 2000) || null, clean(b.languages, 120) || null,
      clean(b.home_city, 80) || null, clean(b.home_country, 60) || null,
      now(), c.id, host.id
    ).run();
    const after = await ownClient(env, host.id, c.id);
    return J({ ok: true, client: clientFile(after) });
  }

  if (action === 'event') {
    const title = clean(b.title, 200);
    const starts = clean(b.starts_at, 40);
    if (!title || !starts) {
      return J({ ok: false, error: 'need_title_and_when',
        says: 'An entry needs something to call it and a date.' }, 400);
    }
    const id = clean(b.event_id, 40);
    if (id) {
      // Scoped by client AND host. An event id from a body is a claim.
      const r = await env.DB.prepare(
        `UPDATE num_client_events
            SET title=?1, detail=?2, location=?3, starts_at=?4, ends_at=?5, all_day=?6, updated_at=?7
          WHERE id=?8 AND host_id=?9 AND client_id=?10`
      ).bind(title, clean(b.detail, 2000) || null, clean(b.location, 300) || null,
        starts, clean(b.ends_at, 40) || null, b.all_day ? 1 : 0, now(), id, host.id, c.id).run();
      if (!r.meta || !r.meta.changes) return J({ ok: false, error: 'no_such_event' }, 404);
      return J({ ok: true, event_id: id });
    }
    const newId = nid('cev_');
    await env.DB.prepare(
      `INSERT INTO num_client_events
         (id, host_id, client_id, source, title, detail, location, starts_at, ends_at, all_day, created_at)
       VALUES (?1,?2,?3,'host',?4,?5,?6,?7,?8,?9,?10)`
    ).bind(newId, host.id, c.id, title, clean(b.detail, 2000) || null,
      clean(b.location, 300) || null, starts, clean(b.ends_at, 40) || null,
      b.all_day ? 1 : 0, now()).run();
    return J({ ok: true, event_id: newId });
  }

  if (action === 'event-delete') {
    const id = clean(b.event_id, 40);
    const r = await env.DB.prepare(
      'DELETE FROM num_client_events WHERE id=?1 AND host_id=?2 AND client_id=?3'
    ).bind(id, host.id, c.id).run();
    if (!r.meta || !r.meta.changes) return J({ ok: false, error: 'no_such_event' }, 404);
    return J({ ok: true, deleted: id });
  }

  /* INVOICING.
   *
   * Two timestamps and the host's own reference. NUM does not generate an
   * invoice number: a host has an accounting system with its own sequence, and
   * a second sequence of ours against the same client is how a payment gets
   * applied to the wrong thing.
   *
   * Only a CONFIRMED booking can be billed. Marking a declined request as paid
   * would put money against work that did not happen, and the totals a host
   * reads at the top of the page are the first place that would show up. */
  if (action === 'invoice') {
    const rid = clean(b.request_id, 40);
    const w = await env.DB.prepare(
      `SELECT id, status FROM num_host_requests
        WHERE id=?1 AND host_id=?2 AND client_id=?3`
    ).bind(rid, host.id, c.id).first().catch(() => null);
    if (!w) return J({ ok: false, error: 'no_such_booking' }, 404);
    if (w.status !== 'confirmed' && w.status !== 'done') {
      return J({ ok: false, error: 'not_confirmed',
        says: 'Only confirmed work can be billed. Confirm it first.' }, 409);
    }

    const state = String(b.state || '');
    if (!['unbilled', 'sent', 'paid'].includes(state)) return J({ ok: false, error: 'bad_state' }, 400);
    const ref = clean(b.invoice_ref, 60) || null;

    // 'sent' after 'paid' un-pays it rather than leaving both set, because a
    // row that is paid and not yet invoiced is a state nobody can read.
    const invoicedAt = state === 'unbilled' ? null : (clean(b.invoiced_at, 40) || now());
    const paidAt = state === 'paid' ? (clean(b.paid_at, 40) || now()) : null;

    await env.DB.prepare(
      `UPDATE num_host_requests SET invoiced_at=?1, paid_at=?2, invoice_ref=?3, updated_at=?4
        WHERE id=?5 AND host_id=?6`
    ).bind(invoicedAt, paidAt, ref, now(), w.id, host.id).run();
    return J({ ok: true, request_id: w.id, state });
  }

  if (action === 'portal') {
    const on = (b.portal_trips === true || b.portal_trips === 1) ? 1 : 0;
    await env.DB.prepare(
      'UPDATE num_host_clients SET portal_trips = ?1, updated_at = ?2 WHERE id = ?3 AND host_id = ?4'
    ).bind(on, now(), c.id, host.id).run();
    return J({
      ok: true,
      portal_trips: !!on,
      // Said back, because the thing a host is most likely to misread is what
      // the switch does NOT cover.
      says: on
        ? 'They can see their trips on their own page, and in the calendar feed they subscribed to.'
        : 'Their page still tells them who holds their details and lets them leave. It no longer lists their '
          + 'trips, and the calendar feed they subscribed to now carries nothing rather than breaking.',
    });
  }

  return J({ ok: false, error: 'unknown_action' }, 400);
}

/**
 * POST /api/host/client-import?k=KEY&id=hc_…
 * Body: the .ics file, as text.
 *
 * Re-importing the same trip UPDATES rather than duplicates, keyed on the
 * calendar's own UID. That is the whole difference between a feature a host
 * uses twice and one they use once and never again.
 */
export async function hostClientImport(req, env, url, D) {
  const { J, clean, badOrigin, hostAuth } = D;
  const host = await hostAuth(env, url);
  if (!host) return J({ ok: false, error: 'unauthorised' }, 401);
  if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
  if (badOrigin(req)) return J({ ok: false }, 403);
  if (host.status !== 'active') return J({ ok: false, error: 'host_not_active' }, 403);

  const c = await ownClient(env, host.id, clean(url.searchParams.get('id'), 40));
  if (!c) return J({ ok: false, error: 'not_your_client' }, 404);

  const text = await req.text();
  if (!text.trim()) return J({ ok: false, error: 'empty' }, 400);
  if (text.length > MAX_ICS_BYTES) {
    return J({ ok: false, error: 'too_big',
      says: 'That is a whole calendar rather than a trip. Export just the trip and send that.' }, 413);
  }

  const { events, skipped } = parseIcs(text, { max: MAX_EVENTS });
  if (!events.length) {
    return J({ ok: false, error: 'nothing_readable',
      says: 'We could not find any events in that file. It should be a .ics export.' }, 422);
  }

  const importId = nid('imp_');
  let added = 0;
  let updated = 0;

  for (const e of events) {
    const uid = e.uid ? String(e.uid).slice(0, 200) : null;
    if (uid) {
      const existing = await env.DB.prepare(
        'SELECT id FROM num_client_events WHERE client_id = ?1 AND uid = ?2'
      ).bind(c.id, uid).first().catch(() => null);
      if (existing) {
        await env.DB.prepare(
          `UPDATE num_client_events
              SET title=?1, detail=?2, location=?3, starts_at=?4, ends_at=?5, all_day=?6,
                  tz=?7, repeats=?8, import_id=?9, updated_at=?10
            WHERE id=?11`
        ).bind(e.title, e.detail || null, e.location || null, e.starts_at, e.ends_at || null,
          e.all_day ? 1 : 0, e.tz || null, e.repeats ? 1 : 0, importId, now(), existing.id).run();
        updated += 1;
        continue;
      }
    }
    try {
      await env.DB.prepare(
        `INSERT INTO num_client_events
           (id, host_id, client_id, source, uid, title, detail, location, starts_at, ends_at,
            all_day, tz, repeats, import_id, created_at)
         VALUES (?1,?2,?3,'import',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`
      ).bind(nid('cev_'), host.id, c.id, uid, e.title, e.detail || null, e.location || null,
        e.starts_at, e.ends_at || null, e.all_day ? 1 : 0, e.tz || null,
        e.repeats ? 1 : 0, importId, now()).run();
      added += 1;
    } catch (err) {
      // The unique index on (client_id, uid) doing its job under a race. Not
      // an error worth showing anybody.
      if (!String(err?.message || '').includes('UNIQUE')) throw err;
      updated += 1;
    }
  }

  return J({
    ok: true,
    import_id: importId,
    added,
    updated,
    skipped,
    says: [
      added ? `${added} added` : null,
      updated ? `${updated} already there and brought up to date` : null,
      skipped ? `${skipped} we could not read` : null,
    ].filter(Boolean).join(', ') + '.',
  });
}
