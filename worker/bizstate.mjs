/**
 * WHERE THIS BUSINESS ACTUALLY IS, AND WHAT WOULD MOVE THEM FORWARD.
 *
 * ── THE NUMBER THAT MADE THIS NECESSARY ──────────────────────────────────
 *
 * 3,538 invitations sent. 668 opened. 77 clicked through to the claim page.
 * 9 filled the form. 4 ever started verification. 2 businesses verified.
 *
 * Two. And until this file, nothing in the system could answer "where did
 * the other 75 stop" for any individual business, because the answer was
 * spread across six tables that nobody joined: `num_invites` knows they
 * clicked, `claims` knows they typed their name, `num_claims` knows whether a
 * code was sent, `num_place_owners` knows whether it was proven,
 * `num_booking_channels` knows how they want bookings, `businesses` knows they
 * exist. Six half-answers and no whole one.
 *
 * So every conversation with a business started from nothing. You could not
 * write them a useful sentence without going and looking six things up, and
 * nobody was going to do that 77 times.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────
 *
 * One read that says where they are and what the single next move is. It is
 * the grounding for a drafted reply (bizreply.mjs will not assert anything
 * this does not report), the spine of the follow-up, and the thing that lets
 * a person open a thread and know the situation in one screen.
 *
 * ── WHY THE STEPS ARE EVIDENCE AND NOT A STATUS COLUMN ───────────────────
 *
 * There is no `status` field being maintained here, deliberately. A status
 * column is a claim somebody has to keep true, and this codebase has already
 * been bitten twice by exactly that: `num_claim_decisions.onboarded` was set
 * to 1 for six businesses that were never told anything, and the CHANGELOG
 * called three versions live that had been staged and never shipped.
 *
 * Every step below is DERIVED from a row that only exists if the thing
 * actually happened. `verified` is true because there is an unrevoked owner
 * row, not because a process said so. Nothing can drift, because there is
 * nothing to keep in step.
 */

/** The ladder, in order. A business is "at" the last step it has reached. */
export const STEPS = Object.freeze([
  'invited',    // we mailed them
  'opened',     // the pixel fired — weak, see below
  'clicked',    // they arrived on the claim page
  'applied',    // they filled the form
  'proving',    // a verification code went out
  'verified',   // they proved control of the listing
  'configured', // they said how bookings should reach them
  'live',       // recommendable, and able to receive a booking
]);

const rank = (s) => STEPS.indexOf(s);

/**
 * Everything, from whatever identifier is to hand.
 *
 * `email` is the one that always works, because it is what a mail server
 * gives us and what a thread is keyed on. The rest narrow it.
 */
export async function stateOf(env, { email = null, placeId = null, businessId = null, leadId = null } = {}) {
  if (!env?.DB) return null;
  const addr = email ? String(email).trim().toLowerCase().slice(0, 160) : null;
  if (!addr && !placeId && !businessId && !leadId) return null;

  const evidence = {};

  // ── the invitation, and what they did with it ──────────────────────────
  const invite = addr
    ? await env.DB.prepare(
      `SELECT token, business_name, dest, country, status, sent_at, opened_at, clicked_at,
              unsubscribed_at, open_count, click_count
         FROM num_invites WHERE lower(email) = ?1 ORDER BY sent_at DESC LIMIT 1`,
    ).bind(addr).first().catch(() => null)
    : null;

  // ── the form, if they filled it ────────────────────────────────────────
  const application = addr || placeId
    ? await env.DB.prepare(
      `SELECT id, business_name, contact_name, phone, email, place_id, state, created_at,
              booking_via, booking_system, booking_url
         FROM claims
        WHERE (?1 IS NOT NULL AND lower(email) = ?1) OR (?2 IS NOT NULL AND place_id = ?2)
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(addr, placeId).first().catch(() => null)
    : null;

  const pid = placeId || application?.place_id || null;

  // ── proof ──────────────────────────────────────────────────────────────
  const attempt = pid
    ? await env.DB.prepare(
      'SELECT state, channel, sent_at, expires_at, attempts FROM num_claims WHERE place_id = ?1 ORDER BY created_at DESC LIMIT 1',
    ).bind(pid).first().catch(() => null)
    : null;

  const owner = pid
    ? await env.DB.prepare(
      'SELECT business_id, method, verified_at FROM num_place_owners WHERE place_id = ?1 AND revoked_at IS NULL',
    ).bind(pid).first().catch(() => null)
    : null;

  const bid = businessId || owner?.business_id || null;

  // ── how they want bookings, and whether they are reachable ─────────────
  const channel = pid || bid
    ? await env.DB.prepare(
      `SELECT via, sms_to, email_to, system_name, booking_url, integration
         FROM num_booking_channels
        WHERE (?1 IS NOT NULL AND place_id = ?1) OR (?2 IS NOT NULL AND business_id = ?2)
        LIMIT 1`,
    ).bind(pid, bid).first().catch(() => null)
    : null;

  const group = bid
    ? await env.DB.prepare(
      `SELECT g.id, g.name, (SELECT COUNT(*) FROM num_business_group_sites x WHERE x.group_id = g.id) AS sites
         FROM num_business_group_sites s JOIN num_business_groups g ON g.id = s.group_id
        WHERE s.business_id = ?1`,
    ).bind(bid).first().catch(() => null)
    : null;

  evidence.invite = invite ?? null;
  evidence.application = application ?? null;
  evidence.attempt = attempt ?? null;
  evidence.owner = owner ?? null;
  evidence.channel = channel ?? null;
  evidence.group = group ?? null;

  /* ── the step, from the evidence ─────────────────────────────────────── */
  let step = 'invited';
  if (invite?.opened_at) step = 'opened';
  if (invite?.clicked_at) step = 'clicked';
  if (application) step = 'applied';
  if (attempt?.sent_at) step = 'proving';
  if (owner) step = 'verified';
  if (channel?.via) step = 'configured';
  // LIVE means a booking could actually reach them today. Not "they finished
  // signing up" — a venue that chose email and gave no address is configured
  // and unreachable, and calling that live would be the `onboarded` column all
  // over again.
  const reachable = channel?.via === 'email' ? !!channel.email_to
    : channel?.via === 'sms' ? !!channel.sms_to
      : channel?.via === 'own' ? !!channel.booking_url
        : channel?.via === 'none' ? true
          : false;
  if (owner && channel?.via && reachable) step = 'live';

  return {
    email: addr,
    business_name: application?.business_name || invite?.business_name || null,
    contact_name: application?.contact_name || null,
    place_id: pid, business_id: bid,
    dest: invite?.dest ?? null, country: invite?.country ?? null,
    step, rank: rank(step),
    unsubscribed: !!invite?.unsubscribed_at,
    bounced: String(invite?.status ?? '').startsWith('bounced'),
    reachable,
    evidence,
    next: nextMove({ step, invite, application, attempt, owner, channel, group, reachable }),
  };
}

/**
 * The single next thing. One, not a checklist.
 *
 * A business does not need a project plan from us; it needs to know the one
 * thing standing between it and being recommended. `blocked_by` says whose
 * move it is, because half of these are ours and pretending otherwise is how
 * a queue of our own unfinished work gets sent to a restaurant as a nudge.
 */
export function nextMove({ step, invite, application, attempt, owner, channel, group, reachable } = {}) {
  if (invite?.unsubscribed_at) {
    return { do: 'nothing', blocked_by: 'them', say: 'They asked to be left alone. Nothing further, ever.' };
  }
  if (String(invite?.status ?? '').startsWith('bounced_permanent')) {
    return { do: 'find another address', blocked_by: 'us', say: 'That mailbox does not exist. A different contact, or nothing.' };
  }
  switch (step) {
    case 'invited':
      return { do: 'wait', blocked_by: 'them', say: 'Invited, not opened. Nothing to chase yet.' };
    case 'opened':
      return {
        do: 'wait', blocked_by: 'them',
        // An open is a weak signal and saying otherwise would have us chasing
        // image proxies. Apple Mail Privacy Protection fetches the pixel
        // whether or not a person ever looked at the message.
        say: 'The message was fetched, which is not the same as read. Weak signal.',
      };
    case 'clicked':
      return {
        do: 'follow up once', blocked_by: 'them',
        say: 'They came to the claim page and did not finish. Until 18 Sep the form '
          + 'refused to submit without a mobile number, so this may well have been us.',
      };
    case 'applied':
      return attempt
        ? { do: 'help them find the code', blocked_by: 'them', say: 'They applied and a code went out. Ask whether it arrived.' }
        : { do: 'send the verification', blocked_by: 'us', say: 'They filled the form and nothing was sent to prove the listing. Ours.' };
    case 'proving':
      return attempt?.state === 'expired'
        ? { do: 'send a fresh code', blocked_by: 'us', say: 'Their code expired unused. Offer another.' }
        : { do: 'wait, then offer help', blocked_by: 'them', say: `Code sent by ${attempt?.channel ?? 'some channel'} and not yet used.` };
    case 'verified':
      return {
        do: 'ask how bookings should reach them', blocked_by: 'them',
        say: 'Verified, but nobody has asked how they want bookings. They cannot receive one until that is answered.',
      };
    case 'configured':
      return reachable
        ? { do: 'nothing', blocked_by: 'nobody', say: 'Configured and reachable.' }
        : {
          do: 'get the missing detail', blocked_by: 'them',
          say: channel?.via === 'email' ? 'They chose email and gave no address, so a booking cannot reach them.'
            : channel?.via === 'sms' ? 'They chose text and gave no number, so a booking cannot reach them.'
              : 'They book on their own system and we do not hold the link.',
        };
    case 'live':
      return group
        ? { do: 'nothing', blocked_by: 'nobody', say: `Live, in the group "${group.name}" with ${group.sites} sites.` }
        : { do: 'nothing', blocked_by: 'nobody', say: 'Live. If they run more than one site, they can add it.' };
    default:
      return { do: 'look', blocked_by: 'us', say: 'No step could be derived, which should not happen.' };
  }
}

/**
 * Everyone stuck at a step, for the follow-up and for the board.
 *
 * Excludes anyone who unsubscribed or hard-bounced at the query, not in the
 * caller. A list that has to be filtered by whoever uses it is a list that
 * will eventually be used unfiltered.
 */
export async function stuckAt(env, step, { limit = 200 } = {}) {
  if (!env?.DB || !STEPS.includes(step)) return [];
  await env.DB.prepare('SELECT 1').first().catch(() => {});

  if (step === 'clicked') {
    const { results } = await env.DB.prepare(
      `SELECT i.token, i.email, i.business_name, i.dest, i.country, i.clicked_at
         FROM num_invites i
         LEFT JOIN claims c        ON lower(c.email) = lower(i.email)
         LEFT JOIN num_suppressions s ON lower(s.email) = lower(i.email)
        WHERE i.clicked_at IS NOT NULL
          AND i.unsubscribed_at IS NULL
          AND i.status NOT LIKE 'bounced%'
          AND i.status <> 'complained'
          AND c.id IS NULL
          AND s.email IS NULL
        ORDER BY i.clicked_at ASC LIMIT ?1`,
    ).bind(limit).all();
    return results ?? [];
  }

  if (step === 'applied') {
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.email, c.business_name, c.place_id, c.created_at
         FROM claims c
         LEFT JOIN num_place_owners o ON o.place_id = c.place_id AND o.revoked_at IS NULL
        WHERE o.place_id IS NULL AND c.email IS NOT NULL
        ORDER BY c.created_at ASC LIMIT ?1`,
    ).bind(limit).all();
    return results ?? [];
  }

  if (step === 'verified') {
    const { results } = await env.DB.prepare(
      `SELECT o.place_id, o.business_id, o.verified_at, b.name AS business_name
         FROM num_place_owners o
         LEFT JOIN businesses b ON b.id = o.business_id
         LEFT JOIN num_booking_channels ch ON ch.place_id = o.place_id
        WHERE o.revoked_at IS NULL AND (ch.place_id IS NULL OR ch.via IS NULL)
        ORDER BY o.verified_at ASC LIMIT ?1`,
    ).bind(limit).all();
    return results ?? [];
  }

  return [];
}

/** The whole funnel in one row, counted rather than remembered. */
export async function funnel(env) {
  if (!env?.DB) return null;
  const one = async (sql) => (await env.DB.prepare(sql).first().catch(() => null))?.n ?? 0;
  return {
    invited: await one("SELECT COUNT(*) n FROM num_invites WHERE status='sent' OR status LIKE 'bounced%' OR status='complained'"),
    delivered: await one("SELECT COUNT(*) n FROM num_invites WHERE status='sent'"),
    bounced: await one("SELECT COUNT(*) n FROM num_invites WHERE status LIKE 'bounced%'"),
    opened: await one('SELECT COUNT(*) n FROM num_invites WHERE opened_at IS NOT NULL'),
    clicked: await one('SELECT COUNT(*) n FROM num_invites WHERE clicked_at IS NOT NULL'),
    applied: await one('SELECT COUNT(*) n FROM claims'),
    proving: await one('SELECT COUNT(*) n FROM num_claims'),
    verified: await one('SELECT COUNT(*) n FROM num_place_owners WHERE revoked_at IS NULL'),
    configured: await one('SELECT COUNT(*) n FROM num_booking_channels WHERE via IS NOT NULL'),
    replied: await one("SELECT COUNT(DISTINCT thread_id) n FROM num_biz_messages WHERE direction='in'"),
  };
}
