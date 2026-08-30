# Num 1.0(2) — App Review resubmission pack

**Decision, 2026-08-21 (Andre):** replace the stalled 1.0(1) submission rather than
patch around it. 1.0(1) crashes on the signup screen with
`undefined is not an object (evaluating 'r.me.name')` — a reviewer never reaches
sign-in, so it is an automatic 2.1 rejection whatever the notes say. The 11 days of
queue position were already lost; they were only ever going to buy a rejection.

Everything below is done except the four steps marked **YOU**.

---

## 1 · The demo account — SEEDED AND VERIFIED

Num has no email and no password. An account is a phone number, proved by an SMS
code — and A2P 10DLC is unregistered, so **every OTP fails**. The reviewer therefore
gets in through the App Review access grant in `worker/social.mjs`: a phone number
plus a code that bypasses SMS entirely, scoped to one account, expiring by wall clock.

Seeded into `num-db` on 2026-08-21 and verified by query against every line of
`docs/store-submission-checklist.md` §B:

| §B line | Result |
|---|---|
| Member row exists, holds the number, **only one row holds it** | 1 row |
| `phone_verified` | 1 |
| At least one message that arrived via SMS (`num_inbox` kind='sms') | 3 |
| One past booking | 1 (Suay Restaurant, 19 Aug, confirmed) |
| One upcoming booking | 2 (Baba Beach Club 24 Aug; Blue Elephant 19 Dec) |
| Far-future booking visible in the calendar | 1 (19 Dec 2026) |
| Stars awarded from a visit/receipt, with the ledger move | 3 moves, balance 220 |
| A shared plan with a `join_code` | `NUMREV24` — "Phuket, four days" |
| At least one live connection so People is not empty | Mia Tanaka, accepted, + 2 DMs |

The number is `+1 310 555 0142`. **555-01XX is the range reserved for fiction**, so it
can never be assigned to a real person and can never collide with a real member. It is
never dialled — the grant bypasses SMS — so it does not need to receive anything.

> **What a sign-in still does NOT bring with it.** The concierge transcript, the Today
> canvas, saved Places and visit history live in `localStorage` (`src/lib/data.ts` →
> `saveState`). They are not server state and do not follow the account onto a clean
> device. No amount of seeding changes that. This is why the notes below tell the
> reviewer to *ask Num something* — which works instantly — rather than promising
> history that will not be there.

---

## 2 · YOU — set four secrets on `num-app`

`--config wrangler.app.jsonc` on every line. Without it they land on **num-console**,
which is a different Worker and will silently do nothing (this has happened before).

```bash
cd ~/num-worktrees/app-main
npx wrangler secret put REVIEW_DEMO_PHONE   --config wrangler.app.jsonc
npx wrangler secret put REVIEW_DEMO_MEMBER  --config wrangler.app.jsonc
npx wrangler secret put REVIEW_DEMO_CODE    --config wrangler.app.jsonc
npx wrangler secret put REVIEW_ACCESS_UNTIL --config wrangler.app.jsonc
```

Paste these values, one per prompt:

```
REVIEW_DEMO_PHONE     +13105550142
REVIEW_DEMO_MEMBER    mem_review00000000001
REVIEW_DEMO_CODE      NUM-REVIEW-679PTX-GQXEUF-4RYRM9
REVIEW_ACCESS_UNTIL   2026-11-19T00:00:00Z
```

All four or nothing — `reviewerGrant()` returns null on two of three, and a
half-configured door stays shut. `REVIEW_DEMO_MEMBER` is optional in the code but set
it anyway: it pins the grant to this one member id, so matching the number alone is
not enough.

**Revoke the day the app is approved:**
`npx wrangler secret delete REVIEW_DEMO_CODE --config wrangler.app.jsonc`
It also expires on its own on **19 Nov 2026** — 90 days, comfortably past any review
cycle, and no one has to remember.

---

## 3 · YOU — App Store Connect

**Withdraw the 1.0(1) submission first.** App Store Connect → the 1.0 version page →
*Remove this version from review*. Submission ID `25c1803a-85ef-45de-a497-7de8c22e0539`,
submitted 9 Aug 2026 15:53.

Then App Review Information:

| Field | Value |
|---|---|
| Sign-in required | **Yes** |
| User name | `+13105550142` |
| Password | `NUM-REVIEW-679PTX-GQXEUF-4RYRM9` |
| Contact | your name, `+1 310 738 6298`, `andre@thatislumi.com` |

The old notes gave a reviewer an **email address**, which the app has nowhere to
accept — that alone would have failed the review. Replace the notes with the block in
`docs/store-submission-checklist.md` §C verbatim. The paragraph that matters:

> **Signing in.** Num has no email or password — an account is a phone number. On
> first launch Num asks for a name and a number. Enter the demo name and the demo
> phone number from the fields above; Num answers "we've texted you a code". Instead
> of an SMS, enter the sign-in code given in the Password field — it is issued for
> this one demo account, it expires, and it works with no cellular service.

---

## 4 · YOU — archive and upload 1.0(2)

Xcode → **Product ▸ Archive ▸ Distribute App ▸ App Store Connect**. The build number
is already at 2 in both configurations, and `ios/App/App/public/` already carries the
fixed bundle (verified: zero occurrences of `.me.name`, safe-area insets present,
`contentInset: "never"` in `capacitor.config.json`).

**Order matters if the Worker is ever deployed separately: client first, then Worker.**
A Worker that returns the new three-outcome shape to an old client is the crash we
just fixed, in the other direction.

---

## 5 · Test before submitting — from a clean device

Not optional, and not from your phone with its existing state:

1. Delete Num from the device.
2. Install 1.0(2) from TestFlight.
3. Type `Apple Review` and `+13105550142`.
4. Expect: *"That number already has an account here. Enter the sign-in code and I
   will bring it back."* — the `channel: 'review'` wording, not the SMS wording. If
   you see the SMS wording, the secrets did not land on `num-app`.
5. Enter `NUM-REVIEW-679PTX-GQXEUF-4RYRM9`. You are in, with the plan, the people,
   the bookings and 220 Stars.
6. Ask Num something — "dinner for two in Phuket tonight". That is the product, and
   it is the thing a reviewer on a clean device can actually see working.

Every touch of the grant — offered, wrong, capped, granted — writes a row to
`num_identity_signals`, so "did anyone use this, and when" stays a query rather than a
guess.
