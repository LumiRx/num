#!/usr/bin/env node
/**
 * Who is editing this worktree, and who is deploying it.
 *
 * ── THE INCIDENT THIS EXISTS FOR ─────────────────────────────────────────
 *
 * On 3 Sep 2026 two Cowork sessions edited `~/num-worktrees/app-main` at the
 * same time without either knowing. Between 19:47 and 20:25 one session
 * created maildelivery.mjs, failures.mjs, hostintegrity.mjs and their tests
 * while the other was mid-way through bizconsole.mjs, bizonboard.mjs and
 * index.mjs. Both sets of work survived — by luck. Each session read a file,
 * held it in context, and wrote it back; whichever wrote last would have
 * silently erased the other's edits to that file, and the loser would never
 * have found out, because there is no conflict to see. The tests would have
 * passed. The work would simply have been gone.
 *
 * A git branch does not fix this. Two sessions on the SAME WORKING TREE share
 * one set of files whatever branch is checked out — branches protect history,
 * not the tree. This does.
 *
 * ── AND THE OTHER HALF: DEPLOYS ──────────────────────────────────────────
 *
 * Same shape, worse consequence. Two `wrangler deploy` runs from one tree
 * publish whatever happens to be on disk at that moment, so a deploy started
 * mid-edit ships a half-written file to production, and the second deploy
 * overwrites the first with a different half. `deploy` is therefore its own
 * claim, and taking it REQUIRES the edit lock to be free.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * Advisory, not enforced. Nothing stops a session that does not check — this
 * is a note on the door, not a lock on it. That is the honest description and
 * it is still worth having: the failure above was not two people ignoring each
 * other, it was two people who had no way to find out. Making it findable in
 * one command is most of the fix. `--force` exists because a crashed session
 * leaves a stale claim and the alternative to a documented override is
 * somebody deleting the file by hand.
 *
 *   node scripts/claim.mjs status
 *   node scripts/claim.mjs take   edit   "biz onboarding pages"  --who cowork-A
 *   node scripts/claim.mjs take   deploy "ship 0.8.233"          --who dre
 *   node scripts/claim.mjs renew  edit   --who cowork-A
 *   node scripts/claim.mjs release edit  --who cowork-A
 *   node scripts/claim.mjs take   edit   "..." --who X --force
 *
 * Exit codes: 0 taken or free, 1 held by somebody else, 2 bad usage.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Overridable so the tests never write a claim into the real worktree — a test
 * suite that takes the edit lock would lock out the session running it.
 */
export const CLAIM_DIR = process.env.NUM_CLAIM_DIR || join(HERE, '..', '.claims');
export const KINDS = Object.freeze(['edit', 'deploy']);

/**
 * How long a claim is believed without a heartbeat.
 *
 * Deliberately short. A session that dies mid-edit must not block the tree
 * until somebody notices — twenty minutes is longer than any single edit and
 * shorter than a coffee break, and `renew` costs one command.
 */
export const STALE_MINUTES = 20;

const path = (kind) => join(CLAIM_DIR, `${kind}.json`);
const now = () => new Date().toISOString();
const minsSince = (iso) => (Date.now() - Date.parse(iso)) / 60000;

/** The raw record, released or not. `held()` is what callers usually want. */
export function read(kind) {
  try { return JSON.parse(readFileSync(path(kind), 'utf8')); } catch { return null; }
}

/** A claim nobody has renewed for STALE_MINUTES is not a claim any more. */
export const isStale = (claim) => !claim || minsSince(claim.renewed_at ?? claim.taken_at) > STALE_MINUTES;

/**
 * RELEASING MARKS, IT DOES NOT DELETE.
 *
 * Not a stylistic choice — a Cowork session cannot delete files inside a
 * connected folder at all (`rm` returns "Operation not permitted"), so a
 * delete-based release would let a session TAKE the lock and never give it
 * back. Every session would eventually have to --force past every other
 * session, which is the same as having no lock.
 *
 * Marking also leaves the audit trail the incident wanted: who held the tree,
 * when, and for what.
 */
export const held = (kind) => {
  const c = read(kind);
  return !c || c.released_at || isStale(c) ? null : c;
};

export function take(kind, note, who, { force = false } = {}) {
  if (!KINDS.includes(kind)) return { ok: false, code: 2, error: `kind must be one of ${KINDS.join(', ')}` };
  if (!who) return { ok: false, code: 2, error: '--who is required: name the session or person' };

  const current = held(kind);
  if (current && current.who !== who && !force) {
    return {
      ok: false, code: 1, held: current,
      error: `${kind} is held by ${current.who} since ${current.taken_at} — "${current.note}". `
        + `Wait, or coordinate, or --force if you know that session is gone.`,
    };
  }
  // A deploy while somebody is editing ships a half-written file. This is the
  // one cross-check, and it is the one that reaches production.
  if (kind === 'deploy') {
    const editing = held('edit');
    if (editing && editing.who !== who && !force) {
      return {
        ok: false, code: 1, held: editing,
        error: `${editing.who} is editing the tree — "${editing.note}". A deploy now would ship `
          + `whatever is half-written on disk. Wait for the edit claim to clear.`,
      };
    }
  }

  mkdirSync(CLAIM_DIR, { recursive: true });
  const claim = {
    kind, who, note: String(note ?? '').slice(0, 200), taken_at: now(), renewed_at: now(),
    ...(force && current && current.who !== who
      ? { forced_over: { who: current.who, taken_at: current.taken_at } } : {}),
  };
  writeFileSync(path(kind), `${JSON.stringify(claim, null, 2)}\n`);
  return { ok: true, code: 0, claim };
}

export function renew(kind, who) {
  const current = held(kind);
  if (!current) return { ok: false, code: 1, error: `no live ${kind} claim to renew` };
  if (current.who !== who) return { ok: false, code: 1, error: `${kind} is held by ${current.who}, not ${who}` };
  writeFileSync(path(kind), `${JSON.stringify({ ...current, renewed_at: now() }, null, 2)}\n`);
  return { ok: true, code: 0 };
}

export function release(kind, who, { force = false } = {}) {
  const current = held(kind);
  if (!current) return { ok: true, code: 0, note: `no live ${kind} claim was held` };
  if (current.who !== who && !force) {
    return { ok: false, code: 1, error: `${kind} is held by ${current.who}, not ${who} — use --force to break it` };
  }
  mkdirSync(CLAIM_DIR, { recursive: true });
  writeFileSync(path(kind), `${JSON.stringify({
    ...current, released_at: now(), ...(current.who !== who ? { released_by: who } : {}),
  }, null, 2)}\n`);
  return { ok: true, code: 0 };
}

export function status() {
  return KINDS.map((kind) => {
    const c = read(kind);
    const live = held(kind);
    return {
      kind,
      held: !!live,
      stale: !!c && !c.released_at && isStale(c),
      released: !!c?.released_at,
      ...(c ? { who: c.who, note: c.note, taken_at: c.taken_at, renewed_at: c.renewed_at } : {}),
    };
  });
}

if (process.argv[1] && process.argv[1].endsWith('claim.mjs')) {
  const [, , cmd, kind, ...rest] = process.argv;
  const flag = (n) => { const i = rest.indexOf(`--${n}`); return i === -1 ? null : rest[i + 1]; };
  const force = rest.includes('--force');
  const who = flag('who');
  const note = rest.filter((r, i) => !r.startsWith('--') && rest[i - 1] !== '--who').join(' ');

  if (cmd === 'status' || !cmd) {
    for (const s of status()) {
      if (!s.who) console.log(`${s.kind.padEnd(7)} free`);
      else if (s.released) console.log(`${s.kind.padEnd(7)} free — last held by ${s.who} ("${s.note}")`);
      else if (s.stale) console.log(`${s.kind.padEnd(7)} STALE — ${s.who} since ${s.taken_at} ("${s.note}"). Safe to take.`);
      else console.log(`${s.kind.padEnd(7)} HELD by ${s.who} since ${s.taken_at} — "${s.note}"`);
    }
    process.exit(0);
  }
  const run = { take: () => take(kind, note, who, { force }), renew: () => renew(kind, who), release: () => release(kind, who, { force }) }[cmd];
  if (!run) { console.error('usage: claim.mjs status | take <edit|deploy> "note" --who NAME | renew <kind> --who NAME | release <kind> --who NAME'); process.exit(2); }
  const out = run();
  if (out.ok) console.log(out.claim ? `${kind} claimed by ${who}` : (out.note ?? `${cmd} ok`));
  else console.error(out.error);
  process.exit(out.code ?? 0);
}
