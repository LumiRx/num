#!/usr/bin/env bash
# preflight.sh — answer "is it safe to act here?" in one command.
#
# Every session used to rediscover this with six or seven separate git calls,
# and on 2026-08-04 a session skipped the discovery entirely and nearly pushed
# one lineage over the other. This collapses the whole check into one read-only
# pass so there is no reason to skip it.
#
# Read-only by construction: nothing here writes to .git. That matters because
# a failed git WRITE from the Cowork sandbox leaves a lock file the sandbox
# cannot delete, which then blocks the next command — the retry becomes the
# obstacle. Reads never create locks.
#
# Usage:  bash scripts/preflight.sh            (fetch if possible)
#         bash scripts/preflight.sh --no-fetch (skip network)
set -uo pipefail

FETCH=1
[ "${1:-}" = "--no-fetch" ] && FETCH=0

say() { printf '%s\n' "$*"; }
hr()  { printf '%s\n' "────────────────────────────────────────────────────────"; }

hr; say "NUM preflight — $(pwd)"; hr

# ── 0. Can we read git AT ALL? ───────────────────────────────────────────────
# This guard exists because the first version of this script didn't have it.
# Run from the Cowork sandbox, every git call failed silently and the script
# cheerfully printed "uncommitted paths: 0" — a clean bill of health for a
# repository it could not read. That is the precise failure this whole file is
# meant to prevent, so it has to fail loudly here or it teaches the wrong habit.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  say "⚠  GIT IS NOT READABLE FROM HERE."
  say "   Everything below that depends on git is UNKNOWN, not clean."
  say "   Common cause: a worktree whose .git file points at a host path the"
  say "   sandbox cannot resolve. Re-run this on the host, or pass an explicit"
  say "   --git-dir/--work-tree pair."
  say ""
  GIT_OK=0
else
  GIT_OK=1
fi

if [ "$GIT_OK" = "1" ]; then
BRANCH=$(git branch --show-current 2>/dev/null)
[ -z "$BRANCH" ] && BRANCH='(detached HEAD)'

# ── 1. What does this branch actually track? ─────────────────────────────────
# The branch called "main" in the NUM project folder tracks backend-fastapi.
# Acting on the NAME instead of the tracking config is the highest-consequence
# mistake available in this repo.
TRACKS=$(git config --get "branch.${BRANCH}.merge" 2>/dev/null || echo '(untracked)')
say "branch:   ${BRANCH}"
say "tracks:   ${TRACKS}"
case "$TRACKS" in
  *"refs/heads/${BRANCH}") ;;
  '(untracked)') say "          note: no upstream configured" ;;
  *) say "          ⚠  NAME MISMATCH — this branch does not track its own name." ;;
esac

# ── 2. Is the local view of the remote current? ──────────────────────────────
if [ "$FETCH" = "1" ]; then
  if git fetch --quiet origin 2>/dev/null; then
    say "fetch:    ok"
  else
    # Expected in the Cowork sandbox: no SSH credentials. Say so rather than
    # letting a stale remote-tracking ref pass for a current one.
    say "fetch:    ⚠  FAILED (no credentials?) — remote refs below may be stale"
  fi
else
  say "fetch:    skipped (--no-fetch)"
fi

# ── 3. Which lineage are we on? ──────────────────────────────────────────────
# The two lineages have no merge base. This is the check that would have caught
# the 4 Aug near-miss before a single command was proposed.
hr
if git rev-parse --verify -q origin/main >/dev/null 2>&1; then
  if git merge-base --is-ancestor HEAD origin/main 2>/dev/null \
     || git merge-base HEAD origin/main >/dev/null 2>&1; then
    say "lineage:  shares history with origin/main  ✓"
  else
    say "lineage:  ⚠  NO COMMON ANCESTOR with origin/main"
    say "          Merging or force-pushing across lineages DELETES a codebase."
  fi
  read -r BEHIND AHEAD < <(git rev-list --left-right --count origin/main...HEAD 2>/dev/null || echo "? ?")
  say "vs origin/main:  ${BEHIND} there-only / ${AHEAD} here-only"
fi

# ── 4. Anything in flight? ───────────────────────────────────────────────────
hr
DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
say "uncommitted paths: ${DIRTY}"
[ "$DIRTY" != "0" ] && git status --short 2>/dev/null | head -8

LOCKS=$(ls "$(git rev-parse --git-dir 2>/dev/null)"/*.lock 2>/dev/null || true)
if [ -n "$LOCKS" ]; then
  say ""
  say "⚠  STALE GIT LOCKS present:"
  printf '   %s\n' $LOCKS
  say "   The sandbox cannot delete these. Ask the user to run:"
  say "     rm -f \$(git rev-parse --git-dir)/*.lock"
fi
fi  # end GIT_OK

# ── 5. Is the product actually up? ───────────────────────────────────────────
# A green deploy and a working product are different claims. Cheap to settle.
hr
probe() {
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$1" 2>/dev/null || echo 000)
  case "$code" in
    200) say "  ok   $1" ;;
    000) say "  ??   $1  (no network from here)" ;;
    3*)  say "  FAIL $1  → HTTP $code (redirect — possible loop)" ;;
    *)   say "  FAIL $1  → HTTP $code" ;;
  esac
}
say "live surfaces:"
probe https://itsnum.com/
probe https://app.itsnum.com/api/version
say ""
say "version:  $(curl -s -m 8 https://app.itsnum.com/api/version 2>/dev/null | head -c 60)"
say "health:   $(curl -s -m 8 https://app.itsnum.com/api/health 2>/dev/null | tr -d '\n ' | head -c 80)"
hr
say "Reminders: git is READ-ONLY from the sandbox · deploy via release:stage →"
say "release:ship (num-console is bare wrangler deploy) · verify /api/version after."
