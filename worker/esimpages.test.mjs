import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHome, renderCountry, renderAirport, renderOrder, renderSitemap, renderMessage, esc, smsHref } from './esimpages.mjs';
import { airport, airportsIn } from './esimplaces.mjs';
import { BANNED } from './esimcopy.mjs';

const ENV = { TWILIO_FROM: '+14243460888' };
const PLANS = [
  { provider: 'esimaccess', code: 'TH3', dataMb: 3072, days: 7, priceCs: 249, scope: 'local', countries: ['TH'], networks: ['AIS 5G'] },
  { provider: 'esimaccess', code: 'ASIA', dataMb: 10240, days: 30, priceCs: 999, scope: 'regional', countries: ['TH', 'VN', 'MY'], networks: [] },
];
const READY = { token: 'tok_abcdefghijklmnopqrstuv', state: 'ready', dest_label: 'Thailand', plan_label: '10 GB · 30 days', price_cs: 499, lpa: 'LPA:1$rsp.redtea.io$ABC-123', qr_url: 'https://p.qrsim.net/x.png', country: 'TH', email: 'a@b.co', phone: null };

// What a link preview or a search result shows: title and meta description.
function head(html) {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const desc = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
  return `${title} ${desc}`;
}

test('no price, rate or currency figure in any head', () => {
  const pages = [
    renderHome({ env: ENV, countries: [{ country: 'TH', from_cs: 249 }] }),
    renderCountry({ env: ENV, code: 'TH', plans: PLANS }),
    renderAirport({ env: ENV, airport: airport('BKK'), plans: PLANS }),
    renderOrder({ env: ENV, order: READY }),
  ];
  for (const p of pages) assert.doesNotMatch(head(p), /\$\s?\d|\d+\s?(usd|%)|price/i);
});

test('no claim we cannot check, on any page', () => {
  const pages = [renderHome({ env: ENV, countries: [{ country: 'TH', from_cs: 249 }] }), renderCountry({ env: ENV, code: 'TH', plans: PLANS }), renderAirport({ env: ENV, airport: airport('BKK'), plans: PLANS })];
  for (const p of pages) assert.doesNotMatch(p.replace(/<[^>]+>/g, ' '), BANNED);
});

test('country page posts a server-side quote with the plan id, never a price', () => {
  const html = renderCountry({ env: ENV, code: 'TH', plans: PLANS });
  assert.match(html, /action="\/api\/esim\/quote" method="post"/);
  assert.match(html, /name="plan" value="esimaccess:TH3" checked/);
  assert.doesNotMatch(html, /name="price"/);
  assert.match(html, /\$2\.49/);
  assert.match(html, /Works in 3 countries/);
  assert.match(html, /href="sms:\+14243460888\?&amp;body=ESIM%20THAILAND"/);
  assert.match(html, /\/esim\/airport\/bkk/);
});

test('consent boxes are never pre-ticked and carry their words', () => {
  const html = renderCountry({ env: ENV, code: 'TH', plans: PLANS });
  assert.doesNotMatch(html, /name="sms_ok" value="1" checked/);
  assert.doesNotMatch(html, /name="marketing_ok" value="1" checked/);
  assert.match(html, /Not required to buy/);
});

test('airport pages: big airports indexed, the rest reachable but not indexed', () => {
  assert.match(renderAirport({ env: ENV, airport: airport('BKK'), plans: PLANS }), /content="index,follow"/);
  const small = airportsIn('TH').find((a) => a[4] !== 'L');
  assert.match(renderAirport({ env: ENV, airport: small, plans: PLANS }), /noindex/);
  assert.match(renderAirport({ env: ENV, airport: airport('BKK'), plans: PLANS }), /name="airport" value="BKK"/);
});

test('the ready page gives a one-tap iPhone install, a QR and manual codes, and is private', () => {
  const html = renderOrder({ env: ENV, order: READY });
  assert.match(html, /href="https:\/\/esimsetup\.apple\.com\/esim_qrcode_provisioning\?carddata=LPA:1\$rsp\.redtea\.io\$ABC-123"/);
  assert.match(html, /src="https:\/\/p\.qrsim\.net\/x\.png"/);
  assert.match(html, /Activation code: ABC-123/);
  assert.match(html, /noindex,nofollow/);
  assert.match(html, /name="referrer" content="no-referrer"/);
});

test('the paying and preparing states', () => {
  assert.match(renderOrder({ env: ENV, order: { ...READY, state: 'checkout' } }), /href="\/esim\/pay\/tok_abcdefghijklmnopqrstuv"/);
  const prep = renderOrder({ env: ENV, order: { ...READY, state: 'ordering' } });
  assert.match(prep, /http-equiv="refresh" content="4"/);
  assert.doesNotMatch(prep, /Activation code/);
  assert.match(renderOrder({ env: ENV, order: { ...READY, state: 'refunded', paid_cs: 499 } }), /refunded the full \$4\.99/);
});

test('the concierge text line only appears when text answers are switched on', () => {
  assert.doesNotMatch(renderOrder({ env: ENV, order: READY }), /Or text/);
  assert.match(renderOrder({ env: ENV, order: READY, concierge: { sms: true } }), /Or text/);
});

test('escaping', () => {
  assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  const html = renderOrder({ env: ENV, order: { ...READY, dest_label: '<script>x</script>' } });
  assert.doesNotMatch(html, /<script>x<\/script>/);
});

test('sms link only for a real number', () => {
  assert.equal(smsHref({}), null);
  assert.equal(smsHref({ TWILIO_FROM: '+14243460888' }, 'ESIM BKK'), 'sms:+14243460888?&body=ESIM%20BKK');
});

test('sitemap and message page', () => {
  const xml = renderSitemap({ origin: 'https://app.itsnum.com', countries: ['TH'], airports: ['BKK'] });
  assert.match(xml, /<loc>https:\/\/app\.itsnum\.com\/esim\/airport\/bkk<\/loc>/);
  assert.equal(renderMessage({ title: 'Not found', body: 'x', status: 404 }).status, 404);
});

test('a page with nothing to sell is never put in the search index', () => {
  assert.match(renderCountry({ env: ENV, code: 'NR', plans: [] }), /noindex/);
  assert.match(renderAirport({ env: ENV, airport: airport('BKK'), plans: [] }), /noindex/);
  assert.match(renderCountry({ env: ENV, code: 'TH', plans: PLANS }), /content="index,follow"/);
});

test('the airport page only promises text answers when the concierge answers texts', () => {
  assert.match(renderAirport({ env: ENV, airport: airport('BKK'), plans: PLANS }), /in the app at app\.itsnum\.com/);
  assert.match(renderAirport({ env: { ...ENV, SMS_CONCIERGE: 'on' }, airport: airport('BKK'), plans: PLANS }), /Text Num if anything is not working/);
});

test('the install page says "Or type" only when there is a QR code above it', () => {
  assert.match(renderOrder({ env: ENV, order: READY }), /Or type these in by hand/);
  const noQr = renderOrder({ env: ENV, order: { ...READY, qr_url: null } });
  assert.match(noQr, /Type these in by hand/);
  assert.doesNotMatch(noQr, /Or type these in by hand/);
  assert.doesNotMatch(noQr, /Scan this from the phone/);
});
