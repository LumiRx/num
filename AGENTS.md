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

- **`num-db` is over the D1 size cap — ALL writes fail, silently in `ai/`.**
  Guest memory, signups, invites: nothing persists until the `num-core` import
  runs. Do not chase "NUM doesn't remember" as a prompt bug, and do not
  re-verify write endpoints expecting success. See `docs/handoff-duke.md`.
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
