/**
 * THE CONCIERGE KNOWS WHO YOUR HOST IS.
 *
 * ── THE GAP THIS CLOSES ───────────────────────────────────────────────────
 *
 * On 4 Sep 2026 NUM had two complete, tested, disconnected worlds:
 *
 *   • the app — num_members, the brain, plans, tables (worker/index.mjs)
 *   • the VIP host programme — num_hosts, num_host_clients, num_host_requests,
 *     the console, the calendar feed, the email loop (growth/worker.js)
 *
 * The join between them, `num_host_clients.member_id`, was never a real
 * member: /api/host/intro minted a fresh "m_…" string for every introduction,
 * so a phone-verified member who asked NUM for a car got NUM — never the host
 * who is paid to arrange exactly that. And the only way a request reached a
 * host's console was the host typing it in themselves, which is the opposite
 * of what the pitch promises ("your phone goes quiet at 3am").
 *
 * ── WHAT THIS DOES ────────────────────────────────────────────────────────
 *
 *   hostFor()      — is this member one of some host's clients? Matched on
 *                    member_id first, then on the verified phone — and a phone
 *                    match writes the member_id back, so the bridge heals
 *                    itself the first time each person asks.
 *   hostBlock()    — one paragraph for the prompt: who the host is, what they
 *                    arrange, and the exact rule for offering them.
 *   relayToHost()  — the `ask_host` action, executed server-side: the guest's
 *                    own words become a request in their host's console,
 *                    status 'new', source 'client'.
 *   notifyHosts()  — the cron sweep that tells the host by email, once, with
 *                    a receipt (`host_notified_at`), and files a failure if it
 *                    cannot. The writer never emails; the watchman does. That
 *                    is what keeps "the host was told" from depending on the
 *                    request that created the row surviving to its end.
 *
 * ── THE RULES, KEPT FROM THE HOST LOOP ────────────────────────────────────
 *
 *   • NUM never speaks to a client in the host's name before the host acts.
 *     The guest is in the thread already; they need no email from us.
 *   • The model is told to OFFER the host, never to assume. A guest who wants
 *     NUM to book the table cold still gets that.
 *   • The model never claims the host has confirmed. The status is 'new'
 *     until a human in the console says otherwise.
 *   • A request for a service the host does not list is still relayed if the
 *     guest asked for it to be — the host decides, not the schema.
 */
import { send, AUDIENCE } from './mailer.mjs';
import { record } from './failures.mjs';

/** The service keys the host console understands (growth/worker.js HOST_SERVICES). */
export const HOST_SERVICES = ['car', 'reservation', 'stay', 'activity', 'appointment', 'delivery'];
export const SERVICE_LABELS = Object.freeze({
  car: 'a car or transfer',
  reservation: 'a restaurant reservation',
  stay: 'a place to stay',
  activity: 'an activity or tour',
  appointment: 'an appointment',
  delivery: 'a delivery',
});

const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const token = (n = 10) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, n * 2);
};

/* --------------------------------------------------------------- schema */

// Two columns on the host request, added lazily in the house style (see
// maildelivery.mjs). `source` says who typed it — the host in their console
// or the client through NUM — and `host_notified_at` is the receipt that the
// host has been told, which is the only thing the sweep keys on.
const ALTERS = [
  "ALTER TABLE num_host_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'host'",
  'ALTER TABLE num_host_requests ADD COLUMN host_notified_at TEXT',
];
const ready = new WeakSet();
export async function ensure(env) {
  if (!env?.DB || ready.has(env.DB)) return;
  let absent = false;
  for (const sql of ALTERS) {
    try { await env.DB.prepare(sql).run(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      // "duplicate column" is the normal steady state. "no such table" means
      // the host migrations have not run on this database yet — try again
      // next time rather than remembering the miss.
      if (/no such table/i.test(msg)) absent = true;
      else if (!/duplicate column/i.test(msg)) console.warn('[hostaware] ensure', msg);
    }
  }
  if (!absent) ready.add(env.DB);
}

/* ------------------------------------------------------------- hostFor */

function services(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? arr.map((s) => (typeof s === 'string' ? s : s?.key)).filter((k) => HOST_SERVICES.includes(k)) : [];
  } catch { return []; }
}

/**
 * The member's active host, or null. Cheap: one read of the member's phone,
 * one join. Runs inside the same Promise.all as grounding, so it adds no
 * latency to the answer.
 */
export async function hostFor(env, memberId) {
  if (!env?.DB || !memberId) return null;
  try {
    const m = await env.DB.prepare('SELECT phone, phone_verified FROM num_members WHERE id=?1').bind(memberId).first();
    const phone = m?.phone_verified ? String(m.phone ?? '').trim() : '';
    const row = await env.DB.prepare(
      `SELECT c.id AS client_id, c.member_id, c.name AS client_name,
              h.id AS host_id, h.name AS host_name, h.email AS host_email, h.services_json
         FROM num_host_clients c JOIN num_hosts h ON h.id = c.host_id
        WHERE c.status = 'active' AND h.status = 'active'
          AND (c.member_id = ?1 OR (?2 <> '' AND c.phone = ?2))
        ORDER BY (c.member_id = ?1) DESC LIMIT 1`,
    ).bind(memberId, phone).first();
    if (!row) return null;
    // The bridge heals itself: a phone match becomes a member_id match, so
    // the next ask needs no phone and the host console can show "on NUM".
    if (row.member_id !== memberId) {
      await env.DB.prepare('UPDATE num_host_clients SET member_id=?1, updated_at=?2 WHERE id=?3 AND (member_id IS NULL OR member_id NOT IN (SELECT id FROM num_members))')
        .bind(memberId, now(), row.client_id).run().catch(() => {});
    }
    return {
      clientId: row.client_id,
      clientName: row.client_name,
      hostId: row.host_id,
      hostName: row.host_name,
      hostEmail: row.host_email,
      services: services(row.services_json),
    };
  } catch (e) {
    // A host lookup failing must never cost the guest their answer.
    console.warn('[hostaware] lookup', e?.message ?? e);
    return null;
  }
}

/* ----------------------------------------------------------- hostBlock */

/** The paragraph the brain reads. Empty string when there is no host. */
export function hostBlock(host) {
  if (!host?.hostName) return '';
  const list = host.services.length
    ? ` who arranges ${host.services.map((k) => SERVICE_LABELS[k]).join(', ')} for them in person`
    : '';
  const n = host.hostName;
  return [
    `PERSONAL HOST: this guest has a personal host on NUM — ${n}${list}. ${n} knows their preferences and is paid to handle these things, so ${n} is usually the better answer than a cold booking.`,
    `When the guest asks for something ${n} handles: give the useful answer you can see first, then offer ONCE — "want me to send this to ${n}?". Never assume; some guests want NUM to do it directly, and that is fine.`,
    `When the guest says yes, or asks you to tell / ask / message their host: emit ONE ask_host action carrying exactly what they want ({service_key, title, detail, city, starts_at, party_size}), and say you have passed it to ${n}, who will confirm with them directly. NEVER say ${n} has confirmed, booked or agreed anything — the request is new until ${n} answers it.`,
  ].join('\n');
}

/* --------------------------------------------------------- relayToHost */

function askHostActions(actions) {
  const out = [];
  for (const a of actions ?? []) {
    if (a?.type !== 'ask_host') continue;
    const p = a.request ?? (typeof a.payload === 'string' ? safeJson(a.payload) : a.payload) ?? null;
    if (p && (p.title || p.detail)) out.push(p);
  }
  return out;
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * Turn each ask_host action into a row in the host's console. Called after
 * the reply is sent (ctx.waitUntil), like memory and turns. Returns what it
 * wrote so the caller can log it; never throws.
 */
export async function relayToHost(env, { memberId, host, actions, userText } = {}) {
  const asks = askHostActions(actions);
  if (!asks.length || !host?.hostId || !env?.DB) return { relayed: 0, ids: [] };
  await ensure(env);
  const ids = [];
  for (const p of asks.slice(0, 3)) {
    const key = HOST_SERVICES.includes(p.service_key) ? p.service_key : 'appointment';
    const title = clip(p.title, 160) ?? clip(p.detail, 160) ?? 'Request from NUM';
    const detail = [clip(p.detail, 1000), userText ? `Guest's words: "${clip(userText, 400)}"` : null]
      .filter(Boolean).join('\n');
    const party = Number.isFinite(Number(p.party_size)) && Number(p.party_size) > 0 ? Math.floor(Number(p.party_size)) : null;
    const id = 'hr_' + token(10);
    try {
      await env.DB.prepare(
        `INSERT INTO num_host_requests
           (id, host_id, client_id, service_key, title, detail, city, starts_at, party_size, status, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'new', 'client', ?10)`,
      ).bind(id, host.hostId, host.clientId, key, title, detail, clip(p.city, 80), clip(p.starts_at, 40), party, now()).run();
      ids.push(id);
    } catch (e) {
      // The guest was told it was passed on. If it was not, that is a named
      // failure on the board, not a silent one.
      await record(env, { kind: 'host_request_unrelayed', subject: `${host.hostName} <- ${memberId}`, detail: String(e?.message ?? e) }).catch(() => {});
    }
  }
  return { relayed: ids.length, ids };
}

/* --------------------------------------------------------- notifyHosts */

export function hostRequestEmail({ host, request, client, consoleUrl }) {
  const who = client?.name || 'A client of yours';
  const when = request.starts_at ? ` for ${request.starts_at}` : '';
  const party = request.party_size ? ` (${request.party_size} people)` : '';
  const text = [
    `${host.name},`,
    '',
    `${who} asked NUM for ${SERVICE_LABELS[request.service_key] ?? 'something'}${when}${party}:`,
    '',
    `  ${request.title}`,
    request.detail ? request.detail.split('\n').map((l) => `  ${l}`).join('\n') : null,
    '',
    'It is in your console as a new request. Confirm it there and NUM tells them, in your name.',
    consoleUrl,
    '',
    'NUM — nothing has been promised to your client yet.',
  ].filter((l) => l !== null).join('\n');
  return { subject: `${who} asked for ${SERVICE_LABELS[request.service_key] ?? 'something'}`, text };
}

/**
 * The watchman. Every request a client made through NUM that its host has
 * not been told about, oldest first, at most `limit` per tick. One email per
 * request, marked with a receipt the moment the transport accepts it.
 */
export async function notifyHosts(env, { limit = 25, sendImpl = send, site = null } = {}) {
  if (!env?.DB) return { sent: 0, failed: 0 };
  await ensure(env);
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT r.id, r.host_id, r.client_id, r.service_key, r.title, r.detail, r.starts_at, r.party_size,
              h.name AS host_name, h.email AS host_email, h.console_key,
              c.name AS client_name
         FROM num_host_requests r
         JOIN num_hosts h ON h.id = r.host_id AND h.status = 'active'
         LEFT JOIN num_host_clients c ON c.id = r.client_id
        WHERE r.source = 'client' AND r.host_notified_at IS NULL
        ORDER BY r.created_at ASC LIMIT ?1`,
    ).bind(limit).all());
  } catch (e) {
    // The table or the columns are not there yet (migration 0018 pending).
    // Nothing to sweep is not a failure; a sweep that cannot read is.
    if (!/no such (table|column)/i.test(String(e?.message ?? e))) console.warn('[hostaware] sweep', e?.message ?? e);
    return { sent: 0, failed: 0 };
  }
  let sent = 0, failed = 0;
  const origin = site ?? env.SITE ?? 'https://itsnum.com';
  for (const r of rows ?? []) {
    const mail = hostRequestEmail({
      host: { name: r.host_name },
      request: r,
      client: { name: r.client_name },
      consoleUrl: r.console_key ? `${origin}/host/?k=${r.console_key}` : `${origin}/host/`,
    });
    const out = await sendImpl(env, { to: r.host_email, subject: mail.subject, text: mail.text, tag: 'host_request_new' }, { audience: AUDIENCE.EXTERNAL })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (out?.ok) {
      sent++;
      await env.DB.prepare('UPDATE num_host_requests SET host_notified_at=?1 WHERE id=?2').bind(now(), r.id).run().catch(() => {});
    } else {
      failed++;
      await record(env, { kind: 'host_request_unsent', subject: `${r.host_name} <${r.host_email}>`, detail: out?.error ?? 'send failed' }).catch(() => {});
    }
  }
  return { sent, failed };
}
