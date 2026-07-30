# Friends, invites and group plans

Worker surface: **`/api/social/*`** on `num-app` (same origin as the SPA).
Code: `worker/social.mjs` (API), `worker/social.sql` (schema, readable copy),
`src/lib/social.ts` (client), `src/components/app/InviteSheet.tsx`,
`src/components/app/PartySheet.tsx`.

## The two rules everything rests on

> **1. Nothing crosses between two people until both have acted** — the sender
> by minting the invite, the receiver by opening it on their own device.

A `num_links` row is created `pending` when you send an invite and only goes
`active` when the invitee opens it and creates an account. A pending link
shares nothing at all. That is what makes "the two Nums talk to each other"
safe: neither agent can push anything at someone who never agreed. The token
burns to whoever opens it first, and a stranger who finds a used token learns
nothing (`{ok, already}` with no names).

> **2. A plan is real before a reservation is.**

`num_plan_items.status` starts at `idea`. A group names a plan, throws in
"rooftop dinner, somewhere with a view", pulls friends in — no dates, no
bookings, nothing held. When someone actually books it, the *same row* flips to
`confirmed` and lands on every member's PLAN shelf.

## What happens when two Nums are connected

`num_plan_events` is the agent-to-agent channel. Any write to a plan appends a
one-line summary written for a human thread. Each member's app polls
`GET /api/social/plan?id=&me=&since=<cursor>` every 45s in the foreground, gets
everything the *other* members' agents did (own actions are filtered out), and
narrates it:

> *Rick locked in Rooftop dinner — 2026-08-15 20:00 · Sky Bar, 1055 Silom Rd.*

Confirmed group items with a date are mirrored into that member's own bookings,
so a table one person books shows up on everyone's plan and calendar. The
reverse path exists too: `pushBookingToPlan()` sends a booking this member's Num
just made into the shared plan.

## Endpoints

| Endpoint | What it does |
|---|---|
| `POST /api/social/me` | Upsert the account, mint the referral code, start SMS verification when a provider exists |
| `POST /api/social/verify` | Check the 6-digit code (salted SHA-256, 10-min TTL, 5 attempts) |
| `POST /api/social/invite` | Mint a personalised link + `sms:` / WhatsApp / Web-Share payloads + home-screen install steps |
| `POST /api/social/accept` | The invitee's half of consent — activates the link, joins the plan |
| `GET  /api/social/friends?me=` | Connections both directions, with state |
| `POST /api/social/plan` | Create or rename a plan (title only; dates optional) |
| `POST /api/social/plan/item` | Add or update an item — `idea` by default |
| `GET  /api/social/plan?id=&me=&since=` | Sync: plan, members, items, and new events |
| `GET  /api/social/plans?me=` | Every plan this member belongs to |
| `POST /api/social/plan/join` | Join by the 6-character code |

Membership is the authorisation on every plan endpoint — a non-member gets
`403 not your plan` on read, write, and invite alike.

## Invite by name in chat

"Send an invite to Dre" → the model emits an `invite` action with the name →
`startInvite()` matches it against saved contacts and existing friends → the
sheet shows the candidates and **the user confirms who they meant** before
anything is minted. Num never sends the invite itself: the link is handed to the
OS share sheet so it goes out from the member's own number. That lands better
than a text from an unknown shortcode and needs no consent from a stranger.

Contacts come from the Web Contact Picker where it exists (Chrome/Android) —
which returns only the entries the user taps, never the address book. iOS Safari
has no such API, so the sheet always keeps a manual name field.

### Verified end to end against the live worker

| Case | Result |
|---|---|
| Dre signs up, starts a plan with no dates and no bookings | plan created, `status='idea'` item added |
| Dre invites Rick to the plan | link + message + install steps returned |
| Rick reads the plan *before* accepting | `not your plan` |
| Rick opens `/r/:token`, signs up | link active, joined the plan, "Connected with Dre" in his thread |
| Rick confirms the item | Dre's feed shows *"Rick locked in … 20:00 · Sky Bar"* |
| A second person opens the same token | `already: true`, no names leaked |
| Accept your own invite | `that is your own invite` |
| Non-member writes to / invites into a plan | `not your plan` |
| Claim a number a **verified** account holds | refused |
| Claim a number an **unverified** account holds | transferred — nothing was ever proved, so it must not squat the real owner |

## Phone verification, honestly

There is still **no SMS provider configured**. `POST /me` with a number returns
`verification: {sent: false, reason: 'no_sms_provider'}` and the UI says
*"Number saved, but not verified — SMS is not switched on yet."* The number is
usable for invites; it is not treated as proof of identity. Adding
`TWILIO_SID` / `TWILIO_TOKEN` / `TWILIO_FROM` as secrets on `num-app` turns
verification on with no code change.

Note what this does and does not gate: data flow between two people is gated on
**mutual consent**, not on phone verification, which is why the feature works
today. Verification only backs the identity shown next to a name.

## Not built yet

| Thing | Needs |
|---|---|
| SMS codes and direct invite sends | Twilio (or MessageBird) account + sender ID per country |
| Push when a friend's Num books something | Web Push keys + a notification worker; today it lands on next foreground sync |
| Splitting a tab across the group | The Stars payrail already settles one payer; per-head split needs a ledger decision |
| Leaving / removing someone from a plan | UI + an audit rule for who may remove whom |
