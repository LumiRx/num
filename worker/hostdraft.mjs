/**
 * NUM DRAFTS THE HOST'S REPLY.
 *
 * The host console has shown a "what NUM proposes" field since 1 Sep 2026
 * (`num_host_requests.draft_text`). Nothing ever wrote to it. A field that
 * is always empty teaches the host that NUM's part of the loop is decorative.
 *
 * The same pattern as bizagent.mjs / bizdossier.mjs: a small model writes a
 * DRAFT, in the host's voice, for the host to edit and send. It never sends.
 * It never promises a price the host did not list, never invents a supplier,
 * never says "confirmed" — it says what the host would say in the first two
 * minutes: I have it, here is what I will check, here is when you will hear.
 *
 * Runs from the cron over NEW requests with no draft, a few per tick, and
 * files a low-severity failure if the model is unreachable rather than
 * retrying the same request forever.
 */
import { SERVICE_LABELS } from './hostaware.mjs';

const clip = (s, n) => (s == null ? '' : String(s).trim().slice(0, n));

/** The prompt — exported so the test can pin what the model is asked. */
export function draftPrompt({ host, request, client }) {
  const service = SERVICE_LABELS[request.service_key] ?? 'something';
  const priced = request.price_minor > 0 && request.unit !== 'quote'
    ? `${request.currency} ${(request.price_minor / 100).toFixed(2)} per ${request.unit}` : 'a quote — do not invent a number';
  return [
    `You are drafting a SHORT first reply from ${host.name}, a personal concierge (a "VIP host"), to their client ${client?.name || 'the client'}.`,
    `The client asked for ${service}: "${clip(request.title, 160)}".`,
    request.detail ? `Details: ${clip(request.detail, 800)}` : null,
    request.starts_at ? `When: ${request.starts_at}` : null,
    request.party_size ? `Party: ${request.party_size}` : null,
    request.city ? `Where: ${request.city}` : null,
    `${host.name}'s listed price for this: ${priced}.`,
    '',
    'Write 2–3 sentences in first person as the host, warm and specific. Acknowledge exactly what was asked, say the one thing you will check, and when they will hear back (today / this evening / tomorrow morning). ' +
    'NEVER say confirmed, booked, arranged or done. NEVER name a supplier, a venue or a price the brief above does not give. No sign-off, no subject line, no emoji. Plain text only.',
  ].filter((l) => l !== null).join('\n');
}

async function ask(env, prompt, { fetchImpl = fetch } = {}) {
  if (!env?.ANTHROPIC_API_KEY) return null;
  const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.NUM_RESEARCH_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 220,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const j = await r.json().catch(() => null);
  const text = (j?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  return text || null;
}

const FORBIDDEN = /\b(confirmed|booked|arranged|all set|done deal|reserved)\b/i;

/** The guard the model's words must pass. Exported for the test. */
export function acceptable(text) {
  if (!text) return false;
  if (text.length < 20 || text.length > 700) return false;
  if (FORBIDDEN.test(text)) return false;
  if (/https?:\/\//i.test(text)) return false;
  return true;
}

export async function draftSweep(env, { limit = 5, fetchImpl } = {}) {
  if (!env?.DB) return { drafted: 0, skipped: 0 };
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT r.id, r.service_key, r.title, r.detail, r.city, r.starts_at, r.party_size, r.price_minor, r.currency, r.unit,
              h.name AS host_name, c.name AS client_name
         FROM num_host_requests r
         JOIN num_hosts h ON h.id = r.host_id AND h.status = 'active'
         LEFT JOIN num_host_clients c ON c.id = r.client_id
        WHERE r.status = 'new' AND (r.draft_text IS NULL OR r.draft_text = '')
        ORDER BY r.created_at ASC LIMIT ?1`,
    ).bind(limit).all());
  } catch (e) {
    if (!/no such (table|column)/i.test(String(e?.message ?? e))) console.warn('[hostdraft] sweep', e?.message ?? e);
    return { drafted: 0, skipped: 0 };
  }
  let drafted = 0, skipped = 0;
  for (const r of rows ?? []) {
    const text = await ask(env, draftPrompt({ host: { name: r.host_name }, request: r, client: { name: r.client_name } }), { fetchImpl });
    if (!acceptable(text)) {
      skipped++;
      // A dash means "tried, nothing usable" so the next tick does not spend
      // another call on the same request. The host sees an empty field, which
      // is honest; the console can offer "try again".
      await env.DB.prepare("UPDATE num_host_requests SET draft_text = '-' WHERE id = ?1 AND (draft_text IS NULL OR draft_text = '')").bind(r.id).run().catch(() => {});
      continue;
    }
    await env.DB.prepare("UPDATE num_host_requests SET draft_text = ?2, updated_at = datetime('now') WHERE id = ?1").bind(r.id, text).run().catch(() => {});
    drafted++;
  }
  return { drafted, skipped };
}
