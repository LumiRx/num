# App Review Information — paste-ready

**Supersedes `APP-REVIEW-INFORMATION-1.0.5.md`, which is now wrong.**

That file tells the reviewer: *"About a second after the app opens, a sheet
appears asking for a name and a way to reach you."* That was true of build 5.
Version 0.8.323 shipped ask-first sign-up and deliberately removed the forced
sheet, and nobody updated the notes. The reviewer of build 1.0(8) read them,
waited for a sheet that no longer exists, could not find any other way in, and
rejected on Guideline 2.1 — "Where is the sign-in page?"

**Rule going forward: these notes are part of the build.** If the first-run
experience changes, this file changes in the same commit. A reviewer following
stale instructions is a rejection with our name on it, not theirs.

---

## Field: Sign-In Required — YES

- **User Name:** the demo phone number, in full international form
- **Password:** the review access code

Both must match the Worker secrets exactly. **Test them against production
before submitting**, not after: a demo account that does not authenticate looks
identical, from the reviewer's side, to an app that does not work.

---

## Field: Notes

```
WHAT THIS BUILD CHANGES

Your review of build 1.0(8) asked where the sign-in page was. You were right
to ask, and the cause was ours: our conversation panel renders above the app
header, so on launch the header — which held the only route to the account —
was covered. We have verified by hit-testing on an iPad Air in both
orientations that this was true, and that it is now fixed.

WHERE SIGN-IN IS

Top-right of the first screen, labelled "Sign in". It is visible the moment
the app opens while signed out, on iPhone and iPad, in portrait and landscape,
without scrolling or dismissing anything. Tapping it opens the account sheet,
which offers Sign in with Apple and phone-number sign-in.

USING THE APP WITHOUT AN ACCOUNT

This is deliberate and we mention it so it does not read as something missing:
the concierge answers fully with no account, no phone number and no payment.
Ask it anything from the message box at the bottom. An account is needed only
for bookings, shared plans and group bills, because each of those needs a way
to reach the member afterwards.

SIGN IN WITH APPLE — GUIDELINE 4.8

Offered on the account sheet described above and on the Profile screen,
implemented natively via ASAuthorizationAppleIDProvider and verified
server-side against Apple's published keys. No third-party sign-in option is
offered on iOS.

ACCOUNT DELETION — GUIDELINE 5.1.1(v)

  1. Sign in with the credentials above.
  2. Tap the avatar at the top-right.
  3. Scroll to the bottom of the Profile screen.
  4. Tap "Delete my account".
  5. Type DELETE in the field and confirm.

The account and its contents are permanently deleted, not deactivated. There
is no reactivation window and no support step.
```

---

## Before every submission — run this

```
npm run review:ipad -- https://<the preview or production url>
```

`scripts/ipad-review-walkthrough.mjs` drives an iPad Air viewport in both
orientations and **hit-tests** each control: it asks the page what is actually
underneath the button rather than trusting that the button rendered. That
distinction is the entire reason build 1.0(8) was rejected — the sign-in route
was present, in the viewport, correctly sized, and underneath something else.

It exits non-zero if a reviewer could not sign in, so it can gate a submission.

Two things it cannot check, because a browser has neither the Capacitor plugin
nor a real Apple ID. **Do these by hand in the native build every time:**

- Sign in with Apple appears on the account sheet and completes (4.8).
- Profile → bottom → Delete my account completes (5.1.1(v)).

---

## The pattern worth remembering

Three rejections, all reviewed on an iPad Air, all traced to one thing.

| Build | Finding | What it actually was |
|---|---|---|
| 1.0(2) | Sign in with Apple and account deletion missing | Both on Profile; Profile reached from the covered header |
| 1.0(5) | notes said "tap the profile picture at the top" | The reviewer could not, for the same reason |
| 1.0(8) | "Where is the sign-in page?" | The header was behind the thread panel on launch |

It was diagnosed as a crash the first time, a documentation gap the second, and
a missing page the third. `src/lib/appreview.test.mjs` now pins the repairs,
and every finding in that file is a real rejection, not a hypothetical.
