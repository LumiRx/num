# NUM App — Design and App Store Compliance

**Status:** SHAPE APPROVED by Viv, 28 Jul 2026 — build is go. Apple Developer account already exists and is approved (check membership page for org-vs-individual and any existing D-U-N-S). Google account recovery pending, then Play Console.
**Date:** 28 July 2026
**Owner:** 5arz / NUM
**Code:** github.com/LumiRx/NUM (private) — this doc lives there as `docs/num-app-design-and-store-compliance.md`; prototype at `public/app-preview/` and live at itsnum.com/app-preview. Team channel: #num (Slack, lumirx).
**Decision requested:** approve the build shape in §3 and start the D-U-N-S application in §8 this week

---

## 1. Start here: the one tension in the whole concept

The vision is an app with no interface — a message bubble that talks straight to the concierge. That is the right product idea and it is also, precisely and specifically, the app profile Apple rejects.

Guideline 4.2 (Minimum Functionality) says an app should "include features, content, and UI that elevate it beyond a repackaged website." A single chat pane wrapped in a shell is the textbook case reviewers use for that rule. And it got harder seven weeks ago: on 9 June 2026 Apple revised 4.3(b) to read "Don't submit apps that are indistinguishable from what's already widely available." In mid-2026 a chat bubble is the most widely available thing in software. Apple's own 2025 Transparency Report has 2,093,244 rejections against 9,100,620 submissions — roughly 23% — with 415,532 of those in the Design category, which is where 4.2 lives.

**The resolution is not to abandon the vision. It is to notice that the vision already produces native surface, and to build that surface.**

When the concierge does its job it creates objects: a booking, a saved restaurant, a place you actually visited, a star balance, a receipt. Those objects are not "interface" in the sense the user is trying to avoid — nobody has to tap through a menu tree to get a table booked. But they are exactly what App Review is looking for, and they are also what a traveller genuinely wants at 9pm when they need the confirmation number and have no signal.

So the design rule for the whole app is:

> **Everything is done by typing. Nothing has to be found by tapping. But everything the concierge produces has a real native home that works offline, holds a Wallet pass, fires a push, and can be shown to a reviewer.**

The user never has to leave the bubble. The app is not only the bubble.

---

## 2. The finding that changes the build decision: booking commission is 0% on both stores

This is the single most valuable thing that came out of the rules research, and it inverts the usual advice.

**Apple 3.1.3(e)** — for physical services consumed outside the app, you *must use purchase methods other than in-app purchase*. Using IAP for a restaurant or hotel booking would itself be a violation. Apple's cut on NUM's booking commission is **zero**.

**Google Play Payments policy** exempts "physical services (such as transportation services, cleaning services, airfare, gym memberships, food delivery, tickets for live events)". Google's cut is **zero**.

The standard argument for going PWA-first — "ship on the web, dodge the 30%" — **does not apply to NUM**, because there is no 30% to dodge. Our revenue line is commission on physical services, which both stores explicitly exclude from their billing systems.

What a PWA would actually cost us is iOS push. On iOS a PWA gets no `beforeinstallprompt`, gets push only after the user manually adds it to the home screen through the Share sheet, and gets no background sync and no geofencing at all. Push reach for an installed native app runs roughly 10–15× a PWA's on iOS in practice. NUM's entire loop is proactive messaging — *your table is in 40 minutes, the boat leaves from the other pier today, you're two stars off a free dinner*. Trading that away to avoid a fee we were never charged is a bad trade.

The only place the 30% would bite is a **consumer subscription** (30%, or 15% under the Small Business Program). If NUM ever adds a paid consumer tier, that decision needs its own analysis. Business-side subscriptions sold to venues through the console are B2B on the web and never touch the stores.

### 2.1 How payment actually flows: paylinks in the thread

Decision (Viv, 28 July): **payment is a message, not a screen.** When a booking needs money — a deposit, a prepaid tour, an event ticket — the concierge drops a pay link into the thread. Same link whether the thread is SMS or the app.

This is not just convenient, it is the cleanest possible shape under the rules:

- **Fully compliant by construction.** Bookings are physical services, so external payment is not merely allowed — 3.1.3(e) *requires* it. A paylink that opens the processor's hosted checkout in the in-app browser is fine on both stores.
- **The app never touches card data.** Checkout happens on the processor's hosted page, so the app has no payment UI at all in v1 and our PCI scope for the payment flow itself stays minimal. (The receipt-photo PCI question in §11 is separate and still open.)
- **One rail for both channels.** The SMS-only user pays exactly the same way as the app user. In the app, the same link renders as a rich payment card in the thread and flips to "paid" when the processor webhook fires.
- **Thailand rails.** Hosted checkout should lead with PromptPay QR, cards second; processor candidates are Opn (Omise), 2C2P, and Stripe Thailand, with LINE Pay where the thread is LINE. Opening the processor account is a 5arz business-identity action.

One point Viv raised that deserves a plain answer: *"can we do bookings through our own rails and not through Apple for countries with strict bylaws?"* — **we do bookings through our own rails in every country, not just strict ones.** There is no country where a booking must route through Apple. 3.1.3(e) doesn't merely allow external payment for physical services, it mandates it — so 5arz rails (paylink → hosted checkout) are the one global payment path, same everywhere, nothing to carve out per jurisdiction.

Two cautions, one per store of trouble:

1. **Never use paylinks to route around IAP for digital goods or subscriptions.** That is the one place Apple still bites, and the US link-out relief from the Epic injunction is exactly what is under Supreme Court review. Bookings are exempt regardless, so stay on that side of the line.
2. **A text with a payment link is also the classic phishing shape.** Every paylink must live on one fixed branded domain — `pay.itsnum.com` — with a consistent message format, and never a URL shortener. Separately, SMS containing URLs runs into carrier filtering, and Thai sender-ID/A2P registration governs whether our links get delivered at all. That bumps the A2P item in §11 from "check early" to **check first**.

---

## 3. What we can ship, by channel

### iOS direct-from-website: not available to us. Full stop.

The user asked about downloading from the website. On iOS there is no route:

- **EU Web Distribution** requires EU incorporation, **two continuous years** of Apple Developer Program membership, **and** more than one million EU first-annual-installs in the prior calendar year. We fail all three, not one.
- **Japan and Brazil** have opened alternative *marketplaces*, not web distribution.
- **Enterprise, Ad Hoc and TestFlight** are not consumer channels — Enterprise is for your own employees, Ad Hoc caps at 100 devices, TestFlight builds expire.

iOS means the App Store. There is no side door.

### "dapp" — and a warning worth reading twice

Taking "dapp" at face value: **do not put the stars on-chain.** Apple 3.1.5(b) bars crypto apps from offering currency for completing tasks. Right now stars-for-uploads is explicitly *permitted* under 3.2.2(x) ("Apps may otherwise incentivize users to take specific actions within apps"). Tokenising the stars would convert a compliant loyalty scheme into a prohibited one and take the whole app down with it. There is no upside here that is worth that.

If "dapp" meant "downloadable app, direct from us" — that is the Android APK path below.

### Android

Direct APK from itsnum.com works today. It degrades hard from **30 September 2026**, when Google's developer verification requirement lands — and the first wave is **Brazil, Indonesia, Singapore and Thailand**. Thailand is our primary GTM market. From that date, installing an unverified developer's APK on a certified Android device in Thailand gets progressively harder.

**The nuance that keeps Viv's "downloadable from the browser" idea alive:** the 30 Sept rule requires a *verified developer*, not Play-exclusivity. Once 5arz is verified (Play Console account + D-U-N-S), our directly-downloaded APK keeps installing normally on Android — inside and outside Thailand. So the browser-download channel survives on Android as long as we register; it dies only if we don't. On iOS there is still no browser-install route for us (EU-only, three gates we fail) — the PWA is the only browser path there, and it's a degraded one. This is a reach question, not a fee question: bookings owe the stores 0% either way, so the App Store costs us nothing and buys us distribution and push.

### PWA

Useful, but as a **bridge, not the destination**. Ship it now so the web experience is good and so we have something to hand people before the stores approve us. On Android a PWA can even be wrapped as a Trusted Web Activity and listed on Play. On iOS it cannot be listed on the App Store at all.

### Recommendation

**Native iOS + native Android. PWA as the pre-launch bridge. Play first, App Store second.**

Play first because Thailand skews heavily Android and because Play review is materially more forgiving of a chat-led product. App Store second, and deliberately over-built for 4.2 — we get one good first impression and a rejection costs us a week per cycle.

### 3.1 How 5arz actually builds this — one codebase

5arz's proven stack is web: Cloudflare Workers, D1, and hand-built HTML/CSS/JS — the console (35 screens), the site, and the LINE bot all shipped that way, fast. There is no Swift or Kotlin team, and hiring one is not the plan. So "native iOS + native Android" is built the one way we can actually execute it:

**One web codebase → PWA today → Capacitor shells for both stores → small native extensions only where nothing else works.**

- The **app skeleton** (v0.1, `num-app-skeleton.html`, in the project) is the start of that codebase — the same file grows into the PWA (manifest + service worker) and then ships inside Capacitor shells to Play and the App Store.
- **Capacitor plugins cover most of the 4.2 list natively**: camera capture, push (APNs/FCM), Face ID/biometrics, haptics, share sheet, geolocation, calendar. The app is web-rendered but the capabilities are real native capabilities.
- **Wallet passes need no native code at all** — `.pkpass` files are generated server-side and added via a link.
- The genuinely native-only pieces — **WidgetKit widget and Live Activity** — are added later as a small Swift app-extension inside the same Capacitor Xcode project. v1.1, not v1.
- Maps: **Leaflet + CARTO light tiles** in-app, consistent with the console; native MapKit is an upgrade, not a prerequisite.

One honesty note: Apple rejects *thin wrappers*, not web-rendered apps — a large share of shipped App Store apps are Capacitor/Ionic-based. Reviewers judge behavior: tabs, offline, push, camera, polish. That is exactly what the four-tab surface is for, and it applies with equal force to a Capacitor build.

The skeleton's demo data (Baan Rim Pa tonight, paid Phi Phi tour, receipt → +15★, one message "via text") is deliberately the same content the **App Review demo account** must contain — the prototype doubles as that spec.

---

## 4. The app

### 4.0 v0.2 interaction language — "canvas + orb" (28 Jul, Viv's direction: sleek, fewer buttons)

After the v0.1 skeleton, Viv asked for the most advanced layout we can put in the stores: smooth, easy to understand, minimal buttons and design. v0.2 (`num-app-skeleton.html` → `num-app-v02.html`, in the project) answers with three rules that now govern the app:

1. **Buttons become context.** A collapsed card has *zero* buttons — the card is the button. The hero booking expands in place to reveal its three quiet actions; a paylink is a slide-to-pay gesture, not a Pay button; the composer's mic becomes the send arrow only when you type; the receipt prompt appears on Today at dinnertime instead of living in a menu.
2. **Tabs become a canvas.** Two destinations — **Today** (a time rail: next thing huge, the rest recede, the past folds away) and **Places** (map first, photo cards, one glyph each). The concierge is a **glowing orb** center-docked in a floating pill; tapping it pulls the chat up as a full-height glass sheet *over* your world, which is the "messager bubble" made literal. Profile is a sheet off the avatar (with the star ring around it) — no settings tab exists.
3. **Chrome becomes motion.** Spring curves on every sheet and press, a live countdown that ticks, a star balance that counts up, a breathing orb, a quiet badge dot instead of popups. Depth and spacing do the separating; there are almost no borders or dividers left.

The four surfaces of §4.1 all survive — Chat is the orb's sheet, Trips is Today, Saved is Places, You is the profile sheet. This layout also strengthens the 4.2/4.3(b) story: store screenshots show a living travel canvas, not a text box, and no competitor ships this shape. It rides Apple's own Liquid Glass design direction, so it reads current-generation on device.

**v0.3 "crisp" refinements (same day, `num-app-v03.html` — current):** one accent only — the NuM indigo→violet; cyan exists solely as water on the map; green/amber/rose are status text, never surfaces. Place cards dropped the per-card rainbow for a single ink gradient with a large translucent serif initial doing the identity work. Glass tightened: higher opacity, blur 22→14, hairline borders, two-layer close shadows — no fog. The Places map is now a real interactive stylized Phuket: island silhouette, roads, area labels, and tappable pins for the actual saved/been places (gradient = saved, ink = been) with a floating label card; the hero card carries a matching coastal zoom with the route to tonight's table. All emoji UI chrome replaced with a hand-drawn 28-icon stroke set (24px grid, 1.8px, round caps) — shield, mic, send, receipt, compass, pass, Face ID, and so on; the only serif letterform anywhere is the NuM mark. Buttons redesigned: gradient primaries carry an inset top highlight, ghost buttons are hairline-bordered white with indigo-tinted icons, the hero's actions form one segmented bar, and the dock marks the active destination with a gradient dot. Production note: the prototype map is self-contained SVG; the native build swaps it for MapKit / Google Maps with the same pin language.

**v0.4 — the long horizon and other people (28 Jul, Viv: "calendar for reservations days in advance" + "share plans with friends"; current file: `claude/num-app-prototype.html`):**

*Calendar.* The Today header's date is itself the button — tapping "Tue 28 Jul · Phuket" opens a month-calendar sheet: booking dots under days, gradient pill on the selected day, that day's itinerary listed beneath, month nav Jul ⇄ Aug. The demo carries a Full Moon Party on 14 Aug booked three weeks ahead (deposit paid), plus a held beach-club slot, so the far-future story is visible. The Today rail keeps only the near term plus one far-future entry; the calendar owns the rest. An empty day says "ask me and it'll appear here" — the calendar routes back to the concierge, never to a booking form. Build implications: an advance booking gets a **reminder ladder** (T-7 days "still good for the 14th?", T-1 day reminder, T-3h Live Activity) rather than one lonely confirmation email three weeks early; holds vs confirmations are distinct states (the Catch Beach Club hold shows "confirm by Fri").

*Shared plans.* A share icon sits in the Today header (and Share is the hero card's fourth action for single bookings). The share sheet previews the plan ("Viv's Phuket week · 28 Jul – 14 Aug · 5 bookings · live"), with two defaults that are the whole privacy story: **Live updates** on (their copy changes when plans change) and **Hide costs & stars** on (friends see where and when, never what you paid). The link works in any browser with no app and no account — consistent with the SMS-first philosophy, and our cheapest acquisition loop — and is revocable any time. Build implications: server-rendered plan page at a tokenized URL; **webcal/iCal feed subscription** so a shared plan sits live in the friend's own calendar; per-booking invite generates a calendar attachment; share tokens revocable per recipient later, per link at v1.

Four tabs. This is not a betrayal of "no interface" — it is the native surface that makes 4.2 survivable, and it is four things a traveller actually wants.

```
┌─────────────────────────────────────────────┐
│                                             │
│              (content area)                 │
│                                             │
├─────────────────────────────────────────────┤
│  💬 Chat  │ 🔖 Saved │ ✈️ Trips │ ⭐ You    │
└─────────────────────────────────────────────┘
```

**The app launches onto Trips, not Chat.** This matters more than it sounds. An app that opens directly into an empty chat pane reads to a reviewer as a wrapper. An app that opens onto today's itinerary — with what's nearby, what's booked, what's next — reads as a travel app that happens to have an excellent assistant. Same product, completely different first thirty seconds. If the user has nothing booked, Trips shows Nearby instead, never an empty state with a chat button.

Chat is one tap away and the bubble is persistent, so the person who only ever wants to type never notices the difference.

### 4.2 Chat — the bubble

This is the product. Everything else exists to serve it.

- Full-width message thread, no menus, no command palette, no suggestion chips cluttering the compose bar.
- One input. You type what you want. That is the whole interaction model.
- The concierge replies inline, and when a reply produces an object it renders as a **rich card in the thread** — a booking card, a place card, a receipt card — that is tappable through to its native home. This is the seam between "no interface" and "native surface", and it should be the most polished thing in the app.
- Voice input as a first-class alternative (native speech recognition, not a web fallback). Typing on a phone in a taxi is bad; NUM should be usable by talking.
- **Native camera capture** in the compose bar, not a web file picker. Receipt and proof-of-visit photos are a core loop and they must feel instant.
- Typing indicators, delivery states, and a thread that scrolls back through everything — including SMS (see §5).

### 4.3 Trips — bookings and events

Everything the concierge has booked, in one chronological view. Restaurants, hotels, tours, transfers, event tickets, spa, anything.

- Grouped by trip, then by day.
- Each booking is a native detail view: venue, time, party size, confirmation number, address with a **MapKit** map, one-tap call, one-tap directions, and the original confirmation.
- **Works fully offline.** Cached locally. The moment a traveller most needs their confirmation number is the moment they have no data.
- **EventKit** — add to the phone's calendar with one tap.
- **Wallet passes** for bookings that have them. A pass on the lock screen at the right time and place is worth more than any push we could send.
- **Widget and Live Activity** for the next booking. "Table at Baan Rim Pa, 19:30, 1.2km" on the lock screen is the single strongest signal to a reviewer that this is a real native app, and it is genuinely useful.

### 4.4 Saved — companies and places

The user asked for the app to "organize and save different companies". This is that.

- Saved venues, grouped and searchable. Save from a chat card, from a map, or by asking ("save that place").
- Each venue card: photos, hours, price band, distance, what NUM knows about it, and — importantly — **your** history with it. Visited three times. You left a review. You have a 10% partner discount here.
- Collections the user can name ("Phuket eats", "for when my parents visit").
- Sharable — a saved collection sent to a travel companion is our cheapest acquisition channel.

### 4.5 Visited — proof of visit

The user asked to "keep track of visited places" and to submit "pics of locations for proof of visiting". These are the same feature.

A visit is confirmed by any of: a completed booking, a receipt photo, a location photo, or a manual check-in. The visit log is a map plus a timeline — genuinely one of the nicer things in the app, and the thing people screenshot.

**One hard compliance constraint here.** Apple **5.1.2(i)** forbids *requiring* location permission in order to earn compensation. If stars are awarded for proof-of-visit, we cannot make location access a precondition. So:

- Location, if granted, is a **convenience** — it pre-fills the venue and speeds up verification.
- If location is denied, the user gets a **manual venue picker** and the identical star award. No degradation, no nag.
- Request location **when-in-use only**. **Do not request background location for v1** — it invites review scrutiny out of all proportion to its value to us, and we do not need it yet.

### 4.6 Reviews, receipts and rewards

- **Reviews** — written in-app, attached to the visit. Photos optional.
- **Receipts** — camera capture, uploaded, parsed server-side for venue/date/amount, awards stars. Keep a manual-correction path for when the parse is wrong, because it will be.
- **Stars** — the balance lives on the You tab with a clear ledger of how each star was earned and what it can be spent on.

Three rules that are not negotiable:

1. **Never reward an App Store or Play Store review.** This is an expulsion-level offence, not a rejection-level one. Reward reviews of *venues*, never of *us*.
2. **Use `PHPickerViewController` on iOS (5.1.1(iii)) and the Android Photo Picker, not `READ_MEDIA_IMAGES`.** Both give access to the chosen photo only, with no library permission prompt. Full library access for a receipt upload is both a review flag and an unnecessary privacy ask.
3. **Receipt photos contain card fragments.** Store them encrypted, redact PANs server-side on ingest, set a retention limit, and say so in the privacy policy. This has PCI implications that are not yet scoped — flagged in §11.

### 4.7 You — profile

Stars ledger, trip history, saved payment context, notification settings, language, and:

- **In-app account deletion** — mandatory under Apple 5.1.1(v). Must fully delete, not just deactivate, and must be reachable inside the app rather than by emailing support.
- **Report and block** — mandatory under 4.7.1 for any app with a chat surface, even one where the counterparty is our own AI.
- **Face ID / biometric lock** on the app, optional. Bookings and receipts are personal.

---

## 5. The unified thread — SMS and app in one place

The user's requirement: "it can connect to the text also so if they text us it still shows in the app also."

The instinct is that the app needs to read the phone's SMS. **It does not, and it could not anyway:**

- iOS `TelephonyMessagingKit` is gated to default carrier messaging apps and is an EU-only entitlement.
- Android `READ_SMS` is restricted to apps registered as the default SMS handler.

Neither is available to us and neither is necessary, because **NUM owns the SMS gateway**. Every message a user sends to our number already arrives on our servers. So the unified thread is not a device-side problem at all — it is a **server-side join on the phone number**:

```
User texts +66 xx xxx xxxx ──► NUM SMS gateway ──┐
                                                 ├──► one conversation, keyed on identity
User types in the app ───────► NUM app API ──────┘
                                                 │
                                                 └──► both clients render the same thread
```

The app is simply another client of the same thread API. Consequences worth stating plainly:

- **Zero SMS permissions requested.** Which is also a meaningful review and trust win — we are asking for nothing that looks invasive.
- **Phone verification at signup is the join key.** It is what links the SMS identity to the app identity, so it has to be in v1 and it has to be smooth.
- Messages need a channel marker (`sms` / `app`) so the UI can show *how* something arrived, and so the concierge can pick the right reply channel — reply by SMS if they texted, in-app if they typed, and never both.
- The person who never installs the app still works perfectly over SMS. The app is an upgrade, not a requirement. That is a strength of the model and should stay true.

---

## 6. The fifteen changes that clear Apple 4.2

In rough order of how much each one moves the needle with a reviewer:

1. Native tab bar — Chat, Saved, Trips, You. Not a single-pane wrapper.
2. Launch onto Trips or Nearby, never onto an empty chat.
3. Native camera capture in the composer.
4. APNs push notifications for booking reminders and concierge replies.
5. MapKit — venue maps, the visit map, nearby discovery.
6. Full offline mode for bookings, saved places and visit history.
7. Widget + Live Activity for the next booking.
8. Wallet passes for bookings that support them.
9. EventKit calendar integration.
10. Face ID / biometric app lock.
11. Native share sheet — share a booking, a collection, a place.
12. Haptics and native transitions throughout. Cheap; reads as native immediately.
13. Native voice input.
14. Handoff / universal links — an itsnum.com booking link opens in the app.
15. Dark mode, Dynamic Type, and full VoiceOver support.

None of these require the user to navigate anything. All of them are things the concierge's output naturally wants.

---

## 7. Compliance build list — must exist in v1

These are not polish. A build without them gets rejected.

| # | Requirement | Rule |
|---|---|---|
| 1 | In-app account deletion (full delete, not deactivate) | Apple 5.1.1(v) |
| 2 | Report + block in the chat surface | Apple 4.7.1 |
| 3 | Content filtering on concierge output | Apple 4.7.1 |
| 4 | Explicit consent screen disclosing data shared with **third-party AI**, naming the provider | Apple 5.1.2(i), Nov 2025 |
| 5 | Play Data safety form **naming the model provider** | Google User Data policy, 15 July 2026 |
| 6 | `PHPickerViewController` / Android Photo Picker | Apple 5.1.1(iii) |
| 7 | Manual venue-select fallback for proof-of-visit; identical star award without location | Apple 5.1.2(i) |
| 8 | Age rating ≥ 13+ with the completed questionnaire — an unfiltered AI chat cannot credibly rate 4+ | Apple age-rating overhaul |
| 9 | Age assurance for US states: Texas SB2420 (1 Jan 2026), Utah (6 May 2026), Louisiana (1 Jul 2026) | State law |
| 10 | Target API level 36 | Google, by 31 Aug 2026 |
| 11 | Specific, detailed App Review notes — "generic descriptions will be rejected" | Apple 2.3.1(a) |
| 12 | Working demo account, pre-populated | Apple 2.1 — see §10 |
| 13 | No IAP on bookings (would itself be a violation) | Apple 3.1.3(e) |
| 14 | Never reward store reviews | Apple 5.6 |
| 15 | No crypto/token layer on stars | Apple 3.1.5(b) |

Item 4 is the one most commonly missed by teams shipping AI apps in 2026. It is a rejection, and it is avoidable with one screen.

---

## 8. Sequencing and the critical path

**The gating item is a D-U-N-S number.** It is free, and it takes **up to 28 days**. Google's developer verification lands **30 September 2026** with Thailand in the first wave. Today is 28 July. That is comfortable *if we start now* and tight if we start in September.

**This week:**

1. Apply for the **D-U-N-S number** for 5arz. Free, up to 28 days, on the critical path for both stores.
2. Open the **Google Play Console** account — register as an **organisation**, not an individual. The organisation account skips the 12-testers-for-14-days gate that would otherwise add a fortnight before we can go live.
3. Open the **Apple Developer Program** account, $99/yr, organisation enrolment (needs the D-U-N-S).
4. Ship the **PWA** off the existing site so there is something to hand people while the stores process.

**Weeks 2–6:** build v1 against §4, §6 and §7. Thread API and phone-verification join first, since everything else depends on identity.

**Weeks 6–8:** Play submission. Expect it to go reasonably smoothly.

**Weeks 8–14:** App Store. Budget **three review cycles and four to six weeks**. Apple claims 90% of reviews complete in under 24 hours, but 2026 reports for AI apps specifically run **14–45 days**, and the June 4.3(b) revision is new enough that nobody has a reliable feel for it yet.

**Costs:** Apple $99/year, Google Play $25 one-time, D-U-N-S free. The money is not the constraint; the calendar is.

---

## 9. Do not tokenise the stars

Repeating this on its own because it is the one decision in this document that is irreversible if we get it wrong.

Stars-for-uploads is currently **explicitly permitted** by Apple 3.2.2(x). Putting stars on a blockchain brings 3.1.5(b) into play, which bars crypto apps from offering currency for completing tasks — turning a permitted loyalty programme into a prohibited one, and taking the app with it. There is no version of a token that earns us more than distribution on iOS is worth.

**The off-chain "exchange" design (Viv, 28 Jul — approved direction):** stars never touch a chain. They are rows in our own D1 ledger, and "exchange" means movement *inside* that ledger:

- **Earn** — receipts, proof-of-visit, reviews. Permitted, already designed.
- **Redeem** — stars → rewards at partner venues, with 5arz settling with the partner behind the scenes. This is classic closed-loop loyalty and is the safe heart of the system.
- **Gift between users** — technically trivial on a ledger; deferred, not v1. It adds fraud surface and starts edging toward "stored value" questions.
- **Convert to cash or crypto — never.** The moment stars are exchangeable for money in either direction, they stop being loyalty points and become a financial instrument: Apple's 3.1.5(b) problem returns without any blockchain, and money-transmission / e-money regulation arrives with it. The line that keeps stars legal everywhere is *one-way in, redeemed out as experiences* — never bought, never cashed.

Thailand-specific caution for the legal pass (§11): stored value spendable at *many third-party merchants* can trigger Bank of Thailand e-money licensing. Our structure avoids this precisely because users can't buy stars and partners are settled by us — keep both properties true as the program grows.

---

## 10. What will get us rejected first, and how we pre-empt it

**Most likely: 4.2 Minimum Functionality.** Addressed by §6. Beyond building the features, *say so* — the review notes should walk the reviewer through the native surface explicitly, because a reviewer who opens the app, sees a chat box and closes it will reject in ninety seconds.

**Second most likely, and the more embarrassing one: 2.1 App Completeness — no working demo account.** This is Apple's own single largest cause of rejection, appearing in over 40% of unresolved issues. Our app is worse than most here, because an empty NUM account looks like nothing at all.

So the demo account must be **pre-populated before we submit**:

- A thread with real concierge history, including at least one message that arrived by **SMS** so the reviewer can see the unified thread working.
- Two or three saved places.
- At least one confirmed upcoming booking and one past one.
- A visit history with a receipt already uploaded and stars already awarded.
- Credentials in App Store Connect that we have tested from a clean device.

**Third: the AI data-sharing consent screen** (§7, item 4). One screen. Build it.

---

## 11. What is not yet verified

Stated plainly so nobody builds on sand:

- **Apple 5.2** full text — the source page truncated during research.
- **Apple 5.3.1–5.3.4** — quoted second-hand from a developer forum rather than from Apple.
- **`TelephonyMessagingKit` EU-only scope** — believed correct and it does not change our design (we do not need it), but unconfirmed.
- **The June 2026 4.3(b) revision is roughly seven weeks old.** There is no body of practitioner experience yet. **This is the single largest unknown in the plan** and the main reason to budget three iOS review cycles rather than one.
- **Epic v. Apple** is at the Supreme Court with argument expected from October 2026. It could change the distribution landscape. It does not change anything we should do this quarter.

**Not researched at all, and each needs its own pass:**

- Thai **PDPA** obligations for a consumer app collecting location and photos.
- **A2P SMS registration in Thailand** — this could gate the SMS side of the product entirely, and with the paylink decision (§2.1) it now also gates *payment delivery*: unregistered senders' link-bearing SMS gets filtered by carriers. Check this **first**, before the app work.
- **PCI implications** of storing receipt photos containing card fragments.
- **LINE platform policy**, given LINE's role in the Thai channel mix.

---

## 12. What I need from you — updated 28 Jul evening

1. ~~Approve the shape~~ — **DONE.** Shape approved; build is go, starting with the thread API.
2. **Apple: account already exists and is approved.** Two things to check on the [membership page](https://developer.apple.com/account): (a) is it an *organisation* or *individual* account — individual publishes under a personal name and can be migrated later; (b) if organisation, a **D-U-N-S number already exists** — copy it, because Google verification wants the same number and we skip the 28-day wait entirely.
3. **Google: recover the login** (accounts.google.com/signin/recovery — this one's yours), then open **Play Console** ($25 one-time, organisation type, using the D-U-N-S from Apple if it exists). This is now the only item on the 30 Sept Thailand critical path.
4. **Payment processor account** (Opn / 2C2P / Stripe TH) when ready — gates live paylinks, not the build.
5. Destination priority: rankings now rebuilt across all destinations (17,495 top places, 67 destinations, 9 buckets) — launch-wave ordering is a GTM choice layered on top, not a data blocker.
