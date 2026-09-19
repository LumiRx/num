# App Review Information — paste-ready · 1.0 (12)

**Supersedes the build-9 revision of this file, and `APP-REVIEW-INFORMATION-1.0.5.md`.**

Every claim below was checked against production on 18 Sep 2026 by running it,
not by remembering it. Two statements in the previous revision had gone false:

- *"the concierge answers fully with no account, no phone number and no payment"* —
  the send gate (18 Sep) ended that. One answer is free; after that a member
  must be reachable. Telling a reviewer otherwise hands them a broken app.
- The notes live in App Store Connect still described a start-up sheet removed
  in 0.8.323. The reviewer of build 1.0(8) waited for it, found no other way in,
  and rejected on 2.1 — "Where is the sign-in page?"

**Rule going forward: these notes are part of the build.** If the first-run
experience changes, this file changes in the same commit. A reviewer following
stale instructions is a rejection with our name on it, not theirs.

---

## Field: Sign-In Required — YES

- **User Name:** the demo phone number, full international form
- **Password:** the review access code

Both must match the Worker secrets on num-app exactly, and
`REVIEW_ACCESS_UNTIL` must still be in the future — it is a wall-clock deadline,
and an expired grant is indistinguishable, from the reviewer's side, from an app
that does not work.

**Verified against production 18 Sep 2026:** `/api/social/me` answers
`channel: "review"`, `/api/social/verify` returns the member with
`review_access: true`, the send gate passes that member, and `/api/num`
answered in 3.2 s.

---

## Field: Notes

```
NUM is an AI travel concierge. You message it in one thread and it recommends and arranges real, physical things — a table, a car, a tour — from a directory of over 2.5 million venues, all consumed in the real world, outside the app.

WHAT CHANGED SINCE THE LAST SUBMISSION
Your review of build 1.0(8) asked where the sign-in page was. The cause was ours: the app opens on the conversation thread, and that panel rendered on top of the app header, where every route to an account lived. There is now a labelled "Sign in" button, 44pt tall, in the top-right of BOTH the header and the thread panel, so it is on whichever surface is in front. We hit-tested it on an iPad Air in both orientations: the page reports the button itself as the topmost element. Please disregard the previous notes — they described a start-up sheet this build does not have.

USING IT WITHOUT AN ACCOUNT
Every screen browses free: shelves, feature pages, events, place cards. The first answer from the concierge is free to anyone too — no account, no phone number, no payment. After that, sending requires a verified phone number, a verified email address, or Sign in with Apple, because the concierge books real venues on a member's behalf and must be able to reach them when a booking moves.

SIGNING IN FOR REVIEW
Use the demo phone number and code in the fields above.
1. Tap "Sign in", top-right of the opening screen.
2. Enter the phone number from the User Name field.
3. The app will say a code has been sent. It is NOT sent by SMS. Enter the code from the Password field above.
That code is issued for this one account, it expires, and it works with no cellular service. It exists because our A2P 10DLC registration is still pending, so we cannot text a code to a review device. Tested against production today; it signs in immediately.

SIGN IN WITH APPLE — 4.8
Offered on the same account sheet and on Profile, implemented natively via ASAuthorizationAppleIDProvider and verified server-side against Apple's published keys. No third-party sign-in is offered on iOS.

ACCOUNT DELETION — 5.1.1(v)
Sign in first; deletion is an account feature and does not exist for a guest. Tap your profile picture (top-right) to open Profile, scroll to the bottom to "ACCOUNT & DATA", tap "Delete my account", type DELETE and confirm. The account is permanently deleted, not deactivated: no reactivation window, no support step.

REPORTING AND BLOCKING
Open Messages, tap a conversation and use the shield icon in the header, or the menu beside anyone on the People shelf. Reporting asks a reason, takes an optional note, and offers to block in the same step.

MEMBER PHOTOS
A camera appears on a place card only when the device is within about 200 m of that place. Every photo is reviewed before it is shown to anyone else. An approved photo earns Stars; nothing is charged.

GIVEAWAY — 5.6
Profile carries a weekly prize draw. Entry is free with no purchase necessary, the official rules are linked from the card at itsnum.com/friday-rules, and the card states it is not affiliated with or sponsored by any trademark holder.

NOTHING IS SOLD IN THE iOS APP
There is no in-app purchase and no link out to buy anything. Membership tiers, Star packs and pay-with-Stars are hidden on iOS in code rather than by policy (canOfferSubscription() returns false on iOS), and two test suites fail the build if any purchase surface stops being gated. Stars are a loyalty balance earned from visits, referrals and rewards; they cannot be bought from this app on any platform.

AI DISCLOSURE
itsnum.com/privacy states that AI processing runs on named infrastructure providers under contract, and warns that AI replies can contain mistakes and that hours and prices should be confirmed with the business.

TIMING
A first answer normally returns in two to four seconds; one needing a fresh directory search can take longer, and an indicator shows it is working. A new device starts with an empty thread by design — nothing is pre-scripted.
```

---

## What was cut from the old notes, and why

Each of these was in the notes Apple held for build 8. None was true.

| Removed | Why |
|---|---|
| "About a second after the app opens, a sheet appears asking for a name." | False since 0.8.323. The reviewer waited for it. This one sentence cost three weeks. |
| "payment uses our external processor via pay.itsnum.com links" (3.1.3(e)) | `pay.itsnum.com` appears nowhere in the codebase. Volunteering an external-purchase claim for a door that does not exist invites scrutiny of a door that does not exist. |
| "a directory of 1.8 million verified venues" | 1.8 million is the count of business phone numbers (`worker/bizneighbours.mjs`). The directory holds 2,686,795 listings. |
| "the first answer takes 20 to 40 seconds" | Measured at 3.2 s on 18 Sep. Warning a reviewer about a 40-second hang that no longer happens invents a defect. |
| "Account deletion is in Settings > Account > Delete Account" | That path does not exist. It is Profile → ACCOUNT & DATA → Delete my account. |
| "A screen recording of the full flow is attached to this submission." | Not true of this submission. |

## Before every submission — run this

```
npm run review:ipad -- https://<the preview or production url>
```

It drives an iPad Air viewport in both orientations and **hit-tests** each
control: it asks the page what is actually underneath the button rather than
trusting that the button rendered. That distinction is the entire reason build
1.0(8) was rejected — the sign-in route was present, in the viewport, correctly
sized, and underneath something else. It exits non-zero if a reviewer could not
sign in, so it can gate a submission.

Two things it cannot check, because a browser has neither the Capacitor plugin
nor a real Apple ID. **Do these by hand in the native build every time:**

- Sign in with Apple appears on the account sheet and completes (4.8).
- Profile → bottom → Delete my account completes (5.1.1(v)).

## The pattern worth remembering

Three rejections, all reviewed on an iPad Air, all traced to one thing.

| Build | Finding | What it actually was |
|---|---|---|
| 1.0(2) | Sign in with Apple and account deletion missing | Both on Profile; Profile reached from the covered header |
| 1.0(5) | notes said "tap the profile picture at the top" | The reviewer could not, for the same reason |
| 1.0(8) | "Where is the sign-in page?" | The header was behind the thread panel on launch |

It was diagnosed as a crash the first time, a documentation gap the second, and
a missing page the third. `src/lib/appreview.test.mjs` now pins the repairs, and
every finding in that file is a real rejection, not a hypothetical.
