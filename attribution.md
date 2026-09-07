# Adam's hotel links — attribution, end to end

**1 September 2026.** Instruction: *"any booking we make with these are under
adam."* 13 Edinburgh hotels, from the PDF Adam and Sean sent.

---

## The thing that was actually wrong — two things, not one

### 1. There was no field to put the answer in

`num_scout_places` has known since 25 August which scout introduced which
business. `num_affiliate_clicks` has recorded every outbound link NUM put in
front of a guest. **The two tables could not see each other**, because the
click log wrote down a *host* and never a *place*.

`be.synxis.com` is one booking engine a thousand hotels share. So a link handed
out for one of Adam's hotels and a link handed out for a hotel that came off
OpenStreetMap produced **identical rows**. Not a wiring bug — the column did
not exist.

### 2. NUM could not hand out these links at all

Nine of the thirteen are Hilton, Marriott and IHG properties. `booking.mjs`
knew about eleven independent hotel engines and **not one chain**. So
`/api/book/link` answered `bookable:false` for every one of them, no link was
ever offered, and no attribution could have fired even after fix #1.

Fixing only the first one would have produced a tracking system that correctly
tracked nothing.

---

## What shipped

| File | |
|---|---|
| `worker/sourcing.mjs` | **new** — answers *"who introduced this place?"* at the moment a link is handed over. One query per reply, cached, never throws. |
| `worker/affiliateclicks.mjs` | `num_affiliate_clicks` gains **`place_id`** and **`scout_id`**, added by ALTER because the table is already live. |
| `worker/openapi.mjs` | `/api/book/link` now carries the place id onto the handoff. It always had the id in hand and dropped it. |
| `worker/booking.mjs` | **Hilton, Marriott and IHG** added as stay engines. |
| `scripts/nightly-analytics.mjs` | `sourced_handoffs` and `unattributed_bookable_handoffs`. |

**2,427 tests pass, 0 fail** (was 2,387). 40 new.

`/api/book/link` is the single choke point every venue booking link passes
through — the app and the partner MCP both route to it. One place to fix.

### How the chain hotels were matched — and why it is not guesswork

A chain identifies each property by a short code, and that code was **already
sitting in `places.website`** on rows the directory has had all along:

```
hilton.com/en/hotels/ednchqq-the-caledonian-edinburgh/    →  ctyhocn=EDNCHQQ
marriott.com/en-gb/hotels/edilg-the-edinburgh-grand-…/    →  propertyCode=edilg
ihg.com/intercontinental/…/edinburgh/edigs/hoteldetail    →  hotelCode=EDIGS
```

NUM reads the code off the page it already stored and rebuilds the deep link —
and lands on **byte-identical URLs to the ones in Adam's PDF**, arrived at
independently. That agreement is the evidence. A name match is not evidence,
and a name match is what puts a guest at the wrong Sheraton.

### Three properties the tests hold

- **A voided introduction attributes nothing.** A void that only flips a status
  column while new rows keep carrying the old scout is a void in name only.
- **Two hotels on the same booking engine are two rows, not one.** The old
  dedupe key was `host|kind` — two hotels on synxis share both, so one reply
  offering a sourced hotel and an unsourced one would have collapsed into a
  single row and dropped whichever attribution came second. A lost payment to
  a real person.
- **Attribution never reaches the URL.** The same hotel produces a
  byte-identical link whether or not anybody is credited with it. A
  recommendation that can be bought is worth nothing, and a scout programme is
  not worth that.

### No chain prefills dates, deliberately

Adam's sheet says it: *"you'll still need to enter your dates."* These engines
answer HTTP 200 to any query string they do not recognise, so an invented
`checkInDate` yields a page that opens cleanly on **today** while the traveller
believes they are looking at their weekend — a failure nobody sees until
someone arrives at a hotel with no room. `dated:false` is what stops NUM saying
"dates already filled in" over a link that has none.

---

## What you run

`adam-attribution.sql`, attached. Three steps: register Adam, switch the nine
chain hotels on, put all thirteen under him.

```
cd ~/num-worktrees/app-main
npx wrangler d1 execute num-db --remote --file ./adam-attribution.sql
```

**Two blanks, both marked `<<>>`, neither guessed:** Adam's email, and the date
he actually agreed.

### The one about terms — read this before running

`terms_version` and `agreed_at` are a written record that a named person agreed
to something. **No scout terms have been published yet.** Writing `v1` would
put in a ledger about money that Adam read a document that does not exist, so I
wrote `pre-terms-2026-09-01` instead and left the date blank.

If he has not agreed to anything yet that is fine and blocks nothing — the
attribution can be recorded now and the terms attached when they exist.

---

## Two findings from doing this

### The directory lists seven of these hotels twice

The Caledonian, the Carlton, the DoubleTree, the Sheraton, the Glasshouse, the
Kimpton and Tigerlily each have two rows. **The Fingal has four.**

`UNIQUE(place_id)` credits exactly one row per place, so crediting only one of
a pair loses the attribution roughly half the time — whichever row the guest
happens to be handed. So the SQL puts **every** duplicate row under Adam.

Said out loud: the finder's fee is per row, so two live rows for one hotel
could pay $5 twice. The gate makes that unlikely — a row pays nothing until it
has produced $5 of real revenue, and an unused duplicate never will. The clean
fix is a dedupe pass on `places`, which is a separate job and does not block
this.

### The Fingal is the one I did not guess

Four rows, three with the identical website, nothing to separate them. A wrong
`place_id` is permanent — the wrong row blocks the right one forever. Tell me
which is real, or say "all four" and I will add them like the rest.

---

## What is and is not money

The nightly run now answers *"did we use any of Adam's links"* by itself, as
`sourced_handoffs`. **A handoff is not a booking.** It is a link NUM put in
front of a guest; the tap happens on somebody else's domain and NUM never sees
it. Nothing in that number is owed to anyone.

What is owed lives in `num_scout_earnings`, gated on the venue producing its
first real $5 to NUM. That gate is the whole design: paying on a signature
means the optimal move is volume of signatures — walk a street, collect fifty
taps, leave behind fifty dead listings.

### Still worth knowing

None of these nine chain links is tagged with an affiliate ref, because
`NUM_AFFILIATES` has no entry for hilton.com, marriott.com or ihg.com. The
handoff is recorded and Adam is credited either way — but **NUM currently earns
nothing on a booking made through them.** All three brands run affiliate
programmes. That is the next revenue conversation, and the click log now
produces exactly the traffic evidence their application forms ask for.

---

## Deploy

```
cd ~/num-worktrees/app-main
npm run build && npx wrangler deploy --config wrangler.app.jsonc
```

**This build also carries the verified-number lockout fix** — you are still
locked out of your own account until it ships.

## Open

1. **Adam's email** and **the date he agreed** — the two blanks in the SQL.
2. **Which Fingal row** is the real one.
3. **Sean.** The decision was to credit Adam; `notes` on his row records that
   the sheet was sourced jointly, so if the two of them split it later the
   record says what actually happened rather than what was easiest to write
   down.
