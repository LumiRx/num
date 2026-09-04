/**
 * DID IT ARRIVE — the question this system has never been able to answer.
 *
 * ── WHAT HAPPENED ────────────────────────────────────────────────────────
 *
 * 30 Aug 2026, 20:26. Six approved businesses were handed to the mailer. Every
 * send returned ok, and `num_claim_decisions.onboarded` was set to 1 on all
 * six — Holiday Inn Express, Fingal, Giuliano's, Awafi, makani, Morrisons
 * Lounge. Not one of them received anything.
 *
 * Nothing was broken in a way anything could see. The transport accepted the
 * messages; acceptance is all a transport ever reports at send time. The
 * system asked "did somebody take this from me" and wrote the answer into a
 * column named `onboarded`.
 *
 * ── THE RULE THIS FILE ENFORCES ──────────────────────────────────────────
 *
 * Accepted and delivered are different facts and get different columns.
 *
 *   onboard_at    we handed it over, and here is the provider's id for it.
 *                 This is what stops us sending twice. It is NOT evidence.
 *   delivered_at  the provider told us it landed in a mailbox. Evidence.
 *   bounced_at    the provider told us it did not, and why.
 *
 * A message accepted and never confirmed is not "sent". It is
 * `biz_onboard_unconfirmed` — a visible, open failure on /api/health thirty
 * minutes later. On 30 Aug that would have been six of them by 20:56, on the
 * evening it happened, instead of four days of silence and a founder reading
 * the database by hand.
 *
 * ── WHY THE UNCONFIRMED ONES ARE NOT SIMPLY RE-SENT ──────────────────────
 *
 * Because the failure mode of "retry until confirmed" is mailing a hotel the
 * same welcome forty times, and a webhook that was never configured looks
 * exactly like a message that never arrived. So `onboard_at` still enforces
 * at-most-once, and the un-confirmed state is escalated to a human rather
 * than resolved by a loop. Nobody gets spammed, and nobody gets forgotten.
 */

import { record, resolve } from './failures.mjs';

const COLUMNS = [
  'ALTER TABLE num_claim_decisions ADD COLUMN onboard_via TEXT',
  'ALTER TABLE num_claim_decisions ADD COLUMN onboard_ref TEXT',
  'ALTER TABLE num_claim_decisions ADD COLUMN onboard_at INTEGER',
  'ALTER TABLE num_claim_decisions ADD COLUMN delivered_at INTEGER',
  'ALTER TABLE num_claim_decisions ADD COLUMN bounced_at INTEGER',
  'ALTER TABLE num_claim_decisions ADD COLUMN bounce_reason TEXT',
];
const EVENTS = `
CREATE TABLE IF NOT EXISTS num_mail_events (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  ref        TEXT,
  event      TEXT NOT NULL,
  email      TEXT,
  detail     TEXT,
  at         INTEGER NOT NULL
)`;

const built = new WeakSet();

/**
 * Run one DDL statement and never let it matter.
 *
 * Schema setup must not be able to break a send. The failure this whole file
 * exists to prevent was a message that went out and was mis-recorded; a
 * migration that throws AFTER a successful send would lose the record
 * entirely, which is strictly worse.
 */
async function ddl(db, sql) {
  try {
    const st = db.prepare(sql);
    const r = typeof st?.run === 'function' ? st : (typeof st?.bind === 'function' ? st.bind() : null);
    if (r && typeof r.run === 'function') await r.run();
  } catch { /* already applied, or a stub that does not do DDL */ }
}

async function ensure(env) {
  const db = env?.DB;
  if (!db || built.has(db)) return;
  // ALTERs run one at a time and each swallows its own "duplicate column".
  // A batch would roll the whole set back on the second deploy.
  for (const c of COLUMNS) await ddl(db, c);
  await ddl(db, EVENTS);
  await ddl(db, 'CREATE INDEX IF NOT EXISTS idx_mail_events_ref ON num_mail_events(ref)');
  built.add(db);
}

/** Record the handover. Not a claim that anybody read it. */
export async function accepted(env, claimId, { via, ref }) {
  if (!env?.DB || !claimId) return;
  try {
    await ensure(env);
  } catch { /* see ddl(): schema setup never costs us a record */ }
  await env.DB.prepare(
    `UPDATE num_claim_decisions
        SET onboarded = 1, onboard_via = ?2, onboard_ref = ?3, onboard_at = ?4,
            delivered_at = NULL, bounced_at = NULL, bounce_reason = NULL
      WHERE claim_id = ?1`,
  ).bind(String(claimId), String(via ?? ''), String(ref ?? ''), Math.floor(Date.now() / 1000))
    .run().catch(() => {});
}

/**
 * The sweep. Anything handed over and still unconfirmed after `graceMin` is a
 * failure with a name — the one that would have caught 30 Aug within the hour.
 */
export async function checkUnconfirmed(env, { graceMin = 30 } = {}) {
  if (!env?.DB) return { checked: 0, unconfirmed: 0 };
  await ensure(env);
  const cutoff = Math.floor(Date.now() / 1000) - graceMin * 60;
  const { results } = await env.DB.prepare(
    `SELECT d.claim_id, d.onboard_via, d.onboard_at, c.business_name, c.email
       FROM num_claim_decisions d
       JOIN claims c ON CAST(c.id AS TEXT) = d.claim_id
      WHERE d.onboarded = 1
        AND d.onboard_at IS NOT NULL
        AND d.onboard_at < ?1
        AND d.delivered_at IS NULL
        AND d.bounced_at IS NULL
      LIMIT 50`,
  ).bind(cutoff).all().catch(() => ({ results: [] }));

  for (const r of results ?? []) {
    await record(env, {
      kind: 'biz_onboard_unconfirmed',
      subject: `${r.business_name ?? r.claim_id} <${r.email}>`,
      detail: `Handed to ${r.onboard_via || 'a transport'} at `
        + `${new Date((r.onboard_at ?? 0) * 1000).toISOString()} and no delivery has been reported since. `
        + 'Either the provider webhook is not configured, or this never reached a mailbox. '
        + 'It will NOT be re-sent automatically — that is how a hotel gets the same welcome forty times.',
      severity: 'high',
    });
  }
  return { checked: (results ?? []).length, unconfirmed: (results ?? []).length };
}

/**
 * POST /api/webhooks/resend
 *
 * Signature-verified, and it FAILS CLOSED: with no RESEND_WEBHOOK_SECRET set
 * this endpoint refuses everything. An unauthenticated webhook that writes
 * "delivered" into our records is a stranger with a pen — anybody could mark
 * a business as told.
 */
export async function handleResendWebhook(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const secret = env?.RESEND_WEBHOOK_SECRET;
  const raw = await request.text().catch(() => '');
  if (!secret) {
    await record(env, {
      kind: 'mail_webhook_unconfigured',
      subject: 'resend',
      detail: 'A delivery webhook arrived with no RESEND_WEBHOOK_SECRET set, so it was refused. '
        + 'Until this is configured, no email can ever be CONFIRMED delivered — only handed over.',
      severity: 'high',
    });
    return json({ error: 'not configured' }, 503);
  }
  if (!(await validSvix(request, raw, secret))) return json({ error: 'bad signature' }, 401);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  const type = String(body?.type ?? '');
  const data = body?.data ?? {};
  const ref = String(data.email_id ?? data.id ?? '');
  const to = Array.isArray(data.to) ? data.to[0] : String(data.to ?? '');
  await ensure(env);

  await env.DB?.prepare(
    'INSERT OR IGNORE INTO num_mail_events (id, provider, ref, event, email, detail, at) VALUES (?1,?2,?3,?4,?5,?6,?7)',
  ).bind(
    `${ref || 'x'}:${type}`, 'resend', ref, type, to,
    String(data.reason ?? data.bounce?.message ?? '').slice(0, 300), Math.floor(Date.now() / 1000),
  ).run().catch(() => {});

  if (type === 'email.delivered') {
    await env.DB?.prepare(
      'UPDATE num_claim_decisions SET delivered_at = ?2 WHERE onboard_ref = ?1',
    ).bind(ref, Math.floor(Date.now() / 1000)).run().catch(() => {});
    // It arrived. Close both the "could not send" and the "never confirmed"
    // rows for this address rather than leaving a fixed problem on the board.
    for (const kind of ['biz_onboard_unsent', 'biz_onboard_unconfirmed']) {
      await resolveByEmail(env, kind, to);
    }
  } else if (type === 'email.bounced' || type === 'email.complained') {
    const why = String(data.reason ?? data.bounce?.message ?? type).slice(0, 200);
    await env.DB?.prepare(
      `UPDATE num_claim_decisions
          SET bounced_at = ?2, bounce_reason = ?3,
              -- Cleared so a corrected address can be tried. The bounce is
              -- evidence that this one was never told; leaving it at 1 would
              -- repeat the exact mistake of 30 Aug.
              onboarded = 0
        WHERE onboard_ref = ?1`,
    ).bind(ref, Math.floor(Date.now() / 1000), why).run().catch(() => {});
    if (to && type === 'email.complained') {
      await env.DB?.prepare(
        'INSERT OR IGNORE INTO num_suppressions (email, reason, note) VALUES (?1, ?2, ?3)',
      ).bind(to, 'complaint', why).run().catch(() => {});
    }
    await record(env, {
      kind: type === 'email.complained' ? 'mail_complaint' : 'mail_bounced',
      subject: to || ref,
      detail: why,
      severity: type === 'email.complained' ? 'high' : 'high',
    });
  }
  return json({ ok: true });
}

async function resolveByEmail(env, kind, email) {
  if (!env?.DB || !email) return;
  // The ledger's subject is "Business Name <email>", so match on the address.
  const { results } = await env.DB.prepare(
    "SELECT kind, subject FROM num_failures WHERE kind = ?1 AND subject LIKE ?2 AND resolved_at IS NULL",
  ).bind(kind, `%${email}%`).all().catch(() => ({ results: [] }));
  for (const r of results ?? []) await resolve(env, r.kind, r.subject);
}

/** Svix signature — the scheme Resend uses. Constant-time compare. */
async function validSvix(request, raw, secret) {
  try {
    const id = request.headers.get('svix-id');
    const ts = request.headers.get('svix-timestamp');
    const sig = request.headers.get('svix-signature');
    if (!id || !ts || !sig) return false;
    // Five minutes, so a captured request cannot be replayed tomorrow.
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const keyB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    const key = await crypto.subtle.importKey(
      'raw', base64ToBytes(keyB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${raw}`));
    const want = bytesToBase64(new Uint8Array(mac));
    // The header carries one or more space-separated `v1,<sig>` values.
    return sig.split(' ').some((part) => timingSafeEqual(part.split(',')[1] ?? '', want));
  } catch { return false; }
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
