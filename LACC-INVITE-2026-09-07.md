# LA Cannabis Club — the text, and the one thing that has to happen first

**Alfredo · (818) 667-6918 · claim 16**

---

## Send it from your phone, not from NUM

NUM can send texts — Twilio is live, the A2P campaign was approved on 28 July.
So this is not "we can't". It is "we shouldn't", for one reason:

US carriers prohibit cannabis-related messaging on 10DLC. NUM's number is the
one that carries **every sign-in code in the product**, plus the booking desk
and friend invites. A message naming "LA Cannabis Club" — and his reply, and
the thread after it — is cannabis-related traffic on that number. The upside is
one onboarding text. The downside is nobody being able to sign in.

Sending it yourself costs nothing and works better anyway. A founder's text
from a real phone gets answered; a system message gets ignored.

---

## First — put him on the map. He is currently in Kansas.

His listing was geocoded to **37.0258, -97.6065** — a field in Winfield,
Kansas, 1,200 miles from his shop. "608 S Main Street" carried no city, and the
geocoder picked one. Until this is fixed there is no `places` row, no business
account, and nothing for him to sign into.

**Run this first — it takes about a minute:**

```bash
cd ~/num-worktrees/app-main
TOKEN=$(curl -s -X POST https://app.itsnum.com/api/admin/session \
  -H 'Content-Type: application/json' \
  -d '{"key":"'"$ADMIN_KEY"'","who":"dre"}' | jq -r .token)

curl -s -X POST https://app.itsnum.com/api/admin/submissions/promote \
  -H "X-Admin-Session: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"submission_id":"sub_bf6ad9efffa7bdeb9c1b","lat":34.0443,"lng":-118.2507,"dest":"los-angeles","by":"dre"}'
```

If you text him before this runs, the link goes nowhere and you get one shot at
a first impression.

---

## Text 1 — the invite

> Alfredo — Dre from NUM. Your listing is live. Claim it here and it's yours:
> **itsnum.com/business** — use this number, you'll get a code.
>
> Once you're in, two things and you can start taking orders: add what you sell
> with prices, and set your delivery area. Takes about ten minutes.
>
> Anything's off, text me here.

*Why it's shaped this way: it names you, it says what to do, it says how long,
and it gives him one way to get help. No app-store step — NUM installs from the
browser, and telling him that up front removes the "I'll do it later" reflex.*

---

## Text 2 — after he's in (or if he goes quiet for a day)

> Nice — you're in. Last bits so we can start sending you people:
>
> · **What you offer** — everything you sell + price. NUM only ever tells a
>   customer what you've put there, so an empty menu means we can't send anyone.
>   Price varies? Leave it blank and write "market price" or "from $40".
> · **Delivery** — your radius, your fee, your licence number, hours.
> · **Profile** — hours, address, a line about the shop.
>
> Then flip delivery on and you're taking orders.

---

## Text 3 — the one that actually matters

> What's your email? Everything automatic in NUM — order alerts, going live,
> receipts — goes to email, and we don't have one for you.

**Claim 16 has his name and his phone. `email` is NULL.** Without it he never
gets an order notification when his phone is face-down, and the welcome and
go-live mail can never reach him. Ask for it in the first exchange while you
have his attention.

---

## Add the app to his phone — send when he asks

> Open **app.itsnum.com** in Safari → tap Share (square with the arrow) → **Add
> to Home Screen**. Android: same page in Chrome → ⋮ menu → **Add to Home
> screen**. Nothing to download.

Signing in on the phone with **(818) 667-6918** — the number that claimed the
listing — is what brings him his orders. It has to be that number: NUM matches
the phone that received the claim code, never the number published on the
listing, so nobody can see his orders by knowing his shop's number.

---

## Before delivery is switched on

**Verify the licence at search.cannabis.ca.gov.** The field requires a licence
number; it does not check that one is real or current. That check is ours to
make, once, before his name is ever shown to a customer.

---

## What I fixed while I was here

The geocoder that put him in Kansas would have done it to the next business
too. It asked Geoapify for exactly one answer — and one answer to an ambiguous
question is a confident answer, with the evidence of the ambiguity thrown away.
It now asks for five and compares them: if the runner-up is roughly as good and
more than 25km away, the row stays in the review queue with a note saying
*"this matches Winfield, Kansas and Los Angeles, California — ask which city."*

A question anyone can answer in four words, instead of a business quietly
sitting on the wrong continent.

**3,094 tests green, 0 lint errors.** Not deployed — say the word.
