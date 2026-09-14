#!/usr/bin/env node
/**
 * The one command to run before an iOS build goes anywhere near Apple.
 *
 *   npm run store:check
 *
 * It builds the current tree for the simulator, reads the bundle that comes
 * out, and then watches it run for fifteen seconds. Both halves matter, and
 * neither is sufficient alone:
 *
 *   · the audit reads the artifact — it catches a missing Info.plist key or an
 *     ungated web-only boot path, which no source diff makes obvious.
 *   · the smoke watches it over time — it catches a reload, a white screen or
 *     a crash, which no single screenshot can see.
 *
 * ── THE RULE THIS ENFORCES ─────────────────────────────────────────────────
 *
 * Builds 5 and 6 both went to App Review with ZERO installs and ZERO sessions.
 * Nobody, human or otherwise, had opened either one. Build 6 came back rejected
 * under 2.1.0 and cost two days.
 *
 * No build goes to App Review that nobody has opened. This is the cheap
 * version of opening it — ninety seconds, no device, no TestFlight wait. It
 * does not replace installing the real build from TestFlight before you submit;
 * it means you find the obvious failures before you burn an upload on them.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const APP_DIR = 'ios/App';
const DERIVED = '/tmp/num-storecheck';
const BUILT = `${DERIVED}/Build/Products/Release-iphonesimulator/App.app`;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: 'inherit', ...opts });
const quiet = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

function pickSimulator() {
  if (process.env.SMOKE_SIM) return process.env.SMOKE_SIM;
  const json = JSON.parse(quiet('xcrun simctl list devices available --json'));
  const all = Object.values(json.devices).flat();
  // An iPad, because that is the device class App Review used for both
  // rejections and the class where iPad-only faults (the popover source rect)
  // actually appear. Fall back to anything available.
  // Prefer one that is already booted: a cold first boot takes long enough
  // that `simctl launch` will hang against a SpringBoard that is not up yet.
  const booted = all.filter((d) => d.state === 'Booted');
  const pick = (xs) => xs.find((d) => /iPad Air/.test(d.name)) ?? xs.find((d) => /iPad/.test(d.name));
  const dev = pick(booted) ?? booted[0] ?? pick(all) ?? all[0];
  if (!dev) throw new Error('no available simulators');
  console.log(`── simulator: ${dev.name}`);
  return dev.udid;
}

try {
  if (!existsSync(APP_DIR)) throw new Error(`run this from the repo root (no ${APP_DIR})`);
  const udid = pickSimulator();

  console.log('\n── syncing the web build into the iOS project');
  run('npm', ['run', 'app:sync'], { stdio: ['pipe', 'pipe', 'inherit'] });

  console.log('── building for the simulator');
  run('xcodebuild', [
    '-project', `${APP_DIR}/App.xcodeproj`, '-scheme', 'App', '-configuration', 'Release',
    '-sdk', 'iphonesimulator', '-destination', `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath', DERIVED, 'CODE_SIGNING_ALLOWED=NO', 'build',
  ], { stdio: ['pipe', 'pipe', 'inherit'] });
  if (!existsSync(BUILT)) throw new Error('the build produced no App.app');

  console.log('\n── store audit (reads the bundle)');
  run('node', ['scripts/ios-store-audit.mjs', BUILT]);

  console.log('── launch smoke (watches it run)');
  try { execSync(`xcrun simctl boot ${udid}`, { stdio: 'ignore' }); } catch { /* already booted */ }
  // Wait for the device to actually finish booting. Without this, `simctl
  // launch` blocks indefinitely against a SpringBoard that has not come up —
  // which looks exactly like the app hanging, and is not.
  try {
    execSync(`xcrun simctl bootstatus ${udid} -b`, { stdio: 'ignore', timeout: 180_000 });
  } catch {
    throw new Error('the simulator did not finish booting within three minutes');
  }
  run('node', ['scripts/ios-launch-smoke.mjs', BUILT, udid]);

  console.log('✓ store check passed. Safe to archive.\n');
  console.log('  Still to do before you submit:');
  console.log('    · upload the archive');
  console.log('    · install it FROM TESTFLIGHT and open it on a real phone');
  console.log('    · only then add it for review\n');
} catch (err) {
  console.error(`\n✘ store check failed — do not archive.\n   ${err?.message ?? err}\n`);
  process.exit(1);
}
