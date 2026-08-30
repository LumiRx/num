// Transactional email — the confirmation that makes a booking feel real.
//
// A reservation that exists only inside an app is a reservation people do not
// quite believe. The email is the artefact: it survives a reinstall, it can be
// forwarded to whoever is coming, and it is what somebody shows at a desk.
//
// ── WHY THE TEMPLATES LOOK LIKE THIS ──────────────────────────────────────
//
// Email is not the web. Fifteen years of client quirks mean the rules are:
//
//   · TABLES, not flexbox or grid. Outlook renders with Word's engine and
//     has no concept of either.
//   · INLINE styles. Gmail strips <style> blocks on forwarded mail, so a
//     stylesheet is a design that works until somebody forwards it.
//   · No web fonts. They fail silently and you get Times New Roman, which
//     makes a careful design look like a phishing attempt.
//   · A TEXT PART, always. Some clients show only text, and a missing text
//     part is a spam signal in its own right.
//
// So this is deliberately old-fashioned HTML. It is not how the app is built
// and it is the only thing that renders the same in Gmail, Apple Mail and
// Outlook, which between them are nearly everybody.

const BRAND = {
  // The house colours, matched to the app's Ember theme so the email and the
  // product are recognisably the same thing.
  accent: '#ec3013',
  accentDark: '#c22a11',
  paper: '#faf7f4',
  ink: '#1a1614',
  muted: '#6b625c',
  hairline: '#e8e0d9',
  // Georgia is on every Mac, PC and phone. A web font here would fail to
  // load and silently downgrade the whole design.
  heading: "Georgia, 'Times New Roman', serif",
  body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
};

export const emailReady = (env) => !!env.EMAIL && !!(env.EMAIL_FROM || 'hello@itsnum.com');

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The shell every email sits in.
 *
 * 600px is the width every client agrees on. Wider and Outlook clips it;
 * narrower and it looks like a receipt.
 */
function shell({ preheader, title, kicker, body, cta, footnote }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paper};">
<!-- The preheader is the grey line next to the subject in an inbox list. Left
     unset, clients pull the first words of the body, which is usually "View
     this email in your browser" — a wasted second impression. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.paper};">
<tr><td align="center" style="padding:28px 12px;">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${BRAND.hairline};">

  <tr><td style="padding:22px 28px 0;">
    <span style="font-family:${BRAND.body};font-size:13px;font-weight:800;letter-spacing:.18em;color:${BRAND.ink};">NUM</span>
    <span style="font-family:${BRAND.body};font-size:13px;letter-spacing:.14em;color:${BRAND.muted};"> · YOUR CONCIERGE</span>
  </td></tr>

  ${kicker ? `<tr><td style="padding:20px 28px 0;">
    <span style="font-family:${BRAND.body};font-size:11px;font-weight:800;letter-spacing:.16em;color:${BRAND.accent};">${esc(kicker)}</span>
  </td></tr>` : ''}

  <tr><td style="padding:8px 28px 0;">
    <h1 style="margin:0;font-family:${BRAND.heading};font-size:26px;line-height:1.25;font-weight:700;color:${BRAND.ink};">${esc(title)}</h1>
  </td></tr>

  <tr><td style="padding:14px 28px 0;font-family:${BRAND.body};font-size:15px;line-height:1.6;color:${BRAND.ink};">
    ${body}
  </td></tr>

  ${cta ? `<tr><td style="padding:24px 28px 0;">
    <!-- Bulletproof button: a table, not an <a> with padding. Outlook drops
         padding on inline anchors and you get an unclickable word. -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" bgcolor="${BRAND.accent}" style="border-radius:999px;">
        <a href="${esc(cta.href)}" style="display:inline-block;padding:13px 26px;font-family:${BRAND.body};font-size:13px;font-weight:700;letter-spacing:.06em;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(cta.label)}</a>
      </td></tr>
    </table>
  </td></tr>` : ''}

  <tr><td style="padding:26px 28px 24px;">
    <div style="border-top:1px solid ${BRAND.hairline};padding-top:14px;font-family:${BRAND.body};font-size:12px;line-height:1.55;color:${BRAND.muted};">
      ${footnote ?? 'Num is your concierge — one thread that books dinner, cars, tables and whole weekends.'}
    </div>
  </td></tr>

</table>

<div style="font-family:${BRAND.body};font-size:11px;color:${BRAND.muted};padding:16px 8px 0;max-width:600px;">
  You're getting this because you asked Num for something. This is a transactional message about your own plans, not marketing.
</div>

</td></tr></table>
</body></html>`;
}

/** A labelled row inside the card — the workhorse of every confirmation. */
const row = (label, value) =>
  value == null || value === ''
    ? ''
    : `<tr>
        <td style="padding:7px 0;font-family:${BRAND.body};font-size:12px;letter-spacing:.1em;color:${BRAND.muted};white-space:nowrap;vertical-align:top;">${esc(label)}</td>
        <td style="padding:7px 0 7px 16px;font-family:${BRAND.body};font-size:14px;color:${BRAND.ink};font-weight:600;">${esc(value)}</td>
      </tr>`;

const detailTable = (rows) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:6px;">${rows.join('')}</table>`;

// ── the templates ─────────────────────────────────────────────────────────

/**
 * Every email Num sends, in one place.
 *
 * Each returns { subject, preheader, html, text }. The text part is written by
 * hand rather than stripped from the HTML — an auto-stripped version reads
 * like debris, and for some recipients it is the ONLY thing they will see.
 */
export const TEMPLATES = {
  booking: (d) => ({
    subject: `Confirmed — ${d.title}`,
    preheader: `${d.title}${d.day ? ' · ' + d.day : ''}${d.time ? ' at ' + d.time : ''}. Everything you need is in here.`,
    kicker: 'CONFIRMED',
    title: d.title,
    body:
      `<p style="margin:0 0 4px;">${d.intro ?? 'That\'s locked in. Here it is in full:'}</p>` +
      detailTable([
        row('WHEN', [d.day, d.time].filter(Boolean).join(' · ')),
        row('WHERE', d.place),
        row('ADDRESS', d.address),
        row('PARTY', d.party ? `${d.party} ${d.party === 1 ? 'person' : 'people'}` : null),
        row('COST', d.cost),
        row('REFERENCE', d.reference),
      ]) +
      (d.note ? `<p style="margin:16px 0 0;color:${BRAND.muted};font-size:13.5px;">${esc(d.note)}</p>` : ''),
    cta: d.link ? { href: d.link, label: 'OPEN IN NUM' } : null,
    footnote: 'Need it moved or cancelled? Just tell Num — it\'s faster than calling.',
    text: [
      `Confirmed — ${d.title}`,
      '',
      [d.day, d.time].filter(Boolean).join(' · '),
      d.place,
      d.address,
      d.party ? `Party of ${d.party}` : '',
      d.cost,
      d.reference ? `Reference: ${d.reference}` : '',
      '',
      d.note ?? '',
      d.link ? `Open in Num: ${d.link}` : '',
    ].filter(Boolean).join('\n'),
  }),

  errand: (d) => ({
    subject: `${d.runner} is bringing your ${d.title}`,
    preheader: `Handover code ${d.code}. ★${d.bounty} is held until you confirm.`,
    kicker: 'ON ITS WAY',
    title: `${d.runner} is on it`,
    body:
      `<p style="margin:0 0 4px;">Someone nearby took your errand and is bringing it over.</p>` +
      detailTable([
        row('WHAT', d.title),
        row('TO', d.deliverTo),
        row('HANDOVER CODE', d.code),
        row('HELD', `★${d.bounty}${d.cap ? ` + up to ★${d.cap} to spend` : ''}`),
      ]) +
      `<p style="margin:16px 0 0;color:${BRAND.muted};font-size:13.5px;">Give them the handover code when it arrives. The Stars only move once you confirm — nothing is released before that.</p>`,
    cta: d.link ? { href: d.link, label: 'TRACK IT' } : null,
    footnote: 'Errands are paid in Stars, held by Num until you say it arrived.',
    text: [
      `${d.runner} is bringing your ${d.title}`,
      '',
      `To: ${d.deliverTo}`,
      `Handover code: ${d.code}`,
      `Held: ★${d.bounty}${d.cap ? ` + up to ★${d.cap} to spend` : ''}`,
      '',
      'Give them the code on arrival. Stars are released only when you confirm.',
      d.link ? `Track it: ${d.link}` : '',
    ].filter(Boolean).join('\n'),
  }),

  planInvite: (d) => ({
    subject: `${d.from} added you to ${d.plan}`,
    preheader: 'Your two concierges can talk directly once you join — plans just land.',
    kicker: 'YOU\'RE INVITED',
    title: d.plan,
    body:
      `<p style="margin:0 0 10px;"><strong>${esc(d.from)}</strong> is putting together ${esc(d.plan)} and added you.</p>` +
      `<p style="margin:0;color:${BRAND.muted};font-size:14px;">Join and whatever either of you books, the whole group sees — nobody retypes an address or forwards a screenshot.</p>`,
    cta: d.link ? { href: d.link, label: 'JOIN THE PLAN' } : null,
    footnote: 'This link is yours alone. It signs you in on whatever device you open it on.',
    text: [
      `${d.from} added you to ${d.plan}`,
      '',
      'Join and whatever either of you books, the whole group sees.',
      d.link ? `Join: ${d.link}` : '',
    ].filter(Boolean).join('\n'),
  }),

  changed: (d) => ({
    subject: `Changed — ${d.title}`,
    preheader: `${d.what}. Nothing else moved.`,
    kicker: 'SOMETHING MOVED',
    title: d.title,
    body:
      `<p style="margin:0 0 4px;">${esc(d.what)}</p>` +
      detailTable([
        row('WAS', d.was),
        row('NOW', d.now),
        row('WHERE', d.place),
      ]) +
      `<p style="margin:16px 0 0;color:${BRAND.muted};font-size:13.5px;">Everything else on this booking is unchanged.</p>`,
    cta: d.link ? { href: d.link, label: 'SEE THE DETAILS' } : null,
    text: [`Changed — ${d.title}`, '', d.what, d.was ? `Was: ${d.was}` : '', d.now ? `Now: ${d.now}` : '', d.link ? `Details: ${d.link}` : ''].filter(Boolean).join('\n'),
  }),

  /**
   * The travel handoff — the only email in this file that goes to a BUSINESS
   * rather than to a member, and the only one whose job is legal as much as
   * commercial.
   *
   * Two sentences here are load-bearing and must not be softened: the agency
   * quotes, and the agency collects payment from the traveller directly. That
   * is the property that keeps Num out of the passenger-money business
   * (HQ/divisions/num/REFERRAL_STRUCTURE_ANALYSIS.md §1), and an email that
   * merely implies it is an email a partner can honestly misread.
   *
   * The subject carries the NUM- reference first, so a shared inbox can be
   * filtered on it and a reply keeps the thread — LETSGO2TRIP_MEETING_BRIEF.md
   * §6.1. `d.text` is the plain-text handoff built by travelreferral.mjs, which
   * is the same artefact an operator pastes into WhatsApp; passing it through
   * keeps the two channels identical rather than merely similar.
   */
  travelReferral: (d) => ({
    subject: d.subject ? `Num travel request — ${d.subject}` : `Num travel request — ${d.ref}`,
    preheader: `${d.itinerary ?? 'A qualified request'} · ${d.pax ?? ''} · you quote and you take payment directly.`,
    kicker: 'TRAVEL REQUEST',
    title: `${d.ref} — ${d.itinerary || 'a request from a Num member'}`,
    body:
      `<p style="margin:0 0 4px;">A Num member has asked for this and it is yours to quote${d.sla_hours ? `, ideally within ${esc(String(d.sla_hours))} hours` : ''}.</p>`
      + detailTable([
        row('REFERENCE', d.ref),
        row('PRODUCT', d.product),
        row('ITINERARY', d.itinerary),
        row('PASSENGERS', d.pax),
        row('CABIN', d.cabin),
        row('TRAVELLER BUDGET', d.budget),
        row('NOTES', d.notes),
        row('CONTACT', d.contact),
      ])
      + `<p style="margin:18px 0 0;font-size:14px;line-height:1.6;"><strong>You quote, and you take the traveller's payment directly. You issue the confirmation in your own name.</strong> Num does not hold traveller money and does not issue tickets — we introduce the traveller, relay your quote, and invoice commission afterwards against your own booking reference.</p>`
      + `<p style="margin:12px 0 0;color:${BRAND.muted};font-size:13px;">The contact details above are for this booking only. Please don't add them to a marketing list.</p>`,
    cta: d.link ? { href: d.link, label: 'ATTACH YOUR QUOTE' } : null,
    footnote: `Reply to this email quoting ${esc(d.ref ?? '')} if you'd rather answer in writing — either way reaches the same desk.`,
    // Written by hand and complete: for a small agency working a shared inbox
    // on a phone, this is very often the only part that gets read.
    text: d.text ?? [
      `NUM TRAVEL REQUEST — ${d.ref}`,
      '',
      d.itinerary,
      d.pax,
      d.budget ? `Traveller's budget: up to ${d.budget}` : '',
      d.notes,
      '',
      `Contact: ${d.contact ?? '(reply here)'}`,
      '',
      'You quote and you take the traveller\'s payment directly, and you issue the confirmation. Num does not hold traveller money.',
      d.link ? `Attach your quote: ${d.link}` : '',
    ].filter(Boolean).join('\n'),
  }),
};

// ── sending ───────────────────────────────────────────────────────────────

/**
 * Send one transactional email.
 *
 * Never throws at the caller. An email is a courtesy on top of something that
 * has already happened — a booking that succeeded must not report failure
 * because a mail server was slow.
 */
export async function sendEmail(env, { to, template, data, ctx }) {
  if (!to || !TEMPLATES[template]) return { sent: false, reason: 'bad_request' };
  if (!env.EMAIL) return { sent: false, reason: 'email_not_enabled' };

  const t = TEMPLATES[template](data ?? {});
  const html = shell({
    preheader: t.preheader,
    title: t.title,
    kicker: t.kicker,
    body: t.body,
    cta: t.cta,
    footnote: t.footnote,
  });

  const job = env.EMAIL.send({
    to,
    from: { email: env.EMAIL_FROM || 'hello@itsnum.com', name: 'Num' },
    subject: t.subject,
    html,
    // Both parts, always. Text-only clients exist, and a missing text part is
    // itself a spam signal.
    text: t.text,
  })
    .then(() => ({ sent: true }))
    .catch((err) => {
      console.warn('[email]', template, err?.message ?? err);
      return { sent: false, reason: String(err?.message ?? err).slice(0, 160) };
    });

  if (ctx?.waitUntil) {
    ctx.waitUntil(job);
    return { sent: true, queued: true };
  }
  return job;
}

// ── routes ────────────────────────────────────────────────────────────────

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function handleEmail(request, env, path, ctx) {
  if (path === '/status') {
    return json({
      enabled: !!env.EMAIL,
      from: env.EMAIL_FROM || 'hello@itsnum.com',
      templates: Object.keys(TEMPLATES),
      note: env.EMAIL
        ? 'Ready.'
        : 'Add the send_email binding and onboard the domain: npx wrangler email sending enable itsnum.com',
    });
  }

  // A real send, so the design can be checked in an actual inbox rather than
  // in a preview that lies about how Gmail will treat it.
  if (path === '/test' && request.method === 'POST') {
    if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);
    const b = await request.json().catch(() => ({}));
    if (!b.to) return json({ error: 'to is required' }, 400);
    const out = await sendEmail(env, { to: b.to, template: b.template ?? 'booking', data: b.data ?? SAMPLE[b.template ?? 'booking'] });
    return json(out);
  }

  // The rendered HTML, for checking the design without spending a send.
  if (path === '/preview') {
    const url = new URL(request.url);
    const name = url.searchParams.get('template') ?? 'booking';
    if (!TEMPLATES[name]) return json({ error: `unknown template. try: ${Object.keys(TEMPLATES).join(', ')}` }, 404);
    const t = TEMPLATES[name](SAMPLE[name]);
    return new Response(shell({ preheader: t.preheader, title: t.title, kicker: t.kicker, body: t.body, cta: t.cta, footnote: t.footnote }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  return json({ error: 'not found' }, 404);
}

/** Realistic sample data — a preview with lorem ipsum tests nothing. */
const SAMPLE = {
  booking: {
    title: 'Dinner at Gaggan',
    day: 'Sunday 2 August',
    time: '20:00',
    place: 'Gaggan Anand',
    address: '68/1 Soi Langsuan, Ploenchit Rd, Bangkok',
    party: 4,
    cost: '★529 · pay there',
    reference: 'NUM-8F2K',
    note: 'They hold the table for 15 minutes. Tell Num if you\'re running late and it\'ll call ahead.',
    link: 'https://app.itsnum.com/?app',
  },
  errand: { runner: 'Ben', title: 'USB-C charger', deliverTo: 'Sukhumvit Soi 11, room 704', code: 'WKS7LD', bounty: 40, cap: 50, link: 'https://app.itsnum.com/?app' },
  planInvite: { from: 'Dre', plan: 'Bangkok weekend', link: 'https://app.itsnum.com/?i=example' },
  changed: { title: 'Dinner at Gaggan', what: 'The restaurant moved your table half an hour later.', was: 'Sun 2 Aug · 20:00', now: 'Sun 2 Aug · 20:30', place: 'Gaggan Anand', link: 'https://app.itsnum.com/?app' },
  travelReferral: {
    ref: 'NUM-K7QP42',
    subject: 'NUM-K7QP42 Phuket 2026-09-04–2026-09-11 2 adults',
    product: 'flight',
    itinerary: 'LHR → HKT · out 2026-09-04 · back 2026-09-11',
    pax: '2 adults',
    cabin: 'Economy',
    budget: '1800.00 GBP',
    notes: 'Aisle seats together. Flexible by a day either side.',
    contact: 'Viv Carter · viv@example.com · +447700900123',
    sla_hours: 24,
    link: 'https://app.itsnum.com/api/travel/quote?ref=NUM-K7QP42&t=example',
  },
};
