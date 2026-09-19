// One real question to NUM, seen: the thread after the answer lands — the
// bubbles of one turn, the grid of places, the pictures filling in. Also
// checks the media endpoint for the picks that were shown.
// Usage: PW_CHROME=… node scripts/uianswer.mjs <base> <outdir> ["question"]
/* global document */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [base, outdir, q = 'where should we eat tonight in Bangkok, seafood, near Sukhumvit'] = process.argv.slice(2);
if (!base || !outdir) { console.error('usage: node scripts/uianswer.mjs <base> <outdir> [question]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'en-GB' });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const mediaCalls = [];
page.on('request', (r) => { if (r.url().includes('/api/places/media')) mediaCalls.push(r.url()); });
page.on('response', async (r) => {
  if (!r.url().includes('/api/num')) return;
  try {
    const txt = await r.text();
    const last = txt.trim().split('\n').pop();
    const j = JSON.parse(last);
    console.log('reply lane:', JSON.stringify(j.turn ?? null), 'picks:', (j.picks ?? []).length, 'dropped:', JSON.stringify(j.dropped ?? j.debug?.dropped ?? null));
    console.log('reply text:', String(j.reply ?? '').slice(0, 300).replace(/\n/g, ' ⏎ '));
  } catch (e) { console.log('reply unreadable', String(e).slice(0, 80)); }
});

// The send gate lets the marketing site's own ask box through (sendgate.mjs
// fromSite) — the same door itsnum.com uses, so the harness needs no account.
await page.setExtraHTTPHeaders({ Referer: 'https://itsnum.com/' });
await page.goto(base + '/?app', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.screenshot({ path: `${outdir}/00-open.png` });
const box = page.getByPlaceholder('Message NUM…');
await box.fill(q);
await page.keyboard.press('Enter');
// The answer: brain + grounding is usually 6–20 s; then the parts land 420 ms apart, then the media fill.
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const n = await page.evaluate(() => document.querySelectorAll('.msg-in').length);
  const typing = await page.evaluate(() => !!document.querySelector('[aria-label*="thinking" i], .thinking'));
  if (n >= 3 && !typing) break;
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outdir}/01-answer.png` });
await page.waitForTimeout(6000); // media fill
await page.screenshot({ path: `${outdir}/02-answer-media.png`, fullPage: false });

const census = await page.evaluate(() => {
  const bubbles = [...document.querySelectorAll('.msg-in')].map((b) => ({ text: b.textContent.trim().slice(0, 90), imgs: b.querySelectorAll('img').length }));
  const cards = document.querySelectorAll('[aria-expanded]').length;
  return { bubbles, cards };
});
console.log(JSON.stringify(census, null, 1));
console.log('media calls:', mediaCalls.length, mediaCalls[0] ?? '');
// Open the first card.
const first = page.locator('[aria-expanded]').first();
if (await first.count()) { await first.click(); await page.waitForTimeout(700); await page.screenshot({ path: `${outdir}/03-card-open.png` }); }
console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'no page errors');
await browser.close();
