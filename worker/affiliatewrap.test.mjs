// The click-redirect networks — the mechanism that decides whether NUM is
// actually paid on a hotel booking.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
//
// Marriott and Hilton run their affiliate programmes on impact.com; IHG runs
// on Partnerize. Both are CLICK-REDIRECT networks: the cookie that earns the
// commission is set by the network's own domain, which the guest must pass
// through. A ref parameter appended to `hilton.com/...` sets nothing, is
// ignored by Hilton, and pays nothing — while looking, in NUM's own click
// log, exactly like a tagged link that works.
//
// An affiliate table that reports revenue we are not earning is worse than
// one that reports none. So these tests assert on the SHAPE of the outbound
// URL, not on whether a boolean came back true.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tagged, tag, wrap, programmes } from './affiliate.mjs';

// The real templates, with the credential parts replaced. Structure is what
// is under test; the ids are a secret and never belong in a repository.
const IMPACT = 'https://hilton.sjv.io/c/1234567/1958948/12674?subId1={sub}&u={dest}';
const PARTNERIZE = 'https://prf.hn/click/camref:1100lTEST/pubref:{sub}/destination:{dest}';

const env = (table) => ({ NUM_AFFILIATES: JSON.stringify(table) });
const HILTON = 'https://www.hilton.com/en/book/reservation/deeplink/?ctyhocn=EDNCHQQ';
const IHG = 'https://www.ihg.com/redirect?hotelCode=EDIGS';

describe('impact.com', () => {
  const e = env({ 'hilton.com': { wrap: IMPACT } });

  test('the guest is sent through the network, not straight to the hotel', () => {
    const t = tagged(HILTON, e, { extra: 'ADAM' });
    assert.equal(t.tagged, true);
    assert.equal(t.reason, 'wrapped', 'a wrap and a parameter earn by different mechanisms');
    assert.equal(new URL(t.url).hostname, 'hilton.sjv.io');
    assert.equal(t.programme, 'hilton.com');
    assert.equal(t.host, 'hilton.com', 'the log must still name the hotel we sent traffic to');
  });

  test('the destination survives, question mark and all', () => {
    // The whole booking is in that query string. If `?ctyhocn=EDNCHQQ` is not
    // encoded, the network reads it as its own parameter and the guest lands
    // on hilton.com's home page — a link that looks like it worked, right up
    // until nobody can find their hotel.
    const t = tagged(HILTON, e, { extra: 'ADAM' });
    const u = new URL(t.url).searchParams.get('u');
    assert.equal(u, HILTON, 'the destination came back mangled');
    assert.ok(!t.url.includes('?ctyhocn='), 'the destination query leaked into the wrapper');
  });

  test("the scout's code rides in subId1, where the payout report can see it", () => {
    const t = tagged(HILTON, e, { extra: 'ADAM' });
    assert.equal(new URL(t.url).searchParams.get('subId1'), 'ADAM');
  });
});

describe('partnerize', () => {
  const e = env({ 'ihg.com': { wrap: PARTNERIZE } });

  test('the sub-id can live in a PATH segment, not only a query', () => {
    // Partnerize is the reason the template takes placeholders instead of
    // named fields: `pubref` is a path segment and `subId1` is a query
    // parameter, and neither needs a line of network-specific code.
    const t = tagged(IHG, e, { extra: 'ADAM' });
    assert.equal(t.reason, 'wrapped');
    assert.ok(t.url.includes('/pubref:ADAM/'), t.url);
    assert.ok(t.url.startsWith('https://prf.hn/click/camref:1100lTEST/'), t.url);
  });

  test('the destination is encoded inside the path', () => {
    const t = tagged(IHG, e, { extra: 'ADAM' });
    assert.ok(t.url.includes(`destination:${encodeURIComponent(IHG)}`), t.url);
    assert.ok(!t.url.includes('destination:https://'), 'an unencoded destination ends the path early');
  });
});

describe('what must never happen', () => {
  test('a broken template gives the guest the plain link, not a broken one', () => {
    for (const bad of [
      'https://x.test/c/1/2/3',                 // no {dest} — every guest lands on the network
      'http://x.test/c?u={dest}',               // not https
      'not a url at all {dest}',
      '',
    ]) {
      const t = tagged(HILTON, env({ 'hilton.com': { wrap: bad } }), { extra: 'ADAM' });
      assert.equal(t.url, HILTON, `bad template leaked a broken link: ${bad}`);
      assert.equal(t.tagged, false);
      assert.equal(t.reason, 'bad_wrap');
    }
  });

  test('a link already on the network is not wrapped twice', () => {
    // A second redirect through the same tracker overwrites the first click's
    // attribution. When a partner sent us the wrapped link, that is taking a
    // commission which was already theirs.
    const already = 'https://prf.hn/click/camref:OTHERGUY/destination:https%3A%2F%2Fwww.ihg.com%2F';
    const t = tagged(already, env({ 'prf.hn': { wrap: PARTNERIZE } }), { extra: 'ADAM' });
    assert.equal(t.url, already);
    assert.equal(t.tagged, false);
  });

  test('a sub-id cannot break out of a path segment or a query', () => {
    // `pubref` sits in a Partnerize path. A slash would end the segment early
    // and silently move the destination somewhere else.
    const t = tagged(IHG, env({ 'ihg.com': { wrap: PARTNERIZE } }),
      { extra: 'AD/AM?x=1&y=2 #frag' });
    assert.ok(t.url.includes('/pubref:ADAMx1y2frag/'), t.url);
    assert.equal(new URL(t.url).pathname.split('/').length,
      new URL(tagged(IHG, env({ 'ihg.com': { wrap: PARTNERIZE } }), { extra: 'ADAM' }).url)
        .pathname.split('/').length,
      'a sub-id added a path segment');
  });

  test('a very long sub-id is cut to what the networks accept', () => {
    const t = tagged(HILTON, env({ 'hilton.com': { wrap: IMPACT } }), { extra: 'A'.repeat(300) });
    assert.equal(new URL(t.url).searchParams.get('subId1').length, 64, "Impact's subId1 limit");
  });

  test('no sub-id at all is still a valid, earning link', () => {
    const t = tagged(HILTON, env({ 'hilton.com': { wrap: IMPACT } }));
    assert.equal(t.tagged, true);
    assert.equal(new URL(t.url).searchParams.get('subId1'), '');
    assert.equal(new URL(t.url).searchParams.get('u'), HILTON);
  });

  test('http destinations are refused before any wrapping is attempted', () => {
    const t = tagged('http://www.hilton.com/x', env({ 'hilton.com': { wrap: IMPACT } }));
    assert.equal(t.reason, 'not_https');
    assert.equal(t.tagged, false);
  });

  test('an unconfigured host is untouched, exactly as before', () => {
    const t = tagged('https://www.marriott.com/x', env({ 'hilton.com': { wrap: IMPACT } }));
    assert.equal(t.url, 'https://www.marriott.com/x');
    assert.equal(t.tagged, false);
    assert.equal(t.host, 'marriott.com');
  });
});

describe('the two mechanisms coexist', () => {
  test('a param programme still behaves exactly as it did', () => {
    const e = env({
      'opentable.com': { ref: '12345', param: 'ref' },
      'hilton.com': { wrap: IMPACT },
    });
    const t = tagged('https://www.opentable.com/r/bestia', e);
    assert.equal(t.reason, 'tagged');
    assert.match(t.url, /[?&]ref=12345/);
    assert.equal(new URL(t.url).hostname, 'www.opentable.com', 'a param programme must not redirect');
  });

  test('wrap wins when a rule mistakenly carries both', () => {
    // A rule with both is a configuration error. The wrap is the half that
    // actually earns, so it is the half that must win.
    const t = tagged(HILTON, env({ 'hilton.com': { wrap: IMPACT, ref: 'x', param: 'ref' } }));
    assert.equal(t.reason, 'wrapped');
  });

  test('programmes() reports a wrap rule as a live programme', () => {
    // Filtering on `ref` alone made every chain invisible on the ops page —
    // reporting that NUM earns on nothing while it was earning.
    const list = programmes(env({
      'hilton.com': { wrap: IMPACT },
      'opentable.com': { ref: '12345', param: 'ref' },
      'nothing.test': {},
    }));
    assert.equal(list.length, 2);
    const h = list.find((p) => p.host === 'hilton.com');
    assert.equal(h.mode, 'wrap');
    assert.equal(h.sub, true, 'the ops page must show whether attribution is being carried');
    assert.equal(list.find((p) => p.host === 'opentable.com').mode, 'param');
  });

  test('tag() returns the wrapped URL, like every other caller expects', () => {
    assert.equal(tag(HILTON, env({ 'hilton.com': { wrap: IMPACT } }), { extra: 'ADAM' }),
      tagged(HILTON, env({ 'hilton.com': { wrap: IMPACT } }), { extra: 'ADAM' }).url);
  });
});

describe('wrap() on its own', () => {
  test('null, never a half-built URL', () => {
    assert.equal(wrap('', 'https://x.test/'), null);
    assert.equal(wrap(IMPACT, ''), null);
    assert.equal(wrap(null, null), null);
    assert.equal(wrap('https://x.test/c?u={dest}', 'not-a-url'), null);
  });

  test('a template with no {sub} is fine — not every programme has one', () => {
    const u = wrap('https://x.test/c/1?u={dest}', 'https://y.test/a?b=c', 'ADAM');
    assert.equal(new URL(u).searchParams.get('u'), 'https://y.test/a?b=c');
  });
});
