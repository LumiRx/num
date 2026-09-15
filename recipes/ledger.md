# Recipe: the ledger

**The one rule: never edit `LEDGER.md`.** It is generated. Anything you type
there is erased the next time anyone builds it.

## Every morning — the daily check

```bash
cd ~/num-worktrees/app-main
npm run daily
```

Three questions in one command: do Dre's and Viv's ledgers disagree anywhere, is
the board in step with the entries, and is any worker running older code than
the repo. It exits non-zero if any answer is bad, so it can gate a routine
rather than being something somebody remembers to read.

## Recording something

```bash
cd ~/num-worktrees/app-main
npm run ledger:add -- --who dre --area "host console" --state in-flight --note "tabs, not eleven cards"
```

`--who` is `dre`, `viv` or `claude`. The `--` before the flags is required — npm
eats them otherwise.

| State | Means |
|---|---|
| `live` | Deployed and serving. Somebody has seen it work in production. |
| `done` | Built, tested, merged. **Not necessarily deployed.** |
| `in-flight` | Being worked on right now. |
| `blocked` | Cannot progress. The note must say what would unblock it. |
| `gap` | A known hole we have chosen not to close yet. |
| `decided` | A call was made. The note is the decision and the reason. |

`live` and `done` are separate on purpose. On 15 Sep 2026 the Hollywood fix was
marked as shipped while the phone app still ran the old code, because
built-and-merged got confused with deployed-and-serving.

## Why two people cannot overwrite each other

Everyone appends to their **own** file:

```
ledger/entries/dre.ndjson
ledger/entries/viv.ndjson
ledger/entries/claude.ndjson
```

Nobody edits anybody else's. Two people appending to two different files is not
a merge conflict in any version control system ever built, so both sides survive
a pull. `LEDGER.md` is then rebuilt from all of them — it is a *view*, not a
document, so it cannot drift out of step with what was actually recorded.

This is why there is no "mirror" ledger. Two editable documents that must agree
never will; the argument just moves to which one is right. One derived board and
one file per person removes the question.

## When the ledgers disagree

`npm run ledger:check` prints both entries, both names, both times, and stops.

**It never picks a winner.** The newest entry does not automatically win —
"most recent" is not "correct", and a tool that quietly resolves a disagreement
teaches everyone the board is lying.

Talk. Then whoever was wrong **adds a new entry**. Nothing is ever edited or
deleted, so the record of having been wrong survives — which is usually the most
useful line in the whole ledger.

## Viv's side

She has the repo. Her loop is:

```bash
cd ~/num-worktrees/app-main
git pull
npm run daily
```

Then she records her own work with `--who viv`, and pushes. Her entries only
ever touch `ledger/entries/viv.ndjson`, so a push can never clobber Dre's work,
and a pull can never lose hers.

## What goes where

| File | What it is | Who writes it |
|---|---|---|
| `LEDGER.md` | The master board — current state of every area | **Generated. Nobody.** |
| `ledger/entries/*.ndjson` | Append-only history, one file per person | Each person, their own only |
| `STATUS.md` | Prose context and facts that cost tokens to rediscover | Humans, by hand |
| `RUNS.log` | What happened in each session, and the traps found | Whoever ran it |

`LEDGER.md` answers *what state is everything in*. `STATUS.md` answers *what do
I need to know before I touch anything*. They do not compete.
