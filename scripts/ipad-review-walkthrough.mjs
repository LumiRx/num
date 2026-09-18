/**
 * WALK THE APP THE WAY APP REVIEW WALKS IT. RUN THIS BEFORE EVERY SUBMISSION.
 *
 *   node scripts/ipad-review-walkthrough.mjs https://<preview>.workers.dev
 *
 * Three rejections, all reviewed on an iPad Air 11-inch, all from things that
 * worked perfectly on a phone:
 *
 *   1.0(2)  Sign in with Apple and account deletion "missing" — both on
 *           Profile, which is reached from the app header.
 *   1.0(5)  notes told the reviewer to tap the profile picture at the top of
 *           the screen.
 *   1.0(8)  "Where is the sign-in page?"
 *
 * One cause: the thread panel (z-index 45, the app's default state) renders
 * over the app header, so the top of the app is not there on launch.
 *
 * The important word below is HIT-TEST. An element can be in the DOM, inside
 * the viewport, the right size, and still be untappable because something is
 * on top of it — which is precisely the bug that cost three submissions. So
 * this asks document.elementFromPoint what is actually under each control's
 * centre, and only counts a control that answers with itself.
 *
 * Exits non-zero when a reviewer could not do what the guidelines require,
 * so it can gate a submission in CI.
 */
/* global document, innerHeight, innerWidth */
// ^ The callbacks handed to page.evaluate() are serialised and run INSIDE the
//   browser, not in node. ESLint lints this file as node and is right to, so
//   the three globals those callbacks legitimately use are declared here.

// Resolved at run time, not imported at the top. Playwright is ~300MB of
// browsers and this script runs a handful of times a year, before App Store
// submissions — making `npm test` and every release carry that weight would be
// the wrong trade. If it is missing, say exactly how to get it.
const chromium = await (async () => {
  for (const spec of ['playwright', 'playwright-core']) {
    try { return (await import(spec)).chromium; } catch { /* try the next */ }
  }
  console.error('\nThis needs Playwright, which is not a dependency of this repo on purpose.\n'
    + '  npx playwright@1.55 install chromium   (once)\n'
    + '  npm i -D playwright@1.55               (or run it from a repo that has it)\n'
    + 'Set PW_CHROME to an existing Chromium binary to skip the download.\n');
  process.exit(2);
})();

const URL = process.argv[2];
if (!URL) {
  console.error('usage: node scripts/ipad-review-walkthrough.mjs <url>');
  process.exit(2);
}
// The exact device in all three review reports.
const IPAD = {
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};
const ORIENTATIONS = [
  ['portrait', { width: 820, height: 1180 }],
  ['landscape', { width: 1180, height: 820 }],
];

/** Every control whose visible text matches, that a finger could actually hit. */
const tappable = (page, text) => page.evaluate((want) => {
  const hit = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length) continue;
    if ((el.textContent || '').trim().toLowerCase() !== want.toLowerCase()) continue;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const inView = b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth;
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    const isSelf = top && (el.contains(top) || top.contains(el));
    hit.push({ inView, isSelf, h: Math.round(b.height), w: Math.round(b.width) });
  }
  return hit;
}, text);

const results = [];
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || undefined,
  args: ['--no-sandbox'],
});

for (const [name, viewport] of ORIENTATIONS) {
  const ctx = await browser.newContext({ ...IPAD, viewport });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(7000);

  const signIn = await tappable(page, 'Sign in');
  const good = signIn.filter((h) => h.inView && h.isSelf);
  const big = good.filter((h) => h.h >= 44);

  results.push({
    orientation: name,
    signInPresent: signIn.length > 0,
    signInTappable: good.length > 0,
    signInMeets44pt: big.length > 0,
    detail: signIn,
  });

  // And the account sheet must genuinely open from it, carrying Apple sign-in.
  if (good.length) {
    await page.getByText('Sign in', { exact: true }).last().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const sheet = await page.evaluate(() => document.body.innerText);
    results[results.length - 1].sheetOpens = /mobile|phone|name|continue/i.test(sheet);
    // Guideline 4.8 — CANNOT BE CHECKED FROM HERE, and saying so is the point.
    //
    // canSignInWithApple() in src/lib/appleAuth.ts requires
    // nativePlatform() === 'ios' AND the Capacitor plugin. A browser, even one
    // sending an iPad user-agent, has neither, so the button correctly renders
    // nothing. An earlier version of this script asserted on it anyway and
    // reported a failure that was an artefact of its own harness — which is
    // the same species of mistake as the bug it exists to catch.
    results[results.length - 1].appleOffered = /apple/i.test(sheet) ? true : 'native-only';
  }
  await ctx.close();
}
await browser.close();

let failed = false;
for (const r of results) {
  const line = (label, ok) => {
    if (!ok) failed = true;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  };
  console.log(`\niPad ${r.orientation}`);
  line('"Sign in" exists in the rendered app', r.signInPresent);
  line('a reviewer can actually tap it (nothing on top of it)', r.signInTappable);
  line('it meets Apple\'s 44pt minimum', r.signInMeets44pt);
  line('tapping it opens the account sheet', r.sheetOpens === true);
  if (r.appleOffered === 'native-only') {
    console.log('  n/a  Sign in with Apple (4.8) — native build only, verify on a device or simulator');
  } else {
    line('Sign in with Apple is offered there (Guideline 4.8)', r.appleOffered === true);
  }
}

console.log(failed
  ? '\n✘ A reviewer could not complete sign-in on an iPad. Do not submit.\n'
  : '\n✓ Sign-in is reachable on an iPad in both orientations.'
    + '\n  Still to check by hand in the NATIVE build, because a browser cannot:'
    + '\n    · Sign in with Apple appears on the account sheet (4.8)'
    + '\n    · Profile → bottom → Delete my account completes (5.1.1(v))\n');
process.exit(failed ? 1 : 0);
