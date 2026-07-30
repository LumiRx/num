# NUM for Business — API, MCP, and SMS onboarding (build spec)

**Goal:** any business can plug into Num — through our API/MCP if they have
systems, or through a single text message if they have nothing. Once verified,
their number is linked to their profile, they get the Business button + login
in the app, and an analytics dashboard that upsells into the full website view.

**What already exists (build on it, don't rebuild):**
- `accounts/worker.js` — magic-link sign-in for HQ + business partners
  (`businesses`, `accounts`, `magic_links`, `sessions` tables in num-db),
  mounted at itsnum.com/api/accounts*.
- `scripts/invite_gen.mjs` + `send_invites.mjs` — personalised invite
  generation and batched sending (email today, Resend).
- The partner console (public/console) reading num-db, incl. directory.json.
- 380k+ place directory in num-db with phone numbers (the outreach list).
- `feature_requests` table — the demand signal for which capabilities to
  prioritise per metro.

## 1 · Business API (v1)

Worker `num-biz-api` mounted at `api.itsnum.com` (or itsnum.com/api/biz*):

- `POST /v1/claim` `{place_id | phone}` → starts claim; sends SMS/email code.
- `POST /v1/verify` `{claim_id, code}` → business account + API key issued.
- `GET/PATCH /v1/profile` — hours, services, booking link, photos, deals.
- `POST /v1/availability` — push open slots (tables, appointments, cars).
- Webhook out: `booking.requested` / `booking.confirmed` / `message.received`
  so their POS/booking system reacts to Num users in real time.
- Auth: per-business API keys (hashed in D1) + rate limits; every write is
  attributable.

## 2 · MCP server (agents plug in)

`mcp.itsnum.com` (Workers MCP): tools `num_search_places`,
`num_get_availability`, `num_request_booking`, `num_confirm_booking`,
`num_business_profile`. The same D1 + API underneath — MCP is a thin layer so
partner AIs (and our own) negotiate bookings agent-to-agent. This also becomes
the booking-services connector for the consumer app (askNum's booking actions
route through the same availability API instead of "hold only").

## 3 · SMS onboarding (no-tech businesses)

Trigger: Num user asks for a business we can't confirm live, or ops picks a
batch from the directory (we have their phones).
1. Text via Twilio/MessageBird sender: "Num sends you customers. Set up your
   business: <link itsnum.com/claim/XYZ>" — claim link pre-filled with their
   directory row (name, address, category already populated).
2. Link opens claim page (exists at itsnum.com/claim — extend): confirm
   details, choose services, verify by SMS code to the SAME number (proves
   ownership), optional booking link/hours.
3. On verify: `businesses.status='verified'`, number linked to profile,
   magic-link account auto-created (accounts worker), welcome text with
   dashboard link.

## 4 · In-app Business surface

- "For business" button on the app (header ⋯ / onboarding footer) → magic-link
  login (accounts worker as-is).
- Business home (mobile web, same glass UI): today's requests, bookings,
  respond-to-user thread (their side of the concierge).

## 5 · Analytics dashboard

- D1 already logs llm calls + will log bookings/feature_requests per place.
- v1 tiles: views in Num answers, taps, booking requests, confirmed, response
  time, revenue est. Mobile summary in-app → "Full analytics on the web" →
  console business view (exists, extend with these tiles).

## Sequencing (each shippable alone)

1. Claim + SMS verify + number↔profile link (unlocks everything else).
2. Business login surface in app (accounts worker reuse — small).
3. Availability API + booking round-trip (consumer booking goes real).
4. MCP wrapper (thin, after API stabilises).
5. Analytics tiles (needs 1-3 generating data).

Open items: SMS provider account (Twilio vs MessageBird) + sender IDs per
country; legal check on outreach texts per market (TCPA/GDPR equivalents);
Stars settlement for business-side payouts.
