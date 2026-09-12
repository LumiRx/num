# Recipe: deploy

**Tier 0 — the whole thing, when both workers changed.**

```bash
cd ~/num-worktrees/app-main
node scripts/claim.mjs take deploy "<what changed>" --who dre
npm run release:stage "<what changed>"
npm run release:ship
npx wrangler deploy --config growth/wrangler.jsonc
node scripts/claim.mjs release deploy --who dre
```

**Tier 1 — host or admin work only.** Those routes live on the growth worker,
so `release:stage`/`ship` do not touch them. Only the wrangler line matters.

**Tier 2 — when it fails.**

- *"Nothing to ship for X"* — a stage failed before uploading. Run stage again;
  do not force wrangler past it.
- *`index.lock`: File exists* — a crashed earlier run. Check no git process is
  live, then remove it. An empty lock older than an hour is stale.
- *`EPERM: unlink dist/...`* — a Cowork session, which cannot delete files in a
  connected folder. Dre runs it, or grants delete permission.
- Node is pinned to 22 in `.nvmrc`; `engines` only says >=20, so a newer Node
  will not be blocked and may still misbehave.

Log the run in `RUNS.log` and update `STATUS.md` before finishing.
