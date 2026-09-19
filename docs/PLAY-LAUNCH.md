# Google Play — the critical path

**State on 18 Sep 2026:** nothing exists on Play. No developer account, no app
record, no upload key had ever been made, and no AAB had ever been built. The
`android/` folder was a Capacitor scaffold with `versionCode 1` and a signing
block waiting for a `keystore.properties` that was not there.

What changed in this session: the toolchain is installed, the upload key exists,
and a signed release AAB builds. Everything still blocking is an account
question, not an engineering one.

---

## The one decision that sets the date

| | Personal account | Organization account |
|---|---|---|
| Time to open | minutes | days — needs a D-U-N-S number |
| Closed testing before production | **12 opted-in testers, 14 continuous days** | none |
| Earliest production | ~14 days after the testers are recruited | as soon as review passes |

The 12-tester rule applies only to **personal** accounts created after
13 Nov 2023. An organization account is exempt from it entirely. NUM is a
registered entity and the D-U-N-S is being obtained, so this is the route.

Testers who opt in, test for fewer than 14 days and opt out **do not count** —
the clock is per-tester and continuous, which is why the personal route is
routinely a month rather than a fortnight in practice.

---

## Done in this session

- **JDK 21** (`/opt/homebrew/opt/openjdk@21`) and the **Android SDK**
  (`/opt/homebrew/share/android-commandlinetools`, platform 36, build-tools 36)
  installed via Homebrew. The Temurin *cask* needs `sudo` and could not be used;
  the `openjdk@21` *formula* installs with no password and works.
- **Upload keystore** generated: `~/.stickfactory/num-upload.jks`, alias
  `num-upload`, RSA 4096, valid to Feb 2054, password in
  `~/.stickfactory/num-upload.pass` (mode 600). It sits with the other NUM
  secrets, outside every repo.
- **`android/keystore.properties`** written and confirmed ignored by
  `android/.gitignore:61`. `git check-ignore` agrees. It is not in the history
  and must never be.
- **`android/local.properties`** points Gradle at the SDK.

### Rebuilding the AAB

```
cd ~/NUM/code/num-site-fixes
npm run build && npx cap sync android          # only if dist/ is stale
cd android && ./gradlew bundleRelease
# → android/app/build/outputs/bundle/release/app-release.aab
```

`JAVA_HOME=/opt/homebrew/opt/openjdk@21` and
`ANDROID_HOME=/opt/homebrew/share/android-commandlinetools` must be in the
environment. Worth adding to `~/.zshrc` so this is one command next time.

**`versionCode` must increase on every upload and can never be reused.** It is
`1` now, in `android/app/build.gradle:41`. Bump it before the second upload,
every time, or Play refuses the file.

---

## What only Dre can do

1. **Open the developer account** at play.google.com/console — organization
   type, $25 one-time, D-U-N-S for NUM.
2. **Complete developer verification.** `docs/LAUNCH.md` records a
   **30 Sept 2026** deadline for the Thailand first wave. Confirm that date
   against the current Play Console notice before relying on it.
3. **Create the app**: name `Num`, default language English (US), type App,
   free.
4. **Enrol in Play App Signing** at first upload. This matters more than it
   sounds: with it, `num-upload.jks` is only the *upload* key, and losing it is
   a support ticket rather than the end of the app. Without it, losing that file
   means com.itsnum.app can never be updated by anyone, ever.
5. Upload the AAB to **internal testing** first, not production.
