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

Create `review@itsnum.com` demo user, verified against a test phone number, containing **before** submission:

- [ ] Concierge thread with real history, including **at least one message that arrived via SMS** (shows the unified thread)
- [ ] One upcoming booking (with Wallet pass) and one past booking
- [ ] 2–3 saved places in Places
- [ ] A visit with an uploaded receipt and stars already awarded (ledger shows the entry)
- [ ] A far-future booking visible in the calendar (shows advance reservations)
- [ ] A shared-plan link that resolves in a browser
- [ ] Credentials tested from a clean device the day of submission

## C. App Review notes — template (Apple 2.3.1(a): generic notes get rejected)

> NUM is an AI travel concierge. Users text in one thread — by SMS to our number or inside this app; both are the same conversation, joined server-side on the user's verified phone number. **The app requests no SMS permissions.**
>
> Bookings are for physical, real-world services (restaurants, tours, transfers) consumed outside the app; per guideline 3.1.3(e) payment uses our external processor via pay.itsnum.com links. There is no IAP content.
>
> Demo account: review@itsnum.com / [password in App Store Connect]. It is pre-populated — see the thread (note the "via text" message), Today (upcoming booking + calendar with an August reservation), Places (saved + been, map), and the profile (star ledger, account deletion under You → Delete my account, report/block via the shield icon in chat).
>
> AI disclosure: the consent screen at first run names our model provider and what is shared; Settings → Privacy & your data shows it at any time.
>
> Stars are a closed-loop loyalty program: earned from receipts/visits/reviews, redeemed for partner experiences. They cannot be purchased and cannot be converted to money.

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
