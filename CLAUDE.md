# CLAUDE.md — this folder is NOT the live product

**The branch checked out here is named `main` but tracks
`refs/heads/backend-fastapi`.** It is the Python/FastAPI lineage — Railway plus
Supabase — which has never served a guest. It shares **no ancestry** with the
real `origin/main`.

Verify before believing the name:

```bash
git config --get branch.main.merge      # → refs/heads/backend-fastapi
```

`git push origin main` from here asks to replace the entire Worker codebase
with the Python backend. It was attempted twice on 2026-08-04 and only
non-fast-forward rejection prevented it. A `--force` would have destroyed ~89
commits. **Never force-push from this folder.**

Consider renaming it so the name stops lying:

```bash
git branch -m main backend-fastapi && git branch -u origin/backend-fastapi backend-fastapi
```

## Where the live product lives

`~/num-worktrees/app-main` — Cloudflare Workers + D1, serving `app.itsnum.com`
and `itsnum.com`. Its `AGENTS.md` and `CLAUDE.md` are the operative rules for
anything that ships.

## For agents

- **Git is read-only from the Cowork sandbox here.** Writes leave `index.lock` /
  `HEAD.lock` files the sandbox cannot delete, blocking every later command.
  Write files, hand the user the commit.
- This folder is mostly docs, brand assets (`brand/`), ad production (`ads/`),
  and ops runbooks (`ops/`) — treat those as the primary content.

Full operational detail: the `num-ops` skill in `skills/num-ops/`.
