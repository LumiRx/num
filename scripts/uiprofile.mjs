#!/usr/bin/env node
/* global localStorage, document, getComputedStyle -- run inside the browser */
// The signed-in Profile at iPhone size, with a fake member injected into the
// saved state so the page renders as a member sees it. Screenshots only.
// Run: node scripts/uiprofile.mjs [base] [outdir]
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] || 'https://app.itsnum.com';
const out = process.argv[3] || '/tmp/num-ui';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await browser.newContext({ ...devices['iPhone 14'], locale: 'en-GB' });
await ctx.addInitScript(() => {
  const me = { id: 'mem_preview', name: 'Dre', phone: '+14155550123', phone_verified: true, email: 'dre@example.com', email_verified: false, verified: true, avatar: null, stars: 5 };
  const saved = { me, onboarded: true, place: 'Bangkok', stars: 5, profileOpen: true, threadOpen: false, view: 'dash' };
  try { localStorage.setItem('num-trip-v1', JSON.stringify(saved)); } catch { /* fine */ }
});
const page = await ctx.newPage();
await page.goto(`${base}/?app`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
// Close the thread if it opened, then open profile via the avatar.
const x = page.locator('[aria-label="Close"]:visible, [aria-label="Close thread"]:visible').last();
if (await x.count()) await x.click({ force: true }).catch(() => {});
await page.waitForTimeout(400);
const avatar = page.locator('[aria-label="Your profile"]:visible').first();
console.log('avatar found', await avatar.count());
if (await avatar.count()) await avatar.click({ force: true }).catch((e) => console.log('click failed', String(e)));
await page.waitForTimeout(500);
if (!(await page.evaluate(() => /ACCOUNT & DATA|SETTINGS/.test(document.body.innerText)))) {
  // A synthetic click straight on the element, in case the pointer landed on a sibling.
  await page.evaluate(() => { const el = [...document.querySelectorAll('[aria-label="Your profile"]')].find((e) => e.getClientRects().length); el?.click(); });
}
await page.waitForTimeout(800);
console.log('profile text present', await page.evaluate(() => document.body.innerText.includes('ACCOUNT & DATA') || document.body.innerText.includes('SETTINGS')));
const scroller = () => page.evaluate(() => {
  const els = [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).overflowY === 'auto' && e.scrollHeight > e.clientHeight + 100);
  const s = els.find((e) => /ACCOUNT & DATA|SETTINGS/.test(e.innerText)) ?? els.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  return s ? { h: s.scrollHeight, c: s.clientHeight } : null;
});
const info = await scroller();
console.log('scroller', info);
const pages = info ? Math.ceil(info.h / info.c) : 1;
for (let i = 0; i < Math.min(pages, 8); i++) {
  await page.evaluate((i) => {
    const els = [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).overflowY === 'auto' && e.scrollHeight > e.clientHeight + 100);
    const s = els.find((e) => /ACCOUNT & DATA|SETTINGS/.test(e.innerText)) ?? els.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (s) s.scrollTop = i * s.clientHeight;
  }, i);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/profile-${i}.png` });
}
console.log('pages', pages);
await browser.close();
