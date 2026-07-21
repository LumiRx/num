# NUM by 5arz — Demo Package (send-ready)

Everything you hand someone to understand NUM in under ten minutes. Three artifacts, three audiences, one story.

---

## What to send whom

| Recipient | Lead with | Then |
|---|---|---|
| **Duke (CTO)** | `docs/TECH_BRIEF.md` | live Railway app + `mobile_prototype.html` |
| **Phuket partner** | `mobile_prototype.html` on your phone + `DEMO_SCRIPT.md` | `NUM_by_5arz_Phuket_Launch.pptx` |
| **Investor** | `apps/site/index.html` (landing) + the deck | the live console prototype |

---

## The three artifacts

### 1 · The live mobile console — the "wow"
`apps/dashboard/mobile_prototype.html`
- Open it on an **actual phone** (AirDrop it or send via LINE — it's one self-contained file; on desktop it renders in a phone frame).
- All 7 roles behind the switcher, EN⇄TH one tap, real Phuket data, working buttons (accept a booking, assign a lead, approve a merchant).
- This is the "run your whole operation from a phone" demo. Let them press the buttons — the person who taps Accept believes the product.

### 2 · The landing page — the front door
`apps/site/index.html`
- The 5arz.com/num page: what NUM is, the full feature set, the 7-role console, 5arz Verify + PayRails, the pilot proof, the markets, the ask.
- Partner/investor framing, marketing-reviewed. Open in any browser.
- **To publish:** it's a single static file — drop it on Vercel/Netlify/Cloudflare Pages, or as `num/index.html` on the 5arz.com host. Zero build step.

### 3 · The partner deck — the meeting
`NUM_by_5arz_Phuket_Launch.pptx` (this folder)
- 12 slides, dark-branded, validated. Built system → full flow → whale engine → 5arz platform → pilot terms → economics → asks.
- Paired with `DEMO_SCRIPT.md` — the 15-minute phone walkthrough in meeting order.

---

## The live system (once the DB key is green)

- **API:** `https://web-production-d6ed4.up.railway.app` — `/healthz` is green now; `/healthz/db` goes green when the Supabase service-role key resolves to the right project.
- **When green:** the strongest possible demo is real — hand someone your phone, have them text the WhatsApp sandbox number in any language, watch NUM reply and recommend a seeded vendor in under three seconds. Nothing sells like a live reply.
- **Launch Command artifact** (in your Cowork sidebar) shows the live system pulse + deploy checklist + the 200-company onboarding tracker.

---

## The 60-second story (say it in this order)

1. **Thesis:** "Every traveler in our partner's cars gets a personal AI concierge in their own language — it books, it remembers, it finds the whales."
2. **Proof it's real:** built, 95 tests, deployed, PDPA-compliant. Not a deck — a running system.
3. **The circuit:** demand from the fleet → AI → approved local supply → bookings + whale leads → revenue, measured at every step.
4. **The management:** you run all of it from your phone, seven role-views, English and Thai.
5. **The ask:** distribution + accounts + the first 40 merchants; the tech is ready this week.

---

## Publish checklist for the landing page (when ready)

- [ ] Point `num.5arz.com` (or `5arz.com/num`) DNS at the host
- [ ] Drop `apps/site/index.html` as the index — no build needed
- [ ] Confirm the `mailto:` CTAs point at the right inbox (currently `andre@thatislumi.com`)
- [ ] Optional: add a real "Talk to NUM" WhatsApp link once the sender is approved
- [ ] Optional: swap the hero phone mock for a short screen-recording of the console

*Sources: apps/site/index.html · apps/dashboard/mobile_prototype.html · docs/TECH_BRIEF.md · DEMO_SCRIPT.md · NUM_by_5arz_Phuket_Launch.pptx*
