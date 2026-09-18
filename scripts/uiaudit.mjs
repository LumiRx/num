#!/usr/bin/env node
/* global document, getComputedStyle -- these run inside page.evaluate(), in the browser */
// UI AUDIT — the live app at iPhone size: screenshots of every screen, and a
// census of every tappable thing with whether it has a handler, its size, and
// its label. Run: node scripts/uiaudit.mjs [https://app.itsnum.com] [outdir]
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] || 'https://app.itsnum.com';
const out = process.argv[3] || '/tmp/num-ui';
mkdirSync(out, { recursive: true });

const iphone = devices['iPhone 14'];
// The installed playwright wants headless_shell-1193; the cache has 1243.
// Point at whichever exists rather than downloading a third.
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await browser.newContext({ ...iphone, locale: 'en-GB', timezoneId: 'Europe/London' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${base}/?app`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

/** Every element that looks tappable: role=button, button, a, [onclick], .tap/.press, inputs. */
async function census(label) {
  const rows = await page.evaluate(() => {
    const sel = 'button, a[href], [role="button"], [role="switch"], [role="tab"], .tap, .press, input, textarea, select';
    const seen = new Set();
    const rows = [];
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue; seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      // React attaches handlers via props; the DOM shows none. The reliable
      // signal is the React props object on the fiber.
      const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
      const props = key ? el[key] : {};
      const handlers = Object.keys(props || {}).filter((k) => /^on(Click|KeyDown|Change|Input|Submit|PointerDown|TouchStart)$/.test(k));
      const isLink = el.tagName === 'A' && el.getAttribute('href') && el.getAttribute('href') !== '#';
      const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const fs = parseFloat(cs.fontSize);
      rows.push({
        tag: el.tagName.toLowerCase(), text, w: Math.round(r.width), h: Math.round(r.height), fs,
        wired: isLink || isField || handlers.length > 0,
        small: !isField && (r.height < 40 || r.width < 40),
        tiny_text: fs > 0 && fs < 11 && text.length > 0,
      });
    }
    return rows;
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  return { label, rows, overflow };
}

const report = [];
async function shot(name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png` });
  report.push(await census(name));
}

// The app opens ON the thread. Screenshot it, then close it to reach the tabs.
await shot('00-thread');
const x = page.locator('[aria-label="Close"]:visible, [aria-label="Close thread"]:visible').last();
if (await x.count()) await x.click({ force: true }).catch(() => {});
await page.waitForTimeout(500);
await shot('01-home');
// Scroll TODAY to the rails.
await page.evaluate(() => { const s = [...document.querySelectorAll('*')].find((e) => getComputedStyle(e).overflowY === 'auto' && e.scrollHeight > e.clientHeight + 200); if (s) s.scrollTop = 900; });
await shot('02-home-rails');
await page.evaluate(() => { const s = [...document.querySelectorAll('*')].find((e) => getComputedStyle(e).overflowY === 'auto' && e.scrollHeight > e.clientHeight + 200); if (s) s.scrollTop = 99999; });
await shot('03-home-bottom');

// Tabs: try each bottom-nav item by its text.
for (const tab of ['PLAN', 'MEMORY', 'TODAY']) {
  const t = page.getByText(tab, { exact: true }).first();
  if (await t.count()) { await t.click({ force: true }).catch(() => {}); await shot(`04-tab-${tab.toLowerCase()}`); }
}

// The sign-in sheet.
const signin = page.getByText(/^Sign in$/i).first();
if (await signin.count()) { await signin.click({ force: true }).catch(() => {}); await shot('05-signin'); }
const close = page.locator('[aria-label="Close"]:visible').last();
if (await close.count()) await close.click({ force: true }).catch(() => {});
await page.waitForTimeout(400);

// Every feature door.
await page.getByText('TODAY', { exact: true }).first().click({ force: true }).catch(() => {});
const doors = await page.evaluate(() => [...document.querySelectorAll('[aria-label*=" — "]')].map((e) => e.getAttribute('aria-label')));
for (const d of doors.slice(0, 30)) {
  const el = page.locator(`[aria-label="${d.replace(/"/g, '\\"')}"]`).first();
  if (!(await el.count())) continue;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ force: true }).catch(() => {});
  await shot(`06-door-${d.split(' — ')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`);
  const c = page.locator('[aria-label="Close"]:visible, [aria-label="Back"]:visible').last();
  if (await c.count()) await c.click({ force: true }).catch(() => {});
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

writeFileSync(`${out}/report.json`, JSON.stringify({ report, errors }, null, 2));
// Summary to stdout.
for (const r of report) {
  const un = r.rows.filter((x) => !x.wired);
  const sm = r.rows.filter((x) => x.small);
  const tt = r.rows.filter((x) => x.tiny_text);
  console.log(`\n== ${r.label}: ${r.rows.length} controls · ${un.length} unwired · ${sm.length} under 40px · ${tt.length} text <11px${r.overflow ? ' · HORIZONTAL OVERFLOW' : ''}`);
  for (const x of un) console.log(`   UNWIRED  <${x.tag}> "${x.text}" ${x.w}×${x.h}`);
  for (const x of sm) console.log(`   SMALL    <${x.tag}> "${x.text}" ${x.w}×${x.h}`);
  for (const x of tt) console.log(`   TINY     <${x.tag}> "${x.text}" ${x.fs}px`);
}
console.log(`\nerrors: ${errors.length}`); for (const e of errors.slice(0, 10)) console.log('  ' + e.slice(0, 200));
await browser.close();
