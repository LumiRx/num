# CLAUDE.md — read before touching anything

This file exists because `AGENTS.md` is **not** auto-loaded in Cowork sessions.
On 2026-08-04 a session spent an hour walking toward a push that would have
destroyed ~89 commits, and the rule forbidding it was sitting unread in
`AGENTS.md` the whole time. Knowledge that isn't loaded isn't knowledge.

**Read `AGENTS.md` in this directory now.** It is the canonical convention file
(deploy discipline, branch policy, the binding §8 rules from the CTO handoff).

## The three checks that cost one command each

Run these before any push, reset, rebase, or merge. Each maps to a real incident.

```bash
git config --get branch.$(git branch --show-current).merge   # names lie here
git fetch origin && git rev-list --left-right --count origin/main...HEAD
git merge-base --is-ancestor HEAD origin/main && echo same-lineage || echo DIFFERENT-LINEAGE
```

Or run all of them at once: `bash scripts/preflight.sh`

## Non-negotiables

- **Two lineages, no common ancestor.** `origin/main` is the Worker codebase;
  `origin/backend-fastapi` is Python/FastAPI. Never merge or force-push across
  them — it deletes a codebase.
- **The branch named `main` in `~/Documents/Claude/Projects/NUM` tracks
  `backend-fastapi`.** Verify tracking; never trust the name.
- **Agents: git is read-only from the Cowork sandbox.** Writes leave lock files
  the sandbox cannot delete, and each retry blocks the next command. Write
  files, run tests, hand the user a commit command. Pushing needs the user —
  there are no SSH credentials here.
- **Deploy via `npm run release:stage` → `release:ship`**, never raw
  `wrangler deploy`. `num-console` is the exception: bare `npx wrangler deploy`.
- **Verify after shipping** — `curl -s https://app.itsnum.com/api/version`. A
  successful deploy and a working product are different claims.

Full detail: the `num-ops` skill (`skills/num-ops/` in the NUM project folder).
