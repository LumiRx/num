#!/usr/bin/env node
/**
 * Build, check, and upload an iOS build — in an order that cannot be skipped.
 *
 *   npm run app:ship
 *
 * ── WHY THIS IS ONE COMMAND ────────────────────────────────────────────────
 *
 * Three submissions, two rejections, and both rejections came from a step that
 * was available but not taken:
 *
 *   · 1.0 (2) shipped with a missing Info.plist key. Reading the built bundle
 *     would have found it in a second.
 *   · 1.0 (6) shipped with the auto-updater reloading the page 2.5s in. Opening
 *     it once would have shown it. Builds 5 and 6 both went to App Review with
 *     ZERO installs and ZERO sessions — nobody ever opened either.
 *
 * A checklist that people can skip is a checklist people skip, under deadline,
 * every time. So the gate is not a document; it is the only path to an upload.
 *
 * The order matters: everything cheap and fallible runs BEFORE the three
 * minutes of archiving, so a failure costs seconds rather than a wasted cycle.
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';

const TEAM = process.env.ASC_TEAM_ID || '6X2UDX3SUP';
const OUT = '/tmp/num-ship';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const cap = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const die = (msg) => { console.error(`\n✘ ${msg}\n`); process.exit(1); };

const pbx = 'ios/App/App.xcodeproj/project.pbxproj';
if (!existsSync(pbx)) die('run this from the repo root.');
const readBuild = () => Number(/CURRENT_PROJECT_VERSION = (\d+);/.exec(readFileSync(pbx, 'utf8'))?.[1]);
const marketing = /MARKETING_VERSION = ([\d.]+);/.exec(readFileSync(pbx, 'utf8'))?.[1];

console.log(`── shipping ${marketing} (${readBuild()})\n`);

/* ── 1 · does Apple already have this build number? ────────────────────────
 *
 * First, because it is one request and it invalidates everything after it.
 * The project file is not authoritative: on 13 Sep 2026 it read 5 while Apple
 * held 6, and on 15 Sep it read 7 while Apple held 8. Something outside the
 * repository increments it. Apple is the only source of truth.
 */
if (process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID && process.env.ASC_APP_ID) {
  let highest = null;
  try {
    highest = cap(`node scripts/asc-builds.mjs ${marketing}`);
  } catch {
    console.log('⚠  could not reach App Store Connect for a build-number check — continuing.\n');
  }
  if (highest && highest !== 'none') {
    const theirs = Number(highest);
    const ours = readBuild();
    console.log(`   Apple holds up to build ${theirs} for ${marketing}; this tree says ${ours}.`);
    if (ours <= theirs) {
      die(
        `build ${ours} would be REFUSED — Apple already has ${theirs}.\n` +
        `   Apple rejects this after the archive, the export and the transfer, several\n` +
        `   minutes in. Set CURRENT_PROJECT_VERSION to ${theirs + 1} in ${pbx} and run again.`,
      );
    }
    console.log('   ✓ build number is clear\n');
  }
} else {
  console.log('⚠  ASC_KEY_ID / ASC_ISSUER_ID / ASC_APP_ID not set — skipping the build-number check.');
  console.log('   Without it, a collision is only discovered after the upload.\n');
}

/* ── 2 · the gate: read the bundle, then watch it run ─────────────────────── */
console.log('── store check (audit + launch smoke)');
try {
  run('node', ['scripts/ios-store-check.mjs']);
} catch {
  die('the store check failed. Do not archive. Fix what it named and run again.');
}

/* ── 3 · archive ──────────────────────────────────────────────────────────── */
console.log('\n── archiving');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
run('xcodebuild', [
  '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release',
  '-destination', 'generic/platform=iOS', '-archivePath', `${OUT}/Num.xcarchive`, 'archive',
  'CODE_SIGN_STYLE=Automatic', `DEVELOPMENT_TEAM=${TEAM}`, '-allowProvisioningUpdates',
], { stdio: ['pipe', 'pipe', 'inherit'] });

/* ── 4 · audit the ARCHIVE too ────────────────────────────────────────────
 *
 * Not paranoia. The simulator build and the device archive are separate
 * products of separate build settings; auditing one is not auditing the other.
 */
console.log('── auditing the archive itself');
try {
  run('node', ['scripts/ios-store-audit.mjs', `${OUT}/Num.xcarchive/Products/Applications/App.app`]);
} catch {
  die('the archive failed the audit. It differs from the simulator build that passed.');
}

/* ── 5 · export and validate ──────────────────────────────────────────────── */
writeFileSync(`${OUT}/exportOptions.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>${TEAM}</string>
  <key>uploadSymbols</key><true/>
  <key>signingStyle</key><string>automatic</string>
  <key>destination</key><string>export</string>
</dict></plist>
`);
console.log('── exporting');
run('xcodebuild', [
  '-exportArchive', '-archivePath', `${OUT}/Num.xcarchive`,
  '-exportOptionsPlist', `${OUT}/exportOptions.plist`, '-exportPath', `${OUT}/export`,
  '-allowProvisioningUpdates',
], { stdio: ['pipe', 'pipe', 'inherit'] });

const ipa = `${OUT}/export/App.ipa`;
if (!existsSync(ipa)) die('no IPA was produced.');

/* ── 5b · audit the IPA — it is NOT the archive ───────────────────────────
 *
 * ── MEASURED 15 SEP 2026 ─────────────────────────────────────────────────
 *
 * The archive's Info.plist said CFBundleVersion 7. The IPA exported FROM that
 * archive said 8. `xcodebuild -exportArchive` with automatic signing silently
 * increments the build number when the one you built is already taken at App
 * Store Connect — and it does it after every check that reads the archive.
 *
 * This is also why the project file has never matched what Apple holds: it
 * read 5 when Apple had 6, and 7 when Apple had 8. Nothing "outside the
 * repository" was incrementing it. The export step was.
 *
 * So the IPA gets audited too, and the build number reported at the end is
 * read back from the IPA rather than from the project file — otherwise this
 * script would tell you to select a build number that does not exist.
 */
console.log('── auditing the exported IPA');
const unpacked = `${OUT}/unpacked`;
rmSync(unpacked, { recursive: true, force: true });
mkdirSync(unpacked, { recursive: true });
run('unzip', ['-o', '-q', ipa, '-d', unpacked], { stdio: ['pipe', 'pipe', 'inherit'] });
const ipaApp = `${unpacked}/Payload/App.app`;
if (!existsSync(ipaApp)) die('the IPA had no Payload/App.app.');
try {
  run('node', ['scripts/ios-store-audit.mjs', ipaApp]);
} catch {
  die('the exported IPA failed the audit even though the archive passed. The export changed something.');
}
const shipped = Number(
  cap(`/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" ${JSON.stringify(`${ipaApp}/Info.plist`)}`),
);
if (shipped !== readBuild()) {
  console.log(`\n⚠  the export renumbered this build: you built ${readBuild()}, the IPA is ${shipped}.`);
  console.log('   Xcode does this when the number you built is already taken at Apple.');
  console.log(`   Set CURRENT_PROJECT_VERSION to ${shipped} so the tree matches what shipped.\n`);
}

console.log('── validating with Apple');
try {
  run('xcrun', ['altool', '--validate-app', '-f', ipa, '-t', 'ios',
    '--apiKey', process.env.ASC_KEY_ID ?? '', '--apiIssuer', process.env.ASC_ISSUER_ID ?? '']);
} catch {
  die('Apple refused the build at validation. Nothing was uploaded.');
}

/* ── 6 · upload ───────────────────────────────────────────────────────────── */
console.log('── uploading');
run('xcrun', ['altool', '--upload-app', '-f', ipa, '-t', 'ios',
  '--apiKey', process.env.ASC_KEY_ID ?? '', '--apiIssuer', process.env.ASC_ISSUER_ID ?? '']);

console.log(`\n✓ ${marketing} (${shipped}) uploaded and every gate passed.\n`);
console.log('  TWO THINGS THE MACHINE CANNOT DO FOR YOU:');
console.log('    1. Install it FROM TESTFLIGHT and open it on a real phone.');
console.log('       Builds 5 and 6 both went to review unopened. That is how both got rejected.');
console.log(`    2. On the version page, SELECT THIS BUILD (${readBuild()}).`);
console.log('       On 12 Sep the page was still pointing at the rejected build 2 at submit time.\n');
