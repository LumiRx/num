# NUM — threat model and standing audit

Scope: the `num-app` Worker (`app.itsnum.com`), `num-console`, `num-claim`,
`num-growth`, the `num-db` D1 and the `5arz-ledger` D1.

This document is the ground truth the three security agents work from. It is
written to be read by someone deciding what to fix first, not to be
comprehensive. Findings are ordered by what an attacker would actually do.

---

## What we are actually protecting

| Asset | Where | Worst case if lost |
|---|---|---|
| Member PII — name, phone, avatar, bio, destination | `num-db.num_members` | Regulatory + trust; phones are verified identity |
| Money ledger — Stars, tabs, settlements | `5arz-ledger`, `num_star_moves` | Direct financial loss, unwindable only by hand |
| Payment session creation | `worker/pay.mjs` → Stripe | Fraudulent charges under our merchant account |
| Travel booking | `worker/sabre-booking.mjs` → Sabre PCC `FF9A` | Real tickets bought on our credentials |
| Delivery dispatch | `worker/doordash.mjs` → DoorDash Drive | Real deliveries billed to us |
| Model spend | `env.ANTHROPIC_API_KEY` | Unbounded API bill |
| `ADMIN_KEY` | Worker secret, 5 workers | Total control of every admin surface |

The three highest-consequence assets (ledger, Stripe, Sabre) all sit behind the
same Worker as the lowest-consequence one (a public chat endpoint). That is the
central structural problem, and it is what the compartment design in
[`COMPARTMENTS.md`](COMPARTMENTS.md) exists to fix.

---

## Findings

### SEC-001 — Member endpoints have no authentication at all — CRITICAL

`worker/social.mjs` establishes caller identity by reading it out of the
request:

```js
const meId = clip(b.me, 40);                    // social.mjs:539, 653, 686, 778, 1032
const meId = clip(url.searchParams.get('me'), 40); // social.mjs:761, 872
const me   = clip(url.searchParams.get('me'), 40); // pay.mjs:224
```

There is no signature, no session token, no proof of possession. The member ID
*is* the credential, and it is submitted as an ordinary parameter.

The codebase already knows how to do this correctly — `worker/console.mjs:172`
mints an HMAC-signed session for the admin console. That pattern was never
extended to members.

**What this gives an attacker who learns one member ID:**

- Read that member's friends, plans, pending invites, tab balances
  (`GET /api/social/*?me=<id>`)
- Read their payment history (`GET /api/pay/...?me=<id>`, `pay.mjs:224`)
- Settle their tabs — which writes paired rows into the ledger
  (`social.mjs:1121-1125`), moving value between accounts
- Send connection requests and event invites in their name (`social.mjs:653`)
- Patch their account. `me()` at `social.mjs:241` accepts an existing `id` and
  updates name, avatar, bio, destination. The comment says *"Existing accounts
  may still patch freely"* — that is true for the account's owner and for
  anybody else who knows the ID.

**Why "the IDs are random" is not a defence.** `uid()` (`claim/verify.mjs:37`)
produces 80 bits of UUIDv4 entropy, so IDs are not *guessable*. But they are
not *secret* either — the system hands them to other people by design:

- `social.mjs:1146` — `SELECT member_id FROM num_tab_members` returns every
  co-member's ID to everyone else on the tab
- `social.mjs:1010` — the same for tab member lists
- Plan member lists, link rows and invite acceptance all move IDs between
  members

So the practical exposure is: **anyone you have ever shared a tab or a plan
with can impersonate you completely, forever.** Not a remote attacker — a
friend, or anyone who compromises a friend's device. That is the realistic
breach path, and no rate limit or WAF rule touches it.

There is also no revocation. Because the ID is the credential and the ID is the
primary key, a leaked credential cannot be rotated without destroying the
account.

*Fix:* signed capability tokens — see [`COMPARTMENTS.md`](COMPARTMENTS.md).
`worker/capability.mjs` implements the primitive.

---

### SEC-002 — One `ADMIN_KEY` opens every admin surface — HIGH

A single static secret authenticates admin access across five separate
workers and every admin capability within them:

| Site | What it unlocks |
|---|---|
| `worker/push.mjs:192` | Push to any member |
| `worker/sabre-booking.mjs:375, 411` | Booking admin — real tickets |
| `worker/email.mjs:300` | Send mail as us |
| `worker/index.mjs:299` | Diagnostic probe |
| `claim/worker.js:262` | Claim admin |
| `growth/worker.js:1491` | Earnings accrual — money |
| `worker/console.mjs:249` | Console login → HMAC session |

One secret, no scopes, no expiry, no per-action audit trail, and it is
duplicated across five Worker configurations. Compromise anywhere is
compromise everywhere — including the two surfaces that move money.

Comparison is also inconsistent: `console.mjs:251` and `growth/worker.js:1491`
use constant-time helpers (`safeEq`, `sameSecret`), while `push.mjs:192`,
`sabre-booking.mjs:375`, `email.mjs:300`, `index.mjs:299` and
`claim/worker.js:262` use plain `!==` / `===` on the raw header. The timing
signal is small behind Cloudflare's network jitter and is not the real issue —
the inconsistency is, because it means there is no single reviewed path for
admin auth.

*Fix:* replace with compartment-scoped admin capabilities. A booking-admin
token must not open the earnings endpoint.

---

### SEC-003 — Admin keys sit unencrypted in the home directory — MEDIUM

```
/Users/rick/.num-growth-admin-key      (0600, 65 bytes)
/Users/rick/num-concierge/.claim_admin_key  (0600, 32 bytes)
/Users/rick/num-concierge/.scout_key        (0600, 32 bytes)
```

`.gitignore` covers all three, so they are not in git — that part is handled.
But they are plaintext on disk, readable by any process running as `rick`.
On macOS that includes every npm postinstall script, every VS Code extension,
and anything that gets shell access through a dependency. These keys unlock
production money endpoints.

*Fix:* move to Keychain (`security add-generic-password`), read at use time.

---

### SEC-004 — The unauthenticated model endpoint is the cheapest DoS — MEDIUM

`/api/num` is unauthenticated by design and spends our Anthropic budget per
request. `worker/guard.mjs` is genuinely well built — two-layer rate limiting,
strict payload validation, honest same-origin CORS, and it documents its own
weakness at lines 17-21 (the isolate-local Map is nearly useless alone, and it
says so).

The residual gap is that both degraded paths fail **open**:

```js
if (!limiter?.limit) return { ok: true, degraded: true };   // guard.mjs:87-90
catch (err) { ... return { ok: true, degraded: true }; }     // guard.mjs:95-101
```

That is a defensible tradeoff — a limiter outage should not take the API
down — but nothing alerts on `degraded: true`. It is logged with
`console.warn` and no one is watching. An attacker who can make the limiter
throw gets unmetered access to our model spend and we find out on the bill.

*Fix:* the Perimeter agent watches for `[guard]` warnings and a spend anomaly;
add a hard daily spend ceiling that fails closed.

---

### SEC-005 — Prompt injection reaches tools that spend money — HIGH

`/api/num` takes untrusted user text and the agent layer (`worker/agents/`,
`specialists.mjs`, `errands.mjs`, `doordash.mjs`, `sabre-booking.mjs`) can act
on it. Any content the model reads — a place description from Google Places, a
scraped page, another member's bio, an inbound email — is attacker-controlled
input that reaches a model with access to tools that place real orders.

This is the attack class most likely to be *novel* against us, because the
techniques are still being invented monthly. It is the standing assignment for
the Threat Intel agent.

*Control:* no tool that spends money, books travel, or moves ledger value may
fire from model output alone. Those require a capability token minted from an
explicit human confirmation — enforced structurally by the `money` and
`travel` compartments, not by prompt instructions.

---

### SEC-006 — Unverified phone numbers are a claim, not an identity — LOW (accepted)

`social.mjs:290-300` hands an account back to whoever presents an unverified
phone number. The code argues this correctly at length: an unverified number
proves nothing, so refusing the claim on re-entry strands real users without
stopping any attacker.

This is a correct tradeoff and is recorded here so it is not "rediscovered" as
a finding. It stops being acceptable the moment SMS verification is on by
default — at that point `phone_verified` must gate recovery.

---

## Priority

1. **SEC-001** — nothing else matters while any friend can impersonate any member.
2. **SEC-002** — one key from money to mail.
3. **SEC-005** — structural, and the threat surface is still moving.
4. **SEC-003**, **SEC-004** — real, bounded, quick.

## What is genuinely good already

Worth stating, so the agents do not "fix" it: `guard.mjs` is careful and
honest about its own limits. `permissions.mjs` gets the invite default right
(closed, not open) and deliberately blurs refusal reasons so member IDs cannot
be enumerated through it. `generateCode()` rejects the biased tail of the
CSPRNG range instead of using a naive modulus. `.gitignore` covers the key
files. Someone was paying attention.
