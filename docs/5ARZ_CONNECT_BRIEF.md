# 5arz connection — brief for the session executing it (written by Dre's session, 2026-08-01)

You're on Viv's/Rick's machine doing the 5arz connection. Dre's session is live
on the other Mac. **Read AGENTS.md first.** This brief exists so we don't
collide and so the gates that make 5arz worth connecting don't get skipped
under launch pressure.

## Coordination — hard rules for tonight
- Work on a branch (`feat/5arz-connect`), never directly on main.
- **Pull main first**: it moved 8+ commits today (0.8.79→0.8.86 shipped).
- num-app releases ONLY via `npm run release:stage` → preview → `ship`.
  Dre's session may also ship tonight — announce in a commit before you stage,
  check `git log origin/main` before you ship.
- The deployable pack (verification ladder 0041, liveness 0044, proof chain
  0042, `verification-router.js`, `liveness.mjs`) is on YOUR machine
  (5arz-verification-pack.zip + claude.ai 5arz project) — it is NOT in this
  repo. Commit whatever you deploy INTO the repo; deployed-but-uncommitted is
  how member DMs got deleted once already.

## Gates before the connector goes live (from cto-handoff-duke.md — binding)
1. **Key registry must match the live JWKS.** `attestation_keys` says
   oracle-1; `api.5arz.com/.well-known/jwks.json` publishes oracle-2 only.
   Fix the registry + write the rotation-with-overlap procedure.
2. **`hmac-v0` dies first.** A symmetric key means every verifier can forge.
   No version of "5arz connected" survives it. It is cheap TODAY because every
   credential table is empty.
3. Root/oracle split stood up (offline root signs nothing but certs).
Only then wire the app: signup → 5arz liveness, verification ladder scoring
(attestation is the free 15 points that clears the 70 bar), proof chain on
money actions. §Track C order in the CTO handoff.

## What the app side already has waiting (this repo, main)
- `worker/capability.mjs` — HKDF per-compartment tokens, 24 tests, imported by
  NOTHING. If you're touching auth anyway, SEC-001 step 1 (dual-accept) is
  deploy-safe and closes the member-id-as-credential hole.
- Members: 141 (102 verified, 95 via Stripe Identity). Backfill plan in Track C.
- Writes work again (Free-plan cap fixed 08-01). Ingest stays paused.

## What NOT to do
- Don't deploy payout/cards code — Track B is gated on ledger truth + webhook
  signatures (defect #4). `payments:"none"` stays until one real payout clears.
- Don't touch `ai/` or plan/invite code — Dre's session shipped there today.
- Don't edit in the Cloudflare dashboard. Ever.

Questions → leave a dated note in docs/, commit it. That's our channel.

## Two tiers, two gates — NUM launches without waiting for you
Decided by Dre 08-01: NUM users enter through NUM's OWN gate — phone OTP
(worker/social.mjs signUp/verifyCode + claim/verify.mjs, complete and tested,
lights up when TWILIO_SID/TWILIO_TOKEN/TWILIO_FROM secrets exist on num-app).
That gate opens NOW. 5arz verification (liveness, attestation, proof chain) is
an ADDITIVE second tier behind your key gates — build the connector so it
UPGRADES a NUM account (phone_verified=1 -> 5arz-verified), never replaces or
blocks the phone tier. A NUM user who never touches 5arz keeps working forever.
