// The payout desk. Read the ledger, check who is safe to pay, queue it, have a
// human approve it, and execute — with an audit line at every step.
//
// Two rules the code enforces rather than trusts:
//
//   1. A `block` finding cannot be approved. There is no override, because the
//      blocks are things like "this wallet is the USDC contract" — an override
//      is just a slower way to lose the money.
//   2. Nothing is marked sent unless a rail adapter actually sent it. Every
//      adapter is unready today, so the desk can prepare and approve, and will
//      say plainly that it cannot execute. A queue that lies about what it did
//      is worse than no queue.
//
// Stars are HELD when a cashout is requested and DEBITED when it settles, never
// at request time. A member whose balance vanishes on a payout that later fails
// does not come back.
import { buildContext, checkMember, worstSeverity, NEVER_PAY } from './preflight.mjs';
import { ADAPTERS, STAR_CENTS, chooseRail, railReady, readyRails } from './rails.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const now = () => Math.floor(Date.now() / 1000);

// ── auth: identical scheme to the operator console ──────────────────────────
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}
function safeEq(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
async function sessionValid(env, token) {
  const [p, sig] = String(token ?? '').split('.');
  if (!p || !sig || !env.ADMIN_KEY) return false;
  if (!safeEq(sig, await hmac(env, p))) return false;
  try {
    const { exp } = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}
async function mintSession(env) {
  const p = b64url(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + 12 * 3600_000 })));
  return `${p}.${await hmac(env, p)}`;
}

async function audit(env, { cashoutId, memberId, action, actor, detail, ip }) {
  try {
    await env.LEDGER.prepare(
      'INSERT INTO payout_audit (id, cashout_id, member_id, action, actor, detail_json, ip, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)',
    ).bind(crypto.randomUUID(), cashoutId ?? null, memberId ?? null, action, actor ?? 'operator', JSON.stringify(detail ?? {}), ip ?? null, now()).run();
  } catch (err) {
    console.warn('[payout-audit]', err?.message ?? err);
  }
}

// ── the desk ────────────────────────────────────────────────────────────────

/**
 * Everyone with a balance, checked. This is the screen an operator opens
 * before sending anything.
 */
async function roster(env, url) {
  const minStars = Number(url.searchParams.get('min') ?? 1);

  const [{ results: finances }, { results: members }, { results: methods }, { results: rails }, { results: debts }] = await Promise.all([
    env.LEDGER.prepare('SELECT member_id, stars_earned, payout_status, payout_total_sent_cents FROM member_finance WHERE stars_earned >= ?1').bind(minStars).all(),
    env.LEDGER.prepare('SELECT id, email_lower, name, country, verified_at, msa_signed_at, frozen_at, frozen_reason, payout_method, payout_account_ref FROM members').all(),
    env.LEDGER.prepare('SELECT id, member_id, rail, external_id, status, country, currency, is_default FROM payout_methods').all(),
    env.LEDGER.prepare('SELECT country, rail, priority, min_amount_cents, max_amount_cents FROM payout_country_rails').all(),
    env.LEDGER.prepare("SELECT member_id, SUM(balance_cents) open_cents FROM debts WHERE status != 'paid' GROUP BY member_id").all().catch(() => ({ results: [] })),
  ]);

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));
  const methodsByMember = new Map();
  for (const m of methods ?? []) {
    if (!methodsByMember.has(m.member_id)) methodsByMember.set(m.member_id, []);
    methodsByMember.get(m.member_id).push(m);
  }
  const debtByMember = new Map((debts ?? []).map((d) => [d.member_id, d.open_cents]));
  const context = buildContext(methods ?? []);

  const rows = (finances ?? [])
    .map((f) => {
      const member = memberById.get(f.member_id);
      const mine = methodsByMember.get(f.member_id) ?? [];
      const method = mine.find((m) => m.is_default && m.status === 'enabled') ?? mine.find((m) => m.status === 'enabled') ?? mine[0] ?? null;
      const countryRails = (rails ?? []).filter((r) => r.country === member?.country);
      const amountCents = f.stars_earned * STAR_CENTS;
      const findings = checkMember({
        member,
        finance: f,
        method,
        rails: countryRails,
        context: { ...context, openDebtCents: debtByMember.get(f.member_id) ?? 0 },
      });
      const routing = chooseRail({ member, methods: mine, countryRails, amountCents, env });
      const severity = worstSeverity(findings);
      return {
        member_id: f.member_id,
        name: member?.name ?? null,
        email: member?.email_lower ?? null,
        country: member?.country ?? null,
        verified: !!member?.verified_at,
        stars: f.stars_earned,
        amount_cents: amountCents,
        method: method ? { id: method.id, rail: method.rail, destination: method.external_id, status: method.status } : null,
        rail: routing.chosen?.rail ?? null,
        rail_ready: routing.chosen ? railReady(env, routing.chosen.rail) : false,
        blocked_reason: routing.blocked_reason,
        severity,
        payable: severity !== 'block' && !!routing.chosen,
        findings,
      };
    })
    .sort((a, b) => b.stars - a.stars);

  const totals = rows.reduce(
    (acc, r) => {
      acc.stars += r.stars;
      acc[r.severity] = (acc[r.severity] ?? 0) + 1;
      if (r.payable) acc.payable_cents += r.amount_cents;
      return acc;
    },
    { stars: 0, payable_cents: 0 },
  );

  // A check that fires on every row is not a signal, it is noise — so the
  // things that are wrong with the PROGRAMME rather than with a person are
  // lifted out and stated once.
  const systemic = [];
  const noDestination = rows.filter((r) => r.findings.some((f) => f.code === 'no_method'));
  if (noDestination.length) {
    systemic.push({
      code: 'no_destination',
      severity: 'block',
      message: `${noDestination.length} of ${rows.length} people with a balance have no payout destination at all — ${(noDestination.reduce((n, r) => n + r.amount_cents, 0) / 100).toFixed(2)} cannot move until they add one.`,
      fix: 'Prompt for a destination in the app. Eleven people set up a wallet in one tap and nobody finished Connect onboarding — make the wallet the default path.',
    });
  }
  const unsigned = rows.filter((r) => r.findings.some((f) => f.code === 'no_msa'));
  if (unsigned.length === rows.length && rows.length) {
    systemic.push({
      code: 'no_agreements',
      severity: 'hold',
      message: `Nobody has a signed agreement on file — this holds every payout, not just some.`,
      fix: 'Either collect signatures before the first payout, or decide explicitly that the agreement is not a precondition and drop the check.',
    });
  }
  const unready = [...new Set(rows.map((r) => r.rail).filter(Boolean))].filter((r) => !railReady(env, r));
  if (unready.length) {
    systemic.push({
      code: 'no_rail_connected',
      severity: 'block',
      message: `The chosen rail${unready.length > 1 ? 's are' : ' is'} ${unready.join(', ')}, and none of them are connected — nothing can actually be sent yet.`,
      fix: unready.map((r) => `${r}: ${ADAPTERS[r]?.needs}`).join(' · '),
    });
  }

  return json({
    rows,
    systemic,
    totals: { ...totals, members: rows.length },
    rails: {
      ready: readyRails(env),
      all: Object.entries(ADAPTERS).map(([id, a]) => ({ id, label: a.label, ready: a.ready(env), needs: a.needs })),
    },
    // Stated so it is never inferred from a number on a screen.
    star_cents: STAR_CENTS,
  });
}

/** One member, in full — used before an operator commits to a payment. */
async function inspect(env, url) {
  const id = clip(url.searchParams.get('member'), 60);
  if (!id) return json({ error: 'member required' }, 400);
  const member = await env.LEDGER.prepare('SELECT * FROM members WHERE id=?1').bind(id).first();
  if (!member) return json({ error: 'no such member' }, 404);
  const finance = await env.LEDGER.prepare('SELECT * FROM member_finance WHERE member_id=?1').bind(id).first();
  const { results: mine } = await env.LEDGER.prepare('SELECT * FROM payout_methods WHERE member_id=?1').bind(id).all();
  const { results: allMethods } = await env.LEDGER.prepare("SELECT member_id, rail, external_id FROM payout_methods WHERE rail='usdc_base'").all();
  const { results: countryRails } = await env.LEDGER.prepare('SELECT * FROM payout_country_rails WHERE country=?1').bind(member.country ?? '').all();
  const { results: history } = await env.LEDGER.prepare('SELECT * FROM cashout_requests WHERE member_id=?1 ORDER BY created_at DESC LIMIT 10').bind(id).all();
  const { results: ledger } = await env.LEDGER.prepare('SELECT delta, kind, reason, balance_after, created_at FROM stars_ledger WHERE member_id=?1 ORDER BY id DESC LIMIT 15').bind(id).all();

  const method = (mine ?? []).find((m) => m.is_default && m.status === 'enabled') ?? (mine ?? [])[0] ?? null;
  const amountCents = (finance?.stars_earned ?? 0) * STAR_CENTS;
  const findings = checkMember({ member, finance, method, rails: countryRails ?? [], context: buildContext(allMethods ?? []) });

  return json({
    member,
    finance,
    methods: mine ?? [],
    findings,
    severity: worstSeverity(findings),
    routing: chooseRail({ member, methods: mine ?? [], countryRails: countryRails ?? [], amountCents, env }),
    history: history ?? [],
    stars_ledger: ledger ?? [],
  });
}

/**
 * Queue a payout. Stars are HELD here, not spent: the balance moves out of
 * `stars_earned` into the request, and only settles when the money actually
 * lands. A `block` finding refuses outright.
 */
async function requestPayout(env, req, ip) {
  const b = await readBody(req);
  const memberId = clip(b.member_id, 60);
  const stars = Math.floor(Number(b.stars));
  if (!memberId || !Number.isFinite(stars) || stars <= 0) return json({ error: 'member_id and a positive stars amount are required' }, 400);

  const member = await env.LEDGER.prepare('SELECT * FROM members WHERE id=?1').bind(memberId).first();
  const finance = await env.LEDGER.prepare('SELECT * FROM member_finance WHERE member_id=?1').bind(memberId).first();
  if (!member || !finance) return json({ error: 'no such member' }, 404);

  const { results: mine } = await env.LEDGER.prepare('SELECT * FROM payout_methods WHERE member_id=?1').bind(memberId).all();
  const { results: allMethods } = await env.LEDGER.prepare("SELECT member_id, rail, external_id FROM payout_methods WHERE rail='usdc_base'").all();
  const { results: countryRails } = await env.LEDGER.prepare('SELECT * FROM payout_country_rails WHERE country=?1').bind(member.country ?? '').all();
  const method = (mine ?? []).find((m) => m.is_default && m.status === 'enabled') ?? (mine ?? []).find((m) => m.status === 'enabled') ?? null;

  const findings = checkMember({ member, finance, method, rails: countryRails ?? [], context: buildContext(allMethods ?? []) });
  const severity = worstSeverity(findings);
  if (severity === 'block') {
    await audit(env, { memberId, action: 'request_refused', detail: { findings }, ip });
    return json({ error: 'This member cannot be paid.', findings }, 409);
  }
  if (stars > finance.stars_earned) return json({ error: `Only ${finance.stars_earned} Stars available.` }, 409);

  const amountCents = stars * STAR_CENTS;
  const routing = chooseRail({ member, methods: mine ?? [], countryRails: countryRails ?? [], amountCents, env });
  if (!routing.chosen) return json({ error: routing.blocked_reason }, 409);

  const id = crypto.randomUUID();
  const idem = clip(b.idempotency_key, 80) || id;

  const existing = await env.LEDGER.prepare('SELECT id, status FROM cashout_requests WHERE idempotency_key=?1').bind(idem).first();
  if (existing) return json({ ok: true, already: true, id: existing.id, status: existing.status });

  // HOLD: take it out of the spendable balance, do not call it paid.
  const held = await env.LEDGER.prepare('UPDATE member_finance SET stars_earned = stars_earned - ?2, updated_at = ?3 WHERE member_id = ?1 AND stars_earned >= ?2')
    .bind(memberId, stars, now()).run();
  if (!held.meta?.changes) return json({ error: 'Balance changed while preparing — nothing was held.' }, 409);

  try {
    await env.LEDGER.batch([
      env.LEDGER.prepare(
        `INSERT INTO cashout_requests (id, member_id, stars, amount_cents, rail_requested, payout_method_id, destination, status, flags_json, idempotency_key, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)`,
      ).bind(id, memberId, stars, amountCents, routing.chosen.rail, routing.chosen.method_id, routing.chosen.destination,
        severity === 'hold' ? 'review' : 'approved_pending_send', JSON.stringify(findings), idem, now()),
      env.LEDGER.prepare(
        "INSERT INTO stars_ledger (member_id, delta, kind, ref_id, reason, balance_after, created_at, created_by) VALUES (?1,?2,'cashout_hold',?3,?4,?5,?6,'payout-desk')",
      ).bind(memberId, -stars, id, 'Held for payout', finance.stars_earned - stars, now()),
    ]);
  } catch (err) {
    await env.LEDGER.prepare('UPDATE member_finance SET stars_earned = stars_earned + ?2 WHERE member_id = ?1').bind(memberId, stars).run();
    console.error('[payout] hold rolled back', err?.message ?? err);
    return json({ error: 'Could not queue that — the hold was released.' }, 500);
  }

  await audit(env, { cashoutId: id, memberId, action: 'requested', detail: { stars, amountCents, rail: routing.chosen.rail, severity }, ip });
  return json({ ok: true, id, status: severity === 'hold' ? 'review' : 'approved_pending_send', severity, findings, rail: routing.chosen.rail, amount_cents: amountCents });
}

/** A human decides on anything the checks put in review. */
async function decide(env, req, ip) {
  const b = await readBody(req);
  const id = clip(b.id, 60);
  const approve = b.decision === 'approve';
  const row = await env.LEDGER.prepare('SELECT * FROM cashout_requests WHERE id=?1').bind(id ?? '').first();
  if (!row) return json({ error: 'no such request' }, 404);
  if (row.status !== 'review') return json({ error: `That request is "${row.status}", not in review.` }, 409);

  const findings = JSON.parse(row.flags_json || '[]');
  if (approve && findings.some((f) => f.severity === 'block')) {
    return json({ error: 'That request carries a blocking finding and cannot be approved.' }, 409);
  }

  if (!approve) {
    // Releasing the hold returns the Stars — a rejected payout must not cost
    // the member their balance.
    await env.LEDGER.batch([
      env.LEDGER.prepare("UPDATE cashout_requests SET status='rejected', reviewed_by=?2, reviewed_at=?3, review_note=?4, updated_at=?3 WHERE id=?1")
        .bind(id, clip(b.actor, 60) ?? 'operator', now(), clip(b.note, 500)),
      env.LEDGER.prepare('UPDATE member_finance SET stars_earned = stars_earned + ?2, updated_at=?3 WHERE member_id=?1').bind(row.member_id, row.stars, now()),
      env.LEDGER.prepare(
        "INSERT INTO stars_ledger (member_id, delta, kind, ref_id, reason, balance_after, created_at, created_by) VALUES (?1,?2,'cashout_release',?3,?4,NULL,?5,'payout-desk')",
      ).bind(row.member_id, row.stars, id, 'Payout rejected — Stars returned', now()),
    ]);
    await audit(env, { cashoutId: id, memberId: row.member_id, action: 'rejected', actor: b.actor, detail: { note: b.note }, ip });
    return json({ ok: true, status: 'rejected', released_stars: row.stars });
  }

  await env.LEDGER.prepare("UPDATE cashout_requests SET status='approved_pending_send', reviewed_by=?2, reviewed_at=?3, review_note=?4, updated_at=?3 WHERE id=?1")
    .bind(id, clip(b.actor, 60) ?? 'operator', now(), clip(b.note, 500)).run();
  await audit(env, { cashoutId: id, memberId: row.member_id, action: 'approved', actor: b.actor, detail: { note: b.note }, ip });
  return json({ ok: true, status: 'approved_pending_send' });
}

/**
 * Send it. This is the only place that may mark a payout paid, and it refuses
 * unless the rail's adapter is configured and actually returns a reference.
 */
async function execute(env, req, ip) {
  const b = await readBody(req);
  const id = clip(b.id, 60);
  const row = await env.LEDGER.prepare('SELECT * FROM cashout_requests WHERE id=?1').bind(id ?? '').first();
  if (!row) return json({ error: 'no such request' }, 404);
  if (row.status === 'paid') return json({ ok: true, already: true, provider_ref: row.provider_ref });
  if (row.status !== 'approved_pending_send') return json({ error: `That request is "${row.status}" — only approved requests can be sent.` }, 409);

  const adapter = ADAPTERS[row.rail_requested];
  if (!adapter?.ready(env)) {
    await audit(env, { cashoutId: id, memberId: row.member_id, action: 'send_unavailable', detail: { rail: row.rail_requested }, ip });
    return json({
      error: `${adapter?.label ?? row.rail_requested} is not connected, so nothing can be sent yet.`,
      needs: adapter?.needs ?? 'credentials for this rail',
      // The hold stays in place: the money is still owed, just not movable.
      status: row.status,
    }, 503);
  }

  let ref;
  try {
    ref = await adapter.send(env, { destination: row.destination, amountCents: row.amount_cents, idempotencyKey: row.idempotency_key });
  } catch (err) {
    await env.LEDGER.prepare("UPDATE cashout_requests SET status='failed', review_note=?2, updated_at=?3 WHERE id=?1").bind(id, String(err?.message ?? err).slice(0, 400), now()).run();
    await audit(env, { cashoutId: id, memberId: row.member_id, action: 'send_failed', detail: { error: String(err?.message ?? err) }, ip });
    return json({ error: 'The rail rejected it. The hold is still in place — nothing was lost.', status: 'failed' }, 502);
  }

  // CAPTURE: only now does the hold become a spend.
  await env.LEDGER.batch([
    env.LEDGER.prepare("UPDATE cashout_requests SET status='paid', provider=?2, provider_ref=?3, paid_at=?4, updated_at=?4 WHERE id=?1")
      .bind(id, row.rail_requested, String(ref).slice(0, 200), now()),
    env.LEDGER.prepare('UPDATE member_finance SET payout_total_sent_cents = COALESCE(payout_total_sent_cents,0) + ?2, updated_at=?3 WHERE member_id=?1')
      .bind(row.member_id, row.amount_cents, now()),
    env.LEDGER.prepare(
      "INSERT INTO stars_ledger (member_id, delta, kind, ref_id, reason, balance_after, created_at, created_by) VALUES (?1,0,'cashout_captured',?2,?3,NULL,?4,'payout-desk')",
    ).bind(row.member_id, id, `Paid ${(row.amount_cents / 100).toFixed(2)} via ${row.rail_requested}`, now()),
  ]);
  await audit(env, { cashoutId: id, memberId: row.member_id, action: 'paid', detail: { ref, amountCents: row.amount_cents }, ip });
  return json({ ok: true, status: 'paid', provider_ref: ref });
}

async function queue(env, url) {
  const status = clip(url.searchParams.get('status'), 40);
  const { results } = await env.LEDGER.prepare(
    `SELECT c.*, m.name, m.email_lower, m.country FROM cashout_requests c LEFT JOIN members m ON m.id=c.member_id
      ${status ? 'WHERE c.status = ?1' : ''} ORDER BY c.created_at DESC LIMIT 60`,
  ).bind(...(status ? [status] : [])).all();
  return json({ requests: (results ?? []).map((r) => ({ ...r, flags: JSON.parse(r.flags_json || '[]') })) });
}

async function auditLog(env, url) {
  const { results } = await env.LEDGER.prepare(
    `SELECT * FROM payout_audit ${url.searchParams.get('member') ? 'WHERE member_id = ?1' : ''} ORDER BY created_at DESC LIMIT 80`,
  ).bind(...(url.searchParams.get('member') ? [url.searchParams.get('member')] : [])).all();
  return json({ audit: results ?? [] });
}

/** The standing danger list, so the UI can explain a block without guessing. */
const rules = () => json({ never_pay: NEVER_PAY, star_cents: STAR_CENTS });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const post = request.method === 'POST';
    const ip = request.headers.get('CF-Connecting-IP') ?? null;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Session', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const reply = async () => {
      if (!env.LEDGER) return json({ error: 'ledger binding missing' }, 503);
      if (p === '/session' && post) {
        const b = await readBody(request);
        if (!env.ADMIN_KEY) return json({ error: 'no admin key configured' }, 503);
        if (!safeEq(b.key, env.ADMIN_KEY)) return json({ error: 'That key does not match.' }, 401);
        return json({ token: await mintSession(env) });
      }
      if (!(await sessionValid(env, request.headers.get('X-Admin-Session')))) return json({ error: 'unauthorized' }, 401);

      if (p === '/roster') return await roster(env, url);
      if (p === '/inspect') return await inspect(env, url);
      if (p === '/queue') return await queue(env, url);
      if (p === '/audit') return await auditLog(env, url);
      if (p === '/rules') return rules();
      if (p === '/request' && post) return await requestPayout(env, request, ip);
      if (p === '/decide' && post) return await decide(env, request, ip);
      if (p === '/execute' && post) return await execute(env, request, ip);
      return json({ error: 'not found' }, 404);
    };

    try {
      const res = await reply();
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    } catch (err) {
      console.error('[payouts]', p, err?.message ?? err);
      return json({ error: 'that didn’t go through' }, 500);
    }
  },
};
