/**
 * Posting NUM jobs to the 5arz board.
 *
 * Companion to `fivearz.mjs`, which handles the *verification* side
 * (personhood credentials, JWKS, transaction binding). This file handles the
 * *work* side: a NUM host needs something done, we post it to 5arz, a verified
 * human does it, we approve and they get paid.
 *
 * Same conventions as its sibling — ESM, `fetchImpl` injected so tests never
 * touch the network, the same `FIVEARZ_API_KEY` secret, the same
 * `{ ok: false, reason }` shape on failure.
 *
 * ── WHAT WE ARE BUYING ───────────────────────────────────────────────────
 *
 * 5arz's job rail is the *staffing* shape, not the *custody* shape: NUM pays
 * 5arz for work, 5arz engages and pays the worker from its own funds. NUM's
 * money is 5arz's the moment it arrives. That is why this rail is open while
 * their member-to-member board is not — and it is why there is no "pay this
 * person" call in this file. We buy work. We never direct their money.
 *
 * ── THE TWO THINGS THAT WILL BITE ────────────────────────────────────────
 *
 * 1. `externalRef` IS THE IDEMPOTENCY KEY. 5arz enforces one job per
 *    (partner, externalRef) with a unique index. A retry returns the existing
 *    job with `duplicate: true` instead of posting a second one — which
 *    matters because a duplicate there is a duplicate payment obligation here.
 *    Always derive it from something stable on our side (the NUM job id), never
 *    from a timestamp or a random value.
 *
 * 2. WEBHOOK DELIVERY IS AT-LEAST-ONCE. A lost acknowledgement means 5arz
 *    retries, so the same `eventId` can arrive twice. Dedupe on it before
 *    acting, or a host gets told their job finished twice — and if we ever
 *    trigger billing from the event, they get billed twice.
 *
 * ── WHAT WE DO NOT GET, ON PURPOSE ───────────────────────────────────────
 *
 * The worker's identity. 5arz returns a stable pseudonymous `workerRef` so we
 * can recognise a repeat worker across jobs, and nothing else. Do not build a
 * feature that needs their name or contact — it is not coming, and asking for
 * it is asking 5arz to break their own promise to the person who did the work.
 */

export const API_BASE = 'https://api.5arz.com';
export const USER_AGENT = 'num-host-board (+https://itsnum.com)';

/** Job lifecycle as 5arz reports it. `disputed` means a human there is deciding. */
export const STATUS = Object.freeze({
  PENDING_REVIEW: 'pending_review',   // 5arz is reviewing the post itself
  APPROVED: 'approved',               // live on the board, nobody has taken it
  CLAIMED: 'claimed',                 // somebody is working on it
  SUBMITTED: 'submitted',             // delivered, waiting on US to approve
  COMPLETED: 'completed',             // approved and paid
  DISPUTED: 'disputed',               // we rejected it; 5arz is arbitrating
  REJECTED: 'rejected',               // 5arz declined the post; stars returned
  EXPIRED: 'expired',                 // nobody claimed it, or we cancelled
});

/** Events 5arz pushes, and the only ones worth reacting to. */
export const EVENTS = Object.freeze({
  POSTED: 'job.posted',
  CLAIMED: 'job.claimed',
  SUBMITTED: 'job.submitted',     // ← the one that needs a host decision
  COMPLETED: 'job.completed',
  DISPUTED: 'job.disputed',
  CANCELLED: 'job.cancelled',
});

const no = (reason, extra = {}) => ({ ok: false, reason, ...extra });

async function call(env, path, { method = 'GET', body, query } = {}, fetchImpl = fetch) {
  if (!env?.FIVEARZ_API_KEY) return no('no 5arz key configured on this Worker');
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${env.FIVEARZ_API_KEY}`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return no(`could not reach 5arz: ${e?.message ?? e}`);
  }
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Pass the machine-readable code through. `insufficient_balance` and
    // `daily_cap_reached` are operational, not bugs, and the caller should be
    // able to branch on them without string-matching a sentence.
    return no(`5arz said ${res.status}: ${parsed?.error ?? parsed?.message ?? 'no reason given'}`, {
      status: res.status,
      code: parsed?.error ?? null,
      raw: parsed,
    });
  }
  return { ok: true, ...parsed };
}

/**
 * What are we allowed to do right now — balance, ceilings, whether the rail is
 * even open. Call this before showing a host a "post this job" button, so we
 * never take their instruction and then fail on budget.
 */
export async function jobsConfig(env, fetchImpl = fetch) {
  return call(env, '/api/partner/jobs/config', {}, fetchImpl);
}

/**
 * Post a job.
 *
 * `stars` is the worker's pay in 5arz Stars, where 1 star = $1 of work. Price
 * it like real work: an underpriced job sits on the board unclaimed, which
 * costs the host more in delay than the difference ever saved.
 *
 * `proofSpec.checklist` is the contract. 5arz's standing rule is that the
 * worker is paid for work delivered to the stated checklist, NOT for the buyer
 * liking it — so anything the host actually needs has to be written down here.
 * A vague checklist is how a host ends up paying for something they did not want.
 */
export async function postJob(env, job, fetchImpl = fetch) {
  const externalRef = String(job?.externalRef ?? '').trim();
  if (!externalRef) return no('externalRef is required — use the NUM job id, never a timestamp');
  if (!job?.title || String(job.title).trim().length < 5) return no('title must be at least 5 characters');
  if (!job?.description || String(job.description).trim().length < 15) {
    return no('description must be at least 15 characters — the person doing this has no other context');
  }
  const stars = Math.floor(Number(job.stars) || 0);
  if (stars < 2) return no('stars must be at least 2');

  const out = await call(env, '/api/partner/jobs', {
    method: 'POST',
    body: {
      externalRef,
      title: String(job.title).trim().slice(0, 100),
      description: String(job.description).trim().slice(0, 1000),
      category: job.category ? String(job.category).slice(0, 32) : 'other',
      stars,
      ...(job.deliveryDays ? { deliveryDays: Math.floor(Number(job.deliveryDays)) } : {}),
      ...(Array.isArray(job.skills) && job.skills.length ? { skills: job.skills.slice(0, 6) } : {}),
      ...(job.proofSpec ? { proofSpec: job.proofSpec } : {}),
      // Opaque passthrough. Put the NUM host id here so a webhook can be
      // routed back to the right host without a second lookup.
      ...(job.meta ? { meta: job.meta } : {}),
    },
  }, fetchImpl);

  if (!out.ok) return out;
  // `duplicate: true` is a SUCCESS. It means our retry was absorbed.
  return { ok: true, duplicate: out.duplicate === true, job: out.job ?? null, message: out.message ?? null };
}

/** Our jobs and their current state. Use this as the poll fallback. */
export async function listJobs(env, { status, externalRef, limit } = {}, fetchImpl = fetch) {
  return call(env, '/api/partner/jobs', { query: { status, externalRef, limit } }, fetchImpl);
}

/** One job, by our own reference. */
export async function getJob(env, externalRef, fetchImpl = fetch) {
  const out = await listJobs(env, { externalRef, limit: 1 }, fetchImpl);
  if (!out.ok) return out;
  const job = (out.jobs || [])[0] ?? null;
  return job ? { ok: true, job } : no('no job on this account with that externalRef');
}

/**
 * Accept the work. This releases payment to the worker and cannot be undone
 * from here, so only call it once the host has actually said yes.
 */
export async function approveJob(env, { externalRef, jobId }, fetchImpl = fetch) {
  if (!externalRef && !jobId) return no('externalRef or jobId is required');
  return call(env, '/api/partner/jobs/approve', { method: 'POST', body: { externalRef, jobId } }, fetchImpl);
}

/**
 * Contest the work. This does NOT cancel payment — it opens an arbitration at
 * 5arz, and if the delivered work met the published checklist the worker is
 * paid anyway. Write the reason for the person at 5arz who will read it, not
 * for our own logs.
 */
export async function rejectJob(env, { externalRef, jobId, reason }, fetchImpl = fetch) {
  if (!externalRef && !jobId) return no('externalRef or jobId is required');
  if (!reason || String(reason).trim().length < 10) {
    return no('reason must be at least 10 characters — a person did this work and a human at 5arz reads your reason');
  }
  return call(env, '/api/partner/jobs/reject', {
    method: 'POST', body: { externalRef, jobId, reason: String(reason).trim() },
  }, fetchImpl);
}

/** Withdraw a job nobody has claimed yet. Stars come back to our balance. */
export async function cancelJob(env, { externalRef, jobId }, fetchImpl = fetch) {
  if (!externalRef && !jobId) return no('externalRef or jobId is required');
  return call(env, '/api/partner/jobs/cancel', { method: 'POST', body: { externalRef, jobId } }, fetchImpl);
}

/**
 * Pull the event log. The safety net for a webhook we missed — a stale URL, a
 * deploy window, a bug in our handler. Page forward with the returned
 * `nextSince`.
 */
export async function pullEvents(env, { since = 0, limit = 50 } = {}, fetchImpl = fetch) {
  return call(env, '/api/partner/jobs/events', { query: { since, limit } }, fetchImpl);
}

/* ------------------------------------------------------------------ *
 * Receiving webhooks
 * ------------------------------------------------------------------ */

/**
 * Verify a 5arz webhook signature.
 *
 * Same scheme as every other 5arz webhook: `X-5arz-Signature: sha256=<hex>`
 * over the RAW request body, keyed by the secret 5arz gave us when we
 * registered the hook.
 *
 * Two rules, both of which have burned people on this exact pattern:
 *   · Verify against the raw body text, NOT a re-serialised object. Any
 *     round-trip through JSON.parse/stringify can reorder keys and the HMAC
 *     will not match.
 *   · Compare in constant time. A byte-by-byte early return leaks the
 *     signature one character at a time to anyone willing to retry.
 */
export async function verifyWebhook(secret, rawBody, signatureHeader, cryptoImpl = crypto) {
  if (!secret) return no('no webhook secret configured');
  const given = String(signatureHeader || '').trim();
  if (!given.startsWith('sha256=')) return no('missing or malformed X-5arz-Signature');
  const key = await cryptoImpl.subtle.importKey(
    'raw', new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await cryptoImpl.subtle.sign('HMAC', key, new TextEncoder().encode(String(rawBody)));
  const expected = 'sha256=' + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== given.length) return no('signature mismatch');
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  if (diff !== 0) return no('signature mismatch');
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return no('body is not JSON'); }
  return {
    ok: true,
    event: payload.event ?? null,
    /** Dedupe on this. Delivery is at-least-once. */
    eventId: payload.eventId ?? null,
    jobId: payload.data?.jobId ?? null,
    externalRef: payload.data?.externalRef ?? null,
    data: payload.data ?? {},
    ts: payload.ts ?? null,
  };
}

/**
 * Should we act on this event, or have we seen it already?
 *
 * Pass a D1 binding with a table that has a unique index on the event id. The
 * INSERT either succeeds (first time — act) or violates the index (a retry —
 * skip). Doing it as an insert rather than a SELECT-then-INSERT is what makes
 * it safe against two deliveries landing at the same moment.
 *
 *   CREATE TABLE IF NOT EXISTS fivearz_job_events (
 *     event_id   TEXT PRIMARY KEY,
 *     event      TEXT NOT NULL,
 *     job_id     TEXT,
 *     external_ref TEXT,
 *     received_at INTEGER NOT NULL
 *   );
 */
export async function claimEventOnce(db, { eventId, event, jobId, externalRef }, now = Date.now()) {
  if (!db) return no('no database binding');
  if (!eventId) return no('eventId is required — without it a retry double-fires');
  try {
    const r = await db.prepare(
      'INSERT OR IGNORE INTO fivearz_job_events (event_id, event, job_id, external_ref, received_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(eventId, event ?? null, jobId ?? null, externalRef ?? null, now).run();
    const inserted = r?.meta?.changes ? true : false;
    return { ok: true, fresh: inserted, duplicate: !inserted };
  } catch (e) {
    return no(`could not record the event: ${e?.message ?? e}`);
  }
}
