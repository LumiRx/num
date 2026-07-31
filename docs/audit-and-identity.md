# System audit, stress test, and who counts as one person

## Endpoint audit — 23 checks

Every public route, every auth gate, every validation path.
`scratchpad/audit.sh` (re-runnable).

| | |
|---|---|
| Public reads | version, brains, claim search, event page, confirm page — all correct |
| **Auth gates** | admin overview with no session, a forged session, a wrong key, and the brain probe without a key — **all refused** |
| Validation | 11 malformed / missing-field requests — all rejected with their own message, none 500'd |

One test "failed": `/claim/confirm?t=nope` returns **200 with a human-readable
page** rather than a 404. That is right — it is a page a business owner opens
from their inbox, not an API. The expectation was wrong, not the code.

## Stress test

| Test | Result |
|---|---|
| **50 devices race for the same phone number** | **exactly 1 won** |
| 120 concurrent inbox polls | 120 × 200, **1.2s** |
| One payment + 8 replays of the same idempotency key | 1 charged, 8 recognised as already-done, balance exactly right |
| 20 signups from **one IP** | 1 through, **19 rate-limited** |

That last row is the per-IP limiter working, not a bug — in production 50 users
are 50 addresses. It matters for one case only: **a demo where everyone is on
the same wifi.** Raise `ratelimits.simple.limit` in `wrangler.app.jsonc` before
a room full of people tries to sign up at once.

## The Sybil hole this found

`POST /api/social/me {}` — an **empty body** — created an account *and minted a
referral code*, every single time. A farm in one curl loop, and referral codes
are worth Stars.

Two changes:

**A new account needs a name.** Existing accounts can still patch themselves
freely (that is how the profile saves), but nothing is created from nothing.

**One number, one account — verified or not.** The previous rule released an
unverified number to whoever asked next, which was wrong in both directions: it
let one person mint an account per device from a single number, *and* it handed
a stranger somebody else's account for the price of typing their number. Until
SMS is on, an unverified number is a **claim**, so a collision is refused and
written down rather than resolved.

**Signals.** `num_identity_signals` records device id, hashed IP, hashed user
agent and country per account, and every refused collision. Hashed because the
only question we ever ask of an IP is whether two accounts share one — never
what it was.

Verified live: three empty POSTs refused, a real signup unaffected, the same
number from a second device refused with the collision logged, and the original
device still able to update itself.

## What identity still cannot do

- **SMS is not on**, so no number is *proved*. The rules above stop farming;
  they do not establish that a number belongs to the person holding it.
- **A cleared browser is a new device.** `num-device-id` lives in localStorage.
  The phone rule is what stops that becoming a second account.
- **Nothing links to the 5arz `uniqueness_attestations` table yet.** When the
  app and the earner ledger need to agree that two accounts are one person,
  that is where it should join.
