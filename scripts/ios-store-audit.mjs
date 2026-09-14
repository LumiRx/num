#!/usr/bin/env node
/**
 * Read the app that is about to be shipped, not the source it came from.
 *
 * ── WHY THIS READS THE BUILT BUNDLE ────────────────────────────────────────
 *
 * Every rejection this app has taken was invisible in source review and visible
 * in the artifact:
 *
 *   1.0 (2), Aug 2026 — guideline 2.1.0, plus 4.8, 4.0 and 5.1.1 behind it.
 *     NSCameraUsageDescription was missing from Info.plist. iOS kills the
 *     process the instant the picker offers "Take Photo". Three of the four
 *     findings were the reviewer never reaching the Profile screen.
 *
 *   1.0 (6), Sep 2026 — guideline 2.1.0 again.
 *     The auto-updater ran in the App Store build and reloaded the page 2.5s
 *     in. Source looked fine; the gate simply was not there.
 *
 * Both are one grep away in the bundle. Neither is obvious in a diff.
 *
 * This is the static half. `ios-launch-smoke.mjs` is the half that watches it
 * run. Ship nothing that has not passed both.
 *
 * Usage:  node scripts/ios-store-audit.mjs <path-to-.app>
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const APP = process.argv[2];
if (!APP || !existsSync(APP)) {
  console.error('usage: node scripts/ios-store-audit.mjs <path-to-.app>');
  process.exit(2);
}
const PUB = join(APP, 'public');
const fails = [];
const warns = [];
const notes = [];

const plist = (key) => {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(APP, 'Info.plist')], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
};
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const files = existsSync(PUB) ? walk(PUB) : [];
const js = files.filter((f) => f.endsWith('.js'));
const allJs = js.map((f) => readFileSync(f, 'utf8')).join('\n');
const indexHtml = existsSync(join(PUB, 'index.html')) ? readFileSync(join(PUB, 'index.html'), 'utf8') : '';

/* ── 1 · the keys whose absence terminates the process ───────────────────── */
for (const key of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']) {
  if (!plist(key)) {
    fails.push(`Info.plist is missing ${key}. iOS terminates the process (TCC SIGABRT) the moment the media picker offers that source. This is exactly what sank 1.0 (2).`);
  }
}

/* ── 2 · web-only boot work must be gated ────────────────────────────────── */
//
// Minified code makes this fiddly, so the rule is mechanical: for a marker on
// the boot path, slice back to the previous statement boundary and require a
// `&&` guard in what is left. Measured against the two real builds:
//
//   1.0 (6)  "}));ag(async()=>{...await import(\"./autoupdate-"   → no &&  → fail
//   1.0 (7)  "}));cg&&yg(async()=>{...await import(\"./autoupdate-" → &&    → pass
//   1.0 (6)  "}));\"serviceWorker\"in navigator&&"                → no &&  → fail
//   1.0 (7)  "const cg=!zt();cg&&\"serviceWorker\"in navigator&&"  → &&    → pass
//
// Occurrences inside an arrow-function body are helper definitions, not the
// boot path, and are skipped — otherwise every build fails on its own utils.
// `skipNested` is per-marker, and the difference is real:
//   · the auto-updater import lives INSIDE a callback by construction —
//     `cg&&yg(async()=>{ ...import... })` — so its site is always nested and
//     the guard shows up in the statement slice regardless. Check every site.
//   · `"serviceWorker"in navigator` also appears inside an on-demand recovery
//     method that has nothing to do with launch. Checking that one would
//     demand a gate on code Apple never sees at boot. Skip nested sites.
const guardedAt = (hay, marker, { skipNested = false } = {}) => {
  const out = [];
  let i = hay.indexOf(marker);
  while (i !== -1) {
    const from = Math.max(0, i - 160);
    const before = hay.slice(from, i);
    const stmt = before.slice(before.lastIndexOf(';') + 1);
    // Only statement-level uses are the boot path. An occurrence sitting inside
    // an open call or block — `Ve(this,"recover",async()=>{try{if(` — is a
    // method that runs on demand, not at launch, and gating it would be wrong.
    // Unbalanced openers in the slice mean we are inside one.
    const depth = (stmt.match(/[({]/g) ?? []).length - (stmt.match(/[)}]/g) ?? []).length;
    // a helper like `Dh=()=>"serviceWorker"in navigator` is a definition
    const isHelper = /\(\s*\)\s*=>\s*$/.test(stmt) || /=\s*\([^)]*\)\s*=>\s*$/.test(stmt);
    if ((!skipNested || depth <= 0) && !isHelper) out.push({ guarded: stmt.includes('&&'), stmt });
    i = hay.indexOf(marker, i + 1);
  }
  return out;
};

const autoMarker = /import\("\.\/autoupdate-[A-Za-z0-9_-]+\.js"\)/.exec(allJs)?.[0];
if (!autoMarker) {
  notes.push('no auto-updater chunk in the bundle at all — nothing to gate.');
} else {
  const sites = guardedAt(allJs, autoMarker);
  const open = sites.filter((s) => !s.guarded);
  if (open.length) {
    fails.push(`the auto-updater import is NOT behind a guard: "...${open[0].stmt.slice(-52)}". In an App Store build it compares a frozen bundle against the live Worker, always loses, and calls location.reload(). That is what Apple read as a crash in 1.0 (6).`);
  }
}

const swSites = guardedAt(allJs, '"serviceWorker"in navigator', { skipNested: true });
const swOpen = swSites.filter((s) => !s.guarded);
if (swOpen.length) {
  fails.push(`the boot service-worker registration is not gated: "...${swOpen[0].stmt.slice(-52)}". There is nothing for a service worker to cache inside an IPA, and a stale one can serve a previous build's index.html over the real one — a white screen with no error.`);
}

/* ── 3 · third-party tracking that runs before any consent prompt ─────────── */
const TRACKERS = [
  ['redditstatic.com', 'Reddit pixel'],
  ['connect.facebook.net', 'Meta pixel'],
  ['googletagmanager.com', 'Google Tag Manager'],
  ['google-analytics.com', 'Google Analytics'],
  ['static.cloudflareinsights.com', 'Cloudflare Insights'],
];
for (const [host, name] of TRACKERS) {
  if (!indexHtml.includes(host)) continue;
  // It may be present but guarded by origin. The guard has to be an origin
  // check, not a bridge check: index.html runs before any bundle loads, so a
  // Capacitor-bridge test reads "web" on the exact launch it must protect.
  if (!/capacitor:/.test(indexHtml)) {
    fails.push(`${name} (${host}) loads from index.html with no origin guard. Inside the IPA that contacts a third-party tracker at launch with no App Tracking Transparency prompt — guideline 5.1.2.`);
  }
}

/* ── 4 · things that should never be inside a shipped bundle ──────────────── */
const tests = files.filter((f) => /\.test\.(mjs|js|ts)$/.test(f));
if (tests.length) {
  warns.push(`${tests.length} test file(s) are inside the app bundle: ${tests.map((f) => f.split('/').pop()).join(', ')}. Cosmetic, but it ships to every user.`);
}

/* ── 5 · the device capability nobody meant to declare ────────────────────── */
try {
  const caps = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :UIRequiredDeviceCapabilities', join(APP, 'Info.plist')], { encoding: 'utf8' });
  if (/armv7/.test(caps)) {
    warns.push('UIRequiredDeviceCapabilities still lists armv7, from the Capacitor template. Harmless on arm64 hardware, but it is a claim that is not true.');
  }
} catch { /* key absent is fine */ }

/* ── 6 · is the bundle the one we think it is ─────────────────────────────── */
const stamp = [...new Set((allJs.match(/0\.\d+\.\d+/g) ?? []))].sort().pop();
let pkg = null;
try { pkg = JSON.parse(readFileSync('package.json', 'utf8')).version; } catch { /* run from elsewhere */ }
if (stamp && pkg && stamp !== pkg) {
  warns.push(`the bundle is stamped ${stamp} but package.json says ${pkg}. Run \`npm run app:sync\` — you are about to ship a bundle older than the tree.`);
} else if (stamp) {
  notes.push(`bundle stamp ${stamp}`);
}
notes.push(`version ${plist('CFBundleShortVersionString')} (${plist('CFBundleVersion')}) · ${plist('CFBundleIdentifier')}`);

/* ── report ──────────────────────────────────────────────────────────────── */
for (const n of notes) console.log(`   · ${n}`);
for (const w of warns) console.log(`\n⚠  ${w}`);
if (fails.length) {
  console.error(`\n✘ STORE AUDIT FAILED — ${fails.length} blocker(s)\n`);
  for (const f of fails) console.error(`   ✘ ${f}\n`);
  process.exit(1);
}
console.log(`\n✓ store audit passed${warns.length ? ` (${warns.length} warning(s) above)` : ''}.\n`);
