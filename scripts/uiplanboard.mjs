// Render the plan board headlessly with a mocked plan API, screenshot it,
// and try a drag. Usage: PW_CHROME=… node scripts/uiplanboard.mjs <base> <outdir>
/* global document, localStorage */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] || 'https://app.itsnum.com';
const out = process.argv[3] || '/tmp/num-ui-plan';
mkdirSync(out, { recursive: true });

const ME = { id: 'mem_preview', name: 'Dre', phone: '+15550000001', phone_verified: true, contact_verified: true };
const plan = { id: 'pl_demo', title: 'Lisbon weekend', dest: 'Lisbon', owner_id: 'mem_preview', starts_on: '2026-10-02', ends_on: '2026-10-04', starts_time: null, state: 'planning', join_code: 'LIS001', currency: 'USD', locked_at: null, locked_by: null, members: 3, items: 5 };
const members = [
  { member_id: 'mem_preview', name: 'Dre', role: 'owner', vote: 'in' },
  { member_id: 'mem_sam', name: 'Sam', role: 'member', vote: 'in' },
  { member_id: 'mem_viv', name: 'Viv', role: 'member', vote: null },
];
let items = [
  { id: 'it_1', plan_id: 'pl_demo', kind: 'idea', title: 'Pastéis de Belém', place: 'Belém', day: '2026-10-02', time: '10:00', status: 'idea', sort: 0, cost_minor: 1800, paid_by: 'mem_sam', split_with: null, comments: 2, by_name: 'Sam' },
  { id: 'it_2', plan_id: 'pl_demo', kind: 'idea', title: 'Tram 28 to Alfama', day: '2026-10-02', time: '11:30', status: 'idea', sort: 0, cost_minor: 900, paid_by: null, split_with: null, comments: 0, by_name: 'Dre' },
  { id: 'it_3', plan_id: 'pl_demo', kind: 'booking', title: 'Cervejaria Ramiro', address: 'Av. Almirante Reis 1', day: '2026-10-02', time: '20:00', status: 'confirmed', sort: 0, cost_minor: 14000, paid_by: 'mem_preview', split_with: null, comments: 1, by_name: 'Dre' },
  { id: 'it_4', plan_id: 'pl_demo', kind: 'idea', title: 'Pensão Amor', day: '2026-10-02', time: '23:00', status: 'idea', sort: 0, cost_minor: null, paid_by: null, split_with: null, comments: 0, by_name: 'Viv' },
  { id: 'it_5', plan_id: 'pl_demo', kind: 'idea', title: 'Sintra day trip', day: '2026-10-03', time: null, status: 'idea', sort: 0, cost_minor: 6000, paid_by: null, split_with: ['mem_preview', 'mem_viv'], comments: 0, by_name: 'Dre' },
];
const events = [
  { id: 1, ts: '2026-09-18T20:00:00Z', by_id: 'mem_sam', by_name: 'Sam', kind: 'comment', summary: 'They open at 8 — go early or the queue is an hour.', item_id: 'it_1' },
  { id: 2, ts: '2026-09-18T20:01:00Z', by_id: 'mem_viv', by_name: 'Viv', kind: 'comment', summary: 'Early is fine by me', item_id: 'it_1' },
  { id: 3, ts: '2026-09-18T20:02:00Z', by_id: 'mem_preview', by_name: 'Dre', kind: 'comment', summary: 'Table for 3 at 8, booked.', item_id: 'it_3' },
];
const money = {
  currency: 'USD', total_minor: 22700, per_head_minor: 7567,
  people: [
    { member_id: 'mem_preview', name: 'Dre', paid_minor: 14000, owes_minor: 4667 + 300 + 600 + 3000, settled_out_minor: 0, settled_in_minor: 0, net_minor: 14000 - 8567 },
    { member_id: 'mem_sam', name: 'Sam', paid_minor: 1800, owes_minor: 4667 + 300 + 600, settled_out_minor: 0, settled_in_minor: 0, net_minor: 1800 - 5567 },
    { member_id: 'mem_viv', name: 'Viv', paid_minor: 0, owes_minor: 4666 + 300 + 600 + 3000, settled_out_minor: 0, settled_in_minor: 0, net_minor: -8566 },
  ],
  transfers: [{ from_id: 'mem_viv', from_name: 'Viv', to_id: 'mem_preview', to_name: 'Dre', minor: 5433 }, { from_id: 'mem_sam', from_name: 'Sam', to_id: 'mem_preview', to_name: 'Dre', minor: 3767 }],
  settlements: [],
};

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const errors = [];
// itsnum.com/api/ev refuses the workers.dev preview origin with a 403 — known, not the board.
page.on('console', (m) => { if (m.type() === 'error' && !/status of 403/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

let reorders = 0;
await page.route('**/api/social/**', async (route) => {
  const url = new URL(route.request().url());
  const p = url.pathname.replace(/^.*\/api\/social/, '');
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (p === '/plans') return json({ plans: [plan] });
  if (p === '/plan' && route.request().method() === 'GET') return json({ plan, members, items, events, money, cursor: 3, ask_link: null });
  if (p === '/plan/reorder') {
    reorders++;
    const b = route.request().postDataJSON();
    for (const m of b.moves) { const it = items.find((i) => i.id === m.id); if (it) { if (m.day !== undefined) it.day = m.day || null; if (m.time !== undefined) it.time = m.time || null; it.sort = m.sort; } }
    return json({ ok: true, items });
  }
  if (p === '/plan/item') { const b = route.request().postDataJSON(); const it = items.find((i) => i.id === b.id); if (it) Object.assign(it, b); return json({ item: it ?? { ...b, id: 'it_new' } }); }
  if (p === '/plan/comment') return json({ ok: true });
  if (p === '/stars') return json({ balance: 42, moves: [] });
  if (p === '/friends') return json({ friends: [] });
  if (p === '/requests') return json({
    connects: [{ id: 'lnk_1', a_id: 'mem_ana', plan_id: 'pl_x', from_name: 'Ana', from_avatar: null, plan_title: 'Porto day', created_at: 't' }],
    events: [{ token: 'tok_1', event_id: 'ev_1', title: 'Viv’s birthday', day: '2026-10-03', time: '20:00', place: 'Pensão Amor', host_name: 'Viv', via: 'agent' }],
    plans: [
      { id: 'pl_demo', title: 'Lisbon weekend', dest: 'Lisbon', members: 3, open_items: 3, latest: 'Sam added Pastéis de Belém.', my_vote: 'in', my_role: 'owner', owner_name: 'Dre', starts_on: '2026-10-02' },
      { id: 'pl_y', title: 'Sam’s boat day', dest: null, members: 4, open_items: 1, latest: null, my_vote: null, my_role: 'member', owner_name: 'Sam', starts_on: '2026-10-09' },
      { id: 'pl_z', title: 'Viv’s hike', dest: null, members: 2, open_items: 0, latest: null, my_vote: null, my_role: 'member', owner_name: 'Viv', starts_on: '2026-10-11' },
    ],
  });
  if (p === '/agenda') return json({
    items: items.filter((i) => i.day).map((i) => ({ id: i.id, plan_id: 'pl_demo', plan_title: 'Lisbon weekend', title: i.title, day: i.day, time: i.time, status: i.status, kind: i.kind, place: i.place ?? null, address: i.address ?? null, cost_minor: i.cost_minor ?? null, currency: 'USD', with: [{ member_id: 'mem_preview', name: 'Dre', sure: true }, { member_id: 'mem_sam', name: 'Sam', sure: true }, { member_id: 'mem_viv', name: 'Viv', sure: false }] })),
    events: [{ id: 'ev_1', title: 'Viv’s birthday', day: '2026-10-03', time: '20:00', place: 'Pensão Amor', address: null, host_id: 'mem_viv', host_name: 'Viv', going: 6, my_part: 'guest' }],
  });
  return json({ ok: true });
});

await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.evaluate((me) => {
  const raw = localStorage.getItem('num-trip-v1');
  const s = raw ? JSON.parse(raw) : {};
  s.me = me; s.demo = false; s.stars = 42; s.planId = 'pl_demo'; s.planCursor = 0; s.planFeed = []; s.view = 'plan'; s.threadOpen = false;
  localStorage.setItem('num-trip-v1', JSON.stringify(s));
}, ME);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
// Make sure we are on PLAN.
const planTab = page.locator('[role="tab"]:has-text("PLAN")').first();
if (await planTab.count()) await planTab.click();
await page.waitForTimeout(800);
// If the thread narrated the plan's history and opened itself, close it.
const closeThread = page.locator('[role="dialog"][aria-label="Thread with NUM"] [aria-label="Close"]:visible').last();
if (await closeThread.count()) { await closeThread.click(); await page.waitForTimeout(400); }
const board = page.locator('text=GROUP PLAN').first();
console.log('board visible:', await board.count() > 0);
await page.screenshot({ path: `${out}/01-board.png`, fullPage: false });
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n---\n')); await browser.close(); process.exit(1); }

// Open the money panel.
await page.locator('text=SPLIT & SETTLE').first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/02-money.png` });

// Open an item.
await page.locator('text=Pastéis de Belém').first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/03-item.png` });
await page.locator('text=Pastéis de Belém').first().click();

// Drag Tram 28 from 11am to 3pm.
const handle = page.locator('[data-item="it_2"] [aria-label="Drag to another time"]');
const target = page.locator('[data-slot="2026-10-02|15"]');
const h = await handle.boundingBox();
if (h) {
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 20, h.y + 30, { steps: 5 });
  // The empty hours grow into drop zones once a drag begins — measure the
  // target AFTER that, the way a thumb sees it.
  await page.waitForTimeout(150);
  const tg = await target.boundingBox();
  if (!tg) { console.log('drag: target not found after drag start'); process.exit(1); }
  await page.mouse.move(tg.x + 120, tg.y + tg.height / 2, { steps: 12 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}/04-dragging.png` });
  await page.mouse.up();
  await page.waitForTimeout(600);
  console.log('reorder calls:', reorders, 'it_2 now at', items.find((i) => i.id === 'it_2').time);
  await page.screenshot({ path: `${out}/05-dropped.png` });
} else console.log('drag: handle not found');

// The invite rail: folded past three, badge on the tab.
await page.evaluate(() => { document.querySelector('.no-scrollbar')?.scrollTo(0, 0); });
await page.waitForTimeout(300);
const railInfo = await page.evaluate(() => ({
  invites: document.body.innerText.includes('INVITES'),
  more: (document.body.innerText.match(/AND \d+ MORE/) || [null])[0],
  badge: document.querySelector('[aria-label$="waiting on you"]')?.textContent ?? null,
}));
console.log('rail:', JSON.stringify(railInfo));
await page.screenshot({ path: `${out}/06-invites.png` });

// MY DIARY → Fri 2 Oct on the calendar → the day by the hour, with who.
await page.locator('[role="tab"]:has-text("MY DIARY")').first().click();
await page.waitForTimeout(400);
// Open the calendar (the FULL CALENDAR chip on the week strip), then pick 2 Oct.
const cal = page.locator('text=FULL CALENDAR').first();
if (await cal.count()) { await cal.click(); await page.waitForTimeout(500); }
// Step the month forward until an "2" cell of October shows, then tap it.
for (let i = 0; i < 2; i++) {
  const oct = await page.evaluate(() => document.body.innerText.includes('October') || document.body.innerText.includes('OCT'));
  if (oct) break;
  const next = page.locator('[role="dialog"] [aria-label="Next month"], [aria-label="Next month"]').first();
  if (await next.count()) { await next.click(); await page.waitForTimeout(300); } else break;
}
const day2 = page.locator('[role="dialog"] [data-day="10-2"], [data-day="10-2"]').first();
if (await day2.count()) { await day2.click(); await page.waitForTimeout(400); }
const withLines = await page.evaluate(() => [...document.querySelectorAll('div')].map((d) => d.textContent || '').filter((t) => /^with /.test(t.trim())).slice(0, 6));
console.log('with:', JSON.stringify(withLines));
await page.screenshot({ path: `${out}/07-calendar.png` });
const close = page.locator('[aria-label="Close"]:visible').last();
if (await close.count()) await close.click();

// Full-page census of the board.
const census = await page.evaluate(() => {
  const els = [...document.querySelectorAll('[role="button"],button,a,input,select,[role="tab"]')];
  const small = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 30; }).map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30));
  return { controls: els.length, under30: small };
});
console.log(JSON.stringify(census));
console.log('errors:', errors.length, errors.slice(0, 5));
await browser.close();
