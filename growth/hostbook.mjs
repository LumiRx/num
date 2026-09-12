/**
 * The book: a host's clients and their work, joined.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The console already has everything a host needs and shows none of it
 * together. `Your clients` is one card and `Requests` is another, so a host
 * looking at Priya has to scroll to a second list, find the rows whose client
 * name says Priya, and hold the answer in their head. With four clients that
 * is mildly annoying. With forty it is the reason they keep using WhatsApp and
 * a notebook.
 *
 * Nothing new has to be stored to fix it. `num_host_requests.client_id`
 * already points at `num_host_clients.id`; the join has simply never been
 * done for the person. This file does it.
 *
 * ── THE ONE QUESTION IT ANSWERS PER CLIENT ───────────────────────────────
 *
 * Not "how many requests does this client have" — a count tells a host
 * nothing they can act on. The question is **whose move is it**, and there are
 * only three answers:
 *
 *   · YOURS      — they asked, you have not replied. This is the one that
 *                  costs a host their reputation, so it sorts to the top and
 *                  carries how long it has been waiting.
 *   · THEIRS     — you sent a draft or a quote and are waiting on a yes.
 *   · NOBODY'S   — confirmed and in the calendar, or finished.
 *
 * A client with nothing outstanding is still in the book, quietly, because
 * the book is also the answer to "who have I not spoken to since June".
 *
 * ── AND WHY THE AGENDA IS THE SAME DATA, NOT A SECOND SOURCE ─────────────
 *
 * The .ics feed already publishes confirmed work to whatever calendar the host
 * uses, and that stays the system of record for their diary. The agenda here
 * is the same rows read a different way, so the page and the calendar can
 * never disagree. A second query with its own filters is how "it says Tuesday
 * in the app and Wednesday in my calendar" happens.
 */

/** Statuses where the host owes the client an answer. */
export const WAITING_ON_HOST = Object.freeze(['new']);

/** Statuses where the client owes the host an answer. */
export const WAITING_ON_CLIENT = Object.freeze(['drafted', 'awaiting_host']);

/** Statuses that are finished, one way or another. */
export const CLOSED = Object.freeze(['declined', 'cancelled', 'done']);

/** Confirmed work is nobody's move — it is in the diary. */
export const SCHEDULED = Object.freeze(['confirmed']);

export const TURN = Object.freeze({ HOST: 'yours', CLIENT: 'theirs', NOBODY: 'nobody' });

const turnOf = (status) => {
  const s = String(status ?? '');
  if (WAITING_ON_HOST.includes(s)) return TURN.HOST;
  if (WAITING_ON_CLIENT.includes(s)) return TURN.CLIENT;
  return TURN.NOBODY;
};

const ms = (v) => {
  if (!v) return null;
  const t = Date.parse(String(v).includes('T') ? String(v) : `${String(v).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
};

/** Whole days, rounded down, never negative. */
const daysSince = (from, now) => {
  const t = ms(from);
  return t == null ? null : Math.max(0, Math.floor((now - t) / 86400000));
};

/**
 * One client, with their work folded in.
 *
 * `open` is deliberately not "all requests": a host scanning their book wants
 * the live ones. The rest are counted and available, so the page can show
 * "and 14 before that" without carrying 14 rows per client into every render.
 */
export function foldClient(client, requests, now = Date.now()) {
  const mine = (requests ?? []).filter((r) => r.client_id === client.id);
  const open = mine.filter((r) => !CLOSED.includes(String(r.status)));
  const waitingOnHost = open.filter((r) => turnOf(r.status) === TURN.HOST);
  const scheduled = mine
    .filter((r) => SCHEDULED.includes(String(r.status)) && ms(r.starts_at) != null)
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at));
  const upcoming = scheduled.filter((r) => ms(r.starts_at) >= now);

  // The oldest unanswered request is the one that decides how bad this looks
  // to the client, so that is the number the page shows — not an average, and
  // not the newest.
  const oldestUnanswered = waitingOnHost
    .map((r) => daysSince(r.created_at, now))
    .filter((n) => n != null)
    .sort((a, b) => b - a)[0] ?? null;

  const lastTouch = mine
    .map((r) => ms(r.confirmed_at) ?? ms(r.created_at))
    .filter((t) => t != null)
    .sort((a, b) => b - a)[0] ?? ms(client.created_at);

  // Whose move, decided by the turns of the OPEN rows — not by how many there
  // are. `open` includes confirmed work, which is live but is nobody's move,
  // so counting rows would report a client with a booking in the diary as
  // waiting on us. Its own test caught that.
  const waitingOnClient = open.filter((r) => turnOf(r.status) === TURN.CLIENT);

  return {
    ...client,
    turn: waitingOnHost.length ? TURN.HOST
      : waitingOnClient.length ? TURN.CLIENT
        : TURN.NOBODY,
    waiting_on_you: waitingOnHost.length,
    days_waiting: oldestUnanswered,
    open_count: open.length,
    total_count: mine.length,
    next: upcoming[0] ?? null,
    // Silence is a fact about a relationship, and it is the one a host cannot
    // see from a list of requests: nothing is a row.
    quiet_days: lastTouch == null ? null : Math.max(0, Math.floor((now - lastTouch) / 86400000)),
    open: open.map((r) => ({ ...r, turn: turnOf(r.status) })),
  };
}

/**
 * Order: whoever is owed an answer, longest wait first.
 *
 * Paused clients sink regardless — they are in the book for continuity, not
 * for attention — and a host with nothing outstanding sees their book sorted
 * by who they have not spoken to longest, which is the next most useful
 * question after "who is waiting".
 */
const rank = (c) => {
  if (String(c.status) === 'paused') return 3;
  if (c.turn === TURN.HOST) return 0;
  if (c.turn === TURN.CLIENT) return 1;
  return 2;
};

export function book(clients, requests, now = Date.now()) {
  const folded = (clients ?? []).map((c) => foldClient(c, requests, now));
  folded.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    if (a.turn === TURN.HOST && b.turn === TURN.HOST) {
      return (b.days_waiting ?? 0) - (a.days_waiting ?? 0);
    }
    if (rank(a) === 2) return (b.quiet_days ?? 0) - (a.quiet_days ?? 0);
    return String(a.name ?? '').localeCompare(String(b.name ?? ''));
  });

  // Requests with no client attached are not dropped. They are somebody's
  // work, and a row that exists but appears nowhere is how a host misses a job
  // and blames the product.
  const orphans = (requests ?? [])
    .filter((r) => !r.client_id && !CLOSED.includes(String(r.status)))
    .map((r) => ({ ...r, turn: turnOf(r.status) }));

  return {
    clients: folded,
    unassigned: orphans,
    counts: {
      clients: folded.filter((c) => String(c.status) !== 'paused').length,
      waiting_on_you: folded.reduce((n, c) => n + c.waiting_on_you, 0) + orphans.filter((r) => r.turn === TURN.HOST).length,
      open: folded.reduce((n, c) => n + c.open_count, 0) + orphans.length,
      // The number a host actually plans their week around.
      upcoming: folded.filter((c) => c.next).length,
    },
  };
}

/**
 * The next N days of confirmed work, in time order.
 *
 * Read from the same rows the .ics feed publishes, on purpose: two queries
 * with their own filters is how the app says Tuesday and the calendar says
 * Wednesday.
 */
export function agenda(clients, requests, { now = Date.now(), days = 30 } = {}) {
  const until = now + days * 86400000;
  const byId = new Map((clients ?? []).map((c) => [c.id, c]));
  return (requests ?? [])
    .filter((r) => SCHEDULED.includes(String(r.status)))
    .map((r) => ({ ...r, at: ms(r.starts_at) }))
    .filter((r) => r.at != null && r.at >= now && r.at <= until)
    .sort((a, b) => a.at - b.at)
    .map((r) => ({
      ...r,
      client_name: r.client_name ?? byId.get(r.client_id)?.name ?? null,
      day: new Date(r.at).toISOString().slice(0, 10),
    }));
}
