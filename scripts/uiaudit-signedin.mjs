#!/usr/bin/env node
/* global localStorage, document, getComputedStyle -- run inside the browser */
// SIGNED-IN UI AUDIT — a fake member and a Bangkok fix injected into saved
// state, then every sheet a member can reach is opened and censused: each
// tappable element with whether React gave it a handler, its size, its type
// size; every console error; every failed network call. Screens saved as PNG.
// Run: PW_CHROME=… node scripts/uiaudit-signedin.mjs [base] [outdir]
import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] || 'https://app.itsnum.com';
const out = process.argv[3] || '/tmp/num-ui-in';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await browser.newContext({ ...devices['iPhone 14'], locale: 'en-GB', geolocation: { latitude: 13.7563, longitude: 100.5018 }, permissions: ['geolocation'] });
await ctx.addInitScript(() => {
  const me = { id: 'mem_preview', name: 'Dre', phone: '+14155550123', phone_verified: true, email: 'dre@example.com', email_verified: false, verified: true, avatar: null };
  const saved = { me, onboarded: true, place: 'Bangkok', here: { lat: 13.7563, lng: 100.5018 }, stars: 5, threadOpen: false, view: 'dash' };
  try { localStorage.setItem('num-trip-v1', JSON.stringify(saved)); } catch { /* fine */ }
});
const page = await ctx.newPage();
const errors = [], failed = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400 && /\/api\//.test(r.url())) failed.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });

await page.goto(`${base}/?app`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const closeTop = async () => {
  for (let i = 0; i < 3; i++) {
    const x = page.locator('[aria-label="Close"]:visible, [aria-label="Close thread"]:visible').last();
    if (!(await x.count())) break;
    await x.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
};
await closeTop();

async function census(label) {
  const rows = await page.evaluate(() => {
    const sel = 'button, a[href], [role="button"], [role="switch"], [role="tab"], .tap, .press, input, textarea, select';
    const seen = new Set(); const rows = [];
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue; seen.add(el);
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      const key = Object.keys(el).find((k) => k.startsWith('__reactProps')); const props = key ? el[key] : {};
      const handlers = Object.keys(props || {}).filter((k) => /^on(Click|KeyDown|Change|Input|Submit|PointerDown|TouchStart)$/.test(k));
      const isLink = el.tagName === 'A' && el.getAttribute('href') && el.getAttribute('href') !== '#';
      const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      rows.push({ tag: el.tagName.toLowerCase(), text, w: Math.round(r.width), h: Math.round(r.height), fs: parseFloat(cs.fontSize), wired: isLink || isField || handlers.length > 0, small: !isField && (r.height < 40 || r.width < 40), tiny: parseFloat(cs.fontSize) < 11 && text.length > 0 });
    }
    return rows;
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  return { label, rows, overflow };
}
const report = [];
async function shot(name) { await page.waitForTimeout(700); await page.screenshot({ path: `${out}/${name}.png` }); report.push(await census(name)); }
/** Tap the first visible element whose text matches, if any. */
async function tap(re) {
  const el = page.getByText(re).first();
  if (await el.count()) { await el.scrollIntoViewIfNeeded().catch(() => {}); await el.click({ force: true }).catch(() => {}); return true; }
  return false;
}
const byLabel = async (label) => { const el = page.locator(`[aria-label="${label}"]:visible`).first(); if (await el.count()) { await el.click({ force: true }).catch(() => {}); return true; } return false; };

await shot('10-home-signedin');
// Rails: scroll home to the bottom and tap the first place card's button + send.
await page.evaluate(() => { const s = [...document.querySelectorAll('*')].find((e) => getComputedStyle(e).overflowY === 'auto' && e.scrollHeight > e.clientHeight + 200); if (s) s.scrollTop = 99999; });
await shot('11-home-rails');
if (await tap(/^Get a table$/)) { await shot('12-place-ask'); await closeTop(); }
if (await byLabel('Send')) { await shot('13-send-sheet'); await closeTop(); }
// PLAN tab and its widgets.
await tap(/^PLAN$/); await shot('20-plan');
if (await tap(/^\+ NEW PLAN$/)) { await shot('21-new-plan'); await closeTop(); }
if (await tap(/FULL CALENDAR/)) { await shot('22-calendar'); await closeTop(); }
if (await tap(/TRIP CHECK/)) { await shot('23-tripcheck'); }
// MEMORY tab.
await tap(/^MEMORY$/); await shot('30-memory');
await tap(/^TODAY$/);
// Header: stars wallet, messages, profile.
if (await byLabel('Stars wallet')) { await shot('40-wallet'); await closeTop(); }
if (await byLabel('Your profile')) {
  await shot('50-profile');
  for (const row of [/^Tell NUM about you$/, /^What NUM has picked up$/, /^Look, text & language$/, /^Name on the account$/]) {
    if (await tap(row)) { await shot('51-profile-' + String(row).replace(/[^a-z]/gi, '').slice(1, 14).toLowerCase()); }
  }
  for (const door of [/^Own a place on NUM\?$/, /^NUM Expert$/, /^Passenger details$/]) {
    if (await tap(door)) { await shot('52-profile-door-' + String(door).replace(/[^a-z]/gi, '').slice(1, 12).toLowerCase()); await closeTop(); if (!(await page.evaluate(() => /ACCOUNT & DATA/.test(document.body.innerText)))) await byLabel('Your profile'); }
  }
  if (await tap(/^MY CODE$/)) { await shot('53-share'); await closeTop(); if (!(await page.evaluate(() => /ACCOUNT & DATA/.test(document.body.innerText)))) await byLabel('Your profile'); }
  if (await tap(/^Delete my account$/)) { await shot('54-delete'); }
  await closeTop();
}
// Feature sheets that only open signed in.
await tap(/^TODAY$/);
for (const [label, name] of [['Out tonight — Nearest first', '60-nightlife'], ['Plan with friends — Open plans', '61-plans'], ['Tickets & events — See what’s on', '62-events'], ['Someone to run this — Hire someone', '63-hire']]) {
  const el = page.locator(`[aria-label="${label}"]`).first();
  if (await el.count()) { await el.scrollIntoViewIfNeeded().catch(() => {}); await el.click({ force: true }).catch(() => {}); await shot(name); await closeTop(); }
}
// The errand board and host-your-event doors from inside sheets.
const hire = page.locator('[aria-label="Someone to run this — Hire someone"]').first();
if (await hire.count()) { await hire.scrollIntoViewIfNeeded().catch(() => {}); await hire.click({ force: true }).catch(() => {}); if (await tap(/See the errand board/)) { await shot('64-errands'); } await closeTop(); }
const ev = page.locator('[aria-label="Tickets & events — See what’s on"]').first();
if (await ev.count()) { await ev.scrollIntoViewIfNeeded().catch(() => {}); await ev.click({ force: true }).catch(() => {}); if (await tap(/Host your own event/)) { await shot('65-host-event'); } await closeTop(); }

writeFileSync(`${out}/report.json`, JSON.stringify({ report, errors, failed }, null, 2));
for (const r of report) {
  const un = r.rows.filter((x) => !x.wired), sm = r.rows.filter((x) => x.small), tt = r.rows.filter((x) => x.tiny);
  console.log(`\n== ${r.label}: ${r.rows.length} controls · ${un.length} unwired · ${sm.length} <40px · ${tt.length} text<11px${r.overflow ? ' · OVERFLOW' : ''}`);
  for (const x of un) console.log(`   UNWIRED  <${x.tag}> "${x.text}" ${x.w}×${x.h}`);
  for (const x of sm) console.log(`   SMALL    <${x.tag}> "${x.text}" ${x.w}×${x.h}`);
  for (const x of tt) console.log(`   TINY     <${x.tag}> "${x.text}" ${x.fs}px`);
}
console.log(`\nconsole errors: ${errors.length}`); for (const e of [...new Set(errors)].slice(0, 12)) console.log('  ' + e.slice(0, 220));
console.log(`failed api calls: ${failed.length}`); for (const f of [...new Set(failed)].slice(0, 20)) console.log('  ' + f);
await browser.close();
