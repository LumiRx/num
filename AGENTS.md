# AGENTS.md — rules for every AI session working on NUM

Two Macs (Dre's, Viv's) run AI sessions against this repo, often at the same
time. These rules exist because each of the following has already happened once:

- a session **overwrote live dashboard edits** with `wrangler deploy` (07-30)
- deploys from an unmerged branch **removed member DMs from production** (07-30 → 08-01)
- two sessions **solved the same bug in parallel** (`guessed` vs `unsupported`) and had to be merged by hand
- one session **swept another's in-flight files** into a commit (`00069b9`)
- an untracked handoff about a live incident existed **on one machine only**
- uncommitted work died with a **worktree in `/tmp`**

Every rule below maps to one of those. Read this before touching anything.

## 1. Git is the only source of truth

- **Never edit in the Cloudflare dashboard.** Dashboard edits are invisible to
  review and deleted by the next deploy. If you find drift (`wrangler deploy`
  warns "last updated via the script API"), STOP and commit the live state to a
  branch first — that's what `00069b9` did, and it saved the DM feature.
- **Never force-push.** `main` (the app + `ai/` Worker) and `backend-fastapi`
  (FastAPI/Railway) share this remote but have **no common ancestor**. A
  force-push across them deletes a codebase.
- **Commit before you stop working — every time.** A session's context dies
  with it; only commits survive. Uncommitted = does not exist.
- **Never `git stash` on a shared checkout**, and never sweep files you didn't
  change into your commit. `git status` + `git log` before assuming anything.

## 2. Branch per session, merge to main

- Work on a branch: `fix/…`, `feat/…`, `ops/…`. Push it early and often.
- Merge to `main` only with tests green, and **pull/merge `origin/main` first**
  — it moves under you (three sessions advanced it on 08-01 alone).
- If your change is deployed, it must be on `main` (merged) and **tagged**
  (`num-ai/YYYY-MM-DD`). Live-but-unmerged is how DMs vanished.
- Worktrees go in `~/num-worktrees/`, **never `/tmp`** — macOS cleans it.

## 3. Nothing goes straight to 100% of traffic

- **num-app**: `npm run release:stage` → preview → `release:ship 10` →
  `release:ship`. Never raw `wrangler deploy`.
- **num-ai**: `ai/release.sh stage "msg"` → preview → `ship 10` → `ship`.
  Same contract; it refuses dirty trees and failing tests.
- Roll back with the matching `rollback` command, not by re-deploying old code.

## 4. Tests gate deploys

- `ai/`: `node --test ai/*.test.mjs` (15) · sw: `node --test sw.test.mjs` (22)
  · capability: `node --test capability.test.mjs` (24)
- If you fix a production bug, add the failing input verbatim as a test before
  you ship. Both location bugs are pinned this way in `ai/places.test.mjs`.

## 5. Things every session must know (state, not style)

- **RESOLVED 08-01 ~17:05 UTC — the num-db write block is over.** Root cause of
  the two-day outage: the account was on the **Free plan** (500 MB D1 cap);
  Dre upgraded to Workers Paid (10 GB cap) and writes resumed within a minute
  (verified: signup 200, D1 DELETE ok). This answers open question #3 in
  `HANDOFF-duke-2026-08-01.md`. Still true: the Overture ingest stays paused
  (growth resumes otherwise), and the `num-core` split remains the right
  architecture — now as planned work through the staged release flow, not an
  emergency. Old handoffs describing failing writes are historical.
- Location handling has **three states** — `unsupported` (guest named an
  uncovered city: honest decline, never re-ask), `guessed` (no idea: ask, never
  assert), known (assert only if the guest was the source). Keep all three.
- `top_places` rows are **not quality-ranked** — never render "top rated"/"best".
- Secrets never enter chat, commits, or shell history. `read -rs` prompts or
  the platform's secret store (`wrangler secret put`, Railway variables) only.
- The published place-count (567,793) is known-wrong (real: ~2.53M) — don't
  propagate it into new copy; regenerate from live D1 when fixing.
- **`docs/cto-handoff-duke.md` §8 is binding on every session.** The ones that
  bite day-to-day: every webhook verifies a signature (no assume-valid branch,
  ever); `stars_ledger` is the truth and every other balance is a cache; never
  sell Stars; money never rests with us; Lumi is never public; Cupidt is not
  named in 5arz materials; no AI-generated imagery; cash-out is not live in any
  copy until it is.

## 6. Handoffs

- End of any session that changed state: write/update a handoff in `docs/`,
  **commit it**. An uncommitted handoff on one machine helps nobody.
- Correcting another session's work is normal; deleting its record is not.
  Retract in writing (see the sharding retraction in `HANDOFF-duke-2026-08-01`)
  so ideas don't resurface in a third session.

## 7. Deploy inventory (so you don't guess)

| What | Where | Deploy | Data |
|---|---|---|---|
| num-app (PWA + API) | app.itsnum.com / itsnum.com | `npm run release:*` | num-db (D1) |
| num-ai (LINE concierge) | num-ai.thatislumi.workers.dev | `ai/release.sh` | num-db (D1) |
| num-console | — | — | — |
| FastAPI (SMS/WhatsApp, dormant) | Railway `num` | `railway up` from `backend-fastapi` | Supabase (unreachable acct) |

Cloudflare account: thatislumi@gmail.com · Railway: info@thatislumi.com.

## Every app command needs `--config wrangler.app.jsonc`

A bare `wrangler …` in this repo uses `wrangler.jsonc`, which is **num-console**,
not the app. Dre nearly deployed a console version to production because
`wrangler versions deploy` with no flag listed the console's history and looked
plausible. The versions were dated hours earlier than anything we had shipped —
that mismatch is the tell.

```bash
npx wrangler versions secret put NAME --config wrangler.app.jsonc   # app
npx wrangler d1 execute num-db --remote --config wrangler.app.jsonc # app's DB
npx wrangler deploy --config wrangler.jsonc                         # console (deliberate)
```

Secrets accumulate across versions, so `versions secret put` twice then deploying
the LATEST version carries both. Deploy with an explicit id and `@100%`:

```bash
npx wrangler versions deploy <id>@100% -y --config wrangler.app.jsonc
```

## Health monitoring (0.8.107+)

`/api/health` deep-checks the failures that return 200 anyway: D1 writes, the
brain key, a pay rail that can charge but not deliver, an SMS webhook that would
reject everything. Returns 503 when genuinely broken — point uptime checks there.
A 5-minute cron (`triggers.crons` in wrangler.app.jsonc) runs the same checks and
alerts on a CHANGE of state only, via `ALERT_SMS_TO` and/or `ALERT_WEBHOOK`.
History: `/api/health/history`.

**Known scale fact:** `places` holds ~2.53M rows against ~77 members — the
directory IS the 1.24 GB database. That is ~$1/month, so this is not a cost
problem; it is the cliff that caused the 2-day read-only outage. Keep the
Overture ingest paused. Splitting the directory into `num-core` remains the
right fix and is about resilience, not the bill.
