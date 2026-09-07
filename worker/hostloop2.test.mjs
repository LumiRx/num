// The rest of the host loop that runs without a host typing: a reservation
// through NUM's desk (never confirmed on the host's behalf), NUM's draft reply
// (never a promise), the venue's parties (headcount, not hopes), and the
// before/after moments around a member's confirmed table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bookForHost, venueAnswerSweep, splitWhen } from './hostbookdesk.mjs';
import { draftPrompt, acceptable, draftSweep } from './hostdraft.mjs';
import { upcomingEvents } from './venueevents.mjs';
import { minutesUntil, reminderSweep, afterVisitSweep } from './tablefollowup.mjs';

function reorder(sql, args) {
  const idx = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  if (!idx.length) return args;
  return idx.map((i) => (args[i - 1] === undefined ? null : args[i - 1]));
}
function d1(db) {
  return {
    prepare(sql) {
      const st = { sql, args: [] };
      st.bind = (...a) => { st.args = a; return st; };
      const run = (fn) => fn(db.prepare(st.sql.replace(/\?(\d+)/g, '?')), reorder(st.sql, st.args));
      st.run = async () => ({ meta: { changes: run((s, a) => s.run(...a)).changes } });
      st.first = async () => run((s, a) => s.get(...a)) ?? null;
      st.all = async () => ({ results: run((s, a) => s.all(...a)) });
      return st;
    },
    batch: async (stmts) => { for (const s of stmts) await s.run(); return []; },
  };
}
function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_hosts (id TEXT PRIMARY KEY, name TEXT, email TEXT, console_key TEXT, status TEXT, tier TEXT DEFAULT 'free', plan_status TEXT, plan_sub_id TEXT, plan_renews_at TEXT, currency TEXT, code TEXT, host_bps INTEGER, term_months INTEGER)`);
  db.exec(`CREATE TABLE num_host_clients (id TEXT PRIMARY KEY, host_id TEXT, name TEXT, member_id TEXT, status TEXT)`);
  db.exec(`CREATE TABLE num_host_requests (id TEXT PRIMARY KEY, host_id TEXT, client_id TEXT, service_key TEXT, title TEXT, detail TEXT, city TEXT, starts_at TEXT, party_size INTEGER, price_minor INTEGER DEFAULT 0, currency TEXT DEFAULT 'GBP', unit TEXT DEFAULT 'quote', status TEXT, draft_text TEXT, created_at TEXT, updated_at TEXT)`);
  db.exec(`CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, phone TEXT, business_id TEXT, dest TEXT, address TEXT)`);
  db.exec(`CREATE TABLE destinations (slug TEXT PRIMARY KEY, tz TEXT)`);
  db.exec(`CREATE TABLE num_booking_requests (id TEXT PRIMARY KEY, member_id TEXT, venue_name TEXT, venue_phone TEXT, party_size INTEGER, on_date TEXT, at_time TEXT, note TEXT, state TEXT DEFAULT 'requested', plan_id TEXT, place_id TEXT, created_at TEXT DEFAULT (datetime('now')), answered_at TEXT)`);
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE num_sms_consent (id TEXT PRIMARY KEY, phone TEXT UNIQUE, revoked_at INTEGER)`);
  db.exec(`CREATE TABLE num_events (id TEXT PRIMARY KEY, host_id TEXT, business_id TEXT, title TEXT, day TEXT, time TEXT, place TEXT, capacity INTEGER, state TEXT DEFAULT 'open')`);
  db.exec(`CREATE TABLE num_event_guests (token TEXT PRIMARY KEY, event_id TEXT, rsvp TEXT DEFAULT 'pending', plus_ones INTEGER DEFAULT 0)`);
  // push.mjs creates this itself on first use, but remembers having done so
  // per process — so the second fresh() here would find no table. Pre-made.
  db.exec(`CREATE TABLE IF NOT EXISTS num_notifications (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, url TEXT, tag TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT, read_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS num_push_subs (member_id TEXT, endpoint TEXT, fails INTEGER DEFAULT 0)`);
  db.exec(`INSERT INTO num_hosts (id,name,email,console_key,status) VALUES ('h_1','Priya','priya@example.com','k_${'x'.repeat(30)}','active')`);
  db.exec(`INSERT INTO num_host_clients VALUES ('hc_1','h_1','Dre','mem_1','active')`);
  db.exec(`INSERT INTO places VALUES ('pl_1','Gymkhana','+44 20 3011 5900','biz_1','london','42 Albemarle St')`);
  db.exec(`INSERT INTO destinations VALUES ('london','Europe/London'),('bangkok','Asia/Bangkok')`);
  db.exec(`INSERT INTO num_members VALUES ('mem_1','Dre','+13105550100',1)`);
  return { DB: d1(db), _db: db, ADMIN_KEY: 'test-admin', NUM_APP_ORIGIN: 'https://app.itsnum.com', TWILIO_SID: 'AC' + 'a'.repeat(32), TWILIO_TOKEN: 't', TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'b'.repeat(32) };
}
const host = { id: 'h_1', name: 'Priya' };

test('splitWhen reads the host console\'s local timestamps and nothing else', () => {
  assert.deepEqual(splitWhen('2026-09-12 20:00'), { on_date: '2026-09-12', at_time: '20:00' });
  assert.deepEqual(splitWhen('2026-09-12T9:05:00'), { on_date: '2026-09-12', at_time: '09:05' });
  assert.equal(splitWhen('Friday 8pm'), null);
  assert.equal(splitWhen('2026-09-12'), null, 'a date with no time is not enough for a venue');
});

test('a host\'s reservation goes to the venue as the same one-tap request an app member gets — and the request becomes awaiting_host, never confirmed', async () => {
  const env = fresh(); const sms = [];
  env._db.exec(`INSERT INTO num_host_requests (id,host_id,client_id,service_key,title,starts_at,party_size,status,created_at) VALUES ('hr1','h_1','hc_1','reservation','Dinner for four','2026-09-12 20:00',4,'new','2026-09-04')`);
  const out = await bookForHost(env, { host, requestId: 'hr1', placeId: 'pl_1', smsImpl: async (_e, to, text) => { sms.push({ to, text }); return true; } });
  assert.equal(out.ok, true); assert.equal(out.texted, true); assert.match(out.booking, /^bk_/);
  assert.equal(sms[0].to, '+442030115900');
  assert.match(sms[0].text, /table for 4, 2026-09-12 20:00, for a guest of Priya/);
  assert.match(sms[0].text, /CONFIRM: https:\/\/app\.itsnum\.com\/api\/book\/answer\?id=bk_\w+&v=confirmed&t=[0-9a-f]{32}/);
  const b = env._db.prepare('SELECT * FROM num_booking_requests').get();
  assert.equal(b.member_id, 'host:h_1', 'keyed on the host — the desk\'s "guest told" push goes nowhere, on purpose');
  assert.equal(b.place_id, 'pl_1'); assert.equal(b.venue_name, 'Gymkhana');
  const r = env._db.prepare('SELECT status, booking_ref FROM num_host_requests WHERE id=?').get('hr1');
  assert.equal(r.status, 'awaiting_host'); assert.equal(r.booking_ref, b.id);
  // Idempotent: a second tap does not text the venue twice.
  const again = await bookForHost(env, { host, requestId: 'hr1', placeId: 'pl_1', smsImpl: async () => { sms.push({}); return true; } });
  assert.equal(again.already, true); assert.equal(sms.length, 1);
});

test('the desk refuses what a venue cannot act on, and what is not a reservation', async () => {
  const env = fresh();
  env._db.exec(`INSERT INTO num_host_requests (id,host_id,client_id,service_key,title,starts_at,party_size,status,created_at) VALUES
    ('car','h_1','hc_1','car','Car','2026-09-12 20:00',2,'new','2026-09-04'),
    ('notime','h_1','hc_1','reservation','Dinner',NULL,2,'new','2026-09-04'),
    ('noparty','h_1','hc_1','reservation','Dinner','2026-09-12 20:00',NULL,'new','2026-09-04'),
    ('done','h_1','hc_1','reservation','Dinner','2026-09-12 20:00',2,'confirmed','2026-09-04')`);
  const s = async (id, pid = 'pl_1') => (await bookForHost(env, { host, requestId: id, placeId: pid, smsImpl: async () => true })).status;
  assert.equal(await s('car'), 400); assert.equal(await s('notime'), 400); assert.equal(await s('noparty'), 400); assert.equal(await s('done'), 409);
  assert.equal(await s('car', 'pl_nope'), 400, 'service check comes first; an unknown place on a reservation is 404');
  assert.equal((await bookForHost(env, { host: { id: 'h_other', name: 'X' }, requestId: 'car', placeId: 'pl_1' })).status, 404, 'not your request');
  assert.equal(env._db.prepare('SELECT COUNT(*) n FROM num_booking_requests').get().n, 0);
});

test('the venue\'s answer is written back onto the host\'s request once, the host is emailed once, and the word "confirmed" stays the host\'s', async () => {
  const env = fresh();
  env._db.exec(`INSERT INTO num_host_requests (id,host_id,client_id,service_key,title,starts_at,party_size,status,created_at) VALUES ('hr1','h_1','hc_1','reservation','Dinner','2026-09-12 20:00',4,'new','2026-09-04')`);
  await bookForHost(env, { host, requestId: 'hr1', placeId: 'pl_1', smsImpl: async () => true });
  const ref = env._db.prepare('SELECT booking_ref FROM num_host_requests WHERE id=?').get('hr1').booking_ref;
  assert.deepEqual(await venueAnswerSweep(env), { written: 0 }, 'no answer yet');
  env._db.prepare("UPDATE num_booking_requests SET state='confirmed', answered_at=datetime('now') WHERE id=?").run(ref);
  // Mail goes through the real mailer with no transport configured: the write-back
  // must still happen, and the miss lands on the failure board rather than looping.
  assert.deepEqual(await venueAnswerSweep(env), { written: 1 });
  const r = env._db.prepare('SELECT status, detail, venue_answer_at FROM num_host_requests WHERE id=?').get('hr1');
  assert.equal(r.status, 'awaiting_host', 'NUM never confirms on the host\'s behalf');
  assert.match(r.detail, /✔ Gymkhana confirmed the table through NUM \(bk_\w+\)\. Confirm here to tell your client\./);
  assert.ok(r.venue_answer_at);
  assert.deepEqual(await venueAnswerSweep(env), { written: 0 }, 'once');
});

test('NUM\'s draft for the host: the prompt forbids promises, the guard enforces it', () => {
  const p = draftPrompt({ host: { name: 'Priya' }, request: { service_key: 'car', title: 'Car to LHR', detail: 'Friday 06:00', starts_at: '2026-09-11 06:00', party_size: 2, price_minor: 0, unit: 'quote', currency: 'GBP' }, client: { name: 'Dre' } });
  assert.match(p, /first reply from Priya/); assert.match(p, /client Dre/); assert.match(p, /a car or transfer/); assert.match(p, /a quote — do not invent a number/);
  assert.match(p, /NEVER say confirmed, booked, arranged or done/);
  assert.equal(acceptable('Hi Dre — got your request for a car to Heathrow on Friday at six. I will check the driver and the price and come back to you this evening.'), true);
  assert.equal(acceptable('All confirmed, see you Friday!'), false, 'a promise the host has not made');
  assert.equal(acceptable('Sure, book here: https://x.com'), false, 'no links');
  assert.equal(acceptable('ok'), false); assert.equal(acceptable(null), false);
});

test('the draft sweep fills draft_text on new requests, marks a miss so it is not retried forever, and skips ended hosts', async () => {
  const env = fresh(); env.ANTHROPIC_API_KEY = 'sk-test';
  env._db.exec(`INSERT INTO num_hosts (id,name,email,console_key,status) VALUES ('h_gone','Old','old@x.com','k_${'y'.repeat(30)}','ended')`);
  env._db.exec(`INSERT INTO num_host_requests (id,host_id,client_id,service_key,title,status,created_at) VALUES
    ('a','h_1','hc_1','car','Car to LHR','new','2026-09-04 10:00'),
    ('b','h_1','hc_1','stay','Two nights in Lisbon','new','2026-09-04 10:01'),
    ('c','h_gone',NULL,'car','Old','new','2026-09-04 10:02'),
    ('d','h_1','hc_1','car','Already drafted','new','2026-09-04 10:03')`);
  env._db.prepare("UPDATE num_host_requests SET draft_text='Hi — on it.' WHERE id='d'").run();
  let n = 0;
  const fetchImpl = async () => {
    n++;
    const text = n === 1
      ? 'Hi Dre — got your request for a car to Heathrow on Friday morning. I will confirm the driver and the fare and come back to you this evening.'
      : 'Booked and confirmed, all done!';
    return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) };
  };
  const out = await draftSweep(env, { fetchImpl });
  assert.deepEqual(out, { drafted: 1, skipped: 1 });
  assert.match(env._db.prepare("SELECT draft_text FROM num_host_requests WHERE id='a'").get().draft_text, /come back to you this evening/);
  assert.equal(env._db.prepare("SELECT draft_text FROM num_host_requests WHERE id='b'").get().draft_text, '-', 'a miss is marked, not retried');
  assert.equal(env._db.prepare("SELECT draft_text FROM num_host_requests WHERE id='c'").get().draft_text, null, 'an ended host gets no drafts');
  assert.deepEqual(await draftSweep(env, { fetchImpl }), { drafted: 0, skipped: 0 });
  assert.equal(n, 2);
  delete env.ANTHROPIC_API_KEY;
  env._db.prepare("UPDATE num_host_requests SET draft_text=NULL WHERE id='b'").run();
  assert.deepEqual(await draftSweep(env, { fetchImpl }), { drafted: 0, skipped: 1 }, 'no key: nothing drafted, nothing pretended');
});

test('the venue sees parties coming with a headcount it can cook for — confirmed guests, not invited ones', async () => {
  const env = fresh();
  env._db.exec(`INSERT INTO num_events VALUES ('e1','mem_1','biz_1','Dre''s birthday',date('now','+5 days'),'19:00','Gymkhana',12,'open'),('e2','mem_1','biz_1','Old party',date('now','-10 days'),'19:00','Gymkhana',NULL,'open'),('e3','mem_1','biz_2','Elsewhere',date('now','+2 days'),'19:00','X',NULL,'open'),('e4','mem_1','biz_1','Cancelled',date('now','+3 days'),'19:00','Gymkhana',NULL,'cancelled')`);
  env._db.exec(`INSERT INTO num_event_guests VALUES ('g1','e1','yes',1),('g2','e1','yes',0),('g3','e1','no',0),('g4','e1','pending',0)`);
  const list = await upcomingEvents(env, { businessId: 'biz_1' });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Dre's birthday"); assert.equal(list[0].host, 'Dre');
  assert.equal(list[0].invited, 4); assert.equal(list[0].yes, 2);
  assert.equal(list[0].expected, 4, 'two yeses + one plus-one + the host');
  assert.equal(list[0].capacity, 12);
  assert.deepEqual(await upcomingEvents(env, { businessId: null }), []);
});

test('minutesUntil places a booking in the venue\'s clock, and refuses to guess without a timezone', () => {
  const now = new Date('2026-09-12T16:30:00Z'); // 17:30 London (BST), 23:30 Bangkok
  assert.equal(minutesUntil({ on_date: '2026-09-12', at_time: '20:30' }, 'Europe/London', now), 180);
  assert.equal(minutesUntil({ on_date: '2026-09-13', at_time: '02:30' }, 'Asia/Bangkok', now), 180);
  assert.equal(minutesUntil({ on_date: '2026-09-12', at_time: '20:30' }, null, now), null);
  assert.equal(minutesUntil({ on_date: 'tonight', at_time: '20:30' }, 'Europe/London', now), null);
});

test('the reminder fires once, about three hours out, in-app for everyone and by text only with consent', async () => {
  const env = fresh(); const texts = [];
  env._db.exec(`INSERT INTO num_booking_requests (id,member_id,venue_name,venue_phone,party_size,on_date,at_time,state,place_id) VALUES
    ('bk1','mem_1','Gymkhana','+442030115900',4,'2026-09-12','20:30','confirmed','pl_1'),
    ('bk2','mem_1','Somewhere far','+442030115900',2,'2026-09-12','23:30','confirmed',NULL),
    ('bk3','mem_1','Not confirmed','+442030115900',2,'2026-09-12','20:30','requested','pl_1'),
    ('bk4','mem_1','No zone',NULL,2,'2026-09-12','20:30','confirmed',NULL)`);
  const fetchImpl = async (url, init) => { texts.push(Object.fromEntries(new URLSearchParams(init.body))); return { ok: true, status: 201, json: async () => ({ sid: 'SM1' }), text: async () => '' }; };
  const now = new Date('2026-09-12T16:30:00Z');
  let out = await reminderSweep(env, { now, fetchImpl });
  assert.equal(out.sent, 1, 'only bk1 is ~3h out, confirmed, and placeable');
  assert.equal(out.texted, 0, 'no consent on file — the text is not sent, the in-app note is');
  const note = env._db.prepare("SELECT * FROM num_notifications WHERE member_id='mem_1'").get();
  assert.match(note.title, /Gymkhana at 20:30 — table for 4/); assert.equal(note.tag, 'table:bk1:before');
  out = await reminderSweep(env, { now, fetchImpl });
  assert.equal(out.sent, 0, 'never twice for the same moment');
  // With consent, the same reminder also goes by text.
  env._db.exec(`INSERT INTO num_sms_consent VALUES ('c1','+13105550100',NULL)`);
  env._db.exec(`INSERT INTO num_booking_requests (id,member_id,venue_name,venue_phone,party_size,on_date,at_time,state,place_id) VALUES ('bk5','mem_1','Kiln','+442030115900',2,'2026-09-12','20:45','confirmed','pl_1')`);
  out = await reminderSweep(env, { now, fetchImpl });
  assert.equal(out.sent, 1); assert.equal(out.texted, 1);
  assert.equal(texts[0].To, '+13105550100'); assert.match(texts[0].Body, /Kiln at 20:45/); assert.match(texts[0].Body, /Reply STOP to opt out\.$/);
});

test('the morning after, the after-visit link is minted for an app booking and offered once', async () => {
  const env = fresh();
  env._db.exec(`INSERT INTO num_booking_requests (id,member_id,venue_name,venue_phone,party_size,on_date,at_time,state,place_id) VALUES ('bk1','mem_1','Gymkhana','+442030115900',4,'2026-09-11','20:30','confirmed','pl_1')`);
  const now = new Date('2026-09-12T09:00:00Z'); // ~13.5h after
  let out = await afterVisitSweep(env, { now, site: 'https://itsnum.com' });
  assert.equal(out.sent, 1);
  const tok = env._db.prepare('SELECT * FROM num_after_tokens').get();
  assert.equal(tok.booking_id, 'bk1'); assert.equal(tok.business_id, 'biz_1'); assert.equal(tok.member_ref, 'mem_1');
  const note = env._db.prepare("SELECT * FROM num_notifications WHERE member_id='mem_1'").get();
  assert.equal(note.title, 'How was Gymkhana?'); assert.match(note.url, new RegExp(`^https://itsnum\\.com/a/${tok.token}$`));
  out = await afterVisitSweep(env, { now });
  assert.equal(out.sent, 0, 'once');
  // Too soon (two hours after) and too late (three days after) both wait/skip.
  env._db.exec(`INSERT INTO num_booking_requests (id,member_id,venue_name,venue_phone,party_size,on_date,at_time,state,place_id) VALUES ('bk2','mem_1','Kiln','+442030115900',2,'2026-09-12','06:00','confirmed','pl_1')`);
  assert.equal((await afterVisitSweep(env, { now })).sent, 0);
});
