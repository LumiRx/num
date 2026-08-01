# CTO Handoff — Duke

*Everything running, everything broken, everything decided, and what to do first.*
*State of the system as queried on 31 July 2026. All production access read-only.*

---

## 0. The four things that are wrong right now

Before anything else, because two of them affect money and one is live in production.

**1. Member balances disagree with themselves.** 21 of 80 members have a `stars_ledger` sum that does not match `member_finance`. Total absolute drift 3,852 Stars; worst single member out by 1,102. `payable_stars` is **0 for all 80 members**. The member named in the first-payout plan, `mem_4xx35e9j97v1`, is owed either $798 or $100 depending on which table you read. **Nobody gets paid until this is one number.**

**2. The signing key registry does not match production.** `attestation_keys` says the active ES256 signer is `es256:5arz-oracle-1`, with a verifier string that literally reads *"kid=5arz-oracle-1"*. The live JWKS at `api.5arz.com/.well-known/jwks.json` publishes exactly one key: **`5arz-oracle-2`**. A rotation happened without updating the registry and without an overlap window. Any credential signed by oracle-1 is unverifiable today. Blast radius is currently zero because every credential table is empty — which is precisely why this is the cheap moment to fix it.

**3. `hmac-v0` is still active.** A symmetric shared secret used for attestation means **anyone who can verify can also forge.** That is survivable while we are the only verifier. It becomes fatal the moment a third party runs a node, which is now the plan. It has to die before any node ships.

**4. There is half a million dollars of member debt nobody has mentioned.** `member_finance` holds 50 members with $502,574.66 original debt, $494,064.94 remaining, 0 tranches paid, 0 cents sent. The schema around it is deliberate — `payout_required_pct` 25, `tranches_total` 4, `payout_earndown_cents`, `first_payout_unlocked_at`. Somebody designed a four-tranche earn-down product. Nobody knows if it is live. If it gates cash-out, then cash-out and the debt model are the same feature.

---

## 1. What the company is

Four brands, one thesis: the internet went fake, and proving real is the business.

| Brand | Proves | Status |
|---|---|---|
| **Lumi** | — | The true parent. **Never public.** No consumer surface, schema, footer or profile may mention it. |
| **Aeroz** (aeroz.io) | Products are real | Lead company of the public portfolio |
| **5arz** (5arz.com) | People are real | Owns and runs NUM |
| **NUM** (itsnum.com) | Places are real | AI travel concierge, branded "NUM — by 5arz" |
| **Cupidt** (cupidtoday.com) | — | Verified-human dating. Stands alone publicly until Phase 2. **Do not name in 5arz materials yet.** |

**One thing to check on day one:** there is a deployed worker called `lumirx-coming-soon`. If it serves a public route, that is a Lumi surface, and the standing rule says there are none. Also `still-mountain-a48b` — an auto-named worker nobody meant to keep.

---

## 2. The stack

Everything is Cloudflare. Workers, D1 (SQLite), KV, R2. No containers, no VMs, no Kubernetes. **131 tables in one D1 database** (`479dfff2-cd26-49b0-ae54-84d4a41b99aa`).

**27 workers deployed.** The live ones, by recency:

| Worker | Last modified | Note |
|---|---|---|
| `num-app` | 1 Aug | The consumer surface |
| `num-console` | 31 Jul | Merchant dashboard |
| `num-book` | 31 Jul | Created today |
| `num-ai` | 31 Jul | The concierge |
| `num-payouts` | 31 Jul | Created today |
| `num-agents` · `num-growth` · `num-claim` · `num-scout` · `num-wa` · `num-biz` · `num-auth` · `num-accounts` | Jul | NUM surface |
| `5arz-api` | 15 Jul | **The core. Two weeks stale.** |
| `5arz-mcp` | 15 Jul | **Two weeks stale — see §5** |
| `5arz-relayer` · `5arz-acc` · `5arz-site` · `5arz-sitemap` · `5arz-demand` | May–Jul | |
| `cupidt-api` · `cupidt-seo-files` | Jul | |
| `aeroz-contact-api` · `aeroz-io-redirects` · `aeroz-ai-redirect` | May | |
| `lumirx-coming-soon` · `still-mountain-a48b` | May | **Audit these** |

The deployment velocity is on NUM. The 5arz core has not moved in two weeks, and that is where the identity, credential and payout work lands.

---

## 3. The money, as the ledger sees it

| | |
|---|---|
| Members | **141** — 102 verified, 34 pending, 5 merged |
| Verified by Stripe Identity | **95 of 102.** One vendor is 93% of the identity graph. |
| Verified with no reference at all | **7** — cause unknown, one is a QA account |
| Stars outstanding | **8,843 across 69 holders = $8,843 of liability** |
| Cash-outs, ever | **0** |
| Payout methods on file | **11 — every one USDC on Base** |
| Stripe Connect accounts | **0.** All 141 sit at `not_started`. |
| Agent accounts | 79, with 41 credit balances and an **empty** credit ledger |
| Business credits · P2P balances | 0 rows each |
| Partner Stars | 8 rows — a third, separate Star economy |

### Where the Stars came from

| Kind | Entries | Net |
|---|---|---|
| `chest_overflow` | 4,748 | **+20,846** |
| `reconciliation` | 9 | +5,807 |
| `task_completion` | 6,809 | **+2,327** |
| everything else | 172 | +2,812 |
| `correction` | 39 | **−23,233** |

The story is "earn Stars by doing tasks." The ledger says the supply is dominated by a chest mechanic and a large correction. Both can be true; they need to be reconciled before anyone repeats the story externally.

### The two numbers that should keep you up

**Eleven people set up a crypto wallet in one click. Zero completed Stripe Connect.** That has been the most consistent signal in the whole system and it should shape every payout decision.

**Nobody has ever been paid.** Every rail is configured; none is proven. `payout_rail_verified` flips only after a real payout clears, and it never has.

---

## 4. Keys, and the architecture we just committed to

### Today

Three rows in `attestation_keys`:

```
hmac-v0                symmetric, shared secret        ACTIVE  ← must die
es256:5arz-oracle-1    ES256, "kid=5arz-oracle-1"      ACTIVE  ← not published
ed25519:5arz-webbot-1  Ed25519, Web Bot Auth           ACTIVE  ← ship-dark
```

Live JWKS publishes **one** key: `5arz-oracle-2`. No private key material is in D1 — that part is right. Everything else about this is wrong.

There is no root/leaf separation, no rotation procedure, no overlap window, no revocation list, and no registry that matches reality.

### The decision

**Node model: network attestation nodes.** Third parties run signing and verification nodes and earn fees for work performed.

**Key custody: nodes sign, 5arz certifies.** Each node holds its own keypair. 5arz runs a registry, certifies node keys against a 5arz root, and can revoke. Verifiers walk the chain: credential → node key → registry → 5arz root.

That is a real delegation model and it is the more expensive of the options. What it requires:

**A three-tier key hierarchy we do not have.**

```
5arz root key        offline, HSM or equivalent, signs nothing but node certs
  ├── oracle key     online, signs 5arz's own credentials
  └── node keys      held by operators, never leave the node, sign node attestations
```

**A public node registry**, signed by the root, listing every certified node key with its status, certification date, and expiry. This is the thing an external verifier fetches. It must be cacheable, versioned, and it must not require asking us for permission.

**A revocation list.** The moment nodes hold keys, revocation stops being theoretical. Short-lived node certificates — 30 to 90 days, auto-renewed while the node is in good standing — are usually less painful than a CRL that every verifier must poll. Pick one deliberately.

**Rotation with overlap.** Publish the new key, wait one full credential lifetime, then retire the old one. The oracle-1 → oracle-2 rotation is exactly what happens without this.

**Kill `hmac-v0` first.** In a network where third parties verify, a symmetric key means every verifier can forge. There is no version of the node plan that survives it.

**Verifier logic that is public and boring.** The offline verifier in the AiR pack is the reference and it already has the corrected issuer allowlist and `exp` handling. Extend it to walk the node chain, publish it, and let anyone check us without our cooperation. `workers/proof-chain.js` already takes this posture — appending needs a token, verifying needs nothing. Keep that.

### The thing to raise before a single node is sold

Selling attestation nodes to third parties who expect to earn fees is a structure regulators have looked at closely, and node and licence sales with promised returns have drawn enforcement. The distinction that matters is whether the buyer performs meaningful work or is passive. A node that genuinely runs infrastructure and earns for verified work is a different animal from a node that is a receipt for a revenue share — but the line is fact-specific, and it is drawn by counsel, not by us.

**This is a legal workstream that runs in parallel with the engineering, not after it.** Design so the answer can be either — meaning node operators do real, measurable, slashable work — and get an opinion before anything is offered for sale.

---

## 5. Known defects, in priority order

| # | Defect | Where |
|---|---|---|
| 1 | Balance drift, 21 of 80 members | `stars_ledger` vs `member_finance` |
| 2 | JWKS/registry mismatch; no rotation procedure | `attestation_keys` vs live JWKS |
| 3 | `hmac-v0` symmetric key still active | `attestation_keys` |
| 4 | **Webhook signatures unverified** — `TODO` in both the payout router and the card authorizer | `payout-router.js`, `card-authorization.js` |
| 5 | `agent_credits` has 41 balances and an empty ledger | balances no transaction created |
| 6 | Three inconsistent MCP tool lists — live `tools/list`, the well-known manifest, and the standalone worker all disagree | `5arz-mcp`, stale since 15 Jul |
| 7 | Data quality: 7 members `country='other'` holding 2,389 Stars; one 'UK' instead of 'GB'; 3 null | `members` |
| 8 | Two members share wallet `0x1859…1759` | live sybil signal |
| 9 | `public_stats_cache` never computed — all zeros, `last_computed_at = 0` | |
| 10 | Unaudited workers: `lumirx-coming-soon`, `still-mountain-a48b` | |

Defect 4 is the one I would fix this week regardless of everything else. **An unauthenticated endpoint that can mark a payout paid is a way to make money disappear quietly.**

---

## 6. What is built and waiting

Written and tested this month, not yet deployed. 128 passing assertions across three suites.

| Area | Migrations | Workers |
|---|---|---|
| Errands / P2P | `0037` | `errands-api.js`, `proof-capture.js` |
| Payout rails | `0038` | `payout-router.js` |
| Cards | `0039` | `card-authorization.js` |
| Payment integrity | `0040` | `integrity.js`, `liveness-stepup.js` |
| Verification ladder | `0041` | `verification-router.js` |
| Proof chain | `0042` | `proof-chain.js` |
| Edinburgh policy | `0043`, `0045` | `errand-policy.js` |
| Liveness | `0044` | `liveness.js`, `liveness-client.js` |
| AiR integration | — | `5arz-mcp-v2.js`, `num-mcp.js`, `5arz-a2a.js`, `delegation-endpoint.js` |

Two things in there worth knowing about specifically.

**The perceptual-hash index was wrong and is now right.** The original 4-band design had measured recall of 0.45 — it would have missed 55% of duplicate errand photos. Pigeonhole principle: with B bands you can only guarantee finding pairs differing by ≤ B−1 bits. Rebuilt as 8 bands × 8 bits at threshold 7: **recall 1.00, 0 false positives in 50,000 pairs.** If anyone reimplements this, both details are load bearing.

**The Merkle tree follows RFC 6962 deliberately.** Domain-separated leaves and nodes, and odd nodes promoted rather than duplicated — the common duplicate-the-last-node trick admits a second-preimage forgery. Tested at every size from 1 to 33.

---

## 7. Build order

**Track A — Ledger truth. Blocks everything. ~3 days.**
Freeze balance writes outside `stars_ledger`. Rebuild the caches from it. Run `0040`, turn on INV-1 on a five-minute cron, page on breach. Reconcile the 21 drifting members by hand and record why each drifted — a drift you cannot explain is a bug you have not found. Write the missing `agent_credit_ledger`. Decide the debt model. **Done when INV-1 has been green for 24 hours.**

**Track A′ — Key hygiene. Runs alongside A. ~3 days.**
Reconcile `attestation_keys` with the live JWKS. Write the rotation procedure with an overlap window. Retire `hmac-v0`. Stand up the root/oracle split. This is the prerequisite for the entire node plan and it is cheap now because no credentials exist.

**Track B — Cash-out. ~2 weeks.**
Verify the webhook signatures first. Wire the outbox. Contact dLocal for PromptPay. One real payout to one real person, reconciled, then flip `payout_rail_verified` — not before.

**Track C — Verification. ~1 week.**
Wire Play Integrity and App Attest first: challenge-response alone scores 55 against a 70 bar, and attestation is the free 15 that closes it. Ship the capture module. Point signup at 5arz liveness. Add Didit's free 500/month. Backfill the 102 existing verifications.

**Track D — Proof chain. ~1 week.** Money actions, then identity, then the daily anchor and audit crons.

**Track E — Nodes. ~4 weeks, gated on A′ and counsel.** Registry, certification, revocation, the public verifier, and the operator onboarding. Do not start the commercial side until the legal opinion lands.

**Track F — NUM and Edinburgh. ~3 weeks.** Blocked on A and B. An errand product that cannot pay a runner is a demo.

**Track G — Cards. Ongoing, mostly waiting.** Stripe Issuing application is the longest lead time and nothing waits on it.

---

## 8. Standing rules — do not break these

- **`stars_ledger` is the truth.** Every other balance is a cache and may be wrong. Literally true today.
- **Never sell Stars.** The moment they can be bought with cash, we hold customer funds. This is the bright line the whole licensing posture rests on.
- **Money never rests with us.** Provider → recipient. Our account is never a waypoint. You cannot lose money you never held.
- **No private key material in D1.** Currently honoured. Keep it.
- **Cash-out is not live** in any copy until it is. Approved line: *"Every Star = $1. Always. Cash-out is coming soon."*
- **No fabricated contacts.** Zero verified emails in the pipeline; do not pattern-guess addresses.
- **Lumi is never public.**
- **Cupidt is not named** in 5arz materials until Phase 2.
- **No AI-generated imagery.** Stated policy.
- **Every webhook verifies a signature.** No "assume valid" branch, ever.

---

## 9. Open decisions — only Viv can answer these

1. **ARZ** — company shorthand, or a token? It does not exist in the schema. If it is a token, it reverses the published anti-coin position, kills the Worldcoin differentiator, and crosses the never-sell-Stars line. That is a company-level decision, not a schema change.
2. **The debt model** — live product or delete? It may be the same feature as cash-out.
3. **The chest** — `payable_stars`, `chest_stars`, `milestone_chest_stars` are either one thing with a status or three things needing three names.
4. **`partner_star_ledger`** — fold into Stars or keep separate? Eight rows is the cheapest this decision will ever be.

---

## 10. Where everything lives

Project docs are in the claude.ai project **5arz** — the money map, payout rails, payment integrity, verification options, liveness, proof chain, Scotland, the AiR pack, and the brand playbook with the binding claims register. The code and migrations are in `5arz-verification-pack.zip` alongside the earlier packs. Ground truth on the API surface and all 131 tables is in `api_surface.md` and `ledger_schema.md`.

Run the tests before touching anything:

```bash
node --experimental-sqlite test/run-tests.mjs       # 49
node --experimental-sqlite test/liveness-tests.mjs  # 61
node test/check-html.mjs                            # 9
node test/check-board.mjs                           # 8
```

---

## 11. If you only do three things this week

1. **Freeze balance writes and reconcile the ledger.** Nothing else is safe until one number describes what a member has.
2. **Verify the webhook signatures.** Two `TODO`s that can move money.
3. **Fix the key registry and kill the HMAC.** It costs almost nothing today and it is the foundation of everything in the node plan.

Everything else can wait a week. None of those three can.

---

*Compiled 31 July 2026 from production D1 (read-only), the live JWKS, the Cloudflare Workers list, and the project docs. Every number here was queried, not remembered. Nothing in this document is legal or financial advice — the node structure, biometric collection, platform reporting and employment status all need counsel.*
