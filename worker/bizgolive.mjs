/**
 * Telling a business its listing is actually live.
 *
 * ── THE LOOP THAT WAS LEFT OPEN ──────────────────────────────────────────
 *
 * A business NUM had never heard of can now tell us it exists
 * (worker/bizsubmit.mjs). Its row waits in `num_place_submissions`, gets
 * geocoded, gets reviewed, and — when somebody presses promote — becomes a
 * real `places` row a traveller can be sent to.
 *
 * And nobody tells the owner. `adminSubmissionPromote` writes the listing and
 * returns JSON to the admin who pressed the button. The person who filled in
 * the form, who was told "we will email you the moment your listing is live",
 * hears nothing.
 *
 * That promise is in `bizsubmit.SUBMISSION_STATE.new`, in writing, on their
 * screen. This is the half that keeps it.
 *
 * ── WHY A SWEEP, AGAIN ───────────────────────────────────────────────────
 *
 * The same reasoning as bizonboard.onboardApproved, and for the same reason it
 * had to be written twice: every failure this codebase has found was a hook
 * that fired once into a channel that was down and then believed the job was
 * done. A hook on the promote button would lose a business to one bad minute
 * on the mail provider. A sweep re-reads the world each tick, so a listing
 * promoted while the mailer is broken is announced when it comes back.
 *
 * `golive_at` is set only after a send that actually succeeded — never before,
 * never on a "we tried". That column is the difference between a business
 * being told and a row claiming it was.
 *
 * ── AND IT CARRIES A WAY IN ──────────────────────────────────────────────
 *
 * The email holds a single-use sign-in link (worker/bizsignin.mjs), so the
 * first thing an owner can do with their new listing is open it. Sending
 * somebody a "you're live" note that lands them on a search box is the
 * friction bizsignin exists to remove, and it would be worse here: they have
 * never seen NUM's console before.
 */

/** Self-migrating, like the rest. A duplicate-column error is the steady state. */
async function ensure(env) {
  for (const col of ['golive_at TEXT', 'golive_ref TEXT']) {
    await env.DB.prepare(`ALTER TABLE num_place_submissions ADD COLUMN ${col}`).run().catch(() => {});
  }
}

/**
 * The message.
 *
 * Says three things and no more: it is live, here is the door, and here is the
 * one thing worth doing first. Everything a business could be told at this
 * moment is true of NUM in general; only these are true of THEM today.
 *
 * What it deliberately does not promise, same list as bizonboard.mjs: no
 * bookings (the desk returns 503), no payments (`num_paylinks` is empty), no
 * ranking, no fee figure. A first email that oversells is the one a merchant
 * quotes back at you in March.
 */
export function goLiveEmail({ business, contact, signinLink, duplicate = false } = {}) {
  const biz = String(business ?? 'Your business').trim();
  const name = String(contact ?? '').trim().split(/\s+/)[0] || '';
  const link = signinLink || 'https://app.itsnum.com/api/biz/console';

  if (duplicate) {
    return {
      subject: `${biz} is on NUM — we already had a listing for you`,
      text: [
        name ? `Hi ${name},` : 'Hello,',
        '',
        `You told us about ${biz}. We already held a listing for it, so rather than making a second copy `
          + 'we have pointed you at the one we had — it is older, which means it already carries whatever '
          + 'travellers have seen of you.',
        '',
        'It is yours to manage here:',
        link,
        '',
        'The first thing worth checking is your opening hours. It is the detail people act on, and an old '
          + 'listing is most likely to be wrong about exactly that.',
        '',
        'Reply to this email if anything looks wrong and a person will read it.',
        '',
        'NUM',
      ].join('\n'),
    };
  }

  return {
    subject: `${biz} is live on NUM`,
    text: [
      name ? `Hi ${name},` : 'Hello,',
      '',
      `${biz} is now listed on NUM. A person checked it and added it by hand, which is why it took a `
        + 'couple of days rather than a couple of seconds.',
      '',
      'NUM is a personal concierge travellers ask things like "where should we eat tonight". It answers '
        + 'from real places, and yours is now one of them.',
      '',
      'Manage your listing here:',
      link,
      '',
      'This link signs you straight in. It works once and lasts fourteen days — so if you forward this '
        + 'email, the link in it will already be spent.',
      '',
      'The one thing worth doing first is your opening hours. It is the detail people act on: wrong hours '
        + 'send a guest to a locked door, and we sent them.',
      '',
      'What you cannot change, and neither can anyone else: your category, your rating and where you '
        + 'appear. None of it is for sale at any price. If placement could be bought, a traveller would '
        + 'have no reason to trust the answer — and then being listed would be worth nothing to you either.',
      '',
      'Reply to this email if anything looks wrong and a person will read it.',
      '',
      'NUM',
    ].join('\n'),
  };
}

/**
 * Tell everyone whose listing went live and who has not been told.
 *
 * Ordered oldest-first because that is who has waited longest, and capped per
 * tick so a backlog drains steadily rather than as one burst a mail provider
 * reads as a spike.
 *
 * Gated on the same secret as the other business email. One switch for
 * "NUM may write to merchants" is a switch somebody can reason about; two is
 * a switch somebody forgets.
 */
export async function goLiveSweep(env, { limit = 10, mailer } = {}) {
  if (!env?.DB) return { sent: 0, failed: 0, skipped: 'no database' };
  if (env.BIZ_ONBOARD_EMAIL !== 'on') return { sent: 0, failed: 0, skipped: 'BIZ_ONBOARD_EMAIL not on' };
  await ensure(env);

  const { results } = await env.DB.prepare(
    `SELECT id, name, email, status, place_id, created_at
       FROM num_place_submissions
      WHERE status IN ('promoted','duplicate')
        AND place_id IS NOT NULL
        AND email IS NOT NULL AND email <> ''
        AND golive_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const sub of results ?? []) {
    // Minted per send. A failed mint is not a reason to withhold the email —
    // the console link still gets them to a door they can open.
    let signinLink = null;
    try {
      const { mintSigninLink, signinUrl } = await import('./bizsignin.mjs');
      const token = await mintSigninLink(env, { placeId: sub.place_id, purpose: 'golive' });
      if (token) signinLink = signinUrl(env.NUM_APP_ORIGIN || 'https://app.itsnum.com', token);
    } catch { /* fall through to the plain console link */ }

    const { subject, text } = goLiveEmail({
      business: sub.name,
      signinLink,
      duplicate: sub.status === 'duplicate',
    });

    const send = mailer ?? (await import('./mailer.mjs')).send;
    const out = await send(env, {
      to: sub.email,
      from: env.MAIL_FROM || 'NUM <info@itsnum.com>',
      subject,
      text,
      headers: {
        'List-Unsubscribe': `<mailto:${env.MAIL_REPLY_TO || 'info@itsnum.com'}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      // Same audience rule as the onboarding email: only a transport that can
      // actually reach a stranger and report what happened may carry this.
      // Six messages were once "accepted" by a binding that could reach
      // nobody, and all six were marked done.
    }, { audience: 'external' }).catch((e) => ({ ok: false, error: String(e?.message || e) }));

    if (out?.ok) {
      await env.DB.prepare(
        "UPDATE num_place_submissions SET golive_at = datetime('now'), golive_ref = ?2 WHERE id = ?1",
      ).bind(sub.id, String(out.id ?? out.via ?? 'sent').slice(0, 80)).run().catch(() => {});
      sent += 1;
    } else if (!out?.skipped) {
      failed += 1;
      errors.push(`${sub.name}: ${out?.error ?? 'unknown'}`.slice(0, 160));
    }
  }

  return { sent, failed, ...(errors.length ? { errors } : {}) };
}

/**
 * Has this business been told? Read by the ops console so a promoted listing
 * whose owner is still in the dark is visible rather than assumed handled.
 */
export async function untold(env, { limit = 50 } = {}) {
  if (!env?.DB) return [];
  await ensure(env);
  const { results } = await env.DB.prepare(
    `SELECT id, name, email, status, place_id, created_at, reviewed_at
       FROM num_place_submissions
      WHERE status IN ('promoted','duplicate') AND golive_at IS NULL
      ORDER BY COALESCE(reviewed_at, created_at) ASC
      LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));
  return results ?? [];
}
