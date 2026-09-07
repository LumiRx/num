/**
 * Naming the account that answers our guests.
 *
 * The 5 Sep outage lasted two and a half days partly because "which Anthropic
 * account is this?" had no answer inside the system. These tests are mostly
 * about what the answer must NEVER contain: the key, or a confident guess.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brainOrg, matchesExpected, keyTail, resetOrgCache } from './brainorg.mjs';

const KEY = 'sk-ant-api03-abcdefghijklmnop-QRST';

const okBody = { id: 'org_01ABCDEF', name: 'Lumi', type: 'organization' };
const fetcher = (plan) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const next = plan.shift();
    if (next instanceof Error) throw next;
    return { status: next.status, json: async () => next.body ?? null };
  };
  f.calls = calls;
  return f;
};

beforeEach(() => resetOrgCache());

describe('it answers the question', () => {
  test('a working key names the organisation', async () => {
    const f = fetcher([{ status: 200, body: okBody }]);
    const out = await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: f });
    assert.equal(out.ok, true);
    assert.equal(out.id, 'org_01ABCDEF');
    assert.equal(out.name, 'Lumi');
    assert.equal(f.calls[0].url, 'https://api.anthropic.com/v1/organizations/me');
    assert.equal(f.calls[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(f.calls[0].headers['x-api-key'], KEY);
  });

  test('it falls back to Bearer once on a 401, and then stops', async () => {
    const f = fetcher([{ status: 401 }, { status: 200, body: okBody }]);
    const out = await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: f });
    assert.equal(out.ok, true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].headers.authorization, `Bearer ${KEY}`);
  });

  test('two 401s is a dead key, said in words, with no third attempt', async () => {
    const f = fetcher([{ status: 401 }, { status: 401 }]);
    const out = await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: f });
    assert.equal(out.ok, false);
    assert.equal(f.calls.length, 2);
    assert.match(out.note, /expired, revoked/);
  });

  test('no key at all is reported as no key, not as an outage', async () => {
    const out = await brainOrg({}, { fetchImpl: fetcher([]) });
    assert.equal(out.ok, false);
    assert.equal(out.configured, false);
    assert.match(out.note, /no Anthropic key/);
  });

  test('a network failure does not throw into the caller', async () => {
    const out = await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: fetcher([new Error('boom')]) });
    assert.equal(out.ok, false);
    assert.equal(out.configured, true);
    assert.match(out.note, /Could not reach Anthropic/);
  });
});

describe('what it must never say', () => {
  test('the key never appears in the answer, on any path', async () => {
    const outs = [
      await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: fetcher([{ status: 200, body: okBody }]) }),
      await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: fetcher([{ status: 401 }, { status: 401 }]) }),
      await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: fetcher([new Error('boom')]) }),
      await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: fetcher([{ status: 500 }]) }),
    ];
    for (const o of outs) {
      const text = JSON.stringify(o);
      assert.doesNotMatch(text, /sk-ant/);
      assert.ok(!text.includes(KEY.slice(0, -4)));
    }
  });

  test('key_tail is four characters and no more', () => {
    assert.equal(keyTail(KEY), 'QRST');
    assert.equal(keyTail('abc'), null);
    assert.equal(keyTail(null), null);
  });

  test('it never claims to know the credit balance', () => {
    const SRC = readFileSync(new URL('./brainorg.mjs', import.meta.url), 'utf8');
    const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /balance|credits?_remaining|usage/i);
  });
});

describe('caching', () => {
  test('a second read inside the window does not call Anthropic again', async () => {
    const f = fetcher([{ status: 200, body: okBody }]);
    await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: f });
    const again = await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: f });
    assert.equal(f.calls.length, 1);
    assert.equal(again.cached, true);
  });

  test('a NEW key is never answered from the old key’s cache', async () => {
    const f = fetcher([{ status: 200, body: okBody }, { status: 200, body: { ...okBody, id: 'org_NEW', name: 'Num' } }]);
    await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: f });
    const out = await brainOrg({ ANTHROPIC_API_KEY: 'sk-ant-api03-zzzzzzzz-WXYZ' }, { fetchImpl: f });
    assert.equal(out.id, 'org_NEW', 'the whole point of the move is seeing that it moved');
    assert.equal(f.calls.length, 2);
  });

  test('a failure is not cached — the next check re-asks', async () => {
    const f = fetcher([{ status: 500 }, { status: 200, body: okBody }]);
    await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: f });
    const out = await brainOrg({ ANTHROPIC_API_KEY: KEY }, { fetchImpl: f });
    assert.equal(out.ok, true);
  });
});

describe('did the move actually happen', () => {
  test('with nothing to compare against it says so instead of passing', () => {
    assert.deepEqual(matchesExpected({ ok: true, id: 'org_1' }, null).checked, false);
  });

  test('the right account is a match', () => {
    assert.equal(matchesExpected({ ok: true, id: 'org_1' }, ' org_1 ').match, true);
  });

  test('the wrong account fails loudly, and names the consequence', () => {
    const r = matchesExpected({ ok: true, id: 'org_1' }, 'org_2');
    assert.equal(r.match, false);
    assert.match(r.note, /take the concierge down/);
  });

  test('an unreadable organisation is never reported as a match', () => {
    assert.equal(matchesExpected({ ok: false }, 'org_1').match, false);
  });
});

describe('the endpoint that serves it', () => {
  const IDX = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const at = IDX.indexOf("url.pathname === '/api/brains'");
  // Wide enough to survive another branch being added inside the handler —
  // on 7 Sep `?plan=` joined `?probe=` and `?org=` in here, and a tight
  // window failed on a change that was not about this file at all.
  const block = IDX.slice(at, IDX.indexOf('/api/admin/claims', at));

  test('the org read is admin-gated, like the probe', () => {
    assert.match(block, /const admin = env\.ADMIN_KEY && request\.headers\.get\('X-Admin-Key'\) === env\.ADMIN_KEY/);
    assert.match(block, /searchParams\.get\('org'\) && admin/);
  });

  test('the plain, ungated call still works and costs nothing', () => {
    assert.match(block, /return json\(200, \{ brains: brainRoster\(env\) \}\);/);
  });
});
