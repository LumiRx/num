// The confirmation email: who may receive one, what it says, and that it is
// never sent to an address nobody has confirmed.
// Run: node --test worker/bookingmail.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipientFor, dayOf, bookingData, declinedData, sendBookingMail } from './bookingmail.mjs';
import { composeTemplate } from './email.mjs';

test('recipient: a verified email, or an address on a phone-verified account; nothing else', () => {
  assert.deepEqual(recipientFor({ email: 'A@B.co', email_verified: 1, phone_verified: 0 }), { to: 'a@b.co', why: null });
  assert.deepEqual(recipientFor({ email: 'a@b.co', email_verified: 0, phone_verified: 1 }), { to: 'a@b.co', why: null });
  assert.deepEqual(recipientFor({ email: 'a@b.co', email_verified: 0, phone_verified: 0 }), { to: null, why: 'unverified' });
  assert.deepEqual(recipientFor({ email: '', email_verified: 1, phone_verified: 1 }), { to: null, why: 'no_email' });
  assert.deepEqual(recipientFor({ email: 'not an email', phone_verified: 1 }), { to: null, why: 'no_email' });
  assert.deepEqual(recipientFor(null), { to: null, why: 'no_email' });
});

test('the day reads like a person wrote it, and a non-date passes through', () => {
  assert.equal(dayOf('2026-09-25'), 'Fri 25 Sep');
  assert.equal(dayOf('tomorrow'), 'tomorrow');
  assert.equal(dayOf(null), null);
});

const ROW = { id: 'bk_7fq2', member_id: 'm1', venue_name: 'Dishoom Shoreditch', party_size: 4, on_date: '2026-09-25', at_time: '20:00', note: 'a booth if possible', place_id: 'p1' };

test('the confirmed email carries every fact the desk holds and no cost line', () => {
  const d = bookingData(ROW, { place: { address: '7 Boundary St, London E2 7JE' } });
  const m = composeTemplate('booking', d);
  assert.equal(m.subject, 'Confirmed — Dishoom Shoreditch');
  for (const s of ['Fri 25 Sep', '20:00', '7 Boundary St', '4 people', 'BK_7FQ2', 'a booth if possible', 'https://app.itsnum.com/?go=plan']) {
    assert.ok(m.html.includes(s), `html has ${s}`);
    assert.ok(m.text.includes(s.replace('4 people', 'Party of 4')), `text has ${s}`);
  }
  assert.doesNotMatch(m.html, /COST/);
  assert.match(m.html, /transactional message/);
});

test('the declined email says what did not happen and offers the next step', () => {
  const m = composeTemplate('changed', declinedData(ROW));
  assert.equal(m.subject, 'Changed — Dishoom Shoreditch');
  assert.match(m.html, /couldn’t take the table on Fri 25 Sep at 20:00/);
  assert.match(m.html, /find somewhere as good/);
});

function envWith({ member, accept = true }) {
  const sent = [];
  const env = {
    DB: {
      prepare(sql) {
        const s = { bind() { return s; }, async first() { return /FROM num_members/.test(sql) ? member : null; }, async run() { return { meta: { changes: 1 } }; } };
        return s;
      },
    },
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'hello@itsnum.com',
  };
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(accept ? { id: 'em_1' } : { message: 'nope' }), { status: accept ? 200 : 403 });
  };
  return { env, sent };
}
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

test('send: a phone-verified member with an address gets the mail through Resend, once', async () => {
  const { env, sent } = envWith({ member: { id: 'm1', email: 'guest@example.com', email_verified: 0, phone_verified: 1 } });
  const r = await sendBookingMail(env, { row: ROW, verdict: 'confirmed' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.to, 'guest@example.com');
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /resend/);
  assert.match(sent[0].body.subject, /^Confirmed — Dishoom/);
});

test('send: an unverified account sends nothing and says why', async () => {
  const { env, sent } = envWith({ member: { id: 'm1', email: 'guest@example.com', email_verified: 0, phone_verified: 0 } });
  const r = await sendBookingMail(env, { row: ROW, verdict: 'confirmed' });
  assert.deepEqual(r, { ok: false, reason: 'unverified' });
  assert.equal(sent.length, 0);
});

test('send: a refused transport is a failure, never a false success', async () => {
  const { env } = envWith({ member: { id: 'm1', email: 'guest@example.com', phone_verified: 1 }, accept: false });
  const r = await sendBookingMail(env, { row: ROW, verdict: 'confirmed' });
  assert.equal(r.ok, false);
});

test('send: only confirmed and declined have an email; a stray verdict sends nothing', async () => {
  const { env, sent } = envWith({ member: { id: 'm1', email: 'guest@example.com', phone_verified: 1 } });
  const r = await sendBookingMail(env, { row: ROW, verdict: 'requested' });
  assert.equal(r.ok, false);
  assert.equal(sent.length, 0);
});

// A host books through the same desk with member_id `host:<id>` (hostbookdesk).
// No member row, so no email — the host tells their client; NUM does not.
test('send: a host-booked table emails nobody — the host owns the client', async () => {
  const { env, sent } = envWith({ member: null });
  const r = await sendBookingMail(env, { row: { ...ROW, member_id: 'host:h1' }, verdict: 'confirmed' });
  assert.deepEqual(r, { ok: false, reason: 'no_email' });
  assert.equal(sent.length, 0);
});
