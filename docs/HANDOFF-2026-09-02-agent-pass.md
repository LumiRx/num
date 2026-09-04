# Handoff — 2 Sep 2026, agent pass (Cowork session, git read-only)

Full write-up: project doc `claude/num-AGENT-BLUEPRINT-2026-09-02.md`.

## Changed, uncommitted, tests green (2,526 pass / 0 fail, eslint 0 errors, tsc clean)

| Area | Files | What |
|---|---|---|
| Sign-in | `claim/verify.mjs`, `worker/social.mjs`, `worker/phone.e164.test.mjs`, `src/lib/phone.ts`, `src/components/app/InviteSheet.tsx` | `normaliseMobile()` refuses a shape that cannot receive a text (the `+44 991…` / 60200 case, row 6 of `num_signin_events`). Error names the guessed country. Sheet shows the number it will text, live. 18 more home countries in `REGIONS`. `normalisePhone` untouched — the desk still calls landlines. |
| Instrumentation | `src/lib/track.ts`, `src/lib/concierge.ts`, `src/components/app/Verify5arz.tsx`, `*/num-track.js` (4 copies), `growth/worker.js` | `webEvent()` helper. `first_message_sent` now fires (never had a call site). `consent_prompt_shown` / `consent_prompt_engaged` — the wall metric's denominator. |
| Thread continuity | `worker/turns.mjs` (+test), `worker/index.mjs` | `num_member_turns`, self-migrating. Last 24 turns per member or `anon:<id>`, 1,200 chars, 30-day TTL. Loaded in the same `Promise.all` as facts. Client history always wins; server fills what a fresh device lacks. Cache hits stored as turns too. |
| Briefing | `worker/briefing.mjs` (+test), `worker/suggest.mjs`, `src/components/app/ThreadView.tsx` | `/api/suggest?me=&tz=` returns `briefing` — a plan today/tomorrow/this week. `Cache-Control: private, no-store` whenever `me` is present. |

## Not done, on purpose
- No secrets touched, no deploy run, no git write (CLAUDE.md rule).
- Money rails: all founder signups. See blueprint Part 3.
- `vite build` not verified from the sandbox (cannot empty `dist/`); tsc is clean.

## Found, not fixed
- **107 files were already uncommitted** before this session; deploys on 1–2 Sep shipped from that state. Commit them first, separately.
- `/api/version` reports `version: "unknown"` — `NUM_VERSION` unset on the live worker.
- `num_bookings` has no `member_id`; booking follow-ups cannot target anyone until it does.

## Round 2 — same session, "move next steps"

**2,538 pass / 0 fail**, eslint 0 errors, tsc clean.

| Step | Outcome |
|---|---|
| Twilio 10DLC status | Needs `ADMIN_KEY` (not held here). Run: `curl -s -H "X-Admin-Key: $ADMIN_KEY" https://app.itsnum.com/api/admin/twilio` — `account.services[].a2p_campaign` is the answer. |
| Place ingest "stopped" | **Not a fault.** `places.created_at` shows 137,833 `osm` rows on 31 Aug (the Taiwan island batch) and 22,863 on 30 Aug; `.ingest_state.json` ends at `chiayi` 30 Aug 22:03Z. Ingest is `scripts/ingest_places.mjs`, run by hand from the Mac. It finished. AGENTS.md keeps the automated Overture ingest paused. |
| WhatsApp front door | **Built.** `worker/whatsapp.mjs` (+12 tests). `POST /api/whatsapp/inbound`, Twilio-signed (`validSignature` now exported from sms.mjs), rides `handleNum` in-process → same brain/facts/thread. Verified member on that number → their account; otherwise subject `anon:wa:<phone>`. Acknowledges with empty TwiML, answers via Messages API in `waitUntil` (15s webhook budget). **503 until `WHATSAPP_ENABLED=true` and `TWILIO_WHATSAPP_FROM=whatsapp:+…`** (a WhatsApp-approved sender, or the sandbox number). Exempt from the blanket POST gate; per-sender bucket `wa:<phone>` on handleNum. `/api/version.connected.whatsapp` reports it. |
| Affiliates | `affiliates.example.json` (all placeholders, gitignored copy target) + `scripts/affiliate-dryrun.mjs` now understands `wrap` rules and flags unfilled placeholders instead of saying every wrap rule "does nothing". |

### Switching WhatsApp on (founder)
1. Twilio Console → Messaging → Senders → WhatsApp senders: approve `+14243460888` (Meta business verification) — or use the sandbox number to test today.
2. Set the inbound webhook for that sender to `https://app.itsnum.com/api/whatsapp/inbound` (POST).
3. `printf '%s' 'whatsapp:+14243460888' | npx wrangler secret put TWILIO_WHATSAPP_FROM --config wrangler.app.jsonc`
4. `printf '%s' 'true' | npx wrangler secret put WHATSAPP_ENABLED --config wrangler.app.jsonc`
5. Message the number from your own WhatsApp; `num_inbox` gets a `kind='whatsapp'` row and `num_member_turns` a `wa:` subject (or your member id, since your number is verified).

### Add to the commit
`worker/whatsapp.mjs worker/whatsapp.test.mjs worker/sms.mjs worker/index.mjs scripts/affiliate-dryrun.mjs affiliates.example.json .gitignore docs/HANDOFF-2026-09-02-agent-pass.md`

## Round 3 — clean, organised messages, and a link on every recommendation (3 Sep)

Dre: *"If we are giving a recommendation for a restaurant, it needs to be clear. We need to
have a link and the information needs to be organized properly... every time we give a
recommendation for a place, we need to give a link to the location."*

**2,617 pass / 0 fail**, eslint 0 errors, tsc clean.

### The root cause
`REPLY_SCHEMA.properties.reply` had told the model since August that *"Detail belongs in
`picks` and `card`"* — and **`picks` did not exist in the schema.** So every recommendation
fell back into one prose blob: three names, three reasons, phone numbers and addresses run
into a paragraph, and **no link to anything**, because the partner block never carried
`website` and there was no map link at all. The app renders replies as plain text
(`whiteSpace: 'pre-line'`), so even a typed URL would not have been tappable.

### What changed

| File | Change |
|---|---|
| `worker/placelink.mjs` (new, +16 tests) | One verified link per place. Venue website when we have one and `alive !== 0`; otherwise a Google Maps link **built from the row's coordinates** (never a name search — `?q=Blue Elephant` resolves to the wrong continent). `telLink`, `placeContact`, and `resolvePicks`. |
| `worker/prompt.mjs` | `picks` added to `REPLY_SCHEMA` (required). Model supplies **only** `{id, name, why}` — there is no url/link/phone field for it to fill, so a hallucinated link is structurally impossible. `reply` description and PERSONA rewritten: places go in picks, prose never repeats them, **the model never writes a web address.** Partner line now notes when a website exists. |
| `worker/index.mjs` | `resolvePicks` runs on the reply **before** grading, attaching link/phone/address/open-state from the row grounding actually read. Unmatched picks are dropped and logged. The retry path re-resolves too. |
| `worker/quality.mjs` (+10 tests) | The pre-send screening agent now enforces it. **Hard:** `recommendation-without-picks` (places named in prose with an empty picks array) and `model-written-url`. **Soft:** `picks-restated-in-prose`, `phone-in-prose`. Each hard flag carries a correction and earns the existing one retry. |
| `src/components/app/PickCards.tsx` (new) | Each pick as a card: name *is* the link, one-line reason, category/area/distance/rating, Open-now only when verified, and Directions / Call / Website as real tap targets. Address shown in full — it is what you read to a taxi driver. |
| `src/lib/types.ts`, `concierge.ts`, `ThreadView.tsx` | `Pick` type (`link` non-optional), picks carried onto the message and rendered. |
| `*/num-track.js` (4), `growth/worker.js` | `pick_link_click`, `pick_map_click`, `pick_call_click` — so we learn whether travellers want the website or the directions. |

### Two invariants deliberately preserved, not dropped
- **"Three options and a pick"** (Dre, 11 Aug) — `worker/brainseam.test.mjs` asserts it in
  *both* `brains.mjs` and `prompt.mjs`. Kept in both: the fallback brains are
  `structured: false` and cannot emit picks, so **prose brains keep the prose rule**;
  structured brains express the same rule through `picks`.
- **"Phone and address when Num cannot book it"** — now stronger than an instruction the
  model can forget: every pick carries them from the verified row, and a pick with no
  attachable link is dropped rather than shown as a bare name.

Two `worker/prompt.test.mjs` tests were **re-pointed, not relaxed** — same properties,
asserted against the structure that now carries them.

### Bugs my own tests caught while writing this
- `Number(null) === 0`, so `alive: null` (most of the directory — never checked) was being
  read as "site is dead", sending every guest to a map instead of the venue's website.
- A name-only maps fallback: a link to "Blue Elephant" with no address resolves to whichever
  one the map prefers, anywhere on earth. Now requires name **and** address, else no link.

### Add to the commit
`worker/placelink.mjs worker/placelink.test.mjs worker/prompt.mjs worker/prompt.test.mjs worker/quality.mjs worker/quality.test.mjs worker/index.mjs src/components/app/PickCards.tsx src/components/app/ThreadView.tsx src/lib/types.ts src/lib/concierge.ts`
(plus the `num-track.js` copies and `growth/worker.js`, already listed above.)

### What to check on the preview
Ask *"where should we eat tonight?"* in a city with directory coverage (Phuket, London,
Bangkok). Expect: one short framing line, then three cards, each with a tappable name,
Directions, and Call where there is a number. **No URLs in the prose, no phone numbers run
into sentences.** Then:

```sql
SELECT event, COUNT(*) FROM num_web_events
 WHERE event LIKE 'pick_%' GROUP BY event;
SELECT quality, COUNT(*) FROM num_asks
 WHERE ts >= datetime('now','-1 day') AND quality IS NOT NULL GROUP BY quality;
```
`recommendation-without-picks` appearing in `quality` is the grader doing its job; a rising
count means the model needs a firmer nudge, not that the check is wrong.

## Round 4 — the business site: features first, pricing last (3 Sep)

Dre: *"The website is very wordy. Shorten the text, stick to the keywords and selling
points... lay it out completely so businesses understand the benefit. Features first, then
pricing tiers at the bottom. Very informational, where they want to sign up. And in the
sign-up, show them the pricing."*

**3,820 pass / 0 fail**, eslint 0 errors, travel-speak clean, MCP integrity 6/6.

### `public/business/index.html` — rebuilt

| | Before | After |
|---|---|---|
| Prose | 683 words | **484** (−29%) |
| Longest paragraph | 95 words | **63** |
| Page height @1280 | 5,141px | **4,750px** |
| Feature cards | 0 | **9** |
| Pricing | scattered in 3 places | **one block, at the bottom** |

New order: hero → 3 keyword tiles → the real conversation → the turn → **What you get (9
cards)** → Live in four steps → Not a listings site (comparison table) → the auditable number
→ **How the pricing works** (success fee + 4 tiers) → FAQ → sign-up CTA.

### Fixed while rewriting
- **A false claim.** The page said the guest perk was *"free forever — on every plan."*
  `worker/bizbilling.mjs` has `free.entitlements.promotions = false`, and `/pricing/` said
  paid. The code and the pricing page were right; the business page was wrong. Removed.
- **A layout bug.** `<section class="wrap prose">` puts `max-width:72ch` on the element that
  also carries `.wrap`'s `margin:0 auto`, so every prose section floated centred at x≈515
  while the hero and cards sat at x≈145. Now `<section class="wrap"><div class="prose">`,
  so the page has one left edge. **Business page only** — 15 other pages (agent guides,
  beaches) use the centred reading column deliberately.
- **Dead vertical space.** A heading-only section was paying 64px padding twice. Merged.

### Two tests earned their keep
- `scripts/mcp-integrity.test.mjs` failed: the rewrite dropped the six `biz/mcp` tool names,
  and every live tool must be named on its public docs page. Its own comment says *"do not
  delete the tool from this list — write the sentence on the page."* Restored, inside a
  collapsed `<details>` so it documents without cluttering the sales flow. 6/6 named.
- `worker/gate.test.mjs` matched the apostrophe **encoding** (`&#039;`) in "somebody else's
  is", so it broke on a typographic `&rsquo;`. Widened to accept all spellings — it now
  asserts the sentence, which is what it meant. The other five pinned claims were kept
  verbatim and still pass.

### `public/claim/index.html` — pricing at sign-up
A compact "What it costs" block above the footer: Listing **Free** · Completed booking
**10%** · Optional dashboard **$9.99 · $19.99 · $50/mo**, linking to `/pricing/`. Deliberately
number-led — the figures need no translation, so only one short label per row does.
Added to all three language tables (EN/TH/ID).

⚠️ **The TH and ID labels are mine and unreviewed** — same open item as the rest of the
claim-page copy. Five short strings each (`priceTitle`, `priceList`, `priceFee`,
`priceDash`, `priceLink`); worth a native speaker's eye before a Thai campaign.

### Add to the commit
`public/business/index.html public/claim/index.html worker/gate.test.mjs`

### Deploy note
`public/` is served by **num-console**, which `release:ship` never touches:
```bash
npx wrangler deploy --config wrangler.jsonc
```
Without it, neither page changes in production.

## Round 5 — charts, shorter sentences, keyword titles (3 Sep)

Dre: *"Build more graphs to help display this information... shorten the large paragraphs,
full clear sentences but shorter... make this more sales forward and make sure the titles
have keywords businesses are looking for."*

**2,851 pass / 0 fail**, eslint 0 errors, MCP integrity 6/6, no horizontal overflow at 390px.

### Paragraphs

| | Before today | After round 4 | **Now** |
|---|---|---|---|
| Prose | 658 words | 484 | **501** |
| **Longest paragraph** | **95 words** | 63 | **27** |
| Top four | 95 / 71 / 62 / 56 | 63 / 27 / 26 / 25 | **27 / 26 / 25 / 25** |

Every paragraph on the page is now one or two complete sentences. Prose ticked up 17 words
because three figures gained captions — the paragraphs themselves more than halved.

### Three visuals (inline SVG/CSS — no library, no JS, no CDN)

1. **KPI row** replacing three prose tiles: `$0` setup · `$0` monthly · `$0` no-show · `10%`
   on completion. Headline numbers are stat tiles, not a one-bar chart.
2. **Unit comparison** — "A search page shows forty. NUM says three." A 10×4 grid of 40 grey
   marks against three named green rows. Captioned **Illustrative** so it is never read as a
   measured statistic.
3. **Meter** — "You keep 90% of every booking": a $100 booking with $90 filled and $10 in the
   track. One ratio against a limit is a meter, not a two-slice pie.

Plus the four-step flow as numbered cards instead of an `<ol>`.

### The palette was computed, not eyeballed
`scripts/validate_palette.js` on the brand greens returned **PASS contrast** (both ≥3:1 on
white) but **FAIL as an adjacent categorical pair** — `#0EA483` ↔ `#0B7C63`, normal-vision
ΔE 12.0, under the 15 floor. So nothing on the page asks a reader to tell those two greens
apart:
- the plan bars would have been a light→dark ramp; they are **one hue** instead — bar length
  already encodes magnitude, so colour-by-magnitude is redundant;
- the 90/10 split is **fill against a same-ramp track**, not two competing hues.

Every value is direct-labelled, so no hover tooltip is owed; the pricing table is the table
view; `role="img"` + `aria-label` on both figures. Site has no dark mode (0 uses of
`prefers-color-scheme`), so light-mode only is correct here.

### Two layout bugs caught by rendering it
- The meter was an SVG with a fixed `viewBox`; it **letterboxed and centred** inside the wider
  card instead of spanning it. Rebuilt in HTML/CSS — scales at any width, labels stay crisp.
- The 40 units wrapped 17/17/6 at `max-width:330px`, which reads as "some". Pinned to
  `width:175px` = exactly 10 per row, so it reads as **forty**.

### Keyword-led titles
`<title>` → *"NUM for Business — free listing, more bookings, 10% commission"*.
Description → *"Get more bookings from travellers. Free business listing for restaurants,
hotels and tours — no setup fee, no monthly fee…"*. H2s now: *What your free business listing
includes · How to get listed — four steps · Why NUM beats a directory listing · Booking
analytics you can actually audit · Pricing: free listing, 10% commission · Free API and MCP
for AI assistants · Business listing FAQ*.

All six `gate.test.mjs` claims still pass verbatim.

## Round 6 — real product graphics (3 Sep)

Dre: *"We need real graphics, screen shots are not good enough."*

Correct call. Rounds 4–5 gave the page *diagrams* — grey squares and a progress bar. What a
restaurant owner needs is to **see the product**. Two hand-built vector illustrations replace
them, both showing NUM as it actually behaves.

**2,851 pass / 0 fail**, eslint 0 errors, MCP integrity 6/6, no overflow at 390px or 1280px.
Page 36KB total.

| Replaced | With |
|---|---|
| 40 grey squares vs 3 green rows | **A traveller's phone**: the guest's question, NUM's answer, and three real pick cards with Open-now, distance, rating and Directions / Call / Website — the exact UI shipped in Round 3 |
| A green progress bar | **The owner's phone**: a booking request (party size, time, language, note) with Accept / Decline, then "You keep 90%" and "If they don't: $0" |

Inline SVG, ~10KB for both. Vector rather than captured screens: crisp on any retina phone,
no image pipeline, no CDN, and it cannot go stale the moment the real UI moves.

### The bug worth recording: a class-name collision

The phones rendered at **x = −16px** — off the left edge of the page, invisible — and their
grid parent stayed 255px tall as though they weren't there. `offsetLeft` came back
`undefined`, and toggling `filter`, `width` and `justify-self` changed nothing.

Cause: **`site.css:91` already defines `.phone{position:absolute;left:-16px;bottom:-20px}`**,
a mockup class used by other pages. My `class="phone"` inherited it, went out of flow, and
landed at literally the `left` value in that rule. Renamed to `.numphone`.

That prompted an audit of every class this work introduced against the shared stylesheets,
which found four more: **`.kpi`, `.kpis`, `.step`, `.dot`**. Resolutions:
- `.kpi` / `.kpis` already exist in `site.css` **with the same intent** — a stat-tile grid. My
  duplicates are deleted and the markup now uses the house convention (`.l` label, `.n`
  number, `.d` note), so the tiles match the rest of the site.
- `.step` carries `animation:fade` site-wide → renamed mine to `.gstep` / `.gsteps`.
- `.dot` is scoped `.brand .dot`, so it was harmless — and is now unused anyway.

**Lesson for the next session:** `public/assets/site.css` is shared by every page. Grep it
before naming a class. A generic name silently inherits behaviour from a page you have never
opened, and the symptom looks nothing like the cause.

### Dead CSS removed
Replacing the two figures orphaned 21 rules (`.fig*`, `.units`, `.meter*`, `.split`,
`.named*`, `.axis`, plus the `.kpi` duplicates). All deleted — verified by checking every
class name against actual usage in the page body.

## Round 7 — designed graphics, and a flyer that oversells the product (3 Sep)

Dre: *"These are not good, we need better quality, use canva or some kind of designer... use claude design."*

**2,851 pass / 0 fail.** Page 36KB → **27KB**; graphics 79KB (WebP, lazy-loaded).

### 🛑 The finding: `NUM — For Business (A4 flyer)` promises things the product does not do

Found in Dre's Canva while looking for real brand assets (design `DAHStHVoHiI`, updated
recently). Each line checked against source:

| Flyer says | Code |
|---|---|
| "$2 per confirmed table. **Flat, not a percentage**" | `commission.mjs` → `reservation: {bp: 1000, flat_cs: 200}` — **10% of the bill**, $2 only when the bill is not visible |
| "**$100** free promotion credit when you claim" | No promo-credit column, table or code path exists |
| "Buy an hour of promotion for **$20**" | No boost product exists |
| "Priority seating… **you keep $10**" (of $20) | `PRIORITY_SHARE_BPS = 4000` → venue keeps **$8** |

Correct on the flyer: free listing, stays/appointments 15%, activities 20%, own-QR-code
("get paid direct"), "placement is never for sale".

**Dre's calls:** table pricing stays **10% of the bill with the $2 fallback** (code and
website already agree — no change). The $100 credit and $20 boost are **real but not
shipped**, so they stay off the website under the standing rule that a thing is not in any
copy until it is live. **The flyer still needs correcting before it goes to more venues.**

### The graphics
Replaced the hand-drawn inline SVGs with two designed artboards, built in Claude Design and
matched to the flyer + `site.css` tokens (Space Grotesk / Plus Jakarta Sans, `#0EA483`,
`#0A1A24`, `#143D30`):

- **`num-answer-phone.webp`** — a traveller's phone: the question, NUM's reply, three pick
  cards with Open-now/distance/rating and Directions · Call · Website, starter chips, composer.
- **`num-booking-phone.webp`** — the owner's phone: booking request with party size, time,
  language and note, Accept / Decline, then "You keep 90%" and "If they don't: $0".

Canvas (editable, both artboards): the "NUM for Business Graphics" artifact.
Working files: `~/numdesign/*.dc.html` in the cloud session — re-seed from those to change them.

**Why WebP and not the SVG:** rendered at 2× display width (680px), 79KB for the pair versus
319KB as PNG. `width`/`height` set to prevent layout shift, `loading="lazy"`,
`decoding="async"`. Headline and checklist stay as **HTML text beside the image** — text
baked into a picture is invisible to search engines and screen readers, and both images carry
full `alt` text describing the UI.

### Add to the commit
`public/assets/num-answer-phone.webp public/assets/num-booking-phone.webp public/business/index.html`
