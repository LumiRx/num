/**
 * FIRST CLOSE — the agent whose only job is one signed merchant.
 *
 * ── WHY THIS IS NOT ANOTHER OUTREACH AGENT ───────────────────────────────
 *
 * Dre asked for an agent that gets a business signed up inside 24 hours, and
 * the obvious build is a faster OUTREACH_EMAIL: more sends, wider net, 92,198
 * addresses sitting in `leads` with status 'new'. That build would fail, and
 * it would fail for a reason worth writing down rather than rediscovering.
 *
 * NUM has already contacted 1,051 businesses. One of them raised a hand.
 * Adam at the Holiday Inn Express Edinburgh City Centre filled in the claim
 * form from an iPhone on 24 August and left a working reception address. On
 * 30 August that row is still `state = 'pending'`, unanswered, six days old.
 *
 * A funnel that ignores the person who already said yes does not have a
 * top-of-funnel problem. Sending another ten thousand emails would have added
 * another Adam, and then ignored him too.
 *
 * So this agent is ranked, not wide. It works OUTWARDS from the warmest
 * signal NUM holds, and the cold list is the last thing it touches rather
 * than the first.
 *
 * ── THE SECOND REASON VOLUME WAS THE WRONG ANSWER ────────────────────────
 *
 * Nothing NUM sent since 30 July has arrived. Every invite the cron has
 * attempted this week failed, and the errors say exactly why:
 *
 *   40 x "no RESEND_KEY"                                 (27 Aug)
 *    6 x "resend 403 ... not authorized to send emails
 *         from itsnum.com"                               (30 Aug, 08:00-08:30)
 *
 * The cron is alive. It fires every five minutes. It has been rejected on
 * every single attempt for five days, and the only reason anybody knows is
 * that somebody read the `error` column. An agent that sends into that is not
 * an agent, it is a log entry — so `readiness()` below refuses to pretend,
 * and `send_path_proven` in state.mjs derives the answer from what actually
 * happened rather than from whether a secret exists.
 *
 * ── AND THE THIRD THING, WHICH IS THE HARDEST ────────────────────────────
 *
 * There is nothing a business can buy. Every rate in commission.mjs is
 * performance-based — 10% of a reported bill, $2 per table otherwise, 20% on
 * an activity — so a merchant becomes a PAYING customer only after a
 * traveller completes a booking through NUM. `num_commissions` and
 * `num_orders` are both empty, and 2-4 people ask NUM anything on a given day.
 *
 * That is not a reason to give up on 24 hours. It is a reason to be exact
 * about what 24 hours can produce: a signed, logged-in merchant with a live
 * listing and a first billable event pending. Calling that "a paying
 * customer" would be the invent_fact rule broken against ourselves, which is
 * the only direction nobody checks.
 */

/** How warm a contact is, highest first. The number is the sort key. */
export const HEAT = Object.freeze({
  claimed_pending: 100, // filled in the claim form and is waiting on us
  clicked: 80, //         opened the invite and clicked through
  opened: 60, //          opened the invite
  invited_silent: 40, //  we wrote, they said nothing
  demand_backed: 30, //   never contacted, but travellers ask about their city
  cold: 10, //            an address and nothing else
});

/** A contact NUM must not approach, whatever its heat. */
export const DISQUALIFY = Object.freeze({
  opted_out: 'on num_optouts or leads.status = opted_out',
  unsubscribed: 'unsubscribed from an earlier invite',
  bounced: 'the address bounced — sending again teaches the provider we do not listen',
  no_address: 'no business address on the listing',
  already_claimed: 'the listing is already claimed, so there is nobody to sign up',
});

/**
 * Freemail is not a disqualifier here, unlike in invitecron.mjs.
 *
 * There it orders 7,651 gmail addresses last, correctly — a cold campaign
 * that opens at a personal inbox looks like spam and burns the domain. But a
 * hotel receptionist who has ALREADY filled in our claim form and left a
 * gmail address is not a cold lead with a bad address; she is the warmest
 * contact in the database. Heat outranks address shape, and only for contacts
 * that reached out first.
 */
const FREEMAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mail|gmx|proton(mail)?)\./i;

export const isFreemail = (email) => FREEMAIL.test(String(email || ''));

/**
 * Score one candidate row.
 *
 * Takes a plain object rather than a DB row on purpose, so the ranking can be
 * tested without a database and audited without a query planner.
 *
 * @param {object} c
 * @param {string} [c.email]
 * @param {string} [c.claim_state]   pending | approved | rejected
 * @param {string} [c.invite_status] queued | sent | failed | unsubscribed | bounced
 * @param {string} [c.clicked_at]
 * @param {string} [c.opened_at]
 * @param {number} [c.dest_asks]     how many travellers asked about their city
 * @param {boolean} [c.opted_out]
 * @param {boolean} [c.claimed]      the listing already has an owner
 * @returns {{heat:number, why:string} | {heat:0, blocked:string}}
 */
export function score(c = {}) {
  if (c.opted_out) return { heat: 0, blocked: DISQUALIFY.opted_out };
  if (c.invite_status === 'unsubscribed') return { heat: 0, blocked: DISQUALIFY.unsubscribed };
  if (c.invite_status === 'bounced') return { heat: 0, blocked: DISQUALIFY.bounced };
  if (!c.email) return { heat: 0, blocked: DISQUALIFY.no_address };
  if (c.claimed) return { heat: 0, blocked: DISQUALIFY.already_claimed };

  if (c.claim_state === 'pending') {
    return { heat: HEAT.claimed_pending, why: 'they filled in the claim form and are waiting on us' };
  }
  if (c.clicked_at) return { heat: HEAT.clicked, why: 'opened the invite and clicked through' };
  if (c.opened_at) return { heat: HEAT.opened, why: 'opened the invite' };
  if (c.invite_status === 'sent') return { heat: HEAT.invited_silent, why: 'invited, no reply' };
  if ((c.dest_asks || 0) > 0) {
    return {
      heat: HEAT.demand_backed,
      why: `${c.dest_asks} traveller ask${c.dest_asks === 1 ? '' : 's'} in their city`,
    };
  }
  return { heat: HEAT.cold, why: 'an address and nothing else' };
}

/** Rank a list of candidates warmest first, dropping the disqualified. */
export function rank(candidates = []) {
  return candidates
    .map((c) => ({ ...c, ...score(c) }))
    .filter((c) => c.heat > 0)
    .sort((a, b) => b.heat - a.heat || String(a.email).localeCompare(String(b.email)));
}

/**
 * The warm queue, straight out of D1.
 *
 * LEFT JOINs on purpose: a pending claim with no matching invite row is the
 * single most valuable row in the table, and an INNER JOIN would have hidden
 * exactly the contact this agent exists to find.
 */
export const QUEUE_SQL = `
  SELECT
    p.id                AS place_id,
    p.name              AS business_name,
    p.category          AS category,
    p.dest              AS dest,
    COALESCE(c.claimant_email, i.email, l.email) AS email,
    c.state             AS claim_state,
    c.claimant_name     AS claimant_name,
    i.status            AS invite_status,
    i.opened_at         AS opened_at,
    i.clicked_at        AS clicked_at,
    (SELECT COUNT(*) FROM num_asks a WHERE a.dest = p.dest) AS dest_asks,
    (SELECT COUNT(*) FROM num_optouts o
       WHERE o.email = COALESCE(c.claimant_email, i.email, l.email)) AS opted_out
  FROM places p
  LEFT JOIN num_claims  c ON c.place_id = p.id AND c.state = 'pending'
  LEFT JOIN num_invites i ON i.email    = c.claimant_email
  LEFT JOIN leads       l ON l.place_id = p.id
  WHERE COALESCE(c.claimant_email, i.email, l.email) IS NOT NULL
`;

/**
 * Is this agent able to do anything at all right now?
 *
 * Returns blockers with the fix attached, because "the agent ran and closed
 * nobody" and "the agent could not send a single email for five days" look
 * identical from outside and are not the same problem.
 *
 * @param {object} facts derived from the database, never from a human flag
 * @returns {{ok:boolean, blockers:Array<{what:string, fix:string}>}}
 */
export function readiness(facts = {}) {
  const blockers = [];

  if (facts.lastSendError) {
    blockers.push({
      what: `outbound email is failing: ${facts.lastSendError}`,
      fix: /not authorized to send/i.test(facts.lastSendError)
        ? 'the RESEND_KEY on num-app is a restricted key with no authorised domain. Issue a key in the Resend team that owns the verified itsnum.com domain, then wrangler secret put RESEND_KEY'
        : 'read num_invites.error for the last failed row and fix that before sending anything else',
    });
  }

  // Inbound is worth its own blocker rather than a footnote. 1,051 businesses
  // were invited and asked to reply; itsnum.com's MX points at SES inbound and
  // num_inbox holds three demo rows. Every reply those invites produced went
  // somewhere nobody reads, which is worse than never having asked.
  if (!facts.inboxReceiving) {
    blockers.push({
      what: 'no reply from a business has ever reached num_inbox',
      fix: 'route inbound mail for itsnum.com into the worker and write it to num_inbox — an invitation that cannot be answered is not an invitation',
    });
  }

  if (facts.pendingClaims > 0) {
    blockers.push({
      what: `${facts.pendingClaims} claim${facts.pendingClaims === 1 ? '' : 's'} sitting unanswered`,
      fix: 'answer these before sending anything new. A business that already said yes is not a lead, it is a customer being kept waiting',
    });
  }

  return { ok: blockers.length === 0, blockers };
}

/**
 * What "closed" means, so it cannot quietly soften.
 *
 * A merchant is signed when all four are true. Three of four is a promising
 * conversation, and reporting a promising conversation as a close is the
 * fastest way to lose the ability to tell.
 */
export const CLOSED = Object.freeze([
  'the claim on their listing is approved, not pending',
  'a real person at that business has logged into the console at least once',
  'their listing shows the details they gave us, not the ones we scraped',
  'they have seen the rate they will be billed, in writing, before any booking',
]);

/**
 * Has this business actually signed up?
 * @returns {{closed:boolean, missing:string[]}}
 */
export function isClosed(b = {}) {
  const missing = [];
  if (b.claim_state !== 'approved') missing.push(CLOSED[0]);
  if (!b.first_login_at) missing.push(CLOSED[1]);
  if (!b.profile_edited_at) missing.push(CLOSED[2]);
  if (!b.rate_disclosed_at) missing.push(CLOSED[3]);
  return { closed: missing.length === 0, missing };
}

/**
 * And the distinction the 24-hour target turns on.
 *
 * Signed is not paying. Every NUM merchant rate bills after a completed
 * booking, so a merchant who signs today owes nothing today, and will owe
 * nothing until a traveller books through us. Saying otherwise to Dre would
 * be inventing a fact in the one direction nobody audits.
 */
export const isPaying = (b = {}) => Number(b.commission_cs || 0) > 0;
