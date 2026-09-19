#!/usr/bin/env node
/**
 * Phone screenshots for the Play listing.
 *
 *   node scripts/play-screenshots.mjs [baseUrl]
 *
 * Play requires at least two phone screenshots and will not publish a listing
 * without them. The Android app bundles the same dist/ the web app serves, so a
 * capture of app.itsnum.com at a phone viewport IS the app, not a mockup.
 *
 * ── WHAT THIS CAN AND CANNOT DO (19 Sep 2026) ─────────────────────────────
 *
 * It captures the opening screen, and that one is good.
 *
 * It CANNOT yet reach TODAY / PLAN / MEMORY. Synthetic clicks on those tabs
 * time out in a 412px headless viewport — Playwright finds the text, then
 * cannot click it, and `document.elementFromPoint` finds no leaf element whose
 * text is exactly "TODAY", so the label is nested somewhere the locator is not
 * resolving to a hit target. Whether that is a headless artefact or something a
 * thumb would also hit is NOT established here, and given that three App Store
 * rejections came from a control that rendered but was not hittable, it is
 * worth ten seconds on a real phone before it is assumed harmless.
 *
 * Two dead ends recorded so it is not rediscovered:
 *   · `?tab=today` and friends do nothing. The app holds its tab in state, not
 *     in the query string. Four URLs produced four captures of one screen.
 *   · Neither `body.innerText` nor an image hash detects that. The text is
 *     identical on every tab because every panel stays in the DOM, and the
 *     hashes differ even with nothing changed because live place data shifts
 *     between captures. The check that works is the CLICK RESULT — if the click
 *     timed out, the screen did not change, whatever the file says.
 *
 * Writes 1030x2288 PNGs (412x915 at DPR 2.5) to android/play/screenshots/.
 */
import pw from '/opt/homebrew/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'https://app.itsnum.com';
const OUT = 'android/play/screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.5,
  isMobile: true,
  hasTouch: true,
  locale: 'en-US',
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
});
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/01-home-1030x2288.png` });
console.log('  ✓ 01-home');

// Each tab is attempted, and a failure is REPORTED rather than leaving a file
// that looks like a second screen and is not one.
for (const [n, tab] of [['02', 'TODAY'], ['03', 'PLAN'], ['04', 'MEMORY']]) {
  const el = page.getByText(tab, { exact: true }).first();
  if (!(await el.count())) { console.log(`  ✘ ${tab}: not on screen`); continue; }
  try {
    await el.click({ timeout: 8000 });
  } catch {
    console.log(`  ✘ ${tab}: click timed out — NOT captured (see header)`);
    continue;
  }
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/${n}-${tab.toLowerCase()}-1030x2288.png` });
  console.log(`  ✓ ${n}-${tab.toLowerCase()}`);
}

await browser.close();
console.log(`\nwritten to ${OUT}/`);
