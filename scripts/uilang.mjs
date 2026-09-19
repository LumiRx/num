// The app in another language, seen: open the sign-in sheet, pick a language
// on its first screen, and screenshot what a reader of that language gets —
// the sheet itself, then TODAY, then PLAN. Also counts what is still English.
// Usage: PW_CHROME=… node scripts/uilang.mjs <base> <outdir> [lang=th]
/* global document */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const [base, outdir, lang = 'th'] = process.argv.slice(2);
if (!base || !outdir) { console.error('usage: node scripts/uilang.mjs <base> <outdir> [lang]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });

const NAMES = { th: 'ไทย', zh: '中文', ja: '日本語', ko: '한국어', es: 'Español', fr: 'Français', de: 'Deutsch', ar: 'العربية', mn: 'Монгол' };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'en-GB' });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(base + '/?app', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
// The sign-in door sits in the header when there is no account.
await page.getByLabel('Sign in').last().click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${outdir}/01-signin-en.png` });

await page.getByRole('radio', { name: NAMES[lang] }).click();
// The catalogue map: cached → network → possibly a second ask 20 s later.
await page.waitForTimeout(6_000);
await page.screenshot({ path: `${outdir}/02-signin-${lang}.png` });

// What is still English on the sheet?
const census = async (label) => {
  const texts = await page.evaluate(() => {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { const s = c.textContent.trim(); if (s.length > 1) out.push(s); }
        else if (c.nodeType === 1 && !['SCRIPT', 'STYLE'].includes(c.tagName)) walk(c);
      }
    };
    walk(document.body);
    return out;
  });
  const latin = texts.filter((s) => /[A-Za-z]{3,}/.test(s) && !/^[A-Z0-9 .:+★$€£฿·—–-]+$/.test(s) && !/^(NUM|Num|5arz|LINE|WhatsApp|OK|Google|Apple|@|https?:)/.test(s));
  console.log(`${label}: ${texts.length} text nodes, ${latin.length} with Latin words`);
  for (const s of latin.slice(0, 40)) console.log('   EN?  ' + s.slice(0, 100));
  return latin;
};
const still = { sheet: await census('sheet') };

// Close the sheet and the thread overlay the app opens on, look at TODAY and PLAN.
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await page.screenshot({ path: `${outdir}/03-thread-${lang}.png` });
const closeThread = page.locator('[role="dialog"] .glass.press').filter({ has: page.locator('svg') }).last();
if (await closeThread.count()) await closeThread.click().catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: `${outdir}/04-today-${lang}.png` });
still.today = await census('today');
const plan = page.getByRole('tab', { name: /plan|แผน|プラン|计划|계획|planes|plans|pläne|خطط|төлөвлөгөө/i }).first();
if (await plan.count()) { await plan.click(); await page.waitForTimeout(1200); await page.screenshot({ path: `${outdir}/05-plan-${lang}.png` }); still.plan = await census('plan'); }

writeFileSync(`${outdir}/census-${lang}.json`, JSON.stringify(still, null, 1));
console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'no page errors');
await browser.close();
