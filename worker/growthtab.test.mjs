// The growth tab — the morning check, on the dashboard instead of in a chat.
//
// Every other number on the ops console is a TOTAL. A total cannot answer the
// only question worth asking in the morning, "is it going up?", and answering
// it from totals means asking someone to remember yesterday's — which nobody
// does. So this tab is four daily series and one red banner.
//
// The banner is the point. On 23 Aug 2026 the production numbers were: 30
// unique visitors a week, a working install funnel, 4–7 attributed asks a day
// — and the last member to complete phone verification did so on 4 JULY. Seven
// weeks. Every healthy number above it converted to nobody we could reach, and
// nothing on the dashboard said so, because "members: 131" is a total and
// totals do not decay.
//
// Driven through the real handler against real SQLite, because the tab exists
// to be believed and a stubbed row proves only that a template renders.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleConsole } from './console.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      try { return { results: db.prepare(sql).all(...args), success: true }; }
      catch { return { results: [], success: true }; }
    },
    first: async () => { try { return db.prepare(sql).get(...args) ?? null; } catch { return null; } },
    run: async () => { try { db.prepare(sql).run(...args); } catch { /* migrations */ } return { success: true, meta: { changes: 1 } }; },
  });
  return {
    prepare(sql) { const b = (a) => ({ bind: (...m) => b([...a, ...m]), ...shape(sql, a) }); return b([]); },
    batch: async (s) => Promise.all(s.map((x) => x.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = { ADMIN_KEY: 'k123', ADMIN_EMAIL: 'a@b.c', DB: d1(db) };
const ago = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 19).replace('T', ' ');

before(() => {
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0,
           dest TEXT, created_at TEXT, seen_at TEXT, utm_source TEXT, utm_campaign TEXT)`);
  db.exec(`CREATE TABLE num_web_events (id INTEGER PRIMARY KEY AUTOINCREMENT, visitor_id TEXT, event TEXT,
           page TEXT, country TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE num_asks (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, category TEXT, dest TEXT,
           lane TEXT, brain TEXT, degraded INTEGER DEFAULT 0, cached INTEGER DEFAULT 0,
           member_id TEXT, anon_id TEXT, ts TEXT)`);

  const m = db.prepare('INSERT INTO num_members (id, phone, phone_verified, created_at, utm_source) VALUES (?,?,?,?,?)');
  // One verified member, long ago. This is what makes the banner fire.
  m.run('mem_old', '+66810000001', 1, ago(50), 'organic');
  // Recent signups: some gave a number and never verified, some never gave one.
  m.run('mem_a', '+66810000002', 0, ago(1), 'organic');
  m.run('mem_b', null, 0, ago(1), 'flyer');
  m.run('mem_c', null, 0, ago(3), 'organic');

  const w = db.prepare('INSERT INTO num_web_events (visitor_id, event, created_at) VALUES (?,?,?)');
  for (let i = 0; i < 9; i++) w.run(`v${i}`, 'landing_view', ago(1));
  for (let i = 0; i < 4; i++) w.run(`v${i}`, 'install_cta_click', ago(1));
  w.run('v0', 'install_accepted', ago(1));
  for (let i = 0; i < 3; i++) w.run(`w${i}`, 'landing_view', ago(2));
  // One visitor who came back twice on the same day. Without a repeat visitor
  // in the fixture, DISTINCT visitor_id and COUNT(*) are the same number and a
  // test cannot tell "visitors" from "page views" — which is exactly the
  // confusion the column exists to prevent.
  w.run('w0', 'landing_view', ago(2));
  w.run('w0', 'landing_view', ago(2));

  const a = db.prepare('INSERT INTO num_asks (text, lane, member_id, anon_id, ts) VALUES (?,?,?,?,?)');
  a.run('dinner in kata', 'big', 'mem_a', null, ago(1));
  a.run('taxi to airport', 'big', null, 'anon_1', ago(1));
  // The kind of row that used to be counted as demand: no member, no anon id.
  a.run('healthcheck', 'big', null, null, ago(1));
});

const open = async () => {
  const html = await (await handleConsole(
    new Request('http://x/api/admin/console', { method: 'POST', body: new URLSearchParams({ key: 'k123' }) }),
    env, '/admin/console',
  )).text();
  return /s=([^&"]+)/.exec(html)?.[1];
};
const tab = async (s, q = '') =>
  (await handleConsole(new Request(`http://x/api/admin/console?s=${s}&tab=growth${q}`), env, '/admin/console')).text();

describe('the growth tab', () => {
  test('is reachable from the nav and renders its own sections', async () => {
    const s = await open();
    assert.ok(s, 'no session token in the rendered page');
    const html = await tab(s);
    for (const marker of [
      'Visitors — unique per day',
      'Signups — green where at least one verified',
      'Day by day',
      'Website funnel',
      'Where signups came from',
    ]) assert.ok(html.includes(marker), `the growth tab does not render "${marker}"`);
  });

  test('shouts when nobody has completed sign-in', async () => {
    // The whole reason the tab exists. A funnel can look healthy top to bottom
    // and convert nobody into a person we can reach.
    const html = await tab(await open());
    assert.match(html, /days since anyone completed sign-in/i);
    assert.match(html, /\b(49|50|51) days since/, 'the age of the last verification is wrong');
    assert.ok(html.includes('gave a number and never verified'));
  });

  test('counts the unverified and the never-asked separately', async () => {
    // "Gave a number and never verified" is a sign-in bug. "Never gave one" is
    // a funnel problem. Summing them into "unverified" hides which one you have.
    const html = await tab(await open());
    const stale = /<div class="stale">[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    assert.match(stale, /1 gave a number and never verified/);
    assert.match(stale, /2 never gave one/);
  });

  test('separates attributed asks from unattributed ones', async () => {
    // Before anon_id shipped, monitors and probes were counted as demand —
    // 20 to 48 a day of our own health checks reading as people.
    const html = await tab(await open());
    assert.ok(html.includes('Unattributed'), 'the unattributed column is gone');
    assert.match(html, /asks<\/b>|asks<br>/i);
  });

  test('the funnel counts PEOPLE, not page views', async () => {
    const html = await tab(await open());
    const row = /landing_view<\/td><td>(\d+)<\/td><td>(\d+)<\/td>/.exec(html);
    assert.ok(row, 'landing_view is not in the funnel table');
    // 12 distinct visitors, 14 views — w0 came back twice. The two numbers
    // MUST differ here or the assertion proves nothing.
    assert.equal(row[1], '12', 'unique visitors is wrong — page views counted as people?');
    assert.equal(row[2], '14', 'event count is wrong');
    assert.notEqual(row[1], row[2], 'the fixture no longer distinguishes visitors from views');
    const cta = /install_cta_click<\/td><td>(\d+)<\/td>/.exec(html);
    assert.equal(cta?.[1], '4');
  });

  test('a day with no signups renders a zero, not a gap', async () => {
    // Missing days silently dropped is how a flat week looks like a busy one.
    const html = await tab(await open(), '&days=14');
    const dayRows = html.match(/<tr>\s*<td>\d{4}-\d{2}-\d{2}<\/td>/g) ?? [];
    assert.equal(dayRows.length, 14, `expected 14 day rows, got ${dayRows.length}`);
  });

  test('the window switches with ?days=', async () => {
    const s = await open();
    assert.equal(((await tab(s, '&days=7')).match(/<tr>\s*<td>\d{4}-\d{2}-\d{2}<\/td>/g) ?? []).length, 7);
    assert.equal(((await tab(s, '&days=30')).match(/<tr>\s*<td>\d{4}-\d{2}-\d{2}<\/td>/g) ?? []).length, 30);
  });

  test('no session, no numbers', async () => {
    const html = await (await handleConsole(
      new Request('http://x/api/admin/console?s=garbage&tab=growth'), env, '/admin/console')).text();
    assert.ok(!html.includes('days since anyone completed sign-in'));
    assert.ok(html.includes('sign in') || html.includes('Admin key'));
  });

  test('hostile data renders as text, never as markup', async () => {
    db.prepare('INSERT INTO num_members (id, phone, phone_verified, created_at, utm_source) VALUES (?,?,?,?,?)')
      .run('mem_x', null, 0, ago(1), '<script>alert(1)</script>');
    const html = await tab(await open());
    assert.ok(!html.includes('<script>alert'), 'a utm_source executes in the admin console');
    assert.ok(html.includes('&lt;script&gt;'), 'the hostile value was dropped rather than escaped');
  });
});
