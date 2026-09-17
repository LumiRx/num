/**
 * Flight Watch — NUM watches a flight and tells you only what changes your plans.
 *
 * ── WHAT THIS IS (17 Sep 2026) ────────────────────────────────────────────
 *
 * A member gives a flight number and a date. NUM looks it up on AeroDataBox,
 * keeps a row, and re-checks it on a cadence that tightens as departure
 * nears. When something changes that matters — a delay of 15 minutes or
 * more, a gate change, a cancellation, the landing — the member gets one
 * push, in the NUM voice, with a number in it. Everything else updates the
 * card quietly.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *
 *   · Times shown are the airline's, passed through as data. The model
 *     never restates them.
 *   · One lookup serves every watcher of that flight (num_flight_cache), and
 *     the cache is what the cron reads, so 20 members on TG917 cost one call.
 *   · Cadence, not polling: >24h out once a day; 24h–3h every 3h; the last
 *     3h every 20 min; in the air every 45 min, every 10 in the last 45;
 *     stop 30 min after arrival. The $5 Pro plan is 6,000 units a month.
 *   · At most one push per flight per 20 minutes; quiet 23:00–07:00 in the
 *     member's local time unless it changes the next three hours.
 *   · Never claims a driver, a hotel or a plan moved. Phase A watches and
 *     tells; re-timing the driver is phase B and needs the driver rail.
 *
 * Routes: POST /api/flightwatch {me, flight_no, date}  → the watch, looked up now
 *         GET  /api/flightwatch?me=…                    → active watches
 *         POST /api/flightwatch/stop {me, id}
 * Cron:   sweepFlights(env) from the 5-minute schedule.
 */

import { notify } from './push.mjs';

const API = 'https://aerodatabox.p.rapidapi.com';
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const flightWatchReady = (env) => !!env?.AERODATABOX_KEY;

/** "tg917", "TG 917", "tg-917" → "TG917". Null when it is not a flight number. */
export function normaliseFlightNo(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$/.test(s) ? s : null;
}

/** Only the fields the card and the diff need, from AeroDataBox's shape. */
export function shape(f) {
  if (!f) return null;
  const t = (x) => x?.utc ?? null;
  const local = (x) => x?.local ?? null;
  return {
    number: String(f.number ?? '').replace(/\s+/g, ''),
    airline: f.airline?.name ?? null,
    status: f.status ?? 'Unknown',
    dep: {
      iata: f.departure?.airport?.iata ?? null, name: f.departure?.airport?.name ?? null,
      sched: t(f.departure?.scheduledTime), est: t(f.departure?.revisedTime) ?? t(f.departure?.runwayTime) ?? null,
      sched_local: local(f.departure?.scheduledTime), terminal: f.departure?.terminal ?? null, gate: f.departure?.gate ?? null,
    },
    arr: {
      iata: f.arrival?.airport?.iata ?? null, name: f.arrival?.airport?.name ?? null,
      sched: t(f.arrival?.scheduledTime), est: t(f.arrival?.revisedTime) ?? t(f.arrival?.predictedTime) ?? t(f.arrival?.runwayTime) ?? null,
      sched_local: local(f.arrival?.scheduledTime), est_local: local(f.arrival?.revisedTime) ?? local(f.arrival?.predictedTime) ?? null,
      terminal: f.arrival?.terminal ?? null, gate: f.arrival?.gate ?? null, belt: f.arrival?.baggageBelt ?? null,
    },
  };
}

const parse = (s) => (s ? Date.parse(String(s).replace(' ', 'T')) : NaN);
const mins = (a, b) => Math.round((parse(a) - parse(b)) / 60000);

/** When to look again, in ms from now. 0 means the watch is finished. */
export function nextPollMs(flight, now = Date.now()) {
  const dep = parse(flight?.dep?.est ?? flight?.dep?.sched), arr = parse(flight?.arr?.est ?? flight?.arr?.sched);
  const st = String(flight?.status ?? '').toLowerCase();
  if (/cancel|diverted/.test(st)) return 0;
  if (/arrived|landed/.test(st) || (Number.isFinite(arr) && now > arr + 30 * 60000)) return 0;
  if (!Number.isFinite(dep)) return 6 * 3600_000;
  const toDep = dep - now, toArr = Number.isFinite(arr) ? arr - now : Infinity;
  if (toDep > 24 * 3600_000) return 24 * 3600_000;
  if (toDep > 3 * 3600_000) return 3 * 3600_000;
  if (toDep > 0) return 20 * 60000;
  if (toArr > 45 * 60000) return 45 * 60000;
  return 10 * 60000;
}

/**
 * What changed between two looks, as the events a person would want to hear
 * about. Returns [] when nothing worth a push happened.
 */
export function diff(prev, next) {
  if (!next) return [];
  const out = [];
  const ps = String(prev?.status ?? '').toLowerCase(), ns = String(next.status ?? '').toLowerCase();
  if (/cancel/.test(ns) && !/cancel/.test(ps)) out.push({ kind: 'cancelled' });
  const prevArr = prev?.arr?.est ?? prev?.arr?.sched, nextArr = next.arr?.est ?? next.arr?.sched;
  const late = next.arr?.sched && nextArr ? mins(nextArr, next.arr.sched) : 0;
  const prevLate = prev?.arr?.sched && prevArr ? mins(prevArr, prev.arr.sched) : 0;
  if (Math.abs(late - prevLate) >= 15) out.push({ kind: 'delay', minutes: late, arr_local: next.arr?.est_local ?? null });
  if (prev?.dep?.gate && next.dep?.gate && prev.dep.gate !== next.dep.gate) out.push({ kind: 'gate', from: prev.dep.gate, to: next.dep.gate });
  if (!prev?.dep?.gate && next.dep?.gate) out.push({ kind: 'gate_set', gate: next.dep.gate });
  if (/boarding/.test(ns) && !/boarding/.test(ps)) out.push({ kind: 'boarding', gate: next.dep?.gate ?? null });
  if (/(arrived|landed)/.test(ns) && !/(arrived|landed)/.test(ps)) out.push({ kind: 'landed', at_local: next.arr?.est_local ?? next.arr?.sched_local ?? null, belt: next.arr?.belt ?? null });
  return out;
}

const hhmm = (local) => (local ? String(local).slice(11, 16) : null);

/** The push, in the NUM voice: one line, a number in it, nothing invented. */
export function copyFor(ev, flight) {
  const no = flight.number;
  switch (ev.kind) {
    case 'cancelled': return { title: `${no} is cancelled`, body: 'Tell me what you need and I will look at the next flights and your first night.' };
    case 'delay': {
      if (ev.minutes <= 0) return { title: `${no} is back on time`, body: hhmm(ev.arr_local) ? `Lands ${hhmm(ev.arr_local)}.` : 'Nothing else changes.' };
      const when = hhmm(ev.arr_local);
      return { title: `${no} is ${ev.minutes} min late`, body: when ? `Now lands ${when}. Nothing else changes yet.` : 'Nothing else changes yet.' };
    }
    case 'gate': return { title: `Gate changed: ${ev.from} → ${ev.to}`, body: `${no}. Worth checking the walk.` };
    case 'gate_set': return { title: `${no} boards at gate ${ev.gate}`, body: 'Posted just now.' };
    case 'boarding': return { title: `${no} is boarding`, body: ev.gate ? `Gate ${ev.gate}.` : '' };
    case 'landed': return { title: `Landed${hhmm(ev.at_local) ? ` ${hhmm(ev.at_local)}` : ''}`, body: ev.belt ? `Bags on belt ${ev.belt}. Say the word for a car.` : 'Say the word for a car.' };
    default: return null;
  }
}

/* ── storage ─────────────────────────────────────────────────────────────── */

let ensured = null;
async function ensure(env) {
  if (!env?.DB) return;
  if (ensured === env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS num_flight_watch (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL, flight_no TEXT NOT NULL, date TEXT NOT NULL,
      snapshot TEXT, status TEXT NOT NULL DEFAULT 'watching',
      last_polled_at TEXT, next_poll_at TEXT, last_push_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_flight_watch_member ON num_flight_watch (member_id, status)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_flight_watch_next ON num_flight_watch (status, next_poll_at)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS num_flight_cache (k TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL)'),
  ]);
  ensured = env.DB;
}
export const _resetForTests = () => { ensured = null; };

/** One AeroDataBox call per flight per cadence window, shared by every watcher. */
export async function lookup(env, flightNo, date, { fetchImpl = fetch, maxAgeMs = 8 * 60000, now = Date.now() } = {}) {
  if (!flightWatchReady(env)) return { ok: false, reason: 'not_connected' };
  const k = `${flightNo}|${date}`;
  try {
    const hit = await env.DB.prepare('SELECT payload, fetched_at FROM num_flight_cache WHERE k = ?1').bind(k).first();
    if (hit && now - Date.parse(hit.fetched_at) < maxAgeMs) return { ok: true, flight: JSON.parse(hit.payload), cached: true };
  } catch { /* cache miss */ }
  const res = await fetchImpl(`${API}/flights/number/${encodeURIComponent(flightNo)}/${date}?withAircraftImage=false&withLocation=false`, {
    headers: { 'X-RapidAPI-Key': env.AERODATABOX_KEY, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' },
  });
  if (res.status === 204 || res.status === 404) return { ok: false, reason: 'not_found' };
  if (!res.ok) return { ok: false, reason: `http_${res.status}` };
  const body = await res.json().catch(() => null);
  const raw = Array.isArray(body) ? body[0] : body;
  const flight = shape(raw);
  if (!flight?.number) return { ok: false, reason: 'not_found' };
  try {
    await env.DB.prepare('INSERT OR REPLACE INTO num_flight_cache (k, payload, fetched_at) VALUES (?1, ?2, ?3)')
      .bind(k, JSON.stringify(flight), new Date(now).toISOString()).run();
  } catch { /* fine */ }
  return { ok: true, flight, cached: false };
}

const row = (r) => ({
  id: r.id, member_id: r.member_id, flight_no: r.flight_no, date: r.date, status: r.status,
  flight: r.snapshot ? JSON.parse(r.snapshot) : null, last_polled_at: r.last_polled_at, next_poll_at: r.next_poll_at,
});

export async function startWatch(env, { me, flightNo, date }, opts = {}) {
  await ensure(env);
  const no = normaliseFlightNo(flightNo);
  if (!no) return { ok: false, error: 'That does not look like a flight number. Try TG917.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return { ok: false, error: 'date must be YYYY-MM-DD' };
  const look = await lookup(env, no, date, opts);
  if (!look.ok) return { ok: false, error: look.reason === 'not_found' ? `I can’t find ${no} on ${date}. Check the number and the date.` : 'Flight data is not reachable right now.' };
  const now = opts.now ?? Date.now();
  const next = nextPollMs(look.flight, now);
  const existing = await env.DB.prepare('SELECT id FROM num_flight_watch WHERE member_id = ?1 AND flight_no = ?2 AND date = ?3 AND status = ?4')
    .bind(me, no, date, 'watching').first();
  const id = existing?.id ?? crypto.randomUUID();
  await env.DB.prepare(`INSERT OR REPLACE INTO num_flight_watch (id, member_id, flight_no, date, snapshot, status, last_polled_at, next_poll_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .bind(id, me, no, date, JSON.stringify(look.flight), next ? 'watching' : 'done', new Date(now).toISOString(), new Date(now + (next || 0)).toISOString()).run();
  return { ok: true, watch: { id, member_id: me, flight_no: no, date, status: next ? 'watching' : 'done', flight: look.flight } };
}

export async function listWatches(env, me) {
  await ensure(env);
  const { results } = await env.DB.prepare('SELECT * FROM num_flight_watch WHERE member_id = ?1 AND status = ?2 ORDER BY date').bind(me, 'watching').all();
  return (results ?? []).map(row);
}

/**
 * The cron. Every watch whose time has come is looked up (through the shared
 * cache), diffed against its last snapshot, and the member is told about the
 * events that matter — at most one push per 20 minutes per watch.
 */
export async function sweepFlights(env, { fetchImpl = fetch, now = Date.now(), ctx } = {}) {
  if (!flightWatchReady(env) || !env?.DB) return { checked: 0, pushed: 0 };
  await ensure(env);
  const { results } = await env.DB.prepare('SELECT * FROM num_flight_watch WHERE status = ?1 AND next_poll_at <= ?2 LIMIT 50')
    .bind('watching', new Date(now).toISOString()).all();
  let pushed = 0;
  for (const r of results ?? []) {
    const prev = r.snapshot ? JSON.parse(r.snapshot) : null;
    const look = await lookup(env, r.flight_no, r.date, { fetchImpl, now, maxAgeMs: 5 * 60000 });
    if (!look.ok) {
      await env.DB.prepare('UPDATE num_flight_watch SET last_polled_at = ?1, next_poll_at = ?2 WHERE id = ?3')
        .bind(new Date(now).toISOString(), new Date(now + 30 * 60000).toISOString(), r.id).run();
      continue;
    }
    const events = diff(prev, look.flight);
    const next = nextPollMs(look.flight, now);
    const canPush = !r.last_push_at || now - Date.parse(r.last_push_at) >= 20 * 60000;
    let pushedNow = false;
    if (events.length && canPush) {
      // The most consequential event wins the one push; the rest live on the card.
      const order = ['cancelled', 'landed', 'delay', 'boarding', 'gate', 'gate_set'];
      const ev = events.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0];
      const copy = copyFor(ev, look.flight);
      if (copy) {
        await notify(env, { memberId: r.member_id, kind: 'flight', title: copy.title, subtitle: null, body: copy.body, url: '/?app=1', tag: `flight-${r.flight_no}`, ctx });
        pushed += 1; pushedNow = true;
      }
    }
    await env.DB.prepare('UPDATE num_flight_watch SET snapshot = ?1, status = ?2, last_polled_at = ?3, next_poll_at = ?4, last_push_at = COALESCE(?5, last_push_at) WHERE id = ?6')
      .bind(JSON.stringify(look.flight), next ? 'watching' : 'done', new Date(now).toISOString(), new Date(now + (next || 0)).toISOString(), pushedNow ? new Date(now).toISOString() : null, r.id).run();
  }
  return { checked: (results ?? []).length, pushed };
}

/* ── routes ──────────────────────────────────────────────────────────────── */

export async function handleFlightWatch(request, env, path, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const me = url.searchParams.get('me');
    if (!me) return json({ ok: false, error: 'me required' }, 400);
    return json({ ok: true, ready: flightWatchReady(env), watches: await listWatches(env, me) });
  }
  const b = await request.json().catch(() => ({}));
  const me = String(b?.me ?? '').slice(0, 80);
  if (!me) return json({ ok: false, error: 'me required' }, 400);
  if (path.endsWith('/stop')) {
    await ensure(env);
    await env.DB.prepare('UPDATE num_flight_watch SET status = ?1 WHERE id = ?2 AND member_id = ?3').bind('stopped', String(b.id ?? ''), me).run();
    return json({ ok: true });
  }
  const out = await startWatch(env, { me, flightNo: b.flight_no, date: b.date }, { fetchImpl });
  return json(out, out.ok ? 200 : 400);
}
