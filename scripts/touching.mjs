/**
 * WHICH FILES IS EACH SESSION ON, AND WHOSE WORK IS IN MY `git add`?
 *
 * ── WHY claim.mjs WAS NOT ENOUGH ─────────────────────────────────────────
 *
 * claim.mjs holds ONE lock for the whole worktree. That was right when two
 * sessions shared a tree: the failure it was written for is two sessions
 * editing the same file, each holding it in context, the later write silently
 * erasing the earlier one with no conflict to see and the tests still passing.
 *
 * It stops being right at six. Measured on 19 Sep 2026 between 20:00 and 21:40
 * the `edit` lock passed through semrush-robots, claude-cowork, pseo-nav,
 * claude-promo, claude-drift, cannabis-gate, attribution and id-check — eight
 * holders in a hundred minutes, most of them for a few seconds. A lock that
 * changes hands that fast is not coordinating anybody. It is a turnstile in
 * front of a building with six doors, and sessions route around it: one of
 * mine took it mid-command, found it gone, and edited anyway.
 *
 * The honest reading is that the whole-tree lock is the wrong granularity, not
 * that sessions are careless. Six sessions genuinely CAN work at once — they
 * are almost always in different files. What none of them can see is which
 * files.
 *
 * ── AND THE PLACE IT ACTUALLY HURTS IS `git add` ─────────────────────────
 *
 * Not the edit. The COMMIT. Every session shares one working tree, so
 * `git add src/components/app/WalletSheet.tsx` stages whatever is in that file
 * right now — including forty lines of somebody else's half-finished work that
 * happens to be sitting in it. RUNS.log records this as the accepted cost of a
 * shared tree ("Ships other sessions WIP in tree") three separate times today.
 *
 * It is accepted because it was invisible. This makes it visible:
 *
 *     node scripts/touching.mjs check worker/liteapi.mjs src/lib/stays.ts
 *
 * prints, for each path you are about to stage, whether anybody else has said
 * they are in it. That is the one question worth answering before a commit,
 * and it takes a second.
 *
 * ── DELIBERATELY NOT A LOCK ──────────────────────────────────────────────
 *
 * Nothing here blocks anything. A second session claiming the same file gets a
 * warning and proceeds. That is the same choice claim.mjs made and for the
 * same reason, stated in its own header: the 3 Sep failure "was not two people
 * ignoring each other — it was two people with no way to find out." Adding
 * enforcement to a registry nobody is obliged to use would only make sessions
 * route around this one too.
 *
 *   node scripts/touching.mjs on worker/liteapi.mjs worker/staydata.mjs \
 *        --who claude-stays --note "liteapi rail"
 *   node scripts/touching.mjs status                   # everyone, every file
 *   node scripts/touching.mjs check <paths...>         # before you git add
 *   node scripts/touching.mjs mine --who claude-stays  # what am I holding
 *   node scripts/touching.mjs off --who claude-stays   # release all of mine
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.claims');
const FILE = join(DIR, 'touching.json');

/**
 * Twenty minutes, matching claim.mjs exactly.
 *
 * Same number on purpose: two staleness rules that disagree is a third thing
 * to remember, and a session that crashed should disappear from both at once.
 */
const STALE_MS = 20 * 60 * 1000;

const now = () => new Date().toISOString();
const age = (iso) => Date.now() - Date.parse(iso);
const isStale = (row) => age(row.at) > STALE_MS;

function load() {
  try {
    const rows = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    // No registry yet is the ordinary first run, not an error.
    return [];
  }
}

function save(rows) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(rows, null, 2)}\n`);
}

/** Stale rows are dropped on every read, so a crashed session frees its files. */
const live = (rows) => rows.filter((r) => !isStale(r));

const mins = (iso) => Math.round(age(iso) / 60000);

/**
 * What git thinks is modified right now.
 *
 * Wrapped because a Cowork session usually cannot reach git at all — the
 * worktree's gitdir points at a path outside its mount. When that is the case
 * the registry still answers "who is on this file", which is the useful half;
 * only the "and it is dirty" half goes quiet. Saying so beats printing
 * nothing and letting somebody read it as "all clear".
 */
function dirtyFiles() {
  try {
    // stdio 'pipe' on stderr: when git cannot resolve the worktree it prints a
    // fatal to the terminal before throwing, and that line reads like this
    // script broke rather than like git being out of reach.
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Set(
      out.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean),
    );
  } catch {
    return null;
  }
}

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};

const paths = () => process.argv.slice(3).filter((a) => !a.startsWith('--')
  && process.argv[process.argv.indexOf(a) - 1] !== '--who'
  && process.argv[process.argv.indexOf(a) - 1] !== '--note');

function requireWho() {
  const who = arg('who');
  if (!who) {
    console.error('--who is required: name the session or person.');
    process.exit(1);
  }
  return who;
}

/* ── on ────────────────────────────────────────────────────────────────── */

function cmdOn() {
  const who = requireWho();
  const note = arg('note') ?? '';
  const files = paths();
  if (!files.length) {
    console.error('Name at least one file.');
    process.exit(1);
  }
  const rows = live(load());
  const warnings = [];

  for (const f of files) {
    const others = rows.filter((r) => r.file === f && r.who !== who);
    for (const o of others) warnings.push(`  ${f} — also ${o.who} (${mins(o.at)} min, "${o.note || 'no note'}")`);
    const mine = rows.find((r) => r.file === f && r.who === who);
    if (mine) { mine.at = now(); mine.note = note || mine.note; } else rows.push({ file: f, who, note, at: now() });
  }
  save(rows);

  console.log(`${who} is on ${files.length} file${files.length === 1 ? '' : 's'}.`);
  if (warnings.length) {
    // A warning, not a refusal — see the header. Two sessions in one file is
    // sometimes correct and always worth knowing about.
    console.log('\nSomebody else is in these too:');
    console.log(warnings.join('\n'));
    console.log('\nNot a block. Talk, or split the file between you.');
  }
}

/* ── status ────────────────────────────────────────────────────────────── */

function cmdStatus() {
  const rows = live(load());
  if (!rows.length) { console.log('Nobody has said what they are on.'); return; }

  const bySession = new Map();
  for (const r of rows) {
    if (!bySession.has(r.who)) bySession.set(r.who, []);
    bySession.get(r.who).push(r);
  }
  for (const [who, list] of [...bySession].sort((a, b) => a[0].localeCompare(b[0]))) {
    const freshest = Math.min(...list.map((r) => mins(r.at)));
    console.log(`\n${who}  (${freshest} min ago)  ${list[0].note ? `— ${list[0].note}` : ''}`);
    for (const r of list.sort((a, b) => a.file.localeCompare(b.file))) console.log(`  ${r.file}`);
  }

  // The contested ones last, because they are the point of the whole file.
  const counts = new Map();
  for (const r of rows) counts.set(r.file, (counts.get(r.file) ?? 0) + 1);
  const shared = [...counts].filter(([, n]) => n > 1);
  if (shared.length) {
    console.log('\nTWO OR MORE SESSIONS IN THE SAME FILE:');
    for (const [f] of shared) {
      console.log(`  ${f} — ${rows.filter((r) => r.file === f).map((r) => r.who).join(', ')}`);
    }
  }
}

/* ── check ─────────────────────────────────────────────────────────────── */

/**
 * The one to run before `git add`.
 *
 * Answers two questions per path: is somebody else in it, and is it dirty. A
 * file that is both is the one that stages work you did not write.
 */
function cmdCheck() {
  const who = arg('who');
  const rows = live(load());
  const dirty = dirtyFiles();
  const files = paths();
  if (!files.length) {
    console.error('Name the files you are about to stage.');
    process.exit(1);
  }

  let risky = 0;
  for (const f of files) {
    const others = rows.filter((r) => r.file === f && (!who || r.who !== who));
    const isDirty = dirty ? dirty.has(f) : null;
    if (others.length) {
      risky++;
      console.log(`RISK   ${f}`);
      for (const o of others) console.log(`         ${o.who} is in this file (${mins(o.at)} min) — "${o.note || 'no note'}"`);
      if (isDirty === false) console.log('         …though git says it is clean, so their work may already be committed.');
    } else {
      console.log(`ok     ${f}${isDirty === false ? '  (clean — nothing to stage)' : ''}`);
    }
  }

  if (dirty === null) {
    console.log('\nNote: git was not reachable from here, so this checked the registry only.');
    console.log('It cannot tell you about a session that never registered.');
  }
  if (risky) {
    console.log(`\n${risky} file${risky === 1 ? '' : 's'} another session is working in.`);
    console.log('Staging one of those commits their half-finished work under your message.');
    console.log('Leave it out, or ask them to commit first.');
    process.exit(2);
  }
  console.log('\nNobody else has claimed any of these.');
}

/* ── mine / off ────────────────────────────────────────────────────────── */

function cmdMine() {
  const who = requireWho();
  const list = live(load()).filter((r) => r.who === who);
  if (!list.length) { console.log(`${who} is not on anything.`); return; }
  for (const r of list) console.log(`  ${r.file}  (${mins(r.at)} min)`);
}

function cmdOff() {
  const who = requireWho();
  const files = paths();
  const rows = live(load());
  const keep = files.length
    ? rows.filter((r) => !(r.who === who && files.includes(r.file)))
    : rows.filter((r) => r.who !== who);
  save(keep);
  console.log(`${who} released ${rows.length - keep.length} file${rows.length - keep.length === 1 ? '' : 's'}.`);
}

const CMDS = { on: cmdOn, status: cmdStatus, check: cmdCheck, mine: cmdMine, off: cmdOff };
const cmd = process.argv[2];

if (!cmd || !CMDS[cmd]) {
  console.log(`Which files is each session on?

  node scripts/touching.mjs on <files...> --who NAME --note "what"
  node scripts/touching.mjs status
  node scripts/touching.mjs check <files...> [--who NAME]    # before git add
  node scripts/touching.mjs mine --who NAME
  node scripts/touching.mjs off  --who NAME [files...]

Advisory, never a block. Rows go stale after 20 minutes, same as claim.mjs.`);
  process.exit(cmd ? 1 : 0);
}
CMDS[cmd]();
