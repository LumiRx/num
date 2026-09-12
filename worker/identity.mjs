/**
 * ONE PERSON, SEVERAL HATS — AND ONE CODE PER HAT.
 *
 * Dre, 11 Sep 2026: "when a user signs up and they have a business account we
 * can connect the two to their app and be able to manage their business
 * dashboard seperate from their personal num account, same for VIP hosts.
 * each needs a qr cods and a referral link so we can keep the connection
 * between all of them and whos meeting who."
 *
 * ── WHAT WAS ACTUALLY MISSING ────────────────────────────────────────────
 *
 * Surveyed against production before writing a line:
 *
 *   - `num_place_owners.member_ref` EXISTS and is populated by the in-app
 *     claim — but was NULL on all three live rows, because those came through
 *     the web/API claim flow (`num_claims`), which knows an email and never a
 *     member. So the app could not tell that the person signed in owns a
 *     business.
 *   - `num_hosts` had NO member column at all. A host was `console_key` and
 *     `email`, an identity with no relationship to `num_members`.
 *   - The QR system covered TABLES AND BILLS. Nothing issued a code meaning
 *     "this is this business / host / member", and nothing recorded a scan.
 *   - Hosts had `num_host_clients`; businesses had no equivalent, and members
 *     could see friends (`num_links`) but never the places they had met.
 *
 * ── THE TWO DECISIONS THIS FILE ENCODES ──────────────────────────────────
 *
 * 1. ONE ACCOUNT, MANY HATS. A member IS the identity; a business or host is
 *    a hat that member wears. Everything keys off `member_id`, so signing in
 *    once is enough and a dashboard switch is a read, not a second login.
 *
 * 2. A SCAN IS A CONNECTION BOTH SIDES CAN SEE. The guest gets the place in
 *    their list; the business gets the guest in theirs.
 *
 * ── AND ONE CODE, NOT TWO ────────────────────────────────────────────────
 *
 * The QR and the referral link are THE SAME CODE — the link is just the code
 * in URL form. Issuing separate codes for "scan me" and "refer me" would mean
 * two attribution paths for one relationship, and the day they disagree
 * nobody can say which was right.
 */

/** The hats a member can wear. `member` is not optional — everyone has it. */
export const HATS = Object.freeze(['member', 'business', 'host']);

/** How a connection was made. Kept small on purpose. */
export const VIA = Object.freeze(['qr', 'link']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_identity_codes (
  code TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  member_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_owner ON num_identity_codes(owner_type, owner_id);
CREATE TABLE IF NOT EXISTS num_connections (
  id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  via TEXT NOT NULL,
  place TEXT,
  times INTEGER NOT NULL DEFAULT 1,
  first_met_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_met_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conn_pair ON num_connections(from_type, from_id, to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_conn_from ON num_connections(from_type, from_id, last_met_at);
CREATE INDEX IF NOT EXISTS idx_conn_to ON num_connections(to_type, to_id, last_met_at);
`;

// num_hosts predates this file, so the member link is a migration rather than
// part of SCHEMA: CREATE TABLE IF NOT EXISTS will not add a column to a table
// that already exists, which is how a migration that looks applied does
// nothing at all.
const MIGRATIONS = ['ALTER TABLE num_hosts ADD COLUMN member_id TEXT'];

const readied = new WeakSet();
export async function ensure(env) {
  if (!env?.DB || readied.has(env.DB)) return;
  for (const s of SCHEMA.split(';').map((x) => x.trim()).filter(Boolean)) {
    await env.DB.prepare(s).run();
  }
  for (const m of MIGRATIONS) {
    // Already-applied ALTERs throw "duplicate column"; that is the success
    // case on every run after the first.
    await env.DB.prepare(m).run().catch(() => {});
  }
  readied.add(env.DB);
}

/**
 * A short, unambiguous code.
 *
 * No 0/O/1/I/L: these get read off a phone screen and typed by hand, and a
 * code that cannot survive being read aloud is a support ticket.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode(len = 8, rnd = () => crypto.getRandomValues(new Uint8Array(1))[0]) {
  let out = '';
  while (out.length < len) out += ALPHABET[rnd() % ALPHABET.length];
  return out;
}

/**
 * Where every Num code points.
 *
 * This is app.itsnum.com and not itsnum.com, and the difference is the whole
 * link working or not working. `/c/<code>` is a route on the APP Worker
 * (worker/index.mjs). The marketing site is a different Worker and returns a
 * flat 404 for it — verified against production on 12 Sep 2026:
 * `itsnum.com/c/ABCD2345` → 404, `app.itsnum.com/c/ABCD2345` → 302 to
 * `/?c=ABCD2345`. The default used to be the marketing host, which would have
 * put a dead link under every business, host and member QR we printed.
 *
 * It matches APP_ORIGIN in src/lib/links.ts on purpose: the code a member sees
 * in the app and the code their venue prints from the console have to be the
 * same code, and connectlink.test.mjs holds the two files to it.
 */
export const APP_ORIGIN = 'https://app.itsnum.com';

/** The one link shape. The QR encodes exactly this, so both paths agree. */
export const linkFor = (code, base = APP_ORIGIN) =>
  `${String(base).replace(/\/+$/, '')}/c/${encodeURIComponent(String(code))}`;

/**
 * Every hat this member wears, most personal first.
 *
 * A business is theirs when `num_place_owners.member_ref` is them and the
 * ownership has not been revoked. A host is theirs when `num_hosts.member_id`
 * is them AND the host record is not closed — a closed host must not keep a
 * live dashboard.
 */
export async function identitiesFor(env, memberId) {
  // ensure() no-ops without a binding, so each entry point guards for itself.
  // Local dev and the test harness both run without DB, and a concierge that
  // crashes on a missing optional table is worse than one with no hats.
  if (!env?.DB) return [];
  await ensure(env);
  const me = String(memberId ?? '').trim();
  if (!me) return [];
  const out = [{ type: 'member', id: me, name: null }];

  const biz = await env.DB.prepare(
    `SELECT o.business_id AS id, p.name AS name, p.dest AS dest
       FROM num_place_owners o LEFT JOIN places p ON p.id = o.place_id
      WHERE o.member_ref = ?1 AND o.revoked_at IS NULL`,
  ).bind(me).all().catch(() => ({ results: [] }));
  for (const b of biz.results ?? []) out.push({ type: 'business', id: b.id, name: b.name ?? null, dest: b.dest ?? null });

  const hosts = await env.DB.prepare(
    `SELECT id, name, company, status FROM num_hosts
      WHERE member_id = ?1 AND closed_at IS NULL AND status <> 'ended'`,
  ).bind(me).all().catch(() => ({ results: [] }));
  for (const h of hosts.results ?? []) out.push({ type: 'host', id: h.id, name: h.company || h.name || null });

  return out;
}

/**
 * The stable code for one identity, minted on first ask.
 *
 * Stable is the whole point: a code that rotates invalidates every printed
 * QR and every link already shared. `INSERT OR IGNORE` on the unique
 * (owner_type, owner_id) index means two simultaneous requests cannot mint
 * two codes for the same identity.
 */
export async function codeFor(env, { ownerType, ownerId, memberId = null }) {
  if (!env?.DB) return null;
  await ensure(env);
  if (!HATS.includes(ownerType) || !ownerId) return null;
  const existing = await env.DB.prepare(
    'SELECT code FROM num_identity_codes WHERE owner_type=?1 AND owner_id=?2 AND active=1',
  ).bind(ownerType, String(ownerId)).first().catch(() => null);
  if (existing?.code) return existing.code;

  const code = newCode();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO num_identity_codes (code, owner_type, owner_id, member_id) VALUES (?1,?2,?3,?4)',
  ).bind(code, ownerType, String(ownerId), memberId ? String(memberId) : null).run().catch(() => {});
  const row = await env.DB.prepare(
    'SELECT code FROM num_identity_codes WHERE owner_type=?1 AND owner_id=?2 AND active=1',
  ).bind(ownerType, String(ownerId)).first().catch(() => null);
  return row?.code ?? null;
}

/** Who a code belongs to, or null. Never guesses. */
export async function resolveCode(env, code) {
  if (!env?.DB) return null;
  await ensure(env);
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) return null;
  const row = await env.DB.prepare(
    'SELECT code, owner_type, owner_id, member_id FROM num_identity_codes WHERE code=?1 AND active=1',
  ).bind(c).first().catch(() => null);
  return row ?? null;
}

/**
 * One directed edge, upserted.
 *
 * A second scan of the same code is the same relationship, not a new one — it
 * bumps `times` and `last_met_at`. Without that, a regular at a bar would
 * appear in their list forty times and the list would be useless.
 */
async function edge(env, { fromType, fromId, toType, toId, via, place }) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await env.DB.prepare(
    `INSERT INTO num_connections (id, from_type, from_id, to_type, to_id, via, place, times, first_met_at, last_met_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,?8)
     ON CONFLICT(from_type, from_id, to_type, to_id) DO UPDATE SET
       times = times + 1, last_met_at = ?8, place = COALESCE(?7, place)`,
  ).bind(crypto.randomUUID(), fromType, String(fromId), toType, String(toId), via, place ?? null, now)
    .run().catch((e) => console.warn('[connections]', e?.message ?? e));
}

/**
 * Somebody scanned a code, or opened its link.
 *
 * Both directions are written, because Dre chose "record the connection, both
 * sides see it": the guest gets the place in their list and the business gets
 * the guest in theirs. Two rows rather than one bidirectional row so each side
 * can carry its own `place` note and be deleted independently when an account
 * goes.
 */
export async function recordScan(env, { code, scannerMemberId, via = 'qr', place = null }) {
  if (!env?.DB) return { ok: false, error: 'no database' };
  await ensure(env);
  if (!VIA.includes(via)) return { ok: false, error: 'unknown via' };
  const me = String(scannerMemberId ?? '').trim();
  if (!me) return { ok: false, error: 'sign in first' };

  const owner = await resolveCode(env, code);
  // An unresolved code invents nothing. A connection to a place that does not
  // exist is worse than no connection: it is a false memory of a real evening.
  if (!owner) return { ok: false, error: 'that code is not one of ours' };

  // Scanning your own code is a no-op, not an error — people test their own
  // QR constantly and a red failure would read as the code being broken.
  if (owner.owner_type === 'member' && owner.owner_id === me) return { ok: true, self: true };
  if (owner.member_id && owner.member_id === me) return { ok: true, self: true };

  await edge(env, { fromType: 'member', fromId: me, toType: owner.owner_type, toId: owner.owner_id, via, place });
  await edge(env, { fromType: owner.owner_type, fromId: owner.owner_id, toType: 'member', toId: me, via, place });
  return { ok: true, connected: { type: owner.owner_type, id: owner.owner_id }, via };
}

/** Who this identity has met, most recent first, with names where we have them. */
export async function connectionsFor(env, { ownerType, ownerId, limit = 50 }) {
  if (!env?.DB) return [];
  await ensure(env);
  if (!HATS.includes(ownerType) || !ownerId) return [];
  const { results } = await env.DB.prepare(
    `SELECT c.to_type, c.to_id, c.via, c.place, c.times, c.first_met_at, c.last_met_at,
            COALESCE(m.name, b.name, h.company, h.name) AS name
       FROM num_connections c
       LEFT JOIN num_members m ON c.to_type='member'   AND m.id = c.to_id
       LEFT JOIN businesses  b ON c.to_type='business' AND b.id = c.to_id
       LEFT JOIN num_hosts   h ON c.to_type='host'     AND h.id = c.to_id
      WHERE c.from_type=?1 AND c.from_id=?2
      ORDER BY c.last_met_at DESC
      LIMIT ${Math.max(1, Math.min(200, limit | 0))}`,
  ).bind(ownerType, String(ownerId)).all().catch(() => ({ results: [] }));
  return results ?? [];
}

/**
 * Attach an existing host record to the member signed in.
 *
 * Proof is the host's own console key — the credential they already hold and
 * nobody else does. Matching on email alone would let anyone who knows a
 * host's address adopt their dashboard.
 *
 * One host, one member: `member_id IS NULL` in the WHERE means a host already
 * claimed cannot be silently taken over, and the caller is told so.
 */
export async function claimHost(env, { memberId, consoleKey }) {
  if (!env?.DB) return { ok: false, error: 'no database' };
  await ensure(env);
  const me = String(memberId ?? '').trim();
  const key = String(consoleKey ?? '').trim();
  if (!me || !key) return { ok: false, error: 'missing details' };

  const host = await env.DB.prepare(
    'SELECT id, name, company, member_id FROM num_hosts WHERE console_key = ?1 AND closed_at IS NULL',
  ).bind(key).first().catch(() => null);
  if (!host) return { ok: false, error: 'that host key is not recognised' };
  if (host.member_id && host.member_id !== me) return { ok: false, error: 'that host is already linked to another account' };

  await env.DB.prepare('UPDATE num_hosts SET member_id=?2 WHERE id=?1 AND (member_id IS NULL OR member_id=?2)')
    .bind(host.id, me).run();
  await codeFor(env, { ownerType: 'host', ownerId: host.id, memberId: me });
  return { ok: true, host: { id: host.id, name: host.company || host.name } };
}

/** Digits only, so +1 (310) 555-0134 and +13105550134 are the same number. */
export const samePhone = (a, b) => {
  const d = (v) => String(v ?? '').replace(/\D+/g, '');
  const x = d(a);
  const y = d(b);
  if (x.length < 7 || y.length < 7) return false;
  // Compare the last 10 digits: one side may carry a country code the other
  // does not, and a venue's published number rarely matches a member's
  // formatting exactly.
  return x.slice(-10) === y.slice(-10);
};

/**
 * Attach a business the member has already proven they own.
 *
 * Used to backfill ownerships proven through the WEB claim flow, which knows
 * a verified email and phone but no member — the reason all three live rows
 * had a NULL member_ref. The proof is the verified phone on the ownership
 * record matching the member's own verified number; nothing weaker.
 *
 * ── THE PHONE IS READ, NEVER ACCEPTED ────────────────────────────────────
 * This used to take `phone` from the caller. A venue's number is printed on
 * its own listing, its own door and its own Google entry, so "send us the
 * number" is not proof of anything — anyone who could read a signboard could
 * have attached that business to their own account and opened its dashboard,
 * its bookings and its guest list.
 *
 * So the number comes from `num_members` for the member who is asking, and
 * only if `phone_verified` is set — meaning Num texted that handset and the
 * person read the code off it. The client cannot influence which number is
 * compared. Caught on review 12 Sep 2026, before it shipped.
 */
export async function claimBusinessByPhone(env, { memberId }) {
  if (!env?.DB) return { ok: false, error: 'no database' };
  await ensure(env);
  const me = String(memberId ?? '').trim();
  if (!me) return { ok: false, error: 'missing details' };

  const member = await env.DB.prepare(
    'SELECT phone, phone_verified FROM num_members WHERE id = ?1',
  ).bind(me).first().catch(() => null);
  if (!member?.phone || !Number(member.phone_verified)) {
    return { ok: false, error: 'verify your phone number first — that is what proves the listing is yours' };
  }
  const ph = String(member.phone);

  // Read the candidates and compare in code rather than in SQL: the stored
  // formats differ between the claim flow and sign-up, and a `WHERE phone = ?`
  // silently misses "+1 310 555 0134" against "+13105550134".
  const { results } = await env.DB.prepare(
    'SELECT place_id, business_id, member_ref, phone FROM num_place_owners WHERE revoked_at IS NULL AND phone IS NOT NULL',
  ).all().catch(() => ({ results: [] }));
  const row = (results ?? []).find((r) => samePhone(r.phone, ph));
  if (!row) return { ok: false, error: 'no verified listing on that number' };
  if (row.member_ref && row.member_ref !== me) return { ok: false, error: 'that listing is linked to another account' };

  await env.DB.prepare('UPDATE num_place_owners SET member_ref=?2 WHERE place_id=?1 AND (member_ref IS NULL OR member_ref=?2)')
    .bind(row.place_id, me).run();
  await codeFor(env, { ownerType: 'business', ownerId: row.business_id, memberId: me });
  return { ok: true, business: { id: row.business_id } };
}

/** Everything a profile needs to draw the hats, their codes and their links. */
export async function identityPayload(env, memberId, base = APP_ORIGIN) {
  const hats = await identitiesFor(env, memberId);
  const out = [];
  for (const h of hats) {
    const code = await codeFor(env, { ownerType: h.type, ownerId: h.id, memberId });
    out.push({ ...h, code, link: code ? linkFor(code, base) : null });
  }
  return out;
}
