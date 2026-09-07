# Four businesses raised their hand and nobody could see them

---

## Arroyo is already in NUM

**Arroyo del Sol Clothing Optional Bed and Breakfast** — Hotel, Pasadena. It's
been in the directory the whole time; my earlier search missed it because I
searched your spelling, "aroyo", and the listing has two r's. Larry started a
claim on it and is waiting.

---

## They weren't ignored. They were invisible.

Your morning alert reads **every** unfinished claim. The ops console you'd open
to do something about it reads **only** `state = 'verified'`.

So for three mornings running your phone said *"Holiday Inn Express Edinburgh
City Centre — Adam (12d)… (13d)… (14d)"*, and the Claims page had no row for
him. The tally on that page even counted him — under "pending" — with nothing
to click. Larry joined the same hole yesterday.

Four people, one blind spot:

| Who | Business | Waiting |
|---|---|---|
| Adam | Holiday Inn Express Edinburgh City Centre | 14 days |
| — | 11:11 Resto and Bar | 11 days |
| — | 11:11 Resto and Bar *(second claim, likely a duplicate)* | 11 days |
| Larry | Arroyo del Sol Clothing Optional B&B | new |

---

## Why the claims stall in the first place

This is the part worth understanding, because it will keep happening.

When someone claims a listing, NUM sends a one-time code **to the contact
already published on that listing** — not to the address the person typed. That
is deliberate and it's the entire reason claiming can't be used to steal a
business: the code goes to the door, not to whoever knocked.

But the published contact on a hotel is `reception@`. Adam typed his own
address, the code went to a reception inbox, nobody forwarded it, and it
expired. The claim then sits at `pending` **forever** — nothing sweeps it to
`expired`, and there's no "send it again" for the claimant. He is stuck with no
move available to him, and until now, no move available to us either.

---

## What I built

**The queue shows them now.** Every stalled claim, with how many days they've
waited and one sentence saying exactly where the code went — *"The code went to
r\*\*\*@fingal.co.uk, not to adam@example.com who filled in the form."* Those two
addresses being different **is** the explanation, so the page says it rather
than leaving you to work it out from timestamps.

**And you can now vouch for them.** A grant route that does for an existing
listing what `--owner` does for a new submission: creates the account, records
the ownership, marks the claim verified, and hands back a one-tap sign-in link.
Same machinery that got Alfredo in.

It records `method: 'admin_promote'` — never `sms` or `email`. Those mean a code
reached the published contact, which is the anti-hijack property. A person
vouching is a weaker, different fact and the register has to keep saying which
one it was. It refuses without a name, refuses a listing that already has an
owner, and refuses a listing that doesn't exist.

---

## I could not deploy it, and that is the lock working

`cowork-connections` is mid-edit in the same tree — *"backfill: rank by a signal
the directory actually has"*. The deploy claim refused:

> a deploy now would ship whatever is half-written on disk

That's exactly the behaviour we want. When they release, run:

```bash
cd ~/num-worktrees/app-main
node scripts/claim.mjs take deploy "stalled-claim grant route + queue widening" --who dre
```

```bash
npm test && npm run build && npm run release:stage && npm run release:ship
```

```bash
node scripts/claim.mjs release deploy --who dre
```

Then tell me and I'll grant all four and send you their sign-in links.

---

## Two things that worry me

**What's deployed doesn't match this tree.** `/api/admin/claims` returns 404 on
production right now, while `/api/admin/submissions` and `/api/admin/overview`
both work — and all three routes sit in the same block of the same file here.
So the live worker was built from a different version of `console.mjs` than the
one on disk. **With git broken I cannot diff them to find out what else differs.**
That's the second time today the missing repo has cost us something real.

**Your alert channel is erroring.** At the top of that screenshot there's a
truncated `400 invalid_request_error … Your cred… Quota: check the balance`.
Something in the alerting or model path is failing on credits. Worth a look
before it swallows an alert that matters.

---

## Aroyo's disclosure

Separately: the clothing-optional handling is built and tested but **not wired
into the live answer path yet** — I want to do that as its own pass now that I
know the real listing. The rule you chose: it can be suggested for what it
genuinely is, the disclosure leads the first sentence, unverified guests don't
see it, and any ask mentioning kids or family returns nothing at all.

**3,493 tests green, 0 lint errors.**
