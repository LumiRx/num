// The send gate, on the server.
//
// The app has its own gate (src/lib/gate.test.mjs); this is the one that
// cannot be bypassed by an old bundle or a curl. The tests that earn their
// keep here are the four that would each have been an outage:
//
//   · the health probe still passes, or /api/health goes red on its own gate
//     — and that endpoint went green for the first time in two weeks this
//     morning;
//   · itsnum.com/ask/ still passes, because its own headline says "No signup"
//     and it is the top of the funnel;
//   · the App Review reviewer still passes, whose row is deliberately NOT
//     marked verified;
//   · a member whose row we cannot read is refused rather than waved through.
//
// And one that was a real bug, caught before shipping: num_members has no
// `apple_sub` column and num_apple_identities does not exist until the first
// Apple sign-in, so a joined query threw and the gate — which fails closed —
// would have stopped every member in the world from sending.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { maySend, fromSite, reviewerRow, VERIFY_TO_SEND } from './sendgate.mjs';

const req = (headers = {}) => ({ headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null } });
const body = (id) => (id ? { state: { me: { id } } } : { state: {} });

/** A database that answers the member query, and optionally the provider one. */
const db = (row, { provider = null, providerThrows = false, memberThrows = false } = {}) => ({
  prepare(sql) {
    return {
      bind() {
        return {
          first() {
            if (sql.includes('num_apple_identities')) {
              return providerThrows ? Promise.reject(new Error('no such table')) : Promise.resolve(provider);
            }
            return memberThrows ? Promise.reject(new Error('D1 unwell')) : Promise.resolve(row);
          },
        };
      },
    };
  },
});

const member = (over = {}) => ({ id: 'mem_1', phone: null, phone_verified: 0, email: null, email_verified: 0, ...over });

describe('what is deliberately still open', () => {
  test('the health probe passes without a member', async () => {
    const out = await maySend({ DB: db(null) }, req({ 'X-Num-Probe': '1' }), body());
    assert.deepEqual(out, { ok: true, reason: 'probe' });
  });

  test('the marketing site passes — /ask promises no signup and means it', async () => {
    for (const h of [
      { Origin: 'https://itsnum.com' },
      { Origin: 'https://www.itsnum.com' },
      { Referer: 'https://itsnum.com/ask/' },
    ]) {
      const out = await maySend({ DB: db(null) }, req(h), body());
      assert.equal(out.ok, true, JSON.stringify(h));
      assert.equal(out.reason, 'site');
    }
  });

  test('the app itself is NOT the site — that is the whole point', () => {
    assert.equal(fromSite(req({ Origin: 'https://app.itsnum.com' })), false);
    assert.equal(fromSite(req({ Origin: 'capacitor://localhost' })), false);
    assert.equal(fromSite(req({})), false);
    // A look-alike host must not pass for the real one.
    assert.equal(fromSite(req({ Origin: 'https://itsnum.com.evil.example' })), false);
    assert.equal(fromSite(req({ Origin: 'not a url' })), false);
  });
});

describe('who may ask', () => {
  test('no member id at all is refused', async () => {
    const out = await maySend({ DB: db(null) }, req(), body());
    assert.deepEqual(out, { ok: false, reason: 'no_member' });
  });

  test('a member with nothing proved is refused', async () => {
    const out = await maySend({ DB: db(member({ phone: '+15555550123' })) }, req(), body('mem_1'));
    assert.deepEqual(out, { ok: false, reason: 'unverified' });
  });

  test('a proved phone passes, and so does a proved address', async () => {
    assert.equal((await maySend({ DB: db(member({ phone_verified: 1 })) }, req(), body('mem_1'))).ok, true);
    assert.equal((await maySend({ DB: db(member({ email_verified: 1 })) }, req(), body('mem_1'))).ok, true);
  });

  test('an id nobody holds is refused, not treated as a stranger to welcome', async () => {
    const out = await maySend({ DB: db(null) }, req(), body('mem_nope'));
    assert.deepEqual(out, { ok: false, reason: 'unknown_member' });
  });

  test('an Apple identity passes, from its own table', async () => {
    const out = await maySend({ DB: db(member(), { provider: { has_provider: 1 } }) }, req(), body('mem_1'));
    assert.deepEqual(out, { ok: true, reason: 'provider' });
  });

  test('THE APPLE TABLE MISSING IS NOT AN OUTAGE', async () => {
    // It does not exist until the first Apple sign-in creates it. If its
    // absence propagated, this gate would refuse everyone on a database where
    // nobody has ever used Apple — which is production, today.
    const out = await maySend(
      { DB: db(member({ phone_verified: 1 }), { providerThrows: true }) }, req(), body('mem_1'),
    );
    assert.equal(out.ok, true);
    const refused = await maySend({ DB: db(member(), { providerThrows: true }) }, req(), body('mem_1'));
    assert.deepEqual(refused, { ok: false, reason: 'unverified' }, 'a missing table must read as "no provider"');
  });

  test('a database that will not answer fails CLOSED', async () => {
    // The alternative is a gate that disappears exactly when D1 is unwell,
    // which is when a flood is most likely to be the reason it is unwell.
    await assert.rejects(() => maySend({ DB: db(null, { memberThrows: true }) }, req(), body('mem_1')));
    assert.deepEqual(await maySend({}, req(), body('mem_1')), { ok: false, reason: 'no_db' });
  });
});

describe('the App Review reviewer', () => {
  const soon = new Date(Date.now() + 864e5).toISOString();
  const past = new Date(Date.now() - 864e5).toISOString();

  test('passes on the pinned member id while the grant is live', () => {
    const env = { REVIEW_ACCESS_UNTIL: soon, REVIEW_DEMO_MEMBER: 'mem_review' };
    assert.equal(reviewerRow(env, { id: 'mem_review' }), true);
    assert.equal(reviewerRow(env, { id: 'mem_1' }), false, 'the grant is bound to one account');
  });

  test('or on the phone the grant is bound to, when no member is pinned', () => {
    const env = { REVIEW_ACCESS_UNTIL: soon, REVIEW_DEMO_PHONE: '+15005550006' };
    assert.equal(reviewerRow(env, { id: 'x', phone: '+15005550006' }), true);
    assert.equal(reviewerRow(env, { id: 'x', phone: '+15005550007' }), false);
  });

  test('and an expired or unset grant is the same as no grant', () => {
    assert.equal(reviewerRow({ REVIEW_ACCESS_UNTIL: past, REVIEW_DEMO_MEMBER: 'mem_review' }, { id: 'mem_review' }), false);
    assert.equal(reviewerRow({}, { id: 'mem_review' }), false, 'DEFAULT: OFF');
    assert.equal(reviewerRow({ REVIEW_ACCESS_UNTIL: 'not a date', REVIEW_DEMO_MEMBER: 'm' }, { id: 'm' }), false);
  });

  test('an unverified reviewer row passes the whole gate', async () => {
    const env = { DB: db(member({ id: 'mem_review' })), REVIEW_ACCESS_UNTIL: soon, REVIEW_DEMO_MEMBER: 'mem_review' };
    const out = await maySend(env, req(), body('mem_review'));
    assert.deepEqual(out, { ok: true, reason: 'review' });
  });
});

describe('wired at the boundary, not inside the brain', () => {
  const INDEX = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

  test('the gate runs on the /api/num route, before either answer shape', () => {
    const at = INDEX.indexOf("const { maySend, VERIFY_TO_SEND } = await import('./sendgate.mjs');");
    assert.ok(at > 0, 'the route must carry the gate');
    assert.ok(at < INDEX.indexOf("const { wantsNdjson, streamNdjson } = await import('./ack.mjs');"), 'before the streaming branch');
    assert.ok(at < INDEX.lastIndexOf('return await handleNum(request, env, ctx);'), 'before the plain branch');
  });

  test('the body is peeked from a CLONE, so the brain still gets its stream', () => {
    assert.match(INDEX, /await request\.clone\(\)\.json\(\)\.catch\(\(\) => null\)/);
  });

  test('handleNum itself is not gated — WhatsApp, MCP and concierge_answer go through it', () => {
    const fn = INDEX.slice(INDEX.indexOf('export async function handleNum(request, env, ctx'));
    assert.doesNotMatch(fn.slice(0, 4000), /maySend\(/);
  });

  test('the refusal says one sentence and carries a word to branch on', () => {
    assert.equal(VERIFY_TO_SEND.error, 'verify_to_send');
    assert.match(VERIFY_TO_SEND.message, /Verify a number or an email/);
    assert.doesNotMatch(VERIFY_TO_SEND.message, /error|invalid|denied|forbidden/i);
  });
});
