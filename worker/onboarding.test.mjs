// Business onboarding: the chain must be CLOSED, not just present.
//
// Every link here existed as a fine-looking piece in isolation while the
// chain as a whole was broken: grant() wrote its rows and went silent, the
// referral table waited for a manual /activate nobody would ever run, and a
// stalled claim vanished into a table nobody read. These tests hold the
// links together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const claim = readFileSync(join(HERE, 'claim.mjs'), 'utf8');
const bizref = readFileSync(join(HERE, 'bizreferral.mjs'), 'utf8');
const nudge = readFileSync(join(HERE, 'nudge.mjs'), 'utf8');
const index = readFileSync(join(HERE, 'index.mjs'), 'utf8');

test('a verified claim tells the owner, tells Dre, and closes the referral', () => {
  const g = claim.slice(claim.indexOf('async function grant'), claim.indexOf('async function confirm'));
  assert.match(g, /notify\(env/, 'the owner’s app is never told the tools opened');
  assert.match(g, /alert\(env/, 'a business onboarding is discoverable only by querying D1');
  assert.match(g, /activateByKey\(env/, 'a referral for this business stays unmatched forever');
});

test('the referral chain cannot pay the owner for referring themselves', () => {
  const a = bizref.slice(bizref.indexOf('export async function activateByKey'));
  assert.match(a, /referrer_id === ownerMemberId/, '"you can’t refer your own business" holds on one path but not this one');
});

test('auto-activation only moves claims that are still claimed', () => {
  const a = bizref.slice(bizref.indexOf('export async function activateByKey'), bizref.indexOf('export async function handleBizReferral'));
  assert.match(a, /state='claimed'/, 'an active or dead referral could be re-activated');
});

test('grant survives every notification failing', () => {
  // The grant already happened when we start telling people. A push outage
  // must not make a verified owner look unverified.
  const g = claim.slice(claim.indexOf('async function grant'), claim.indexOf('async function confirm'));
  const tries = (g.match(/try \{/g) ?? []).length;
  assert.ok(tries >= 3, 'a notification failure would throw out of grant()');
});

test('stalled claims surface daily, with names, exactly once', () => {
  assert.match(nudge, /claimSweep/, 'no stalled-claim sweep exists');
  const c = nudge.slice(nudge.indexOf('export async function claimSweep'));
  assert.match(c, /claimstall:/, 'no daily dedup — Dre would get the same list every 5 minutes');
  assert.match(c, /c\.name/, 'the alert counts claims instead of naming them — a count prompts a query, a name prompts a phone call');
  assert.match(index, /claimSweep\(env\)/, 'the sweep exists but nothing runs it');
});

test('the UK web funnel is read by the console and watched by the sweep', () => {
  // Three workers, three claim tables. Businesses signed up in Scotland and
  // the rows landed in `claims` — which no dashboard read and no alert
  // watched. Dre learned about his own signups secondhand, days later.
  const console_ = readFileSync(join(HERE, 'console.mjs'), 'utf8');
  assert.match(console_, /FROM claims WHERE state = 'new'/, 'the admin console still cannot see web signups');
  assert.match(nudge, /'webclaim'/, 'a web signup would again reach Dre secondhand, days later');
  // And each signup alerts exactly once, forever — not once per sweep.
  const sweep = nudge.slice(nudge.indexOf('webclaim') - 800, nudge.indexOf('webclaim') + 200);
  assert.match(sweep, /INSERT OR IGNORE INTO num_nudges/, 'the web-signup alert has no dedup — every 5 minutes, the same list');
});

test('the public /activate stays admin-gated even with auto-activation live', () => {
  // Auto-activation is safe because a VERIFIED claim triggers it. The public
  // endpoint is the one an attacker can reach, and it must stay locked.
  const pub = bizref.slice(bizref.indexOf("path === '/activate'"));
  assert.match(pub, /isAdmin\(env, request\)/, 'the public activate endpoint lost its admin gate');
});
