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

## Before you edit: claim the tree

**Another session may be editing these files right now.** On 3 Sep 2026 two
Cowork sessions edited this worktree between 19:47 and 20:25 without either
knowing. Both sets of work survived by luck — each session reads a file, holds
it in context, and writes it back, so whichever writes last silently erases the
other's edits to that file. There is no conflict to see. The tests still pass.
The work is simply gone.

A git branch does not fix this: two sessions on the same working tree share one
set of files whatever branch is checked out. Branches protect history, not the
tree.

```bash
cd ~/num-worktrees/app-main            # these paths are relative to the worktree
node scripts/claim.mjs status                                   # who holds what
node scripts/claim.mjs take edit "what you are doing" --who ME  # before editing
node scripts/claim.mjs renew edit --who ME                      # every ~15 min
node scripts/claim.mjs release edit --who ME                    # when done
```

`npm run claim -- status` does the same from any subdirectory of the worktree —
npm runs a script from the package root whatever folder you are standing in.
From a *different* repo you get a bare `MODULE_NOT_FOUND` stack, which is Node
failing before the script exists to say anything more useful; the fix is the
`cd`.

A claim goes stale after 20 minutes without a renew, so a crashed session never
blocks the tree. `--force` breaks a claim you know is dead.

**Deploys take their own claim, and it refuses while somebody is editing** — a
deploy started mid-edit ships whatever is half-written on disk:

```bash
node scripts/claim.mjs take deploy "ship 0.8.233" --who ME
```

This is advisory: nothing stops a session that does not check. That is still
most of the fix, because the failure above was not two people ignoring each
other — it was two people with no way to find out.

## Non-negotiables

- **Two lineages, no common ancestor.** `origin/main` is the Worker codebase;
  `origin/backend-fastapi` is Python/FastAPI. Never merge or force-push across
  them — it deletes a codebase.
- **Branch names lied here until 2026-08-05.** `~/Documents/Claude/Projects/NUM`
  had a branch called `main` that tracked `backend-fastapi`; it is now correctly
  named `backend-fastapi`, and this worktree is on the real `main`. The habit
  outlives the fix: verify tracking, never trust a name. Three pushes were
  rejected on 04–05 Aug and every rejection was correct.
- **Agents: git is read-only from the Cowork sandbox.** Writes leave lock files
  the sandbox cannot delete, and each retry blocks the next command. Write
  files, run tests, hand the user a commit command. Pushing needs the user —
  there are no SSH credentials here.
- **Deploy via `npm run release:stage` → `release:ship`**, never raw
  `wrangler deploy`. `num-console` is the exception: bare `npx wrangler deploy`.
- **Verify after shipping** — `curl -s https://app.itsnum.com/api/version`. A
  successful deploy and a working product are different claims.

Full detail: the `num-ops` skill (`skills/num-ops/` in the NUM project folder).
