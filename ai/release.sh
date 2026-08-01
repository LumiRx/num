#!/usr/bin/env bash
# Staged releases for the num-ai Worker — mirror of num-app's release flow.
#
#   ./release.sh stage "what changed"   # upload a version, 0% traffic, print preview URL
#   ./release.sh ship 10                # send 10% of traffic to the staged version
#   ./release.sh ship                   # promote staged version to 100%
#   ./release.sh rollback               # 100% back to the previous version
#   ./release.sh status                 # what is serving, at what split
#
# WHY THIS EXISTS
#   Until 2026-08-01 this Worker was deployed with raw `wrangler deploy`, which
#   goes straight to 100% of live traffic. Twice that overwrote work: dashboard
#   edits made outside git, and (via deploys built from a fix branch) the
#   member-DM + guessed-location code from main. Staging first makes both
#   mistakes visible before guests see them.
#
# RULES (see ../AGENTS.md)
#   - Deploy from a clean checkout of origin/main. Never from a dirty tree,
#     never from a branch that hasn't been merged.
#   - Tag what you ship: num-ai/YYYY-MM-DD[-suffix].
#   - Never `wrangler deploy` directly. Never edit in the Cloudflare dashboard.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"

STATE=".staged-version"      # gitignored; holds the last staged version id

case "${1:-}" in
  stage)
    MSG="${2:-}"
    [ -n "$MSG" ] || { echo "usage: ./release.sh stage \"what changed\"" >&2; exit 1; }
    if ! git diff --quiet -- . || ! git diff --cached --quiet -- .; then
      echo "REFUSING: ai/ has uncommitted changes. Commit first — an unstaged" >&2
      echo "deploy is exactly how work got overwritten twice already." >&2
      exit 1
    fi
    node --test ./*.test.mjs >/dev/null 2>&1 || { echo "REFUSING: tests fail. Run: node --test ai/*.test.mjs" >&2; exit 1; }
    OUT=$(wrangler versions upload --message "$MSG" 2>&1) || { echo "$OUT" >&2; exit 1; }
    echo "$OUT" | grep -E "Version ID|Preview URL|Uploaded" || echo "$OUT" | tail -5
    VID=$(echo "$OUT" | grep -oE "Worker Version ID: [0-9a-f-]+|Version ID: [0-9a-f-]+" | grep -oE "[0-9a-f-]{36}" | head -1)
    [ -n "$VID" ] && echo "$VID" > "$STATE" && echo "staged: $VID (0% traffic). Test the preview URL, then ./release.sh ship 10"
    ;;
  ship)
    PCT="${2:-100}"
    VID=$(cat "$STATE" 2>/dev/null || true)
    [ -n "$VID" ] || { echo "No staged version recorded. Run ./release.sh stage first." >&2; exit 1; }
    CUR=$(wrangler deployments list 2>/dev/null | grep -oE "[0-9a-f-]{36}" | head -1 || true)
    if [ "$PCT" = "100" ]; then
      wrangler versions deploy "$VID@100%" --yes
      echo "$CUR" > .previous-version 2>/dev/null || true
      echo "LIVE at 100%: $VID  (rollback: ./release.sh rollback)"
      echo "Tag it: git tag num-ai/$(date +%Y-%m-%d) && git push origin --tags"
    else
      [ -n "$CUR" ] || { echo "Could not read current version for the split." >&2; exit 1; }
      wrangler versions deploy "$VID@${PCT}%" "$CUR@$((100-PCT))%" --yes
      echo "CANARY: $VID at ${PCT}%, previous at $((100-PCT))%."
      echo "Watch: wrangler tail num-ai --format pretty   Promote: ./release.sh ship"
    fi
    ;;
  rollback)
    PREV=$(cat .previous-version 2>/dev/null || true)
    if [ -z "$PREV" ]; then
      echo "No recorded previous version. Pick one:" >&2
      wrangler versions list 2>/dev/null | grep -E "Version ID|Created|Message" | tail -12
      exit 1
    fi
    wrangler versions deploy "$PREV@100%" --yes
    echo "ROLLED BACK to $PREV"
    ;;
  status)
    echo "== serving now =="; wrangler deployments list 2>/dev/null | head -14
    echo "== staged =="; cat "$STATE" 2>/dev/null || echo "(nothing staged)"
    ;;
  *)
    sed -n '2,12p' "$0"; exit 1;;
esac
