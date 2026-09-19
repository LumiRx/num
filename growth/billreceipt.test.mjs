/**
 * billreceipt — what a guest and a venue are told once a bill is paid.
 *
 * 12 Sep 2026. Settling a bill moved the ledger and told nobody. There was no
 * guest receipt, no venue confirmation, no text and no email anywhere in the
 * settle path — and `payLanding` never read `settled_at`, so a guest who
 * reopened their own bill link after paying was shown "Pay THB 2,400" again.
 *
 * Two things are guarded here. The receipt, which has to work for a guest we
 * hold no contact details for at all. And the venue's confirmation, which has
 * to fire once per bill, say whether NUM will invoice on it, and never make
 * staff at a table wait on an email.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

test('a paid bill shows a receipt instead of asking for the money again', () => {
  assert.match(worker, /if \(o\.state === "paid"\) return payShell\(/,
    'payPage has no receipt state, so a settled bill renders as a demand');
  assert.match(worker, /<h1>Paid — thank you<\/h1>/);
  assert.match(worker, /cannot be paid again/);
});

test('payLanding actually looks at settled_at', () => {
  // The whole bug was that it did not. Selecting the column is not enough:
  // it has to branch on it before rendering the pay screen.
  assert.match(worker, /l\.crypto_quote, l\.settled_at,/,
    'settled_at is not in the query, so the page cannot know');
  const branch = worker.match(/if \(link\.settled_at\) \{[\s\S]*?\n  \}/);
  assert.ok(branch, 'nothing branches on settled_at');
  assert.match(branch[0], /state: "paid"/);
});

test('reopening a paid bill is never counted as a billable scan', () => {
  const branch = worker.match(/if \(link\.settled_at\) \{[\s\S]*?\n  \}/)[0];
  assert.match(branch, /kind: "receipt_view"/, 'a receipt view needs its own kind');
  assert.ok(!/active: true/.test(branch),
    'a guest rereading their receipt would inflate the venue\'s scan count and ours');
});

test('the receipt gives the guest a reference they can quote', () => {
  assert.match(worker, /Your reference/);
  assert.match(worker, /Quote this if you need to ask/);
});

test('the venue is emailed once per bill, not once per tap of Settle', () => {
  assert.match(worker, /__idem: "billsettled-" \+ bill\.token/,
    'without an idempotency key a double tap sends two receipts for one dinner');
  assert.match(worker, /out\.ok && out\.settled/,
    'the mail must not fire on `already`, which is exactly what a second tap returns');
});

test('settling does not make staff wait on an email', () => {
  // Staff are standing at a table with a guest in front of them.
  assert.match(worker, /ctx\.waitUntil\(\s*\n\s*mailBillSettled\(env, who, b\.token, out\)/);
  assert.match(worker, /\.catch\(\(e\) => console\.error\("billsettled mail threw"/,
    'a failed send must never turn a successful settle into an error');
});

test('a send that does not happen leaves a reason behind', () => {
  // Found the hard way: the first real end-to-end settle in production sent
  // nothing and the outcome was discarded, so there was no way to tell a
  // refused send from one that never ran.
  assert.match(worker, /console\.error\("billsettled mail not sent"/,
    'a failed send must say so — a swallowed error reads as a working feature');
  assert.match(worker, /console\.log\("billsettled mail sent"/,
    'a success needs the provider id, or nobody can find the message later');
  assert.ok(!/mailBillSettled\(env, who, b\.token, out\)\.catch\(\(\) => \{\}\)/.test(worker),
    'the silent catch is back');
});

test('mailBillSettled names which precondition stopped it', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /bill not found: /);
  assert.match(fn, /no address on file for /);
});

test('the venue is told plainly whether NUM will invoice on this bill', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /out\.billed/, 'the email cannot be honest about the fee without checking');
  assert.match(fn, /NUM charges nothing on this bill/);
  assert.match(fn, /nothing is taken out of what the guest paid you/,
    'a venue must not read this as money being taken out of the guest\'s payment');
});

test('the rate is read off the ledger row, never typed into the email', () => {
  // It used to say "NUM's 10% applies" to every venue, and two venues bill 15%.
  // A merchant quoted one rate and invoiced another stops believing the rest of
  // the invoice, which is the whole reason feeSentence() exists one layer up.
  //
  // Matched against the CODE with comments stripped, following the same rule as
  // scripts/invite_fee.test.mjs: the comment above this function quotes the old
  // wrong sentence on purpose, and a guard that forces that record to be deleted
  // deletes the reason the mistake is not repeated.
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  const code = fn
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.doesNotMatch(code, /\b10%\b/, 'a hardcoded rate is back in the settle email');
  assert.doesNotMatch(code, /\b15%\b/, 'a hardcoded rate is back in the settle email');
  assert.match(code, /c\.rate_bp/, 'the rate must come from the commission row');
  assert.match(code, /rateText/);
});

test('a walk-in is NOT told that NUM brought the table', () => {
  // The bug this closes. The branch was `out.billed ? referred : nothing`, and
  // when walk-ins started earning a flat fee on 12 Sep 2026 `billed` went true
  // for them too — so a venue whose own regular had paid by QR would have been
  // emailed "NUM brought this table, so NUM's 10% applies to this bill." Wrong
  // about the guest and wrong about the money, in writing, to a merchant.
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /c\.category === "payment"/,
    'the sentence must branch on WHAT was recorded, not merely that something was');
  assert.match(fn, /This guest was not sent by NUM/);
  assert.match(fn, /never a percentage|flat/i);
  // And the referred sentence must sit behind a check that a percentage was
  // actually taken, so it can never be reached by a flat line.
  assert.match(fn, /c\.kind === "percent"/);
});

test('no address on file means no send, not a crash', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(!bill\.venue_email\) \{/,
    'four of six live businesses have no email on file');
  assert.match(fn, /no address on file for " \+ bill\.venue_name/,
    'it has to say WHICH venue, or the log is useless at scale');
});

test('the email carries the figure the statement is calculated from', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /it is the figure your/,
    'the venue needs to know this is its one chance to correct the number');
});

/* ── the attempt log ──────────────────────────────────────────────────────
 * Added after the first real settle in production sent nothing and left no
 * trace anywhere. `num_mail_events` is Resend's webhook, so it can only ever
 * record a message that REACHED Resend — a refused send, a fall-through to the
 * Cloudflare transport, or a send that never ran is invisible in it. These
 * guard the record of the attempt itself.
 */

test('every exit from the settle mail leaves a row behind', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  const calls = fn.match(/logMailAttempt\(env, \{/g) || [];
  assert.equal(calls.length, 3,
    'three ways out — no bill, no address, and the send itself — all must be recorded');
});

test('the attempt log records the reason a send failed, not just that it did', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /"via=" \+ \(sent\?\.via \|\| "\?"\)/,
    'the record must name the rail — a Cloudflare fallback and a Resend send are not the same event');
  assert.match(fn, /fell_back_from=/,
    'a silent fallback on a rejected key must not look like a healthy send');
  assert.match(fn, /"ids=" \+ \(sent\.ids \|\| \[\]\)\.join\(","\)/,
    'a success needs the provider ids');
  assert.match(fn, /"error=" \+ \(sent\?\.error \|\| "no error given"\)/,
    'a failure needs the error text');
  assert.match(fn, /ok: !!sent\?\.ok/);
});

test('the send result is awaited, or there is nothing to record', () => {
  const fn = worker.match(/async function mailBillSettled\([\s\S]*?\n\}/)[0];
  assert.match(fn, /const sent = await sendBatch\(env, \[\{/,
    'returning sendBatch directly throws the outcome away — that was the original bug');
});

test('the attempt log creates its own table and can never break a settle', () => {
  const fn = worker.match(/async function logMailAttempt\([\s\S]*?\n\}\n/)[0];
  assert.match(fn, /CREATE TABLE IF NOT EXISTS num_mail_attempts/,
    'created on first use, like num_commissions');
  assert.match(fn, /catch \(e\) \{\s*\n\s*console\.error\("logMailAttempt failed"/,
    'a logging failure must not turn a sent email into a failed settle');
});

test('the attempt log is queryable by bill, which is how it gets read', () => {
  const fn = worker.match(/async function logMailAttempt\([\s\S]*?\n\}\n/)[0];
  assert.match(fn, /INSERT INTO num_mail_attempts \(kind, ref, recipient, ok, detail, created_at\)/);
  // `ref` is the bill token. Without it the log says a send failed but not for what.
  assert.match(fn, /ref \? String\(ref\)\.slice\(0, 64\) : null/);
});

/* ── THE GUEST'S OWN COPY, AND WHERE THEY ARE ASKED FOR AN ADDRESS ────────
 *
 * Everything above is the VENUE's settled-bill email, which has existed since
 * 12 Sep. The guest got nothing, and not for want of a template: on 19 Sep
 * 2026 the live database held one member email address across 156 members,
 * none verified, and no push token anywhere. There was nowhere to send it.
 *
 * So the address is asked for on the confirmation itself — the one screen
 * where a person has a reason to type one. These guard that the box is
 * reachable, that it works without JavaScript, and that it never claims to be
 * more than an addition to a page that is already the receipt.
 *
 * The sending logic is tested against a real database in
 * worker/billreceipt.test.mjs. What is left here is wiring, which is what
 * actually breaks: payLanding never selected `resource_id` and the whole
 * till-bill path was dead with every unit test green.
 */

test('the receipt endpoint is routed, and the paid page can reach it', () => {
  assert.match(worker, /\(go\|promptpay\|crypto\|bill\|receipt\)/,
    'the /p/ matcher does not know the word, so the form posts into a 404');
  assert.match(worker, /if \(m\[2\] === "receipt"\) return payReceipt\(req, env, m\[1\]\);/,
    'a handler written and never routed looks exactly like one that works');
});

test('the box is rendered on the paid page, not merely written', () => {
  const branch = worker.match(/if \(o\.state === "paid"\) return payShell\(`[\s\S]*?"Paid — " \+ o\.venue/)[0];
  assert.match(branch, /\$\{receiptBox\(o\)\}/,
    'built and never placed on the page — the payLanding failure exactly');
});

test('the page is handed what it needs to draw the box honestly', () => {
  const branch = worker.match(/if \(link\.settled_at\) \{[\s\S]*?\n  \}/)[0];
  assert.match(branch, /canSend: RECEIPT\.channelsAvailable\(env\)/,
    'without this the page offers a box that cannot work');
  assert.match(branch, /say: RECEIPT\.sayFor\(new URL\(req\.url\)\.searchParams\.get\("said"\)\)/,
    'the outcome must survive the redirect, and as a CODE mapped to fixed copy \u2014 '
    + 'a sentence carried in a query string is a phishing message in NUM\u2019s own voice on NUM\u2019s own page');
});

test('the box needs no JavaScript', () => {
  const fn = worker.match(/function receiptBox\(o\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /<form method="post" action="\/p\/\$\{esc\(o\.token\)\}\/receipt"/);
  assert.doesNotMatch(fn, /fetch\(/,
    'this page is opened by a camera on a stranger’s phone on a venue’s wifi');
  assert.doesNotMatch(fn, /onclick=/);
});

test('one field, because a guest should not classify their own address', () => {
  const fn = worker.match(/function receiptBox\(o\) \{[\s\S]*?\n\}/)[0];
  const inputs = fn.match(/<input /g) || [];
  assert.equal(inputs.length, 1);
  assert.doesNotMatch(fn, /type="radio"/);
});

test('no configured channel means no box, not a dead one', () => {
  const fn = worker.match(/function receiptBox\(o\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(!can\.email && !can\.sms\) return said;/,
    'a guest typing into a field that goes nowhere is worse than no offer at all');
});

test('the box says it is optional and that the receipt stays either way', () => {
  const fn = worker.match(/function receiptBox\(o\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /Optional/);
  assert.match(fn, /stays on this page whether or not you/);
  assert.match(fn, /does not use it to sign you up/,
    'an address asked for one purpose and used for another is why people stop giving them');
});

test('sending a receipt can never break the page it was offered on', () => {
  const fn = worker.match(/async function payReceipt\(req, env, tok\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /\.catch\(\(e\) => \{/, 'a throw here would 500 a guest who has already paid');
  assert.match(fn, /return back\(out\.code\)/, 'the page takes a code, never a sentence');
  // Every exit is a redirect back to the receipt.
  assert.equal((fn.match(/return back\(/g) || []).length, 3);
});

test('a GET on the receipt endpoint just returns the page', () => {
  const fn = worker.match(/async function payReceipt\(req, env, tok\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(req\.method !== "POST"\) return back\(null\);/,
    'a crawler following this URL must not be able to trigger a send');
});

/* ── it actually renders ─────────────────────────────────────────────────
 * Source assertions catch a missing call. They do not catch a template that
 * throws, produces broken markup, or leaks a value unescaped — and the box
 * sits on a page a guest reaches with a camera, where a blank screen is
 * indistinguishable from a venue that lost their money. So the real function
 * is extracted and run.
 */
function renderBox(o) {
  const src = `
    ${worker.match(/function receiptBox\(o\) \{[\s\S]*?\n\}/)[0]}
    return receiptBox;
  `;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // eslint-disable-next-line no-new-func
  return new Function('esc', src)(esc)(o);
}

test('the rendered box posts to this bill and asks for one thing', () => {
  const html = renderBox({ token: 'PAID1', canSend: { email: true, sms: true } });
  assert.match(html, /action="\/p\/PAID1\/receipt"/);
  assert.match(html, /name="to"/);
  assert.match(html, /email address or mobile number/);
  assert.match(html, /Include the country code/);
});

test('it offers only what is configured', () => {
  const mailOnly = renderBox({ token: 'PAID1', canSend: { email: true, sms: false } });
  assert.match(mailOnly, /placeholder="email address"/);
  assert.doesNotMatch(mailOnly, /country code/,
    'offering a text on a worker with no Twilio is a promise it cannot keep');

  const textOnly = renderBox({ token: 'PAID1', canSend: { email: false, sms: true } });
  assert.match(textOnly, /placeholder="mobile number"/);
});

test('with nothing configured it renders nothing at all', () => {
  assert.equal(renderBox({ token: 'PAID1', canSend: { email: false, sms: false } }), '');
  assert.equal(renderBox({ token: 'PAID1' }), '', 'a page that forgot to pass canSend must not draw a dead box');
});

test('the outcome of the last attempt is shown, even when the box is gone', () => {
  const said = renderBox({ token: 'PAID1', canSend: { email: false, sms: false }, say: 'Sent — it should arrive in a moment.' });
  assert.match(said, /Sent — it should arrive in a moment\./,
    'a guest who pressed the button and is told nothing presses it again');
});

test('nothing a guest can influence reaches the page unescaped', () => {
  // `say` comes back off the query string, which anybody can write.
  const html = renderBox({
    token: 'PAID1',
    canSend: { email: true, sms: true },
    say: '<script>alert(1)</script>',
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('the input is 16px, or an iPhone zooms the receipt out from under them', () => {
  const html = renderBox({ token: 'PAID1', canSend: { email: true, sms: true } });
  assert.match(html, /font-size:16px/);
});
