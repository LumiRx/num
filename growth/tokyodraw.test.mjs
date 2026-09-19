// The Tokyo draw: is the weighting real, and can a stranger check the result?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  CAMPAIGN, LADDER, entriesFor, toNextEntry, ticketsFor, memberOfTicket,
  standings, standingFor, runTokyoDraw,
} from './tokyodraw.mjs';
import { pickWinners } from '../worker/fridaydraw.mjs';

const load = (f) => readFileSync(new URL('../worker/migrations/' + f, import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE num_members (id TEXT PRIMARY KEY, name TEXT, referred_by TEXT,
      phone TEXT, phone_verified INTEGER DEFAULT 0, email_verified INTEGER DEFAULT 0,
      identity_verified INTEGER DEFAULT 0, bio TEXT);
    CREATE TABLE num_identity_signals (member_id TEXT PRIMARY KEY, device_id TEXT,
      ip_hash TEXT, ua_hash TEXT, country TEXT);
    CREATE TABLE num_messages (id TEXT PRIMARY KEY, member_ref TEXT, body TEXT);
    CREATE TABLE num_giveaway_results (id TEXT PRIMARY KEY, week_start INTEGER NOT NULL,
      drawn_at TEXT NOT NULL, seed TEXT NOT NULL, eligible_count INTEGER NOT NULL,
      winners TEXT NOT NULL, note TEXT, campaign TEXT);
    CREATE TABLE num_giveaway_claims (draw_id TEXT NOT NULL, entrant_key TEXT NOT NULL,
      phone TEXT, member_id TEXT, state TEXT DEFAULT 'won', claimed_at TEXT,
      forfeited_at TEXT, reason TEXT, campaign TEXT, PRIMARY KEY (draw_id, entrant_key));
  `);
  // The free-entry table comes from the real migration, so its uniqueness
  // rules are the ones production will actually enforce.
  const sql = load('0055_niches_and_tokyo.sql').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) {
    try { db.exec(stmt + ';'); } catch { /* the ALTERs target tables this fixture already shaped */ }
  }
  return db;
}
const nz = (v) => (v === undefined ? null : v);
function expand(sql, binds) {
  if (!/\?\d/.test(sql)) return { sql, args: binds.map(nz) };
  const args = [];
  const out = sql.replace(/\?(\d+)/g, (_, n) => { args.push(nz(binds[Number(n) - 1])); return '?'; });
  return { sql: out, args };
}
const env = (db) => ({
  DB: {
    prepare(sql) {
      const binds = [];
      const go = (fn) => { const e = expand(sql, binds); return db.prepare(e.sql)[fn](...e.args); };
      const api = {
        bind(...a) { binds.push(...a); return api; },
        async first() { return go('all')[0] ?? null; },
        async all() { return { results: go('all') }; },
        async run() { const r = go('run'); return { ...r, meta: { changes: Number(r.changes ?? 0) } }; },
      };
      return api;
    },
  },
});
/**
 * Bring in `n` people who are REAL by every rule in entryquality.mjs: their
 * own device, a verified phone, and something done in NUM.
 *
 * The fixture has to be this specific since 19 Sep. Before the quality rules
 * a bare row counted, which is exactly the hole a farm walked through — so a
 * test fixture that still produced bare rows would be testing a draw nobody
 * ships.
 */
function bring(db, referrer, n, from = 0, opts = {}) {
  for (let i = 0; i < n; i++) {
    const id = `${referrer}_f${from + i}`;
    db.prepare(`INSERT INTO num_members (id,referred_by,phone,phone_verified) VALUES (?,?,?,1)`)
      .run(id, referrer, '+4477' + from + i);
    db.prepare('INSERT INTO num_identity_signals (member_id,device_id,ip_hash,ua_hash) VALUES (?,?,?,?)')
      .run(id, opts.device || 'dev_' + id, 'ip_' + id, 'ua_' + id);
    db.prepare('INSERT INTO num_messages (id,member_ref,body) VALUES (?,?,?)')
      .run('msg_' + id, id, 'hello');
  }
  // The referrer needs a row of their own to be an entrant.
  db.prepare('INSERT OR IGNORE INTO num_members (id) VALUES (?)').run(referrer);
}

/* ── the ladder ────────────────────────────────────────────────────────── */

test('the ladder is the shape Dre asked for, sized to the product', () => {
  assert.equal(entriesFor(0), 0);
  assert.equal(entriesFor(LADDER.first - 1), 0);
  assert.equal(entriesFor(LADDER.first), 1);
  assert.equal(entriesFor(LADDER.second - 1), 1);
  assert.equal(entriesFor(LADDER.second), 2);
  assert.equal(entriesFor(LADDER.second + LADDER.step), 3);
  assert.equal(entriesFor(LADDER.second + LADDER.step * 4), 6);
});

test('entries never go down as somebody brings more people', () => {
  let last = 0;
  for (let n = 0; n < 500; n++) {
    const e = entriesFor(n);
    assert.ok(e >= last, `entries fell at ${n}`);
    last = e;
  }
});

test('the card can always say how many more people until the next entry', () => {
  assert.equal(toNextEntry(0), LADDER.first);
  assert.equal(toNextEntry(LADDER.first), LADDER.second - LADDER.first);
  assert.equal(toNextEntry(LADDER.second), LADDER.step);
  // Never zero, never negative: "0 more to go" on a card that has not moved
  // reads as a bug.
  for (let n = 0; n < 400; n++) assert.ok(toNextEntry(n) > 0, `to_next was ${toNextEntry(n)} at ${n}`);
});

test('nonsense in is zero out, not a crash or a free entry', () => {
  for (const bad of [null, undefined, -5, 'lots', NaN, Infinity]) {
    assert.equal(entriesFor(bad), 0, String(bad));
  }
});

/* ── THE BUG THIS DESIGN EXISTS TO AVOID ───────────────────────────────── */

test('weighting is REAL — pickWinners de-duplicates ids, so repeats would flatten it', () => {
  // Proof of the hazard, kept as a test so nobody "simplifies" tickets back
  // into repeated ids: three copies of one id collapse to one.
  assert.deepEqual(pickWinners(['a', 'a', 'a'], 3, 'seed'), ['a']);
  // Tickets survive, because they are genuinely different strings.
  assert.equal(pickWinners(ticketsFor('a', 3), 3, 'seed').length, 3);
});

test('ten entries really is ten times the tickets of one', () => {
  assert.equal(ticketsFor('m1', 10).length, 10);
  assert.equal(new Set(ticketsFor('m1', 10)).size, 10);
  assert.equal(memberOfTicket('m1#7'), 'm1');
});

test('a weighted field is actually won more often by the heavier entrant', () => {
  // Not a fairness proof — a distribution check. With 10 tickets against 1,
  // the heavy entrant should win the clear majority over many seeds.
  let heavy = 0;
  for (let i = 0; i < 300; i++) {
    const tickets = [...ticketsFor('big', 10), ...ticketsFor('small', 1)];
    const order = pickWinners(tickets, tickets.length, 'seed-' + i);
    if (memberOfTicket(order[0]) === 'big') heavy++;
  }
  assert.ok(heavy > 230, `heavier entrant won ${heavy}/300 — the weighting is not biting`);
  assert.ok(heavy < 300, 'the lighter entrant never won once, which is not a draw');
});

/* ── reproducibility: the property the rules promise ───────────────────── */

test('the same seed and the same tickets give the same winner, always', async () => {
  const db = freshDb();
  bring(db, 'm_a', 60); bring(db, 'm_b', 30); bring(db, 'm_c', 25);
  const first = await runTokyoDraw(env(db), { seed: 'fixed-seed-1' });
  assert.equal(first.ok, true);

  const db2 = freshDb();
  bring(db2, 'm_a', 60); bring(db2, 'm_b', 30); bring(db2, 'm_c', 25);
  const second = await runTokyoDraw(env(db2), { seed: 'fixed-seed-1' });
  assert.deepEqual(second.winners, first.winners, 'the draw is not reproducible');
});

test('the seed and the whole ticket list are handed back so it can be checked', async () => {
  const db = freshDb();
  bring(db, 'm_a', 50);
  const r = await runTokyoDraw(env(db), { seed: 'check-me' });
  assert.equal(r.verify.seed, 'check-me');
  assert.equal(r.verify.tickets.length, 2, 'fifty people is two entries');
  // And the recorded row carries the seed, which is what makes it checkable
  // after everyone has forgotten the API response.
  const row = db.prepare('SELECT * FROM num_giveaway_results').get();
  assert.equal(row.seed, 'check-me');
  assert.equal(row.campaign, CAMPAIGN);
  assert.equal(row.eligible_count, 2);
});

test('one person cannot win the same trip twice', async () => {
  const db = freshDb();
  bring(db, 'm_solo', 200);
  const r = await runTokyoDraw(env(db), { seed: 's', winners: 3 });
  assert.deepEqual(r.winners, ['m_solo'], 'the only entrant should win once, not three times');
});

test('an empty draw is refused loudly, not reported as a calm week', async () => {
  const db = freshDb();
  bring(db, 'm_a', 3); // below the first rung
  const r = await runTokyoDraw(env(db), { seed: 's' });
  assert.equal(r.ok, false);
  assert.match(r.why, /nobody has an entry/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_giveaway_results').get().n, 0);
});

/* ── the free route, which is what keeps it lawful ─────────────────────── */

test('a free entry counts, without anybody being referred', async () => {
  const db = freshDb();
  db.prepare('INSERT INTO num_members (id) VALUES (?)').run('m_free');
  db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,member_id,entries,source,created_at)
              VALUES ('f1',?,'m_free',1,'form','2026-09-19')`).run(CAMPAIGN);
  const s = await standingFor(env(db), 'm_free');
  assert.equal(s.referred, 0);
  assert.equal(s.earned, 0);
  assert.equal(s.free, 1);
  assert.equal(s.entries, 1, 'the free route did not actually put them in the draw');
  const all = await standings(env(db));
  assert.deepEqual(all.map((r) => r.member_id), ['m_free']);
});

test('free and earned entries stack — the free door is not a trap', async () => {
  const db = freshDb();
  bring(db, 'm_x', 50);
  db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,member_id,entries,source,created_at)
              VALUES ('f1',?,'m_x',1,'form','2026-09-19')`).run(CAMPAIGN);
  const s = await standingFor(env(db), 'm_x');
  assert.equal(s.earned, 2);
  assert.equal(s.entries, 3, 'using the free route cost them an earned entry');
});

test('the same person cannot take the free entry twice', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,member_id,entries,source,created_at)
              VALUES ('f1',?,'m_x',1,'form','2026-09-19')`).run(CAMPAIGN);
  assert.throws(() => {
    db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,member_id,entries,source,created_at)
                VALUES ('f2',?,'m_x',1,'form','2026-09-19')`).run(CAMPAIGN);
  }, 'the free route is unlimited, which makes the ladder meaningless');
});

test('standings rank by entries and are computed, never stored', async () => {
  const db = freshDb();
  bring(db, 'm_big', 100); bring(db, 'm_mid', 50); bring(db, 'm_small', 25);
  const s = await standings(env(db));
  assert.deepEqual(s.map((r) => r.member_id), ['m_big', 'm_mid', 'm_small']);
  assert.deepEqual(s.map((r) => r.entries), [4, 2, 1]);
  // Nothing was written to get that answer.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM num_draw_free_entries').get().n, 0);
});

/* ══ IS IT GAMABLE? ═══════════════════════════════════════════════════
   Dre, 19 Sep 2026. These run the whole thing — counting, dedupe and the
   claim gate — against the attacks somebody would actually try. */

function farm(db, referrer, n, device = 'one_phone') {
  // Twenty accounts on one handset. Verified, active, plausible — and all
  // from the same device, which is the only thing that gives them away.
  for (let i = 0; i < n; i++) {
    const id = `${referrer}_farm${i}`;
    db.prepare('INSERT INTO num_members (id,referred_by,phone,phone_verified) VALUES (?,?,?,1)')
      .run(id, referrer, '+4499' + i);
    db.prepare('INSERT INTO num_identity_signals (member_id,device_id,ip_hash,ua_hash) VALUES (?,?,?,?)')
      .run(id, device, 'ip_farm', 'ua_farm');
    db.prepare('INSERT INTO num_messages (id,member_ref,body) VALUES (?,?,?)').run('m' + id, id, 'hi');
  }
  db.prepare('INSERT OR IGNORE INTO num_members (id) VALUES (?)').run(referrer);
}

test('a hundred accounts on one phone do not buy a single entry', async () => {
  const db = freshDb();
  farm(db, 'm_cheat', 100);
  const s = await standings(env(db));
  assert.deepEqual(s, [], 'the farm got into the draw');
  const r = await runTokyoDraw(env(db), { seed: 's' });
  assert.equal(r.ok, false);
});

test('a real ambassador beside a farm still wins their entries', async () => {
  // The farm must not be stopped by rejecting everybody.
  const db = freshDb();
  bring(db, 'm_real', 30);
  farm(db, 'm_cheat', 100);
  const s = await standings(env(db));
  assert.deepEqual(s.map((x) => x.member_id), ['m_real']);
  assert.equal(s[0].entries, 1);
});

test('one person with two accounts gets what one person earns, not two', async () => {
  const db = freshDb();
  bring(db, 'm_one', 30);
  bring(db, 'm_two', 30, 100);
  // Both accounts carry the SAME verified 5arz identity, which /verify/5arz
  // would refuse — this is the belt to that braces.
  const bio = JSON.stringify({ '5arz_id': 'mem_sameperson' });
  for (const id of ['m_one', 'm_two']) {
    db.prepare('UPDATE num_members SET bio=?, identity_verified=1 WHERE id=?').run(bio, id);
  }
  const s = await standings(env(db));
  assert.equal(s.length, 1, 'two accounts stayed two entrants');
  assert.equal(s[0].accounts, 2);
  // 60 counted referrals between them: two entries, not one-plus-one from
  // each side of a split that would have been worth the same anyway.
  assert.equal(s[0].referred, 60);
  assert.equal(s[0].entries, entriesFor(60));
});

test('splitting referrals across accounts is never better than keeping them together', async () => {
  const together = freshDb();
  bring(together, 'm_solo', 60);
  const a = await standings(env(together));

  const split = freshDb();
  bring(split, 'm_a', 30);
  bring(split, 'm_b', 30, 100);
  const bio = JSON.stringify({ '5arz_id': 'mem_same' });
  for (const id of ['m_a', 'm_b']) {
    split.prepare('UPDATE num_members SET bio=?, identity_verified=1 WHERE id=?').run(bio, id);
  }
  const b = await standings(env(split));
  assert.equal(b[0].entries, a[0].entries, 'splitting changed the answer, so there is an incentive to split');
});

test('two accounts cannot take the free entry twice', async () => {
  const db = freshDb();
  const bio = JSON.stringify({ '5arz_id': 'mem_same' });
  for (const id of ['m_a', 'm_b']) {
    db.prepare('INSERT INTO num_members (id,bio,identity_verified) VALUES (?,?,1)').run(id, bio);
    db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,member_id,entries,source,created_at)
                VALUES (?,?,?,1,'form','2026-09-19')`).run('f_' + id, CAMPAIGN, id);
  }
  const s = await standings(env(db));
  assert.equal(s.length, 1, 'one person held two free entries');
  assert.equal(s[0].entries, 1);
});

/* ── the claim gate ────────────────────────────────────────────────────── */

test('an unverified winner is told to verify, and has not forfeited', async () => {
  const db = freshDb();
  bring(db, 'm_win', 30);
  const r = await runTokyoDraw(env(db), { seed: 's' });
  assert.deepEqual(r.winners, ['m_win']);
  assert.equal(r.claimable[0].can_claim, false);
  assert.deepEqual(r.needs_verification, ['m_win']);
  const claim = db.prepare('SELECT * FROM num_giveaway_claims').get();
  // Still 'won'. Verification is a step before release, not a disqualification.
  assert.equal(claim.state, 'won');
  assert.match(claim.reason, /5arz verification/);
});

test('a 5arz-verified winner can claim outright', async () => {
  const db = freshDb();
  bring(db, 'm_win', 30);
  db.prepare("UPDATE num_members SET identity_verified=1, bio=? WHERE id='m_win'")
    .run(JSON.stringify({ '5arz_id': 'mem_real' }));
  const r = await runTokyoDraw(env(db), { seed: 's' });
  assert.equal(r.claimable[0].can_claim, true);
  assert.deepEqual(r.needs_verification, []);
  assert.equal(db.prepare('SELECT reason FROM num_giveaway_claims').get().reason, null);
});

test('the standings say who could claim, so nobody finds out at the end', async () => {
  const db = freshDb();
  bring(db, 'm_x', 30);
  const s = await standings(env(db));
  assert.equal(s[0].can_claim, false);
});

/* ── and the ambassador is told why their number is what it is ─────────── */

test('an ambassador can see how many counted and why the rest did not', async () => {
  const db = freshDb();
  bring(db, 'm_amb', 10);
  farm(db, 'm_amb', 20, 'shared_phone');
  const st = await standingFor(env(db), 'm_amb');
  assert.equal(st.joined, 30);
  // Ten real, plus one kept from the shared device: nineteen rejected.
  assert.equal(st.referred, 11);
  assert.equal(st.not_counted, 19);
  const cluster = st.reasons.find((r) => r.key === 'cluster');
  assert.ok(cluster, 'no reason was given for nineteen missing signups');
  assert.equal(cluster.n, 19);
  assert.ok(cluster.why.length > 25);
});

/* ══ THE REVIEW FINDINGS, 19 SEP 2026 ═════════════════════════════════ */

test('a postal free entry actually enters the draw — it was write-only', () => {
  // The worst bug in the draw. standings() filtered `member_id IS NOT NULL`,
  // so every entry granted by hand to somebody who wrote in was recorded,
  // acknowledged, and then excluded — a zero chance of winning while every
  // surface said they were entered. The legal position rests on this route
  // being real.
  const db = freshDb();
  db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,email,name,entries,source,created_at)
              VALUES ('f1',?,'writer@example.com','A Writer',1,'post','2026-09-19')`).run(CAMPAIGN);
  return standings(env(db)).then((s) => {
    assert.equal(s.length, 1, 'the postal entrant is not in the draw');
    assert.equal(s[0].entries, 1);
    assert.equal(s[0].postal, true);
  });
});

test('a postal entrant can actually be drawn as the winner', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,email,entries,source,created_at)
              VALUES ('f1',?,'writer@example.com',1,'post','2026-09-19')`).run(CAMPAIGN);
  const r = await runTokyoDraw(env(db), { seed: 's' });
  assert.equal(r.ok, true);
  assert.equal(r.winners.length, 1);
  assert.match(r.winners[0], /^email:writer@example\.com/);
  // And they must still verify, like anybody else.
  assert.equal(r.claimable[0].can_claim, false);
});

test('a postal entrant is not merged with anybody else', async () => {
  const db = freshDb();
  bring(db, 'm_amb', 30);
  for (const e of ['a@x.com', 'b@x.com']) {
    db.prepare(`INSERT INTO num_draw_free_entries (id,campaign,email,entries,source,created_at)
                VALUES (?,?,?,1,'post','2026-09-19')`).run('f_' + e, CAMPAIGN, e);
  }
  const s = await standings(env(db));
  assert.equal(s.length, 3, 'postal entrants collapsed into one another');
  assert.equal(s.filter((r) => r.postal).length, 2);
});

test('running the draw twice does not crown a second winner', async () => {
  // num_giveaway_claims is keyed on (draw_id, entrant_key), so a second run
  // with a fresh seed used to insert a DIFFERENT winner under the same draw
  // id — two people told they had won one trip. A double-click was enough.
  const db = freshDb();
  bring(db, 'm_a', 30);
  bring(db, 'm_b', 60, 500);
  const first = await runTokyoDraw(env(db), { seed: 'seed-one' });
  const second = await runTokyoDraw(env(db), { seed: 'a-different-seed' });

  assert.equal(second.already, true);
  assert.deepEqual(second.winners, first.winners, 'a second run picked a different winner');
  assert.equal(second.seed, first.seed, 'the published seed changed under the recorded result');
  const claims = db.prepare("SELECT COUNT(*) n FROM num_giveaway_claims WHERE state='won'").get();
  assert.equal(claims.n, 1, claims.n + ' people were told they won one trip');
});

test('a seed handed in cannot be ground against a recorded draw', async () => {
  const db = freshDb();
  bring(db, 'm_a', 30);
  bring(db, 'm_b', 30, 500);
  const first = await runTokyoDraw(env(db), { seed: 's0' });
  for (const s of ['s1', 's2', 's3', 's4', 's5']) {
    const again = await runTokyoDraw(env(db), { seed: s });
    assert.deepEqual(again.winners, first.winners, 'seed ' + s + ' changed the winner');
  }
});

test('a broken read of the free-entry table stops the draw rather than quietly excluding it', async () => {
  const db = freshDb();
  bring(db, 'm_a', 30);
  db.exec('DROP TABLE num_draw_free_entries');
  // The old code caught this into an empty list, drew a winner from referral
  // tickets alone with every lawful entrant missing, and reported success.
  await assert.rejects(() => standings(env(db)));
});
