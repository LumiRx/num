# The payout desk

Worker: **`num-payouts`** → https://num-payouts.thatislumi.workers.dev
Code: `payouts/preflight.mjs` (the rules), `payouts/rails.mjs` (routing + adapters),
`payouts/index.mjs` (the desk). Binds **5arz-ledger**, which is where members,
Stars and payout destinations actually live — a different database from the app.

Deliberately a separate Worker: money code should not share a deploy, a blast
radius or a set of bindings with a chat UI.

## Two rules the code enforces rather than trusts

1. **A `block` finding cannot be approved.** No override in the UI, because the
   blocks are things like *"this wallet is the USDC contract"* — an override is
   just a slower way to lose the money.
2. **Nothing is marked sent unless a rail adapter actually sent it.** Every
   adapter is unready today, so the desk prepares, checks and approves, and then
   says plainly that it cannot execute. A queue that lies about what it did is
   worse than no queue.

Stars are **held** when a cashout is requested and **debited when it settles**,
never at request time. A rejected or failed payout returns the balance. A member
whose Stars vanish on a payment that never landed does not come back.

## What the live ledger actually says

Run `node scripts/payout-dryrun.mjs` (read-only, no credentials) for this.

| | |
|---|---|
| Members | 141 · 102 verified |
| Holding Stars | **68 · 4,991★ = $4,991** |
| **Blocked** | **58 members · $4,336** |
| Needs a human | 10 members · $655 |
| Clear to pay right now | **0** |

### The findings that matter

- **One saved wallet is the USDC token contract on Base**
  (`0x8335…2913`, Reginald Noel, 86★). Paying it burns the money with no way
  back. This is now a hard block, and it is the reason `preflight.mjs` exists —
  a human scanning a column of hex will not catch it, a rule will, every time.
- **57 of 68 people with a balance have no payout destination at all** — $4,250
  of the $4,991. This, not the choice of rail, is the real constraint.
- **Two accounts share one wallet** (`mem_z8t3if…` / `mem_oquonx…`, surnames
  Haug). Held for a human, never auto-paid.
- **Nobody has signed an agreement** — `msa_signed_at` is null on all 141
  members, so this holds every payout. Reported once as a systemic finding
  rather than 68 times.
- **Two country mismatches** between the account and the payout method (US vs
  NL, US vs "other").
- **Zero Stripe Connect accounts.** All 11 destinations on file are USDC on
  Base, enabled, default. The behavioural signal stands: eleven people set up a
  wallet in one tap and nobody finished Connect onboarding.

### Where the briefing was wrong

The plan we were handed said *"49 verified US members hold 5,370 Stars, biggest
holder 1,202"* and *"mem_4xx35e at $798, your largest payable balance"*. The
live tables say 68 members hold 4,991★, the biggest holder is 1,136★ (blocked —
no destination), and mem_4xx35e holds **65★ = $65**. It also recommended a first
payout without noticing the burn address. Numbers in a briefing are a starting
point; the ledger is the authority.

## Rails

| Rail | Status | To turn it on |
|---|---|---|
| USDC on Base | not connected | `USDC_SIGNER_KEY` + `USDC_RPC_URL` |
| Stripe Connect | not connected | `STRIPE_SECRET_KEY` + members completing onboarding |
| Wise | not connected | `WISE_API_TOKEN` |
| PayPal | not connected | `PAYPAL_CLIENT_ID` + `PAYPAL_SECRET` |
| Thunes | not connected | `THUNES_API_KEY` — the answer for Asia, which Stripe does not cover |

`chooseRail()` prefers a rail the member already has a working destination for,
then the country table by priority. A country row saying "US → stripe_connect"
is worthless when the member never onboarded, so it ranks below a wallet we hold.

## Endpoints

All require `X-Admin-Session` (posted key → HMAC-signed 12h session, same scheme
as the operator console; the key never travels in a URL).

| | |
|---|---|
| `POST /session` | key → session token |
| `GET /roster` | everyone with a balance, checked, plus systemic findings |
| `GET /inspect?member=` | one member in full: methods, findings, routing, history, Stars ledger |
| `POST /request` | queue a payout — **holds** the Stars, refuses on any block |
| `POST /decide` | approve or reject; rejecting **returns** the held Stars |
| `POST /execute` | send it — refuses unless the rail adapter is configured |
| `GET /queue`, `GET /audit`, `GET /rules` | the queue, the audit trail, the danger list |

Every step writes to `payout_audit`.

## What to do next, in order

1. **Fix the burn address.** Reginald Noel needs to supply a wallet he controls.
2. **Resolve the shared wallet** before either Haug account is paid.
3. **Ask the other 57 for a destination.** That unlocks $4,250 — more than every
   other fix combined. Make the wallet the default path; the data says people
   finish it and do not finish Connect.
4. **Decide on the agreement**: collect signatures, or drop the check
   deliberately. Right now it holds everything by accident.
5. **Connect one rail.** USDC on Base is the only one with real destinations
   already on file.
6. Set `ADMIN_KEY` on `num-payouts` (`cd payouts && npx wrangler secret put ADMIN_KEY`)
   — use the same value as the app so one sign-in opens both.
