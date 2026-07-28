#!/usr/bin/env node
/** One-off: email the NUM Phuket Partner Brief (attached) via Resend.
 *  Run from num-console folder:  node scripts/send_brief.mjs sean@thatislumi.com  */
import { readFileSync } from 'node:fs';
const KEY = readFileSync('.resend_key','utf8').replace(/\s+/g,'');
const to = process.argv[2];
if (!to || !to.includes('@')) { console.log('Usage: node scripts/send_brief.mjs someone@email.com'); process.exit(1); }
const pdf = readFileSync('public/brief-num-phuket-7c4a.pdf');

const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1B1D36">
  <div style="background:linear-gradient(135deg,#6366F1,#8B5CF6);border-radius:14px;padding:22px 26px;color:#fff">
    <div style="font-family:Georgia,serif;font-style:italic;font-weight:700;font-size:26px">NuM</div>
    <div style="font-size:11px;letter-spacing:2px;opacity:.85">BY 5ARZ · PHUKET</div>
  </div>
  <p style="font-size:15px;line-height:1.6;margin:18px 0 0">Hey Sean,</p>
  <p style="font-size:15px;line-height:1.6">Attached is the <b>NUM Phuket Partner Brief</b> — everything we're building, what's already live, how we earn, and the partners we want first. Six pages, five-minute read.</p>
  <p style="font-size:15px;line-height:1.6"><b>Fastest way to get it:</b> scan the QR on the cover — the AI concierge is live on LINE right now. Ask it for "best massage in Patong" in any language.</p>
  <p style="font-size:14px;line-height:1.7;color:#3A3E5C"><b>Ideal partners to start reaching out to:</b><br>
  ⛵ Boat charters, jet-ski &amp; water-sports operators (our flagship vertical — highest tickets)<br>
  🍽️ Top-rated restaurants &amp; beach clubs · 💆 spas &amp; massage studios<br>
  🏨 Guesthouses &amp; hostels without concierges (we become their front desk)<br>
  🛍️ Pharmacies, minimarts, beachwear &amp; SIM counters (promo-code affiliate deals)<br>
  🛺 Tuk-tuk drivers &amp; guides (referral cards — they earn stars per traveler)</p>
  <p style="font-size:14px;line-height:1.6;color:#3A3E5C">The pitch in one line: <b>free to join, guests in 9 languages, pay 10% only when a booking actually happens.</b></p>
  <p style="font-size:13px;color:#7C81A1;line-height:1.6">Online copy: <a href="https://num-console.thatislumi.workers.dev/brief-num-phuket-7c4a.pdf" style="color:#5B5FEF">brief (PDF)</a> · <a href="https://itsnum.com" style="color:#5B5FEF">itsnum.com</a> · claim funnel: <a href="https://itsnum.com/claim" style="color:#5B5FEF">/claim</a> · questions → just reply.</p>
</div>`;

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer '+KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from: 'Num by 5arz <info@5arz.com>',
    to: [to],
    reply_to: 'info@5arz.com',
    subject: 'NUM — Phuket Partner Brief (what we\'re building + who to reach out to)',
    html,
    attachments: [{ filename: 'NUM_Phuket_Partner_Brief.pdf', content: pdf.toString('base64') }],
  }),
});
const j = await res.json().catch(()=>({}));
if (!res.ok) { console.log('✗ failed:', res.status, JSON.stringify(j).slice(0,200)); process.exit(1); }
console.log('✓ brief emailed to', to, '· id', j.id);
