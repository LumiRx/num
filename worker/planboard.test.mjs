/**
 * The plan board (18 Sep 2026): days and hours, an order inside the hour, a
 * lock only the owner holds, money on items, comments on items, and settling
 * up through the same Stars rail every other payment uses.
 *
 * Driven through handleSocialSafe against node:sqlite, the way
 * socialrequests.test.mjs does it, so the SQL is the SQL that ships.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSocialSafe, tableAnswered } from './social.mjs';

function d1(db) {
  const shape = (sql, args) => ({
    all: async () => {
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { results: stmt.all(...args), success: true };
      stmt.run(...args);
      return { results: [], success: true };
    },
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
    },
  });
  return {
    prepare(sql) {
      const bound = (args) => ({ bind: (...more) => bound([...args, ...more]), ...shape(sql, args) });
      return bound([]);
    },
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
  };
}

const db = new DatabaseSync(':memory:');
const env = { DB: d1(db) };

const post = (path, body) => handleSocialSafe(
  new Request(`https://app.itsnum.com/api/social${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  env, path,
);
const get = (path, q) => handleSocialSafe(new Request(`https://app.itsnum.com/api/social${path}?${new URLSearchParams(q)}`), env, path);
const read = async (res) => ({ status: res.status, body: await res.json() });

// Build the schema once (ensured is module-wide), then seed people and a plan.
await get('/plans', { me: 'mem_warm' });

const member = (id, name) => db.prepare("INSERT INTO num_members (id, name, phone, phone_verified) VALUES (?,?,?,1)").run(id, name, `+1555${id.slice(-4).padStart(4, '0')}`);

let plan;
beforeEach(async () => {
  for (const t of ['num_members', 'num_plans', 'num_plan_members', 'num_plan_items', 'num_plan_events', 'num_plan_settlements', 'num_star_balances', 'num_star_moves']) {
    db.exec(`DELETE FROM ${t}`);
  }
  member('mem_dre', 'Dre'); member('mem_sam', 'Sam'); member('mem_viv', 'Viv');
  db.prepare("INSERT INTO num_plans (id, title, owner_id, starts_on, join_code) VALUES ('pl_1','Lisbon','mem_dre','2026-10-02','LIS001')").run();
  for (const [m, n, r] of [['mem_dre', 'Dre', 'owner'], ['mem_sam', 'Sam', 'member'], ['mem_viv', 'Viv', 'member']]) {
    db.prepare('INSERT INTO num_plan_members (plan_id, member_id, name, role) VALUES (?,?,?,?)').run('pl_1', m, n, r);
  }
  plan = 'pl_1';
});

const addItem = async (me, body) => read(await post('/plan/item', { me, plan_id: plan, ...body }));
const readPlan = async (me) => (await read(await get('/plan', { id: plan, me, self: '1' }))).body;

describe('days, hours and order', () => {
  test('a new item lands at the end of its hour; a time can be cleared with ""', async () => {
    const a = await addItem('mem_dre', { title: 'Time Out Market', day: '2026-10-02', time: '13:00' });
    const b = await addItem('mem_sam', { title: 'Pastéis de Belém', day: '2026-10-02', time: '13:00' });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.body.item.sort, 0);
    assert.equal(b.body.item.sort, 1, 'second item in the same hour sorts after the first');
    const cleared = await addItem('mem_sam', { id: b.body.item.id, time: '' });
    assert.equal(cleared.body.item.time, null, '"" clears the time; the old COALESCE never could');
    assert.equal(cleared.body.item.title, 'Pastéis de Belém', 'fields not sent are untouched');
  });

  test('a bad day or time is refused before it reaches the row', async () => {
    assert.equal((await addItem('mem_dre', { title: 'x', day: 'tomorrow' })).status, 400);
    assert.equal((await addItem('mem_dre', { title: 'x', time: '7pm' })).status, 400);
  });

  test('reorder moves several items in one call and says so once; a shuffle inside an hour is silent', async () => {
    const a = (await addItem('mem_dre', { title: 'Tram 28', day: '2026-10-02', time: '10:00' })).body.item;
    const b = (await addItem('mem_dre', { title: 'Alfama walk', day: '2026-10-02', time: '11:00' })).body.item;
    const before = db.prepare("SELECT COUNT(*) n FROM num_plan_events WHERE plan_id='pl_1'").get().n;
    const r = await read(await post('/plan/reorder', { me: 'mem_sam', plan_id: plan, moves: [{ id: a.id, time: '16:00', sort: 0 }, { id: b.id, day: '2026-10-03', time: '09:00', sort: 0 }] }));
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.items.map((i) => [i.id, i]));
    assert.equal(byId[a.id].time, '16:00');
    assert.deepEqual([byId[b.id].day, byId[b.id].time], ['2026-10-03', '09:00']);
    const after = db.prepare("SELECT kind, summary FROM num_plan_events WHERE plan_id='pl_1' ORDER BY id DESC LIMIT 1").get();
    assert.equal(db.prepare("SELECT COUNT(*) n FROM num_plan_events WHERE plan_id='pl_1'").get().n, before + 1, 'one feed line for the whole drag');
    assert.equal(after.kind, 'item_moved');
    assert.match(after.summary, /Sam rearranged the day — 2 things moved/);
    const n = db.prepare("SELECT COUNT(*) n FROM num_plan_events WHERE plan_id='pl_1'").get().n;
    await post('/plan/reorder', { me: 'mem_sam', plan_id: plan, moves: [{ id: a.id, sort: 5 }] });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM num_plan_events WHERE plan_id='pl_1'").get().n, n, 'sort-only is not news');
  });
});

describe('the lock', () => {
  test('only the owner can lock; once locked, others cannot add, move or edit — the owner still can', async () => {
    assert.equal((await read(await post('/plan', { me: 'mem_sam', id: plan, lock: true }))).status, 403);
    const locked = await read(await post('/plan', { me: 'mem_dre', id: plan, lock: true }));
    assert.equal(locked.status, 200);
    assert.ok(locked.body.plan.locked_at, 'locked_at is set');
    assert.equal(locked.body.plan.locked_by, 'mem_dre');

    const refused = await addItem('mem_sam', { title: 'Sneaky extra bar' });
    assert.equal(refused.status, 423);
    assert.equal(refused.body.locked, true);
    assert.equal((await read(await post('/plan/reorder', { me: 'mem_viv', plan_id: plan, moves: [{ id: 'x' }] }))).status, 423);
    assert.equal((await read(await post('/plan', { me: 'mem_sam', id: plan, title: 'Renamed' }))).status, 423);

    const ok = await addItem('mem_dre', { title: 'Owner can still add', day: '2026-10-02', time: '20:00' });
    assert.equal(ok.status, 200);

    const open = await read(await post('/plan', { me: 'mem_dre', id: plan, lock: false }));
    assert.equal(open.body.plan.locked_at, null);
    assert.equal((await addItem('mem_sam', { title: 'Back in business' })).status, 200);
    const kinds = db.prepare("SELECT kind FROM num_plan_events WHERE plan_id='pl_1' AND kind IN ('locked','unlocked') ORDER BY id").all().map((r) => r.kind);
    assert.deepEqual(kinds, ['locked', 'unlocked']);
  });

  test('a plan spans days: ends_on is set, cleared with "", and currency is a 3-letter code', async () => {
    const r = await read(await post('/plan', { me: 'mem_dre', id: plan, ends_on: '2026-10-05', currency: 'eur' }));
    assert.equal(r.body.plan.ends_on, '2026-10-05');
    assert.equal(r.body.plan.currency, 'EUR');
    assert.equal((await read(await post('/plan', { me: 'mem_dre', id: plan, currency: 'euros' }))).status, 400);
    const one = await read(await post('/plan', { me: 'mem_dre', id: plan, ends_on: '' }));
    assert.equal(one.body.plan.ends_on, null);
  });
});

describe('money', () => {
  test('total, per head, who paid, who owes — pennies never vanish on an uneven split', async () => {
    // Dre paid €100 for all three (33.33 each, Dre carries the odd cent);
    // Sam paid €20 for Sam and Viv only.
    await post('/plan', { me: 'mem_dre', id: plan, currency: 'EUR' });
    await addItem('mem_dre', { title: 'Dinner', cost_minor: 10000, paid_by: 'mem_dre' });
    await addItem('mem_sam', { title: 'Taxi', cost_minor: 2000, paid_by: 'mem_sam', split_with: ['mem_sam', 'mem_viv'] });
    const { money } = await readPlan('mem_dre');
    assert.equal(money.currency, 'EUR');
    assert.equal(money.total_minor, 12000);
    assert.equal(money.per_head_minor, 4000);
    const by = Object.fromEntries(money.people.map((p) => [p.member_id, p]));
    assert.equal(by.mem_dre.paid_minor, 10000);
    assert.equal(by.mem_dre.owes_minor, 3334, 'the odd cent lands on the payer');
    assert.equal(by.mem_sam.owes_minor, 3333 + 1000);
    assert.equal(by.mem_viv.owes_minor, 3333 + 1000);
    assert.equal(by.mem_dre.owes_minor + by.mem_sam.owes_minor + by.mem_viv.owes_minor, 12000, 'every cent is owed by someone');
    assert.equal(by.mem_dre.net_minor, 6666);
    assert.equal(by.mem_sam.net_minor, 2000 - 4333);
    assert.equal(by.mem_viv.net_minor, -4333);
    assert.equal(money.people.reduce((s, p) => s + p.net_minor, 0), 0, 'nets sum to zero');
    // Fewest transfers: both debtors pay Dre.
    assert.deepEqual(money.transfers.map((t) => [t.from_id, t.to_id, t.minor]).sort(), [['mem_sam', 'mem_dre', 2333], ['mem_viv', 'mem_dre', 4333]].sort());
  });

  test('paid_by and split_with must name people on the plan; cost must be whole minor units', async () => {
    assert.equal((await addItem('mem_dre', { title: 'x', cost_minor: 12.5 })).status, 200, 'rounded, not refused');
    assert.equal((await addItem('mem_dre', { title: 'x', cost_minor: -5 })).status, 400);
    assert.equal((await addItem('mem_dre', { title: 'x', paid_by: 'mem_stranger' })).status, 400);
    assert.equal((await addItem('mem_dre', { title: 'x', split_with: ['mem_stranger'] })).status, 400);
  });

  test('marking a debt paid outside NUM moves the balances and is idempotent', async () => {
    await addItem('mem_dre', { title: 'Dinner', cost_minor: 9000, paid_by: 'mem_dre' });
    const r = await read(await post('/plan/settle', { me: 'mem_sam', plan_id: plan, to: 'mem_dre', minor: 3000, via: 'outside', idem: 'k1' }));
    assert.equal(r.status, 200);
    await post('/plan/settle', { me: 'mem_sam', plan_id: plan, to: 'mem_dre', minor: 3000, via: 'outside', idem: 'k1' });
    const { money } = await readPlan('mem_sam');
    const sam = money.people.find((p) => p.member_id === 'mem_sam');
    assert.equal(sam.settled_out_minor, 3000, 'the same idem key settles once');
    assert.equal(sam.net_minor, 0);
    assert.deepEqual(money.transfers.map((t) => t.from_id), ['mem_viv'], 'only Viv still owes');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM num_plan_events WHERE kind='settled'").get().n, 1);
  });

  test('Stars settle a USD plan through pay(): ledger, balance and settlement all move; not offered in EUR', async () => {
    db.prepare("INSERT INTO num_star_balances (member_id, stars) VALUES ('mem_sam', 50)").run();
    await addItem('mem_dre', { title: 'Dinner', cost_minor: 9000, paid_by: 'mem_dre' });
    const r = await read(await post('/plan/settle', { me: 'mem_sam', plan_id: plan, to: 'mem_dre', minor: 3000, via: 'stars', idem: 'k2' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stars, 30);
    // The ledger is the truth (balances may also carry the welcome grant
    // ensureBalance gives a first-touched wallet): ★30 left Sam, ★30 reached Dre.
    const moves = db.prepare("SELECT member_id, delta FROM num_star_moves WHERE id LIKE 'plan:k2:%' ORDER BY delta").all().map((m) => ({ member_id: m.member_id, delta: m.delta }));
    assert.deepEqual(moves, [{ member_id: 'mem_sam', delta: -30 }, { member_id: 'mem_dre', delta: 30 }], 'debit and credit rows carry the plan idem key');
    const sam = db.prepare("SELECT stars FROM num_star_balances WHERE member_id='mem_sam'").get().stars;
    const dre = db.prepare("SELECT stars FROM num_star_balances WHERE member_id='mem_dre'").get().stars;
    assert.ok(sam >= 20 && sam <= 25 && dre >= 30 && dre <= 35, `balances moved by ★30 (sam ${sam}, dre ${dre})`);
    const { money } = await readPlan('mem_sam');
    assert.equal(money.people.find((p) => p.member_id === 'mem_sam').net_minor, 0);

    const short = await read(await post('/plan/settle', { me: 'mem_viv', plan_id: plan, to: 'mem_dre', minor: 3000, via: 'stars', idem: 'k3' }));
    assert.equal(short.status, 409, 'no Stars, no payment — and nothing recorded');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM num_plan_settlements").get().n, 1);

    await post('/plan', { me: 'mem_dre', id: plan, currency: 'EUR' });
    const eur = await read(await post('/plan/settle', { me: 'mem_viv', plan_id: plan, to: 'mem_dre', minor: 3000, via: 'stars', idem: 'k4' }));
    assert.equal(eur.status, 400);
    assert.match(eur.body.error, /EUR.*Stars are dollars/);
  });
});

describe('comments on an item', () => {
  test('a comment can hang off one item; the card carries the count; the plan chat still shows it', async () => {
    const it = (await addItem('mem_dre', { title: 'Cervejaria Ramiro', day: '2026-10-02', time: '20:00' })).body.item;
    assert.equal((await read(await post('/plan/comment', { me: 'mem_sam', plan_id: plan, item_id: it.id, text: 'Can we make it 8?' }))).status, 200);
    assert.equal((await read(await post('/plan/comment', { me: 'mem_viv', plan_id: plan, item_id: it.id, text: 'Yes please' }))).status, 200);
    assert.equal((await read(await post('/plan/comment', { me: 'mem_viv', plan_id: plan, text: 'General hello' }))).status, 200);
    assert.equal((await read(await post('/plan/comment', { me: 'mem_viv', plan_id: plan, item_id: 'itm_nope', text: 'x' }))).status, 404);
    const p = await readPlan('mem_dre');
    assert.equal(p.items.find((i) => i.id === it.id).comments, 2);
    const onItem = p.events.filter((e) => e.kind === 'comment' && e.item_id === it.id);
    assert.equal(onItem.length, 2);
    assert.equal(p.events.filter((e) => e.kind === 'comment').length, 3, 'item comments are in the one feed too');
  });
});

describe('a venue answers a table asked for from the plan (bookdesk → tableAnswered)', () => {
  const row = { id: 'req_abc123', member_id: 'mem_sam', venue_name: 'Cervejaria Ramiro', party_size: 4, on_date: '2026-10-02', at_time: '20:00', plan_id: 'pl_1' };

  test('confirmed → one BOOKED card in that hour, one feed line on the item; a replay adds nothing', async () => {
    const r = await tableAnswered(env, { row, verdict: 'confirmed', address: 'Av. Almirante Reis 1' });
    assert.equal(r.ok, true);
    const p = await readPlan('mem_dre');
    const card = p.items.find((i) => i.id === r.item_id);
    assert.ok(card, 'the table is on the board');
    assert.deepEqual([card.kind, card.status, card.day, card.time, card.address, card.by_id], ['booking', 'confirmed', '2026-10-02', '20:00', 'Av. Almirante Reis 1', 'mem_sam']);
    assert.match(card.note, /Table for 4/);
    const ev = db.prepare("SELECT kind, summary, item_id FROM num_plan_events WHERE plan_id='pl_1' ORDER BY id DESC LIMIT 1").get();
    assert.equal(ev.kind, 'booked');
    assert.equal(ev.item_id, r.item_id);
    assert.match(ev.summary, /Cervejaria Ramiro confirmed Sam’s table for 4 — 2026-10-02 20:00/);

    const again = await tableAnswered(env, { row, verdict: 'confirmed', address: 'Av. Almirante Reis 1' });
    assert.equal(again.already, true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM num_plan_items WHERE plan_id='pl_1'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM num_plan_events WHERE kind='booked'").get().n, 1);
  });

  test('confirmed lands even on a locked plan — the world answering is not a member moving things', async () => {
    await post('/plan', { me: 'mem_dre', id: plan, lock: true });
    const r = await tableAnswered(env, { row: { ...row, id: 'req_locked' }, verdict: 'confirmed' });
    assert.equal(r.ok, true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM num_plan_items WHERE plan_id='pl_1' AND status='confirmed'").get().n, 1);
  });

  test('declined → a line in the group chat, no card', async () => {
    const r = await tableAnswered(env, { row: { ...row, id: 'req_no' }, verdict: 'declined' });
    assert.equal(r.declined, true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM num_plan_items WHERE plan_id='pl_1'").get().n, 0);
    const ev = db.prepare("SELECT kind, summary FROM num_plan_events WHERE plan_id='pl_1' ORDER BY id DESC LIMIT 1").get();
    assert.equal(ev.kind, 'declined');
    assert.match(ev.summary, /couldn’t take Sam’s table for 4 \(2026-10-02 20:00\) — pick again\?/);
  });

  test('a request with no plan, or a plan that is gone, is a quiet no', async () => {
    assert.equal((await tableAnswered(env, { row: { ...row, plan_id: null }, verdict: 'confirmed' })).ok, false);
    assert.equal((await tableAnswered(env, { row: { ...row, plan_id: 'pl_gone' }, verdict: 'confirmed' })).ok, false);
  });
});

describe('the agenda: your day across every plan, with who', () => {
  test('dated things from every plan I am on, each with the people who are IN (owner counts, OUT does not, unsure flagged)', async () => {
    db.prepare("INSERT INTO num_plans (id, title, owner_id, starts_on, join_code) VALUES ('pl_2','Porto day','mem_sam','2026-10-05','POR001')").run();
    db.prepare("INSERT INTO num_plan_members (plan_id, member_id, name, role, vote) VALUES ('pl_2','mem_sam','Sam','owner',NULL),('pl_2','mem_dre','Dre','member','in'),('pl_2','mem_viv','Viv','member','out')").run();
    db.prepare("UPDATE num_plan_members SET vote='in' WHERE plan_id='pl_1' AND member_id='mem_sam'").run();
    await addItem('mem_dre', { title: 'Ramiro', day: '2026-10-02', time: '20:00' });
    await addItem('mem_dre', { title: 'Dropped thing', day: '2026-10-02', time: '21:00', status: 'cancelled' });
    db.prepare("INSERT INTO num_plan_items (id, plan_id, kind, title, day, time, status) VALUES ('it_porto','pl_2','idea','Francesinha','2026-10-05','13:00','idea')").run();
    db.prepare("INSERT INTO num_plan_items (id, plan_id, kind, title, day, time, status) VALUES ('it_far','pl_2','idea','Too far out','2026-11-05','13:00','idea')").run();

    const r = await read(await get('/agenda', { me: 'mem_dre', from: '2026-10-01', to: '2026-10-10' }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((i) => [i.plan_title, i.title, i.day, i.time]), [['Lisbon', 'Ramiro', '2026-10-02', '20:00'], ['Porto day', 'Francesinha', '2026-10-05', '13:00']], 'cancelled and out-of-window things are not on the day');
    const lisbon = r.body.items[0].with.map((p) => [p.name, p.sure]);
    assert.deepEqual(lisbon, [['Dre', true], ['Sam', true], ['Viv', false]], 'owner in by definition, IN is sure, no answer is unsure');
    const porto = r.body.items[1].with.map((p) => p.name);
    assert.deepEqual(porto, ['Sam', 'Dre'], 'Viv said OUT — not on the day');
  });

  test('bad dates are refused; a stranger sees nothing', async () => {
    assert.equal((await read(await get('/agenda', { me: 'mem_dre', from: 'next week', to: '2026-10-10' }))).status, 400);
    const r = await read(await get('/agenda', { me: 'mem_stranger', from: '2026-10-01', to: '2026-10-10' }));
    assert.deepEqual(r.body.items, []);
  });
});
