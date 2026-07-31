# Turning on USDC on Base

The desk is built and every check runs. What is missing is a way to *send*, and
that is one decision plus one set of credentials.

## The decision: who holds the key

This is the only real choice, and it is a security decision, not a technical one.

| | What it means | Verdict |
|---|---|---|
| **Custody API** (Circle, Coinbase CDP, Privy, Turnkey) | You call an HTTPS endpoint; the provider holds the key in an HSM and signs. Our Worker never sees a private key. | **Recommended.** Requires a business account and KYB, which takes days, not minutes. |
| **Self-custody hot wallet** | A private key sits in a Worker secret. Fastest to build, and any leak — a log line, a compromised token, a mistaken `console.log` — drains the treasury with no recourse. | Only with a **small float** you can afford to lose, topped up per batch. Never the main treasury. |

My recommendation: **Coinbase CDP Server Wallets** or **Circle**, because they are
HTTP calls and remove key handling from our code entirely. If you want to move
money this week and the KYB will not land in time, run self-custody with a float
of a few hundred dollars and top it up per batch — the exposure is then bounded
by what is in the wallet, not by the whole balance sheet.

## What you need either way

| | |
|---|---|
| **A treasury wallet on Base** | Funded with USDC **and a little ETH for gas** — Base gas is fractions of a cent, but zero ETH means zero payouts. |
| **An RPC endpoint** | `https://mainnet.base.org` works and is what the checks use today. For production volume use Alchemy, QuickNode or Coinbase's own node. |
| **`USDC_TREASURY_ADDRESS`** | The wallet the money leaves from, so `/treasury` can check the balance covers a batch before anything is approved. |

Then, per route:

```bash
cd payouts

# Either — a custody provider (recommended)
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET
# or Circle
npx wrangler secret put CIRCLE_API_KEY

# Or — self-custody, bounded float only
npx wrangler secret put USDC_SIGNER_KEY

# Both paths
npx wrangler secret put USDC_RPC_URL
npx wrangler secret put USDC_TREASURY_ADDRESS
```

`rails.mjs` gates on these. Until they exist `/execute` refuses with *"not
connected, nothing was sent"* rather than marking anything paid.

## What already works, verified against live Base

`node scripts/chain-check.mjs` — read-only, no credentials.

- **keccak-256** checked against the standard vectors.
- **EIP-55 checksums** — a correctly checksummed address passes; the same
  address with one character flipped is rejected. This is the protection that
  catches a mistyped paste before the money goes to a stranger.
- **Amount maths** — USDC has **6 decimals, not 18**. $1.00 is `1000000` units.
  Getting this wrong overpays by 10¹² and is the classic way to empty a
  treasury in one transaction. It lives in exactly one function.
- **Contract detection** via `eth_getCode`. This independently caught the burn
  wallet with no hardcoded list — the general rule beats the special case.
- **Unused-address warning** via nonce and balance.

### What the live chain says about the wallets on file

| | |
|---|---|
| Blocked — a contract | 1 (`mem_4l4lp16mjthb`, the USDC contract itself) |
| Held — never transacted on Base | **9 of 11** |
| Clean history | 1 |

Nine untouched addresses is not proof of anything wrong — people do create a
fresh wallet for this. It is a reason to send **one small test payment first**
and confirm receipt before releasing a batch.

## The order to do it in

1. Pick custody vs self-custody. Everything else follows from it.
2. Fund the treasury with USDC **and** ETH on Base.
3. Set the secrets above.
4. `GET /treasury?cents=<batch total>` — confirm the float covers it.
5. **Pay one person a small amount and have them confirm receipt.** Nine of
   eleven addresses have no history; a first batch is not the place to find out
   one is wrong.
6. Release the rest.

Nothing in the desk needs a code change for any of this.
