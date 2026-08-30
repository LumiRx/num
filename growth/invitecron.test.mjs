/**
 * invitecron — the automated merchant-invite drain.
 *
 * Every safety rail here is the reason `drainInvites` is allowed to run
 * unattended: a bug that slips past these tests sends a real email to a
 * business nobody reviewed, or sends the same business twice, or blows past
 * the ramp a human agreed to. Real SQLite, real production schema for every
 * table this code touches, same as qrsystem.test.mjs and rpc.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  drainInvites, selectBatch, openDestinations, dailyCap, ticksRemainingToday,
  candidateRows, SEND_WINDOWS, _resetSchemaCache,
} from './invitecron.mjs';

/* ── a D1-shaped wrapper over node:sqlite, matching qrsystem.test.mjs ────── */

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE leads (id TEXT PRIMARY KEY, name TEXT, category TEXT, dest TEXT, area TEXT,
      country TEXT, email TEXT, website TEXT, address TEXT, priority INTEGER, batch TEXT, status TEXT);
    CREATE TABLE num_suppressions (email TEXT PRIMARY KEY, reason TEXT, note TEXT,
      created_at TEXT DEFAULT (datetime('now')));
    -- Written by hand here (not left to invitecron.mjs's own ensure()) so a
    -- test can seed rows into it before drainInvites() has run once — real
    -- production shape, matching what accounts/invites.js already reads and
    -- writes on the live table.
    CREATE TABLE num_invites (
      token TEXT PRIMARY KEY, lead_id TEXT, email TEXT NOT NULL UNIQUE, business_name TEXT,
      category TEXT, dest TEXT, country TEXT, risk TEXT, subject TEXT, batch TEXT,
      status TEXT NOT NULL DEFAULT 'queued', sent_at TEXT, provider_id TEXT, error TEXT,
      open_count INTEGER NOT NULL DEFAULT 0, opened_at TEXT, click_count INTEGER NOT NULL DEFAULT 0,
      clicked_at TEXT, unsubscribed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  return {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { return d.prepare(sql).get(...bound) ?? null; },
        async all() { return { results: d.prepare(sql).all(...bound) }; },
        async run() {
          const r = d.prepare(sql).run(...bound);
          return { meta: { changes: Number(r.changes ?? 0) } };
        },
      };
      return api;
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    _raw: d,
  };
}

function seedLead(DB, over = {}) {
  const l = {
    id: 'lead_' + Math.random().toString(36).slice(2),
    name: 'The Yard in Bath', category: 'Hotel', dest: 'edinburgh', area: 'Old Town',
    country: 'GB', email: `x${Math.random().toString(36).slice(2)}@example.com`,
    website: 'https://example.com', address: '1 High St', priority: 1,
    batch: 'outreach-2026-08-25', status: null,
    ...over,
  };
  DB._raw.prepare(
    `INSERT INTO leads (id,name,category,dest,area,country,email,website,address,priority,batch,status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(l.id, l.name, l.category, l.dest, l.area, l.country, l.email, l.website, l.address, l.priority, l.batch, l.status);
  return l;
}

function baseEnv(DB, over = {}) {
  return {
    DB, RESEND_KEY: 'rk_test', MAIL_FROM: 'NUM <info@itsnum.com>', SITE: 'https://itsnum.com',
    INVITE_LEAD_BATCH: 'outreach-2026-08-25', INVITE_RAMP_START: '2026-08-26', INVITE_SEND_BUDGET: '25',
    ...over,
  };
}

// Wednesday 26 Aug 2026 — matches the real calendar date this shipped on.
// 09:00 UTC sits inside edinburgh's window; 17:00 UTC inside los-angeles's;
// 13:00 UTC sits inside neither.
const WED_EDINBURGH = { scheduledTime: Date.parse('2026-08-26T09:00:00Z') };
const WED_LA = { scheduledTime: Date.parse('2026-08-26T17:00:00Z') };
const WED_BETWEEN = { scheduledTime: Date.parse('2026-08-26T13:00:00Z') };
const MONDAY = { scheduledTime: Date.parse('2026-08-24T09:00:00Z') };

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return handler ? handler(url, init) : new Response(
      JSON.stringify({ data: JSON.parse(init.body).map((_, i) => ({ id: `re_${i}` })) }),
      { status: 200 },
    );
  };
  return calls;
}

test.beforeEach(() => { _resetSchemaCache(); delete globalThis.fetch; });

/* ── pure functions ───────────────────────────────────────────────────── */

test('openDestinations: the hour window is the gate, every day of the week', () => {
  // Widened from Tue/Wed/Thu on 30 Aug 2026 against a queue of 14,403.
  // Tue-Thu was an open-rate convention; the thing that protects the domain is
  // messages PER DAY, which is the ramp and is untouched. Every day at the
  // same daily cap is 2.3x the weekly throughput at identical risk.
  assert.deepEqual(openDestinations(new Date(WED_EDINBURGH.scheduledTime)), ['edinburgh']);
  assert.deepEqual(openDestinations(new Date(WED_LA.scheduledTime)), ['los-angeles']);
  assert.deepEqual(openDestinations(new Date(WED_BETWEEN.scheduledTime)), [],
    'between windows still sends nothing — the hour gate is what remains');
  assert.deepEqual(openDestinations(new Date(MONDAY.scheduledTime)), ['edinburgh'],
    'Monday inside the Edinburgh window now sends');
});

test('phuket is never a send destination — the Thai copy has not been reviewed', () => {
  assert.ok(!('phuket' in SEND_WINDOWS));
  // Sweep every hour of every day; phuket must never appear.
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const t = new Date(Date.UTC(2026, 7, 24 + d, h));
      assert.ok(!openDestinations(t).includes('phuket'));
    }
  }
});

test('dailyCap follows the five-week ramp from the outreach doc', () => {
  const env = { INVITE_RAMP_START: '2026-08-26' };
  assert.equal(dailyCap(env, new Date('2026-08-26T09:00:00Z')), 50, 'day 0');
  assert.equal(dailyCap(env, new Date('2026-09-01T09:00:00Z')), 50, 'day 6, still week 1');
  assert.equal(dailyCap(env, new Date('2026-09-02T09:00:00Z')), 150, 'day 7');
  assert.equal(dailyCap(env, new Date('2026-09-09T09:00:00Z')), 400, 'day 14');
  assert.equal(dailyCap(env, new Date('2026-09-16T09:00:00Z')), 800, 'day 21');
  assert.equal(dailyCap(env, new Date('2026-09-23T09:00:00Z')), 1500, 'day 28');
  assert.equal(dailyCap(env, new Date('2027-01-01T09:00:00Z')), 1500, 'ramp does not exceed its top tier');
});

test('ticksRemainingToday counts only ticks inside a send window', () => {
  // At 07:45 UTC on a Wednesday, edinburgh's 08-11 window (4h = 16 ticks) and
  // los-angeles's 16-19 window (4h = 16 ticks) are both still fully ahead.
  assert.equal(ticksRemainingToday(new Date('2026-08-26T07:45:00Z')), 32);
  // At exactly 09:00, three hours of edinburgh's window remain (09,10,11 =
  // 12 ticks, including the current one) plus los-angeles's untouched 16.
  assert.equal(ticksRemainingToday(new Date('2026-08-26T09:00:00Z')), 12 + 16);
  // Mid-tick (09:07) rounds up to the NEXT tick (09:15) rather than counting
  // one already in progress — 09:15..11:45 is 11 ticks of edinburgh left, + LA's 16.
  assert.equal(ticksRemainingToday(new Date('2026-08-26T09:07:00Z')), 11 + 16);
  // After both windows have fully passed for the day, nothing remains.
  assert.equal(ticksRemainingToday(new Date('2026-08-26T20:00:00Z')), 0);
});

test('selectBatch: excludes the wrong audience', () => {
  const rows = [
    { email: 'a@x.com', category: 'Restaurant', name: 'Church Street Tavern', country: 'GB' },
    { email: 'b@x.com', category: 'Place of worship', name: 'St Mary\'s', country: 'GB' },
  ];
  const out = selectBatch(rows, 10);
  assert.deepEqual(out.map((r) => r.email), ['a@x.com']);
});

test('selectBatch: excludes above-tier jurisdictions (DE/AT/IT)', () => {
  const rows = [
    { email: 'a@x.com', category: 'Restaurant', country: 'GB' },
    { email: 'b@x.com', category: 'Restaurant', country: 'DE' },
  ];
  assert.deepEqual(selectBatch(rows, 10).map((r) => r.email), ['a@x.com']);
});

test('selectBatch: one address per domain per tick, freemail excepted', () => {
  const rows = [
    { email: 'a@onehotel.com', category: 'Hotel', country: 'GB' },
    { email: 'b@onehotel.com', category: 'Hotel', country: 'GB' },
    { email: 'a@gmail.com', category: 'Hotel', country: 'GB' },
    { email: 'b@gmail.com', category: 'Hotel', country: 'GB' },
  ];
  const out = selectBatch(rows, 10).map((r) => r.email);
  assert.deepEqual(out, ['a@onehotel.com', 'a@gmail.com', 'b@gmail.com']);
});

test('selectBatch: malformed emails are dropped, not sent', () => {
  const rows = [{ email: 'not-an-email', category: 'Hotel', country: 'GB' }];
  assert.deepEqual(selectBatch(rows, 10), []);
});

/* ── drainInvites: integration ────────────────────────────────────────── */

test('sends within the window, writes the ledger, updates counts', async () => {
  const DB = db();
  const lead = seedLead(DB);
  const env = baseEnv(DB);
  const calls = mockFetch();

  const r = await drainInvites(env, WED_EDINBURGH);
  assert.equal(r.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body[0].to[0], lead.email);

  const row = DB._raw.prepare('SELECT * FROM num_invites WHERE email = ?').get(lead.email);
  assert.equal(row.status, 'sent');
  assert.ok(row.sent_at);
  assert.equal(row.provider_id, 're_0');
});

test('outside every window: sends nothing, touches no table', async () => {
  const DB = db();
  seedLead(DB);
  const env = baseEnv(DB);
  const calls = mockFetch();
  const r = await drainInvites(env, WED_BETWEEN);
  assert.equal(r.sent, 0);
  assert.equal(calls.length, 0);
});

test('a lead already in num_invites is never selected again', async () => {
  const DB = db();
  const lead = seedLead(DB);
  const env = baseEnv(DB);
  mockFetch();
  const first = await drainInvites(env, WED_EDINBURGH);
  assert.equal(first.sent, 1);
  const second = await drainInvites(env, WED_EDINBURGH);
  assert.equal(second.sent, 0, 'the same lead must not be emailed twice');
});

test('a suppressed email is never selected', async () => {
  const DB = db();
  const lead = seedLead(DB);
  DB._raw.prepare('INSERT INTO num_suppressions (email, reason) VALUES (?, ?)').run(lead.email, 'unsub');
  const env = baseEnv(DB);
  const calls = mockFetch();
  const r = await drainInvites(env, WED_EDINBURGH);
  assert.equal(r.sent, 0);
  assert.equal(calls.length, 0);
});

test('a lead opted out (leads.status) is never selected', async () => {
  const DB = db();
  seedLead(DB, { status: 'opted_out' });
  const env = baseEnv(DB);
  const calls = mockFetch();
  const r = await drainInvites(env, WED_EDINBURGH);
  assert.equal(r.sent, 0);
  assert.equal(calls.length, 0);
});

test('a lead in a different batch is never selected', async () => {
  const DB = db();
  seedLead(DB, { batch: 'some-other-campaign' });
  const env = baseEnv(DB);
  const calls = mockFetch();
  const r = await drainInvites(env, WED_EDINBURGH);
  assert.equal(r.sent, 0);
  assert.equal(calls.length, 0);
});

test('a lead outside the open destinations is never selected', async () => {
  const DB = db();
  seedLead(DB, { dest: 'los-angeles' });
  const env = baseEnv(DB);
  const calls = mockFetch();
  // edinburgh's window is open, not los-angeles's
  const r = await drainInvites(env, WED_EDINBURGH);
  assert.equal(r.sent, 0);
  assert.equal(calls.length, 0);
});

test('refuses to run with no INVITE_LEAD_BATCH configured', async () => {
  const DB = db();
  seedLead(DB);
  const env = baseEnv(DB, { INVITE_LEAD_BATCH: undefined });
  const calls = mockFetch();
  const r = await drainInvites(env, WED_EDINBURGH);
  assert.equal(r.sent, 0);
  assert.equal(r.reason, 'INVITE_LEAD_BATCH not set');
  assert.equal(calls.length, 0);
});

test('stops at the daily ramp cap', async () => {
  const DB = db();
  // Day 0 of the ramp: cap is 50. Seed 50 already-sent rows for TODAY AS THE
  // DRAIN SEES IT — WED_EDINBURGH's fixed date, not the real wall clock.
  // datetime('now') here used to mean the sandbox's actual date, so this
  // test silently stopped exercising the cap the day after it was written
  // (dailyCap's count query keys off substr(sent_at,1,10) matched against
  // `now` from the drain call, not against real time) — it passed on
  // 2026-08-26 and quietly went green-but-meaningless, then red, on every
  // day since.
  const today = new Date(WED_EDINBURGH.scheduledTime).toISOString().slice(0, 10);
  for (let i = 0; i < 50; i++) {
    DB._raw.prepare(
      `INSERT INTO num_invites (token, email, status, sent_at) VALUES (?, ?, 'sent', ?)`,
    ).run('t' + i, `sent${i}@example.com`, `${today} 09:00:00`);
  }
  seedLead(DB);
  const env = baseEnv(DB);
  const calls = mockFetch();
  const r = await drainInvites(env, WED_EDINBURGH);
  assert.equal(r.sent, 0);
  assert.equal(r.reason, 'daily ramp cap reached');
  assert.equal(calls.length, 0);
});

test('a Resend failure marks the ledger failed, not silently lost — and never retries automatically', async () => {
  const DB = db();
  const lead = seedLead(DB);
  const env = baseEnv(DB);
  mockFetch(() => new Response('rate limited', { status: 429 }));

  const r = await drainInvites(env, WED_EDINBURGH);
  assert.equal(r.sent, 0);
  assert.equal(r.failed, 1);

  const row = DB._raw.prepare('SELECT * FROM num_invites WHERE email = ?').get(lead.email);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /429|rate limited/);

  // A failed send is a permanent exclusion by design — see invitecron.mjs's
  // comment on why. A human reviews failures; the drain does not guess.
  mockFetch();
  const again = await drainInvites(env, WED_EDINBURGH);
  assert.equal(again.sent, 0);
});

test('the unique index on email refuses a second row for the same address', async () => {
  const DB = db();
  seedLead(DB);
  const env = baseEnv(DB);
  mockFetch();
  await drainInvites(env, WED_EDINBURGH); // creates + migrates the table

  const dup = 'race@example.com';
  DB._raw.prepare('INSERT INTO num_invites (token, email, status) VALUES (?, ?, ?)').run('t1', dup, 'queued');
  assert.throws(() => {
    DB._raw.prepare('INSERT INTO num_invites (token, email, status) VALUES (?, ?, ?)').run('t2', dup, 'queued');
  }, /UNIQUE/);
});

test('candidateRows excludes an email already in num_invites, independent of the send path', async () => {
  // This is the test M1 (dropping "AND i.token IS NULL") could not fail
  // against drainInvites alone: the table's own UNIQUE(email) constraint
  // masked it, because the test schema pre-declares that column UNIQUE.
  // candidateRows is asserted on directly instead, so the SQL clause itself
  // is what is under test, not a side effect of it.
  const DB = db();
  const lead = seedLead(DB);
  DB._raw.prepare(
    "INSERT INTO num_invites (token, email, status) VALUES ('tok_x', ?, 'sent')",
  ).run(lead.email);
  const env = baseEnv(DB);
  const rows = await candidateRows(env, ['edinburgh'], 100);
  assert.deepEqual(rows.map((r) => r.email), []);
});

test('candidateRows excludes a suppressed and an opted-out lead, and includes a clean one', async () => {
  const DB = db();
  const clean = seedLead(DB);
  const suppressed = seedLead(DB);
  DB._raw.prepare('INSERT INTO num_suppressions (email, reason) VALUES (?, ?)').run(suppressed.email, 'unsub');
  const optedOut = seedLead(DB, { status: 'opted_out' });
  const env = baseEnv(DB);
  const rows = await candidateRows(env, ['edinburgh'], 100);
  assert.deepEqual(rows.map((r) => r.email).sort(), [clean.email].sort());
});

test('a num_invites table that predates the UNIQUE(email) index gets it retrofitted', async () => {
  // The live table was hand-created before this code existed (see
  // invitecron.mjs's own comment on MIGRATIONS) — nothing guarantees it
  // already has a unique constraint on email. ensure() must add one to a
  // table that does NOT already have it, not just to a fresh one.
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE leads (id TEXT PRIMARY KEY, name TEXT, category TEXT, dest TEXT, area TEXT,
      country TEXT, email TEXT, website TEXT, address TEXT, priority INTEGER, batch TEXT, status TEXT);
    CREATE TABLE num_suppressions (email TEXT PRIMARY KEY, reason TEXT, note TEXT, created_at TEXT);
    -- Deliberately NO UNIQUE on email — an old, narrow, hand-created table.
    CREATE TABLE num_invites (token TEXT PRIMARY KEY, email TEXT NOT NULL, status TEXT);
  `);
  const DB = {
    prepare(sql) {
      const bound = [];
      const api = {
        bind(...a) { bound.push(...a); return api; },
        async first() { return d.prepare(sql).get(...bound) ?? null; },
        async all() { return { results: d.prepare(sql).all(...bound) }; },
        async run() {
          const r = d.prepare(sql).run(...bound);
          return { meta: { changes: Number(r.changes ?? 0) } };
        },
      };
      return api;
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    _raw: d,
  };
  const lead = seedLead(DB);
  const env = baseEnv(DB);
  mockFetch();
  await drainInvites(env, WED_EDINBURGH); // runs ensure(), which must add the index

  const dup = 'retrofit-check@example.com';
  d.prepare('INSERT INTO num_invites (token, email, status) VALUES (?, ?, ?)').run('r1', dup, 'queued');
  assert.throws(() => {
    d.prepare('INSERT INTO num_invites (token, email, status) VALUES (?, ?, ?)').run('r2', dup, 'queued');
  }, /UNIQUE/, 'ensure() should have retrofitted a unique index onto the pre-existing table');
});

test('respects the hard per-tick ceiling even when the daily cap allows more', async () => {
  // Late in los-angeles's window (19:45 — its last tick), essentially no
  // ticks remain today, so the even-spread math (remainingToday ÷ ticksLeft)
  // wants to send the ENTIRE day's remaining cap in this one tick. The hard
  // ceiling is the only thing stopping that from being a 50-email burst.
  const DB = db();
  for (let i = 0; i < 40; i++) seedLead(DB, { dest: 'los-angeles', email: `x${i}@hotel${i}.com` });
  const env = baseEnv(DB, { INVITE_SEND_BUDGET: '5' });
  const calls = mockFetch();
  const LATE_LA = { scheduledTime: Date.parse('2026-08-26T19:45:00Z') };
  assert.deepEqual(openDestinations(new Date(LATE_LA.scheduledTime)), ['los-angeles']);
  assert.equal(ticksRemainingToday(new Date(LATE_LA.scheduledTime)), 1, 'sanity: only the current tick remains today');

  const r = await drainInvites(env, LATE_LA);
  assert.equal(r.sent, 5, `sent ${r.sent}, expected exactly INVITE_SEND_BUDGET=5, not the ~50 the even-spread math alone would pick`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.length, 5);
});

/* ── template stays in sync with the .html a human actually edits ────────── */

test('invitetemplate.mjs is exactly what build_invite_template.mjs would generate from invite_v2.html', async () => {
  const { readFileSync } = await import('node:fs');
  const { INVITE_TEMPLATE } = await import('./invitetemplate.mjs');
  const html = readFileSync(new URL('../campaign/invite_v2.html', import.meta.url), 'utf8');
  assert.equal(
    INVITE_TEMPLATE, `\n${html}`,
    'growth/invitetemplate.mjs is stale — edit campaign/invite_v2.html then run: node scripts/build_invite_template.mjs',
  );
});

/* ── who goes first ───────────────────────────────────────────────────── */

test('business domains are sent before freemail', async () => {
  // 7,651 of the 14,403 addresses in outreach-2026-08-25 are gmail, yahoo,
  // hotmail or outlook — 53%. Cold mail to a consumer mailbox is judged far
  // more harshly by that mailbox's provider than mail to a company domain, and
  // a Gmail complaint costs a sending domain more than a complaint from
  // anywhere else.
  //
  // So the ramp builds its reputation on the half most likely to be welcomed,
  // and the riskiest half goes last, from a domain that by then has weeks of
  // clean history. It also front-loads the leads most likely to convert: an
  // address at a restaurant's own domain reaches whoever can claim the listing
  // far more often than the owner's personal Gmail does.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('./invitecron.mjs', import.meta.url)), 'utf8');
  const q = src.slice(src.indexOf('FROM leads l'), src.indexOf('LIMIT ?2'));

  assert.match(q, /ORDER BY/);
  for (const host of ['gmail.com', 'yahoo.', 'hotmail.', 'outlook.', 'icloud.com']) {
    assert.ok(q.includes(host), `${host} is not sorted last — it will be sent among the business domains`);
  }
  // Freemail must be ranked 1 and business 0, not the other way round.
  assert.match(q, /THEN 1 ELSE 0 END/);
  // And priority still wins over the domain split — a hand-picked lead is
  // hand-picked for a reason.
  assert.ok(q.indexOf('l.priority') < q.indexOf('gmail.com'),
    'the freemail split must not override an explicit priority');
});

test('the ramp, not the calendar, is what limits daily volume', () => {
  // The safety property that survived widening the send days. If a future
  // change raises the daily cap it should be a deliberate edit to RAMP, never
  // a side effect of touching the schedule.
  const day0 = new Date('2026-08-26T09:00:00Z');
  const day30 = new Date('2026-09-25T09:00:00Z');
  const env = { INVITE_RAMP_START: '2026-08-26' };
  assert.equal(dailyCap(env, day0), 50);
  assert.equal(dailyCap(env, day30), 1500);
  assert.ok(dailyCap(env, day0) < dailyCap(env, day30), 'the ramp must still climb');
});
