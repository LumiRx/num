# Business claim + referrals — how it works, and how it resists fraud

Worker: **`num-claim`** → https://num-claim.thatislumi.workers.dev
Code: `claim/worker.js` (API), `claim/verify.mjs` (verification core), `claim/schema.sql`.

## The one rule that stops listing hijacks

> **The verification code goes to the contact already published on the listing —
> never to a number or address the claimant types in.**

Our directory holds the phone and website each business publishes to the world.
Receiving a code there proves you control the business's public contact point.
A claimant-supplied number proves nothing: anyone can receive a code on their
own phone. This is the same standard Google Business Profile and Yelp use.

## Verification ladder

| Rung | Channel | Target | Outcome |
|---|---|---|---|
| 1 | `sms` | `places.phone` — the listed number | auto-verifies |
| 2 | `email_domain` | a mailbox the claimant names, but it **must** sit on the same registrable domain as `places.website` | auto-verifies |
| 3 | `manual` | no usable channel, a contested listing, or a failed ladder | evidence → human review, never auto |

Free mailboxes (gmail, outlook, icloud, …) are rejected for rung 2 — anyone can
open one, so they prove nothing about a business.

## The rest of the defences

- **Codes**: 6 digits from the CSPRNG (biased tail rejected), stored only as
  `SHA-256(salt + code)`, 10-minute TTL, single use, burned on success,
  constant-time comparison.
- **Attempt cap**: 5 wrong codes locks the claim.
- **Rate limits**: 5 claims per listing per day, 10 per IP per day.
- **Contested listings**: if a place already has a verified owner, a second
  claimant gets *manual review only* and the incumbent is flagged. A listing is
  never transferred on a code alone.
- **Audit trail**: `num_claim_events` records started / code_sent / code_wrong /
  locked / verified / decided, append-only, with IP.
- **On success**: a `businesses` row is created, `num_place_owners` records the
  method and the verified number (number ↔ profile link), and the place flips
  to `claimed`.

### Verified against the live worker

| Attack | Result |
|---|---|
| Claim someone else's listing, redirect the SMS code to my own number | Ignored — the target comes from the DB row, not the request |
| Verify with `attacker@gmail.com` | Rejected: "a free mailbox can't prove ownership" |
| Verify with `me@evil-attacker.com` | Rejected — wrong domain |
| Brute-force the code | Attempts counted down 4 → 3 → 2, then locked |
| Replay a used code | `already: true`, no second grant |
| Claim an already-owned listing | `contested: true`, manual review only |
| Spray 6 claims at one listing | 6th blocked for 24h |

## What SMS still needs

There is **no SMS provider configured**. `sendCode()` is provider-agnostic and
supports Twilio today (`TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` as worker
secrets); email codes work now via `RESEND_API_KEY`. Until SMS credentials
exist, an SMS claim does **not** pretend to send — it routes to manual review
with an honest message. Add the three secrets and rung 1 turns on with no code
change.

## Referrals, invites and student ambassadors

The consumer side of this — signing up with a number, inviting a friend by name
in chat, and the group plans two connected Nums keep in step — lives in
[friends-and-plans.md](friends-and-plans.md). It writes the same
`num_referral_codes` / `num_invite_links` ledger described below, so invites
sent from the app show up in these stats with no extra plumbing.


- `POST /ref/code` — mints a friendly code (no O/0/I/1) for a member,
  ambassador, university or business. Fraud caps are set at creation
  (`max_conversions`, `max_reward_total_cs`) because an uncapped code is an
  uncapped liability.
- `POST /ref/invite` — mints a **personalised, per-person link**. It returns
  ready-to-use `sms:`, WhatsApp and Web-Share payloads so the invite is sent
  **from the member's own phone**. That is deliberate: it lands better than a
  cold text from an unknown shortcode, and it sidesteps the consent problem of
  us texting strangers. With Twilio configured, `{"send": true}` sends directly.
- `GET /r/:token` — records the open and redirects into the app with the
  referral attached.
- `POST /ref/signup` — attributes the conversion. Blocks self-referral and
  double-attribution; honours the code's cap. Conversions land `verified=0` /
  `reward_status='pending'` — rewards are granted on *verified* activity, not on
  a bare signup, which is what stops the classic student-ambassador farm.
- `GET /ref/stats?code=` — sent / opened / joined / conversions, recent invites
  with masked invitee numbers.
- `GET /ref/leaderboard?university=` — ambassador ranking.

## Not built yet (decisions or credentials needed)

| Thing | Needs |
|---|---|
| SMS codes + direct invite sends | Twilio (or MessageBird) account + sender ID per country |
| Claim UI in the app | A "Claim your business" surface + the referral dashboard screen |
| Calendar | `.ics` download and Google Calendar template links work with no OAuth; two-way sync needs Google/Microsoft OAuth apps |
| Reward payout | Stars ledger already exists (`stars_ledger`, `num_wallet_*`) — wire `reward_status: granted` to it |
| Owner notification on contested claims | Needs the owner's contact channel + a notification worker |
