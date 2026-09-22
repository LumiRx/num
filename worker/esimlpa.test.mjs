import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLpa, buildLpa, appleInstallUrl, manualCodes } from './esimlpa.mjs';

test('parses a supplier activation string', () => {
  const p = parseLpa('LPA:1$rsp.redtea.io$ABC-123_xyz');
  assert.deepEqual(p, { lpa: 'LPA:1$rsp.redtea.io$ABC-123_xyz', smdp: 'rsp.redtea.io', code: 'ABC-123_xyz' });
});

test('keeps the activation code case, lowercases nothing but the host', () => {
  assert.equal(parseLpa('lpa:1$RSP.Truphone.com$JQ-209U6H-6I82J5').code, 'JQ-209U6H-6I82J5');
  assert.equal(parseLpa('lpa:1$RSP.Truphone.com$JQ-209U6H-6I82J5').smdp, 'rsp.truphone.com');
});

test('refuses anything that is not an activation string', () => {
  for (const bad of [null, '', 'hello', 'LPA:1$$abc', 'LPA:1$notahost$abc', 'LPA:1$evil.com$a b', 'LPA:1$x.com$<script>', 42]) {
    assert.equal(parseLpa(bad), null, String(bad));
  }
});

test('Apple one-tap link uses the documented base, lowercase, with the code intact', () => {
  const url = appleInstallUrl('LPA:1$rsp.truphone.com$JQ-209U6H-6I82J5');
  assert.equal(url, 'https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=LPA:1$rsp.truphone.com$JQ-209U6H-6I82J5');
  assert.equal(appleInstallUrl('garbage'), null);
});

test('manual codes for Android', () => {
  assert.deepEqual(manualCodes('LPA:1$rsp.redtea.io$K1'), { smdp: 'rsp.redtea.io', activationCode: 'K1' });
});

test('buildLpa joins parts and validates them', () => {
  assert.equal(buildLpa('rsp.redtea.io', 'K1'), 'LPA:1$rsp.redtea.io$K1');
  assert.equal(buildLpa('bad host', 'K1'), null);
});
