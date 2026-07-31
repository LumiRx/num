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

  // Num side — the app's own account signals.
  if (env.DB && memberId) {
    const m = await env.DB.prepare('SELECT id, name, phone_verified, created_at FROM num_members WHERE id=?1')
      .bind(memberId).first().catch(() => null);
    if (m) {
      t.account = {
        age_days: m.created_at ? Math.floor((Date.now() - Date.parse(m.created_at)) / 86400_000) : null,
        // One number, one account is enforced at write time — see worker/social.mjs.
        phone_unique: true,
        phone_verified: !!m.phone_verified,
      };
      if (m.phone_verified) t.identity = { verified: true, basis: 'sms' };
    }
  }

  // 5arz side — the earner ledger, where real verification lives.
  if (env.LEDGER) {
    const row = phone
      ? null
      : await env.LEDGER.prepare('SELECT id, verified_at, verification_ref, country FROM members WHERE id=?1')
          .bind(memberId ?? '').first().catch(() => null);
    if (row?.verified_at) {
      t.identity = { verified: true, basis: 'id_check', at: row.verified_at, country: row.country ?? null };
    }

    const uha = await env.LEDGER
      .prepare("SELECT level, status, valid_until FROM uniqueness_attestations WHERE member_id=?1 AND status='active' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .bind(memberId ?? '').first().catch(() => null);
    if (uha) t.uniqueness = { attested: true, level: uha.level, valid_until: uha.valid_until };

    const sessions = await env.LEDGER
      .prepare("SELECT COUNT(*) n, SUM(status='active') passed, SUM(status='rejected') rejected, ROUND(AVG(score_v),3) avg_score FROM verified_sessions WHERE member_id=?1")
      .bind(memberId ?? '').first().catch(() => null);
    if (sessions?.n) {
      // Proof-of-human-work: sessions scored on focus, input consistency and
      // probe pass rate. The rejections are the point — a screen that never
      // rejects is not a screen.
      t.work = { sessions: sessions.n, passed: sessions.passed, rejected: sessions.rejected, avg_score: sessions.avg_score };
    }
  }
  return t;
}
