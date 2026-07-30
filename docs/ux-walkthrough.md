# NUM app — UX walkthrough & connection map

Walked screen by screen against the live deploy (num-app.thatislumi.workers.dev)
on a 375×812 phone viewport, first-run state through to a booked plan.

## What works well

| Screen | State |
|---|---|
| First run | Asks where you are + where you're headed before assuming anything. Discover bubbles teach capability without a tutorial. |
| Thread | Real venue photos in cards, status pill, chips that answer, Send button, keyboard-aware sizing. |
| Plan | Bookings grouped by city with the gradient underline, photo thumbnails, expand for notes/cost/receipt, pill actions. |
| Memory | Trip shelves with photo counts once photos are granted. |
| Calendar / Wallet / Share | Rounded glass sheets, grabber, X close, hardware-back closes them. |
| Lock screen | Live Activity tracks the thread (dark aurora). |

## Gaps found in the walkthrough (ranked)

1. **Empty-thread void.** After onboarding, the thread has one bubble and ~500px
   of nothing above the input. Fill with a soft "what Num can do" panel, or
   vertically centre the welcome until the first exchange.
2. **PLAN/MEMORY empty states are thin.** PLAN says "new plans come from the
   thread" — good copy, but no illustration or CTA back to the thread.
3. **Three stacked pill rows** (discover + chips + input) eat ~40% of a phone
   screen. Consider collapsing discover into a single "＋" that expands.
4. **No photo attribution shown.** Commons images are CC and require credit;
   `photoAttr`/`photoLicense` reach the client but nothing renders them. Needed
   before shipping Commons photos broadly (venue link-preview images are fine).
5. **No pull-to-refresh / reconnect affordance** if a reply fails; the offline
   message is the only signal.
6. **Voice is a scripted demo** — the mic plays the Viv massage script even in
   live mode. Either wire real speech-to-text or hide the mic outside demo.
7. **No settings/profile surface.** Memory (`profile`) is invisible to the user;
   they can't see or correct what Num remembers. GDPR-adjacent as well as UX.
8. **Business login has no entry point in the app** (worker exists, see below).

## Connection map — what's wired vs. what's missing

### Live now
- **App → brain**: `/api/num` on num-app → Claude Opus 5 (big lane) or Workers
  AI llama-3.3-70b (small lane), guarded output, memory, feature-request logging.
- **Brain → directory**: shared `num-db` D1 — 500k+ places incl. the new UAE +
  US metros, with photos and phone numbers.
- **Scout → brain**: `num-scout` sweeps city food press + Google News into
  `buzz`; grounding injects "WHAT'S NEW HERE" per city. Runs nightly, chained
  to num-ai's cron (account is at the free-plan limit of 5 cron triggers).
- **LINE → brain**: `num-ai` worker (webhook live).
- **Photos**: venue `og:image` + Wikimedia Commons → `places.photo_*` → cards
  and plan rows.

### Exists but not connected to the app
- `num-wa` — WhatsApp worker deployed; needs Meta Business verification + the
  brain wired to the same `/api/num` path (currently separate).
- `num-biz`, `num-auth`, `num-accounts` — business API + magic-link login
  deployed; the app has no "For business" entry point yet.
- `num-console` — partner console; no Feature Requests panel yet even though
  `feature_requests` has been collecting rows.

### Not built (needs a decision or a credential)
| Thing | Blocker |
|---|---|
| Real bookings (tables, cars, food) | Partner availability API — spec'd in `business-platform-spec.md`, needs step 1 (SMS claim) first |
| Real payments / Stars settlement | Payment processor + business payout rails |
| WhatsApp channel | Meta Business account, verified sender, template approval |
| Voice input | Speech-to-text provider (or Web Speech API for a free first pass) |
| Photo attribution UI | Small build; blocks broad Commons usage |
| Google Places ratings/photos | `GOOGLE_PLACES_API_KEY` (~$7/1k photo lookups) |
| Crypto prices | Free CoinGecko API — not yet wired |
| 5arz hiring hand-off | Deep link/API into the 5arz platform |

## Suggested next three

1. **Business claim via SMS** (step 1 of the business spec) — unlocks real
   bookings, the business button, and the dashboard, and the 26k contact sheet
   is its outreach list.
2. **Profile/settings surface** — show and edit what Num remembers, plus the
   business login entry point. Small build, closes gaps 7 and 8.
3. **Thread empty state + attribution** — closes the two most visible polish
   gaps (1 and 4).
