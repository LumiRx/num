import { mint, verify, identify, epochFor, EPOCH_MS } from './capability.mjs';
const env = { NUM_ROOT_KEY: 'test-root-secret-32-bytes-minimum-ok' };
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const social = await mint(env, { sub: 'mem_abc', compartment: 'social', scope: ['plan:write'] });
t('mints', social.startsWith('v1.social.'));
t('verifies in own compartment', (await verify(env, social, 'social')).ok);
t('sub round-trips', (await verify(env, social, 'social')).sub === 'mem_abc');

// THE core property
const cross = await verify(env, social, 'money');
t('social token REJECTED by money', !cross.ok && cross.reason === 'wrong_compartment');

// relabel attack: attacker rewrites the compartment field
const relabel = social.replace('v1.social.', 'v1.money.');
t('relabel to money forged -> bad_signature', (await verify(env, relabel, 'money')).reason === 'bad_signature');

// payload tamper: escalate scope
const p = social.split('.');
p[3] = Buffer.from(JSON.stringify({sub:'mem_VICTIM',scope:['admin:all'],me:0,exp:2**31,jti:'x'})).toString('base64url');
t('payload tamper -> bad_signature', (await verify(env, p.join('.'), 'social')).reason === 'bad_signature');

// different root = different key
t('other root cannot verify', !(await verify({NUM_ROOT_KEY:'a-completely-different-root-secret'}, social, 'social')).ok);

// expiry (money = 15m)
const money = await mint(env, { sub: 'mem_abc', compartment: 'money' });
t('money valid now', (await verify(env, money, 'money')).ok);
t('money expired at +16m', (await verify(env, money, 'money', { now: Date.now() + 16*60*1000 })).reason === 'expired');

// rotation
// Mint 1h BEFORE a rotation boundary, verify 1h AFTER it: different epoch,
// still inside the 24h TTL. This is the real rollover case — without the
// grace window every member is logged out at midnight on rotation day.
const boundary = (epochFor(Date.now()) + 1) * EPOCH_MS;
const tok = await mint(env, { sub: 'm', compartment: 'social' }, boundary - 3600_000);
t('minted pre-boundary, epoch N', tok.split('.')[2] === String(epochFor(boundary - 3600_000)));
t('prev-epoch grace accepted across rollover', (await verify(env, tok, 'social', { now: boundary + 3600_000 })).ok);
const old = await mint(env, { sub: 'm', compartment: 'social' }, boundary - 3600_000 - EPOCH_MS);
t('two epochs on -> stale_epoch', (await verify(env, old, 'social', { now: boundary + 3600_000 })).reason === 'stale_epoch');
t('epoch advances', epochFor(boundary) === epochFor(boundary - EPOCH_MS) + 1);

// per-member revocation
t('revoked when memberEpoch bumped', (await verify(env, social, 'social', { memberEpoch: 1 })).reason === 'revoked');
const reissued = await mint(env, { sub: 'mem_abc', compartment: 'social', memberEpoch: 1 });
t('reissued after revoke works', (await verify(env, reissued, 'social', { memberEpoch: 1 })).ok);

// junk
for (const junk of ['', 'x', 'v1.social.1.a', 'a.b.c.d.e', 'v2.social.1.a.b'])
  t(`junk rejected: ${JSON.stringify(junk)}`, !(await verify(env, junk, 'social')).ok);

// identify() bridge
const req = (h={}, u='https://app.itsnum.com/api/social/plans') => new Request(u, { headers: h });
const leg = await identify(env, req({}, 'https://app.itsnum.com/x?me=mem_legacy'), 'social');
t('legacy flagged', leg.sub === 'mem_legacy' && leg.legacy === true);
const good = await identify(env, req({ Authorization: `Bearer ${social}` }), 'social');
t('bearer accepted, not legacy', good.sub === 'mem_abc' && good.legacy === false);
const forged = await identify(env, new Request('https://app.itsnum.com/x?me=mem_victim', { headers: { Authorization: 'Bearer garbage' } }), 'social');
t('bad token does NOT fall back to ?me=', forged.sub === null);
const closed = await identify(env, req({}, 'https://app.itsnum.com/x?me=m'), 'money', { allowLegacy: false });
t('allowLegacy:false closes the door', closed.sub === null && closed.reason === 'token_required');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
