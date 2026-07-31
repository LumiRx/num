# Specialist agents, services, taste, and the dash

Code: `worker/specialists.mjs`, `worker/services.mjs`, `worker/events.mjs`,
`src/lib/prefs.ts`, `src/lib/services.ts`, `src/lib/events.ts`,
`src/components/app/DashView.tsx`, `src/components/app/EventSheet.tsx`.

## An agent per service

A specialist is **not** a second model call — that would double the latency and
the bill for nothing. It is a short brief appended to the system prompt when the
request is clearly in that domain (`pickSpecialist`, first match wins, ordered
so `table` doesn't swallow "order dinner to my hotel").

| Agent | Knows |
|---|---|
| `ride` | The answer is a time, not a car. Works back from the flight, adds local traffic, names the pickup *point*, flags surge and airport zones, picks the right product for bags/party size |
| `food` | Recommends the dish, not just the restaurant. What travels (fried holds, tempura doesn't), realistic door-to-door time, which kitchens are open this late, hotel rider rules |
| `table` | Matches the room to the occasion. States party size, time, and what the table *is*. Knows the city's rhythm — where 19:00 is early, where Sunday is dark |
| `nightlife` | Door times, table minimums, dress codes, group ratio — and the walkable second option when the queue is unbearable |
| `wellness` | Asks the outcome, not the treatment. Modality and length matched to jet lag / back / disappearing for an hour |
| `crypto` | **No live prices, ever. No buy/sell calls, ever.** Useful for which rails work in this country and settling a Num bill |
| `meetings` | Protects the day, not just the slot. One time with a hard stop, and squares it with the other person's Num |
| `hiring` | Turns a wish into a scope with an honest local rate band (5arz) |
| `events` | People first, venue second. One link that answers everything and chases the silent |
| `trip` | Gaps, collisions, transfers, expiring holds, entry admin — ranked, most urgent first |

`VOICE` sits above the cache breakpoint on every request: decide don't survey,
one question then act, concrete over effusive, no fawning.

### Verified live

- *"car to Suvarnabhumi, 6am flight, two big bags"* → **Grab XL**, pickup 03:30,
  worked back from the flight, named the lobby door. Grab first because Thailand.
- *"order dinner to my hotel"* in Dubai at 02:33 local → noticed the hour, picked
  a kitchen still firing, chose dishes that survive the trip, **talabat** first.
- *"car to LAX in an hour"* → warned about the 110/105 at 16:30 and the surge
  window, **Uber** deep link with the dropoff prefilled.
- *"what's bitcoin at, should I buy more ETH?"* → refused both, honestly, and
  pointed at their own exchange.

## Services: connected vs hand-off

`worker/services.mjs` maps ~35 countries to the providers people there actually
use, best first — Uber in LA, Grab in Bangkok, Careem in Dubai, Bolt in Lisbon,
iFood in São Paulo. Four kinds: `ride`, `food`, `table`, `wellness`.

> **Num holds no commercial accounts with these companies.** `ADAPTERS` is empty
> on purpose, `connected()` returns false everywhere, and the prompt forbids the
> words "booked" / "on its way" for a hand-off. An empty adapter registry is the
> *mechanism* that stops Num claiming a car it cannot call.

So every fulfilment today is a **hand-off**: the model emits a `service` action,
the server resolves the providers from the user's country and attaches the deep
links (the model never names a provider or writes a URL — it can't invent one
that way), and the app shows a tray of one-tap buttons prefilled with the
destination. The tray says so out loud: *"Opens in your own app with the
destination already filled in — Num can't place it for you yet."*

To connect one for real, add an entry to `ADAPTERS` with `{kind, ready(env),
order(env, req)}` and the same code path starts fulfilling instead of handing
off. Nothing else changes.

## Taste — learned, not configured

`src/lib/prefs.ts`. Two signals:

1. **Emoji reactions** under Num's suggestions — 😍 more like this, 👍 good,
   😐 not quite, 👎 never again, 🥱 too long. A rating with no typing, so people
   actually give it. 👎 puts the subject on a `rejected` list the model is told
   not to offer again; 🥱 alone sets `length: short` and `pace: fast`.
2. **Behaviour** — message length, whether they say "do it" or "what else".

The result is a small `style` object sent up with each turn (raw message lengths
stay on the device) and turned into a short instruction block by `styleBlock()`.

Same question, measured live:

| | Reply |
|---|---|
| No style learned | 418 chars, one pick **plus** an alternative and an offer |
| `length: short, decisiveness: one, loved: [Le Du], rejected: [Gaggan]` | 336 chars, one pick, no alternatives, and it chose Nusara — *same team as Le Du* |

## Trip check

Arithmetic on the user's own plan is done **on-device** (`tripCheck()`): clashes,
tight gaps, transfers, expiring holds, empty days, multi-city hops. The findings
go up as facts and the model does what it's good at — ranking them and saying
them well. A language model should not be trusted to subtract times unaided.

Surfaced on the dash (collapsed: "1 thing to look at") and by asking.

## Events and RSVP by text

**The guest never installs anything.** They get one text with one link; the link
is a server-rendered page at `/e/:slug?g=<token>` with where, when, dress code,
a Maps link and three buttons. The token arrived on their phone — same proof
model as every other invite in Num.

The host gets the dashboard an event site would charge for: coming / maybe /
can't / silent, headcount including plus-ones, who opened it and went quiet, and
a one-tap nudge for the silent ones — sent from the host's own number.

Verified live: 3 guests invited, page renders with details and RSVP buttons, yes
+2 counted as 3 heads, decline recorded, guest phones masked in the dashboard,
and a non-host is refused on read, invite and edit alike.

## Everything else in this pass

- **First run asks for a name and number.** Every fresh device, not just invited
  ones — a demo that ends with an anonymous device is one we can't follow up on.
  Num acknowledges by name and carries straight on to "where are you?".
- **Share to text** — `shareNative()` opens the real OS share sheet (AirDrop,
  Messages, WhatsApp, Signal, whatever they use) with a clipboard fallback, and
  `smsLink()` gets the iOS `&body=` / Android `?body=` split right, which
  silently drops the message when you get it wrong.
- **A changed reservation now alerts the group** — `pushBookingUpdateToPlan()`
  matches the plan item and re-emits it, so the friends' Nums narrate the move.
- **THREAD is a floating dot**, bottom-right, over every screen, with an unread
  badge. Tabs are DASH / PLAN / MEMORY — three, on purpose.
- **YOU is in the header, not the tab bar.** It is a place you visit
  occasionally, not one of the three things the app is for, so it lives as an
  avatar next to the wallet and opens as a full overlay. Every block on it
  collapses — fifteen fields and eight colour tiles open at once is a wall, and
  a wall is a screen people close. Each row says what it holds ("2 of 5 filled
  in", "Ember — tap to change") and opens only when asked.
- **A new plan starts on PLAN and nowhere else.** The old header button was a
  second entry point to the same thing, which is how people end up with two
  half-built plans. DASH's group card now navigates to PLAN rather than opening
  the sheet itself.
- **DASH** — next up, a fortnight strip, trip check, group, events, wallet, and
  the connections switches (contacts, photos, calendar, crypto, email, texts):
  each off by default, each saying what it buys, granted at the moment of use.
- **Lane router fixed** — "run a trip check" is short and verbless, so it used to
  route to the cheap model and come back with "what would you like to do?".
  `NEEDS_THE_BRAIN` now forces the big lane for trip checks, invites, events,
  services and crypto. 12/12 routing cases pass.

## Not built yet

| Thing | Needs |
|---|---|
| Real ride/food ordering | Commercial accounts + API credentials per provider — a business decision |
| Live crypto prices on the dash | A price feed; the agent refuses to guess until there is one |
| Email / texts / calendar ingestion | OAuth apps (Google, Microsoft) and a mail parser; the switches record intent today |
| Contacts on iOS | No Web API exists; Chrome/Android uses the picker, elsewhere is manual |
| Push when a friend's Num books | Web Push keys + notification worker; today it lands on next foreground sync |
| Business-side event dashboard | The host dashboard is per-member; hanging it off a claimed `business_id` is a small step from here (`num_events.business_id` already exists) |

---

## Travel: flights, hotels, rail

Added as three more `service` kinds. Travel is not a per-country market the way
a taxi is — the same metasearch engines cover the planet — so these come from
one global set, ordered comparison-first, with the search **prefilled**:

```
flight  Google Flights → Skyscanner → Kayak
        …/travel/flights?q=Flights from Bangkok to Singapore on 2026-08-05 returning 2026-08-09
        …/transport/flights/bkk/sin/260805/260809/
        …/flights/BKK-SIN/2026-08-05/2026-08-09
hotel   Booking.com → Google Hotels → Agoda → Expedia   (city + checkin/checkout + adults)
rail    Trainline → Omio
```

The model fills `from/to/fromCode/toCode/depart/ret` or `city/checkin/checkout`
and the server builds the URLs — it never writes one itself.

**On "find them the best price":** we cannot see live fares and we do not
pretend to. The prompt forbids stating a price as current or calling a fare the
cheapest. What Num does instead is say the band people actually pay on that
route and put the identical search into the engines that *do* compare, in one
tap. If the profile carries an airline status or hotel programme, it weighs that
openly — status on a route is often worth more than the cheapest fare, and
sometimes plainly is not.

`AIRLINES` and `HOTEL_GROUPS` list the programmes worth recognising (23 carriers
with alliances, 10 hotel groups) so "I'm Delta Platinum" changes the answer.

## The voice, rewritten

The first version optimised for brevity — "decide, don't survey", no
pleasantries — and read as clipped and machine-like. Rewritten against butler
etiquette, executive-assistant speaking practice and travel-advisor guidance:

- **Never a bare yes or no.** A short useful phrase instead — "Consider it
  done", "That one's tricky, here's what I'd do".
- **Never contradict flatly.** Fold it in: *"As you know, the ferry stops at
  six — so I've put you on the 17:20."*
- **Present alternatives, don't refuse.** Lead with what you *can* do.
- **Warm, not servile.** No "Certainly!", no "I'd be delighted to assist", no
  "Does that make sense?", no switchboard openers.
- **Plain words.** No FIT, no DMC, no inventory. Nobody needs a glossary.
- Reply shape: acknowledge → the answer with the reason → what's done → an open
  door.

The cheap lane got the same treatment, and a **code-level guard**: any
small-lane reply matching `/how can i help|here to help|let me know if|what's
up/` is discarded and the turn falls through to Claude. Asking a 70B model
nicely not to say "how can I help you today?" is not a control — this is.

## Profile, themes, dashboards

- **YOU tab** — picture (square-cropped to 160px *on the device*, so a 4MB
  phone photo never hits the wire), name, number with verification state, then
  travel facts (status, seat, home airport) and taste facts (dietary,
  allergies, budget, the kind of night they want). Everything typed here lands
  in the same KNOWN FACTS the model reads, and every field says what it buys.
  **The name locks once the number is verified** — it is what a friend sees
  next to a proved number, so changing it goes through support.
- **8 themes** — Ember (house), Bloom, Midnight, Neon, Mono, Heritage, Forest,
  Plain. A theme is a `data-theme` attribute and token overrides; no component
  knows themes exist. `--field-bg` was added because raised surfaces were
  hardcoded white and became white boxes floating on black.
- **Dashboards** — see [launch-readiness.md](launch-readiness.md).

---

## QR codes, and paying by scan

`src/lib/qr.ts`, `src/lib/stars.ts`, `worker/social.mjs` (`/stars`, `/pay`, `/who`).

**The QR is a plain https link.** That one decision removes the whole scanner
problem: every phone camera already reads a URL, iOS Safari has no barcode API
at all, and nobody has to install anything. A tuk-tuk driver tapes a printed
code to the dashboard; the passenger points their camera at it and the app
opens with the payment already filled in.

Two codes, because they answer two questions:

| | Encodes | What a scan does |
|---|---|---|
| **Connect** | `/?ref=<code>&c=<member>` | Connects you, and counts as their referral |
| **Get paid** | `/?p=<member>&a=<stars>&n=<note>` | Opens "Pay Tuk-tuk Somchai ★60 — Patong beach" |

### The encoder is written out, and verified

No runtime dependency: `qr.ts` is a byte-mode, level-M, version 1–10 encoder
(~4KB). A payment code that scans wrong is worse than no code, so it is checked
two ways, both in `scripts/`:

- **`qr-check.mjs`** compares the full matrix against the reference `qrcode`
  package — which also compares the chosen mask. Two real bugs came out of it:
  the second format-info copy was off by one (bit 7 landed on the dark module),
  and the format word was being written least-significant-bit first. Both are
  silent failures: the code *looks* perfect and decodes with the wrong mask.
- **`qr-decode.mjs`** renders our own matrix to a bitmap and reads it back with
  **jsQR, a scanner implementation**. All 14 payloads — including multi-byte
  Thai, and the long ones — decode to the exact string. That is the test that
  actually matters, and it covers the cases where we legitimately choose a
  different mask from the reference.

### Stars moved server-side

Balances left the device. A balance a phone can edit is not a balance, and the
moment two people can pay each other the client stops being allowed an opinion
about who has what. `num_star_balances` + `num_star_moves` (double-entered, so
a balance can always be rebuilt from the log).

The debit is a **conditional** update — `WHERE stars >= amount` — and the code
checks how many rows changed. That is what makes it safe under a race, and an
`idem` key makes a retry a no-op rather than a second payment.

Verified live:

| Case | Result |
|---|---|
| Rider pays ★60 | 100 → 40, driver 100 → 160 |
| Same `idem` replayed (double scan) | `already: true`, nothing moved |
| Five **simultaneous** ★30 payments from a ★40 balance | exactly **1** succeeded |
| Overspend / negative / pay yourself / unknown code | each refused with its own message |
| Credit fails after debit | debit is rolled back — Stars never vanish into a gap |

Stars are in-app credit, not money. The sheet says so, and shows the payee's
name from `/who` before you can send — "Pay them" is not a confirmation.

## Service worker: why redeploys weren't landing

Navigations were already network-first, but `fetch(request)` still consults the
browser's HTTP cache, and index.html is served `must-revalidate` — which a
browser may satisfy from its own store. The practical result was a deploy that
never reached anyone until they cleared site data, which is exactly what kept
happening during testing. Fixed with `cache: 'no-store'` on the navigation
fetch, `updateViaCache: 'none'` on registration, a cache-name bump, and an
update check when a backgrounded tab comes forward.
