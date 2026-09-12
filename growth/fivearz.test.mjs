// Verifying a 5arz Proof-of-Personhood credential.
//
// The rule that shapes this whole file, from the 5arz team: sandbox
// credentials are signed by the PRODUCTION key and verify. So a good signature
// proves 5arz issued it and proves nothing about a human. Anyone can get a
// sandbox key from an unauthenticated endpoint.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUER, TYP, USER_AGENT, VCT, __resetJwks, bindTransaction, checkHeader, mintPersonhood, peek,
  verifyPersonhood,
} from './fivearz.mjs';

// The real sub_hash from the live 12 Sep probe. There is no `sub` claim in a
// 5arz payload at all — see the test that pins this.
const SUB_HASH = 'eb9ba517ac43cd7e4a50f8eb01809a85f5473bd9f950d008da203489597962c7';

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
const nowS = Math.floor(NOW / 1000);

let KEY, JWK, OTHER_JWK;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(payload, header = {}, key = KEY) {
  const h = b64url(JSON.stringify({ alg: 'ES256', typ: TYP, kid: '5arz-oracle-2', ...header }));
  const p = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key.privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

// Shaped on the live 12 Sep response, minus the `test`/`env` sandbox markers.
const good = (o = {}) => ({
  iss: ISSUER, vct: VCT, sub_hash: SUB_HASH, jti: 'pop_ir21epfgc0mz',
  iat: nowS - 60, exp: nowS + 3600, id_verified: true,
  method: 'stripe_identity+bio_bridge', assurance: 'direct_document_liveness', ...o,
});

before(async () => {
  KEY = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  JWK = { ...(await crypto.subtle.exportKey('jwk', KEY.publicKey)), kid: '5arz-oracle-2' };
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  OTHER_JWK = { ...(await crypto.subtle.exportKey('jwk', other.publicKey)), kid: '5arz-oracle-2' };
  OTHER_JWK.privateKey = other.privateKey;
});
beforeEach(() => __resetJwks());

const serving = (keys) => async () => ({ ok: true, json: async () => ({ keys }) });
const verify = (token, keys = [JWK]) =>
  verifyPersonhood(token, { fetchImpl: serving(keys), now: NOW });

describe('a real credential', () => {
  test('verifies, and identifies the human by sub_hash', async () => {
    const out = await verify(await sign(good()));
    assert.equal(out.ok, true, out.why);
    assert.equal(out.sub_hash, SUB_HASH);
    assert.equal(out.kid, '5arz-oracle-2');
  });

  test('it returns sub_hash, and never a `subject` read from `sub`', async () => {
    // Proven live 12 Sep: there is NO `sub` claim in a 5arz payload. The old
    // code read `p.sub`, so every verification returned subject:null — a
    // credential that looked like it was about nobody. sub_hash is also the
    // right thing to put in a receipt: it is SHA-256 of the member id, so it
    // links credentials to the same human without naming them.
    const out = await verify(await sign(good({ sub: 'm_typed_by_hand' })));
    assert.equal(out.ok, true, out.why);
    assert.equal('subject' in out, false);
    assert.equal(out.sub_hash, SUB_HASH);
  });

  test('the jti comes back, because a receipt without it cannot be revoked', async () => {
    const out = await verify(await sign(good()));
    assert.equal(out.jti, 'pop_ir21epfgc0mz');
  });

  test('id_verified is honoured under either spelling 5arz have used', async () => {
    const a = await verify(await sign(good({ id_verified: true, identity_verified: undefined })));
    const b = await verify(await sign(good({ id_verified: undefined, identity_verified: true })));
    const c = await verify(await sign(good({ id_verified: undefined, identity_verified: undefined })));
    assert.equal(a.id_verified, true);
    assert.equal(b.id_verified, true);
    assert.equal(c.id_verified, false, 'absent must not read as verified');
  });
});

describe('THE TRAP: a sandbox credential is signed by the production key', () => {
  test('test:true is refused even though the signature is perfect', async () => {
    // Anyone can POST /api/agents/register with mode:"test" — no auth — and
    // mint one of these. A verifier that stopped at the signature would hand
    // a human badge to whoever read the docs.
    const out = await verify(await sign(good({ test: true })));
    assert.equal(out.ok, false);
    assert.equal(out.sandbox, true);
    assert.match(out.why, /sandbox/);
  });

  test('sample:true is refused the same way', async () => {
    const out = await verify(await sign(good({ sample: true })));
    assert.equal(out.ok, false);
    assert.equal(out.sandbox, true);
  });

  test('the sandbox check is not skipped by anything that passes first', async () => {
    // A perfectly-formed, in-date, correctly-issued sandbox credential is the
    // exact shape that would sail through a verifier written in the obvious
    // order.
    const out = await verify(await sign(good({ test: true, liveness: true, unique_human: true })));
    assert.equal(out.ok, false);
  });

  test('test:false and sample:false are fine — only true is a sandbox', async () => {
    assert.equal((await verify(await sign(good({ test: false, sample: false })))).ok, true);
  });
});

describe('the forgeries', () => {
  test('alg:none never reaches a key lookup', async () => {
    const h = b64url(JSON.stringify({ alg: 'none', typ: TYP, kid: '5arz-oracle-2' }));
    const p = b64url(JSON.stringify(good()));
    const out = await verifyPersonhood(`${h}.${p}.`, {
      fetchImpl: () => { throw new Error('the key set must not even be fetched'); }, now: NOW,
    });
    assert.equal(out.ok, false);
    assert.match(out.why, /only ES256/);
  });

  test('an HMAC algorithm is refused — a symmetric key means anyone can forge', async () => {
    // 5arz have killing hmac-v0 on their own Tier 2 list for exactly this.
    for (const alg of ['HS256', 'HS384', 'HS512', 'RS256']) {
      const out = checkHeader({ alg, kid: '5arz-oracle-2' });
      assert.equal(out.ok, false, `${alg} was accepted`);
    }
  });

  test('a signature from the wrong key is refused', async () => {
    const forged = await sign(good(), {}, { privateKey: OTHER_JWK.privateKey });
    assert.equal((await verify(forged)).ok, false);
  });

  test('a kid that is not in the key set is refused', async () => {
    const out = await verify(await sign(good(), { kid: 'made-up-key' }));
    assert.equal(out.ok, false);
    assert.match(out.why, /not in the 5arz key set/);
  });

  test('an unknown kid triggers ONE refetch, then is still refused', async () => {
    // A rotation must be picked up without a deploy, so an unknown kid earns a
    // fresh fetch. It must not earn an unlimited number of them, or a made-up
    // kid becomes a way to make us hammer 5arz.
    let calls = 0;
    const out = await verifyPersonhood(await sign(good(), { kid: 'rotated-key' }), {
      fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ keys: [JWK] }) }; },
      now: NOW,
    });
    assert.equal(calls, 2, 'one normal fetch plus one rescue');
    assert.equal(out.ok, false, 'a failed rescue is never a pass');
  });

  test('a rotation IS picked up without a deploy', async () => {
    const rotated = { ...JWK, kid: 'rotated-key' };
    let calls = 0;
    const out = await verifyPersonhood(await sign(good(), { kid: 'rotated-key' }), {
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, json: async () => ({ keys: calls === 1 ? [] : [rotated] }) };
      },
      now: NOW,
    });
    assert.equal(out.ok, true, out.why);
  });

  test('the JWKS fetch names itself — a default agent string was 403d at their edge', async () => {
    let headers = null;
    await verifyPersonhood(await sign(good()), {
      fetchImpl: async (_u, o) => { headers = o?.headers; return { ok: true, json: async () => ({ keys: [JWK] }) }; },
      now: NOW,
    });
    assert.equal(headers['user-agent'], USER_AGENT);
    assert.match(USER_AGENT, /num/i);
  });

  test('a tampered payload breaks the signature', async () => {
    const token = await sign(good());
    const [h, , s] = token.split('.');
    const swapped = b64url(JSON.stringify(good({ sub_hash: 'somebody_else' })));
    assert.equal((await verify(`${h}.${swapped}.${s}`)).ok, false);
  });
});

describe('the fields the team named exactly', () => {
  test('iss is 5arz.com, NOT api.5arz.com', async () => {
    const out = await verify(await sign(good({ iss: 'https://api.5arz.com' })));
    assert.equal(out.ok, false);
    assert.match(out.why, /iss is/);
  });

  test('vct must match exactly', async () => {
    for (const vct of ['https://5arz.com/credentials/proof-of-humanity', '', undefined]) {
      assert.equal((await verify(await sign(good({ vct })))).ok, false, `${vct} was accepted`);
    }
  });

  test('typ is vi+jwt, and asserting JWT would reject a real credential', async () => {
    assert.equal(checkHeader({ alg: 'ES256', kid: 'k', typ: TYP }).ok, true);
    assert.equal(checkHeader({ alg: 'ES256', kid: 'k', typ: 'JWT' }).ok, false);
  });

  test('unique_human is never read or surfaced', async () => {
    // The 5arz team say do not build on it. A field that is not returned
    // cannot be depended on by accident six months from now.
    const out = await verify(await sign(good({ unique_human: true })));
    assert.equal(out.ok, true);
    assert.equal('unique_human' in out, false);
  });

  test('liveness is passed through as a CLAIM, never as a measurement', async () => {
    // It is still a literal in the payload on the 5arz side. Confirmed live on
    // 12 Sep: liveness:true came back next to sybil_checked:false.
    const out = await verify(await sign(good({ liveness: true })));
    assert.equal(out.liveness_claimed, true);
    assert.equal('liveness' in out, false, 'a bare `liveness` would read as measured');
  });

  test('`verified` is a bare literal too, and is renamed for the same reason', async () => {
    // 5arz's own 4 Sep audit lists both liveness and verified as written-in
    // literals rather than computed. Only liveness was handled before.
    const out = await verify(await sign(good({ verified: true })));
    assert.equal(out.verified_claimed, true);
    assert.equal('verified' in out, false, 'a bare `verified` would read as measured');
  });

  test('sybil_checked is never surfaced as a pass', async () => {
    const out = await verify(await sign(good({ sybil_checked: false })));
    assert.equal(out.sybil_checked_claimed, false);
    assert.equal('sybil_checked' in out, false);
  });

  test('method and assurance come through as 5arz sent them', async () => {
    const out = await verify(await sign(good()));
    assert.equal(out.method, 'stripe_identity+bio_bridge');
    assert.equal(out.assurance, 'direct_document_liveness');
  });
});

describe('env — the third sandbox marker', () => {
  test('env:test is refused (this is what a live sandbox credential carries)', async () => {
    const out = await verify(await sign(good({ env: 'test' })));
    assert.equal(out.ok, false);
    assert.equal(out.sandbox, true);
    assert.match(out.why, /not production/);
  });

  test('env:sample is refused (what the public sample carries)', async () => {
    assert.equal((await verify(await sign(good({ env: 'sample' })))).ok, false);
  });

  test('env:production passes', async () => {
    assert.equal((await verify(await sign(good({ env: 'production' })))).ok, true);
  });

  test('env ABSENT passes — we have never seen a live credential', async () => {
    // Requiring env outright would be fail-closed in the wrong place: if a real
    // credential simply omits the field, no host on NUM could ever verify, and
    // the failure would look like 5arz being broken. test/sample are the gates
    // that decide; env only adds a rejection when it is present and wrong.
    assert.equal('env' in good(), false);
    assert.equal((await verify(await sign(good()))).ok, true);
  });
});

describe('time and reachability', () => {
  test('an expired credential is refused', async () => {
    assert.equal((await verify(await sign(good({ exp: nowS - 3600 })))).ok, false);
  });

  test('one not yet valid is refused', async () => {
    assert.equal((await verify(await sign(good({ nbf: nowS + 3600 })))).ok, false);
  });

  test('a couple of minutes of clock drift is forgiven', async () => {
    assert.equal((await verify(await sign(good({ exp: nowS - 30 })))).ok, true);
  });

  test('a key set we cannot reach is a NO, and says it is worth retrying', async () => {
    // "Cannot verify" is never "verified".
    const out = await verifyPersonhood(await sign(good()), {
      fetchImpl: async () => ({ ok: false, status: 503 }), now: NOW,
    });
    assert.equal(out.ok, false);
    assert.equal(out.retryable, true);
  });

  test('rubbish in is a reason, not a throw', async () => {
    for (const t of ['', 'not.a.jwt', 'a.b', null, undefined, 'x.y.z']) {
      const out = await verify(t);
      assert.equal(out.ok, false);
      assert.ok(out.why);
    }
  });
});

describe('calling 5arz', () => {
  const env = { FIVEARZ_API_KEY: 'k_test' };

  test('minting sends the bearer key and the member id', async () => {
    let seen = null;
    await mintPersonhood(env, 'm_priya', async (url, o) => {
      seen = { url, ...o }; return { ok: true, json: async () => ({ credential: 'jwt' }) };
    });
    assert.match(seen.url, /api\.5arz\.com\/api\/agents\/verify-personhood$/);
    assert.equal(seen.headers.authorization, 'Bearer k_test');
    assert.deepEqual(JSON.parse(seen.body), { memberId: 'm_priya' });
  });

  test('the credential is read from pop_jwt — the field live 5arz actually returns', async () => {
    // Proven against production on 12 Sep. The old chain was
    // credential/jwt/token and the handoff documented jwt/pohf_jwt; BOTH were
    // wrong. Reading the wrong field gave credential:null with ok:true — a
    // silent pass with nothing to verify, which is the worst failure available
    // here.
    const out = await mintPersonhood(env, 'mem_x', async () => ({
      ok: true,
      json: async () => ({
        ok: true, testMode: true, attestationId: 'pop_ir21epfgc0mz',
        pop_jwt: 'eyJ.the.one', credential_type: 'Proof-of-Personhood',
      }),
    }));
    assert.equal(out.ok, true, out.why);
    assert.equal(out.credential, 'eyJ.the.one');
    assert.equal(out.attestation_id, 'pop_ir21epfgc0mz');
    assert.equal(out.test_mode, true);
  });

  test('a 200 with no credential field we know is a refusal, not ok:true and null', async () => {
    const out = await mintPersonhood(env, 'mem_x', async () => ({
      ok: true, json: async () => ({ ok: true, somethingNew: 'eyJ...' }),
    }));
    assert.equal(out.ok, false);
    assert.match(out.why, /no credential field/);
  });

  test('no key configured is a stated refusal, not a crash', async () => {
    assert.equal((await mintPersonhood({}, 'm_priya')).ok, false);
    assert.equal((await bindTransaction({}, { paymentRef: 'p' })).ok, false);
  });

  test('a binding always names a payment and a person', async () => {
    assert.equal((await bindTransaction(env, { memberId: 'm' })).ok, false);
    assert.equal((await bindTransaction(env, { paymentRef: 'p' })).ok, false);
  });

  test('a binding NEVER sends test:true from production code', async () => {
    // A binding marked test looks real in our database and is not one in
    // theirs — the worst of both records.
    let body = null;
    await bindTransaction(env, { paymentRef: 'pi_1', memberId: 'm_priya', workRef: 'job_1', test: true },
      async (url, o) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({}) }; });
    assert.equal('test' in body, false);
    assert.equal(body.paymentRef, 'pi_1');
    assert.equal(body.workRef, 'job_1');
  });
});
