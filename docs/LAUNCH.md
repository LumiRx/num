# NUM — Launch Runbook

**Who this is for:** whoever sits at the launch machine (Andres/Andrew's computer). This doc takes you from a clean machine to store submissions. Nothing here requires asking Viv or Claude for context — if it does, that's a bug in this doc; fix it in a PR.

**The split:** Viv's machine + Claude prepare everything (code, prototype, docs, backend). The launch machine builds, signs, and submits. This repo is the only thing that travels between them.

---

## 1. What exists today vs what's pending

**Exists (don't rebuild):**
- Interactive v0.4 prototype — `public/app-preview/index.html`, live at itsnum.com/app-preview. This is the approved UX spec: canvas + orb, calendar, shared plans, slide-to-pay, map. Match it.
- Design + store strategy — `docs/num-app-design-and-store-compliance.md`. Read it in full once. The compliance table in §7 is the law of this project.
- Backend: Cloudflare Workers (`accounts/`, `ai/`), D1 directory (514k places, 67 destinations, ranked top-places), LINE concierge.
- itsnum.com site with /signin, /claim, /console.

**Pending (built here before launch day, tracked in #num):**
- Unified thread API (SMS ↔ app join on phone number) — first build
- Paylink rail (pay.itsnum.com hosted checkout + webhook)
- The Capacitor app shell built to the v0.4 spec (`app/` directory when it lands)
- v1 compliance layer (§7 of the design doc)

Do not submit anything to the stores until the pre-submission gates (§5 below) are all green.

## 2. Machine prerequisites

- macOS with **Xcode 16+** (iOS builds; also install Command Line Tools)
- **Android Studio** + SDK 36 (Play target API level 36 is mandatory from 31 Aug 2026)
- **Node 20+**, git, CocoaPods (`sudo gem install cocoapods`)
- Capacitor CLI comes via npm when `app/` exists — no global install needed
- GitHub access to `LumiRx/NUM` (ask Viv for collaborator invite)

## 3. Secrets model — read before touching anything

- **The repo contains no secrets and never will.** `.gitignore` blocks the key files; keep it that way.
- Server-side secrets (Resend, LINE, Places) live only as Wrangler secrets on the Workers and as local dotfiles on Viv's machine. **The launch machine never needs them.**
- The app binary embeds no secrets — paylinks, AI calls, and directory reads all happen server-side.
- Apple and Google **store logins are Viv's** and get entered by him at this machine (or via App Store Connect / Play Console user invites with the right roles — preferred: invite the launch operator with Developer role instead of sharing credentials).
- Signing: iOS certificates/profiles come from the Apple Developer account (already approved). Use Xcode's automatic signing with the team selected. Android: generate the upload keystore ON this machine, back it up somewhere safe that is not this repo, and never lose it.

## 4. Build path

1. `git clone git@github.com:LumiRx/NUM.git && cd NUM`
2. Until `app/` exists: the PWA is servable from `public/` today; the store shells are blocked on the app build. Check `#num` for current state.
3. When `app/` lands: `cd app && npm install && npx cap sync`, then `npx cap open ios` / `npx cap open android`.
4. Web assets build from the same codebase as the prototype — one codebase → PWA → Capacitor shells (design doc §3.1).

## 5. Pre-submission gates

Every line of `docs/store-submission-checklist.md` must be checked. Highlights that have killed other apps:
- Demo account pre-populated (Apple's #1 rejection cause) — spec in the checklist
- App Review notes written specifically (Apple 2.3.1(a) rejects generic notes)
- Third-party AI disclosure consent screen present, naming the provider
- In-app account deletion working
- Location-optional proof-of-visit verified (earn same stars with location denied)
- No IAP anywhere near bookings

## 6. Submission order

**Play first** (Thailand skews Android; review is more forgiving):
1. Play Console → create app → **internal testing track** first
2. Data safety form: names the AI model provider (per 15 Jul 2026 User Data policy)
3. Content rating questionnaire → Teen (13+) tier, honest answers on AI chat
4. Promote internal → closed → production when stable
5. Developer verification must be complete before **30 Sept 2026** (Thailand first wave)

**Apple second**, over-built for Guideline 4.2:
1. App Store Connect → new app record (bundle id from the Xcode project)
2. TestFlight internal first; exercise every compliance gate on a clean device
3. Fill review notes from the template in the checklist; attach demo account credentials
4. Age rating questionnaire → 13+ minimum
5. Submit. **Budget 3 review cycles / 4–6 weeks.** AI apps in 2026 report 14–45-day reviews. Do not book launch marketing against the first submission date.

## 7. Launch-day comms

- Post progress in `#num` (Slack). The status canvas is pinned there — update it or ask Claude to.
- Live-site smoke test after any deploy: itsnum.com, /signin/, /claim/, /app-preview/ all 200.

*Maintained by Claude in Viv's sessions. If you change process here, commit the change — this doc is the process.*
