#!/usr/bin/env bash
# NUM backup — code history + production data, to a timestamped local folder.
#
# Why this exists: production Supabase (lvallpzkhnuarrnxbvfg) sits on an account
# we cannot reach from the dashboard or MCP, and Railway holds no SUPABASE_DB_URL,
# so `pg_dump` is not available to us. The data path here goes through PostgREST
# with the service key, which is the only route we actually have. It is a real
# backup of row data; it is NOT a schema backup (see MIGRATIONS note below).
#
# Credentials are read straight from Railway and piped into curl — never printed,
# never written to disk.
#
#   ./ops/backup.sh                  # code + data
#   ./ops/backup.sh --code-only      # skip the network calls
#
# Restore: see ops/RESTORE.md
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="${NUM_BACKUP_DIR:-$HOME/Backups/NUM}/$STAMP"
mkdir -p "$DEST/data"
echo "→ $DEST"

# ── 1. Code: a git bundle is a single file containing the FULL history of every
#    branch. Unlike a zip of the working tree, you can `git clone` it directly.
echo "[code] bundling all refs..."
git bundle create "$DEST/num-repo.bundle" --all 2>&1 | tail -2
git log --oneline -1 > "$DEST/HEAD.txt"
git status --short > "$DEST/uncommitted.txt"
# Anything not committed wouldn't survive the bundle — capture it separately.
if [ -s "$DEST/uncommitted.txt" ]; then
  echo "[code] uncommitted changes present — archiving working tree too"
  tar --exclude-vcs --exclude='node_modules' --exclude='__pycache__' \
      --exclude='.venv' -czf "$DEST/worktree-dirty.tgz" . 2>/dev/null
fi

[ "${1:-}" = "--code-only" ] && { echo "done (code only): $DEST"; exit 0; }

# ── 2. Data: every table, newest first, as JSON.
K=$(railway variables --kv 2>/dev/null | grep '^SUPABASE_SERVICE_ROLE_KEY=' | cut -d= -f2-)
U=$(railway variables --kv 2>/dev/null | grep '^SUPABASE_URL=' | cut -d= -f2-)
if [ -z "$K" ] || [ -z "$U" ]; then
  echo "[data] SKIPPED — no Railway credentials. Run 'railway link' and re-run." >&2
  echo "done (code only): $DEST"; exit 1
fi
echo "[data] source: ${U#https://}"
echo "${U#https://}" > "$DEST/data/SOURCE.txt"

TABLES="users channel_identities conversations messages memories vendors leads
bookings consent_events llm_usage events partners partner_tenants acquisition_sources"

total=0
for t in $TABLES; do
  # limit=50000 is well above current volume; raise it before it bites.
  if curl -s -m 60 "$U/rest/v1/$t?select=*&limit=50000" \
       -H "apikey: $K" -H "Authorization: Bearer $K" -o "$DEST/data/$t.json"; then
    n=$(python3 -c "import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(len(d) if isinstance(d,list) else 'ERR')
except Exception: print('ERR')" "$DEST/data/$t.json" 2>/dev/null)
    printf '  %-22s %s\n' "$t" "$n"
    [ "$n" != "ERR" ] && total=$((total + n))
  else
    printf '  %-22s FAILED\n' "$t"
  fi
done
echo "[data] $total rows total"

# ── 3. Schema: what we CAN capture without DDL access.
cp -R migrations "$DEST/migrations" 2>/dev/null && echo "[schema] migration files copied"
cat > "$DEST/README.txt" <<EOF
NUM backup — $STAMP

CONTENTS
  num-repo.bundle   Full git history, all branches. Restore: git clone num-repo.bundle num
  HEAD.txt          Commit this was taken from
  data/*.json       Row data from ${U#https://} via PostgREST
  migrations/       SQL that defines the schema

LIMITATION — READ THIS
  This is a DATA backup, not a byte-for-byte database backup. We have no
  SUPABASE_DB_URL and no dashboard access to the production project, so pg_dump
  is unavailable. Rebuilding means: create a project, run migrations/ in order,
  then load data/*.json. Sequences, RLS policy state and storage objects are
  NOT captured here.

  The durable fix is to move production onto a Supabase project the team can
  actually administer, then use Supabase's own PITR/backups.
EOF

echo "done: $DEST"
