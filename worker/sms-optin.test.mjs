// Consent you cannot prove is consent you do not have.
//
// The /sms/ opt-in page was published, linked from the A2P campaign, and
// looked completely functional. Its form posted to /api/sms-optin — an
// endpoint that existed nowhere. Every submission returned HTTP 405 and not a
// single consent record was ever written. A carrier or TCR audit asks exactly
// one question ("show us the consent") and the honest answer would have been
// that we had none, for anyone, ever.
//
// These tests pin the properties that make that failure impossible to repeat,
// and — more importantly — keep the STORED record honest about what the person
// was actually shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const worker = readFileSync(join(ROOT, 'growth', 'worker.js'), 'utf8');
const wrangler = readFileSync(join(ROOT, 'growth', 'wrangler.jsonc'), 'utf8');
const page = readFileSync(join(ROOT, 'public', 'sms', 'index.html'), 'utf8');

/** The consent sentence exactly as a visitor reads it, tags and spacing gone. */
function labelAsRendered(html) {
  const m = html.match(/<label for="sms_consent">([\s\S]*?)<\/label>/);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

test('the form posts somewhere that is actually routed', () => {
  // THE bug. The page and the endpoint were deployed by different Workers and
  // nobody checked that the path the form names is a path anything answers.
  const action = page.match(/<form[^>]*action="([^"]+)"/)?.[1];
  assert.ok(action, 'the opt-in form has no action at all');
  const path = action.replace(/^https?:\/\/[^/]+/, '');
  assert.ok(
    wrangler.includes(`itsnum.com${path}`),
    `the form posts to ${path} but no route in growth/wrangler.jsonc claims it — submissions will hit the static asset worker and 405, exactly as they did before`,
  );
  assert.match(worker, new RegExp(`p === "${path}"`),
    `${path} is routed at the edge but the Worker has no handler for it`);
});

test('the stored consent text is the text the page actually shows', () => {
  // The whole evidentiary value of the record is that it describes what was on
  // screen. If the page copy drifts from the stored constant, every record
  // written afterwards misrepresents what the person agreed to — and it does
  // so silently, which is the worst kind of wrong.
  const stored = worker.match(/const SMS_CONSENT_TEXT =([\s\S]*?);\n/)?.[1] ?? '';
  const storedText = [...stored.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('').replace(/\s+/g, ' ').trim();
  const shown = labelAsRendered(page);
  assert.ok(storedText.length > 40, 'no server-side consent text found');
  assert.equal(storedText, shown,
    'the consent text stored in the record no longer matches the words on /sms/ — bump SMS_CONSENT_VERSION and update the constant');
});

test('consent language is never taken from the request body', () => {
  // Anything can POST here and claim any wording. A record built from
  // attacker-supplied text proves nothing, so the constant must be the only
  // source.
  const fn = worker.slice(worker.indexOf('async function smsOptin'), worker.indexOf('/* -------------------------------------------------- /api/capture'));
  assert.match(fn, /SMS_CONSENT_TEXT/, 'the handler does not store the server-side consent text');
  assert.ok(!/form\.get\(\s*["']consent_text["']\s*\)/.test(fn),
    'consent wording is read from the request — a client could assert it agreed to anything');
});

test('no tick, no record', () => {
  const fn = worker.slice(worker.indexOf('async function smsOptin'), worker.indexOf('/* -------------------------------------------------- /api/capture'));
  assert.match(fn, /sms_consent/, 'the handler never checks the consent checkbox');
  assert.match(fn, /consent_required/,
    'a submission without consent is not rejected — the browser `required` attribute is trivially bypassed and is not the check that matters');
});

test('the endpoint reads a form, so the page works without JavaScript', () => {
  // A compliance page a reviewer cannot complete with JS disabled is a
  // compliance page that can fail a review for a reason nobody can see.
  const fn = worker.slice(worker.indexOf('async function smsOptin'), worker.indexOf('/* -------------------------------------------------- /api/capture'));
  assert.match(fn, /req\.formData\(\)/,
    'the handler expects JSON, but /sms/ is a plain HTML form — submissions from a JS-disabled browser would fail');
  assert.match(page, /<form[^>]*method="post"/i, 'the page no longer submits as a real form');
});

test('the record keeps the evidence a carrier asks for', () => {
  // Phone, the wording, when, and from where. Missing any one of these turns
  // "here is the consent" into "here is a phone number we have".
  const schema = worker.slice(worker.indexOf('CREATE TABLE IF NOT EXISTS num_sms_consent'), worker.indexOf('CREATE INDEX IF NOT EXISTS idx_num_sms_consent'));
  for (const col of ['phone', 'consent_text', 'consent_version', 'ip', 'created_at']) {
    assert.match(schema, new RegExp(`\\b${col}\\b`), `the consent record has no ${col} — that is evidence an audit expects`);
  }
  assert.match(schema, /revoked_at/, 'no way to record a STOP — an opt-out that leaves no trace is not an opt-out');
});

test('the page does not claim a text was sent while sending is blocked', () => {
  // A2P is unapproved, so Twilio rejects every send. Telling somebody to check
  // a phone that will never ring is a small lie that a reviewer opting in
  // would experience directly.
  const done = page.match(/<div class="done"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.ok(!/just sent/i.test(done),
    'the confirmation still says a message was sent — nothing is sent until A2P clears');
  assert.match(done, /STOP/,
    'the confirmation drops the STOP disclosure');
});
