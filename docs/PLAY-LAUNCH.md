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

---

# Listing pack — paste-ready

## The thing that differs from iOS, and it is not small

**On Android, NUM sells.** `canOfferSubscription()` returns false only on iOS, so
the membership ladder and the Star packs are live on Android. The Play listing
must therefore declare **in-app purchases**, and the Data safety and content
sections have to match that. Copying the iOS posture ("nothing is sold") onto
Play would be a false declaration.

## App name (30 char limit)

```
Num — Travel Concierge
```

## Short description (80 char limit)

```
Text it. It's booked. Tables, cars, stays and plans, in one conversation.
```

## Full description (4000 char limit)

```
Num is a travel concierge in your pocket. You message it like a friend who lives there, and it books real local places — tables, guest lists, drivers, stays — in your language.

NO FORMS. NO TABS. ONE CONVERSATION.
Tell Num what you want the way you'd text a friend: "dinner for two in West Hollywood tonight", "a car to the airport at 6", "somewhere quiet to work with good coffee". It answers with real places — open now, with the distance, the phone number and the link — and it arranges the booking.

IT KNOWS WHERE YOU ARE
Num draws on a directory of over 2.5 million venues, deepest in Thailand and the UK, and it checks what is actually open before it recommends anything. Ask it what's on tonight and it reads live listings, not a stale guide.

FREE TO START
Browse everything without an account. Your first answer is free — no sign-up, no phone number, no payment. After that, Num needs a way to reach you, because a table it cannot confirm is not a booking.

WHAT PEOPLE USE IT FOR
· Restaurant tables and bar guest lists
· Airport transfers, drivers and rides
· Hotels, villas and last-minute stays
· Flights, with fares for your actual dates
· What's on tonight, near you
· Shared plans — a trip, day by day, with who's paying what
· Errands, pickups, pets, kids, wellness, getting around

SHARED PLANS
Build a trip with the people on it. A tab per plan, a chip per day, the day hour by hour. Drag a thing to another hour. Put a cost on it, say who paid, split it, and settle up.

MEMBERSHIP
Num is free to use. Plus and Pro lift the ceilings on deep research and the number of plans you can run. Stars are a loyalty balance earned from visits, referrals and rewards, and spent on partner experiences.

A NOTE ON AI
Num uses AI to understand what you're asking and to search its directory. AI replies can contain mistakes — please confirm opening hours and prices with the business before you rely on them. Details of how this works, and which providers process data under contract, are at itsnum.com/privacy.

Free for travellers. itsnum.com
```

**Before pasting, settle the coverage number.** Marketing says 38 countries, the
code says 39 countries / 106 destinations. The draft above dodges it by not
giving a count. Pick one and make both match, because a store listing is the
worst place for the two to disagree.

## Category and contact

- Category: **Travel & Local**
- Contains ads: **No**
- In-app purchases: **Yes** (see above)
- Privacy policy: `https://itsnum.com/privacy`
- Website: `https://itsnum.com`

## Data safety — what to declare

Answer from what the app actually does, not from this list — but this is what it
does as of 0.8.388:

| Collected | Why | Notes |
|---|---|---|
| Name | Account, what friends see | Required to send |
| Phone number | Account identity, booking callbacks | The account IS the phone number |
| Email address | Alternative to phone for reachability | Optional |
| Approximate location | Recommendations near you | Optional; the app works without it |
| Precise location | The camera on a place card unlocks within ~200 m | Optional |
| Photos | Member photos of places; profile picture | Reviewed before shown to anyone |
| In-app messages | The concierge thread is the product | Processed by AI providers under contract |
| Purchase history | Membership and Star packs | Android only |

Also true, and Play asks all three: data is **encrypted in transit**; users
**can request deletion** (in-app, Profile → ACCOUNT & DATA → Delete my account);
data **is shared** with AI infrastructure providers acting under contract.

## Content rating questionnaire

Answer honestly; the ones that need thought:

- **User-generated content: yes.** Member photos and messages between members.
  Play will then want your moderation answer: photos are reviewed before they
  are shown, and there is in-app reporting and blocking (Messages → shield icon).
- **Prize draw: yes.** The weekly giveaway is free entry, no purchase necessary,
  official rules at itsnum.com/friday-rules.
- **AI-generated content: yes.**

The giveaway rules are **18+**, so a target age group of 18+ keeps the listing
consistent with them. The App Store rating was set at 13+; if you want 13+ on
Play too, the giveaway needs to be either gated or absent for under-18s.

## Assets

| Asset | Required | State |
|---|---|---|
| App icon 512×512 | yes | `android/play/icon_512.png` ✓ |
| Feature graphic 1024×500 | yes | **missing** |
| Phone screenshots (min 2) | yes | **1 of 2** — `android/play/screenshots/01-home-1030x2288.png` |

`node scripts/play-screenshots.mjs` captures the opening screen. It cannot yet
reach the TODAY / PLAN / MEMORY tabs — read that script's header before
retrying, two dead ends are recorded there. The fastest path to the rest is a
real phone: open app.itsnum.com, screenshot the tabs, drop the files in
`android/play/screenshots/`.
