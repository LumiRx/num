import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sms, email, page, smsSafe, textNumberDisplay, BANNED } from './esimcopy.mjs';

const PLANS = [
  { dataMb: 3072, days: 7, priceCs: 249 },
  { dataMb: 10240, days: 30, priceCs: 499 },
  { dataMb: 20480, days: 30, priceCs: 849 },
];
const ORDER = { dest_label: 'Curaçao', plan_label: '10 GB · 30 days', price_cs: 499, paid_cs: 499 };
const URL = 'https://app.itsnum.com/esim/o/AbCdEfGhIjKlMnOpQrStUvWx';

function allTexts() {
  return [
    sms.askDestination(), sms.ambiguous(['Canada', 'Seychelles']), sms.noPlans('Nauru'), sms.menu('Thailand', PLANS),
    sms.payLink(ORDER, URL), sms.ready(ORDER, URL), sms.refunded(ORDER), sms.paused(), sms.tooMany(),
  ];
}

test('every text is plain GSM-7 ASCII', () => {
  for (const t of allTexts()) assert.match(t, /^[\x20-\x7E\n]+$/, t);
});

test('texts that start a conversation carry STOP', () => {
  assert.match(sms.askDestination(), /STOP/);
  assert.match(sms.menu('Thailand', PLANS), /STOP/);
  assert.match(sms.ready(ORDER, URL), /STOP/);
});

test('every text is branded', () => {
  for (const t of allTexts()) assert.match(t, /^Num:/);
});

test('the menu shows the real prices, numbered', () => {
  const m = sms.menu('Thailand', PLANS);
  assert.match(m, /1\) 3GB, 7 days \$2\.49/);
  assert.match(m, /3\) 20GB, 30 days \$8\.49/);
  assert.match(m, /Reply 1, 2 or 3/);
  assert.match(m, /data only/);
  assert.match(sms.menu('Japan', PLANS.slice(0, 2)), /Reply 1 or 2\./);
});

test('the menu fits in two SMS segments', () => {
  assert.ok(sms.menu('Bosnia and Herzegovina', PLANS).length <= 306);
});

test('accents and dots are made SMS-safe', () => {
  assert.equal(smsSafe('Curaçao · Réunion'), 'Curacao - Reunion');
  assert.match(sms.payLink(ORDER, URL), /Curacao eSIM, 10 GB - 30 days, \$4\.99/);
});

test('no claim we cannot check, anywhere', () => {
  const words = [...allTexts(), email.ready(ORDER, URL).text, email.refunded(ORDER).text, ...Object.values(page).flatMap((v) => (typeof v === 'function' ? [v({})] : Array.isArray(v) ? v : [v]))];
  for (const w of words) assert.doesNotMatch(w, BANNED, w);
});

test('data-only is said out loud', () => {
  assert.match(page.dataOnly, /data-only/i);
  assert.match(email.ready(ORDER, URL).text, /data-only/i);
});

test('consent lines carry the required parts and are never a condition', () => {
  assert.match(page.smsConsent, /STOP/);
  assert.match(page.marketingConsent, /STOP/);
  assert.match(page.marketingConsent, /HELP/);
  assert.match(page.marketingConsent, /Not required to buy/);
});

test('number display', () => {
  assert.equal(textNumberDisplay({ TWILIO_FROM: '+14243460888' }), '+1 (424) 346-0888');
  assert.equal(textNumberDisplay({ ESIM_TEXT_NUMBER: '+447700900123' }), '+447700900123');
});

test('the delivery text only promises text answers when the concierge really answers texts', () => {
  assert.match(sms.ready(ORDER, URL), /Ask Num at app\.itsnum\.com/);
  assert.doesNotMatch(sms.ready(ORDER, URL), /Just text me/);
  assert.match(sms.ready(ORDER, URL, { textConcierge: true }), /Just text me/);
  assert.match(email.ready(ORDER, URL).text, /app\.itsnum\.com/);
});

test('the refund promise on every page is one the code keeps', () => {
  // Clear failures refund themselves in seconds, but an unclear one (supplier
  // silent for an hour) goes to "attention" for a person. So the footer may
  // promise a full refund, never an automatic one.
  assert.doesNotMatch(page.refundLine, /automatic/i);
  assert.match(page.refundLine, /refund you in full/);
});
