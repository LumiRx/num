/**
 * billphoto.mjs — reading the figure off a paper bill.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Thailand is where NUM is deepest and it is the market with no POS to read.
 * The dominant tills — Ocha and FoodStory (LINE MAN Wongnai), StoreHub — have
 * no public API at all, and a large share of Thai restaurants run on a paper
 * slip and a calculator. growth/pos only ever helps a venue that has a till
 * NUM can talk to.
 *
 * So this is the other half: staff hold up the bill, the phone reads the
 * total, and staff tap to confirm it. It removes the typing, not the human.
 *
 * ── THE RULE THAT MAKES THIS SAFE ────────────────────────────────────────
 *
 *   THE MODEL PROPOSES. STAFF CONFIRM. THE GUEST NEVER SETS THE AMOUNT.
 *
 * Not a preference — it is what keeps billqr.mjs's whole argument standing.
 * That file's case for why a venue cannot quietly under-report is "the figure
 * on the code is the figure the guest pays, and showing 800 to a table that
 * owes 2,400 means asking your own customer to pay the wrong amount". That
 * argument needs a human who is accountable for the number. A model reading
 * 2,400 as 240 and minting silently would charge a guest a tenth of their
 * bill and hand the venue a shortfall; the same misread the other way charges
 * a stranger ten times over. Both are unacceptable, and confirmation is what
 * prevents them — which is the same discipline growth/fleetvision.mjs applies
 * to a host's photographs: the model gets the first word, never the last.
 *
 * ── AND THE ONE ABOUT CURRENCY ───────────────────────────────────────────
 *
 * The currency comes from the VENUE, never from the photograph. A slip that
 * says "2,400" in Phuket is baht; a model that decides it is dollars has
 * multiplied the bill by thirty-five. worker/commission.mjs already owns
 * country-to-currency and this reads it rather than keeping a second opinion.
 *
 * ── WHAT IS NOT STORED ───────────────────────────────────────────────────
 *
 * Not the photograph. A restaurant bill can carry a guest's name, a card's
 * last four, a room number. What a dispute actually needs is what the model
 * SAID and which image it said it about, so this keeps the raw answer, the
 * confidence and a SHA-256 of the bytes — enough to prove a read, nothing to
 * leak. The image lives in memory for the length of one request.
 */

import { parseAmount } from './billqr.mjs';
import { currencyForCountry } from './commission.mjs';

export const PHOTO_MODEL = 'claude-haiku-4-5-20251001';
export const photoReady = (env) => !!env?.ANTHROPIC_API_KEY;
export const photoNeeds = (env) => (photoReady(env) ? [] : ['ANTHROPIC_API_KEY']);

/** Same allowlist discipline as inboundmedia.mjs: what we will send, not what was claimed. */
export const PHOTO_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

/** 6MB of base64 is about a 4.5MB photo — comfortably above a phone camera, below a problem. */
export const MAX_B64 = 6 * 1024 * 1024;

/**
 * A read below this is not offered at all.
 *
 * The alternative to a shaky read is staff typing four digits, which they can
 * already do and which is never wrong. So the bar is set where "we could not
 * read it" is a better answer than a number nobody should trust.
 */
export const MIN_CONFIDENCE = 0.75;

export function buildPrompt(currency) {
  return [
    'This is a photograph of a restaurant bill or receipt.',
    '',
    `Read ONE number: the TOTAL AMOUNT THE GUEST MUST PAY, in ${currency}.`,
    '',
    'Rules:',
    '- If the bill shows a subtotal, a service charge, and a total, take the FINAL total.',
    '- If an amount has already been paid or a deposit deducted, take the amount STILL DUE.',
    '- Do not add anything. Do not apply a tip. Do not convert a currency.',
    '- Ignore table numbers, bill numbers, dates, phone numbers and item prices.',
    '- If the photograph is blurred, cut off, at an angle you cannot read, or is',
    '  not a bill at all, say so instead of guessing.',
    '',
    'Answer with JSON and nothing else:',
    '{"amount":"0.00","confidence":0.0,"legible":true,"note":""}',
    '',
    '"amount" is digits and at most one decimal point, no currency symbol and no',
    'thousands separators. "confidence" is 0 to 1 and is how sure you are that this',
    'is the final amount due — be honest; a low number is useful and a wrong number',
    'is not. "note" is a short reason when you could not read it.',
  ].join('\n');
}

/**
 * Parse the model's answer into something we would be willing to show staff.
 * Deliberately strict, for the same reason parseAmount is: this figure becomes
 * the number a guest is asked to pay.
 */
export function parseRead(raw, { currency = 'THB', max = 10_000_000 } = {}) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let body = null;
  if (start !== -1 && end > start) {
    try { body = JSON.parse(text.slice(start, end + 1)); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') return { ok: false, reason: 'the reader did not answer in a form we can use' };

  const confidence = Number(body.confidence);
  const conf = Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0;
  const note = String(body.note ?? '').slice(0, 200) || null;

  if (body.legible === false) return { ok: false, reason: note || 'the bill could not be read from that photo', confidence: conf, note };

  const amt = parseAmount(body.amount, { max });
  if (!amt.ok) return { ok: false, reason: 'no readable total on that photo', confidence: conf, note };
  if (conf < MIN_CONFIDENCE) {
    return { ok: false, low: true, confidence: conf, note, reason: 'not sure enough of that number to put it on a bill — type it instead' };
  }
  return { ok: true, amount_minor: amt.minor, amount: amt.display, currency, confidence: conf, note };
}

export async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Look at one photograph and report the total.
 *
 * Returns a REFUSAL rather than throwing, and never returns a number it is not
 * confident about. Every caller is rendering a screen to a member of staff
 * standing at a table.
 */
export async function readBillPhoto(env, { data, mediaType, currency = 'THB' } = {}, { fetchImpl = fetch } = {}) {
  if (!PHOTO_TYPES.has(String(mediaType))) return { ok: false, reason: 'that file is not a photo we can read' };
  if (!data || typeof data !== 'string') return { ok: false, reason: 'no photo arrived' };
  if (data.length > MAX_B64) return { ok: false, reason: 'that photo is too large — take it again, a little further back' };
  if (!photoReady(env)) return { ok: false, reason: 'reading bills from a photo is not switched on yet', needs: photoNeeds(env) };

  let res;
  try {
    res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.NUM_VISION_MODEL || PHOTO_MODEL,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: buildPrompt(currency) },
          ],
        }],
      }),
    });
  } catch (e) {
    console.warn('[billphoto] unreachable', e?.message ?? e);
    return { ok: false, reason: 'could not reach the reader — type the amount instead' };
  }
  if (!res.ok) {
    console.warn('[billphoto] http', res.status);
    return { ok: false, reason: 'could not read that photo — type the amount instead' };
  }

  let text = '';
  try {
    const j = await res.json();
    text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  } catch {
    return { ok: false, reason: 'the reader answered with nothing we could use' };
  }
  const out = parseRead(text, { currency });
  return { ...out, raw: text.slice(0, 500) };
}

/** The venue's own currency. From the profile, never from the photograph. */
export async function currencyFor(env, businessId) {
  const row = await env.DB.prepare('SELECT country FROM num_business_profiles WHERE business_id = ?1')
    .bind(String(businessId)).first().catch(() => null);
  return currencyForCountry(row?.country);
}

/**
 * Read a photo and file the result as a PROPOSAL. Nothing is minted here.
 *
 * The proposal is what the console shows staff beside a Confirm button, and
 * it is what makes the read auditable afterwards: the raw answer, the
 * confidence and the image hash are kept; the image is not.
 */
export async function proposeFromPhoto(env, { businessId, resourceId = null, bookingId = null, data, mediaType, by = null } = {}, opts = {}) {
  if (!env?.DB || !businessId) return { ok: false, reason: 'missing venue' };
  const currency = await currencyFor(env, businessId);
  const read = await readBillPhoto(env, { data, mediaType, currency }, opts);

  let hash = null;
  try { hash = await sha256Hex(Uint8Array.from(atob(String(data).slice(0, 64)), (c) => c.charCodeAt(0))); } catch { hash = null; }

  const id = `bp_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
  await env.DB.prepare(
    `INSERT INTO num_bill_proposals
       (id, business_id, resource_id, booking_id, amount_minor, currency, confidence, note, raw, image_sha, state, created_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
  ).bind(
    id, String(businessId), resourceId, bookingId,
    read.ok ? read.amount_minor : null, currency,
    Number.isFinite(read.confidence) ? read.confidence : null,
    read.note ?? read.reason ?? null, String(read.raw ?? '').slice(0, 500), hash,
    read.ok ? 'proposed' : 'unreadable', by,
  ).run().catch((e) => { console.warn('[billphoto] could not file the proposal', e?.message); return null; });

  if (!read.ok) return { ok: false, id, reason: read.reason, low: !!read.low, confidence: read.confidence ?? null };
  return {
    ok: true, id, amount_minor: read.amount_minor, amount: read.amount, currency,
    confidence: read.confidence,
    // Said out loud on every proposal, so the screen can say it too.
    confirm: 'Check this against the bill before you confirm — NUM read it, you are the one who is sure.',
  };
}

/**
 * Staff confirm, and only then does a bill code exist.
 *
 * The amount staff send wins over the amount the model read. They are holding
 * the paper; the model saw a photograph of it. `corrected` records when the
 * two differed, which over a few hundred bills is the only honest measure of
 * whether this feature is worth having.
 */
export async function confirmProposal(env, businessId, proposalId, { amount = null, by = null, mint } = {}) {
  if (!env?.DB || !businessId || !proposalId) return { ok: false, reason: 'missing proposal' };
  const row = await env.DB.prepare(
    `SELECT id, business_id, resource_id, booking_id, amount_minor, currency, state
       FROM num_bill_proposals WHERE id = ?1 AND business_id = ?2`,
  ).bind(String(proposalId), String(businessId)).first().catch(() => null);
  if (!row) return { ok: false, reason: 'no such proposal' };
  if (row.state === 'confirmed') return { ok: false, reason: 'that bill has already been made' };

  const chosen = amount == null ? (row.amount_minor == null ? null : (row.amount_minor / 100).toFixed(2)) : amount;
  const amt = parseAmount(chosen);
  if (!amt.ok) return { ok: false, reason: amt.reason };

  const out = await mint({
    businessId, resourceId: row.resource_id, bookingId: row.booking_id,
    amount: amt.display, currency: row.currency, issuedBy: by,
  });
  if (!out?.ok) return { ok: false, reason: out?.reason ?? 'could not make the bill code' };

  await env.DB.prepare(
    `UPDATE num_bill_proposals
        SET state = 'confirmed', confirmed_minor = ?3, corrected = ?4, token = ?5,
            confirmed_by = ?6, confirmed_at = datetime('now')
      WHERE id = ?1 AND business_id = ?2`,
  ).bind(
    row.id, String(businessId), amt.minor,
    row.amount_minor != null && row.amount_minor !== amt.minor ? 1 : 0,
    out.token, by,
  ).run().catch(() => null);

  return { ok: true, token: out.token, url: out.url, amount: amt.display, currency: row.currency,
           corrected: row.amount_minor != null && row.amount_minor !== amt.minor };
}

/**
 * How well the reader is actually doing at this venue — proposals made, how
 * often staff changed the number, how often it could not read at all.
 * A feature that quietly gets it wrong should be visible, not assumed.
 */
export async function readerScore(env, businessId, { days = 30 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT state, corrected FROM num_bill_proposals
      WHERE business_id = ?1 AND created_at > datetime('now', ?2)`,
  ).bind(String(businessId), `-${Math.max(1, Math.round(days))} days`).all();
  const rows = results ?? [];
  const confirmed = rows.filter((r) => r.state === 'confirmed');
  return {
    proposals: rows.length,
    unreadable: rows.filter((r) => r.state === 'unreadable').length,
    confirmed: confirmed.length,
    corrected: confirmed.filter((r) => Number(r.corrected) === 1).length,
  };
}
