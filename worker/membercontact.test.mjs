/**
 * A WAY TO REACH YOU, REQUIRED — AND THE ALTERNATIVE THAT MAKES THAT FAIR.
 *
 * Dre, 12 Sep 2026: "the number when a person is signing up is suppsoe to be
 * mandatory. if they dont have a phone number they can use and email."
 *
 * The state of the account table that day:
 *
 *     147 members · 107 with no phone at all · 6 verified
 *
 * These tests hold three things that pull against each other:
 *   1. a NEW account cannot be opened with no way to reach the person,
 *   2. an EXISTING one is never locked out by a rule made after they joined,
 *   3. the email door is a real door — verifiable, recoverable, and refusing
 *      the addresses people actually mistype.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  normaliseEmail, hasContact, hasVerifiedContact, contactNudge,
  issueEmailCode, ensureContact, __resetReady,
} from './membercontact.mjs';

describe('the address rule', () => {
  test('ordinary addresses pass, normalised', () => {
    assert.equal(normaliseEmail('  Dre@ThatIsLumi.com '), 'dre@thatislumi.com');
    assert.equal(normaliseEmail('a.b+tag@sub.example.co.uk'), 'a.b+tag@sub.example.co.uk');
  });

  test('the typos people actually make are refused', () => {
    for (const bad of [
      'gmail.com',          // no @ at all
      'dre@',               // nothing to send to
      '@gmail.com',         // nobody to send it to
      'dre@@gmail.com',     // two @
      'dre @gmail.com',     // a space
      'dre@gmail',          // no dot in the domain
      'dre@gmail.c',        // one-letter TLD — always a slip
      'dre@gmail.123',      // numeric TLD
      'dre@.com',           // empty label
      '.dre@gmail.com',     // leading dot
      'dre.@gmail.com',     // trailing dot
      'dre..x@gmail.com',   // double dot
      '',
      null,
      undefined,
    ]) {
      assert.equal(normaliseEmail(bad), null, `should have refused ${JSON.stringify(bad)}`);
    }
  });

  test('an absurdly long address is refused rather than truncated', () => {
    // Truncating would produce a DIFFERENT address that happens to parse —
    // silently sending somebody's code to a stranger.
    assert.equal(normaliseEmail(`${'x'.repeat(200)}@example.com`), null);
  });

  test('the client and the server share one implementation', () => {
    const client = readFileSync(new URL('../src/lib/contact.ts', import.meta.url), 'utf8');
    assert.match(client, /from '\.\.\/\.\.\/worker\/emailaddr\.mjs'/,
      'a second copy on the client is a form that accepts what the server refuses');
  });
});

describe('what counts as reachable', () => {
  test('a phone, an address or an Apple identity — any one of them', () => {
    assert.equal(hasContact({ phone: '+13105550000' }), true);
    assert.equal(hasContact({ email: 'dre@example.com' }), true);
    assert.equal(hasContact({ apple_sub: '001234.abc' }), true);
    assert.equal(hasContact({ name: 'Dre' }), false);
    assert.equal(hasContact(null), false);
  });

  test('unverified still counts as reachable, and that is deliberate', () => {
    // 34 members have a number that never verified. Treating them as having
    // no contact would strand exactly the people whose code did not arrive.
    assert.equal(hasContact({ phone: '+13105550000', phone_verified: 0 }), true);
    assert.equal(hasVerifiedContact({ phone: '+13105550000', phone_verified: 0 }), false);
    assert.equal(hasVerifiedContact({ email: 'a@b.com', email_verified: 1 }), true);
  });
});

describe('the nudge for the 107', () => {
  test('it asks, and it says why', () => {
    const n = contactNudge({ name: 'Dre' });
    assert.ok(n?.needed);
    assert.match(n.ask, /booking moves|change phones/);
    assert.equal(n.chip.id, 'addcontact');
  });

  test('nobody who already gave us something is asked again', () => {
    assert.equal(contactNudge({ phone: '+13105550000' }), null);
    assert.equal(contactNudge({ email: 'dre@example.com' }), null);
  });

  test('it is an ask, never a block — nothing here refuses anything', () => {
    const src = readFileSync(new URL('./membercontact.mjs', import.meta.url), 'utf8');
    const i = src.indexOf('export function contactNudge');
    assert.ok(!/throw|401|403/.test(src.slice(i)),
      'the nudge must not be able to stop anybody using Num');
  });
});

describe('the emailed code', () => {
  let db; let env; let sent;
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  beforeEach(() => {
    __resetReady();
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE num_members (
      id TEXT PRIMARY KEY, name TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0,
      code_hash TEXT, code_salt TEXT, code_expires TEXT, attempts INTEGER DEFAULT 0, code_sid TEXT)`);
    db.prepare("INSERT INTO num_members (id, name) VALUES ('mem_1','Dre')").run();
    sent = [];
    // A sign-in code goes to somebody else's inbox, so it takes the mailer's
    // EXTERNAL chain — Resend only, because the Cloudflare binding accepts a
    // message and reports nothing. Stubbing `fetch` is stubbing Resend.
    globalThis.fetch = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')));
      return { ok: true, status: 200, json: async () => ({ id: 're_test' }) };
    };
    env = {
      RESEND_KEY: 'test-key',
      MAIL_FROM: 'NUM <hello@itsnum.com>',
      DB: {
        prepare(sql) {
          let bound = [];
          const api = {
            bind(...a) { bound = a; return api; },
            async run() { db.prepare(sql).run(...bound); return { success: true }; },
            async first() { const r = db.prepare(sql).get(...bound); return r ? { ...r } : null; },
            async all() { return { results: db.prepare(sql).all(...bound).map((r) => ({ ...r })) }; },
          };
          return api;
        },
      },
      // The shape worker/email.mjs expects of the binding.
      EMAIL: { send: (msg) => { sent.push(msg); return Promise.resolve(); } },
    };
  });

  test('the code goes out and the hash is stored', async () => {
    const out = await issueEmailCode(env, 'mem_1', 'Dre@Example.com');
    assert.equal(out.sent, true);
    assert.equal(out.channel, 'email');
    assert.equal(out.to, 'dre@example.com', 'the address is normalised before sending');
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /is your Num code/);
    assert.deepEqual(sent[0].to, ['dre@example.com']);
    assert.ok(!sent[0].bcc?.length, 'a sign-in code must not be blind-copied to ops');

    const row = db.prepare('SELECT * FROM num_members WHERE id=?').get('mem_1');
    assert.ok(row.code_hash, 'no hash stored — the code could never be checked');
    assert.equal(row.code_channel, 'email');
  });

  test('the six digits are actually in the message, both parts of it', async () => {
    await issueEmailCode(env, 'mem_1', 'dre@example.com');
    const msg = sent[0];
    const code = /\b(\d{6})\b/.exec(msg.text)?.[1];
    assert.ok(code, 'no six-digit code in the plain-text part');
    assert.ok(msg.html.includes(code), 'the HTML and text parts carry different codes');
    assert.ok(msg.subject.includes(code), 'the code should be readable from the notification');
    // A sign-in code dressed as marketing gets filed as marketing — and this
    // is the one message that has to land inside a minute.
    assert.ok(!/unsubscribe/i.test(msg.html), 'a sign-in code is not a mailing');
    assert.match(msg.text, /never ask you to send this code/i,
      'the anti-phishing line is the one sentence that protects the account');
  });

  test('a send that FAILED stores no hash', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => 'mailbox full' });
    const out = await issueEmailCode(env, 'mem_1', 'dre@example.com');
    assert.equal(out.sent, false);
    const row = db.prepare('SELECT * FROM num_members WHERE id=?').get('mem_1');
    assert.equal(row.code_hash, null,
      'a hash for a message that never left is a member who can never verify');
  });

  test('no transport configured is reported as a send problem, not a bad address', async () => {
    delete env.RESEND_KEY;
    const out = await issueEmailCode(env, 'mem_1', 'dre@example.com');
    assert.equal(out.sent, false);
    assert.match(out.note, /did not go out/);
    assert.ok(!/@/.test(String(out.reason ?? '')), 'the reason must not read as an address problem');
  });

  test('it never takes the Cloudflare binding — that one accepts and says nothing', async () => {
    // worker/mailer.mjs: the Cloudflare transport "would accept the message
    // and tell us nothing, which is how six businesses became
    // unreachable-forever rather than merely un-emailed." A sign-in code with
    // a false success is a person waiting for a text that will never come.
    const src = readFileSync(new URL('./membercontact.mjs', import.meta.url), 'utf8');
    assert.match(src, /AUDIENCE\.EXTERNAL/);
    assert.ok(!/sendEmail\(env/.test(src),
      'email.mjs sendEmail posts straight at the Cloudflare binding');
  });

  test('the send is logged, or the resend cooldown can never fire', async () => {
    // sendGate reads num_signin_events. With no row an email account has NO
    // rate limit at all — an open endpoint for spending our sending
    // reputation on somebody else's afternoon.
    const src = readFileSync(new URL('./membercontact.mjs', import.meta.url), 'utf8');
    assert.match(src, /logSignin\(env, \{ memberId: id, stage: 'send', outcome: 'ok', via: 'email' \}\)/);
    assert.match(src, /outcome: 'failed'[\s\S]{0,40}via: 'email'/);
  });

  test('a malformed address never reaches the mailer', async () => {
    const out = await issueEmailCode(env, 'mem_1', 'gmail.c');
    assert.equal(out.sent, false);
    assert.equal(out.reason, 'bad_email');
    assert.equal(sent.length, 0);
  });

  test('the columns are added rather than assumed', async () => {
    __resetReady();
    await ensureContact(env);
    const cols = db.prepare('PRAGMA table_info(num_members)').all().map((c) => c.name);
    for (const c of ['email', 'email_verified', 'code_channel']) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
  });
});

describe('the rule is enforced on the server, not only in the sheet', () => {
  const social = readFileSync(new URL('./social.mjs', import.meta.url), 'utf8');

  test('a new account with neither is refused', () => {
    assert.match(social, /if \(!existing && !phone && !email\) \{/);
    assert.match(social, /need_contact: true/);
  });

  test('an existing account is untouched by it', () => {
    const i = social.indexOf('if (!existing && !phone && !email)');
    assert.ok(i > 0);
    assert.match(social.slice(i - 700, i), /EXISTING accounts pass untouched/);
  });

  test('an emailed code cannot mark a phone verified', () => {
    // The pending code lives in code_hash whichever door it went out of, so
    // without the channel an email verification would have claimed we texted
    // a number nobody ever texted — and locked the member's name on it.
    assert.match(social, /const pendingEmail = row\.code_channel === 'email'/);
    assert.match(social, /pendingEmail\s*\n?\s*\?\s*`UPDATE num_members SET email_verified=1/);
  });

  test('Twilio Verify is not asked about a code it never issued', () => {
    assert.match(social, /const viaVerify = verifyConfigured\(env\) && !pendingEmail;/);
  });

  test('an SMS consent row is never written for an email verification', () => {
    assert.match(social, /if \(!pendingEmail && row\.phone\) \{/);
  });

  test('recovery works by address as well as by number', () => {
    assert.match(social, /const byEmail = noId && !byPhone && !!normaliseEmail\(b\.email\)/);
    assert.match(social, /if \(!byPhone && !byEmail\) \{/,
      'an email recovery must reach the branch that releases the member id');
  });

  test('the recovery code goes to the channel ON FILE, never the one typed', () => {
    assert.match(social, /issueEmailCode\(env, holder\.id, holder\.email\)/,
      'sending to the caller-supplied address would be a takeover, not a recovery');
  });
});

describe('the sign-up sheet offers the door and the button says which is missing', () => {
  const sheet = readFileSync(new URL('../src/components/app/InviteSheet.tsx', import.meta.url), 'utf8');
  const social = readFileSync(new URL('../src/lib/social.ts', import.meta.url), 'utf8');

  test('the email field exists and is reachable in one tap', () => {
    assert.match(sheet, /use my email instead/);
    assert.match(sheet, /placeholder=(?:"Email address"|\{t\('Email address'\)\})/);
  });

  test('trying to continue with both blank opens the other door for them', () => {
    assert.match(sheet, /if \(!tidy && !tidyEmail\) \{[\s\S]{0,200}setEmailOpen\(true\)/);
  });

  test('the address reaches the server', () => {
    assert.match(sheet, /signUp\(name\.trim\(\), tidy \?\? undefined, tidyEmail \?\? undefined\)/);
    assert.match(social, /export async function signUp\(name: string, phone\?: string, email\?: string\)/);
    assert.match(social, /body: JSON\.stringify\(\{ id: deviceId\(\), name, phone, email,/);
  });

  test('the code box appears for an email sign-up too', () => {
    // `smsOn` reports whether a TEXT went out; guarding on it alone would have
    // left an email member holding a code with nowhere to type it.
    assert.match(sheet, /!me\.email_verified && me\.email && !me\.phone/);
  });
});

describe('the nudge chip is wired all the way to a real card', () => {
  const social = readFileSync(new URL('../src/lib/social.ts', import.meta.url), 'utf8');
  const concierge = readFileSync(new URL('../src/lib/concierge.ts', import.meta.url), 'utf8');
  const profile = readFileSync(new URL('../src/components/app/ProfileView.tsx', import.meta.url), 'utf8');
  const card = readFileSync(new URL('../src/components/app/ContactCard.tsx', import.meta.url), 'utf8');

  test('the ask fires only for somebody with neither', () => {
    assert.match(social, /if \(!me \|\| me\.phone \|\| me\.email\) return;/);
  });

  test('and no more than once a week', () => {
    assert.match(social, /CONTACT_NUDGE_DAYS \* 86_400_000/);
  });

  test('the chip opens the profile AND the card inside it', () => {
    assert.match(concierge, /id === 'addcontact'/);
    assert.match(concierge, /store\.set\(\{ profileOpen: true, contactOpen: true \}\)/);
    assert.match(profile, /<ContactCard \/>/);
    assert.match(card, /store\.set\(\{ contactOpen: false \}\)/);
    assert.match(card, /scrollIntoView/);
  });

  test('the card posts somewhere real and can check the code', () => {
    assert.match(card, /addContact\(tidyPhone \?\? undefined, tidyEmail \?\? undefined\)/);
    assert.match(social, /export async function addContact/);
    assert.match(social, /apiUrl|api<Partial<MeResponse>>\('\/me'/);
    assert.match(card, /verifyCode\(code\.trim\(\)\)/);
    assert.match(card, /resendCode\(\)/);
  });

  test('a fully verified member is shown nothing at all', () => {
    assert.match(card, /if \(verified\) return null;/);
  });
});
