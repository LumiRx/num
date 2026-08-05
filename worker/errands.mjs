// Errands — "someone go and get this for me", with the money held up front.
//
// Two halves that only work together:
//
//   1. FIND IT.  "Where do I get a phone charger at 10pm in Bangkok" is a
//      question Num can already answer from local knowledge and the services
//      map. That half needs no new plumbing.
//   2. GET IT HERE.  Which is either a courier, or a person.
//
// The second half is the product. A traveller who cannot leave a meeting, a
// parent whose kid forgot a charger, someone who just does not want to walk
// twenty minutes — they will happily pay somebody nearby to go. Every part of
// that already exists on Num: members, Stars, push, and a real courier in
// DoorDash Drive when no human is about.
//
// ── THE ONE THING THAT MATTERS ─────────────────────────────────────────────
//
// ESCROW. When Dre posts "collect my order from Terminal 21, ★200", those
// Stars leave Dre's balance THE MOMENT IT IS POSTED and sit in escrow. They do
// not sit in Dre's account with a promise attached.
//
// Without that, the runner is working on a hope: Dre could spend the same
// Stars twice over while the runner is in a taxi, and the runner finds out
// when they try to get paid. One person doing unpaid work because the app let
// the money move is enough to kill a marketplace, because the story travels
// further than the feature does.
//
// So: funded or it is not posted. The board only ever shows errands whose
// money is already sitting still. Every state change is a single conditional
// UPDATE that names the state it expects, so two phones racing to claim the
// same errand cannot both win, and completing twice cannot pay twice.
//
// The escrow is held against a reserved member id rather than a floating
// column, so the ledger still balances if you sum every row — an escrow you
// cannot audit is just a number someone can be talked into changing.

import { notify } from './push.mjs';
import { ensureBalance } from './social.mjs';
import { driveReady, quote as driveQuote, accept as driveAccept } from './doordash.mjs';

const ESCROW = '__escrow__';
const MAX_BOUNTY = 20_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const readBody = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
const code = (n = 6) => {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
};

/**
 * The lifecycle, and who is allowed to move it.
 *
 * Written as data rather than as a pile of if-statements because this is the
 * part that must be provably right: every transition names the state it comes
 * from, so the SQL can assert it and the race resolves itself.
 */
const FLOW = {
  open: { claim: 'claimed', cancel: 'cancelled' },
  claimed: { pickup: 'collected', giveup: 'open', cancel: 'cancelled' },
  collected: { deliver: 'delivered', giveup: 'open' },
  delivered: { confirm: 'settled', dispute: 'disputed' },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS num_errands (
  id TEXT PRIMARY KEY,
  poster_id TEXT NOT NULL,
  runner_id TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  where_from TEXT,
  deliver_to TEXT NOT NULL,
  bounty INTEGER NOT NULL,
  spend_cap INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open',
  handoff_code TEXT NOT NULL,
  place TEXT,
  courier TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT, collected_at TEXT, delivered_at TEXT, settled_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_errand_state ON num_errands(state, place);
CREATE INDEX IF NOT EXISTS idx_errand_poster ON num_errands(poster_id);
CREATE INDEX IF NOT EXISTS idx_errand_runner ON num_errands(runner_id);
CREATE TABLE IF NOT EXISTS num_errand_events (
  id TEXT PRIMARY KEY, errand_id TEXT NOT NULL, actor_id TEXT, kind TEXT NOT NULL,
  detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_errand_events ON num_errand_events(errand_id);
`;
let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  // The escrow account is a real row in the ledger, so "how much is held right
  // now" is a query rather than a belief.
  await env.DB.prepare('INSERT OR IGNORE INTO num_star_balances (member_id, stars) VALUES (?1, 0)').bind(ESCROW).run();
  ready = true;
}

const logEvent = (env, errandId, actorId, kind, detail) =>
  env.DB.prepare('INSERT INTO num_errand_events (id, errand_id, actor_id, kind, detail) VALUES (?1,?2,?3,?4,?5)')
    .bind(uid('ev'), errandId, actorId ?? null, kind, clip(detail, 300))
    .run()
    .catch((e) => console.warn('[errands] event log failed', e?.message ?? e));

/**
 * Move Stars into or out of escrow, always as a matched pair of ledger rows.
 *
 * Both sides get a balance row FIRST. This is not defensive noise: a runner
 * who has never been paid before has no row yet, and `UPDATE ... WHERE
 * member_id = <them>` then matches zero rows and reports success, because an
 * UPDATE that hits nothing is not an error in SQL. The debit leaves escrow,
 * the credit lands nowhere, and the Stars are simply gone. It cost this
 * feature ★70 on its first end-to-end run.
 */
async function moveEscrow(env, { memberId, amount, into, ref, note }) {
  const from = into ? memberId : ESCROW;
  const to = into ? ESCROW : memberId;

  await ensureBalance(env, memberId);

  // Conditional debit: the balance must actually cover it. This is the check
  // that makes "funded" mean something.
  const debit = await env.DB.prepare('UPDATE num_star_balances SET stars = stars - ?2 WHERE member_id = ?1 AND stars >= ?2')
    .bind(from, amount).run();
  if (!debit.meta?.changes) return { ok: false };

  try {
    // Assert the credit actually landed. Belt and braces on top of
    // ensureBalance, because the failure mode is silent and irreversible.
    const credit = await env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(to, amount).run();
    if (!credit.meta?.changes) throw new Error(`credit matched no row for ${to}`);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO num_star_moves (id, member_id, delta, kind, note, counterparty) VALUES (?1,?2,?3,'errand',?4,?5)")
        .bind(`${ref}:${into ? 'hold' : 'release'}`, memberId, into ? -amount : amount, clip(note, 140), ESCROW),
    ]);
  } catch (err) {
    // Put it back. A gap between the debit and the credit is the one failure
    // that is never acceptable, so the rollback is not optional.
    await env.DB.prepare('UPDATE num_star_balances SET stars = stars + ?2 WHERE member_id = ?1').bind(from, amount).run();
    console.error('[errands] escrow rolled back', err?.message ?? err);
    return { ok: false, rolled_back: true };
  }
  return { ok: true };
}

// ── posting ───────────────────────────────────────────────────────────────

/**
 * Post an errand. The Stars move here, not later.
 *
 * `spend_cap` is separate from the bounty and worth the extra field: the
 * bounty is what the runner earns, the cap is what they are authorised to lay
 * out on the thing itself. Conflating them is how a runner ends up arguing
 * about whether ★200 included the charger.
 */
async function post(env, req, ctx) {
  const b = await readBody(req);
  const me = clip(b.me, 40);
  const bounty = Math.floor(Number(b.bounty));
  const cap = Math.max(0, Math.floor(Number(b.spend_cap ?? 0)) || 0);

  if (!me) return json({ error: 'sign up first' }, 401);
  const poster = await env.DB.prepare('SELECT id, name FROM num_members WHERE id=?1').bind(me).first();
  if (!poster) return json({ error: 'sign up first' }, 404);
  if (!clip(b.title, 80)) return json({ error: 'What do you need? Give it a short title.' }, 400);
  if (!clip(b.deliver_to, 200)) return json({ error: 'Where should it be delivered?' }, 400);
  if (!Number.isFinite(bounty) || bounty <= 0) return json({ error: 'Set a bounty — what is this worth to you?' }, 400);
  if (bounty + cap > MAX_BOUNTY) return json({ error: `Bounty plus spend cap is over the ★${MAX_BOUNTY.toLocaleString()} limit.` }, 400);

  const id = uid('err');
  // Bounty AND float go into escrow together: the runner is fronting the cost
  // of the item as well as their time, and only one of those being guaranteed
  // is not a deal anyone should take.
  const held = bounty + cap;
  const moved = await moveEscrow(env, { memberId: me, amount: held, into: true, ref: id, note: clip(b.title, 60) });
  if (!moved.ok) {
    const row = await env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1').bind(me).first();
    return json(
      { error: `You need ★${held.toLocaleString()} to post this — bounty plus the spend cap. You have ★${row?.stars ?? 0}.`, balance: row?.stars ?? 0 },
      409,
    );
  }

  await env.DB.prepare(
    `INSERT INTO num_errands (id, poster_id, title, detail, where_from, deliver_to, bounty, spend_cap, handoff_code, place)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
  ).bind(
    id, me, clip(b.title, 80), clip(b.detail, 500), clip(b.where_from, 200),
    clip(b.deliver_to, 200), bounty, cap, code(6), clip(b.place, 60),
  ).run();

  await logEvent(env, id, me, 'posted', `★${bounty} bounty, ★${cap} cap`);
  // TELL SOMEBODY. The board was pull-only: an errand posted into a quiet room
  // was never seen by anyone, so the bounty sat in escrow and the thing never
  // got fetched. Friends first — the people most likely to actually go.
  try {
    const { results: friends } = await env.DB.prepare(
      `SELECT CASE WHEN a_id = ?1 THEN b_id ELSE a_id END AS id
         FROM num_links WHERE (a_id = ?1 OR b_id = ?1) AND state = 'active' LIMIT 25`,
    ).bind(me).all();
    for (const f of friends ?? []) {
      if (!f.id || f.id === me) continue;
      await notify(env, {
        memberId: f.id, kind: 'errand', title: `★${bounty} — ${clip(b.title, 80)}`,
        body: `${poster?.name || 'A friend'} needs something fetched. First to claim it earns the bounty.`,
        url: '/?app', tag: `errand:${id}`,
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('[errands] post notify', err?.message ?? err);
  }

  return json({ ok: true, errand: await one(env, id), held });
}

// ── the board ─────────────────────────────────────────────────────────────

async function one(env, id) {
  const e = await env.DB.prepare(
    `SELECT e.*, p.name AS poster_name, r.name AS runner_name
     FROM num_errands e
     LEFT JOIN num_members p ON p.id = e.poster_id
     LEFT JOIN num_members r ON r.id = e.runner_id
     WHERE e.id = ?1`,
  ).bind(id).first();
  return e ?? null;
}

/**
 * What a given person is allowed to see of an errand.
 *
 * The handoff code is the proof of delivery, so it belongs to the poster and
 * the assigned runner only. Putting it on the open board would let anyone
 * claim a delivery they never made.
 */
function visible(e, meId) {
  const mine = e.poster_id === meId;
  const running = e.runner_id === meId;
  return {
    id: e.id,
    title: e.title,
    detail: e.detail,
    where_from: e.where_from,
    // The exact drop address is not public either — a board that publishes
    // where strangers are staying is a different kind of product.
    deliver_to: mine || running ? e.deliver_to : coarse(e.deliver_to),
    bounty: e.bounty,
    spend_cap: e.spend_cap,
    state: e.state,
    place: e.place,
    poster_name: e.poster_name,
    runner_name: e.runner_name,
    created_at: e.created_at,
    courier: e.courier,
    is_mine: mine,
    is_running: running,
    ...(mine || running ? { handoff_code: e.handoff_code } : {}),
  };
}

/** Enough to judge the journey, not enough to find the door. */
const coarse = (addr) => {
  if (!addr) return null;
  const first = String(addr).split(',')[0].trim();
  return first.length > 24 ? `${first.slice(0, 24)}…` : first;
};

async function board(env, url) {
  const me = clip(url.searchParams.get('me'), 40);
  const place = clip(url.searchParams.get('place'), 60);
  const mine = url.searchParams.get('mine') === '1';

  const rows = mine
    ? await env.DB.prepare(
        `SELECT e.*, p.name AS poster_name, r.name AS runner_name FROM num_errands e
         LEFT JOIN num_members p ON p.id=e.poster_id LEFT JOIN num_members r ON r.id=e.runner_id
         WHERE e.poster_id=?1 OR e.runner_id=?1 ORDER BY e.rowid DESC LIMIT 40`,
      ).bind(me ?? '').all()
    : await env.DB.prepare(
        `SELECT e.*, p.name AS poster_name, r.name AS runner_name FROM num_errands e
         LEFT JOIN num_members p ON p.id=e.poster_id LEFT JOIN num_members r ON r.id=e.runner_id
         WHERE e.state='open' AND (?1 IS NULL OR e.place=?1) ORDER BY e.bounty DESC, e.rowid DESC LIMIT 40`,
      ).bind(place).all();

  return json({ errands: (rows.results ?? []).map((e) => visible(e, me)) });
}

// ── the state machine ─────────────────────────────────────────────────────

/**
 * Move an errand along, or say precisely why it cannot move.
 *
 * The whole transition is one UPDATE with `state = <expected>` in the WHERE
 * clause. That is what makes two people tapping "I'll go" at the same instant
 * resolve to exactly one runner: the second UPDATE matches zero rows and is
 * told the errand is already taken, rather than silently overwriting the first.
 */
async function advance(env, req, action, ctx) {
  const b = await readBody(req);
  const me = clip(b.me, 40);
  const id = clip(b.id, 40);
  if (!me || !id) return json({ error: 'me and id are required' }, 400);

  const e = await one(env, id);
  if (!e) return json({ error: 'no such errand' }, 404);

  const next = FLOW[e.state]?.[action];
  if (!next) return json({ error: `You can’t ${action} an errand that is ${e.state}.`, state: e.state }, 409);

  // Who may do what. Stated explicitly rather than inferred, because "the
  // runner can cancel" and "the poster can cancel" are very different rules.
  const isPoster = e.poster_id === me;
  const isRunner = e.runner_id === me;
  const allowed = {
    claim: !isPoster && !e.runner_id,
    giveup: isRunner,
    pickup: isRunner,
    deliver: isRunner,
    confirm: isPoster,
    dispute: isPoster,
    cancel: isPoster,
  }[action];
  if (!allowed) {
    return json(
      { error: action === 'claim' && isPoster ? 'You can’t run your own errand.' : 'That isn’t yours to do.' },
      403,
    );
  }

  switch (action) {
    case 'claim': {
      const won = await env.DB.prepare(
        "UPDATE num_errands SET state='claimed', runner_id=?2, claimed_at=datetime('now') WHERE id=?1 AND state='open' AND runner_id IS NULL",
      ).bind(id, me).run();
      if (!won.meta?.changes) return json({ error: 'Somebody just took that one.' }, 409);
      await logEvent(env, id, me, 'claimed');
      await tell(env, e.poster_id, 'Someone’s on it', `${await nameOf(env, me)} is picking up “${e.title}”.`, ctx);
      break;
    }

    case 'giveup': {
      // Back on the board rather than cancelled: the poster still wants the
      // thing, and their money is still held, so the errand should stay alive.
      const done = await env.DB.prepare(
        'UPDATE num_errands SET state=\'open\', runner_id=NULL, claimed_at=NULL, collected_at=NULL WHERE id=?1 AND runner_id=?2',
      ).bind(id, me).run();
      if (!done.meta?.changes) return json({ error: 'That isn’t yours to drop.' }, 409);
      await logEvent(env, id, me, 'gave up');
      await tell(env, e.poster_id, 'Back on the board', `“${e.title}” needs someone else.`, ctx);
      break;
    }

    case 'pickup':
    case 'deliver': {
      const col = action === 'pickup' ? 'collected_at' : 'delivered_at';
      const done = await env.DB.prepare(
        `UPDATE num_errands SET state=?3, ${col}=datetime('now') WHERE id=?1 AND runner_id=?2 AND state=?4`,
      ).bind(id, me, next, e.state).run();
      if (!done.meta?.changes) return json({ error: 'That already moved on.' }, 409);
      await logEvent(env, id, me, action);
      await tell(
        env,
        e.poster_id,
        action === 'pickup' ? 'Collected' : 'Delivered',
        action === 'pickup'
          ? `${await nameOf(env, me)} has your “${e.title}”.`
          : `“${e.title}” is with you — confirm to release ★${e.bounty}.`,
        ctx,
      );
      break;
    }

    case 'confirm': {
      // The handoff code is the proof. Requiring it means "delivered" is the
      // runner's claim and "settled" is the poster's agreement, which is the
      // right way round — the person who paid decides when it is done.
      if (clip(b.handoff_code, 10)?.toUpperCase() !== e.handoff_code) {
        return json({ error: 'That handoff code doesn’t match.' }, 400);
      }
      const spent = Math.min(e.spend_cap, Math.max(0, Math.floor(Number(b.spent ?? e.spend_cap)) || 0));
      const owed = e.bounty + spent;
      const refund = e.bounty + e.spend_cap - owed;

      const done = await env.DB.prepare(
        "UPDATE num_errands SET state='settled', settled_at=datetime('now') WHERE id=?1 AND state='delivered'",
      ).bind(id).run();
      if (!done.meta?.changes) return json({ error: 'That already settled.' }, 409);

      const paid = await moveEscrow(env, { memberId: e.runner_id, amount: owed, into: false, ref: `${id}:pay`, note: e.title });
      if (!paid.ok) {
        // Escrow should always cover this — it was funded at posting. If it
        // does not, stop rather than half-pay, and leave a loud trail.
        await env.DB.prepare("UPDATE num_errands SET state='disputed', note='escrow short at settle' WHERE id=?1").bind(id).run();
        await logEvent(env, id, me, 'escrow-short', `owed ${owed}`);
        return json({ error: 'Something is wrong with the escrow on this errand — it’s been flagged, nothing moved.' }, 500);
      }
      if (refund > 0) {
        await moveEscrow(env, { memberId: e.poster_id, amount: refund, into: false, ref: `${id}:refund`, note: `${e.title} — unspent` });
      }
      await logEvent(env, id, me, 'settled', `paid ${owed}, refunded ${refund}`);
      await tell(env, e.runner_id, `★${owed} paid`, `“${e.title}” is settled. Nice one.`, ctx);
      break;
    }

    case 'cancel': {
      // Only refundable while nobody has done any work. Once claimed, the
      // poster cancelling would mean the runner ate the trip.
      const done = await env.DB.prepare("UPDATE num_errands SET state='cancelled' WHERE id=?1 AND state='open'").bind(id).run();
      if (!done.meta?.changes) return json({ error: 'Someone has already started this — you’ll need to sort it with them.' }, 409);
      await moveEscrow(env, {
        memberId: e.poster_id,
        amount: e.bounty + e.spend_cap,
        into: false,
        ref: `${id}:cancel`,
        note: `${e.title} — cancelled`,
      });
      await logEvent(env, id, me, 'cancelled');
      break;
    }

    case 'dispute': {
      // Deliberately does NOT move money. A dispute freezes the escrow and
      // asks a human; an automatic refund here would be a free-goods button.
      await env.DB.prepare("UPDATE num_errands SET state='disputed', note=?2 WHERE id=?1 AND state='delivered'")
        .bind(id, clip(b.note, 300)).run();
      await logEvent(env, id, me, 'disputed', clip(b.note, 300));
      await tell(env, e.runner_id, 'A delivery is being queried', `“${e.title}” — Num will sort it out.`, ctx);
      break;
    }
  }

  return json({ ok: true, errand: visible(await one(env, id), me) });
}

const nameOf = async (env, id) =>
  (await env.DB.prepare('SELECT name FROM num_members WHERE id=?1').bind(id).first())?.name ?? 'Someone';

const tell = (env, memberId, title, body, ctx) =>
  notify(env, { memberId, kind: 'errand', title, body, url: '/?app', tag: 'errand', ctx }).catch(() => null);

/**
 * When nobody goes, send a courier.
 *
 * A marketplace with no runners is where this feature dies: the first person
 * to post an errand into an empty city waits, nothing happens, and they never
 * post again. DoorDash Drive is already connected and dispatches between two
 * addresses, so the board has a floor under it — if no human takes it, a
 * Dasher can.
 *
 * Two honesty constraints shape this:
 *   · Drive quotes in real currency, not Stars. The escrow already holds the
 *     poster's Stars; the courier fee is a SEPARATE real-money cost that the
 *     operator carries, so it is quoted and shown rather than silently
 *     converted at an invented rate.
 *   · It is offered, never automatic. Dispatching a courier spends money, and
 *     the poster is the only person entitled to decide that.
 */
async function courier(env, req, ctx) {
  const b = await readBody(req);
  const meId = clip(b.me, 40);
  const id = clip(b.id, 40);
  const e = await one(env, id ?? '');
  if (!e) return json({ error: 'no such errand' }, 404);
  if (e.poster_id !== meId) return json({ error: 'Only whoever posted it can send a courier.' }, 403);
  if (e.state !== 'open') return json({ error: `That errand is ${e.state} — a courier only helps while nobody has taken it.` }, 409);
  if (!driveReady(env)) return json({ error: 'No courier is connected on this account yet.' }, 503);
  if (!e.where_from) return json({ error: 'A courier needs a pickup address — add where it is coming from.' }, 400);

  const external = `num-${e.id}`;
  try {
    const q = await driveQuote(env, {
      external_delivery_id: external,
      pickup_address: e.where_from,
      pickup_business_name: clip(e.title, 40) || 'Pickup',
      pickup_phone_number: env.NUM_DISPATCH_PHONE || '+16505555555',
      dropoff_address: e.deliver_to,
      dropoff_phone_number: env.NUM_DISPATCH_PHONE || '+16505555555',
      dropoff_contact_given_name: e.poster_name || 'Num',
      order_value: Math.max(100, (e.spend_cap || 0) * 10),
    });

    // A quote alone commits nothing. `confirm` is the second, deliberate step.
    if (!b.confirm) {
      await logEvent(env, e.id, meId, 'courier-quoted', `${q.fee} ${q.currency}`);
      return json({
        quoted: true,
        fee: q.fee,
        currency: q.currency,
        pickup_eta: q.pickup_time_estimated ?? null,
        dropoff_eta: q.dropoff_time_estimated ?? null,
        note: 'This is a real courier fee in money, separate from the Stars already held for the runner’s bounty.',
      });
    }

    const delivery = await driveAccept(env, external);
    await env.DB.prepare("UPDATE num_errands SET state='claimed', courier=?2, claimed_at=datetime('now') WHERE id=?1 AND state='open'")
      .bind(e.id, clip(delivery.delivery_id ?? external, 60)).run();
    await logEvent(env, e.id, meId, 'courier-dispatched', delivery.delivery_id ?? external);
    await tell(env, e.poster_id, 'A courier is on it', `“${e.title}” is being collected.`, ctx);
    return json({ dispatched: true, delivery_id: delivery.delivery_id ?? external, tracking: delivery.tracking_url ?? null });
  } catch (err) {
    console.error('[errands] courier', err?.message ?? err);
    return json({ error: err?.message ?? 'The courier service didn’t answer.' }, err?.status ?? 502);
  }
}

// ── routes ────────────────────────────────────────────────────────────────

export async function handleErrands(request, env, path, ctx) {
  if (!env.DB) return json({ error: 'errands need the database binding' }, 503);
  await ensure(env);
  const url = new URL(request.url);
  const post_ = request.method === 'POST';

  try {
    if (path === '/' || path === '') return await board(env, url);
    if (path === '/post' && post_) return await post(env, request, ctx);
    if (path === '/one') {
      const e = await one(env, clip(url.searchParams.get('id'), 40) ?? '');
      return e ? json({ errand: visible(e, clip(url.searchParams.get('me'), 40)) }) : json({ error: 'no such errand' }, 404);
    }
    if (post_ && FLOW.open[path.slice(1)] !== undefined) return await advance(env, request, path.slice(1), ctx);
    if (post_ && ['claim', 'giveup', 'pickup', 'deliver', 'confirm', 'dispute', 'cancel'].includes(path.slice(1))) {
      return await advance(env, request, path.slice(1), ctx);
    }

    // What is sitting in escrow right now, for the operator. A number anyone
    // can check is a number nobody has to trust.
    if (path === '/courier' && post_) return await courier(env, request, ctx);

    if (path === '/escrow') {
      const held = await env.DB.prepare('SELECT stars FROM num_star_balances WHERE member_id=?1').bind(ESCROW).first();
      const open = await env.DB.prepare(
        "SELECT COUNT(*) n, COALESCE(SUM(bounty + spend_cap),0) owed FROM num_errands WHERE state NOT IN ('settled','cancelled')",
      ).first();
      return json({
        escrow_balance: held?.stars ?? 0,
        live_errands: open?.n ?? 0,
        committed: open?.owed ?? 0,
        // These must agree. If they ever drift, something moved money without
        // moving an errand, and that is worth finding out immediately.
        balanced: (held?.stars ?? 0) === (open?.owed ?? 0),
      });
    }

    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('[errands]', path, err?.message ?? err);
    return json({ error: 'that didn’t go through' }, 500);
  }
}
