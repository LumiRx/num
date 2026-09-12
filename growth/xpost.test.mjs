// Posting to X from Num's own account.
//
// The two things worth testing here are money and silence: that a post's cost
// is computed from its own text rather than assumed, and that every path which
// cannot prove it is allowed to post refuses instead of posting.
//
// The cost asymmetry is the whole reason the first matters. X charges $0.015 a
// post and $0.20 for a post CONTAINING A LINK — thirteen times more — and every
// post Num would naturally make carries a link. A budget built on the headline
// rate is out by more than an order of magnitude.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_LINK_TC, COST_PLAIN_TC, LIMIT, canPost, costOf, dollars, hasLink, postToX,
} from './xpost.mjs';

const ENV = { NUM_X_BEARER: 'tok', NUM_X_POSTING: '1', NUM_X_BUDGET_TC: '1000' };
const ok = async () => ({ ok: true, json: async () => ({ data: { id: '1' } }) });

describe('what a post costs', () => {
  test('a post with a link costs thirteen times a post without one', () => {
    assert.equal(COST_PLAIN_TC, 15, '$0.015');
    assert.equal(COST_LINK_TC, 200, '$0.20');
    assert.equal(costOf('dinner in Phuket tonight'), COST_PLAIN_TC);
    assert.equal(costOf('dinner in Phuket tonight https://itsnum.com'), COST_LINK_TC);
  });

  test('a link is recognised however it is written', () => {
    for (const t of [
      'see https://app.itsnum.com', 'see http://x.test', 'visit www.itsnum.com',
      'itsnum.com has it', 'try bangtao.co.th', 'num.app', 'look at EXAMPLE.COM',
    ]) {
      assert.equal(hasLink(t), true, `missed the link in: ${t}`);
    }
  });

  test('the link test errs EXPENSIVE, never cheap', () => {
    // Wrong in the generous direction over-states the bill by 18.5 cents.
    // Wrong the other way under-states it thirteenfold and the cap stops
    // working, which is not a guard at all.
    assert.equal(hasLink('we opened at 9 a.m. sharp'), false, 'a false positive is survivable');
    assert.equal(costOf('book now at itsnum.com'), COST_LINK_TC);
  });

  test('no money is ever a float', () => {
    for (const t of ['plain', 'link https://a.com']) {
      assert.equal(Number.isInteger(costOf(t)), true);
    }
    assert.equal(dollars(200), '$0.20');
    assert.equal(dollars(1000), '$1.00');
    // A sub-cent cost must not be DISPLAYED as less than it is. Two decimals
    // turned $0.015 into "$0.01", which is the same shape of under-statement as
    // assuming the cheap rate in the first place.
    assert.equal(dollars(15), '$0.015');
    assert.equal(dollars(5), '$0.005');
  });
});

describe('the budget gate', () => {
  test('an UNSET budget means no posting, not unlimited', () => {
    // Forgetting to set a cap must not be the same act as approving every post.
    const out = canPost({ text: 'hello', spentTc: 0, capTc: 0 });
    assert.equal(out.ok, false);
    assert.match(out.why, /no posting budget/);
    for (const cap of [null, undefined, '', NaN, -5]) {
      assert.equal(canPost({ text: 'hello', capTc: cap }).ok, false, `cap ${cap} allowed a post`);
    }
  });

  test('a post that would cross the cap is refused, and says what is left', () => {
    const out = canPost({ text: 'go to itsnum.com', spentTc: 900, capTc: 1000 });
    assert.equal(out.ok, false);
    assert.equal(out.capped, true);
    assert.match(out.why, /\$0\.20/);
    assert.match(out.why, /\$0\.10 is left/);
  });

  test('the cap counts the REAL cost of this post, not the cheap one', () => {
    // 15 tenth-cents left. A plain post fits; the same post with a link does
    // not, and assuming the cheap rate would have let it through.
    assert.equal(canPost({ text: 'dinner tonight', spentTc: 985, capTc: 1000 }).ok, true);
    assert.equal(canPost({ text: 'dinner tonight itsnum.com', spentTc: 985, capTc: 1000 }).ok, false);
  });

  test('exactly reaching the cap is allowed; exceeding it is not', () => {
    assert.equal(canPost({ text: 'x', spentTc: 985, capTc: 1000 }).ok, true);
    assert.equal(canPost({ text: 'x', spentTc: 986, capTc: 1000 }).ok, false);
  });

  test('an over-length post is refused before it costs anything', () => {
    const out = canPost({ text: 'x'.repeat(LIMIT + 1), spentTc: 0, capTc: 100000 });
    assert.equal(out.ok, false);
    assert.match(out.why, /over 280/);
  });

  test('length is counted the way X counts it — a link is 23 characters', () => {
    // A 300-character URL is 23 to X. Counting it literally would refuse a post
    // that is perfectly legal.
    const long = `https://app.itsnum.com/${'p'.repeat(300)}`;
    const out = canPost({ text: `dinner ${long}`, spentTc: 0, capTc: 100000 });
    assert.equal(out.ok, true, out.why);
    assert.ok(out.counted < 60);
  });

  test('an empty post is nothing to send', () => {
    for (const t of ['', '   ', null, undefined]) {
      assert.equal(canPost({ text: t, capTc: 100000 }).ok, false);
    }
  });
});

describe('nothing posts unless all three things are true', () => {
  test('no token, no post', async () => {
    let called = false;
    const out = await postToX({ NUM_X_POSTING: '1', NUM_X_BUDGET_TC: '1000' }, { text: 'hi' },
      async () => { called = true; return ok(); });
    assert.equal(out.ok, false);
    assert.equal(called, false, 'it tried to post with no credentials');
  });

  test('a token alone does NOT turn posting on', async () => {
    // The switch is separate on purpose: adding a token to check the
    // credentials work must not also start publishing.
    let called = false;
    const out = await postToX({ NUM_X_BEARER: 'tok', NUM_X_BUDGET_TC: '1000' }, { text: 'hi' },
      async () => { called = true; return ok(); });
    assert.equal(out.ok, false);
    assert.match(out.why, /NUM_X_POSTING/);
    assert.equal(called, false);
  });

  test('only the exact string "1" turns it on', async () => {
    for (const v of ['true', 'yes', 'on', '0', 1, '']) {
      let called = false;
      await postToX({ ...ENV, NUM_X_POSTING: v }, { text: 'hi' },
        async () => { called = true; return ok(); });
      assert.equal(called, false, `NUM_X_POSTING=${v} posted`);
    }
  });

  test('the budget is still checked when everything else is on', async () => {
    let called = false;
    const out = await postToX({ ...ENV, NUM_X_BUDGET_TC: '0' }, { text: 'hi' },
      async () => { called = true; return ok(); });
    assert.equal(out.ok, false);
    assert.equal(called, false, 'a post was sent with no budget');
  });

  test('with all three, it posts once and reports the real cost', async () => {
    let seen = null;
    const out = await postToX(ENV, { text: 'dinner at itsnum.com', idempotencyKey: 'k1' },
      async (url, o) => { seen = { url, ...o }; return ok(); });
    assert.equal(out.ok, true, out.why);
    assert.equal(out.id, '1');
    assert.equal(out.cost_tc, COST_LINK_TC, 'a link post must not be priced as a plain one');
    assert.match(seen.url, /api\.x\.com\/2\/tweets$/);
    assert.equal(seen.headers.authorization, 'Bearer tok');
    assert.equal(seen.headers['x-idempotency-key'], 'k1', 'a retry must not become a second post');
    assert.deepEqual(JSON.parse(seen.body), { text: 'dinner at itsnum.com' });
  });
});

describe('when X refuses', () => {
  test('a failure is a stated refusal, not a throw', async () => {
    // The caller is usually a background task, where an exception is silence.
    const out = await postToX(ENV, { text: 'hi' }, async () => ({
      ok: false, status: 403, json: async () => ({ detail: 'not permitted' }),
    }));
    assert.equal(out.ok, false);
    assert.match(out.why, /403/);
    assert.match(out.why, /not permitted/);
  });

  test('a credential problem is NOT marked retryable', async () => {
    // Retrying a 401 cannot succeed and keeps spending attempts.
    for (const status of [400, 401, 403, 404]) {
      const out = await postToX(ENV, { text: 'hi' },
        async () => ({ ok: false, status, json: async () => ({}) }));
      assert.equal(out.retryable, false, `${status} was marked retryable`);
    }
  });

  test('rate limits and server faults are retryable', async () => {
    for (const status of [429, 500, 503]) {
      const out = await postToX(ENV, { text: 'hi' },
        async () => ({ ok: false, status, json: async () => ({}) }));
      assert.equal(out.retryable, true, `${status} should be retried later`);
    }
  });
});

describe('the file does not schedule itself', () => {
  test('nothing here posts on a timer', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./xpost.mjs', import.meta.url), 'utf8');
    // An agent that posts publicly on a schedule is a different product from a
    // tool that posts when asked, and that change should be made out loud.
    assert.doesNotMatch(src, /scheduled\(|cron|setInterval/i,
      'this file has acquired a schedule — that is a decision, not a refactor');
  });
});
