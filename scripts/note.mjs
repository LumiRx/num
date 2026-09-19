#!/usr/bin/env node
/**
 * One line into RUNS.log, so the next session can adjust to what you just did.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * RUNS.log already works, and the entries in it are the good kind — not
 * changelogs but warnings to whoever comes next: "in this shell always prefix
 * npm installs with NODE_ENV=development" after a session pruned every
 * devDependency; "ships other sessions' WIP present in the tree, as every ship
 * from this worktree does".
 *
 * The gap is granularity. Those entries are written per SHIP, so between
 * deploys a session cannot see what landed. Several sessions commit to this
 * tree every hour, and a commit is the unit that actually changes the ground
 * under somebody else's feet.
 *
 * CLAUDE.md has asked for a line at the end of every run since August. It is
 * skipped because it means opening a file, matching a format and not
 * forgetting the date. A convention is only followed when following it is
 * cheaper than not following it, so this makes it one command.
 *
 *   npm run note -- "what changed, and what it means for anyone else in here"
 *
 * ── WHO YOU ARE IS ALREADY KNOWN ─────────────────────────────────────────
 *
 * scripts/claim.mjs holds the name of whoever has the tree. Rather than ask
 * for it again, this reads the edit claim and uses that name. A session that
 * claimed the tree to work — which is the rule — never types --who at all, and
 * the name in RUNS.log is guaranteed to match the name in the claim, so the
 * two ledgers can be read against each other.
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG = join(REPO, 'RUNS.log');

const argv = process.argv.slice(2);
const whoFlag = argv.indexOf('--who');
const who = whoFlag !== -1 ? argv[whoFlag + 1] : null;
const message = argv.filter((a, i) => i !== whoFlag && i !== whoFlag + 1).join(' ').trim();

if (!message) {
  console.error('Say what changed:\n  npm run note -- "what changed, and what it means for anyone else in here"');
  process.exit(1);
}

/** Whoever holds the edit claim, since they are the one writing. */
function claimant() {
  try {
    const out = execFileSync('node', ['scripts/claim.mjs', 'status'], { cwd: REPO, encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith('edit')) ?? '';
    const held = line.match(/HELD by ([^\s(]+)/);
    if (held) return held[1];
    const last = line.match(/last held by ([^\s(]+)/);
    return last ? last[1] : null;
  } catch { return null; }
}

function head() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch { return '0000000'; }
}

/** Files changed but not committed — the thing that actually trips other sessions. */
function dirty() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' });
    const n = out.split('\n').filter((l) => l.trim()).length;
    return n;
  } catch { return 0; }
}

const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const name = who || claimant() || 'unknown';
const wip = dirty();
// The uncommitted count is recorded because a ship from this worktree carries
// whatever else is on disk, and the log has repeatedly had to say so by hand.
const tail = wip ? `  [${wip} files uncommitted in tree at the time]` : '';

if (!existsSync(LOG)) {
  console.error(`No RUNS.log at ${LOG} — refusing to create one, in case this is the wrong directory.`);
  process.exit(1);
}
const last = readFileSync(LOG, 'utf8');
const prefix = last.endsWith('\n') || last === '' ? '' : '\n';

appendFileSync(LOG, `${prefix}${stamp}  ${head()}  ${name}  ${message}${tail}\n`);
console.log(`${stamp}  ${head()}  ${name}  ${message}${tail}`);
