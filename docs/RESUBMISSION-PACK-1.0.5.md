# NUM iOS — resubmission pack
**Prepared 12 Sep 2026 · build 1.0 (5) · verified against live code and the live API**

Apple has only ever received **1.0(1)** and **1.0(2)**. Builds 3 and 4 were never
uploaded. This resubmission is **1.0 (5)**.

---

## Part 1 — The video Apple asked for

Apple named the account-deletion recording specifically. Without it, 5.1.1(v)
is rejected again regardless of what the code does.

### Before you record — the one thing that can ruin the take

Deletion is **blocked** when the account has either of these open:

- a **live errand**
- an **open tab**

If the demo account has either, the screen shows *"Not yet — finish these
first"* and the confirmation never appears. On camera that looks exactly like
"account deletion is not available" — the rejection you are trying to answer.

A Stars balance is fine. It shows as a warning you acknowledge, not a wall.
That was fixed deliberately: Stars harm only the person leaving, so they are
theirs to give up.

**So: sign in as the demo account first, settle any open tab, finish or cancel
any running errand, and confirm the red confirmation box appears — then start
recording.**

### The shot list

Record on a **physical iPhone or iPad**, portrait, screen recording, no
narration needed. Around 45 seconds.

1. Launch the app from the home screen — cold, not resumed.
2. Sign in with the demo number and the review code.
3. Land on the concierge screen so it is clear you are inside a real account.
4. Tap the profile picture — **this is the tap that used to crash.** Let the
   Profile screen open and settle for two seconds.
5. Scroll to the bottom, past the sections, to the **"Delete my account"** row.
6. Tap it. The red **DELETE YOUR ACCOUNT** panel opens showing what the
   account holds and what is forfeited.
7. Type **DELETE** in the field. The button turns red as it becomes active.
8. Tap the button.
9. Hold on the confirmation until the app returns to a signed-out state.

Do not cut between steps 6 and 9 — Apple wants the deletion completed on
camera, not implied.

### Where it goes

**App Store Connect → your app → the 1.0 version page → App Review
Information → Notes.** Attach the video there and reference it in the reply
text below. There is an attachment control on that section; if the file is
large, trim the head and tail rather than compressing until it is unreadable.

---

## Part 2 — What is actually fixed (verified in code today)

| Apple's finding | Status | Evidence |
|---|---|---|
| **2.1(a)** crash on profile picture | Fixed, two causes | `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` present in Info.plist; the file input is laid out at `opacity: 0` rather than `display:none`, so iPad's popover has a rect to anchor to |
| **4.8** no Sign in with Apple | Present all along | `<AppleSignIn />` renders in ProfileView; the Google card is off on iOS |
| **5.1.1(v)** no account deletion | Present all along | `<DangerZone />` renders in ProfileView; `POST /api/account/delete` answers live |
| **4.0** registration leaves the app | Fixed | The outbound claim link is not offered on iOS |

Twelve tests in `src/lib/appreview.test.mjs` pin every one of these in source,
including a test that fails the build if `display:none` ever returns to the
file input. All twelve pass.

**Three of the four findings had a single cause.** Sign in with Apple and
Delete My Account both live on the Profile screen — the screen behind the tap
that crashed. The reviewer never reached it, so they reported both as missing.

---

## Part 3 — The reply to paste

> Hello, and thank you for the detailed review.
>
> **2.1(a) — Crash.** Reproduced and fixed. There were two separate faults, both
> on iPad. First, the app was missing `NSCameraUsageDescription` and
> `NSPhotoLibraryUsageDescription`, so iOS terminated the process when the media
> picker offered "Take Photo"; both keys are now present. Second, the file input
> behind the profile picture was `display:none`, which leaves iPad's popover
> presentation no source rect to anchor to. The input is now laid out and
> transparent so it presents correctly. Tested on iPad.
>
> **4.8 — Login Services.** The app offers Sign in with Apple as a first-class
> login, on the Profile screen and in the invite sheet, implemented natively via
> `ASAuthorizationAppleIDProvider` and verified server-side against Apple's
> published keys. The reviewer could not reach it because the crash above
> occurred on the way to that screen. Separately, the third-party "Continue with
> Google" option that prompted this issue is no longer offered on iOS at all.
>
> **4.0 — Design.** Fixed. The one place the app linked out to a web
> registration flow was the business-claim link. It is no longer offered on iOS.
>
> **5.1.1(v) — Account Deletion.** The app supports full in-app account
> deletion, on the Profile screen under "Delete my account". It permanently
> deletes the account rather than deactivating it. It was behind the same crash.
> A screen recording of the complete flow — signing in with the demo account,
> opening Profile, and confirming deletion through to completion — is attached
> in App Review Information.
>
> Thank you again.

---

## Part 4 — Before you submit

**Test the profile-picture tap on an iPad or the iPad simulator.** That exact
tap is what failed. It is the single highest-value five minutes in this list.

**Confirm the four `REVIEW_DEMO_*` secrets are set on the num-app Worker**, and
that the number and code in App Store Connect match them. A reviewer who cannot
sign in rejects on 2.1 without reading anything else.

**Sign in on a clean device the day you submit.** Install, type the number,
enter the code. Not the simulator — a real device that has never held this app.

---

## Part 5 — The risk that is not on Apple's list

The concierge is **healthy but slow**. Health reports `ok` with zero failing
checks, and every brain is back after the billing outage. But timed live today:

| Question | Time |
|---|---|
| Restaurant for dinner in Bangkok | 36.0s |
| Quiet rooftop bar | 28.3s |
| A tailor who works fast | 26.9s |
| Birthday dinner, vegetarian | 39.2s |
| A repeat of a question already asked | 2.2s |

Every answer came back correct and complete — three picks, real website links,
maps, phone, walking distance. Nothing is broken. But a **novel** question takes
**27 to 39 seconds**, and only a repeat is fast, because the second one is
served from cache.

This is not a symptom of the billing outage. The brains are healthy and none of
these were degraded. It is the normal warm path.

Your review notes tell the reviewer to ask Num something "which works
immediately." During those thirty seconds the interface shows a small "…".
A reviewer who taps send and watches a dot for half a minute may well conclude
the app has hung.

Three honest options:

1. **Change the notes to set expectations** — tell the reviewer the first answer
   takes up to a minute while it searches the directory. Cheapest, honest, and
   removes the "it hung" reading.
2. **Make the wait legible in the app** — replace the "…" with visible progress
   ("finding places near you…"). Better for every real user too, not just the
   reviewer, and it is the fix I would push for.
3. **Submit as-is** and accept the risk. Apple did not raise speed, and the
   answers are correct when they arrive.

I would do 1 now and 2 soon. What I would not do is pre-warm the cache with the
exact questions in the review notes: it would show the reviewer a two-second app
that no real first-time user experiences, and that is the kind of thing that
reads as misrepresentation if anyone looks closely.
