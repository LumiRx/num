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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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

switch (cmd) {
  case 'stage': {
    if (dirty()) console.warn('\n⚠  Working tree has uncommitted changes — staging them anyway.\n');
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
      console.log(`\n── sending all traffic to ${staged.version} (${staged.id})\n`);
      sh(`npx wrangler versions deploy ${staged.id}@100% --yes ${CONFIG}`);
      // Confirm against the running Worker rather than trusting the exit code —
      // "deployed" and "serving" are not the same claim. A new version takes a
      // few seconds to reach every edge, so this polls instead of asking once;
      // a check that cries wolf on every deploy is a check people learn to
      // ignore.
      let serving = null;
      for (let i = 0; i < 10; i++) {
        try {
          serving = JSON.parse(cap('curl -s --max-time 10 https://app.itsnum.com/api/version')).version;
          if (serving === staged.version) break;
        } catch {
          /* edge still swapping — try again */
        }
        execSync('sleep 3');
      }
      if (serving !== staged.version) {
        console.error(`\n✘ deploy reported success but production is still serving ${serving ?? 'an unknown version'}, not ${staged.version}.`);
        console.error('  Check `npm run release` and roll back if this is wrong.\n');
        process.exit(1);
      }
      console.log(`  verified: production is serving ${serving}`);
    } else {
      console.log(`\n── ${pct}% of traffic to the newest version, the rest stays put\n`);
      console.log('  wrangler will ask which two versions to split between.\n');
      sh(`npx wrangler versions deploy ${CONFIG}`);
    }
    try {
      sh(`git tag -f v${pkg.version} && echo "tagged v${pkg.version}"`, true);
    } catch {
      /* tagging is a convenience, never a blocker */
    }
    console.log(`\n✓ v${pkg.version} is live.\n`);
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
    console.log('  BUMP=minor node scripts/release.mjs stage "…"   minor instead of patch\n');
    break;
  }
}
