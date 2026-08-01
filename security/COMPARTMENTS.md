# Cryptographic compartments

The design goal, stated plainly: **a stolen credential should open one room,
not the building — and it should stop working on its own.**

That is achievable. What is *not* achievable, and is worth saying before the
design rather than after an incident, is a lock that is impossible to open.

---

## Two corrections to the brief

**1. "Impossible to hack" is not a design target, because it is not reachable.**
Every system with a door has a way through it. The properties that are actually
reachable, and that this design delivers, are:

- **Blast radius** — one compromised credential exposes one compartment
- **Time limit** — a stolen credential expires whether or not we notice
- **Revocability** — we can kill one member, one compartment, or everything,
  without destroying accounts
- **Detection** — a forgery attempt is a distinguishable event we can alarm on

Chasing impossibility produces worse security than chasing those four, because
it spends effort on the wrong thing. Note that today NUM has none of the four
(see SEC-001), so the gap is large and the fix is standard work, not exotic work.

**2. An "ever-changing, self-evolving cipher" would make us weaker, not stronger.**
This is the one place I want to be direct, because the intuition is common and
it is backwards. A cipher that mutates its own algorithm is a cipher nobody has
analysed — including us. Cryptographic strength comes from an algorithm being
public and having survived years of expert attack; secrecy of the algorithm is
the thing that has failed every single time it has been tried. Rolling our own
mutating scheme would replace AES/HMAC — analysed since the 1990s — with
something whose weaknesses are simply unknown to us until someone finds them.

**What we take from the idea is the part that is real: rotation.** Keep the
algorithm boring, standard and public (HMAC-SHA256, HKDF). Rotate the *keys*
automatically and continuously. That gives the genuine benefit — a stolen key
has a short useful life, and an attacker cannot bank credentials for later —
without giving up the analysis that makes the primitive trustworthy. The lock
changes every 30 days on its own. The lock's *design* stays the one that
everybody has already tried and failed to pick.

---

## The design

### Compartments

Five, chosen so that the boundaries fall where consequence changes:

| Compartment | Covers | Consequence of compromise |
|---|---|---|
| `identity` | profile read/write, member record | PII |
| `social` | friends, plans, invites, events | Social graph |
| `money` | tabs, settlement, ledger, Stripe | Direct financial loss |
| `travel` | Sabre booking, DoorDash dispatch | Real purchases on our credentials |
| `admin` | every `/admin/*` surface | Total |

A token minted for `social` **cannot verify** against `money`. Not by policy
check — by mathematics. It is signed with a key that the `money` verifier does
not derive and has never held.

### Key derivation

One root secret, never used to sign anything directly:

```
NUM_ROOT_KEY            Worker secret. 32 bytes from a CSPRNG. Never leaves CF.
  │
  └─ HKDF-SHA256(root, salt = epoch, info = "num.v1." + compartment)
       │
       ├─ K_identity[epoch]
       ├─ K_social[epoch]
       ├─ K_money[epoch]
       ├─ K_travel[epoch]
       └─ K_admin[epoch]
```

Two independent properties fall out of this:

- **Compartment isolation.** HKDF is a one-way function. Holding `K_social`
  gives no information about `K_money` or about the root. An attacker who
  extracts a derived key from a log, a crash dump or a misconfigured endpoint
  gets exactly one compartment.
- **Automatic rotation.** `epoch = floor(now / 30 days)`. Every key is a pure
  function of the root and the current epoch, so all five rotate on their own,
  on schedule, with no key distribution, no deploy, and no operator action.
  This is the "lock that keeps changing" — and it is one line of arithmetic
  rather than a novel cipher.

Verification accepts the current epoch and the previous one. Without that grace
window, every member is logged out at midnight on rotation day.

### Token shape

```
v1.<compartment>.<epoch>.<payload>.<sig>

payload = base64url({ sub, scope[], exp, jti })
sig     = HMAC-SHA256(K_compartment[epoch], "v1.<compartment>.<epoch>.<payload>")
```

- `sub` — member ID. Now an *identifier*, not a credential.
- `scope` — actions within the compartment (`tab:settle`, `plan:write`)
- `exp` — 24h for member tokens, 15m for `money` and `travel`, 1h for `admin`
- `jti` — unique ID, so a single token can be revoked without a mass rotation

The compartment and epoch are outside the signature's payload but inside the
signed string, so neither can be swapped without invalidating the signature.

### Revocation, at three widths

| Need | Action | Effect |
|---|---|---|
| One leaked token | Add `jti` to the KV denylist until `exp` | That token only |
| One compromised member | Bump their `token_epoch` column | All their tokens |
| Compartment breach | Bump the compartment's salt constant | Everyone, that compartment |
| Root compromise | Rotate `NUM_ROOT_KEY` | Everything, instantly |

Today none of these are possible — the credential is the primary key, so
revoking it means deleting the account.

### What this does *not* fix

Worth being explicit, so the compartments are not mistaken for total coverage:

- A token stolen from a live device works until it expires. Compartments limit
  *which* rooms and *how long*; they do not stop theft.
- Prompt injection (SEC-005) is only mitigated because `money` and `travel`
  tokens must originate from a human confirmation. If a future code path mints
  one from model output, the compartment boundary is bypassed legitimately and
  the crypto never notices. That rule is enforced by review, not by math — it
  is the weakest link in this design and should be treated as such.
- Cloudflare itself remains fully trusted. Root key, D1 and Workers all sit
  inside one vendor boundary.

---

## Migration — no flag day

Members cannot be logged out en masse, so:

1. **Ship dual-accept.** `worker/capability.mjs` is live; endpoints accept a
   valid token *or* the legacy `?me=` parameter. Every legacy use increments a
   counter. Zero behaviour change.
2. **Mint on the client.** The app requests a token at startup and sends it.
   Legacy counter starts falling.
3. **Watch it reach zero.** The Perimeter agent reports the legacy rate daily.
4. **Close money and travel first.** Highest consequence, smallest traffic.
5. **Close the rest.** `?me=` stops being accepted; it becomes a forgery signal
   and alarms.

Step 1 is safe to deploy today — it cannot break a live session, because
nothing rejects anything yet. Steps 4 and 5 are the ones that need a decision,
because they can lock out a stale client.
