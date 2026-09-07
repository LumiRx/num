/**
 * THE MEMBER'S CALENDAR — bookings, plans and events as .ics files.
 *
 * Until 4 Sep 2026 the only calendar output NUM had was the VIP host's feed
 * (growth/worker.js hostCalendar). A guest whose table was confirmed, whose
 * plan had a date, or whose friend's party had a time got a line in a chat
 * thread and nothing they could put where they actually look: their phone's
 * calendar. Every other concierge in the world ends a booking with "it's in
 * your diary". This is that.
 *
 * Three rules, all inherited from the host feed and kept on purpose:
 *
 *   1. READ-ONLY, PERMANENTLY. NUM publishes a file; the person's calendar
 *      imports it. NUM never asks for write access to anyone's calendar.
 *   2. A DATE WE CANNOT PARSE IS SKIPPED, NOT GUESSED. A dinner filed on the
 *      wrong evening is worse than a missing one, because people plan
 *      around it.
 *   3. TIMES ARE FLOATING (no Z, no TZID). A table at 19:30 in Bangkok is a
 *      19:30 wall-clock appointment wherever the phone happens to be set;
 *      RFC 5545 calls this "floating time" and it is exactly the semantics
 *      a traveller wants. The host feed uses UTC because a host's work is
 *      logged in ISO with an offset; a guest's booking is written as the
 *      venue's clock reads.
 *
 * Authorisation follows the app's existing convention: the member id is
 * the bearer (`?me=`, as /api/booking/mine and /api/events/list already do).
 * Event guests use the RSVP token they were sent. Every response is
 * private, no-store, noindex, no-referrer — an .ics URL is a bearer.
 */

const CRLF = '\r\n';

/** RFC 5545 §3.3.11 text escaping. */
export function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * RFC 5545 §3.1 folding at 75 octets. Folded on characters at 73 (not
 * octets) with a two-character margin, so a multibyte name never straddles
 * a fold — Outlook rejects a fold inside a UTF-8 sequence, Apple silently
 * drops the line.
 */
export function icsFold(line) {
  const out = [];
  let s = String(line);
  while (s.length > 73) { out.push(s.slice(0, 73)); s = ' ' + s.slice(73); }
  out.push(s);
  return out.join(CRLF);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})/;

/**
 * 'YYYY-MM-DD' + 'HH:MM' → 'YYYYMMDDTHHMM00' (floating local time), or
 * 'YYYYMMDD' (all-day) when there is no time, or null when the date is not
 * a date. Never guesses: '8 Aug', 'tonight' and '' all come back null.
 */
export function floating(day, time) {
  const d = DATE_RE.exec(String(day ?? '').trim());
  if (!d) return null;
  const [, y, m, dd] = d;
  const mo = Number(m), da = Number(dd);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const t = TIME_RE.exec(String(time ?? '').trim());
  if (!t) return { value: `${y}${m}${dd}`, allDay: true };
  const hh = Number(t[1]), mm = Number(t[2]);
  if (hh > 23 || mm > 59) return { value: `${y}${m}${dd}`, allDay: true };
  return { value: `${y}${m}${dd}T${String(hh).padStart(2, '0')}${t[2]}00`, allDay: false };
}

/** Add minutes to a floating 'YYYYMMDDTHHMMSS' stamp (or a day to an all-day one). */
export function plus(stamp, minutes) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/.exec(stamp);
  if (!m) return stamp;
  const allDay = m[4] === undefined;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], allDay ? 0 : +m[4], allDay ? 0 : +m[5], allDay ? 0 : +m[6]));
  d.setUTCMinutes(d.getUTCMinutes() + (allDay ? 1440 : minutes));
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  return allDay ? day : `${day}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

const nowStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * One VEVENT. `start`/`end` are floating stamps from floating(); an all-day
 * event uses DATE values and an exclusive DTEND the next day, per the RFC.
 */
export function vevent({ uid, start, end, allDay = false, summary, description, location, url, stamp }) {
  const lines = ['BEGIN:VEVENT', `UID:${uid}@itsnum.com`, `DTSTAMP:${stamp ?? nowStamp()}`];
  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${start}`);
    lines.push(`DTEND;VALUE=DATE:${end ?? plus(start, 0)}`);
  } else {
    lines.push(`DTSTART:${start}`);
    lines.push(`DTEND:${end ?? plus(start, 90)}`);
  }
  lines.push(icsFold(`SUMMARY:${icsEscape(summary || 'NUM')}`));
  if (description) lines.push(icsFold(`DESCRIPTION:${icsEscape(description)}`));
  if (location) lines.push(icsFold(`LOCATION:${icsEscape(location)}`));
  if (url) lines.push(icsFold(`URL:${icsEscape(url)}`));
  lines.push('END:VEVENT');
  return lines.join(CRLF);
}

export function calendar({ name, events }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NUM//concierge//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    icsFold(`X-WR-CALNAME:${icsEscape(name || 'NUM')}`),
    ...events,
    'END:VCALENDAR', '',
  ].join(CRLF);
}

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

function file(body, filename) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex',
      'referrer-policy': 'no-referrer',
    },
  });
}
const nope = (status, why) => new Response(JSON.stringify({ error: why }), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/* ------------------------------------------------------------ builders */

/** A confirmed table request → one event. null when there is nothing to file. */
export function bookingEvent(row) {
  if (!row || row.state !== 'confirmed') return null;
  const when = floating(row.on_date, row.at_time);
  if (!when) return null;
  const party = row.party_size ? `Table for ${row.party_size}` : 'Table';
  return vevent({
    uid: `booking-${row.id}`,
    start: when.value,
    allDay: when.allDay,
    summary: `${row.venue_name} — ${party.toLowerCase()}`,
    description: [
      `${party} at ${row.venue_name}, confirmed by the venue through NUM.`,
      row.note ? `Note: ${row.note}` : null,
      row.venue_phone ? `Venue: ${row.venue_phone}` : null,
    ].filter(Boolean).join('\n'),
    location: row.venue_name,
    stamp: isoStamp(row.answered_at) ?? undefined,
  });
}

/** A plan and its dated items → events. Undated items are left out, not guessed. */
export function planEvents(plan, items, origin) {
  const out = [];
  const stamp = isoStamp(plan?.updated_at) ?? undefined;
  const head = floating(plan?.starts_on, plan?.starts_time);
  if (head) {
    out.push(vevent({
      uid: `plan-${plan.id}`,
      start: head.value,
      allDay: head.allDay,
      summary: plan.title + (plan.dest ? ` · ${plan.dest}` : ''),
      description: `Your plan on NUM${plan.dest ? ` in ${plan.dest}` : ''} begins.`,
      url: origin ? `${origin}/?go=plan` : undefined,
      stamp,
    }));
  }
  for (const it of items ?? []) {
    if (!it || it.status === 'cancelled') continue;
    const when = floating(it.day, it.time);
    if (!when) continue;
    out.push(vevent({
      uid: `plan-item-${it.id}`,
      start: when.value,
      allDay: when.allDay,
      summary: it.title,
      description: [
        it.status && it.status !== 'idea' ? `Status: ${it.status}` : 'Still an idea — not booked.',
        it.cost ? `Cost: ${it.cost}` : null,
        it.note ?? null,
      ].filter(Boolean).join('\n'),
      location: [it.place, it.address].filter(Boolean).join(', ') || undefined,
      stamp: isoStamp(it.updated_at) ?? stamp,
    }));
  }
  return out;
}

/** A hosted event → one event, with the RSVP page as its URL. */
export function eventEvent(ev, origin) {
  if (!ev) return null;
  const when = floating(ev.day, ev.time);
  if (!when) return null;
  return vevent({
    uid: `event-${ev.id}`,
    start: when.value,
    allDay: when.allDay,
    summary: ev.title,
    description: [ev.note, ev.dress ? `Dress: ${ev.dress}` : null].filter(Boolean).join('\n') || undefined,
    location: [ev.place, ev.address].filter(Boolean).join(', ') || undefined,
    url: origin && ev.slug ? `${origin}/e/${ev.slug}` : undefined,
    stamp: isoStamp(ev.updated_at) ?? undefined,
  });
}

function isoStamp(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + (/[Zz]|[+-]\d{2}:?\d{2}$/.test(String(s)) ? '' : 'Z'));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const slug = (s) => String(s ?? 'num').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'num';

/* --------------------------------------------------------------- routes */

/**
 * GET /api/calendar/booking.ics?id=&me=
 * GET /api/calendar/plan.ics?id=&me=
 * GET /api/calendar/event.ics?token=        (a guest, with their RSVP token)
 * GET /api/calendar/event.ics?id=&me=       (the host)
 */
export async function handleCalendar(request, env, url) {
  if (request.method !== 'GET') return nope(405, 'GET only');
  const sub = url.pathname.replace(/^\/api\/calendar\/?/, '');
  const id = clip(url.searchParams.get('id'), 40);
  const me = clip(url.searchParams.get('me'), 40);
  const origin = env.APP_ORIGIN ?? 'https://app.itsnum.com';

  if (sub === 'booking.ics') {
    if (!id || !me) return nope(400, 'id and me required');
    const row = await env.DB.prepare(
      'SELECT id, member_id, venue_name, venue_phone, party_size, on_date, at_time, note, state, answered_at FROM num_booking_requests WHERE id=?1 AND member_id=?2',
    ).bind(id, me).first().catch(() => null);
    if (!row) return nope(404, 'not found');
    const ev = bookingEvent(row);
    if (!ev) return nope(409, row.state !== 'confirmed' ? 'not confirmed yet' : 'no date to file');
    return file(calendar({ name: 'NUM', events: [ev] }), `num-${slug(row.venue_name)}.ics`);
  }

  if (sub === 'plan.ics') {
    if (!id || !me) return nope(400, 'id and me required');
    const plan = await env.DB.prepare(
      `SELECT p.* FROM num_plans p
        WHERE p.id=?1 AND (p.owner_id=?2 OR EXISTS (SELECT 1 FROM num_plan_members m WHERE m.plan_id=p.id AND m.member_id=?2))`,
    ).bind(id, me).first().catch(() => null);
    if (!plan) return nope(404, 'not found');
    const { results } = await env.DB.prepare(
      'SELECT id, title, place, address, day, time, status, cost, note, updated_at FROM num_plan_items WHERE plan_id=?1 ORDER BY day, time LIMIT 200',
    ).bind(id).all().catch(() => ({ results: [] }));
    const events = planEvents(plan, results ?? [], origin);
    if (!events.length) return nope(409, 'nothing in this plan has a date yet');
    return file(calendar({ name: plan.title, events }), `num-${slug(plan.title)}.ics`);
  }

  if (sub === 'event.ics') {
    const token = clip(url.searchParams.get('token'), 80);
    let ev = null;
    if (token) {
      ev = await env.DB.prepare(
        'SELECT e.* FROM num_event_guests g JOIN num_events e ON e.id=g.event_id WHERE g.token=?1',
      ).bind(token).first().catch(() => null);
    } else if (id && me) {
      ev = await env.DB.prepare('SELECT * FROM num_events WHERE id=?1 AND host_id=?2').bind(id, me).first().catch(() => null);
    } else return nope(400, 'token, or id and me, required');
    if (!ev) return nope(404, 'not found');
    const one = eventEvent(ev, origin);
    if (!one) return nope(409, 'no date to file');
    return file(calendar({ name: ev.title, events: [one] }), `num-${slug(ev.title)}.ics`);
  }

  return nope(404, 'unknown calendar');
}
