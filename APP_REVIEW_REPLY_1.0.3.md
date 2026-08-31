# Reply to App Review — build 1.0(3)

Paste into the Resolution Center thread for submission
`2e72c004-c50d-4e41-a7a3-2d145c6156e3` when 1.0(3) is uploaded.

Apple explicitly asked for a reply on 4.8 and on 5.1.1, so this is not optional
courtesy — an unanswered request is a second rejection on the same finding.

**Attach the account-deletion screen recording before sending.**

---

Hello, and thank you for the detailed report — the crash log in particular made the
root cause unambiguous.

All four issues are addressed in build 1.0 (3).

**Guideline 2.1(a) — crash on tapping the profile picture.**
The crash log's termination reason identified it exactly: the process was terminated by
TCC for accessing privacy-sensitive data without a usage description. Tapping the profile
picture opens an image picker that offers "Take Photo", and our Info.plist contained no
usage descriptions at all. We have added NSCameraUsageDescription and
NSPhotoLibraryUsageDescription, each describing the actual use. We have also added an
automated test that fails the build if any file input accepting image or video media ships
without a matching usage description, so this class of crash cannot recur.

**Guideline 4.8 — Login Services.**
You are correct. The "Continue with Google" option shown in your screenshot was used to
link an existing identity from our sister product, and we offered no equivalent
privacy-preserving login. Build 1.0 (3) adds **Sign in with Apple** as a first-class login,
implemented natively with ASAuthorizationController. It requests only name and email, so a
user may withhold their real address via Private Relay, and we perform no advertising
tracking of any kind. It appears on the first screen of the app, above every other sign-in
option. The Google option has been removed from the iOS build entirely.

**Guideline 4 — Design, sign-in in the default browser.**
This was the same Google flow: its web SDK opened the system browser from inside our web
view. With that option removed from iOS, no account creation or sign-in step leaves the app.
Sign in with Apple is presented natively.

**Guideline 5.1.1(v) — account deletion.**
Account deletion was present in 1.0 (2) — at You → Delete my account, backed by a real
delete endpoint, not a deactivation — but we accept that it was not discoverable: it was
rendered as small, low-contrast text at the foot of the profile screen, below the control
that crashed your device. It is now a clearly labelled, outlined row stating that it
permanently erases the account and its data. A screen recording of the complete flow —
signing in, navigating to the option, and confirming deletion — is attached to this
submission and included in the App Review Information notes.

**One additional fix you did not raise.** Your screenshots showed the app rendering as a
phone-shaped card on a black background on iPad. That was a browser-only presentation style
leaking into the installed app. On iPad the app now fills the device.

**A note on the demo account.** Your screenshots show an account created with the name
"Qwerty" and no phone number. That path is intentional — a traveller is not blocked at the
door — but it creates an empty account, which does not show the product. The demo
credentials in the App Review Information fields open an account already containing
bookings, connections, a shared plan and a Stars ledger. In 1.0 (3), Sign in with Apple on
the first screen is the fastest way in and needs no code at all.

Thank you again for the clear reproduction steps.

---

## Pre-flight, at the moment of writing (2026-08-30 20:00 UTC)

| | |
|---|---|
| Full suite | 1,997 pass / 0 fail |
| ESLint | 0 errors |
| `tsc --noEmit` | 0 errors |
| Worker | **deployed** — `/api/social/apple` answers, Haiku routing and answer cache proven live |
| iOS bundle | rebuilt 19:54, carries "Sign in with Apple", `num-native`, "Delete my account" |
| Info.plist | camera + photo-library usage descriptions present |
| Entitlement | `com.apple.developer.applesignin: [Default]`, capability enabled on the App ID |
| Build number | 3, both configurations |

### ⚠️ Before `git add -A`

Another session was editing this same worktree between 19:19 and 19:57 — `worker/flightpay.mjs`,
`worker/pay.mjs`, `worker/flightconfirm.mjs`, `worker/mailer.mjs`, `worker/nudge.mjs`,
`growth/claimverify.mjs` and their tests. None of it is App Review work.

For about a minute those files were mid-edit and three tests failed; they pass now. But
`git add -A` will sweep that work into the same commit as the App Review fixes. Decide
deliberately whether that is what you want — a mixed commit is harder to roll back if only
one half turns out to be wrong.
