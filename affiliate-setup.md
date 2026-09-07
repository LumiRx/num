# Turning the hotel links into money — Hilton, Marriott, IHG

**1 Sep 2026.** What NUM can do on its own is done. What is left needs you,
because it needs accounts and credentials, and those are your keystrokes.

---

## The finding that changed the shape of this

`affiliate.mjs` could only ever do one thing: append a parameter to the
merchant's own URL. `opentable.com/r/bestia?ref=12345`. That is how OpenTable
and the small booking engines work, and for two years it was the only shape the
file knew.

**The hotel chains do not work that way.**

Marriott and Hilton run their programmes on **impact.com**. IHG runs on
**Partnerize**. Both are *click-redirect* networks: the cookie that earns the
commission is set by the **network's own domain**, which the guest has to
actually pass through.

So a ref parameter appended to `hilton.com/...` sets nothing, is ignored by
Hilton, and pays nothing — **while looking, in our own click log, exactly like
a tagged link that works.** An affiliate table that reports revenue we are not
earning is worse than one that reports none.

`affiliate.mjs` now has a second mode. A rule can carry a `wrap` template with
two placeholders:

```
{dest}  the destination URL, percent-encoded
{sub}   a short attribution string
```

One mechanism covers both networks — Impact puts its sub-id in the query,
Partnerize puts it in a path segment — with no network-specific code anywhere.

## Why `{sub}` matters more than the commission rate

`subId1` (Impact, 64 chars) and `pubref` (Partnerize, 100 chars) come back on
**the network's own payout report**.

NUM now puts the scout's code there. So the question *"was this booking one of
Adam's?"* is answered by **Hilton's statement**, not only by our database. Two
independent records that have to agree is what makes a commission owed to a
real person checkable rather than assertable — and it is the difference between
paying someone because the ledger says so and paying them because you can show
them why.

---

## What you need to do

### 1. Apply to the three programmes

| Brand | Network | Commission (reported) | Cookie |
|---|---|---|---|
| Marriott Bonvoy | impact.com | ~3–6% of room revenue | ~7 days |
| Hilton | impact.com | ~4% of room revenue | ~30 days |
| IHG | Partnerize | ~3–7% of room revenue | ~7 days |

Rates are what the trade press reports, not what NUM has been quoted. Treat
them as a reason to apply, not as a number to promise anyone.

### 2. Copy your tracking link out of each dashboard, and paste it into the secret

Each network gives you a click URL containing your publisher ids. Turn it into
a template by replacing the destination and sub-id with the placeholders:

```json
{
  "hilton.com":   { "wrap": "https://<yours>.sjv.io/c/<MPID>/<ADID>/<CAMPID>?subId1={sub}&u={dest}" },
  "marriott.com": { "wrap": "https://<yours>.sjv.io/c/<MPID>/<ADID>/<CAMPID>?subId1={sub}&u={dest}" },
  "ihg.com":      { "wrap": "https://prf.hn/click/camref:<YOURCAMREF>/pubref:{sub}/destination:{dest}" }
}
```

Then, merged with whatever `NUM_AFFILIATES` already holds:

```
npx wrangler secret put NUM_AFFILIATES --config wrangler.app.jsonc
```

**Your keystrokes, not mine — these are account credentials and I do not
handle them.** No deploy is needed; the secret is read at request time.

### 3. Check it before you trust it

```
curl -s -X POST https://app.itsnum.com/api/book/link \
  -H 'content-type: application/json' \
  -d '{"place_id":"5f3713f92a7ea5ef90f3"}' | jq -r .url
```

The URL that comes back must be on the **network's** domain, with your ids in
it, the Hilton deep link percent-encoded in `u=`, and `subId1=ADAM`. If the
host is `hilton.com`, the wrap did not fire and nothing is being earned.

---

## Say the true thing on the application form

The forms ask how much traffic you send. Here is the whole click log, today:

| host | handoffs | tagged | window |
|---|---:|---:|---|
| m.uber.com | 2 | 0 | 24–28 Aug |
| bolt.eu | 1 | 0 | 24 Aug |
| free-now.com | 1 | 0 | 24 Aug |
| ride.lyft.com | 1 | 0 | 28 Aug |
| fresha.com | 1 | 0 | 23 Aug |
| gowabi.com | 1 | 0 | 23 Aug |

**Seven rows. Zero hotel handoffs, because until this deploy NUM could not hand
out a hotel link at all.** Anything you tell Hilton beyond that is a number
they can check and you cannot support, and an affiliate account closed for
misrepresentation is not one you get back.

The honest and stronger pitch is what NUM *is*: a concierge with a verified
directory, thirteen Edinburgh properties deep-linked to the brand's own booking
engine, sending guests to **book direct** rather than through an OTA — which is
the outcome every one of these chains is trying to buy. Apply on that, and let
the traffic evidence accumulate now that the log can record it.

---

## One thing worth deciding early

NUM sends guests to the hotel's own booking engine, and never holds money —
which is what keeps a California seller-of-travel bond at zero. **An affiliate
commission does not change that**: it is a referral fee paid by the brand,
after the stay, and it never passes through NUM. That is the same reasoning
already written into `affiliate.mjs`, and it is worth keeping true as these go
live.

## Sources

- [Hotel affiliate programs compared — operator map 2026](https://track360.io/blog/hotel-affiliate-programs-compared-marriott-hilton-ihg-operator-map-2026)
- [impact.com — Sub ID and Shared ID parameters for partners](https://help.impact.com/partner/what-would-you-like-to-learn-about/platform-features/tracking/tracking-links/link-parameters/sub-id-and-shared-id-parameters-explained-for-partners)
- [SubID tracking formats, incl. Partnerize `prf.hn` and Impact](https://strackr.com/subid)
- [Hilton affiliate program details](https://getlasso.co/affiliate/hilton/)
