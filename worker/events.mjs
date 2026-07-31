// Events, RSVP-by-text, and the host dashboard.
//
// The design constraint that shapes everything: **the guest must not need the
// app.** They get one text with one link; that link is a real page that says
// where, when, what to wear, and has two big buttons. No download, no account,
// no login. That is why RSVP lives on a server-rendered page rather than in
// the SPA, and why the RSVP token is the identity — it arrived on their phone,
// which is the same proof an invite link gives us everywhere else in Num.
//
// The host side is the dashboard an event site would give you: who's coming,
// who hasn't answered, plus-ones, and a one-tap chase for the silent ones —
// again sent from the host's own phone rather than from an unknown shortcode.
//
// ── The second path: agent to agent ──────────────────────────────────────
//
// Everything above assumes the guest is a stranger holding a phone. When the
// guest is already on Num, the text is the wrong shape entirely: their agent
// is right there, and it can simply be asked. So an invite addressed to a
// member id is DELIVERED rather than handed to a share sheet — it lands in
// their inbox, buzzes their phone, and their Num puts the question to them in
// their own thread. Nobody copies a link, nobody leaves the app, and the
// answer comes back down the same channel to the host's Num.
//
// That channel needs a door, because unlike a text it does not go out through
// the sender's own phone. `worker/permissions.mjs` is the door: the recipient
// decides whether their Num takes invites from friends only, from anyone, or
// from nobody. Delivery here is the thing that is automatic — never consent.
import { uid, normalisePhone, maskPhone } from '../claim/verify.mjs';
import { notify } from './push.mjs';
import { canInvite, ensurePermissions } from './permissions.mjs';
// One-way: dm.mjs knows nothing about events. The invite rides the messaging
// thread so the question can be answered where it was asked.
import { postDm } from './dm.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
function token(n = 10) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_events (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, business_id TEXT, title TEXT NOT NULL, day TEXT, time TEXT, place TEXT, address TEXT, dress TEXT, note TEXT, capacity INTEGER, plan_id TEXT, slug TEXT UNIQUE, state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_num_events_host ON num_events(host_id);
CREATE TABLE IF NOT EXISTS num_event_guests (token TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT, phone TEXT, member_id TEXT, rsvp TEXT NOT NULL DEFAULT 'pending', plus_ones INTEGER NOT NULL DEFAULT 0, message TEXT, invited_at TEXT NOT NULL DEFAULT (datetime('now')), opened_at TEXT, replied_at TEXT);
CREATE INDEX IF NOT EXISTS idx_num_event_guests_event ON num_event_guests(event_id, rsvp);
CREATE INDEX IF NOT EXISTS idx_num_event_guests_member ON num_event_guests(member_id, rsvp);
`;

// CREATE TABLE IF NOT EXISTS silently skips a table that already exists with
// an older shape, so anything added after the first deploy has to arrive as an
// ALTER. "duplicate column" is the expected outcome from the second deploy on.
const MIGRATIONS = [
  // Who sent it. Needed for the reply ("Dre's Num says yes"), for the per-pair
  // nag cap, and to tell an agent invite from a link the host texted out.
  'ALTER TABLE num_event_guests ADD COLUMN invited_by TEXT',
  // 'link' — a token the guest opens in a browser, no app needed.
  // 'agent' — delivered into another member's Num.
  "ALTER TABLE num_event_guests ADD COLUMN via TEXT NOT NULL DEFAULT 'link'",
  // When their Num was actually told, as opposed to when the row was written.
  'ALTER TABLE num_event_guests ADD COLUMN delivered_at TEXT',
];

let ensured = false;
async function ensure(env) {
  if (ensured) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  for (const alter of MIGRATIONS) {
    try {
      await env.DB.prepare(alter).run();
    } catch (err) {
      if (!/duplicate column/i.test(err?.message ?? '')) console.warn('[events] migration:', err?.message);
    }
  }
  // An agent invite is checked against the recipient's invite policy, which
  // lives on num_members — so that column has to exist before the first one
  // is sent, whichever Worker surface got hit first.
  await ensurePermissions(env);
  ensured = true;
}

const when = (e) =>
  [e.day ? new Date(e.day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : null, e.time]
    .filter(Boolean)
    .join(' · ');

// ── host side ─────────────────────────────────────────────────────────────

async function createEvent(env, req, origin) {
  const b = await readBody(req);
  const hostId = clip(b.host_id ?? b.me, 40);
  if (!hostId) return json({ error: 'host_id required' }, 400);
  const host = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(hostId).first();
  if (!host) return json({ error: 'sign up first' }, 404);

  const id = uid('evt');
  const slug = token(8);
  await env.DB.prepare(
    `INSERT INTO num_events (id, host_id, business_id, title, day, time, place, address, dress, note, capacity, plan_id, slug)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
  ).bind(
    id, hostId, clip(b.business_id, 40), clip(b.title, 120) || 'Our event', clip(b.day, 20), clip(b.time, 10),
    clip(b.place, 120), clip(b.address, 200), clip(b.dress, 80), clip(b.note, 600),
    b.capacity == null ? null : Number(b.capacity) || null, clip(b.plan_id, 40), slug,
  ).run();

  const event = await env.DB.prepare('SELECT * FROM num_events WHERE id=?1').bind(id).first();

  // "Dinner Friday with Dre and Sam" is one instruction, not two. Anyone named
  // in `ask` who is on Num is asked here, in the same call that made the event
  // — that is the whole agent-to-agent feature, and splitting it into a second
  // round trip is how a host ends up with an event nobody was told about.
  //
  // Anyone we cannot identify still comes back as a link for the host to send,
  // and anyone whose name matched two friends comes back as a question. Both
  // are the caller's to finish; neither blocks the event from existing.
  const ask = Array.isArray(b.ask) ? b.ask : Array.isArray(b.guests) ? b.guests : [];
  const dispatched = ask.length
    ? await dispatchInvites(env, {
        event,
        meId: hostId,
        // A bare string is the shape the model produces when it just heard a
        // name; an object is what the app sends once someone has been picked.
        guests: ask.map((g) => (typeof g === 'string' ? { name: g } : g)),
        origin,
        ua: req.headers.get('User-Agent') ?? '',
      })
    : null;

  return json({ event, url: `${origin}/e/${slug}`, ...(dispatched ?? {}) });
}

async function updateEvent(env, req) {
  const b = await readBody(req);
  const e = await env.DB.prepare('SELECT * FROM num_events WHERE id=?1').bind(clip(b.id, 40) ?? '').first();
  if (!e) return json({ error: 'unknown event' }, 404);
  if (e.host_id !== clip(b.me, 40)) return json({ error: 'not your event' }, 403);
  await env.DB.prepare(
    `UPDATE num_events SET title=COALESCE(?2,title), day=COALESCE(?3,day), time=COALESCE(?4,time), place=COALESCE(?5,place),
            address=COALESCE(?6,address), dress=COALESCE(?7,dress), note=COALESCE(?8,note), state=COALESCE(?9,state),
            updated_at=datetime('now') WHERE id=?1`,
  ).bind(e.id, clip(b.title, 120), clip(b.day, 20), clip(b.time, 10), clip(b.place, 120), clip(b.address, 200),
    clip(b.dress, 80), clip(b.note, 600), clip(b.state, 20)).run();
  return json({ event: await env.DB.prepare('SELECT * FROM num_events WHERE id=?1').bind(e.id).first() });
}

// ── who is this actually for ──────────────────────────────────────────────

/** Everyone this member is connected to, as people rather than link rows. */
async function friendsOf(env, meId) {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.name, m.avatar FROM num_links l
       JOIN num_members m ON m.id = CASE WHEN l.a_id=?1 THEN l.b_id ELSE l.a_id END
      WHERE l.state='active' AND (l.a_id=?1 OR l.b_id=?1)`,
  ).bind(meId).all().catch(() => ({ results: [] }));
  // One person can be reached through two links (they invited you, you later
  // scanned their code). Two identical rows in a candidate list reads as two
  // different people and makes an unambiguous match look ambiguous.
  const seen = new Map();
  for (const r of results ?? []) if (r.id && !seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

const fold = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Turn "invite Dre" into a member id — or into a question.
 *
 * The automatic part of this feature is DELIVERY, never the guess about who
 * was meant. A name that matches exactly one friend is unambiguous and routes
 * straight through; a name that matches several comes back as candidates for
 * the user to pick from, which is the same rule the connection invite sheet
 * has always followed. Sending a dinner invitation to the wrong Sam is not an
 * error you can take back.
 *
 * A name that matches nobody is not a failure either — it is a guest who is
 * not on Num, and they get the link path they have always had.
 */
async function resolveInvitee(env, meId, g) {
  const memberId = clip(g.member_id, 40);
  // A number passed alongside an id is carried through, because it is one the
  // CALLER already had — which is what makes the text fallback legitimate when
  // that member's Num declines. It is never read off the member's account.
  if (memberId) return { kind: 'member', member_id: memberId, name: clip(g.name, 60), phone: normalisePhone(g.phone) ?? null };

  const phone = normalisePhone(g.phone);
  if (phone) {
    // A number that belongs to a member is a member, whatever the caller
    // thought they were doing. Texting a link to someone whose Num is sitting
    // right there is the worse of the two experiences.
    const row = await env.DB.prepare('SELECT id, name FROM num_members WHERE phone=?1').bind(phone).first().catch(() => null);
    if (row) return { kind: 'member', member_id: row.id, name: clip(g.name, 60) ?? row.name, phone };
    return { kind: 'link', name: clip(g.name, 60), phone };
  }

  const name = clip(g.name, 60);
  if (!name) return { kind: 'invalid' };

  const friends = await friendsOf(env, meId);
  const q = fold(name);
  // Narrowest match first. An exact name beats a prefix beats a substring, so
  // "Sam" does not become ambiguous just because "Samira" is also a friend.
  const exact = friends.filter((f) => fold(f.name) === q);
  const starts = exact.length ? exact : friends.filter((f) => fold(f.name).startsWith(q));
  const hits = starts.length ? starts : friends.filter((f) => fold(f.name).includes(q));

  if (hits.length === 1) return { kind: 'member', member_id: hits[0].id, name: hits[0].name };
  if (hits.length > 1) return { kind: 'ambiguous', name, candidates: hits.map((f) => ({ id: f.id, name: f.name, avatar: f.avatar })) };
  return { kind: 'link', name };
}

// ── inviting ──────────────────────────────────────────────────────────────

/**
 * Invite people. Two paths out of one endpoint, chosen by who the guest is.
 *
 *   · Not on Num → a token and a message the HOST sends from their own phone.
 *     Unchanged, and still the default for anyone we cannot identify.
 *   · On Num → delivered straight into their Num, subject to their invite
 *     policy. Their agent asks them; the answer comes back here.
 *
 * The reply keeps the two apart — `invites` is what the host still has to send,
 * `asked` is what has already gone — because those are two different sentences
 * for the host's agent to say, and conflating them is how a host thinks they
 * have told six people when they have told three. On the dashboard afterwards
 * it is one guest list either way, which is the point.
 */
async function inviteGuest(env, req, origin) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const e = await env.DB.prepare('SELECT * FROM num_events WHERE id=?1').bind(clip(b.event_id, 40) ?? '').first();
  if (!e) return json({ error: 'unknown event' }, 404);
  if (e.host_id !== meId) return json({ error: 'not your event' }, 403);

  const guests = Array.isArray(b.guests) ? b.guests : [{ name: b.name, phone: b.phone, member_id: b.member_id }];
  return json(await dispatchInvites(env, { event: e, meId, guests, origin, ua: req.headers.get('User-Agent') ?? '' }));
}

/**
 * The guest list, turned into whatever each guest needs.
 *
 * Shared by `/invite` and by event creation, because "make the event" and
 * "ask the people" are one intention — a host who says "dinner Friday with Dre
 * and Sam" has not asked for an event object, they have asked for their two
 * friends to be asked.
 */
async function dispatchInvites(env, { event: e, meId, guests, origin, ua = '' }) {
  const host = await env.DB.prepare('SELECT name FROM num_members WHERE id=?1').bind(e.host_id).first();
  const hostName = host?.name ?? 'A friend';
  guests = (Array.isArray(guests) ? guests : []).slice(0, 50);

  const out = [];
  const asked = [];
  const blocked = [];
  const ambiguous = [];

  for (const g of guests) {
    const who = await resolveInvitee(env, meId, g ?? {});
    if (who.kind === 'invalid') continue;
    if (who.kind === 'ambiguous') {
      ambiguous.push(who);
      continue;
    }

    let fallback = null;
    if (who.kind === 'member') {
      const delivered = await deliverToAgent(env, { event: e, hostId: meId, hostName, to: who });
      if (delivered.ok) {
        asked.push(delivered.invite);
        continue;
      }
      // Refused — but a refusal on the AGENT channel is not a ban on the host.
      //
      // If the caller supplied the number themselves, the host already had it
      // and could always have texted this person; a policy about whose Num may
      // be interrupted must not quietly take that away, or the feature makes
      // the app worse at the thing it could already do. So it falls back to
      // the link path: the host sends it from their own phone, same as before
      // any of this existed.
      //
      // Only a phone the CALLER passed in. The number on a member's account is
      // never handed back to a host who did not already know it — that would
      // turn "invite by member id" into a phone-number lookup.
      if (!who.phone) {
        blocked.push(delivered.blocked);
        continue;
      }
      fallback = delivered.blocked;
    }

    // ── the link path, unchanged ──
    const t = token();
    const name = who.name;
    const phone = who.phone ?? null;
    await env.DB.prepare(
      "INSERT INTO num_event_guests (token, event_id, name, phone, invited_by, via) VALUES (?1,?2,?3,?4,?5,'link')",
    ).bind(t, e.id, name, phone, meId).run();
    const url = `${origin}/e/${e.slug}?g=${t}`;
    const message =
      `${name ? name + ' — ' : ''}${hostName} is having ${e.title}` +
      `${when(e) ? `, ${when(e)}` : ''}${e.place ? ` at ${e.place}` : ''}. RSVP here (one tap, no app): ${url}`;
    out.push({
      token: t,
      name,
      via: 'link',
      url,
      message,
      sms_url: `sms:${phone ?? ''}${/iphone|ipad|mac/i.test(ua) ? '&' : '?'}body=${encodeURIComponent(message)}`,
      whatsapp_url: `https://wa.me/${phone ? phone.replace(/\D/g, '') : ''}?text=${encodeURIComponent(message)}`,
      share: { title: e.title, text: message, url },
      // Set when their Num would not take it and this is the way round. The
      // host's agent needs it to say the true thing — "her Num only takes
      // invites from people she's connected to, so text her instead" — rather
      // than presenting a text as the plan all along.
      ...(fallback ? { fell_back: { reason: fallback.reason, message: fallback.message } } : {}),
    });
  }

  return {
    // `invites` keeps its old meaning — things the host still has to send —
    // so a caller written before agent delivery existed behaves identically.
    invites: out,
    // Things that have ALREADY gone. Nothing for the host to do.
    asked,
    blocked,
    ambiguous,
    summary: { sent: asked.length, to_send: out.length, blocked: blocked.length, needs_confirming: ambiguous.length },
  };
}

/**
 * Put the question to another member's Num.
 *
 * Idempotent per (event, member): asking twice does not produce two rows or
 * two buzzes, it returns the ask already in flight. A host tapping "invite"
 * again because they were not sure it worked is the most likely second call
 * this will ever get, and it must not read as pestering on the other side.
 */
async function deliverToAgent(env, { event: e, hostId, hostName, to }) {
  const gate = await canInvite(env, hostId, to.member_id);
  if (!gate.ok) {
    return {
      ok: false,
      blocked: { member_id: to.member_id, name: to.name ?? gate.to?.name ?? null, reason: gate.reason, message: gate.message, remedy: gate.remedy ?? null },
    };
  }

  const already = await env.DB.prepare('SELECT * FROM num_event_guests WHERE event_id=?1 AND member_id=?2')
    .bind(e.id, to.member_id).first();
  if (already) {
    return {
      ok: true,
      invite: { token: already.token, member_id: to.member_id, name: already.name, via: 'agent', delivered: true, already: true, rsvp: already.rsvp },
    };
  }

  const t = token();
  const name = to.name ?? gate.to?.name ?? null;
  await env.DB.prepare(
    `INSERT INTO num_event_guests (token, event_id, name, phone, member_id, invited_by, via, delivered_at)
     VALUES (?1,?2,?3,?4,?5,?6,'agent',datetime('now'))`,
  ).bind(t, e.id, name, to.phone ?? null, to.member_id, hostId).run();

  // Put the question INTO the conversation with the host, as a card carrying
  // the guest's own token. That is what makes it answerable where it landed:
  // the invite arrives in the thread you already have with that person, and
  // yes/no goes back without either side opening a dashboard.
  //
  // Only possible between connected members. An invite from someone whose
  // policy is 'public' but who is not a friend has no thread to land in, and
  // falls through to the plain notification below.
  const carded = await postDm(env, {
    from: hostId,
    to: to.member_id,
    body: `${askLine(e, hostName)} Want in?`,
    kind: 'event',
    ref: t,
    title: hostName,
  });

  // Their phone buzzes now; their Num asks them the moment they look. The
  // inbox row above is the durable half — push is best-effort by design, and
  // an invite that only exists as a notification is an invite that is lost the
  // first time a phone is face down.
  if (!carded) await notify(env, {
    memberId: to.member_id,
    kind: 'invite',
    title: e.title,
    body: askLine(e, hostName),
    url: '/?app',
    // One tag per event: a host who edits the time twice does not buzz you
    // three times about one dinner.
    tag: `event:${e.id}`,
  }).catch((err) => console.warn('[events] notify', err?.message ?? err));

  return {
    ok: true,
    invite: {
      token: t,
      member_id: to.member_id,
      name,
      via: 'agent',
      delivered: true,
      // The host's own agent says this back to them, so it reads as a thing
      // that happened rather than a thing they must now go and do.
      line: `Asked ${name || 'them'} — their Num will let you know.`,
      // Deliberately NO guest url. On the link path the url is the invite and
      // the host has to send it; here the host is not the courier, and handing
      // them a link that answers on the guest's behalf would let a host RSVP
      // "yes" for someone who never saw the question.
    },
  };
}

/** The question one Num puts to another. Written to be read out loud. */
function askLine(e, hostName) {
  const w = when(e);
  return `${hostName || 'A friend'} asked if you want to join ${e.title}${w ? ` — ${w}` : ''}${e.place ? ` at ${e.place}` : ''}.`;
}

/** The host dashboard payload: counts, the list, and who to chase. */
async function eventDashboard(env, url, origin) {
  const id = url.searchParams.get('id');
  const me = url.searchParams.get('me');
  const e = await env.DB.prepare('SELECT * FROM num_events WHERE id=?1 OR slug=?1').bind(id ?? '').first();
  if (!e) return json({ error: 'unknown event' }, 404);
  if (e.host_id !== me) return json({ error: 'not your event' }, 403);

  const { results: guests } = await env.DB.prepare(
    // `member_id` is here so the host's own invite picker can grey out the
    // friends it has already asked. It is only ever the host's guest list, and
    // they are the one who put every id on it.
    'SELECT token, name, phone, member_id, rsvp, plus_ones, message, via, opened_at, delivered_at, replied_at FROM num_event_guests WHERE event_id=?1 ORDER BY replied_at IS NULL, replied_at DESC',
  ).bind(e.id).all();

  const list = (guests ?? []).map((g) => ({ ...g, phone: maskPhone(g.phone) }));
  const count = (s) => list.filter((g) => g.rsvp === s).length;
  const heads = list.filter((g) => g.rsvp === 'yes').reduce((n, g) => n + 1 + (g.plus_ones || 0), 0);

  return json({
    event: e,
    url: `${origin}/e/${e.slug}`,
    guests: list,
    summary: {
      invited: list.length,
      yes: count('yes'),
      no: count('no'),
      maybe: count('maybe'),
      pending: count('pending'),
      opened: list.filter((g) => g.opened_at).length,
      heads,
      capacity: e.capacity,
      // The number a host actually wants: who got the text and never answered.
      silent: list.filter((g) => g.rsvp === 'pending' && g.opened_at).length,
      // How the guest list was actually reached. `to_send` is the only number
      // here that is a to-do: those are the links still sitting in the host's
      // share sheet, unsent.
      asked: list.filter((g) => g.via === 'agent').length,
      to_send: list.filter((g) => g.via !== 'agent' && !g.opened_at && g.rsvp === 'pending').length,
    },
  });
}

async function listEvents(env, url, origin) {
  const me = url.searchParams.get('me');
  if (!me) return json({ error: 'me required' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM num_event_guests g WHERE g.event_id=e.id) invited,
            (SELECT COUNT(*) FROM num_event_guests g WHERE g.event_id=e.id AND g.rsvp='yes') yes
       FROM num_events e WHERE e.host_id=?1 ORDER BY e.created_at DESC LIMIT 25`,
  ).bind(me).all();
  return json({ events: (results ?? []).map((e) => ({ ...e, url: `${origin}/e/${e.slug}` })) });
}

// ── guest side: no app, no account ────────────────────────────────────────

async function rsvp(env, req) {
  const b = await readBody(req);
  const g = await env.DB.prepare('SELECT * FROM num_event_guests WHERE token=?1').bind(clip(b.token, 40) ?? '').first();
  if (!g) return json({ error: 'unknown invite' }, 404);

  // An agent invite is answered by the person it was put to, in their own Num.
  // The token exists for the web page, and on this path the token is the ONLY
  // credential — so honouring it here would let anyone holding the token
  // (starting with the host, who created it) answer on the member's behalf.
  if (g.via === 'agent' && g.member_id) {
    return json({ error: 'That one is waiting in your Num — answer it there.', answer_in_app: true }, 403);
  }

  const out = await answerEventInvite(env, {
    guest: g,
    rsvp: b.rsvp,
    plusOnes: b.plus_ones,
    name: clip(b.name, 60),
    message: clip(b.message, 300),
  });
  return out.error ? json({ error: out.error }, out.status ?? 400) : json({ ok: true, rsvp: out.rsvp });
}

// ── the answer coming back ────────────────────────────────────────────────

/**
 * One implementation of "they answered", whichever door it came through — the
 * public RSVP page, the app inbox, or the member's own Num acting on a spoken
 * "yes, put me down for that".
 *
 * The half that makes it agent-to-agent rather than a form submission is what
 * happens AFTER the row is updated: the host's Num is told, and if the event
 * belongs to a group plan the answer is narrated into that plan's feed, where
 * every other member's Num picks it up on its next sync. One person says yes
 * out loud and five agents know.
 */
export async function answerEventInvite(env, { guest, rsvp: answer, plusOnes, name, message, memberId }) {
  const rsvpValue = ['yes', 'no', 'maybe'].includes(answer) ? answer : null;
  if (!rsvpValue) return { error: 'rsvp must be yes, no or maybe', status: 400 };

  const e = await env.DB.prepare('SELECT * FROM num_events WHERE id=?1').bind(guest.event_id).first();
  if (!e) return { error: 'unknown event', status: 404 };

  await env.DB.prepare(
    `UPDATE num_event_guests SET rsvp=?2, plus_ones=?3, name=COALESCE(?4,name),
            message=COALESCE(?5,message), member_id=COALESCE(?6,member_id), replied_at=datetime('now')
      WHERE token=?1`,
  ).bind(guest.token, rsvpValue, Math.max(0, Math.min(10, Number(plusOnes) || 0)), name ?? null, message ?? null, memberId ?? null).run();

  const who = name || guest.name || 'Someone';
  const extra = Math.max(0, Math.min(10, Number(plusOnes) || 0));
  const line =
    rsvpValue === 'yes'
      ? `${who} is in${extra ? ` — bringing ${extra}` : ''}.`
      : rsvpValue === 'no'
        ? `${who} can’t make it.`
        : `${who} is a maybe.`;

  // The answer goes back where the question came from. A guest who was asked
  // in a conversation and answers in a dashboard has left the conversation
  // half-finished — the host sees "Dre is in" under the invite card they sent,
  // in the same thread, which is what makes it feel like two people talking
  // rather than two people filing forms.
  const joiner = memberId ?? guest.member_id ?? null;
  const answered = joiner
    ? await postDm(env, {
        from: joiner,
        to: e.host_id,
        body: `${line}${message ? ` “${message}”` : ''}`,
        title: who,
      })
    : null;

  // The host hears it on their phone. A host who has to keep reopening a
  // dashboard to find out whether anyone is coming does not have an agent.
  // Skipped when the answer already went as a message — that push has fired.
  if (!answered) await notify(env, {
    memberId: e.host_id,
    kind: 'rsvp',
    title: e.title,
    body: `${line}${message ? ` “${message}”` : ''}`,
    url: '/?app',
    tag: `event:${e.id}`,
  }).catch((err) => console.warn('[events] host notify', err?.message ?? err));

  // Tied to a group plan? Then it is everyone's news, not just the host's.
  if (e.plan_id) {
    // Saying yes is this member's half of consent, so they join the plan they
    // just agreed to be part of — the same rule an accepted connection invite
    // follows. Saying no or maybe joins nothing.
    if (rsvpValue === 'yes' && joiner) {
      await env.DB.prepare('INSERT OR IGNORE INTO num_plan_members (plan_id, member_id, name) VALUES (?1,?2,?3)')
        .bind(e.plan_id, joiner, who).run().catch(() => {});
    }
    await narrateToPlan(env, e.plan_id, { id: joiner, name: who }, 'rsvp', `${line} — ${e.title}`).catch(() => {});
  }

  return { ok: true, rsvp: rsvpValue, line, event: { id: e.id, title: e.title, plan_id: e.plan_id ?? null } };
}

/**
 * Append to a plan's feed and buzz the other members.
 *
 * Deliberately a local copy of what social.mjs's `event()` does rather than an
 * import of it: social.mjs already imports the reply path from this file, and
 * a two-way import between the two busiest modules in the Worker is a cycle
 * waiting to bite on the next bundler change. Twelve lines is the cheaper
 * side of that trade.
 */
async function narrateToPlan(env, planId, by, kind, summary) {
  await env.DB.prepare(
    'INSERT INTO num_plan_events (plan_id, by_id, by_name, kind, summary) VALUES (?1,?2,?3,?4,?5)',
  ).bind(planId, by?.id ?? null, by?.name ?? null, kind, summary.slice(0, 300)).run();
  await env.DB.prepare("UPDATE num_plans SET updated_at=datetime('now') WHERE id=?1").bind(planId).run();

  const plan = await env.DB.prepare('SELECT title FROM num_plans WHERE id=?1').bind(planId).first();
  const { results: members } = await env.DB.prepare(
    'SELECT member_id FROM num_plan_members WHERE plan_id=?1 AND member_id <> ?2',
  ).bind(planId, by?.id ?? '').all();
  await Promise.all(
    (members ?? []).map((m) =>
      notify(env, { memberId: m.member_id, kind: 'plan', title: plan?.title ?? 'Your plan', body: summary, url: '/?app', tag: `plan:${planId}` }),
    ),
  );
}

/**
 * Everything one member's Num has been asked to join, with the question
 * already phrased. This is what the agent reads out; the app's own inbox
 * (`/api/social/requests`) shows the same rows as cards.
 *
 * Matched on member id OR on the phone the invite was addressed to — so
 * someone invited by number before they had ever opened Num finds the question
 * waiting the moment they sign up, with nothing to click.
 */
async function pendingInvites(env, url) {
  const meId = clip(url.searchParams.get('me'), 40);
  if (!meId) return json({ error: 'me required' }, 400);
  const me = await env.DB.prepare('SELECT id, phone FROM num_members WHERE id=?1').bind(meId).first();
  if (!me) return json({ invites: [] });

  const { results } = await env.DB.prepare(
    `SELECT g.token, g.rsvp, g.via, g.name AS guest_name, g.invited_at,
            e.id AS event_id, e.title, e.day, e.time, e.place, e.address, e.dress, e.note, e.plan_id,
            h.id AS host_id, h.name AS host_name, h.avatar AS host_avatar
       FROM num_event_guests g
       JOIN num_events e ON e.id = g.event_id
       LEFT JOIN num_members h ON h.id = e.host_id
      WHERE g.rsvp='pending' AND e.state='open'
        AND (g.member_id = ?1 OR (?2 IS NOT NULL AND g.phone = ?2))
      ORDER BY g.invited_at DESC LIMIT 20`,
  ).bind(meId, me.phone ?? null).all();

  return json({
    invites: (results ?? []).map((r) => ({
      token: r.token,
      event_id: r.event_id,
      via: r.via ?? 'link',
      title: r.title,
      day: r.day,
      time: r.time,
      place: r.place,
      address: r.address,
      dress: r.dress,
      note: r.note,
      plan_id: r.plan_id,
      host: { id: r.host_id, name: r.host_name, avatar: r.host_avatar },
      invited_at: r.invited_at,
      // The line the recipient's Num says. Phrased as a question because that
      // is what it is — nothing has been put in their calendar.
      ask: `${askLine({ title: r.title, day: r.day, time: r.time, place: r.place }, r.host_name)} Want in?`,
    })),
  });
}

/**
 * The member's own answer, from inside their Num.
 *
 * Ownership is checked rather than assumed: the invite must name this member,
 * or have been addressed to their verified-or-not number. Without that check
 * any member holding a token could answer for the person it was sent to —
 * which on the agent path includes the host who minted it.
 */
async function replyToInvite(env, req) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const tok = clip(b.token, 40);
  if (!meId || !tok) return json({ error: 'me and token are required' }, 400);

  const me = await env.DB.prepare('SELECT id, name, phone FROM num_members WHERE id=?1').bind(meId).first();
  if (!me) return json({ error: 'sign up first' }, 404);
  const g = await env.DB.prepare('SELECT * FROM num_event_guests WHERE token=?1').bind(tok).first();
  if (!g) return json({ error: 'unknown invite' }, 404);

  const mine = (g.member_id && g.member_id === meId) || (g.phone && me.phone && g.phone === me.phone);
  if (!mine) return json({ error: 'not your invite' }, 403);

  const out = await answerEventInvite(env, {
    guest: g,
    rsvp: b.rsvp,
    plusOnes: b.plus_ones,
    name: g.name ?? me.name,
    message: clip(b.message, 300),
    memberId: meId,
  });
  return out.error ? json({ error: out.error }, out.status ?? 400) : json(out);
}

/**
 * The page the guest actually sees. Server-rendered and self-contained: it has
 * to work on a five-year-old phone, over hotel wifi, from a text message.
 */
async function eventPage(env, slug, url, origin) {
  const e = await env.DB.prepare('SELECT * FROM num_events WHERE slug=?1').bind(slug).first();
  if (!e) return html('<p style="font:16px system-ui;padding:40px">That invite link isn’t valid any more.</p>', 404);

  const gt = url.searchParams.get('g');
  let guest = null;
  if (gt) {
    guest = await env.DB.prepare('SELECT * FROM num_event_guests WHERE token=?1 AND event_id=?2').bind(gt, e.id).first();
    if (guest) {
      await env.DB.prepare("UPDATE num_event_guests SET opened_at=COALESCE(opened_at, datetime('now')) WHERE token=?1").bind(gt).run();
    }
  }
  const host = await env.DB.prepare('SELECT name FROM num_members WHERE id=?1').bind(e.host_id).first();
  const going = await env.DB.prepare("SELECT COUNT(*) n FROM num_event_guests WHERE event_id=?1 AND rsvp='yes'").bind(e.id).first();

  const row = (k, v) => (v ? `<div class="row"><span>${esc(k)}</span><b>${esc(v)}</b></div>` : '');
  const mapQ = encodeURIComponent([e.place, e.address].filter(Boolean).join(', '));

  return html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(e.title)}</title>
<style>
:root{--ink:#201e1d;--accent:#ec3013;--paper:#faf7f4}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background-image:radial-gradient(60% 40% at 20% 0%,#ffe9e2 0%,transparent 60%),radial-gradient(50% 40% at 90% 10%,#ffe2d3 0%,transparent 55%)}
.wrap{max-width:520px;margin:0 auto;padding:28px 20px 60px}
.kicker{font-size:11px;letter-spacing:.16em;font-weight:800;color:var(--accent)}
h1{font-size:30px;line-height:1.12;margin:10px 0 4px;letter-spacing:-.02em}
.sub{color:#6b625d;font-size:14px}
.card{margin-top:22px;background:rgba(255,255,255,.72);border:1px solid rgba(32,30,29,.08);border-radius:20px;padding:18px;
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 10px 30px rgba(32,30,29,.07)}
.row{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid rgba(32,30,29,.07);font-size:14px}
.row:last-child{border-bottom:0}.row span{color:#6b625d}.row b{text-align:right;font-weight:600}
.btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:16px}
button{font:inherit;font-weight:700;font-size:13px;letter-spacing:.04em;padding:14px 8px;border-radius:999px;border:1px solid rgba(32,30,29,.12);
  background:rgba(255,255,255,.8);color:var(--ink);cursor:pointer;-webkit-tap-highlight-color:transparent}
button.yes{background:linear-gradient(135deg,#ff6a3d,#ec3013);color:#fff;border-color:transparent;box-shadow:0 6px 18px rgba(236,48,19,.28)}
button[aria-pressed="true"]{outline:2px solid var(--accent);outline-offset:2px}
input,textarea{font:inherit;width:100%;margin-top:10px;padding:12px 14px;border-radius:14px;border:1px solid rgba(32,30,29,.12);background:rgba(255,255,255,.8)}
a.map{display:block;margin-top:12px;text-align:center;text-decoration:none;color:var(--accent);font-weight:700;font-size:13px}
.ok{margin-top:16px;padding:14px;border-radius:14px;background:rgba(22,140,90,.12);color:#0e6b45;font-size:14px;font-weight:600;display:none}
.foot{margin-top:26px;text-align:center;font-size:12px;color:#8b817b}
.foot a{color:#8b817b}
</style></head><body><div class="wrap">
<div class="kicker">${esc(host?.name ? host.name.toUpperCase() + ' INVITES YOU' : 'YOU’RE INVITED')}</div>
<h1>${esc(e.title)}</h1>
<div class="sub">${esc(when(e) || 'Date to come')}${going?.n ? ` · ${going.n} going` : ''}</div>
<div class="card">
  ${row('When', when(e))}
  ${row('Where', e.place)}
  ${row('Address', e.address)}
  ${row('Dress', e.dress)}
  ${e.note ? `<div style="padding-top:12px;font-size:14px">${esc(e.note)}</div>` : ''}
  ${mapQ ? `<a class="map" href="https://maps.google.com/?q=${mapQ}" target="_blank" rel="noreferrer">Open in Maps →</a>` : ''}
</div>
${
  guest
    ? `<div class="card">
  <div class="kicker" style="color:#6b625d">${esc(guest.name ? guest.name + ' — can you make it?' : 'Can you make it?')}</div>
  <div class="btns">
    <button class="yes" data-r="yes" aria-pressed="${guest.rsvp === 'yes'}">YES</button>
    <button data-r="maybe" aria-pressed="${guest.rsvp === 'maybe'}">MAYBE</button>
    <button data-r="no" aria-pressed="${guest.rsvp === 'no'}">CAN’T</button>
  </div>
  <input id="plus" type="number" min="0" max="10" placeholder="Bringing anyone? (number)" value="${guest.plus_ones || ''}">
  <textarea id="msg" rows="2" placeholder="Anything to pass on (optional)">${esc(guest.message ?? '')}</textarea>
  <div class="ok" id="ok"></div>
</div>
<script>
const t=${JSON.stringify(gt)};
document.querySelectorAll('button[data-r]').forEach(b=>b.addEventListener('click',async()=>{
  document.querySelectorAll('button[data-r]').forEach(x=>x.setAttribute('aria-pressed','false'));
  b.setAttribute('aria-pressed','true');
  const r=await fetch('/api/events/rsvp',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:t,rsvp:b.dataset.r,plus_ones:document.getElementById('plus').value,message:document.getElementById('msg').value})});
  const ok=document.getElementById('ok');
  ok.style.display='block';
  ok.textContent=r.ok?({yes:'You’re on the list. See you there.',maybe:'Noted — we’ll keep a spot warm.',no:'Thanks for letting us know.'})[b.dataset.r]:'That didn’t save — try once more.';
}));
</script>`
    : `<div class="card"><div style="font-size:14px;color:#6b625d">This is the public page for the event. Ask ${esc(host?.name ?? 'the host')} for your own invite link to RSVP.</div></div>`
}
<div class="foot">Handled by <a href="${origin}">Num</a> — your concierge.</div>
</div></body></html>`);
}

// ── router ────────────────────────────────────────────────────────────────

export async function handleEvents(request, env, path, origin) {
  if (!env.DB) return json({ error: 'events need the database binding' }, 503);
  await ensure(env);
  const url = new URL(request.url);
  const post = request.method === 'POST';
  try {
    if (path === '/create' && post) return await createEvent(env, request, origin);
    if (path === '/update' && post) return await updateEvent(env, request);
    if (path === '/invite' && post) return await inviteGuest(env, request, origin);
    if (path === '/rsvp' && post) return await rsvp(env, request);
    // The agent-to-agent pair: what my Num has been asked, and my answer.
    if (path === '/invites') return await pendingInvites(env, url);
    if (path === '/reply' && post) return await replyToInvite(env, request);
    if (path === '/dashboard') return await eventDashboard(env, url, origin);
    if (path === '/list') return await listEvents(env, url, origin);
    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[events]', path, err?.message ?? err);
    return json({ error: 'that didn’t go through — try again in a moment' }, 500);
  }
}

/** GET /e/:slug — the guest page. Public by design. */
export async function handleEventPage(request, env, slug, origin) {
  if (!env.DB) return html('<p>Unavailable.</p>', 503);
  await ensure(env);
  try {
    return await eventPage(env, slug, new URL(request.url), origin);
  } catch (err) {
    console.error('[event-page]', err?.message ?? err);
    return html('<p style="font:16px system-ui;padding:40px">Something went wrong loading this invite.</p>', 500);
  }
}
