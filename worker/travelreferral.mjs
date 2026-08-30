// The travel referral: Num finds it, the agency sells it, nobody pays Num.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
//
// Num can already SHOP a flight (worker/sabre.mjs — "every endpoint here is
// SHOPPING, not booking") and cannot issue a ticket. The gap between those two
// facts is where a traveller currently falls. This closes it the cheapest way
// there is: a structured request goes to a travel agency, the AGENCY quotes,
// the AGENCY takes the traveller's payment, the AGENCY issues the confirmation,
// and Num earns commission on it.
//
// That is not a compromise, it is the point. §17550.11 sizes a California
// seller-of-travel bond to the passenger money the seller HOLDS. Hold nothing
// and an adequate bond is zero dollars — HQ/divisions/num/
// REFERRAL_STRUCTURE_ANALYSIS.md §1. Every design decision below exists to keep
// that true under pressure:
//
//   · There is no column, field or route that accepts a payment instrument.
//     A request body carrying one is REFUSED (see PAYMENT_KEYS) rather than
//     ignored, because a field that is quietly dropped is a field somebody will
//     later "fix".
//   · Num never states a price it computed. `quote_amount_cs` is the number the
//     PARTNER sent, stored with the partner's own currency and relayed verbatim.
//   · Num never says it booked, reserved or confirmed anything. The partner
//     issues; Num presents. The member-facing sentences are constants at the
//     bottom of this file and travelreferral.test.mjs reads every one of them.
//
// ── WHY THE PARTNER SIDE IS A LINK AND NOT AN INTEGRATION ────────────────
//
// Identical to bookdesk.mjs, and for an identical reason. A travel agency will
// not build an API integration to win one referral from a 125-member concierge.
// The bar for the first real booking has to be: read an email, click once, type
// a price and their own reference. So the inbound side is an HMAC-signed link —
// the same mechanism bookdesk.mjs:104 already uses for restaurants — and the
// token IS the auth. It proves the click came from the address we emailed,
// which is exactly as much identity as the fax it replaces ever had.
//
// And because an agency that has agreed to nothing can still be handed a real
// booking, there is a manual path: an operator with the admin key can create,
// quote and confirm a referral by hand, with no partner action at all. That is
// how the first one goes through, this week, with zero integration on the
// partner's side. See HQ/divisions/num/TRAVEL_REFERRAL_GOLIVE.md.
//
// ── STATES ───────────────────────────────────────────────────────────────
//
//   draft → sent → quoted → accepted → confirmed
//                                  ↘ (any live state) → declined | cancelled | expired
//
// Forward only, one step at a time, and every transition is an UPDATE guarded
// by `AND state = <the state it must be in>`. A second click on last week's
// link changes nothing, because at-least-once delivery is a property of the
// universe and not of Stripe — bookdesk.mjs said it first and it is still true.
//
// Money accrues on exactly one edge: the transition INTO `confirmed`, and only
// when that UPDATE actually changed a row. commission.mjs owns the ledger and
// is idempotent on its own account too (unique index on booking_id) — two locks
// on the same door, because the alternative is invoicing a partner twice in the
// first month of a relationship that took four weeks to start.
import { partnerById, routeFor, commissionBp } from './travelpartners.mjs';
import { sendEmail } from './email.mjs';
import { accrue, markPaid, settleValue, unpaid } from './commission.mjs';
import { isAdmin } from './console.mjs';
import { statementsOf } from './passengers.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The kill switch, in the same shape as BOOKDESK_ENABLED (bookdesk.mjs:139)
 * and SABRE_BOOKING_ENABLED: an explicit string, default OFF.
 *
 * It gates the ASK — creating and sending a referral — and nothing else.
 * `/quote`, `/accept` and `/mine` stay open however this is set, deliberately:
 * a signed quote link already lives in an agency's inbox, and an agent who
 * replies with a price after somebody pulled the switch must still be able to,
 * or a member is left waiting on a trip that an agency believes it has priced.
 * Turning this off means "stop sending", never "stop listening".
 */
export const travelReferralEnabled = (env) => env?.TRAVEL_REFERRAL_ENABLED === 'true';

// ── the reference ─────────────────────────────────────────────────────────

// No I, O, 0, 1 — this is read aloud down a phone line to a travel desk and
// typed into somebody else's CRM by hand. Ambiguity here costs a booking.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * `NUM-XXXXXX` — 32^6 ≈ 1.07 billion, from crypto randomness.
 *
 * Uniqueness is enforced by the UNIQUE index on `ref`, not by hope: mint(),
 * below, retries on collision and gives up loudly rather than reusing one.
 */
export function newRef() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `NUM-${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}

// ── what may never be sent to this module ─────────────────────────────────

/**
 * Anything that could be used to charge a traveller.
 *
 * A request carrying one of these is refused with 422 and a sentence naming the
 * field. Not stripped, not ignored: silence would let a client keep sending it,
 * and the first person to notice would be a regulator asking why Num's schema
 * has a `card_number` column. The traveller pays the AGENCY.
 */
export const PAYMENT_KEYS =
  /(card|cvv|cvc|\bpan\b|payment_method|paymentmethod|payment_token|stripe|iban|sort_code|account_number|routing|exp_month|exp_year|expiry|cardholder|billing_address)/i;

const paymentFieldIn = (obj, depth = 0) => {
  if (!obj || typeof obj !== 'object' || depth > 2) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (PAYMENT_KEYS.test(k)) return k;
    const nested = paymentFieldIn(v, depth + 1);
    if (nested) return nested;
  }
  return null;
};

/**
 * Words Num may not say about a travel referral, and the honest phrasing.
 *
 * Num PRESENTS, the partner ISSUES. "Booked", "reserved", "ticketed" and
 * "confirmed by Num" are all claims that Num performed a transaction it is
 * structurally incapable of performing — and a member who believes they have a
 * ticket does not check, and does not fly. A sibling change is landing a
 * repo-wide forbidden-words filter; this local guard is the same rule applied
 * at the one place this module can enforce it, and should be replaced by that
 * filter's shared export when it lands.
 */
export const FORBIDDEN_CLAIMS =
  /\b(i(?:'ve| have)? booked|we(?:'ve| have)? booked|your (?:flight|hotel|trip) is booked|reserved for you|i(?:'ve| have)? reserved|ticket(?:ed|s are) issued|num has booked|num booked|paid for you)\b/i;

/** The offending phrase in a member-facing string, or null. */
export const offendingClaim = (text) => String(text ?? '').match(FORBIDDEN_CLAIMS)?.[0] ?? null;

/**
 * A member-facing sentence, or the safe fallback if it ever claims too much.
 *
 * Belt and braces: the constants below are already correct and tested. This
 * exists so a future edit that reintroduces "booked" degrades to a true
 * sentence in production instead of shipping a false one.
 */
const safe = (text, fallback) => (offendingClaim(text) ? fallback : text);

// ── the member-facing language, in one place ──────────────────────────────
//
// Every one of these is read by travelreferral.test.mjs, which fails if any of
// them acquires a word that claims Num booked, reserved, ticketed or priced
// anything. Change them here, not at the call sites.
export const LINES = Object.freeze({
  sent: (p) => `Sent to ${p} with your reference. They'll come back with options and a price — that's their quote, not mine.`,
  quoted: (p) => `${p} came back with a quote. It's theirs, in their currency, exactly as they sent it.`,
  accepted: (p) => `Passed your yes to ${p}. They'll contact you directly to take payment and issue the confirmation — the booking is between you and them.`,
  confirmed: (p) => `${p} has issued your confirmation and sent it to you directly. I've filed their reference against your trip.`,
  declined: (p) => `${p} couldn't cover this one. Want me to put it to another agency?`,
  cancelled: () => 'Cancelled — nothing is outstanding with the agency.',
  no_partner: 'I don\'t have an agency covering that route yet. I can price it and send you the details to book yourself, if that helps.',
  disabled: 'The travel desk isn\'t taking handoffs right now — I\'ll price it and give you the details instead.',
});

/** Plain English for where a referral has got to. Mirrors bookdesk stateLine. */
export const STATE_LINE = Object.freeze({
  draft: 'Not sent yet',
  sent: 'With the agency — waiting on their quote',
  quoted: 'Quoted by the agency — your call',
  accepted: 'Accepted — the agency will contact you to take payment',
  confirmed: 'The agency issued the confirmation',
  declined: 'The agency couldn\'t cover it',
  cancelled: 'Cancelled',
  expired: 'No answer from the agency',
});

// ── schema ────────────────────────────────────────────────────────────────

/**
 * Inlined verbatim from worker/migrations/0003_travel_referrals.sql, because a
 * Worker has no filesystem. The migration file is the readable copy and the one
 * to edit first; travelreferral.test.mjs compares the two with statementsOf()
 * and fails if they drift, the same guard passengers.test.mjs:637 puts on 0002.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_travel_referrals (
  id                     TEXT PRIMARY KEY,
  ref                    TEXT NOT NULL,
  member_id              TEXT NOT NULL,
  partner_id             TEXT NOT NULL,
  partner_name           TEXT,
  partner_email          TEXT,
  product                TEXT NOT NULL DEFAULT 'flight',
  origin                 TEXT,
  destination            TEXT,
  depart_on              TEXT,
  return_on              TEXT,
  adults                 INTEGER NOT NULL DEFAULT 1,
  children               INTEGER NOT NULL DEFAULT 0,
  cabin                  TEXT,
  budget_cs              INTEGER,
  budget_currency        TEXT,
  notes                  TEXT,
  contact_name           TEXT,
  contact_email          TEXT,
  contact_phone          TEXT,
  state                  TEXT NOT NULL DEFAULT 'draft'
                         CHECK (state IN ('draft','sent','quoted','accepted','confirmed','declined','cancelled','expired')),
  quote_amount_cs        INTEGER,
  quote_currency         TEXT,
  quote_note             TEXT,
  quote_url              TEXT,
  partner_ref            TEXT,
  commission_bp          INTEGER,
  commission_expected_cs INTEGER,
  commission_received_cs INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at                TEXT,
  quoted_at              TEXT,
  accepted_at            TEXT,
  confirmed_at           TEXT,
  cancelled_at           TEXT,
  commission_paid_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_travelref_ref ON num_travel_referrals (ref);
CREATE INDEX IF NOT EXISTS idx_travelref_member ON num_travel_referrals (member_id, created_at);
CREATE INDEX IF NOT EXISTS idx_travelref_partner ON num_travel_referrals (partner_id, state, created_at);
`;

let ready = false;
async function ensure(env) {
  if (ready || !env?.DB) return;
  for (const s of statementsOf(SCHEMA)) await env.DB.prepare(s).run();
  ready = true;
}
/** Test hook — a fresh in-memory database per suite needs the schema again. */
export const _resetSchemaCache = () => { ready = false; };

// ── the signed link the agency clicks ─────────────────────────────────────

/**
 * HMAC over exactly (id, verdict), namespaced `tref:` so a bookdesk token can
 * never be replayed here and vice versa. A `quote` token cannot decline, and a
 * `declined` token cannot attach a price.
 */
async function sign(env, id, verdict) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.ADMIN_KEY ?? 'dev'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`tref:${id}:${verdict}`));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const _sign = sign; // the tests build the same links the agency receives

/**
 * Either an admin session (the console) or the raw admin key in a header (a
 * terminal). email.mjs:/test already accepts the header form and Andre logs the
 * first referral from a terminal, before there is a console screen for it.
 */
const adminOk = async (env, request) =>
  (!!env?.ADMIN_KEY && request.headers.get('X-Admin-Key') === env.ADMIN_KEY) || (await isAdmin(env, request));

// ── the handoff document ──────────────────────────────────────────────────

const money = (cs, cur) => (Number.isFinite(cs) && cs > 0 ? `${(cs / 100).toFixed(2)} ${String(cur ?? 'USD').toUpperCase()}` : null);

const itineraryLine = (r) =>
  [r.origin && r.destination ? `${r.origin} → ${r.destination}` : r.destination || r.origin,
    r.depart_on ? `out ${r.depart_on}` : null,
    r.return_on ? `back ${r.return_on}` : null].filter(Boolean).join(' · ');

const paxLine = (r) =>
  `${r.adults} adult${r.adults === 1 ? '' : 's'}${r.children ? ` + ${r.children} child${r.children === 1 ? '' : 'ren'}` : ''}`;

/**
 * The plain-text handoff — the whole deal in a form a human can paste into a
 * shared inbox, a WhatsApp thread or a CRM note.
 *
 * This is not a fallback for the email; it is the SAME artefact in the channel
 * a small agency actually works in. LETSGO2TRIP_MEETING_BRIEF.md §6.1 puts a
 * structured email at step one and everything else after it, so the text form
 * has to be as complete as the HTML one — including the sentence that does the
 * legal work, which is the second-to-last line and is not optional.
 */
export function handoffText(r, { quoteLink = null } = {}) {
  return [
    `NUM TRAVEL REQUEST — ${r.ref}`,
    '',
    `Product:     ${r.product}`,
    `Itinerary:   ${itineraryLine(r) || '(see notes)'}`,
    `Passengers:  ${paxLine(r)}`,
    r.cabin ? `Cabin:       ${r.cabin}` : '',
    money(r.budget_cs, r.budget_currency) ? `Traveller's budget: up to ${money(r.budget_cs, r.budget_currency)}` : '',
    r.notes ? `Notes:       ${r.notes}` : '',
    '',
    'Traveller contact (for this booking only — do not add to marketing lists):',
    `  ${[r.contact_name, r.contact_email, r.contact_phone].filter(Boolean).join(' · ') || '(via Num — reply here)'}`,
    '',
    'HOW THIS WORKS',
    `You quote and you collect payment directly from the traveller, and you issue the confirmation in your own name. Num does not take the traveller's money and does not issue tickets. Reply with your price and your own booking reference, quoting ${r.ref}.`,
    quoteLink ? `\nOr attach your quote in one click: ${quoteLink}` : '',
  ].filter((l) => l !== '').join('\n');
}

/** The subject line the meeting brief agreed: `NUM-<ref> <city> <dates> <pax>`. */
export const handoffSubject = (r) =>
  `${r.ref} ${r.destination ?? r.origin ?? 'travel'} ${[r.depart_on, r.return_on].filter(Boolean).join('–') || 'dates TBC'} ${paxLine(r)}`;

// ── routes ────────────────────────────────────────────────────────────────

async function mint(env, row) {
  // Five attempts against a 1-in-a-billion collision is four more than the
  // arithmetic needs and is there for the other cause: a retried request.
  for (let i = 0; i < 5; i += 1) {
    const ref = newRef();
    const id = `tr_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
    try {
      await env.DB.prepare(
        `INSERT INTO num_travel_referrals
           (id, ref, member_id, partner_id, partner_name, partner_email, product, origin, destination,
            depart_on, return_on, adults, children, cabin, budget_cs, budget_currency, notes,
            contact_name, contact_email, contact_phone, state, commission_bp)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`,
      ).bind(
        id, ref, row.member_id, row.partner_id, row.partner_name, row.partner_email, row.product,
        row.origin, row.destination, row.depart_on, row.return_on, row.adults, row.children, row.cabin,
        row.budget_cs, row.budget_currency, row.notes,
        row.contact_name, row.contact_email, row.contact_phone, row.state ?? 'draft', row.commission_bp,
      ).run();
      return { id, ref };
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(String(e?.message ?? e))) throw e;
    }
  }
  // Loudly. A referral that silently reused another one's reference would put
  // two travellers' money against a single row in the agency's system.
  throw new Error('could not mint a unique NUM- reference');
}

const byRefOrId = (env, key) =>
  env.DB.prepare('SELECT * FROM num_travel_referrals WHERE ref = ?1 OR id = ?1').bind(String(key)).first();

/** Everything the app and the console show. Never the partner's email. */
const publicRow = (r) => ({
  id: r.id,
  ref: r.ref,
  product: r.product,
  partner_name: r.partner_name,
  origin: r.origin,
  destination: r.destination,
  depart_on: r.depart_on,
  return_on: r.return_on,
  adults: r.adults,
  children: r.children,
  cabin: r.cabin,
  state: r.state,
  state_line: STATE_LINE[r.state] ?? r.state,
  // The partner's number, relayed. Two separate fields, never combined into a
  // single formatted string by Num: the currency is theirs and a converted
  // figure would be a price Num computed.
  quote_amount_cs: r.quote_amount_cs,
  quote_currency: r.quote_currency,
  quote_note: r.quote_note,
  quote_url: r.quote_url,
  partner_ref: r.partner_ref,
  created_at: r.created_at,
  sent_at: r.sent_at,
  quoted_at: r.quoted_at,
  accepted_at: r.accepted_at,
  confirmed_at: r.confirmed_at,
});

/**
 * One guarded transition. Returns true only if THIS call moved the row.
 *
 * `from` is an array because a member may cancel from several states and an
 * agency may decline from two. The guard is the point: a second click, a
 * forwarded link and a link previewer all arrive, and only the first counts.
 */
async function move(env, id, from, to, sets = {}, stamp = null) {
  const cols = Object.keys(sets);
  const assignments = cols.map((c, i) => `${c}=?${i + 3}`);
  if (stamp) assignments.push(`${stamp}=datetime('now')`);
  const placeholders = from.map((_, i) => `?${cols.length + 3 + i}`).join(',');
  const res = await env.DB.prepare(
    `UPDATE num_travel_referrals SET state=?2${assignments.length ? `, ${assignments.join(', ')}` : ''}
      WHERE id=?1 AND state IN (${placeholders})`,
  ).bind(id, to, ...cols.map((c) => sets[c]), ...from).run();
  return (res?.meta?.changes ?? 0) > 0;
}

export async function handleTravelReferral(request, env, path, ctx) {
  if (!env?.DB) return json({ error: 'not configured' }, 503);
  await ensure(env);
  const url = new URL(request.url);
  const origin = env.NUM_APP_ORIGIN || 'https://app.itsnum.com';

  // Every write is screened for a payment instrument before anything else
  // happens — before auth, before the kill switch, before the body is read for
  // meaning. There is no route on which one is acceptable.
  //
  // The body is read ONCE, as text, and parsed from that string. A Request's
  // body is a stream and reading it twice throws: the agency's quote arrives as
  // a form POST while everything else is JSON, and calling .json() here and
  // .formData() later silently turned every submitted quote into a 400.
  let body = {};
  if (request.method === 'POST') {
    const raw = await request.text().catch(() => '');
    if (request.headers.get('Content-Type')?.includes('form')) {
      body = Object.fromEntries(new URLSearchParams(raw));
    } else {
      try { body = JSON.parse(raw); } catch { body = {}; }
      if (!body || typeof body !== 'object') body = {};
    }
    const bad = paymentFieldIn(body);
    if (bad) {
      return json({
        error: `Num never takes a payment for travel — remove "${bad}". The agency collects from the traveller directly.`,
        payment_refused: true,
      }, 422);
    }
  }

  // ── the member (or the concierge, on their behalf) asks ──────────────
  if (path === '/refer' && request.method === 'POST') {
    // 503 and a sentence, not a 404: the endpoint exists and is switched off,
    // and the app shows the member a line rather than a broken button.
    if (!travelReferralEnabled(env)) return json({ error: LINES.disabled, disabled: true }, 503);

    const me = clip(body.me, 40);
    if (!me) return json({ error: 'Who is this for?' }, 400);
    // `num_members` carries a name and a phone and no email (worker/social.sql:16),
    // so an email address for the agency to write to can only come from the
    // request. No email is a normal state: the agency replies to Num and the
    // concierge relays, which is the flow the first bookings run on anyway.
    const member = await env.DB.prepare('SELECT id, name, phone FROM num_members WHERE id=?1').bind(me).first();
    if (!member) return json({ error: 'sign up first' }, 404);

    const product = clip(body.product, 20)?.toLowerCase() ?? 'flight';
    const destination = clip(body.destination, 120);
    const partner = routeFor(env, { product, dest: destination, partner_id: clip(body.partner_id, 60) });
    if (!partner) return json({ error: LINES.no_partner, no_partner: true }, 503);

    const adults = Math.min(Math.max(Number(body.adults) || 1, 1), 20);
    const children = Math.min(Math.max(Number(body.children) || 0, 0), 20);
    const budget = Number(body.budget_cs);
    const draft = {
      member_id: me,
      partner_id: partner.id,
      partner_name: partner.name,
      partner_email: partner.email,
      product,
      origin: clip(body.origin, 120),
      destination,
      depart_on: clip(body.depart_on, 20),
      return_on: clip(body.return_on, 20),
      adults,
      children,
      cabin: clip(body.cabin, 40),
      budget_cs: Number.isFinite(budget) && budget > 0 ? Math.round(budget) : null,
      budget_currency: clip(body.budget_currency, 8),
      notes: clip(body.notes, 600),
      // Only what the booking needs. The agency gets a name and a way to reach
      // this one traveller, and nothing else about them — the data rule in
      // LETSGO2TRIP_MEETING_BRIEF.md §5 is a hard rule, not a preference.
      contact_name: clip(body.contact_name ?? member.name, 120),
      contact_email: clip(body.contact_email, 160),
      contact_phone: clip(body.contact_phone ?? member.phone, 40),
      state: 'draft',
      commission_bp: commissionBp(partner, product),
    };

    const { id, ref } = await mint(env, draft);
    const row = { ...draft, id, ref };
    const token = await sign(env, id, 'quote');
    const quoteLink = `${origin}/api/travel/quote?ref=${ref}&t=${token}`;

    // One sender, reused. email.mjs owns templates, the text part, the from
    // address and the never-throws contract; a second sender here would be a
    // second set of rules about what Num's mail looks like.
    const mail = await sendEmail(env, {
      to: partner.email,
      template: 'travelReferral',
      data: {
        ref,
        subject: handoffSubject(row),
        partner: partner.name,
        product,
        itinerary: itineraryLine(row),
        pax: paxLine(row),
        cabin: row.cabin,
        budget: money(row.budget_cs, row.budget_currency),
        notes: row.notes,
        contact: [row.contact_name, row.contact_email, row.contact_phone].filter(Boolean).join(' · '),
        link: quoteLink,
        sla_hours: partner.sla_hours,
        text: handoffText(row, { quoteLink }),
      },
      ctx,
    });

    // `sent` even when the mail binding is off. The row is the handoff; the
    // email is one way of delivering it, and the operator can deliver the same
    // text by hand from /handoff. A referral stuck in `draft` because a mail
    // server was down would be a booking nobody was working.
    await move(env, id, ['draft'], 'sent', {}, 'sent_at');

    return json({
      ok: true,
      id,
      ref,
      state: 'sent',
      partner: partner.name,
      emailed: !!mail?.sent,
      // The plain-text form comes back on the response so an operator can paste
      // it into WhatsApp the moment the email path is unavailable.
      handoff: handoffText(row, { quoteLink }),
      note: safe(LINES.sent(partner.name), LINES.sent(partner.name)),
    });
  }

  // ── the agency replies — the signed link, zero integration ───────────
  if (path === '/quote') {
    const key = clip(url.searchParams.get('ref'), 40);
    const token = clip(url.searchParams.get('t'), 40);
    const verdict = url.searchParams.get('v') ?? 'quote';
    if (!key || !token || !['quote', 'declined'].includes(verdict)) return page('Bad link', 'That link is not one of ours.', 400);
    const row = await byRefOrId(env, key);
    if (!row) return page('Not found', 'We have no request with that reference.', 404);
    // The token is signed over the row's INTERNAL id, never the reference: the
    // reference travels in email subjects and CRM notes and is effectively
    // public, so signing it would make every token guessable from a forwarded
    // thread.
    if (token !== (await sign(env, row.id, verdict))) return page('Bad link', 'That link is not one of ours.', 403);

    if (request.method === 'GET' && verdict === 'quote') {
      return quoteForm(row, url.search);
    }

    if (verdict === 'declined') {
      const moved = await move(env, row.id, ['sent', 'quoted'], 'declined', {}, 'cancelled_at');
      return page(
        'Thanks — noted',
        moved ? `${row.ref} is closed off. We'll take it elsewhere.` : `${row.ref} was already answered.`,
      );
    }

    // The quote itself. Usually a form POST, because an agency types a price
    // into the page; JSON when an operator does it from a terminal. Both arrive
    // in `body` already, parsed above.
    const form = body;
    const amount = Number(String(form.amount ?? '').replace(/[^\d.]/g, ''));
    const partnerRef = clip(form.partner_ref, 80);
    if (!Number.isFinite(amount) || amount <= 0) {
      return quoteForm(row, url.search, 'Put in the total price you are quoting.');
    }
    const moved = await move(
      env, row.id, ['sent'], 'quoted',
      {
        quote_amount_cs: Math.round(amount * 100),
        quote_currency: clip(form.currency, 8)?.toUpperCase() ?? 'USD',
        quote_note: clip(form.note, 600),
        quote_url: clip(form.quote_url, 300),
        partner_ref: partnerRef,
      },
      'quoted_at',
    );
    return page(
      moved ? 'Quote received' : 'Already answered',
      moved
        ? `Thank you. ${row.ref} is with the traveller now. If they accept, you'll take payment and issue the confirmation directly with them.`
        : `${row.ref} already has an answer against it — nothing has changed.`,
    );
  }

  // ── the member accepts ───────────────────────────────────────────────
  if (path === '/accept' && request.method === 'POST') {
    const row = await byRefOrId(env, clip(body.ref, 40) ?? '');
    if (!row) return json({ error: 'not found' }, 404);
    if (clip(body.me, 40) !== row.member_id) return json({ error: 'not yours' }, 403);
    const moved = await move(env, row.id, ['quoted'], 'accepted', {}, 'accepted_at');
    const note = LINES.accepted(row.partner_name ?? 'the agency');
    return json({
      ok: true,
      ref: row.ref,
      state: moved ? 'accepted' : row.state,
      changed: moved,
      // The one sentence this whole structure exists to be able to say.
      note: safe(note, LINES.accepted('the agency')),
    });
  }

  // ── the member (or the desk) calls it off ────────────────────────────
  if (path === '/cancel' && request.method === 'POST') {
    const row = await byRefOrId(env, clip(body.ref, 40) ?? '');
    if (!row) return json({ error: 'not found' }, 404);
    const admin = await adminOk(env, request);
    if (!admin && clip(body.me, 40) !== row.member_id) return json({ error: 'not yours' }, 403);
    const moved = await move(env, row.id, ['draft', 'sent', 'quoted', 'accepted'], 'cancelled', {}, 'cancelled_at');
    return json({ ok: true, ref: row.ref, changed: moved, note: LINES.cancelled() });
  }

  // ── the agency issued it — the only edge that touches money ──────────
  if (path === '/confirm' && request.method === 'POST') {
    if (!(await adminOk(env, request))) return json({ error: 'unauthorized' }, 401);
    const row = await byRefOrId(env, clip(body.ref, 40) ?? '');
    if (!row) return json({ error: 'not found' }, 404);
    const partnerRef = clip(body.partner_ref, 80);
    // The agency's own reference is the evidence that the AGENCY booked it. A
    // confirmation without one is a claim Num cannot support, so it is refused.
    if (!partnerRef) return json({ error: 'The agency\'s own booking reference is required — it is what proves they issued it.' }, 400);

    const value = Number(body.value_cs ?? row.quote_amount_cs);
    const valueCents = Number.isFinite(value) && value > 0 ? Math.round(value) : null;
    const bp = row.commission_bp;
    const expected = bp && valueCents ? Math.round((valueCents * bp) / 10000) : null;

    const moved = await move(
      env, row.id, ['quoted', 'accepted'], 'confirmed',
      { partner_ref: partnerRef, commission_expected_cs: expected },
      'confirmed_at',
    );

    // MONEY, exactly once, and only on a confirmation that actually flipped.
    // The same guard bookdesk.mjs:236 puts on its accrual, for the same reason:
    // this endpoint gets retried by an operator who did not see the first
    // response. commission.mjs is separately idempotent on booking_id, so a
    // double tap is a no-op twice over.
    let ledger = null;
    if (moved) {
      ledger = await accrue(env, {
        bookingId: row.ref,
        // An explicit category and rate: a travel referral is priced by the
        // signed partner agreement, not by the venue-category table. Passing
        // the category explicitly stops it falling through to the $2 flat
        // reservation rate, which would be silently wrong and hard to spot.
        category: `travel_${row.product}`,
        rateBp: bp,
        valueCents,
        venueName: row.partner_name,
        memberId: row.member_id,
        dest: row.destination,
        currency: (row.quote_currency ?? 'usd').toLowerCase(),
        source: 'travel_referral',
      });
    }
    return json({
      ok: true,
      ref: row.ref,
      state: moved ? 'confirmed' : row.state,
      changed: moved,
      partner_ref: partnerRef,
      commission_expected_cs: expected,
      ledger,
      note: LINES.confirmed(row.partner_name ?? 'The agency'),
    });
  }

  // ── the manual path: an operator, a terminal, no partner action ──────
  //
  // This is how the FIRST referral happens, the day the agreement is a
  // handshake and the agency has clicked nothing. One POST creates the row in
  // whatever state it is really in, records the partner's quote and their
  // reference, and — if the state given is `confirmed` — accrues the money on
  // the same guarded edge as everything else.
  if (path === '/log' && request.method === 'POST') {
    if (!(await adminOk(env, request))) return json({ error: 'unauthorized' }, 401);
    const me = clip(body.me, 40);
    if (!me) return json({ error: 'me (the member id) is required' }, 400);
    const product = clip(body.product, 20)?.toLowerCase() ?? 'flight';
    const partner = partnerById(env, clip(body.partner_id, 60))
      ?? routeFor(env, { product, dest: clip(body.destination, 120) });
    if (!partner) return json({ error: 'No partner configured for that product — set TRAVEL_PARTNERS first.' }, 400);

    const wanted = clip(body.state, 20) ?? 'sent';
    if (!['draft', 'sent', 'quoted', 'accepted', 'confirmed'].includes(wanted)) {
      return json({ error: 'state must be one of draft, sent, quoted, accepted, confirmed' }, 400);
    }
    const amount = Number(body.quote_amount_cs);
    const quoteCs = Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
    const bp = Number.isFinite(Number(body.commission_bp)) ? Number(body.commission_bp) : commissionBp(partner, product);
    const budget = Number(body.budget_cs);

    const { id, ref } = await mint(env, {
      member_id: me,
      partner_id: partner.id,
      partner_name: partner.name,
      partner_email: partner.email,
      product,
      origin: clip(body.origin, 120),
      destination: clip(body.destination, 120),
      depart_on: clip(body.depart_on, 20),
      return_on: clip(body.return_on, 20),
      adults: Math.min(Math.max(Number(body.adults) || 1, 1), 20),
      children: Math.min(Math.max(Number(body.children) || 0, 0), 20),
      cabin: clip(body.cabin, 40),
      budget_cs: Number.isFinite(budget) && budget > 0 ? Math.round(budget) : null,
      budget_currency: clip(body.budget_currency, 8),
      notes: clip(body.notes, 600),
      contact_name: clip(body.contact_name, 120),
      contact_email: clip(body.contact_email, 160),
      contact_phone: clip(body.contact_phone, 40),
      state: 'draft',
      commission_bp: bp,
    });

    // Walk the machine forward one guarded step at a time rather than writing
    // the end state straight in. The row then carries real timestamps for every
    // stage it passed through, and the reconciliation in /ledger works on a
    // hand-logged referral exactly as it does on a clicked one.
    const partnerRef = clip(body.partner_ref, 80);
    const stamps = [];
    if (wanted !== 'draft') stamps.push(await move(env, id, ['draft'], 'sent', {}, 'sent_at'));
    if (['quoted', 'accepted', 'confirmed'].includes(wanted)) {
      stamps.push(await move(env, id, ['sent'], 'quoted', {
        quote_amount_cs: quoteCs,
        quote_currency: clip(body.quote_currency, 8)?.toUpperCase() ?? null,
        quote_note: clip(body.quote_note, 600),
        quote_url: clip(body.quote_url, 300),
        partner_ref: partnerRef,
      }, 'quoted_at'));
    }
    if (['accepted', 'confirmed'].includes(wanted)) stamps.push(await move(env, id, ['quoted'], 'accepted', {}, 'accepted_at'));

    let ledger = null;
    if (wanted === 'confirmed') {
      if (!partnerRef) return json({ error: 'partner_ref is required to log a confirmed referral — it is the agency\'s own reference.', ref }, 400);
      const expected = bp && quoteCs ? Math.round((quoteCs * bp) / 10000) : null;
      const moved = await move(env, id, ['accepted'], 'confirmed', { commission_expected_cs: expected }, 'confirmed_at');
      if (moved) {
        ledger = await accrue(env, {
          bookingId: ref,
          category: `travel_${product}`,
          rateBp: bp,
          valueCents: quoteCs,
          venueName: partner.name,
          memberId: me,
          dest: clip(body.destination, 120),
          currency: (clip(body.quote_currency, 8) ?? 'usd').toLowerCase(),
          source: 'travel_referral',
        });
      }
      stamps.push(moved);
    }

    const row = await byRefOrId(env, ref);
    return json({ ok: true, ref, id, state: row.state, steps: stamps.length, ledger, referral: publicRow(row) });
  }

  // ── the money arrived ────────────────────────────────────────────────
  if (path === '/commission' && request.method === 'POST') {
    if (!(await adminOk(env, request))) return json({ error: 'unauthorized' }, 401);
    const row = await byRefOrId(env, clip(body.ref, 40) ?? '');
    if (!row) return json({ error: 'not found' }, 404);
    const received = Number(body.received_cs);
    if (!Number.isFinite(received) || received < 0) return json({ error: 'received_cs is required' }, 400);

    // If the booking's real value arrived with the payment, complete the
    // percentage line that was written as `awaiting_value` at confirmation.
    const value = Number(body.value_cs);
    if (Number.isFinite(value) && value > 0) await settleValue(env, row.ref, Math.round(value));

    await env.DB.prepare(
      `UPDATE num_travel_referrals
          SET commission_received_cs = ?2, commission_paid_at = CASE WHEN ?2 > 0 THEN datetime('now') ELSE NULL END
        WHERE id = ?1`,
    ).bind(row.id, Math.round(received)).run();
    // The ledger is marked paid from the same call, so the two never disagree
    // about whether an invoice is settled.
    await markPaid(env, row.ref, Math.round(received));
    const after = await byRefOrId(env, row.ref);
    return json({
      ok: true,
      ref: row.ref,
      expected_cs: after.commission_expected_cs,
      received_cs: after.commission_received_cs,
      variance_cs: (after.commission_received_cs ?? 0) - (after.commission_expected_cs ?? 0),
    });
  }

  // ── reconciliation: what is owed and by whom ─────────────────────────
  if (path === '/ledger') {
    if (!(await adminOk(env, request))) return json({ error: 'unauthorized' }, 401);
    const { results = [] } = await env.DB.prepare(
      `SELECT ref, partner_id, partner_name, product, destination, state, confirmed_at,
              quote_amount_cs, quote_currency, partner_ref,
              commission_bp, commission_expected_cs, commission_received_cs, commission_paid_at
         FROM num_travel_referrals
        WHERE state = 'confirmed'
        ORDER BY confirmed_at DESC LIMIT 500`,
    ).all();
    const outstanding = results.filter((r) => (r.commission_received_cs ?? 0) < (r.commission_expected_cs ?? 0));
    return json({
      confirmed: results.length,
      // Only rows with a real expectation are summed. A referral whose value we
      // do not know yet is listed, never totalled — commission.mjs made the
      // same choice for the same reason: a total that includes guesses is worse
      // than no total.
      expected_cs: results.reduce((n, r) => n + (r.commission_expected_cs ?? 0), 0),
      received_cs: results.reduce((n, r) => n + (r.commission_received_cs ?? 0), 0),
      outstanding_cs: outstanding.reduce((n, r) => n + ((r.commission_expected_cs ?? 0) - (r.commission_received_cs ?? 0)), 0),
      unpaid: outstanding,
      // The ledger's own view of the same money, so a mismatch between the
      // referral table and num_commissions is visible rather than latent.
      ledger_unpaid: await unpaid(env, { source: 'travel_referral' }),
    });
  }

  // ── the paste-able handoff, for the channel the agency actually uses ──
  if (path === '/handoff') {
    if (!(await adminOk(env, request))) return json({ error: 'unauthorized' }, 401);
    const row = await byRefOrId(env, clip(url.searchParams.get('ref'), 40) ?? '');
    if (!row) return json({ error: 'not found' }, 404);
    const token = await sign(env, row.id, 'quote');
    return json({
      ref: row.ref,
      to: row.partner_email,
      subject: handoffSubject(row),
      text: handoffText(row, { quoteLink: `${origin}/api/travel/quote?ref=${row.ref}&t=${token}` }),
      quote_link: `${origin}/api/travel/quote?ref=${row.ref}&t=${token}`,
      decline_link: `${origin}/api/travel/quote?ref=${row.ref}&v=declined&t=${await sign(env, row.id, 'declined')}`,
    });
  }

  // ── who is configured, and where a given request would go ────────────
  if (path === '/partners') {
    if (!(await adminOk(env, request))) return json({ error: 'unauthorized' }, 401);
    const { partners: all } = await import('./travelpartners.mjs');
    const would = routeFor(env, {
      product: url.searchParams.get('product') ?? 'flight',
      dest: url.searchParams.get('dest'),
    });
    return json({
      enabled: travelReferralEnabled(env),
      partners: all(env).map((p) => ({ ...p, commission_bp: p.commission_bp })),
      routes_to: would?.id ?? null,
    });
  }

  // ── the member's own list ────────────────────────────────────────────
  if (path === '/mine') {
    const me = clip(url.searchParams.get('me'), 40);
    if (!me) return json({ referrals: [] });
    const { results = [] } = await env.DB.prepare(
      'SELECT * FROM num_travel_referrals WHERE member_id=?1 ORDER BY created_at DESC LIMIT 20',
    ).bind(me).all();
    return json({ referrals: results.map(publicRow) });
  }

  return json({ error: 'not found' }, 404);
}

// ── the two pages an agency ever sees ─────────────────────────────────────
//
// HTML, not JSON: a travel agent opened this from their inbox on a phone. Same
// choice bookdesk.mjs makes for the venue's confirm page, same house styling.

const PAGE_HEAD =
  '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<body style="font-family:system-ui;margin:0;background:#faf7f5;color:#1a1614">';

const page = (title, line, status = 200) =>
  new Response(
    `${PAGE_HEAD}<div style="display:grid;place-items:center;min-height:100vh"><div style="text-align:center;padding:24px;max-width:34rem">`
    + `<div style="font-size:11px;letter-spacing:.18em;font-weight:800;color:#ec3013">NUM</div>`
    + `<h2 style="margin:10px 0 6px">${esc(title)}</h2><p style="color:#777;line-height:1.6">${esc(line)}</p></div></div>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );

/**
 * The whole partner integration: four inputs and a button.
 *
 * The form posts back to the SAME signed URL, so the token is carried without
 * the agency having an account, a password or anything to install. The sentence
 * above the button is the deal, restated at the moment they act on it.
 */
const quoteForm = (r, search, error = null) =>
  new Response(
    `${PAGE_HEAD}<div style="max-width:34rem;margin:0 auto;padding:28px 20px">`
    + `<div style="font-size:11px;letter-spacing:.18em;font-weight:800;color:#ec3013">NUM · TRAVEL REQUEST</div>`
    + `<h2 style="margin:10px 0 2px">${esc(r.ref)}</h2>`
    + `<p style="color:#6b625c;line-height:1.6;margin:6px 0 18px">${esc(itineraryLine(r) || 'See the email for the itinerary.')}<br>${esc(paxLine(r))}${r.cabin ? ` · ${esc(r.cabin)}` : ''}</p>`
    + (error ? `<p style="color:#c22a11;font-weight:600">${esc(error)}</p>` : '')
    + `<form method="POST" action="${esc(`/api/travel/quote${search}`)}" style="display:grid;gap:12px">`
    + `<label style="font-size:12px;letter-spacing:.1em;color:#6b625c">YOUR TOTAL PRICE<input name="amount" inputmode="decimal" required style="display:block;width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid #e8e0d9;border-radius:10px;margin-top:6px"></label>`
    + `<label style="font-size:12px;letter-spacing:.1em;color:#6b625c">CURRENCY<input name="currency" value="USD" style="display:block;width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid #e8e0d9;border-radius:10px;margin-top:6px"></label>`
    + `<label style="font-size:12px;letter-spacing:.1em;color:#6b625c">YOUR BOOKING REFERENCE<input name="partner_ref" style="display:block;width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid #e8e0d9;border-radius:10px;margin-top:6px"></label>`
    + `<label style="font-size:12px;letter-spacing:.1em;color:#6b625c">WHAT'S INCLUDED<textarea name="note" rows="4" style="display:block;width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid #e8e0d9;border-radius:10px;margin-top:6px"></textarea></label>`
    + `<p style="font-size:12.5px;color:#6b625c;line-height:1.6;margin:2px 0 0">You quote here. If the traveller accepts, <strong>you take their payment and you issue the confirmation</strong>, in your own name, on your own rail. Num does not hold traveller money.</p>`
    + `<button type="submit" style="cursor:pointer;border:0;border-radius:999px;background:#ec3013;color:#fff;font-weight:700;font-size:13px;letter-spacing:.06em;padding:14px">SEND THIS QUOTE</button>`
    + `</form></div>`,
    { status: error ? 400 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
