/**
 * The email a business gets when its claim is APPROVED.
 *
 * ── HOW THIS DIFFERS FROM THE RECEIPT ─────────────────────────────────────
 *
 * `growth/worker.js sendClaimWelcome` already sends a receipt the moment a
 * form is submitted: "we have your claim, a human will check it." That is a
 * confirmation, and it correctly promises nothing.
 *
 * This is the other end — the message that says the check is done and the
 * listing is theirs. It is the first email in which Num asks a business to do
 * something, so the bar is different: every sentence has to be true on the day
 * it is sent.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CLAIM ───────────────────────────────────
 *
 * The same discipline the receipt already applies, for the same reasons:
 *
 *   · NO bookings. The booking desk returns 503 in production (BOOKDESK_ENABLED
 *     is unset). Telling a restaurant Num will send it reservations is a lie
 *     with a date on it.
 *   · NO QR pay. `num_paylinks` has no rows.
 *   · NO commission or fee figure. The public site and commission.mjs have
 *     disagreed about the number, and quoting either in writing to a merchant
 *     turns an internal inconsistency into a contract dispute.
 *   · NO ranking promise. The console page states plainly that category,
 *     rating and position are not editable, by anyone, at any price. This
 *     email must not imply otherwise.
 *
 * What it does say is what is actually true today: the listing is live in a
 * directory of 2.5M places that a concierge reads when travellers ask, they
 * control what it says, and here is the door.
 */

/**
 * Where an owner manages their listing.
 *
 * No key in the URL, ever — a link that authorised anything would be a
 * credential in an inbox, in a forwarded email and in every referrer. The
 * business name is a PREFILL only: it saves an owner from arriving at a blank
 * search box and typing their own name, and grants nothing.
 */
export const CONSOLE_URL = 'https://app.itsnum.com/api/biz/console';

export const consoleLink = (business) =>
  (business ? `${CONSOLE_URL}?q=${encodeURIComponent(String(business).slice(0, 80))}` : CONSOLE_URL);

const firstName = (full) => String(full ?? '').trim().split(/\s+/)[0] || '';

/**
 * @returns {{ subject: string, text: string }}
 */
export function onboardingEmail({
  business, contact, country, waitedDays = 0, places = null, contactAddress = null,
} = {}) {
  const th = String(country ?? '').toUpperCase() === 'TH';
  const name = firstName(contact);
  const biz = String(business ?? 'your business').trim();
  const link = consoleLink(biz);
  /**
   * The coverage number, read from the database at send time.
   *
   * It said "2.5 million" while the directory held 2,686,795 — the same
   * hand-written-number drift aifacts.mjs exists to stop, in the one email a
   * business owner reads most carefully. A vague "2.5 million" understates us
   * by two hundred thousand places AND is the kind of round number that reads
   * as marketing rather than fact.
   */
  const count = Number(places) > 0
    ? `${Math.floor(Number(places)).toLocaleString('en-GB')} real places`
    : 'millions of real places';
  /**
   * The address we tell them to write to.
   *
   * info@itsnum.com's MX points at an SES inbound host with no receipt rule
   * set, so it rejects at the SMTP layer. Printing it under a sentence that
   * promises "a person will read it" is a promise the infrastructure breaks.
   */
  const reply = String(contactAddress || 'info@itsnum.com');
  // SAY SOMETHING ABOUT THE WAIT, WHEN THERE HAS BEEN ONE.
  //
  // Six businesses signed up between 9 and 29 August and heard nothing back —
  // the signup alerts fired but one landed inside the SMS outage and the rest
  // were never actioned. Writing to someone three weeks later as though they
  // filled the form this morning is the kind of small dishonesty a business
  // owner notices and remembers. One sentence, no excuse, no grovelling.
  const late = Number(waitedDays) >= 3;

  if (th) {
    return {
      subject: `${biz} พร้อมใช้งานบน NUM แล้ว`,
      text: [
        name ? `สวัสดีคุณ ${name}` : 'สวัสดีครับ',
        '',
        late
          ? `ตรวจสอบเรียบร้อยแล้ว — ${biz} เป็นของคุณบน NUM แล้วครับ `
            + `ต้องขออภัยที่ตอบกลับช้าไป ${Math.round(Number(waitedDays))} วันครับ`
          : `ตรวจสอบเรียบร้อยแล้ว — ${biz} เป็นของคุณบน NUM แล้วครับ`,
        '',
        'NUM เป็นผู้ช่วยส่วนตัวที่นักท่องเที่ยวถามว่า "คืนนี้กินอะไรดี" '
          + `เราตอบจากฐานข้อมูลสถานที่จริง${Number(places) > 0 ? ` ${Math.floor(Number(places)).toLocaleString('en-GB')} แห่ง` : 'หลายล้านแห่ง'} และตอนนี้ร้านของคุณอยู่ในนั้น`,
        '',
        'จัดการข้อมูลร้านของคุณได้ที่:',
        link,
        '',
        'คุณแก้ไขได้: เวลาทำการ เบอร์โทร ที่อยู่ เว็บไซต์ และคำอธิบายร้าน',
        'สิ่งที่แก้ไม่ได้: หมวดหมู่ คะแนน และลำดับการแสดงผล — ไม่ว่าจะจ่ายเท่าไหร่ '
          + 'เพราะถ้าซื้อได้ นักท่องเที่ยวก็เลิกเชื่อเรา',
        '',
        'มีคำถาม ตอบกลับอีเมลนี้ได้เลยครับ',
        '',
        `NUM · ${reply}`,
      ].join('\n'),
    };
  }

  return {
    subject: `${biz} is live on NUM`,
    text: [
      name ? `Hi ${name},` : 'Hello,',
      '',
      late
        ? `We have checked your claim — ${biz} is yours on NUM. Sorry it took us `
          + `${Math.round(Number(waitedDays))} days to come back to you; that was longer than it should have been.`
        : `We have checked your claim — ${biz} is yours on NUM.`,
      '',
      'NUM is a personal concierge travellers ask things like "where should we eat tonight".'
        + ` It answers from a directory of ${count}, and yours is now one of them.`,
      '',
      'Manage your listing here:',
      link,
      '',
      'You control the opening hours, phone number, address, website and the description'
        + ' travellers see. Keeping the hours right is the single thing that matters most —'
        + ' it is the detail people act on.',
      '',
      'What you cannot change, and neither can anyone else: your category, your rating and'
        + ' where you appear. None of it is for sale at any price. If placement could be'
        + ' bought, a traveller would have no reason to trust the answer — and then being'
        + ' listed would be worth nothing to you either.',
      '',
      'Reply to this email if anything looks wrong and a person will read it.',
      '',
      `NUM · ${reply}`,
    ].join('\n'),
  };
}

/**
 * Send it, once, and record that it went.
 *
 * `num_claim_decisions.onboarded` is the guard: a business gets this email one
 * time, no matter how many times a decision is re-recorded or a sweep re-runs.
 * The flag is set only after the transport reports success, so a failed send
 * is retried rather than silently counted as delivered — the same mistake that
 * lost Fingal Hotel's signup alert.
 */
export async function sendOnboarding(env, claim, { mailer } = {}) {
  if (!env?.DB || !claim?.email) return { skipped: 'no email' };
  const row = await env.DB.prepare(
    'SELECT onboarded FROM num_claim_decisions WHERE claim_id = ?1 LIMIT 1',
  ).bind(String(claim.id)).first().catch(() => null);
  if (row?.onboarded) return { skipped: 'already onboarded' };

  // How long they actually waited, from the claim row itself.
  const waitedDays = claim.created_at
    ? Math.max(0, (Date.now() - Date.parse(`${String(claim.created_at).replace(' ', 'T')}Z`)) / 86_400_000)
    : 0;
  const places = await env.DB.prepare('SELECT COUNT(*) AS n FROM places').first()
    .then((r) => r?.n ?? null).catch(() => null);
  const { subject, text } = onboardingEmail({
    ...claim,
    business: claim.business ?? claim.business_name,
    waitedDays,
    places,
    contactAddress: env.MAIL_REPLY_TO || null,
  });
  const send = mailer ?? (await import('./mailer.mjs')).send;
  const out = await send(env, {
    to: claim.email,
    from: env.MAIL_FROM || 'NUM <info@itsnum.com>',
    subject,
    text,
  });

  if (out?.ok) {
    await env.DB.prepare(
      'UPDATE num_claim_decisions SET onboarded = 1 WHERE claim_id = ?1',
    ).bind(String(claim.id)).run().catch(() => {});
  }
  return out;
}

/**
 * Tell every approved business that nobody has told yet.
 *
 * `autoApproveAll` runs on the five-minute cron and never called
 * `sendOnboarding`; only the manual admin route did, and that route is behind
 * `BIZ_ONBOARD_EMAIL`. So on 30 Aug eight businesses were approved by the cron
 * and none of them were emailed — a third independent lock on the same door,
 * after the state that would not move and a mailer that could not reach them.
 *
 * This is a sweep rather than a hook on purpose. The three failures above were
 * all one-shot: something fired once, into a channel that was down, and the
 * system then believed the job was done. A sweep that re-reads the world each
 * tick cannot make that mistake — a business approved while the mailer is
 * broken is simply told when the mailer comes back, and `onboarded` is set
 * only on a send that actually succeeded, so it retries until it lands.
 *
 * Ordered oldest-first because that is who has waited longest. Capped per tick
 * so a backlog drains steadily rather than as one burst a provider reads as a
 * spike.
 */
/**
 * Has this exact failure already been reported?
 *
 * alert() does not throttle: it fans out to webhook, SMS and email every time
 * it is called. This sweep runs on the five-minute cron, so alerting on each
 * tick while the mailer is down would have sent 288 identical alerts a day
 * across three channels — and an alert that arrives 288 times is one nobody
 * reads, which is the failure mode every other guard in this file exists to
 * prevent.
 *
 * So: report a failure signature once, then stay quiet until it CHANGES. A new
 * business failing, or the same one failing differently, is news and alerts
 * again. The same six failing for the same reason is not news after the first
 * time.
 */
async function alreadyReported(env, signature) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS num_onboard_alerts (
       signature  TEXT PRIMARY KEY,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run().catch(() => {});
  const ins = await env.DB.prepare(
    'INSERT OR IGNORE INTO num_onboard_alerts (signature) VALUES (?1)',
  ).bind(signature).run().catch(() => null);
  return !ins?.meta?.changes;
}

export async function onboardApproved(env, { limit = 10, mailer } = {}) {
  if (!env?.DB) return { sent: 0, failed: 0, skipped: 'no database' };
  if (env.BIZ_ONBOARD_EMAIL !== 'on') return { sent: 0, failed: 0, skipped: 'BIZ_ONBOARD_EMAIL not on' };

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.business_name, c.contact_name, c.email, c.country, c.created_at
       FROM claims c
       JOIN num_claim_decisions d ON d.claim_id = CAST(c.id AS TEXT)
      WHERE d.decision = 'approved'
        AND COALESCE(d.onboarded, 0) = 0
        AND c.email IS NOT NULL AND c.email <> ''
      ORDER BY c.created_at ASC
      LIMIT ?1`,
  ).bind(limit).all().catch(() => ({ results: [] }));

  let sent = 0;
  let failed = 0;
  const errors = [];
  for (const claim of results ?? []) {
    const out = await sendOnboarding(env, claim, { mailer }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (out?.ok) sent += 1;
    else if (!out?.skipped) {
      failed += 1;
      // Kept, not swallowed. A silent catch here is the exact shape of the
      // three bugs this function exists to close.
      errors.push(`${claim.business_name}: ${out?.error ?? 'unknown'}`.slice(0, 160));
    }
  }
  // A send that succeeds clears the slate, so the next outage is reported
  // even though its signature may match one from before.
  if (sent) {
    await env.DB.prepare('DELETE FROM num_onboard_alerts').run().catch(() => {});
  }
  const repeated = failed ? await alreadyReported(env, errors.slice().sort().join(' | ').slice(0, 400)) : false;
  return { sent, failed, ...(errors.length ? { errors } : {}), ...(repeated ? { repeated: true } : {}) };
}
