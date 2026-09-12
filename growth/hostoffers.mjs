/**
 * Offers on a job: who is offering, what it costs, and when it is confirmed.
 *
 * ── DRE'S THREE RULES, 12 SEP 2026 ───────────────────────────────────────
 *
 *   "we will just charge a small fee on the payment. they can offer as many
 *    jobs as they want they must complete the payment for confirmation to be
 *    set. also all ai agents to post as vip hosts and entrepreneurs. lets
 *    connect this to 5arz."
 *
 * 1. NUM is paid out of the payment, not out of the offer. Offering is free
 *    and unlimited — which is right: charging per offer silences exactly the
 *    hosts with the emptiest weeks, who are the ones a board should help.
 * 2. **Payment settles, THEN it is confirmed.** Not the other way round and
 *    not both at once.
 * 3. An agent may offer, and it says that it is one.
 *
 * ── WHY PAYMENT-BEFORE-CONFIRMED IS ITS OWN FUNCTION ─────────────────────
 *
 * `confirm` in `num_host_requests` already has its own code path, deliberately,
 * so that nothing sets `status='confirmed'` as a side effect of something else.
 * The same discipline applies harder here, because now a confirmation is also a
 * financial fact. A job that reads "confirmed" to a member who has not paid,
 * or to a host who has not been paid, is the worst state this product can
 * produce: both parties plan around it and one of them is wrong.
 *
 * So `canConfirm` fails CLOSED on everything — no payment record, a payment
 * that is merely authorised, a refund, a mismatch between what was quoted and
 * what settled. An unknown payment state is never a yes.
 *
 * ── AND WHY AN AGENT SAYS SO ─────────────────────────────────────────────
 *
 * Agents can offer. They are labelled, and the label leads.
 *
 * That is not a restriction bolted on to Dre's instruction; it is the only
 * version of it that does not destroy the thing it is being connected to.
 * 5arz exists to prove human work in an agent-driven economy — Proof of Human
 * Fulfilment is the product. A NUM board where an agent is indistinguishable
 * from a person is a live argument that the distinction cannot be made, sold
 * by the company selling the distinction.
 *
 * Labelled, it is the opposite: a member choosing between three offers sees
 * which are human-fulfilled and which are run by software, and picks. That is
 * 5arz demonstrating itself on real transactions — which the 5arz notes list
 * as an open question ("whether a full live demo loop exists"). This is one.
 *
 * The pattern is the one `worker/venuedisclosure.mjs` already runs for
 * clothing-optional venues: the fact leads, it is written plainly rather than
 * as a warning, and it is never inferred — only what the party declared.
 */

/** Who is behind an offer. Declared, never guessed. */
export const PARTY = Object.freeze({
  HUMAN: 'human',
  AGENT: 'agent',
});

/**
 * What the member reads, first, before anything else about the offer.
 *
 * Written the way the party would write it about itself. "AI agent" is a fact;
 * "WARNING: BOT" is an opinion, and one that would make an honest declaration
 * the worst commercial choice available — which is how you get dishonest ones.
 */
export const PARTY_LEAD = Object.freeze({
  human: null,
  agent: 'An AI agent, working for',
});

/**
 * 5arz Proof of Human Fulfilment.
 *
 * Held as a credential id and a checked-at time, never as a bare boolean: a
 * `true` with nothing behind it is a claim, and the whole point of PoHF is
 * that it is evidence somebody else can verify. No credential means UNKNOWN,
 * never "not human" — a host who simply has not been through 5arz yet must not
 * be labelled as software.
 */
export function humanProof(row) {
  const id = String(row?.pohf_id ?? '').trim();
  if (!id) return { state: 'unknown', label: null };
  if (row?.pohf_revoked_at) return { state: 'revoked', label: null };
  return {
    state: 'verified',
    credential: id,
    checked_at: row?.pohf_checked_at ?? null,
    label: 'Human-verified by 5arz',
  };
}

/**
 * How an offer is shown to the member choosing.
 *
 * The party type is the first field and the label is the first thing read.
 * An agent offer names the business or person it works FOR, because "an AI
 * agent" on its own tells a member nothing about who is accountable when the
 * car does not arrive.
 */
export function offerCard(offer) {
  const party = offer?.party === PARTY.AGENT ? PARTY.AGENT : PARTY.HUMAN;
  const proof = humanProof(offer);
  return {
    offer_id: offer.offer_id ?? offer.id,
    party,
    // Leads. An agent that reads as a person is the one thing this board
    // cannot allow, because it is the thing 5arz exists to make impossible.
    lead: party === PARTY.AGENT
      ? `${PARTY_LEAD.agent} ${offer.operator_name || offer.name || 'an operator'}`
      : proof.label,
    name: offer.name ?? null,
    operator_name: party === PARTY.AGENT ? (offer.operator_name ?? null) : null,
    blurb: offer.blurb ?? null,
    city: offer.city ?? null,
    // Only a human can carry PoHF. Reporting it on an agent would be the
    // credential meaning nothing.
    human_verified: party === PARTY.HUMAN && proof.state === 'verified',
    price_minor: offer.price_minor ?? null,
    currency: offer.currency ?? null,
    quote_only: !!offer.quote_only,
  };
}

/** NUM's cut, taken out of the payment. Small, flat where it can be. */
export const FEE_BPS = 500;           // 5%
export const FEE_MIN_MINOR = 100;     // and never less than a unit of currency
export const FEE_MAX_MINOR = 5000;    // and never more than 50, on any job

/**
 * What NUM keeps and what the host is owed.
 *
 * Capped at both ends on purpose. A percentage with no ceiling gives NUM an
 * interest in the size of a job it is not doing — the same reason
 * `NETWORK_FEE_MINOR` is flat — and a percentage with no floor costs more to
 * process than it collects.
 */
export function split(totalMinor) {
  const total = Math.max(0, Math.floor(Number(totalMinor) || 0));
  if (!total) return { total: 0, fee: 0, host: 0 };
  const raw = Math.round((total * FEE_BPS) / 10000);
  const fee = Math.min(Math.max(raw, FEE_MIN_MINOR), FEE_MAX_MINOR, total);
  return { total, fee, host: total - fee };
}

/** Payment states we will act on. Anything else is unknown, and unknown is no. */
export const PAID = Object.freeze(['succeeded', 'paid']);

/**
 * May this job be confirmed?
 *
 * Fails closed on every branch, and says which one — a host told "not yet"
 * with no reason will confirm it by hand somewhere else.
 */
export function canConfirm(job, payment) {
  if (!job) return { ok: false, why: 'no job' };
  if (String(job.status) !== 'open' && String(job.status) !== 'accepted') {
    return { ok: false, why: `this job is ${job.status}` };
  }
  if (!payment) {
    return { ok: false, why: 'Payment has not been taken yet — a job is confirmed once it is paid.' };
  }
  if (payment.refunded_at) return { ok: false, why: 'That payment was refunded.' };
  if (!PAID.includes(String(payment.status))) {
    // "requires_capture" is the dangerous one: money is held, not taken, and
    // it reads like success in a dashboard.
    return { ok: false, why: `Payment is ${payment.status || 'in an unknown state'}, not settled.` };
  }
  const owed = Math.floor(Number(job.price_minor) || 0);
  const got = Math.floor(Number(payment.amount_minor) || 0);
  if (owed && got < owed) {
    return { ok: false, why: 'Less was paid than the job was quoted at.' };
  }
  if (job.currency && payment.currency
      && String(job.currency).toUpperCase() !== String(payment.currency).toUpperCase()) {
    return { ok: false, why: 'The payment is in a different currency from the quote.' };
  }
  return { ok: true, ...split(got || owed) };
}
