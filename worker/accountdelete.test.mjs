/**
 * DELETING AN ACCOUNT MUST ACTUALLY BE POSSIBLE.
 *
 * 10 Sep 2026. The delete button was wired, the endpoint existed, the SQL was
 * thorough — and no member holding Stars could ever finish. A balance was a
 * BLOCKER, cash-out is switched off, so the only instruction ("spend it
 * first") could not be followed. Dre held ★100 and hit the wall in his own
 * app; it read as a broken button because functionally it was one.
 *
 * The rule these tests hold down: block only what hurts SOMEBODY ELSE. A live
 * errand leaves a person waiting; an open tab leaves the table short. A Stars
 * balance is the leaver's own to give up.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleAccount } from './account.mjs';

let db; let env;
const d1 = (database) => ({
  prepare: (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    const run = () => {
      const text = sql.replace(/\?(\d+)/g, () => '?');
      const order = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]) - 1);
      return { text, args: order.map((n) => st.binds[n]) };
    };
    st.first = async () => { const { text, args } = run(); return database.prepare(text).get(...args) ?? null; };
    st.all = async () => { const { text, args } = run(); return { results: database.prepare(text).all(...args) }; };
    st.run = async () => { const { text, args } = run(); const r = database.prepare(text).run(...args); return { meta: { changes: r.changes } }; };
    return st;
  },
  batch: async (sts) => { for (const s of sts) await s.run(); return []; },
});

const ME = 'mem_test';
const post = (body) => new Request('https://x/api/account/delete', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const call = async (body) => {
  const r = await handleAccount(post(body), env, '/delete');
  return { status: r.status, body: await r.json() };
};

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT)`);
  db.prepare('INSERT INTO num_members VALUES (?,?)').run(ME, 'Dre');
  db.exec(`CREATE TABLE num_star_balances (member_id TEXT PRIMARY KEY, stars INTEGER)`);
  db.exec(`CREATE TABLE num_errands (id TEXT PRIMARY KEY, poster_id TEXT, runner_id TEXT, state TEXT)`);
  db.exec(`CREATE TABLE num_tabs (id TEXT PRIMARY KEY, state TEXT)`);
  db.exec(`CREATE TABLE num_tab_members (tab_id TEXT, member_id TEXT)`);
  for (const t of ['num_links (a_id TEXT, b_id TEXT, state TEXT)',
    'num_plans (id TEXT, owner_id TEXT)', 'num_plan_members (plan_id TEXT, member_id TEXT)',
    'num_plan_events (plan_id TEXT)', 'num_plan_items (plan_id TEXT)',
    'num_dms (from_id TEXT, to_id TEXT)', 'num_push_subs (member_id TEXT)',
    'num_notifications (member_id TEXT)', 'num_inbox (member_id TEXT)',
    'num_blocks (member_id TEXT, blocked_id TEXT)', 'num_asks (member_id TEXT)',
    'num_usage (member_id TEXT)', 'num_usage_counters (member_id TEXT)',
    'num_place_impressions (member_id TEXT)', 'num_identity_signals (member_id TEXT)',
    'num_signin_events (member_id TEXT)', 'num_member_facts (member_id TEXT)',
    'num_nudges (member_id TEXT)', 'num_affiliate_clicks (member_id TEXT)',
    'num_scouts (member_id TEXT)', 'num_memberships (member_id TEXT)',
    'num_event_guests (member_id TEXT)', 'num_item_attendees (member_id TEXT)']) {
    db.exec(`CREATE TABLE ${t}`);
  }
  env = { DB: d1(db) };
});

const gone = () => !db.prepare('SELECT id FROM num_members WHERE id=?').get(ME);

describe('the exact wall Dre hit', () => {
  test('★100 no longer blocks deletion', async () => {
    db.prepare('INSERT INTO num_star_balances VALUES (?,100)').run(ME);
    const look = await call({ me: ME });
    assert.equal(look.body.can_delete, true, 'a Stars balance must not be a blocker');
    assert.deepEqual(look.body.blockers, []);
  });

  test('but it is stated plainly before they confirm', async () => {
    db.prepare('INSERT INTO num_star_balances VALUES (?,100)').run(ME);
    const look = await call({ me: ME });
    assert.equal(look.body.forfeits.length, 1);
    assert.match(look.body.forfeits[0], /★100/);
    assert.match(look.body.forfeits[0], /cannot be refunded/i);
  });

  test('and the delete actually completes', async () => {
    db.prepare('INSERT INTO num_star_balances VALUES (?,100)').run(ME);
    const out = await call({ me: ME, confirm: 'DELETE' });
    assert.equal(out.body.ok, true);
    assert.equal(out.body.deleted, true);
    assert.ok(gone(), 'the member row is still there — the account was not deleted');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM num_star_balances WHERE member_id=?').get(ME).n, 0,
      'the balance must go with the account');
  });

  test('the server tells the app to start the member over', async () => {
    const out = await call({ me: ME, confirm: 'DELETE' });
    assert.equal(out.body.restart, true,
      'without this the app may leave a deleted account signed in');
  });
});

describe('what still blocks, and why', () => {
  test('a live errand blocks — someone else is waiting', async () => {
    db.prepare("INSERT INTO num_errands VALUES ('e1',?,NULL,'running')").run(ME);
    const look = await call({ me: ME });
    assert.equal(look.body.can_delete, false);
    assert.match(look.body.blockers[0], /errand/i);
  });

  test('an open tab blocks — the table is left short', async () => {
    db.prepare("INSERT INTO num_tabs VALUES ('t1','open')").run();
    db.prepare('INSERT INTO num_tab_members VALUES (?,?)').run('t1', ME);
    const look = await call({ me: ME });
    assert.equal(look.body.can_delete, false);
    assert.match(look.body.blockers[0], /tab/i);
  });

  test('a blocked confirm refuses AND says why — never a bare shrug', async () => {
    db.prepare("INSERT INTO num_errands VALUES ('e1',?,NULL,'running')").run(ME);
    const out = await call({ me: ME, confirm: 'DELETE' });
    assert.equal(out.status, 409);
    assert.ok(out.body.blockers.length, 'the refusal must carry its reason to the UI');
    assert.ok(!gone());
  });

  test('a settled errand does not block — it is over', async () => {
    db.prepare("INSERT INTO num_errands VALUES ('e1',?,NULL,'settled')").run(ME);
    assert.equal((await call({ me: ME })).body.can_delete, true);
  });

  test('every blocker is something the member can clear themselves', async () => {
    // Apple 5.1.1(v): deletion must be completable in the app. A precondition
    // the member cannot satisfy is the same as offering no deletion at all —
    // which is exactly what the Stars blocker was.
    db.prepare('INSERT INTO num_star_balances VALUES (?,500)').run(ME);
    db.prepare("INSERT INTO num_errands VALUES ('e1',?,NULL,'running')").run(ME);
    const look = await call({ me: ME });
    for (const b of look.body.blockers) {
      assert.ok(/errand|tab/i.test(b), `"${b}" cannot be cleared inside the app`);
    }
  });
});

describe('the two-step confirmation still stands', () => {
  test('no confirm phrase, no deletion', async () => {
    const look = await call({ me: ME });
    assert.equal(look.body.needs_confirm, true);
    assert.ok(!gone(), 'inspecting must never delete');
  });

  test('the wrong phrase deletes nothing', async () => {
    const out = await call({ me: ME, confirm: 'delete please' });
    assert.equal(out.body.needs_confirm, true);
    assert.ok(!gone());
  });

  test('an unknown member is refused', async () => {
    assert.equal((await call({ me: 'nobody', confirm: 'DELETE' })).status, 404);
  });
});
