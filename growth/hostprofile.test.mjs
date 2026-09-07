// The VIP host system was live in production and held ZERO rows on 1 Sep 2026.
// Not because it failed — because it had no front door. /hosts/ offered a
// mailto: link and /host/?k=, the console URL that every welcome email sends,
// was a 404. These tests pin the two doors shut behind us.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const worker = read('growth/worker.js');
const hostsPage = read('public/hosts/index.html');
const consolePage = read('public/host/index.html');

test('the console URL the welcome email sends actually has a page', () => {
  // growth/worker.js mails `${site}/host/?k=${consoleKey}` on every signup.
  assert.match(worker, /\/host\/\?k=/, 'the welcome email no longer sends a console link');
  assert.ok(consolePage.length > 2000, 'public/host/index.html is missing or a stub — the welcome email links to a 404');
  assert.match(consolePage, /api\/host\/summary/, 'the console never calls the summary endpoint');
  assert.match(consolePage, /api\/host\/profile/, 'the console cannot read or write the profile');
});

test('the hosts page can actually create an account', () => {
  assert.match(hostsPage, /\/api\/host\/join/, 'the hosts page does not post to the join endpoint');
  assert.ok(
    !/mailto:info@itsnum\.com\?subject=Founding/.test(hostsPage),
    'the signup is a mailto: again — POST /api/host/join is live and this is the only reason nobody uses it',
  );
});

test('the profile endpoint is routed', () => {
  assert.match(worker, /p === "\/api\/host\/profile"/, '/api/host/profile is not routed');
});

test('collecting a host’s money is never a default', () => {
  // Taking payment on a host's behalf makes NUM a payment intermediary for
  // their business, with their refunds, chargebacks and tax position attached.
  // It must be asked for, never inherited from a blank field.
  assert.match(
    worker,
    /const chargeMode = b\.charge_mode === "num" \? "num" : "own"/,
    'charge_mode no longer fails closed to "own" — an unset field could now opt a host into NUM collecting',
  );
  const mig = read('worker/migrations/0013_host_profile.sql');
  assert.match(mig, /charge_mode TEXT NOT NULL DEFAULT 'own'/, 'the column default is no longer "own"');
  assert.match(mig, /CHECK \(charge_mode IN \('own','num'\)\)/, 'charge_mode lost its CHECK constraint');
});

test('SMS cannot be switched on without a number to send to', () => {
  // A tier gate was added on 3 Sep 2026 (text alerts are on the small plan and
  // up). The original promise is unchanged and is what this still pins: the
  // opt-in cannot be 1 without a phone number that validated, whatever plan
  // the host is on — otherwise the dashboard shows "texts on" against nothing
  // and the first missed request gets blamed on the agent instead of on this.
  assert.match(
    worker,
    /smsOptIn = \(b\.sms_opt_in === true \|\| b\.sms_opt_in === 1\)\s*\n?\s*&& notifyPhone/,
    'sms_opt_in can be set without a valid phone',
  );
  // The number itself is still SAVED on any plan — a host who downgrades must
  // not have to retype it to come back.
  assert.match(
    worker,
    /const notifyPhone = okPhone\(b\.notify_phone\) \? e164\(b\.notify_phone\) : null;/,
    'the notify number is no longer stored independently of the plan',
  );
});

test('a price agreed per request stores no price', () => {
  // A greyed-out number that is still stored is how a host ends up quoting a
  // figure they thought they had removed.
  assert.match(worker, /if \(unit === "quote"\) minor = 0;/, 'a "quote" line can still carry a stale amount');
});

test('the contact upload still demands an attestation, and the page says why', () => {
  assert.match(worker, /consentText\.length < 40/, 'the consent attestation requirement is gone');
  assert.match(consolePage, /GDPR|PECR/, 'the console asks for a contact list without explaining the basis it needs');
  assert.match(consolePage, /at least 40 characters/i, 'the console does not tell the host what the server will demand');
});

test('the console key is not left in the address bar', () => {
  // The key is the whole credential. Left in the URL it lands in history, in
  // screenshots, and in the Referer header of every outbound click.
  assert.match(consolePage, /sessionStorage\.setItem\('num_host_k'/, 'the key is never moved out of the URL');
  assert.match(consolePage, /history\.replaceState\(null, '', '\/host\/'\)/, 'the key stays in the address bar');
  assert.match(consolePage, /noindex/, 'a page whose URL carries a credential must not be indexed');
});
