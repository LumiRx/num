# The gate that would have caught both rejections
**14 Sep 2026 · validated against the actual rejected binary**

Three submissions, two rejections, both of a kind that no code review, no test
suite and no screenshot could see. This is what now stands in the way.

---

## What actually went wrong, twice

| Build | Finding | Real cause | Visible in source? |
|---|---|---|---|
| **1.0 (2)** | 2.1.0 crash, plus 4.8, 4.0, 5.1.1 behind it | `NSCameraUsageDescription` missing from Info.plist — iOS kills the process when the picker offers "Take Photo". The reviewer never reached Profile, so Sign in with Apple and account deletion were both reported missing | No — a missing key |
| **1.0 (6)** | 2.1.0 crash | The auto-updater ran in the App Store build, compared the frozen bundle against the live Worker, and called `location.reload()` 2.5s in | No — the gate simply wasn't there |

Both are one grep away **in the built artifact**. Neither is obvious in a diff.

And both shipped for the same process reason: **builds 5 and 6 went to App
Review with zero installs and zero sessions.** Nobody had ever opened either
one.

---

## Two gates, and why it takes two

### `npm run store:audit` — reads the bundle

Runs against the built `.app`, not the source:

- the Info.plist keys whose absence terminates the process
- the auto-updater import must sit behind the not-native guard
- the boot service-worker registration must be gated
- third-party trackers in `index.html` must have an origin guard (5.1.2)
- test files inside the shipped bundle
- `armv7` in `UIRequiredDeviceCapabilities`
- bundle stamp vs `package.json` — catches shipping a stale bundle

**Validated:** fails 1.0 (6), passes 1.0 (7).

### `npm run store:smoke` — watches it run

Counts how many times WebKit commits a page load. It should be exactly once.

```
1.0 (7) fixed      page commits: 1   → pass
1.0 (6) rejected   page commits: 2   → fail
```

**Validated:** two consecutive runs, identical results, no flakiness.

### `npm run store:check` — both, from a clean build

Syncs, builds for an iPad simulator, audits the bundle, then watches it launch.
Ninety seconds. Exit zero means safe to archive.

---

## Two approaches that were tried and abandoned

Worth recording, because both looked reasonable and both were wrong.

**An absolute size threshold on screenshots.** A simulator screenshot is the
whole screen. The iPad *home screen* — wallpaper, icons, dock — compresses to
~3.9 MB; this app's flat UI to ~550 KB. Richer pixels, not more content. Any
threshold calibrated against the home screen judges a healthy app to be blank.

**Screenshot sampling for the blank frame.** A screenshot costs about a second
on this hardware; the blank moment during a reload lasts a few hundred
milliseconds. Sampling raced it and lost — the same rejected build was caught
on one run and passed on the next. **A flaky gate is worse than no gate**,
because people learn to rerun it until it goes green.

WebKit's own page-commit log says it plainly instead, and says it the same way
every time.

---

## The live bug found while building this

`/api/version` was answering **`"unknown"`** in production.

`NUM_VERSION` is set as a flag passed at upload time by `release.mjs` and
nothing else sets it, so any deploy that skipped the release script lost it.
`"unknown"` is a real string that differs from any version number — so the
auto-updater compared them, found a difference, and reloaded.

**Every visitor to the website was reloading ~2.5 seconds after landing.** The
same failure that got iOS rejected, running on the other platform, while the
iOS fix sat in review. The native gate fixed iOS and did nothing for the web,
because on the web the auto-updater is supposed to run.

Fixed at the root: a version the server cannot name is not evidence of a newer
one. Two tests pin it, including one asserting the guard runs *before* the
comparison — in the wrong order it still fires.

---

## The rule

**No build goes to App Review that nobody has opened.**

`store:check` is the cheap version — ninety seconds, no device, no TestFlight
wait. It does not replace installing the real build from TestFlight and opening
it before you submit. It means you find the obvious failures before you spend
an upload and two days on them.

## Still open, deliberately

- `sw.test.mjs` ships inside the app bundle. Cosmetic; every user gets it.
- `UIRequiredDeviceCapabilities` still claims `armv7`, from the Capacitor
  template. Harmless on arm64, but untrue.
- Neither blocks a submission, so both are warnings rather than failures.
