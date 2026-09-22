// Scanning a friend's code must end with them in your friends list.
//
// 21 Sep 2026: "I scanned another user's QR code, it took me into the chat,
// and it never added them as a friend." Three separate leaks, one per test
// group below: the app never heard the link that opened it, a signed-in
// browser refused to act, and anything not finished at once was forgotten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const { savePendingLink, readPendingLink, clearPendingLink, linkParams } = await import('./pendinglink.ts');

const code = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');
const social = code('./social.ts');
const app = code('../components/app/ConciergeApp.tsx');
const native = code('./native.ts');

/* ── the link that opened the app ───────────────────────────────────────── */

test('a universal link in either shape gives the same answer', () => {
  assert.deepEqual(linkParams('https://app.itsnum.com/c/mem_abc123?ref=DRE1'), { c: 'mem_abc123', i: null, ref: 'DRE1' });
  assert.deepEqual(linkParams('https://app.itsnum.com/?c=mem_abc123'), { c: 'mem_abc123', i: null, ref: null });
  assert.deepEqual(linkParams('https://app.itsnum.com/i/tok_9'), { c: null, i: 'tok_9', ref: null });
  assert.deepEqual(linkParams('not a url'), { c: null, i: null, ref: null });
});

test('junk in the link is never carried forward', () => {
  assert.equal(linkParams('https://app.itsnum.com/?c=<script>').c, null);
});

test('the native app listens for the link that opened it, cold and warm', () => {
  assert.match(native, /getLaunchUrl\(\)/, 'a cold launch from a QR would be missed');
  assert.match(native, /addListener\('appUrlOpen'/, 'a link tapped while the app runs would be missed');
  assert.match(app, /listenForOpenedLinks\(handleOpenedLink\)/, 'nothing wires the listener into boot');
});

/* ── nothing is forgotten ───────────────────────────────────────────────── */

test('a scan is kept until it lands, then crossed off', () => {
  mem.clear();
  savePendingLink({ c: 'mem_friend' });
  assert.equal(readPendingLink()?.c, 'mem_friend');
  savePendingLink({ i: 'tok_1' });
  const both = readPendingLink();
  assert.equal(both?.c, 'mem_friend', 'a later invite must not wipe an earlier scan');
  assert.equal(both?.i, 'tok_1');
  clearPendingLink();
  assert.equal(readPendingLink(), null);
});

test('a month-old scan does not surprise anybody', () => {
  mem.clear();
  const then = Date.now() - 31 * 24 * 60 * 60 * 1000;
  savePendingLink({ c: 'mem_old' }, then);
  assert.equal(readPendingLink(), null);
});

test('the scan is written down before anything else can fail', () => {
  const boot = social.slice(social.indexOf('export function bootSocial'));
  assert.ok(boot.indexOf('savePendingLink') < boot.indexOf('pair/mint'),
    'the browser path returns early; the save has to come first');
  assert.match(boot, /readPendingLink\(\)/, 'a waiting scan is never picked back up');
});

test('every way into an account finishes the waiting friend add', () => {
  assert.match(social, /function watchForSignIn[\s\S]*?completePendingLinks\(\)/);
  const signUp = social.slice(social.indexOf('export async function signUp'));
  assert.match(signUp.slice(0, signUp.indexOf('resumeDm()')), /await completePendingLinks\(\)/);
  const adopt = social.slice(social.indexOf('function adoptMember'), social.indexOf('export async function signUp'));
  assert.match(adopt, /completePendingLinks\(\)/, 'recovery sign-in skips the friend add');
});

test('two callers in the same second make one friendship, not two', () => {
  assert.match(social, /if \(completing\) return completing;/);
});

/* ── a signed-in browser acts ───────────────────────────────────────────── */

test('the carry-across code is only for somebody with no account here', () => {
  assert.match(social, /!installed && \(connectTo \|\| token\) && !store\.get\(\)\.me/);
  assert.ok(!/pairCode: d\.code, connectTo: null/.test(social),
    'minting the carry code must not throw the friend add away');
});

test("a member's identity code also makes them a friend", () => {
  const done = social.slice(social.indexOf('export function completePendingLinks'));
  assert.match(done, /connected\?\.type === 'member'\) await connectByCode\(out\.connected\.id\)/);
});

/* ── home-screen web app (PWA) users ────────────────────────────────────── */
//
// Most people are on the PWA until the store app ships. On iPhone the camera
// can only open Safari, never the home-screen app, so the scan has to be
// possible from inside Num, and Safari has to finish the job in one tap.

const scan = code('./scan.ts');
const qrCard = code('../components/app/QrCard.tsx');
const profile = code('../components/app/ProfileView.tsx');
const pair = code('../components/app/PairBridge.tsx');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('the in-app scanner works on iPhone, not only where BarcodeDetector exists', () => {
  assert.ok(pkg.dependencies?.jsqr, 'no decoder for Safari');
  assert.match(scan, /await import\('jsqr'\)/, 'jsQR must load only when someone scans');
  assert.match(scan, /scanSupported = \(\): boolean => !!navigator\.mediaDevices\?\.getUserMedia;/);
});

test('a scan finishes through the same path as a link', () => {
  assert.match(scan, /store\.set\(\{ connectTo: id \}\);\s*await completePendingLinks\(\);/);
});

test('there is a button to scan, where your own code lives', () => {
  assert.match(qrCard, /tab === 'connect' && <ScanFriend \/>/);
});

test('the carry-across code has somewhere to go in the app', () => {
  assert.match(profile, /<PairBridge installed/, 'the code box lives in Profile via PairBridge');
});

test("Safari's first button finishes the add, it does not set homework", () => {
  const card = pair.slice(pair.indexOf('export function PairHandoff'), pair.indexOf('export function PairRedeem'));
  assert.ok(card.indexOf("inviteOpen: {}") > -1 && card.indexOf("inviteOpen: {}") < card.indexOf('{code}'),
    'confirming the number must come before the code');
});

test('Android home-screen app hears the link that focused it', () => {
  assert.match(native, /launchQueue/);
  assert.match(native, /setConsumer/);
  assert.match(app, /listenForLaunchedLinks\(handleOpenedLink\)/);
});

test('the Safari card shows inside the thread, where a link actually lands', () => {
  const thread = code('../components/app/ThreadView.tsx');
  assert.match(thread, /<PairHandoff \/>/, 'only the landing page had it, and the thread covers the landing page');
});
