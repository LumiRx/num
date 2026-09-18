// The booking request a venue receives by email. Two properties matter more
// than everything else in the file: the accept and decline links must be the
// SAME signed links the SMS carries (one lock, one door), and the message must
// never be mistaken for marketing — this is the mail that has to arrive on the
// day the outreach list costs us the inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mailVenueBooking, __testables } from './venuebookmail.mjs';
import { signBookingAnswer } from './bookdesk.mjs';

const SRC = readFileSync(new URL('./venuebookmail.mjs', import.meta.url), 'utf8');
const env = { ADMIN_KEY: 'test-key', NUM_APP_ORIGIN: 'https://app.itsnum.com' };

const row = {
  id: 'bk_abc123', party_size: 4, on_date: '2026-09-25', at_time: '19:30',
  note: 'birthday, quiet table if possible', venue_name: "Hugo's Restaurant",
};

test('the links are the same signed links the text message carries', async () => {
  // Asserted as a contract rather than by intercepting the send. The property
  // that matters is that this file does not own a second answer to "may this
  // person confirm this booking" — a second HMAC implementation is a second
  // set of rules about who owns a table, and the two drift on the day it
  // counts.
  const yes = await signBookingAnswer(env, row.id, 'confirmed');
  const no = await signBookingAnswer(env, row.id, 'declined');
  assert.notEqual(yes, no, 'a confirm token must not be able to decline');
  assert.match(SRC, /import \{ signBookingAnswer \} from '\.\/bookdesk\.mjs'/);
  assert.ok(
    !/crypto\.subtle\.(importKey|sign)/.test(SRC),
    'this file signs nothing of its own — it borrows bookdesk.mjs\'s lock',
  );
  // And it lands on the handler that already knows only 'requested' may move.
  assert.match(SRC, /\/api\/book\/answer\?id=/);
});

test('the message carries a plain-text half, and both answers are in it', () => {
  const yes = 'https://app.itsnum.com/api/book/answer?id=bk_abc123&v=confirmed&t=aa';
  const no = 'https://app.itsnum.com/api/book/answer?id=bk_abc123&v=declined&t=bb';
  const text = __testables.textBody({
    venueName: "Hugo's Restaurant", guestName: 'Ana', party: 4,
    when: '2026-09-25 at 19:30', note: 'birthday', yes, no,
  });
  assert.match(text, /CONFIRM: https:\/\/app\.itsnum\.com/);
  assert.match(text, /DECLINE: https:\/\/app\.itsnum\.com/);
  assert.match(text, /Party of 4/);
  // An HTML-only operational message is a table nobody answers for, and a
  // spam signal on top of it.
  assert.ok(text.length > 120);
});

test('it is not marketing, and carries nothing that looks like it', () => {
  const html = __testables.htmlBody({
    venueName: 'X', guestName: 'Y', party: 2, when: 'tonight', note: null,
    yes: 'https://a.example/y', no: 'https://a.example/n',
  });
  assert.ok(!/1x1|pixel|i\.gif|width="1" height="1"/i.test(html), 'a tracking pixel has no place on a booking request');
  assert.ok(!/unsubscribe/i.test(html), 'this is an operational message, not a mailing list');
  // But a way to change or stop it must be in the message itself, because the
  // venue chose this channel and has to be able to unchoose it.
  assert.match(html, /reply to this message to change that, or to stop them/i);
});

test('a request with nothing to send it to is refused rather than reported sent', async () => {
  assert.deepEqual(await mailVenueBooking(env, { row, to: null }), { ok: false, reason: 'no_address' });
  assert.deepEqual(await mailVenueBooking(env, { row: {}, to: 'x@y.example' }), { ok: false, reason: 'no_booking' });
});

test('"tonight" is what we say when we do not know the date', () => {
  assert.equal(__testables.whenLine({}), 'tonight');
  assert.equal(__testables.whenLine({ on_date: '2026-09-25' }), '2026-09-25');
  assert.equal(__testables.whenLine({ on_date: '2026-09-25', at_time: '19:30' }), '2026-09-25 at 19:30');
});
