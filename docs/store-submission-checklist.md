# NUM — Store Submission Checklist

Nothing ships until every box here is checked on a real device build. This file is the gate; `docs/LAUNCH.md` is the process around it.

## A. Compliance gates (build must have all of these)

- [ ] In-app account deletion — full delete, reachable in-app (Apple 5.1.1(v))
- [ ] Report + block in the chat surface (Apple 4.7.1)
- [ ] Content filtering on concierge output (Apple 4.7.1)
- [ ] Consent screen disclosing data shared with third-party AI, **naming the provider** (Apple 5.1.2(i), Nov 2025)
- [ ] Play Data safety form names the model provider (Google User Data policy, 15 Jul 2026)
- [ ] Photos via `PHPickerViewController` / Android Photo Picker — no library permission (Apple 5.1.1(iii))
- [ ] Proof-of-visit works with location denied — manual venue picker, **identical star award** (Apple 5.1.2(i))
- [ ] Age rating 13+ with questionnaire completed honestly for AI chat
- [ ] Age-assurance handling for Texas (SB2420), Utah, Louisiana
- [ ] Android target API level 36 (deadline 31 Aug 2026)
- [ ] No IAP on bookings anywhere — external payment is *required* for physical services (Apple 3.1.3(e))
- [ ] No rewards of any kind for App Store / Play reviews (expulsion-level)
- [ ] No token/crypto layer on stars; no star purchase; no star→cash (Apple 3.1.5(b) + design doc §9)
- [ ] Offline mode verified in airplane mode: bookings, saved places, visit history all render
- [ ] Universal links: an itsnum.com booking link opens the app when installed

## B. Demo account (Apple's #1 rejection cause when missing)

> **CORRECTED 2026-08-19.** This section used to say "create `review@itsnum.com`,
> verified against a test phone number". That describes an app we do not have.
> **Num has no email and no password.** The only way in is a name and a phone
> number, and the number is proved by an SMS code — so `review@itsnum.com` is a
> mailbox, not a credential, and a reviewer typing it into App Store Connect's
> password box has nothing to type it into. Combined with A2P 10DLC being
> unregistered (every OTP fails), the demo account as specified here was
> **unreachable**. See `HQ/divisions/num/APP_REVIEW_RECOVERY.md`.

The demo account is a real member row, reached with a **phone number and the App
Review access code** (`worker/social.mjs` — `REVIEW_DEMO_*` Worker secrets, off
by default). Both go in App Store Connect → App Review Information.

Before submission, verify with `node scripts/verify-review-account.mjs --phone=+66…`:

- [ ] The member row exists, holds the number, and only one row holds it
- [ ] **At least one message that arrived via SMS** (`num_inbox` kind='sms') — the unified thread
- [ ] One upcoming booking and one past booking (`num_booking_requests`)
- [ ] A far-future booking visible in the calendar
- [ ] Stars awarded from a visit/receipt, with the move in the ledger (`num_star_moves`)
- [ ] A shared plan with a `join_code`
- [ ] At least one live connection so People is not empty
- [ ] The four `REVIEW_DEMO_*` secrets set on **num-app**, and the code and number pasted into App Store Connect
- [ ] Sign-in tested from a clean device the day of submission — install, type the number, enter the code

**What a sign-in does NOT bring with it.** The concierge transcript, the Today
canvas, saved Places and visit history are persisted in `localStorage` on the
device (`src/lib/data.ts` → `saveState`). They are not server state and they do
**not** follow the account onto a reviewer's clean device. Until the thread is
hydrated server-side, no amount of database seeding makes those screens look
populated for a reviewer — so the review notes must tell them to *ask Num
something*, which works immediately, rather than promising history that will
not be there.

## C. App Review notes — template (Apple 2.3.1(a): generic notes get rejected)

> **Rewritten 2026-08-30 for build 1.0(3), after the 1.0(2) rejection.** Every sentence
> below was exercised against the running app or the live site on that date. Paste verbatim.

> NUM is an AI travel concierge. Users text in one thread — by SMS to our number or inside this app; both are the same conversation, joined server-side on the user's verified phone number. **The app requests no SMS permissions.**
>
> **Signing in — two ways, and the first is one tap.**
> **Sign in with Apple** is on the first screen. It needs no code, no phone number and no network round trip to a carrier. Please use it: it is the fastest way in and it exercises the account system fully.
> Num otherwise has no email and no password — an account is a phone number. If you prefer that path, enter the demo name and **demo phone number** from the fields above; Num answers "we've texted you a code". Instead of an SMS, enter the **sign-in code** given in the password field — it is issued for this one demo account, expires by wall clock, and works with no cellular service.
> **You can also start a plain account with just a name and no number.** That is deliberate — a traveller should not be blocked at the door. It creates an EMPTY account, which is why the demo credentials above matter: they are the account with bookings, People, Plans and a Stars ledger already in it.
>
> **Account deletion** is at You → Delete my account, at the foot of the profile screen, in a red-outlined row. It permanently deletes the account and its data; it is not a deactivation. A screen recording of the full flow is attached to this submission.
>
> **Reporting and blocking.** Open Messages, tap a conversation, and use the shield icon in the header — or the ··· menu beside anyone on the People shelf. Reporting asks for a reason, takes an optional note, and offers to block in the same step.
>
> **The concierge is the product** — type any request ("dinner for two in Phuket tonight", "a car to the airport at 6") and Num answers live from a verified directory of 2.5 million places. A brand-new device starts with an empty thread by design; nothing is pre-scripted.
>
> Bookings are for physical, real-world services (restaurants, tours, transfers) consumed outside the app; per guideline 3.1.3(e) payment uses our external processor via pay.itsnum.com links. There is no IAP content.
>
> AI disclosure: itsnum.com/privacy states that AI processing happens on infrastructure providers acting under contract, names Cloudflare among them, and warns that AI replies can contain mistakes and that opening hours and prices should be confirmed with the business.
>
> Stars are a loyalty balance. **They cannot be purchased in the iOS app** — the top-up panel is gated off iOS entirely. Stars are earned from visits, receipts, referrals and rewards and are spent on partner experiences. Stars that were *purchased* on any platform can never be paid out. Only platform-funded credits (bounty, referral, reward) can be paid out to a 5arz wallet, which is a payout of money already owed for work, not a purchase or a conversion of bought credit.
>
> Published contact: **info@itsnum.com** (itsnum.com/privacy §11).

### C.-1 · What changed in 1.0(3), and the four findings it answers

| Apple's finding | What was wrong | Fix |
|---|---|---|
| **2.1(a)** crash on tapping the profile picture | `Info.plist` carried **no usage descriptions**. The avatar file picker offers "Take Photo", so iOS terminated the process (TCC `SIGABRT`) the instant the sheet appeared. | `NSCameraUsageDescription` + `NSPhotoLibraryUsageDescription` added. A test fails if any `type="file"` accepting image/video ships without one. |
| **4.8** Login Services | "Continue with Google" (5arz identity linking) with no equivalent option. | **Sign in with Apple**, native `ASAuthorization`, token verified server-side against Apple's public keys. Offered above every other option on the first-run screen. |
| **4.0** Design — browser sign-in | Google Identity Services opens the system browser from inside the WKWebView. | The Google card is dark on iOS. Nothing in an account flow leaves the app. |
| **5.1.1(v)** account deletion | It existed, but as 10.5px faint grey text below the screen the reviewer crashed on. | Legible, labelled, red-outlined row. Screen recording attached. |

Also fixed, unprompted: the app rendered as a **phone-shaped card on a black background on
iPad** — a browser-only launch-stage style leaking into the installed binary. It now fills
the device.

### C.-2 · The claim ledger — SEVEN so far, check before you send

Every one of these described an app we did not have, and each was found by testing rather
than reading:

1. Sign-in by **email address** — the app has no email field
2. `/whatsapp` as the A2P **opt-in URL** — a 1,570-byte redirect stub
3. **"report/block via the shield icon"** — neither existed (built 08-21)
4. **"the consent screen names our model provider"** — no such screen
5. **"Stars cannot be converted to money"** — cash out is not behind the iOS gate
6. **"info@5arz.com, itsnum.com/privacy §11"** — §11 publishes `info@itsnum.com`;
   `info@5arz.com` appears nowhere on that page *(found 2026-08-30, corrected above)*
7. *(reserved — there will be a seventh)*

**Exercise every claim on a real build before submitting.** The pattern is not carelessness;
it is that these notes get edited faster than the app does.


### C.0 · Two claims corrected 2026-08-21 — verify, never assume

Both of these were in §C and both were **false**. A reviewer checks claims like these.

| Claim as written | Reality |
|---|---|
| "the consent screen at first run names our model provider … Settings → Privacy & your data shows it at any time" | **Neither exists.** No provider is named anywhere in the client — the only mention in the repo is a code comment in `src/lib/concierge.ts`. There is no "Privacy & your data" screen. The privacy policy *does* disclose AI processing properly, so §C now points there instead. |
| "They cannot be purchased and cannot be converted to money" | Half true, stated as whole. Stars genuinely cannot be **purchased** on iOS — `canOfferSubscription()` gates the top-up panel. But **CASH OUT is not behind that gate** (`WalletSheet.tsx`), and earned platform-funded Stars *are* paid out through `worker/cashout.mjs`. A reviewer who opened the wallet would have read "EARNED — YOURS TO CASH OUT" directly under a sentence saying that cannot happen. |

Cashing out is not a purchase, so 3.1.1 is not engaged and the feature is fine as it stands.
The defect was the sentence, not the code — but a metadata claim a reviewer can disprove on
screen is a 2.3.1 problem and it costs the credibility of every other line here.

**Running total: five claims in this document have described an app we did not have** — the
email-address sign-in, the `/whatsapp` opt-in URL, the report/shield control, the AI consent
screen, and the Stars cash-out. Four are now corrected in text; the fifth (report) was built.
Exercise every claim on a real build before submitting.

### C.1 · Guideline 1.2 — user-generated content

Num carries UGC between members: direct messages, comments on shared plans, and the
name, bio and avatar a friend can see. Guideline 1.2 asks for four things, and as of
2026-08-21 all four exist:

| 1.2 requirement | Where it is |
|---|---|
| A way to **report** objectionable content | Shield icon in the Messages header; "Report" in the ··· menu on the People shelf. `POST /api/account/report`, `worker/account.mjs` |
| A way to **block** abusive users | Offered inside the same report step (ticked by default) and standalone via People → ··· → Remove and block. Enforced on every path that writes a friendship row — `worker/block.test.mjs` |
| Filtering of objectionable material | No public feed exists. All content is between mutually-connected members; the concierge itself is the only broadcast surface and it is ours |
| Published contact information | **`info@itsnum.com`** — itsnum.com/privacy §11. *(Corrected 2026-08-30: this row said `info@5arz.com`, which is the merchant-side address used in bizapi/bizconsole and appears nowhere on the privacy page. Verified by fetching the live page.)* |

> **Corrected 2026-08-21.** §C previously told App Review "report/block via the shield
> icon in chat". Blocking existed; **reporting and the shield icon did not**. A reviewer
> who reads the notes goes looking for the control — not finding it is a 1.2 rejection
> and a reason to doubt every other claim in the notes. Both now exist and are covered by
> `worker/report.test.mjs` (12 tests, mutation-verified).
>
> This is the third claim in these notes that described an app we did not have, after the
> email-address sign-in and the `/whatsapp` opt-in URL. Anything asserted here should be
> exercised on a real build before submission, not assumed.

## D. Store listing assets

- [ ] Screenshots (6.9" + 6.5" iOS; phone + 7" tablet Play): **lead with Today canvas** (living travel surface, not a chat box), then chat sheet with booking card, calendar month view, Places map with pins, share-plan sheet, star ledger
- [ ] App name: NUM — Travel Concierge (verify availability); subtitle ~"Text. It's handled."
- [ ] Keywords/description: concierge, travel planner, Thailand, Phuket, bookings, itinerary — no competitor names
- [ ] Privacy policy URL: itsnum.com/privacy (already live); ensure it names AI providers + receipt-photo retention
- [ ] Support URL: itsnum.com; contact only via info@ addresses
- [ ] App Privacy (Apple) answers consistent with the Play Data safety form — same facts, both stores

## E. Rollout

- [ ] Play: internal → closed (team + partner venues) → production
- [ ] Apple: TestFlight internal → submit; budget 3 cycles / 4–6 weeks; AI apps run 14–45 days in 2026
- [ ] Google developer verification complete before 30 Sept 2026 (Thailand wave 1) — also keeps direct-APK downloads working there
- [ ] Post submission status in #num same day
