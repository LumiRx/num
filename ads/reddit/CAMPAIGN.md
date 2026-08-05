# Reddit campaign — NUM, app signups

Built 2026-08-05. Units in `units/`, sources in `images/`, previews in
`units/_preview/`.

---

## ⚠️ Read before launching

**US traffic hits a wall.** A2P 10DLC is still unapproved, so every US
verification SMS fails with error `30034`. A US signup can complete the form and
then receive nothing. Until A2P clears, either:

- **target non-US first** (UK, AU, DE, SG, and travellers already in Thailand),
  where the LINE and WhatsApp paths work, or
- **hold the campaign** until the resubmission comes back (1–3 business days
  from when you update the four console fields).

Spending on US clicks today buys a dead end at the verify step. That is the one
thing capable of turning a working campaign into a refund request.

**§8 exception.** `docs/cto-handoff-duke.md` §8 says *no AI-generated imagery*.
These units are built on the existing AI-generated set in `images/`, at Dre's
explicit direction on 2026-08-05. Recording it here so a later session does not
read §8, find these, and "fix" them — and so the exception stays a decision
rather than a drift. The two strongest units (`num_04`, `num_19`) are real
product UI and are unaffected either way.

---

## The units

Six concepts × three sizes = 18 files.

| File | Line | Type |
|---|---|---|
| `num_03_*` | Skip the 40-tab research spiral. | photo |
| `num_20_*` | Local, not a listicle. | photo |
| `num_14_*` | Still open? Num knows. | photo |
| `bright_num_10_*` | Booked in one message. | conversation |
| `bright_num_13_*` | One day here. No plan. | conversation |
| `bright_num_07_*` | Your concierge in Phuket, by text. | conversation |

Sizes: `1080x1080` (feed), `1200x628` (link), `1080x1920` (vertical). Six
concepts × three sizes = 18 files, one per row above.

**Two treatments.** Photos carry a headline over a bottom scrim. The
conversation units re-typeset a real exchange as bright bubbles over a Phuket
scene.

**Why the conversations are re-typeset rather than screenshotted.** The first
build used the raw app screenshots untouched, on the theory that a real
screenshot is the most persuasive thing you can show on Reddit. That's true of
the *content* and false of the *composition* — the sources are roughly 70% empty
chat background, so the units came out dark, sparse and dull. The words are
unchanged from the originals; only one Num reply ("Got you. Sending your day
now.") is written, because the source screenshot cut it off. Every line still
describes something the product actually does.

**Background variety is deliberate.** An earlier pass had two photos doing
double duty across six creatives, which reads as one ad shown twice. All six
backgrounds are now distinct.

## Copy for the ad itself

Reddit shows a headline separately from the creative. Keep it flat — the
platform punishes ad-voice harder than any other.

- `One day in Phuket and no plan? Text it, get a plan back.`
- `We built a concierge you can just text. It's free.`
- `Ask it like you'd ask a friend who lives there.`
- `Not a listicle. Not 40 tabs. One message.`

CTA: **itsnum.com**

## Targeting

**Communities** — r/ThailandTourism, r/Thailand, r/phuket, r/solotravel,
r/onebag, r/backpacking, r/digitalnomad, r/TravelNoPics, r/Shoestring

**Interests** — Travel, Backpacking, Food & Drink

**Locations** — see the warning above. Start UK / AU / DE / SG / Thailand.

## Things not claimed, on purpose

No place-counts (the published 567,793 is known-wrong; real is ~2.53M and should
be regenerated from live D1 before it appears anywhere). No "top rated" or
"best" — `top_places` rows are not quality-ranked. No cash-out language. Every
line above survives someone checking it.
