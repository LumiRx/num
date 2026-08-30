// AiR — the calendar, contacts and tasks brain, over MCP.
//
// The split is clean because the two systems are good at different things:
//
//   Num  tables, cars, food, wellness, nightlife, the trip itself
//   AiR  availability, scheduling across attendees, contacts, reminders
//
// Num was faking the second half — the meetings specialist reasoned about free
// time with no calendar behind it, and "invite Dre" matched against whatever
// the user had typed in. AiR does both properly.
//
// Every exchange is written to num_air_exchanges (direction, body, custody_ref)
// — a table that already existed, which tells you somebody planned for this.

import { assertNoPassengerData, forbiddenValues } from './passengers.mjs';

const PROTOCOL = '2024-11-05';

/** Tools AiR exposes, and what each is for on our side. */
export const AIR_TOOLS = {
  check_availability: 'when is this person actually free',
  schedule_meeting: 'agree a time across attendees by email',
  manage_contact_lookup: 'resolve a name to a real person before we act on it',
  manage_contact_add: 'remember someone new',
  task_create: 'a reminder or follow-up that has to survive this conversation',
  memory_save: 'a lasting fact about the user',
  run_air_agent: 'hand the whole request over when it is squarely theirs',
};

export const airReady = (env) => !!(env.AIR_MCP_URL && env.AIR_API_KEY);

async function rpc(env, payload, session) {
  const res = await fetch(env.AIR_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${env.AIR_API_KEY}`,
      ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify(payload),
    // AiR is somebody else's uptime. It must never hold a user's turn hostage.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`AiR HTTP ${res.status}`);
  const sid = res.headers.get('Mcp-Session-Id');
  let text = await res.text();
  // The transport may frame replies as SSE; take the first data line.
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      text = line.slice(5).trim();
      break;
    }
  }
  const body = JSON.parse(text);
  if (body.error) throw new Error(body.error.message ?? 'AiR error');
  return { body, session: sid ?? session };
}

/**
 * Call one AiR tool.
 *
 * `trust` is the part that matters commercially: we hand AiR the verification
 * we hold and they do not — whether this person is a proved human, how their
 * work sessions scored, whether their number is theirs. That is the exchange.
 */
export async function callAir(env, tool, args, { trust, memberId, ctx } = {}) {
  if (!airReady(env)) throw new Error('AiR is not configured');
  const started = Date.now();
  const payload = { ...args, ...(trust ? { _num_trust: trust } : {}) };

  // ── the passenger crossing rule, enforced here rather than promised ─────
  //
  // AiR is outside the 5arz group (CONSENT_ARCHITECTURE.md §1.2) and this is
  // the line that puts a Num payload on somebody else's server. A passenger
  // record — legal name, date of birth, gender marker, passport number — has
  // no bearing on scheduling a meeting and no consent scope authorises it, so
  // it may never be in this payload. `assertNoPassengerData` throws BEFORE the
  // fetch, which turns a disclosure into a 500 on our own side.
  //
  // Two checks, because one of them is not enough. The key-shape check catches
  // `born_on` in an obvious place; the value check catches a stored family name
  // or date of birth copied into an innocently-named field, which is the
  // failure a denylist of key names cannot see. The value check costs one
  // indexed SELECT and only runs when this member has saved a passenger.
  assertNoPassengerData(payload, 'air.callAir', { values: await forbiddenValues(env, memberId) });

  let out;
  let ok = 1;
  let note = null;
  try {
    const init = await rpc(env, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'num', version: '1' } },
    });
    const call = await rpc(
      env,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: payload } },
      init.session,
    );
    out = call.body.result;
  } catch (err) {
    ok = 0;
    note = String(err?.message ?? err).slice(0, 300);
  }

  // Log both directions. Fire-and-forget: an audit failure must never cost the
  // user their answer.
  const log = env.DB
    ?.prepare(
      `INSERT INTO num_air_exchanges (id, direction, body, custody_ref, ok, note, created_at)
       VALUES (?1,'out',?2,?3,?4,?5,?6)`,
    )
    .bind(
      crypto.randomUUID(),
      JSON.stringify({ tool, args: redact(payload), result: redact(out), ms: Date.now() - started }).slice(0, 8000),
      memberId ?? null,
      ok,
      note,
      Math.floor(Date.now() / 1000),
    )
    .run()
    .catch((e) => console.warn('[air] log failed', e?.message ?? e));
  if (ctx?.waitUntil) ctx.waitUntil(log);

  if (!ok) throw new Error(note);
  return out;
}

/** Never write a bearer token or a raw phone number into an audit row. */
function redact(v) {
  if (v == null) return v;
  const s = JSON.stringify(v);
  return JSON.parse(
    s
      .replace(/"(Authorization|api_key|apiKey|token)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
      .replace(/\+\d{7,15}/g, '<phone>'),
  );
}

/**
 * The trust envelope — what Num knows about this person that AiR does not.
 *
 * Assembled from BOTH databases, and deliberately honest about which parts are
 * proved and which are merely claimed. A verification report that overstates
 * itself is worth less than none, because the moment one is wrong nobody
 * believes the rest.
 */
export async function trustEnvelope(env, { memberId, phone }) {
  const t = {
    source: 'num/5arz',
    issued_at: new Date().toISOString(),
    identity: { verified: false, basis: 'none' },
    uniqueness: { attested: false, level: null, note: 'no attestation issued' },
    work: null,
    account: null,
  };

  // ── FOUR READS, ONE ROUND TRIP'S WORTH OF WAITING ─────────────────────
  //
  // These four queries used to run one after another: the Num member row,
  // then the ledger member row, then the uniqueness attestation, then the
  // session history. Nothing in any of them feeds the next — the awaits were
  // sequential only because that is the order they were written in, and the
  // envelope paid four serial round trips to two databases for it.
  //
  // That cost was invisible while the envelope was internal. It stopped being
  // invisible the moment a partner asked us to commit to a latency budget for
  // issuing one (LetsGo2Trip, term 9: under 100 ms of added latency per
  // envelope). Four serial D1 reads is the difference between comfortably
  // inside that number and arguing about it.
  //
  // Each read keeps its own .catch(() => null): the envelope is assembled from
  // whatever is available and is explicit about what it could not prove. One
  // database being down must degrade the envelope, never fail it — a checkout
  // that gets "unverified" still works, a checkout that gets a 500 does not.
  const ledger = env.LEDGER;
  const id = memberId ?? '';
  const [m, row, uha, sessions] = await Promise.all([
    env.DB && memberId
      ? env.DB.prepare('SELECT id, name, phone_verified, created_at FROM num_members WHERE id=?1')
          .bind(memberId).first().catch(() => null)
      : null,
    // `phone` short-circuits the ledger identity read exactly as before: a
    // lookup by phone number is not a lookup by member id and must not be
    // silently answered with one.
    ledger && !phone
      ? ledger.prepare('SELECT id, verified_at, verification_ref, country FROM members WHERE id=?1')
          .bind(id).first().catch(() => null)
      : null,
    ledger
      ? ledger.prepare("SELECT level, status, valid_until FROM uniqueness_attestations WHERE member_id=?1 AND status='active' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
          .bind(id).first().catch(() => null)
      : null,
    ledger
      ? ledger.prepare("SELECT COUNT(*) n, SUM(status='active') passed, SUM(status='rejected') rejected, ROUND(AVG(score_v),3) avg_score FROM verified_sessions WHERE member_id=?1")
          .bind(id).first().catch(() => null)
      : null,
  ]);

  // Applied in the SAME ORDER the sequential version applied them, because
  // the order is a precedence rule and not an accident: an SMS-verified phone
  // sets identity to `sms`, and a completed ID check OVERWRITES it with
  // `id_check`. Swap these two and a fully verified member is reported to a
  // partner as merely phone-verified — a quieter bug than a crash and a more
  // expensive one, since the whole point of the envelope is that the partner
  // can trust which basis it names.
  if (m) {
    t.account = {
      age_days: m.created_at ? Math.floor((Date.now() - Date.parse(m.created_at)) / 86400_000) : null,
      // One number, one account is enforced at write time — see worker/social.mjs.
      phone_unique: true,
      phone_verified: !!m.phone_verified,
    };
    if (m.phone_verified) t.identity = { verified: true, basis: 'sms' };
  }
  if (row?.verified_at) {
    t.identity = { verified: true, basis: 'id_check', at: row.verified_at, country: row.country ?? null };
  }
  if (uha) t.uniqueness = { attested: true, level: uha.level, valid_until: uha.valid_until };
  if (sessions?.n) {
    // Proof-of-human-work: sessions scored on focus, input consistency and
    // probe pass rate. The rejections are the point — a screen that never
    // rejects is not a screen.
    t.work = { sessions: sessions.n, passed: sessions.passed, rejected: sessions.rejected, avg_score: sessions.avg_score };
  }
  return t;
}
