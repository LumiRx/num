// Releases, in two steps, so a change can never take the app down.
//
// Cloudflare keeps every upload as a *version*. A version that is uploaded is
// not live — it gets its own preview URL that only you know. So the flow is:
//
//   node scripts/release.mjs stage "what changed"   → build, upload, preview URL
//   node scripts/release.mjs ship                   → send live traffic to it
//   node scripts/release.mjs rollback               → previous version, instantly
//
// `ship` can also go out gradually: `ship 10` puts 10% of traffic on the new
// version and leaves the rest on the old one, which is the difference between
// a bad deploy affecting everybody and it affecting one person in ten for a
// minute.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';

const CONFIG = '--config wrangler.app.jsonc';
// Written by `stage`, read by `ship`. Git-ignored: it describes one machine's
// last upload, not the repository.
const STAGED = '.release-staged.json';
// execSync throws on a non-zero exit, but only if we let it: swallowing that
// is how `ship` printed "v0.8.4 is live" while production stayed on 0.8.1.
// A release tool that lies about what it did is worse than no release tool.
const sh = (cmd, quiet = false) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  } catch (err) {
    console.error(`\n✘ command failed: ${cmd}\n`);
    throw err;
  }
};
const cap = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const cmd = process.argv[2];
const arg = process.argv.slice(3).join(' ');

/** Applies any migration registered in APPLIED.json but not yet sealed. */
function applyPendingMigrations() {
  const path = 'worker/migrations/APPLIED.json';
  if (!existsSync(path)) return;
  let pending = [];
  try { pending = JSON.parse(readFileSync(path, 'utf8')).pending ?? []; }
  catch (e) { console.error(`\n\u2718 ${path} is unreadable: ${e.message}\n`); process.exit(1); }
  if (!pending.length) { console.log('\n\u2500\u2500 schema: nothing pending'); return; }
  console.log(`\n\u2500\u2500 schema: applying ${pending.length} pending migration${pending.length === 1 ? '' : 's'}`);
  for (const p of pending) console.log(`   ${p}`);
  // Not wrapped in try/catch on purpose. If a migration fails, sh() throws and
  // the release stops here — before anything is uploaded. Continuing would
  // stage code against a schema that refused it.
  sh('node scripts/apply-host-migrations.mjs');
  const after = JSON.parse(readFileSync(path, 'utf8')).pending ?? [];
  if (after.length) {
    console.error(`\n\u2718 still pending after the run: ${after.join(', ')}`);
    console.error('  The release is stopping. Nothing was uploaded.\n');
    process.exit(1);
  }
}

const gitSha = () => {
  try {
    return cap('git rev-parse --short HEAD');
  } catch {
    return 'nogit';
  }
};

const dirty = () => {
  try {
    return cap('git status --porcelain').length > 0;
  } catch {
    return false;
  }
};

// ── AUTO-COMMIT ─────────────────────────────────────────────────────────────
//
// `stage` used to print "Working tree has uncommitted changes — staging them
// anyway" and deploy regardless. A warning that never blocks anything is a
// warning nobody reads: on 7 Sep 2026 that line had let 163 files and roughly
// 18,000 lines go live while unrecorded, and underneath the noise a stale git
// lock from 4 August had been failing every write for a month unnoticed. Every
// version that shipped in that window was a version you could not return to,
// which is the one thing a release tool exists to prevent.
//
// So committing is now part of releasing rather than something you remember
// afterwards. It runs AFTER `npm test` and BEFORE `bump`, which means what
// gets committed is exactly what passed, and the changelog's sha names it.
//
// NO_AUTOCOMMIT=1 restores the old warn-and-continue behaviour for the rare
// case where you truly want a deploy off an uncommitted tree.

// The safety valve. .gitignore is the first defence; this is the one that
// assumes .gitignore was wrong, because `git add -A` in an automated path is
// exactly how a key reaches a public remote. Checked against what git is
// about to stage.
const RISKY =
  /(^|\/)(\.env(\.|$)|\.dev\.vars|.*\.(key|pem|p12|pfx|keystore|jks|mobileprovision)$|id_(rsa|dsa|ecdsa|ed25519)|.*secret.*|.*credential.*)/i;

const pendingFiles = () => {
  try {
    return cap('git status --porcelain')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const inRepo = () => {
  try {
    cap('git rev-parse --git-dir');
    return true;
  } catch {
    return false;
  }
};

/**
 * A LEFTOVER LOCK, NAMED — instead of forty lines of stack trace.
 *
 * Git writes `index.lock` while it works and deletes it when it finishes. A
 * git process that is killed part-way leaves the file behind, and every later
 * `git add` refuses with "Unable to create ... index.lock: File exists."
 *
 * `stage` runs `git add -A` inside `execSync`, so that refusal arrives as an
 * unhandled Node exception: forty lines of internal frames with the one
 * sentence that matters buried in the middle, ending in "Node.js v24.14.0".
 * It read as a crash in the release tool rather than as a file to delete.
 *
 * It has now cost two releases three days apart — 9 Sep and 12 Sep 2026 —
 * and on the second one the tests had already passed, so the whole run was
 * thrown away at the last step for a stale file.
 *
 * NOT DELETED AUTOMATICALLY, except in the one case where the file itself
 * proves nothing is holding it. The lock also exists when a git process is
 * genuinely running, and removing it under a live writer is how a repository
 * gets corrupted — so that reasoning stands, and what follows narrows it rather
 * than overriding it. See `deadLock()`.
 */
function staleLock() {
  if (!inRepo()) return null;
  try {
    // The real git dir, which for a worktree is not `.git` but the path
    // inside the parent repository that `.git` points at.
    const dir = cap('git rev-parse --absolute-git-dir');
    const lock = `${dir}/index.lock`;
    return existsSync(lock) ? lock : null;
  } catch {
    return null;
  }
}

/**
 * How long an EMPTY lock must sit before we treat it as abandoned.
 *
 * Ten minutes is far longer than any `git add` in this repository takes, and
 * far shorter than the two hours and twenty minutes the 12 Sep lock had been
 * sitting when it was found.
 */
const DEAD_LOCK_AFTER_MS = 10 * 60 * 1000;

/**
 * Is this lock provably abandoned?
 *
 * Two conditions, and BOTH are required, because either alone is a guess:
 *
 *   · ZERO BYTES. Git writes the new index INTO index.lock as it works, so a
 *     live operation's lock has content within milliseconds of being created.
 *     An empty one is a process that made the file and died before writing —
 *     which is exactly what both the 9 Sep and 12 Sep locks were.
 *   · OLDER THAN TEN MINUTES. A lock created a second ago might be a git
 *     command still starting up.
 *
 * Anything else — any content at all, or any recency — falls through to the
 * refusal below and stays the person's decision. That is the case the original
 * "deliberately not deleted" reasoning was protecting, and it still is: a lock
 * with bytes in it is a writer, and we do not touch it however old it looks.
 */
function deadLock(lock) {
  if (process.env.NO_LOCK_SWEEP) return false;
  try {
    const st = statSync(lock);
    if (st.size !== 0) return false;
    return (Date.now() - st.mtimeMs) > DEAD_LOCK_AFTER_MS;
  } catch {
    return false;   // cannot read it, cannot judge it, do not delete it
  }
}

/** Called before anything that writes to the index. Exits rather than crashing. */
function refuseOnStaleLock() {
  const lock = staleLock();
  if (!lock) return;

  // An empty lock older than ten minutes has never once been a live writer, and
  // has now cost three releases. Clearing it is stated out loud rather than done
  // quietly: a tool that silently deletes files in .git is not one to trust.
  if (deadLock(lock)) {
    try {
      const ageMin = Math.round((Date.now() - statSync(lock).mtimeMs) / 60000);
      unlinkSync(lock);
      console.error(`\n⚠ Cleared an abandoned git lock (0 bytes, ${ageMin} minutes old):`);
      console.error(`    ${lock}`);
      console.error('  Git writes into that file as it works, so an empty one is a killed');
      console.error('  process, never a live writer. Continuing.\n');
      return;
    } catch (e) {
      console.error(`\n✘ Could not remove the stale lock: ${e?.message ?? e}\n`);
    }
  }
  console.error('\n✘ Git has a lock file in place, so nothing can be committed.\n');
  console.error(`    ${lock}\n`);
  console.error('  If no other git command is running — no open commit editor, no other');
  console.error('  session mid-write — this is left over from one that was killed, and');
  console.error('  it is safe to remove:\n');
  console.error(`    rm -f "${lock}"\n`);
  console.error('  Then run stage again. Your tests already passed; nothing else is wrong.\n');
  console.error('  This one was NOT cleared automatically: it has bytes in it, or it is less');
  console.error('  than ten minutes old — either way something may still be writing.\n');
  console.error('  To release without touching git at all: NO_AUTOCOMMIT=1 npm run release:stage\n');
  process.exit(1);
}

// True when something is actually staged. `git diff --cached --quiet` exits
// non-zero when there ARE staged changes, so the throw is the success case.
const hasStaged = () => {
  try {
    cap('git diff --cached --quiet');
    return false;
  } catch {
    return true;
  }
};

function gitCommit(paths, message) {
  if (!inRepo()) return false;
  refuseOnStaleLock();
  if (paths === null) {
    const risky = pendingFiles().filter((f) => RISKY.test(f));
    if (risky.length) {
      console.error('\n✘ Refusing to auto-commit — these look like secrets:\n');
      risky.forEach((f) => console.error(`    ${f}`));
      console.error('\n  Add them to .gitignore, or commit what you meant to yourself,');
      console.error('  then run stage again. NO_AUTOCOMMIT=1 skips this step entirely.\n');
      process.exit(1);
    }
  }
  sh(paths === null ? 'git add -A' : `git add -- ${paths.join(' ')}`, true);
  if (!hasStaged()) return false;
  execSync('git commit -F -', { input: message, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return true;
}

// Called by `stage`, after the tests have passed.
function commitWork(note) {
  if (process.env.NO_AUTOCOMMIT) {
    if (dirty()) console.warn('\n⚠  NO_AUTOCOMMIT set — staging an uncommitted tree.\n');
    return;
  }
  if (!dirty()) return;
  const msg =
    `${note || 'Release work'}\n\n` +
    'Committed by release.mjs stage, after npm test passed.\n';
  if (gitCommit(null, msg)) {
    console.log(`\n✓ working tree committed as ${gitSha()} — this release is recoverable.\n`);
  }
}

// Called by `ship`, once the new version is verified live.
function commitRelease(version) {
  if (process.env.NO_AUTOCOMMIT) return;
  if (gitCommit(['package.json', 'CHANGELOG.md'], `Release v${version}\n`)) {
    console.log(`  release metadata committed for v${version}`);
  }
}

function bump(kind = 'patch') {
  const [maj, min, pat] = pkg.version.split('.').map(Number);
  const next = kind === 'major' ? `${maj + 1}.0.0` : kind === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  pkg.version = next;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  return next;
}

function changelog(version, note) {
  const path = 'CHANGELOG.md';
  const head = existsSync(path) ? readFileSync(path, 'utf8') : '# Changelog\n\nEvery version that has been live, newest first.\n';
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const entry = `\n## ${version} — ${stamp} UTC\n\n${note || '(no note given)'}\n\n- commit \`${gitSha()}\`\n`;
  const [title, ...rest] = head.split('\n## ');
  writeFileSync(path, title + entry + (rest.length ? '\n## ' + rest.join('\n## ') : ''));
}


/**
 * ── THE OTHER LAPTOP (21 Sep 2026, Dre's call) ───────────────────────────
 *
 * "An update from our other MacBook might have reverted some of our changes.
 * We always need to double check to make sure that we don't revert things
 * that are already done."
 *
 * Nothing in this tool had ever looked at the remote. `stage` built whatever
 * was on the machine it ran on and `ship` put it live, so a laptop that had
 * not pulled for a week would cheerfully deploy its own older tree over work
 * done somewhere else — and every other guard we have would stay green while
 * it happened:
 *
 *   · the tests pass, because the older tree is self-consistent
 *   · deploydrift.mjs says "up to date", because it compares the WORKER to
 *     the LOCAL repo, and both are stale together
 *   · `.deploy-shipped.json` is gitignored and per-machine, so this laptop's
 *     ledger has no idea the other one ever deployed
 *
 * The state that prompted this, measured on the Mac at the time: five commits
 * ahead of origin and unpushed, and the last `git fetch` was SIX DAYS old. A
 * week of work on one disk, invisible to the other machine and to every check
 * in this repo.
 *
 * So: fetch, then refuse to stage while the branch is behind its upstream.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
 *
 * It does not refuse for being AHEAD. Unpushed work is normal mid-session and
 * blocking on it would make the tool unusable; it says so and moves on, which
 * is the nudge that matters.
 *
 * It does not pretend to have checked when it could not. A fetch fails on a
 * plane, behind a proxy, or with no key loaded — and a guard that silently
 * passes in that case is worse than no guard, because it teaches people the
 * check happened. It says plainly that the remote could not be reached and
 * names what it could not rule out.
 */
function refuseIfBehindRemote() {
  if (process.env.NO_REMOTE_CHECK) {
    console.warn('\n⚠  NO_REMOTE_CHECK set — shipping without looking at the remote.\n');
    return;
  }
  let upstream = null;
  try { upstream = cap('git rev-parse --abbrev-ref --symbolic-full-name @{u}'); } catch { upstream = null; }
  if (!upstream) {
    console.warn('\n⚠  This branch tracks nothing, so there is no remote to compare against.');
    console.warn('   Whatever another machine has done is invisible from here.\n');
    return;
  }

  let fetched = true;
  try { execSync('git fetch --quiet', { stdio: 'pipe' }); } catch { fetched = false; }

  const [ahead, behind] = cap(`git rev-list --left-right --count HEAD...${upstream}`)
    .split(/\s+/).map(Number);

  if (!fetched) {
    console.warn(`\n⚠  COULD NOT REACH THE REMOTE. The comparison below is against whatever`);
    console.warn(`   ${upstream} looked like the last time this machine fetched, which may be`);
    console.warn('   old. Work pushed from another machine since then is not ruled out.\n');
  }

  if (behind > 0) {
    console.error(`\n✘ ${upstream} is ${behind} commit(s) AHEAD of this machine.`);
    console.error('  Staging now would build a tree that is missing them, and shipping it');
    console.error('  would put that missing work live — silently, because the tests pass and');
    console.error('  the drift ledger only ever compares this worker to this repo.\n');
    console.error('  Pull first:');
    console.error('    git pull --rebase\n');
    console.error('  Then run stage again.\n');
    process.exit(1);
  }

  if (ahead > 0) {
    console.warn(`\n⚠  ${ahead} commit(s) here are not on ${upstream} yet.`);
    console.warn('   Shipping is fine — but until they are pushed they exist on this disk');
    console.warn('   only, and the other machine will deploy over them without knowing.');
    console.warn('     git push\n');
  }
}

switch (cmd) {
  case 'stage': {
    // Tests BEFORE the build. A preview URL is something a person will open
    // and trust; a broken store selector or an unguarded credit site must not
    // be able to reach one.
    //
    // And tests before the BUMP, which is the newer half of this ordering.
    // `bump` rewrites package.json, so running it first meant every failed
    // stage moved the version number with nothing released — package.json
    // reached 0.8.231 while the last thing actually live was 0.8.229. A
    // version number that counts attempts rather than releases makes the
    // stale-stage guard below impossible to write, because there is no longer
    // any version the two files can agree on.
    // Checked BEFORE the tests as well as inside gitCommit. The suite takes
    // minutes; discovering a leftover lock file afterwards throws all of that
    // away for something that was true before we started. Both checks stay —
    // a lock can also appear while the tests are running.
    if (!process.env.NO_AUTOCOMMIT) refuseOnStaleLock();
    refuseIfBehindRemote();
    sh('npm test');

    // ── SCHEMA BEFORE CODE ──────────────────────────────────────────────
    //
    // A migration written but never applied is the quietest failure this repo
    // has. The code ships, the column is missing, and every write that needs
    // it disappears into a `.catch()`. It happened with 0022 on 12 Sep and
    // again with booking_fee_minor before that.
    //
    // Here is the only safe moment for it: the tests have passed, so the
    // migration belongs to code that works, and NOTHING is live yet — `stage`
    // only uploads, `ship` moves traffic. So the schema lands first and the
    // code that needs it goes live second, which is the order that cannot
    // break. These migrations are additive (ALTER / CREATE IF NOT EXISTS), so
    // one applied a few minutes before its code is a no-op, not a risk.
    applyPendingMigrations();

    // Commit here: after the tests, before the bump. What lands in the commit
    // is precisely what passed, and `changelog` below records this sha.
    commitWork(arg);
    const version = bump(process.env.BUMP || 'patch');
    // The build stamps the version in, so a running app can say what it is.
    process.env.VITE_NUM_VERSION = version;
    process.env.VITE_NUM_SHA = gitSha();
    sh('npm run build');
    changelog(version, arg);
    console.log(`\n── uploading ${version} as a version (NOT live yet)\n`);
    // `versions upload` publishes the code without moving any traffic to it.
    // The Worker reports the same version the bundle was stamped with, so
    // /api/version and the app agree or the mismatch is real.
    //
    // The upload's version id is captured here: `versions deploy` has no
    // "just take the newest" flag, and an interactive picker is no good in a
    // script. Tee so the operator still sees the preview URL.
    const out = cap(`npx wrangler versions upload ${CONFIG} --var NUM_VERSION:${version} 2>&1`);
    console.log(out);
    const id = /Worker Version ID:\s*([0-9a-f-]{36})/.exec(out)?.[1];
    if (id) writeFileSync(STAGED, JSON.stringify({ id, version, at: new Date().toISOString() }, null, 2) + '\n');
    else console.warn('\n⚠  Could not read the version id — `ship` will ask you to pick.\n');
    console.log(`\n✓ ${version} is uploaded and NOT serving traffic.`);
    console.log('  Open the preview URL printed above and check it.');
    console.log('  Then:  node scripts/release.mjs ship        (100% of traffic)');
    console.log('     or:  node scripts/release.mjs ship 10    (10% first)\n');
    break;
  }

  case 'ship': {
    const pct = Number(arg) || 100;
    const staged = existsSync(STAGED) ? JSON.parse(readFileSync(STAGED, 'utf8')) : null;
    if (pct === 100) {
      if (!staged?.id) {
        console.error('\nNothing staged. Run `node scripts/release.mjs stage "what changed"` first.\n');
        process.exit(1);
      }
      // ── THE STALE-STAGE GUARD ───────────────────────────────────────────
      //
      // `.release-staged.json` is written by `stage` and never cleared. If a
      // stage FAILS — tests, build, upload — the file keeps pointing at
      // whatever was last uploaded successfully, which may be weeks old. Then
      // `ship` deploys that, and because Cloudflare has no idea you meant to
      // go forwards, it is a silent ROLLBACK of everything since.
      //
      // This happened on 2 Sep 2026: two failed stages left package.json at
      // 0.8.231 while this file still named 0.8.229 from 31 August. `ship`
      // tried to deploy the August version over a week of live work. The only
      // thing that stopped it was Cloudflare noticing a secret had changed and
      // refusing — and the message it prints suggests `?force=true`, which
      // would have completed the rollback.
      //
      // So: the staged version must BE the version in package.json. If it is
      // not, the stage that was supposed to produce it did not finish.
      if (staged.version !== pkg.version) {
        console.error(`\n✘ Nothing to ship for ${pkg.version}.`);
        console.error(`  The last successful upload was ${staged.version}${staged.at ? ` (${staged.at})` : ''}.`);
        console.error('  Shipping it now would ROLL PRODUCTION BACK to that version.');
        console.error('\n  A stage since then failed before it uploaded. Run it again:');
        console.error('    node scripts/release.mjs stage "what changed"\n');
        console.error('  Do NOT pass --force to wrangler to get past a "secret has changed"');
        console.error('  error here. That error is this same problem, caught downstream.\n');
        process.exit(1);
      }
      console.log(`\n── sending all traffic to ${staged.version} (${staged.id})\n`);
      sh(`npx wrangler versions deploy ${staged.id}@100% --yes ${CONFIG}`);
      // Confirm against the running Worker rather than trusting the exit code —
      // "deployed" and "serving" are not the same claim. A new version takes a
      // few seconds to reach every edge, so this polls instead of asking once;
      // a check that cries wolf on every deploy is a check people learn to
      // ignore.
      // A new version does not reach every edge at once, and during the swap
      // the same URL will answer with the OLD version and the NEW one
      // alternately. One matching sample therefore proves nothing — it only
      // proves that ONE colo has caught up. Require several in a row, so
      // "verified" means the fleet has converged rather than that we got lucky
      // on the first poll.
      const NEEDED = 3;
      let serving = null;
      let streak = 0;
      for (let i = 0; i < 20 && streak < NEEDED; i++) {
        try {
          serving = JSON.parse(cap('curl -s --max-time 10 https://app.itsnum.com/api/version')).version;
          streak = serving === staged.version ? streak + 1 : 0;
        } catch {
          streak = 0; // a failed read is not agreement
        }
        if (streak < NEEDED) execSync('sleep 3');
      }
      if (streak < NEEDED) serving = serving === staged.version ? 'a mix of versions' : serving;
      if (streak < NEEDED) {
        console.error(`\n✘ deploy reported success but production is still serving ${serving ?? 'an unknown version'}, not ${staged.version}.`);
        console.error('  Check `npm run release` and roll back if this is wrong.\n');
        process.exit(1);
      }
      console.log(`  verified: production is serving ${serving}`);

      // Now that the new code IS the live code, check that every MCP surface
      // still agrees with itself. `npm test` already ran the offline half
      // during `stage` (source ↔ docs); this is the half that needs a deployed
      // server: live tools/list, the published listings, the registry entry,
      // and a real call to every advertised tool.
      //
      // Placed AFTER the traffic flip on purpose. Before it, the live server is
      // the old one and the check would confirm the previous release. Here, a
      // failure is actionable in the one way that matters: `release.mjs
      // rollback` is the next line of the message.
      //
      // NOT wrapped in try/catch. A drift check whose failure is swallowed is
      // the thing that let a paid tool point at a dead endpoint for a week.
      console.log('\n── MCP integrity: source ↔ live ↔ listing ↔ docs\n');
      try {
        sh('node scripts/mcp-integrity.mjs');
      } catch {
        console.error('\n✘ v' + pkg.version + ' is LIVE and at least one MCP surface disagrees with itself.');
        console.error('  An agent is being advertised something this deploy does not deliver.');
        console.error('  Fix forward, or: node scripts/release.mjs rollback');
        console.error('  Procedure: HQ/divisions/num/MCP_INTEGRITY.md\n');
        process.exit(1);
      }
    } else {
      console.log(`\n── ${pct}% of traffic to the newest version, the rest stays put\n`);
      console.log('  wrangler will ask which two versions to split between.\n');
      sh(`npx wrangler versions deploy ${CONFIG}`);
    }
    // The bump and the changelog entry are only true once the version is
    // actually serving, so they are committed here rather than in `stage`.
    commitRelease(pkg.version);
    try {
      sh(`git tag -f v${pkg.version} && echo "tagged v${pkg.version}"`, true);
    } catch {
      /* tagging is a convenience, never a blocker */
    }
    // ── WHO ELSE IS NOW BEHIND ────────────────────────────────────────
    //
    // num-app has just shipped. Every OTHER worker that compiles a file this
    // release changed is now running older code, and nothing about that fails.
    //
    // 15 Sep 2026 is why this is here: `ai/places.js` was fixed and deployed
    // to num-ai, num-app bundles the same file and was not redeployed, and the
    // Hollywood bug stayed live in the phone app for the rest of the session
    // while every signal said the fix had shipped. See scripts/deploydrift.mjs.
    //
    // A warning, not a failure: this release IS live and correct, and exiting
    // non-zero here would imply otherwise. What is left to do is other deploys,
    // and the message prints the command for each of them.
    try {
      const drift = await import('./deploydrift.mjs');
      drift.record('num-app');
      const warn = drift.siblingWarning('num-app');
      if (warn) console.log(warn);
    } catch (e) {
      console.warn('  (could not check sibling workers: ' + (e?.message ?? e) + ')');
    }

    console.log(`\n✓ v${pkg.version} is live.\n`);
    break;
  }

  // The same remote guard, callable on its own — because `npm run deploy:site`
  // ships public/ through a bare `wrangler deploy` that never passes through
  // stage, and a site deploy from a tree that is behind puts the missing pages
  // live exactly as an app deploy would. It happened on 20 Sep 2026: a CSS fix
  // shipped from a tree that lacked a 16 Sep commit touching 87 pages, and the
  // site served the older ones until somebody deployed again from a current
  // tree. One function, two callers, rather than a second copy that drifts.
  case 'remote-check': {
    refuseIfBehindRemote();
    console.log('✓ this tree is not behind its upstream');
    break;
  }

  case 'rollback': {
    console.log('\n── rolling back to the previous version\n');
    sh(`npx wrangler rollback ${CONFIG}`);
    break;
  }

  case 'list':
  default: {
    console.log(`\nlocal version: ${pkg.version}  (${gitSha()}${dirty() ? ', uncommitted changes' : ''})\n`);
    console.log('── what is live and what is uploaded\n');
    sh(`npx wrangler deployments list ${CONFIG}`);
    console.log('\nusage:');
    console.log('  node scripts/release.mjs stage "what changed"   build + upload, not live');
    console.log('  node scripts/release.mjs ship [percent]         send traffic to it');
    console.log('  node scripts/release.mjs rollback               back to the previous one');
    console.log('  node scripts/release.mjs remote-check           refuse if this tree is behind');
    console.log('  BUMP=minor node scripts/release.mjs stage "…"   minor instead of patch\n');
    break;
  }
}
