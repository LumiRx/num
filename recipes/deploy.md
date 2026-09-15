# Recipe: deploy

**Tier 0 — START HERE, ALWAYS. Ask what actually needs deploying.**

```bash
cd ~/num-worktrees/app-main
npm run deploy:check
```

It hashes the files each worker really compiles against what that worker last
shipped, and names the ones that changed. Run it BEFORE you deploy so you know
the full list, and AFTER, so you can see the list is empty.

**Why this exists.** There are eight code workers and they share source files —
`ai/places.js` is compiled into both num-ai and num-app. Each worker gets its
OWN COPY at build time, so fixing a shared file and deploying one worker leaves
the other running the old code with no error, no failing test, and no alarm.
On 15 Sep 2026 the Hollywood retrieval bug was fixed, tested, deployed to
num-ai, and stayed live in the phone app for the rest of the session because
num-app was never redeployed. Every signal said the fix had shipped.

`release:ship` records itself and prints this warning automatically. The other
workers record themselves through `npm run deploy:growth` and `npm run deploy:ai`
— if you deploy one with a bare `npx wrangler deploy` line instead, stamp it by
hand or the ledger goes stale:

```bash
cd ~/num-worktrees/app-main
npm run deploy:mark num-growth
```

**Tier 1 — the whole thing, when both main workers changed.**

```bash
cd ~/num-worktrees/app-main
node scripts/claim.mjs take deploy "<what changed>" --who dre
npm run release:stage "<what changed>"
npm run release:ship
npx wrangler deploy --config growth/wrangler.jsonc
node scripts/claim.mjs release deploy --who dre
```

**Tier 2 — host or admin work only.** Those routes live on the growth worker,
so `release:stage`/`ship` do not touch them. Only the wrangler line matters.

**ROLLBACK IS NOT A STEP. It is the emergency undo.**

Never list `release:rollback` in the same run of commands as stage and ship.
It happened on 12 Sep 2026: rollback was written as the third code block after
stage and ship, Dre ran all three in sequence, and wrangler sat at its "provide
a message" prompt one Enter away from reverting a healthy deploy — including a
security fix. Nothing was lost only because the prompt is interactive.

Before rolling back, prove there is something wrong:

```bash
curl -s https://app.itsnum.com/api/health
curl -s https://app.itsnum.com/api/version
```

`"verdict":"ok"` with `"failing":0` means the deploy is fine and a rollback
would only remove working code. At wrangler's message prompt, Ctrl+C aborts
cleanly — nothing has been applied yet.

```bash
cd ~/num-worktrees/app-main
npm run release:rollback
```

**Checking what is in flight — and whose shell you are in.**

More than one session edits this tree, and `release.mjs` bundles the working tree rather than a
commit, so check before staging. On Dre's Mac that is just:

```bash
cd ~/num-worktrees/app-main
git status --short
node scripts/claim.mjs status
```

A COWORK session needs two env vars for the same command, because the worktree's `.git` points at an
absolute `/Users/dre/...` path its VM cannot resolve:

```bash
export GIT_DIR="$HOME/mnt/NUM/.git/worktrees/app-main"
export GIT_WORK_TREE="$HOME/mnt/num-worktrees/app-main"
```

**Those two lines must never be given to Dre.** In his shell `$HOME` is `/Users/dre`, so they point at
`/Users/dre/mnt/NUM/...`, which does not exist — and they then break every git command in that window
until `unset GIT_DIR GIT_WORK_TREE`. It happened on 12 Sep 2026.

**Tier 3 — when it fails.**

- *"Nothing to ship for X"* — a stage failed before uploading. Run stage again;
  do not force wrangler past it.
- *`index.lock`: File exists* — a crashed earlier run. **Since 12 Sep the release
  script clears this itself when the file proves it is dead: ZERO BYTES and older
  than ten minutes.** Git writes the new index into that file as it works, so an
  empty one is a killed process, never a live writer. A lock with any content, or
  younger than ten minutes, still stops the run and is the person's call —
  removing a live writer's lock corrupts the repository. `NO_LOCK_SWEEP=1` turns
  the automatic clearing off. It had cost three releases before this: 9 Sep, and
  twice on 12 Sep.
- *`EPERM: unlink dist/...`* — a Cowork session, which cannot delete files in a
  connected folder. Fixed by granting delete permission on `~/num-worktrees`
  (done 12 Sep), or work around it with `mv dist .dist-stale-$(date +%s)`.
- *`necessary to set a CLOUDFLARE_API_TOKEN`* — a Cowork session has NO
  Cloudflare credentials: that VM's home is not Dre's home, so `wrangler login`
  is invisible to it and `$HOME/.wrangler` holds only `logs/`. **Staging and
  shipping are Dre's.** This is not the `dist/` problem and granting file
  permissions does not help it.
- Node is pinned to 22 in `.nvmrc`; `engines` only says >=20, so a newer Node
  will not be blocked and may still misbehave.

Log the run in `RUNS.log` and update `STATUS.md` before finishing.
