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

> NUM is an AI travel concierge. Users text in one thread — by SMS to our number or inside this app; both are the same conversation, joined server-side on the user's verified phone number. **The app requests no SMS permissions.**
>
> Bookings are for physical, real-world services (restaurants, tours, transfers) consumed outside the app; per guideline 3.1.3(e) payment uses our external processor via pay.itsnum.com links. There is no IAP content.
>
> **Signing in.** Num has no email or password — an account is a phone number. On first launch Num asks for a name and a number. Enter the demo name and the **demo phone number** in the App Store Connect fields above; Num answers "we've texted you a code". Instead of an SMS, enter the **sign-in code** given in the password field — it is issued for this one demo account, it expires, and it works with no cellular service. If the app shows the sign-up card again, close and reopen it; the number and code can be entered as many times as you need.
>
> Once in, see: People and Plans (shared trip), the star ledger, and account deletion under You → Delete my account. To report or block another member, open Messages, tap a conversation, and use the shield icon in the header — or open the ··· menu beside anyone on the People shelf. Reporting asks for a reason, takes an optional note, and offers to block in the same step. **The concierge is the product — type any request ("dinner for two in Phuket tonight", "a car to the airport at 6") and Num answers live.** A brand-new device starts with an empty thread by design; nothing is pre-scripted.
>
> AI disclosure: itsnum.com/privacy states that AI processing happens on infrastructure providers acting under contract, names Cloudflare among them, and warns that AI replies can contain mistakes and that opening hours and prices should be confirmed with the business.
>
> Stars are a loyalty balance. **They cannot be purchased in the iOS app** — the top-up panel is gated off iOS entirely. Stars are earned from visits, receipts, referrals and rewards and are spent on partner experiences. Stars that were *purchased* on any platform can never be paid out. Only platform-funded credits (bounty, referral, reward) can be paid out to a 5arz wallet, which is a payout of money already owed for work, not a purchase or a conversion of bought credit.

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
| Published contact information | `info@5arz.com`, itsnum.com/privacy §11 |

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
