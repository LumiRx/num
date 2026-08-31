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
export function onboardingEmail({ business, contact, country, waitedDays = 0 } = {}) {
  const th = String(country ?? '').toUpperCase() === 'TH';
  const name = firstName(contact);
  const biz = String(business ?? 'your business').trim();
  const link = consoleLink(biz);
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
          + 'เราตอบจากฐานข้อมูลสถานที่จริง 2.5 ล้านแห่ง และตอนนี้ร้านของคุณอยู่ในนั้น',
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
        'NUM · info@itsnum.com',
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
        + ' It answers from a directory of 2.5 million real places, and yours is now one of them.',
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
      'NUM · info@itsnum.com',
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
  const { subject, text } = onboardingEmail({ ...claim, business: claim.business ?? claim.business_name, waitedDays });
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
