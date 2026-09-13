// Refer a person, earn a share of what Num makes from them.
//
// The failure this whole file guards against is not a wrong number. It is
// PAYING THE WRONG PERSON, or paying nobody while telling them they earn —
// which is what Num had been doing: of 148 members on 13 Sep 2026, zero had a
// referrer recorded, and five referral conversions had sat `pending` since July.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  __resetSchema, creditMemberReferral, linkReferral, rateFor, referralSummary,
} from './memberreferral.mjs';

beforeEach(() => __resetSchema());

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, ref_code TEXT);
    CREATE TABLE num_referral_codes (code TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, active INTEGER);
    CREATE TABLE num_star_balances (member_id TEXT PRIMARY KEY, stars INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE num_star_moves (id TEXT PRIMARY KEY, member_id TEXT, delta INTEGER, kind TEXT,
      note TEXT, counterparty TEXT);
  `);
  const DB = {
    prepare(sql) {
      const b = [];
      const api = {
        bind(...a) { b.push(...a); return api; },
        async first() { try { return d.prepare(sql).get(...b) ?? null; } catch { return null; } },
        async all() { try { return { results: d.prepare(sql).all(...b) }; } catch { return { results: [] }; } },
        async run() {
          try {
            const r = d.prepare(sql).run(...b);
            return { meta: { changes: Number(r.changes ?? 0) } };
          } catch { return { meta: { changes: 0 } }; }
        },
      };
      return api;
    },
    async batch(st) { const o = []; for (const s of st) o.push(await s.run()); return o; },
  };
  return { d, env: { DB } };
}

const seed = (d) => {
  for (const [id, code] of [['mem_priya', 'PRIYA1'], ['mem_sam', 'SAM111'], ['mem_new', 'NEW111']]) {
    d.prepare('INSERT INTO num_members (id,name,ref_code) VALUES (?,?,?)').run(id, id, code);
    d.prepare("INSERT INTO num_referral_codes (code,owner_type,owner_id,active) VALUES (?,'member',?,1)")
      .run(code, id);
  }
};

describe('recording who brought somebody in', () => {
  test('a valid code links the new member to the referrer', async () => {
    const { d, env } = db();
    seed(d);
    const out = await linkReferral(env, { memberId: 'mem_new', code: 'PRIYA1' });
    assert.equal(out.ok, true);
    assert.equal(d.prepare('SELECT referred_by AS r FROM num_members WHERE id=?').get('mem_new').r, 'mem_priya');
  });

  test('FIRST TOUCH WINS — a later link does not steal the credit', async () => {
    // Otherwise the last person to send a link wins and whoever actually did
    // the persuading loses.
    const { d, env } = db();
    seed(d);
    await linkReferral(env, { memberId: 'mem_new', code: 'PRIYA1' });
    const second = await linkReferral(env, { memberId: 'mem_new', code: 'SAM111' });
    assert.equal(second.already, true);
    assert.equal(d.prepare('SELECT referred_by AS r FROM num_members WHERE id=?').get('mem_new').r, 'mem_priya');
  });

  test('you cannot refer yourself', async () => {
    const { d, env } = db();
    seed(d);
    const out = await linkReferral(env, { memberId: 'mem_priya', code: 'PRIYA1' });
    assert.equal(out.ok, false);
    assert.match(out.why, /self/);
    assert.equal(d.prepare('SELECT referred_by AS r FROM num_members WHERE id=?').get('mem_priya').r, null);
  });

  test('an unknown, inactive or business code links nothing', async () => {
    const { d, env } = db();
    seed(d);
    d.prepare("INSERT INTO num_referral_codes (code,owner_type,owner_id,active) VALUES ('DEAD11','member','mem_sam',0)").run();
    d.prepare("INSERT INTO num_referral_codes (code,owner_type,owner_id,active) VALUES ('BIZ111','business','biz_1',1)").run();
    for (const code of ['NOPE99', 'DEAD11', 'BIZ111', '', null]) {
      assert.equal((await linkReferral(env, { memberId: 'mem_new', code })).ok, false, `${code} linked`);
    }
  });

  test('a referral that cannot be linked never throws — a signup must not fail for it', async () => {
    const dead = { DB: { prepare() { throw new Error('down'); } } };
    const out = await linkReferral(dead, { memberId: 'm', code: 'X' });
    assert.equal(out.ok, false);
  });
});

describe('what the referrer earns', () => {
  const link = async (env, d) => { seed(d); await linkReferral(env, { memberId: 'mem_new', code: 'PRIYA1' }); };

  test('20% of what NUM collected, not of what the guest spent', async () => {
    // The distinction that decided the rate: 1% of a bill is 10% of our
    // revenue, and 1% of our commission is 8 cents on an $80 dinner.
    const { d, env } = db();
    await link(env, d);
    const out = await creditMemberReferral(env, { memberId: 'mem_new', stars: 800, ref: 'cm_1' });
    assert.equal(out.credited, 160);
    assert.equal(d.prepare('SELECT stars AS s FROM num_star_balances WHERE member_id=?').get('mem_priya').s, 160);
  });

  test('it lands as an EARNED star move, so it is cashable', async () => {
    const { d, env } = db();
    await link(env, d);
    await creditMemberReferral(env, { memberId: 'mem_new', stars: 800, ref: 'cm_1' });
    const mv = d.prepare('SELECT * FROM num_star_moves WHERE member_id=?').get('mem_priya');
    assert.equal(mv.kind, 'referral', "'referral' is in cashout.mjs EARNED_KINDS");
    assert.equal(mv.counterparty, 'mem_new');
  });

  test('THE ONE THAT MATTERS: it is SINGLE LEVEL and never walks a chain', async () => {
    // A slice of your referrals' referrals is a multi-level structure, which is
    // regulated territory and a different company from this one.
    const { d, env } = db();
    seed(d);
    await linkReferral(env, { memberId: 'mem_sam', code: 'PRIYA1' });   // priya → sam
    await linkReferral(env, { memberId: 'mem_new', code: 'SAM111' });   // sam → new
    await creditMemberReferral(env, { memberId: 'mem_new', stars: 1000, ref: 'cm_1' });

    assert.equal(d.prepare('SELECT stars AS s FROM num_star_balances WHERE member_id=?').get('mem_sam').s, 200,
      'the direct referrer is paid');
    const upline = d.prepare('SELECT stars AS s FROM num_star_balances WHERE member_id=?').get('mem_priya');
    assert.equal(upline, undefined, 'the referrer OF the referrer must earn nothing at all');
  });

  test('the source has no loop or recursion over referred_by', async () => {
    const src = readFileSync(new URL('./memberreferral.mjs', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    assert.doesNotMatch(code, /while\s*\(.*referred_by|WITH RECURSIVE/i,
      'a chain walk has appeared — this is now a multi-level scheme');
  });

  test('the rate frozen at link time survives a later rate change', async () => {
    // Changing the rate must not silently rewrite what somebody was promised.
    const { d, env } = db();
    await link(env, d);
    const out = await creditMemberReferral({ ...env, MEMBER_REFERRAL_PCT: '5' },
      { memberId: 'mem_new', stars: 1000, ref: 'cm_1' });
    assert.equal(out.pct, 20, 'the promise made at link time is what pays');
    assert.equal(out.credited, 200);
  });

  test('a retried settle does not pay twice', async () => {
    const { d, env } = db();
    await link(env, d);
    await creditMemberReferral(env, { memberId: 'mem_new', stars: 800, ref: 'cm_1' });
    const again = await creditMemberReferral(env, { memberId: 'mem_new', stars: 800, ref: 'cm_1' });
    assert.equal(again.duplicate, true);
    assert.equal(d.prepare('SELECT stars AS s FROM num_star_balances WHERE member_id=?').get('mem_priya').s, 160);
  });

  test('a member with no referrer pays nobody', async () => {
    const { d, env } = db();
    seed(d);
    const out = await creditMemberReferral(env, { memberId: 'mem_new', stars: 800, ref: 'cm_1' });
    assert.equal(out.credited, 0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM num_star_moves').get().n, 0);
  });

  test('a departed referrer earns nothing — "while both stay active"', async () => {
    const { d, env } = db();
    await link(env, d);
    d.prepare('DELETE FROM num_members WHERE id=?').run('mem_priya');
    const out = await creditMemberReferral(env, { memberId: 'mem_new', stars: 800, ref: 'cm_1' });
    assert.equal(out.credited, 0);
  });

  test('a sub-1-star share rounds to nothing rather than to a free star', async () => {
    const { env, d } = db();
    await link(env, d);
    assert.equal((await creditMemberReferral(env, { memberId: 'mem_new', stars: 4, ref: 'cm_x' })).credited, 0);
  });
});

describe('the rate itself', () => {
  test('20% by default, configurable, and clamped against nonsense', () => {
    assert.equal(rateFor({}), 20);
    assert.equal(rateFor({ MEMBER_REFERRAL_PCT: '15' }), 15);
    for (const bad of ['0', '-5', '900', 'abc', '']) {
      assert.equal(rateFor({ MEMBER_REFERRAL_PCT: bad }), 20, `${bad} was accepted as a rate`);
    }
  });
});

describe('what a referrer can see', () => {
  test('how many they brought and what they have earned', async () => {
    const { d, env } = db();
    seed(d);
    await linkReferral(env, { memberId: 'mem_new', code: 'PRIYA1' });
    await linkReferral(env, { memberId: 'mem_sam', code: 'PRIYA1' });
    await creditMemberReferral(env, { memberId: 'mem_new', stars: 800, ref: 'cm_1' });
    const s = await referralSummary(env, 'mem_priya');
    assert.equal(s.referred, 2);
    assert.equal(s.earned, 160);
  });
});

describe('the break that made all of this necessary', () => {
  test('signup now SENDS the referral code', () => {
    // It read `?ref=` into a variable and never included it in the body.
    const src = readFileSync(new URL('../src/lib/social.ts', import.meta.url), 'utf8');
    assert.match(src, /localStorage\.setItem\('num-ref'/, 'first-touch capture is gone');
    assert.match(src, /ref: firstTouchRef/, 'the signup body no longer carries the referral code');
  });

  test('and the server records it', () => {
    const src = readFileSync(new URL('./social.mjs', import.meta.url), 'utf8');
    assert.match(src, /linkReferral\(env, \{ memberId: id, code: b\.ref \}\)/);
  });
});
