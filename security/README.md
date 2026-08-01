# NUM security

Three agents, one threat model, one cryptographic primitive.

## Read first

- [`THREAT_MODEL.md`](THREAT_MODEL.md) — what we protect and what is currently
  broken. **SEC-001 is critical and unfixed: member endpoints have no
  authentication.**
- [`COMPARTMENTS.md`](COMPARTMENTS.md) — the capability-token design, and why
  "impossible to hack" and "self-mutating cipher" are the wrong targets.

## The team

| Agent | Question it answers | Cadence |
|---|---|---|
| `redteam` | How would someone break in from here? | Before any auth/money/booking deploy |
| `threat-intel` | What new technique now works against a stack like ours? | Weekly |
| `perimeter` | What exists, what changed, did it widen the surface? | Daily, and around every deploy |

Run one:

```bash
claude "use the redteam agent to audit worker/social.mjs and worker/pay.mjs"
```

All three are **read-only against production**. None of them deploy, execute
attacks against live hosts, read secret files, or commit. Those limits are
written into each agent definition, not just assumed — the boundaries are the
part that makes it safe to run them often.

They write to `findings/`, `intel/` and `inventory/` respectively, one file per
run.

## The gate

[`../worker/capability.mjs`](../worker/capability.mjs) — compartmented
capability tokens. One root secret, five compartment keys derived with HKDF,
rotating every 30 days on their own. A `social` token cannot verify against
`money`, because the money verifier derives a different key and has never held
the social one.

```bash
node worker/capability.test.mjs   # 24 tests, including cross-compartment rejection
```

Not yet wired into any endpoint — see the migration in `COMPARTMENTS.md`.
Nothing imports it, so it is inert until deliberately adopted.

## Setup before adoption

```bash
openssl rand -base64 32 | npx wrangler secret put NUM_ROOT_KEY --config wrangler.app.jsonc
```

Losing this secret invalidates every token at once — every member is logged
out. It cannot be recovered from anywhere; it exists only inside Cloudflare.
Rotating it deliberately is the "break glass" control.

## Order of work

1. **SEC-001** — nothing else matters while any friend can impersonate any
   member. Dual-accept ships without breaking a live session.
2. **SEC-002** — one `ADMIN_KEY` opens booking, earnings, mail and push.
3. **SEC-005** — prompt injection reaching tools that spend money.
4. **SEC-003**, **SEC-004** — plaintext keys on disk; unalarmed fail-open rate
   limiter.
