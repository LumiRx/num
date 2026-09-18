/**
 * THE THING THAT WORKS THE INTEGRATION QUEUE, AND KNOWS WHEN TO FETCH A HUMAN.
 *
 * ── WHAT IT IS FOR ───────────────────────────────────────────────────────
 *
 * A venue says "we book on SevenRooms". That sentence is either the start of
 * an integration or the start of nothing, and which one it turns out to be has
 * historically depended on whether anybody happened to read the row.
 *
 * This sweeps the queue in `ressystem.mjs` and moves every row forward by one
 * honest step. It does not build adapters. It finds out what building one
 * would take, writes that down against the row, and then does the single most
 * valuable thing in the whole file: it decides whether a person is needed, and
 * only then interrupts one.
 *
 * ── WHY THE MODEL'S ANSWER IS A LEAD AND NOT A FACT ──────────────────────
 *
 * A Worker cannot search the web. What it can do is ask a model what it knows
 * about a reservation platform's developer offering — which is real
 * information and is also exactly the kind of information a model will
 * confabulate a plausible URL for. A made-up documentation link filed as a
 * finding is worse than an empty row, because the empty row gets researched
 * and the filled one gets trusted.
 *
 * So every model answer is stored under the heading it deserves: a lead, with
 * a stated confidence, to be verified by whoever acts on it. Nothing here ever
 * sets `reach: 'open'` or moves a row to `shipped` on a model's say-so. The
 * only thing the model is allowed to do is route the work and describe it.
 *
 * ── THE ESCALATION RULE ──────────────────────────────────────────────────
 *
 * Dre is emailed when, and only when, the blocker is one no agent can clear:
 * a partner agreement, a credential, a signature, money. Those are the four
 * things on the other side of every reservation platform's door, and they are
 * the reason `reach: 'partner'` exists as a value.
 *
 * Everything else — reading documentation, drafting an adapter, chasing a
 * venue for their booking link — is work, and work does not need an email.
 *
 * `alerted_at` is why he is told once. The ledger in failures.mjs learned this
 * the expensive way on 12 Sep 2026, when a single dead mailbox declared the
 * whole product down because recording a problem and telling somebody about it
 * had been wired together without a way of saying "already said".
 */

import { send, AUDIENCE } from './mailer.mjs';
import { openWork, needsHuman, markAlerted, recordProgress, systemByKey } from './ressystem.mjs';

const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));

/**
 * What a model is asked, and the shape it must answer in.
 *
 * Constrained to JSON with a confidence, because an answer that cannot be
 * parsed is an answer that cannot be filed, and an answer with no confidence
 * attached reads as certainty it has not earned.
 */
function prompt(row) {
  return [
    `A hospitality venue books through "${clip(row.system_name, 80)}".`,
    'We want to send it reservations from our own concierge product.',
    '',
    'Answer ONLY with JSON in this exact shape:',
    '{"reach":"open|partner|none|unknown","needs":["..."],"summary":"...","confidence":"high|medium|low"}',
    '',
    'reach: "open" only if a developer can obtain booking credentials without a signed commercial agreement.',
    '"partner" if a real API exists behind an application or agreement. "none" if there is no third-party',
    'booking API at all. "unknown" if you are not confident.',
    'needs: the concrete things required, e.g. "partner application", "signed agreement", "sandbox credentials",',
    '"OAuth app", "revenue share". Empty array if reach is "none" or "unknown".',
    'summary: at most 40 words, plain. Do NOT invent documentation URLs. If you are unsure of a URL, omit it.',
    'confidence: how sure you are that this is current and correct.',
  ].join('\n');
}

async function ask(env, text, { fetchImpl = fetch } = {}) {
  if (!env?.ANTHROPIC_API_KEY) return null;
  const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.NUM_RESEARCH_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const j = await r.json().catch(() => null);
  return (j?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim() || null;
}

/**
 * Parse the model's answer, and refuse anything that does not fit.
 *
 * A half-understood answer is filed as no answer at all. The row stays in
 * research, which is true, rather than acquiring a confident-looking finding
 * nobody can trace.
 */
export function parseFinding(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const reach = String(j.reach ?? '').toLowerCase();
  if (!['open', 'partner', 'none', 'unknown'].includes(reach)) return null;
  const confidence = ['high', 'medium', 'low'].includes(String(j.confidence ?? '').toLowerCase())
    ? String(j.confidence).toLowerCase() : 'low';
  const needs = Array.isArray(j.needs) ? j.needs.map((s) => clip(s, 60)).filter(Boolean).slice(0, 8) : [];
  const summary = clip(j.summary ?? '', 400);
  if (!summary) return null;
  return { reach, needs, summary, confidence };
}

/** Which of the four blockers this finding implies. */
export function blockerFor(finding) {
  if (!finding) return 'research';
  if (finding.reach === 'partner') return 'dre';
  if (finding.reach === 'open') return 'build';
  if (finding.reach === 'none') return 'venue';
  return 'research';
}

/**
 * One pass over the work an agent can actually do.
 *
 * `limit` is small on purpose: this runs on a cron beside everything else, and
 * a sweep that tries to clear a backlog in one tick is a sweep that times out
 * halfway and leaves the rows it touched in a state nobody planned.
 */
export async function researchSweep(env, { limit = 5, fetchImpl = fetch } = {}) {
  const rows = await openWork(env, { limit });
  const done = [];
  for (const row of rows) {
    // A system already in the registry has been researched by a human and
    // written down. Asking a model to second-guess a checked fact is how a
    // checked fact gets replaced by a plausible one.
    const known = systemByKey(row.system_key);
    if (known && known.reach !== 'unknown') {
      await recordProgress(env, row.id, {
        state: 'working',
        blockedOn: known.reach === 'partner' ? 'dre' : known.reach === 'open' ? 'build' : 'venue',
        findings: [
          `From the registry (checked by hand): ${known.name} — reach "${known.reach}".`,
          known.note ?? null,
          known.apply ? `Apply: ${known.apply}` : null,
          known.docs ? `Docs: ${known.docs}` : null,
          known.contact ? `Contact: ${known.contact}` : null,
        ].filter(Boolean).join('\n'),
      });
      done.push({ id: row.id, via: 'registry' });
      continue;
    }

    const finding = parseFinding(await ask(env, prompt(row), { fetchImpl }));
    if (!finding) {
      done.push({ id: row.id, via: 'none' });
      continue;
    }
    await recordProgress(env, row.id, {
      state: 'working',
      blockedOn: blockerFor(finding),
      findings: [
        'A LEAD, NOT A VERIFIED FACT — a model answered this from memory and could not check it.',
        `Confidence: ${finding.confidence}.`,
        `Reach: ${finding.reach}.`,
        finding.needs.length ? `Needs: ${finding.needs.join(', ')}.` : null,
        finding.summary,
        '',
        'Verify against the vendor before committing to anything or telling a venue it is possible.',
      ].filter(Boolean).join('\n'),
    });
    done.push({ id: row.id, via: 'model', reach: finding.reach });
  }
  return { researched: done.length, rows: done };
}

function alertBody(rows, site) {
  const lines = rows.map((r) => [
    `• ${r.system_name}${r.venue_name ? ` — asked for by ${r.venue_name}` : ''}`,
    `  reach: ${r.reach}`,
    r.booking_url ? `  their booking page: ${r.booking_url}` : null,
    r.findings ? `  ${String(r.findings).split('\n').join('\n  ')}` : null,
  ].filter(Boolean).join('\n')).join('\n\n');

  return [
    rows.length === 1
      ? 'One reservation-system integration is waiting on you.'
      : `${rows.length} reservation-system integrations are waiting on you.`,
    '',
    'These are blocked on something no agent can produce — a partner application,',
    'a signed agreement, credentials, or money. Everything else in the queue is',
    'being worked without you.',
    '',
    lines,
    '',
    `The queue: ${site}/ops/integrations`,
    '',
    'You are told once per request. Nothing here re-sends.',
  ].join('\n');
}

/**
 * Tell Dre about the ones only he can unblock — once each, and never about
 * anything else.
 *
 * Marked as alerted only after a transport accepted the message. Marking first
 * would be the 30 Aug failure exactly: six businesses recorded as told, none
 * of them told, and a sweep that skipped them forever after.
 */
export async function alertSweep(env, { limit = 20 } = {}) {
  const rows = await needsHuman(env, { limit });
  if (!rows.length) return { alerted: 0, reason: 'nothing needs a human' };

  const to = env?.ALERT_EMAIL_TO || env?.ADMIN_EMAIL;
  if (!to) return { alerted: 0, reason: 'no ALERT_EMAIL_TO or ADMIN_EMAIL configured' };

  const site = env?.SITE || 'https://itsnum.com';
  const out = await send(env, {
    to,
    from: env?.ALERT_EMAIL_FROM || 'NUM <alerts@itsnum.com>',
    subject: rows.length === 1
      ? `NUM: ${rows[0].system_name} integration needs you`
      : `NUM: ${rows.length} integrations need you`,
    text: alertBody(rows, site),
  }, { audience: AUDIENCE.INTERNAL }).catch((e) => ({ ok: false, error: String(e).slice(0, 200) }));

  if (!out?.ok) return { alerted: 0, reason: out?.error ?? 'send failed', pending: rows.length };
  await markAlerted(env, rows.map((r) => r.id));
  return { alerted: rows.length, via: out.via };
}

export const __testables = { prompt, alertBody };
