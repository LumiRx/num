// The 30034 fix, and the three places it has to hold.
//
// Context, because the test names will not carry it on their own: every SMS
// Num sent to a real phone came back 30034, "A2P campaign not registered or
// not approved". For a month that was recorded as "A2P is unregistered". It
// was not — brand and campaign were both approved on 28 Jul 2026, a week
// before the first failure. A US long code inherits campaign approval through
// its MESSAGING SERVICE, and every call site was sending a bare `From:`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { senderParams, usingMessagingService, numSmsNumber } from './twiliosender.mjs';

const src = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
const SVC = 'MG64fac2280000000000000000000000ab';   // MG + 32 hex
const NUM = '+14243460888';

/* ── choosing a sender ──────────────────────────────────────────────────── */

test('the Messaging Service wins when one is configured', () => {
  const p = senderParams({ TWILIO_MESSAGING_SERVICE_SID: SVC, TWILIO_FROM: NUM });
  assert.deepEqual(p, { MessagingServiceSid: SVC });
  // The bare number must NOT also be sent: supplying both is what Twilio
  // rejects outright, and it is the obvious "belt and braces" mistake here.
  assert.ok(!('From' in p));
  assert.equal(usingMessagingService({ TWILIO_MESSAGING_SERVICE_SID: SVC }), true);
});

test('without a service it falls back to the number, exactly as before', () => {
  // Non-US destinations need no campaign, and a missing secret must degrade to
  // the old behaviour rather than stop every message in the product.
  assert.deepEqual(senderParams({ TWILIO_FROM: NUM }), { From: NUM });
  assert.equal(usingMessagingService({ TWILIO_FROM: NUM }), false);
});

test('neither configured means do not attempt a send', () => {
  assert.equal(senderParams({}), null);
  assert.equal(senderParams(undefined), null);
});

test('a SID of the wrong SHAPE falls back instead of failing at Twilio', () => {
  // These are the four things a person could plausibly paste into the secret.
  // Each would be accepted by a naive presence check and then rejected by
  // Twilio with an error nobody would trace back to the wrong paste.
  for (const wrong of [
    'AC00000000000000000000000000000000',            // account SID
    'CM00000000000000000000000000000000',            // campaign SID
    'BN00000000000000000000000000000000',            // brand SID
    'MG64fac228',                                     // truncated paste
  ]) {
    assert.deepEqual(
      senderParams({ TWILIO_MESSAGING_SERVICE_SID: wrong, TWILIO_FROM: NUM }),
      { From: NUM },
      `${wrong.slice(0, 2)}… should not be treated as a Messaging Service`,
    );
  }
});

test('whitespace around a pasted SID does not break it', () => {
  assert.deepEqual(
    senderParams({ TWILIO_MESSAGING_SERVICE_SID: `  ${SVC}\n` }),
    { MessagingServiceSid: SVC },
  );
});

/* ── every sender uses it — this is the part that regressed before ──────── */

for (const [file, fn] of [
  ['./claim.mjs', 'sendSms — the sign-in code'],
  ['./bookdesk.mjs', 'smsPartner — the venue booking text'],
  ['./health.mjs', 'alert — the message that says something broke'],
]) {
  test(`${fn} sends through senderParams, not a bare From`, () => {
    const s = src(file);
    assert.match(s, /import \{ senderParams \} from '\.\/twiliosender\.mjs'/,
      `${file} must import the shared sender`);
    // No call site may put TWILIO_FROM straight into a request body again.
    assert.doesNotMatch(s, /From: env\.TWILIO_FROM/,
      `${file} still builds a bare From — this is the 30034 bug`);
    assert.match(s, /\.\.\.(sms)?[Ss]ender,/, `${file} must spread the chosen sender`);
  });
}

/* ── THE NUMBER A HUMAN CAN TEXT ─────────────────────────────────────────
 *
 * Found 19 Sep 2026: the host console promised three times that a supplier
 * could text photographs in, the supplier invite promised it too, and the
 * number to send them TO appeared nowhere in the product. The invite named the
 * supplier's own number as the one they send FROM, which is correct and is not
 * the missing half. These tests exist so a promise can only be made with a
 * real destination attached to it.
 */

test('the explicit inbound number wins over the sending number', () => {
  assert.equal(numSmsNumber({ NUM_SMS_NUMBER: '+447700900123', TWILIO_FROM: NUM }), '+447700900123');
});

test('the sending number is used when no inbound number is set', () => {
  assert.equal(numSmsNumber({ TWILIO_FROM: NUM }), NUM);
});

test('a Messaging Service SID is NEVER offered as a number to text', () => {
  // "MG64fac2…" printed as an address would be worse than printing nothing.
  assert.equal(numSmsNumber({ TWILIO_MESSAGING_SERVICE_SID: SVC }), null);
});

test('nothing configured means null, so callers drop the promise', () => {
  assert.equal(numSmsNumber({}), null);
  assert.equal(numSmsNumber(null), null);
  assert.equal(numSmsNumber(undefined), null);
});

test('a number pasted with spaces, brackets or dashes still works', () => {
  for (const messy of ['+1 (424) 346-0888', '+1-424-346-0888', ' +1 424 346 0888 ', '+1.424.346.0888']) {
    assert.equal(numSmsNumber({ NUM_SMS_NUMBER: messy }), NUM, `failed on ${messy}`);
  }
  // An en dash and a non-breaking hyphen, which is what a pasted number from a
  // document actually contains.
  assert.equal(numSmsNumber({ NUM_SMS_NUMBER: '+1–424‑346‑0888' }), NUM);
});

test('anything that is not E.164 is refused rather than printed', () => {
  for (const bad of ['NUMHELP', '4243460888', '+0424346088', '12345', '+1424', 'AC64fac228',
    '+1424346088812345678', 'call us', '']) {
    assert.equal(numSmsNumber({ NUM_SMS_NUMBER: bad }), null, `accepted ${bad}`);
  }
});

test('the console and the invite both say the number, or say it is off', () => {
  // The two surfaces that made the promise. They must consult the helper
  // rather than hard-coding a number, and they must have a not-configured
  // branch — a page that prints an empty bold tag is the original bug back.
  const inv = src('../growth/hostsuppliers.mjs');
  assert.match(inv, /numSmsNumber/, 'the supplier invite must ask for the real number');
  assert.match(inv, /to NUM on \$\{smsNumber\}/, 'the invite must name the destination');
  assert.match(inv, /not switched on just yet/, 'the invite needs a no-number branch');
  // And the no-number branch still has to confirm the mobile we hold, or a
  // supplier is left wondering whether we have it at all.
  assert.match(inv, /gave us \$\{phone\} as your mobile/);

  const console_ = src('../public/host/index.html');
  assert.match(console_, /sms_number/, 'the console must read the number from the summary');
  assert.match(console_, /not switched on yet/, 'the console needs a no-number branch');
  assert.equal(/to your NUM number/.test(console_), false,
    '"your NUM number" tells a host nothing — it must print the number');
});

/* ── the health check that would have caught this in August ────────────── */

test('health warns when a number is set but no Messaging Service is', () => {
  const s = src('./health.mjs');
  assert.match(s, /TWILIO_MESSAGING_SERVICE_SID/);
  assert.match(s, /30034/, 'the remedy must name the error code someone will be googling');
  // A warning, never a failure: outside the US the bare number is correct, and
  // this must not take a Thailand-only deployment red.
  const check = s.slice(s.indexOf('function checkSms('), s.indexOf('\n}', s.indexOf('function checkSms(')));
  assert.match(check, /ok: true, warn:/, 'the missing-service case must warn, not fail');
  assert.match(check, /ok: false, remedy:/, 'a malformed SID must fail loudly');
});

/* ── THE STORY ITSELF IS A THING THAT CAN ROT ───────────────────────────
 *
 * "Our A2P campaign is unapproved" was written into three files while the
 * campaign sat approved in the Twilio console. On 19 Sep 2026 it was read
 * out of one of them and repeated to Dre as the reason NUM could not text
 * anybody — a month and a half after the real cause (a bare `From:`) had
 * been found and fixed.
 *
 * A wrong comment is not inert. This is the guard that the corrected record
 * stays corrected.
 */
test('no file still claims the A2P registration is outstanding', () => {
  // twiliosender.mjs is deliberately absent: it is the file that RECORDS the
  // correction, and it has to be able to quote the belief it is correcting.
  // Everywhere else, the sentence would be an assertion.
  const FILES = ['./smsconsent.mjs', './giveaway.mjs', './orderalert.mjs', './health.mjs', './claim.mjs', './bookdesk.mjs', './features.mjs', './smsconcierge.mjs'];
  // The claim, in the shapes somebody would actually write it. "not approved"
  // is excluded on purpose: it is the wording of Twilio's own 30034 message,
  // which these files quote to explain what the error SAYS versus what it
  // meant.
  //
  // Raw text, comments included, and deliberately so. Four guards in this
  // repo have now had to learn to ignore their own documentation, and the
  // reflex to add a fifth comment-stripper is wrong here: a false claim in a
  // comment is exactly what caused this, and one written into a string a
  // user reads would be worse. The fix is to describe the wrong sentence
  // rather than write it out.
  const WRONG = [
    /campaign is unapproved/i,
    /A2P (10DLC )?(is|remains) unregistered/i,
    /registration is (still )?(pending|outstanding)/i,
    /we are not registered for A2P/i,
  ];
  for (const f of FILES) {
    const s = src(f);
    for (const re of WRONG) {
      assert.equal(re.test(s), false, `${f} still says ${re} — brand and campaign were approved 28 Jul 2026`);
    }
  }
});

test('the two workers that actually send are named, so the secret reaches both', async () => {
  // Setting TWILIO_MESSAGING_SERVICE_SID on one worker and not the other is
  // the same silent half-fix as the shared-source deploy problem: the texts
  // that go through the other one keep failing and nothing says why.
  const { WORKERS, bundleFiles } = await import('../scripts/deploydrift.mjs');
  const senders = Object.entries(WORKERS)
    .filter(([, w]) => [...bundleFiles(w.main)].some((f) => /twiliosender\.mjs$/.test(f)))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(senders, ['num-app', 'num-growth'],
    'the set of SMS-sending workers changed — the secret has to be set on every one of them');
});
