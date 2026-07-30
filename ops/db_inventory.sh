#!/usr/bin/env bash
# Row counts for the live NUM production database.
#
# Reads credentials straight out of Railway and pipes them into curl — they are
# never printed, never written to disk, and never pasted into a chat. Run it
# whenever you need to know what is actually in production.
#
#   ./ops/db_inventory.sh            # human-readable table
#   ./ops/db_inventory.sh --json     # machine-readable
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."

K=$(railway variables --kv 2>/dev/null | grep '^SUPABASE_SERVICE_ROLE_KEY=' | cut -d= -f2-)
U=$(railway variables --kv 2>/dev/null | grep '^SUPABASE_URL=' | cut -d= -f2-)
if [ -z "$K" ] || [ -z "$U" ]; then
  echo "ERROR: could not read Supabase credentials from Railway. Run 'railway link' first." >&2
  exit 1
fi

TABLES="users channel_identities conversations messages memories vendors leads
bookings consent_events llm_usage events partners partner_tenants acquisition_sources"

JSON=0; [ "${1:-}" = "--json" ] && JSON=1
[ $JSON -eq 1 ] && echo "{" || { echo "project: ${U#https://}"; printf '%-22s %8s\n' TABLE ROWS; }

first=1
for t in $TABLES; do
  # PostgREST returns the exact count in the Content-Range header: 0-0/<count>
  c=$(curl -s -m 10 -I "$U/rest/v1/$t?select=*&limit=1" \
        -H "apikey: $K" -H "Authorization: Bearer $K" -H "Prefer: count=exact" \
      | tr -d '\r' | awk -F/ 'tolower($0) ~ /^content-range/ {print $2}')
  [ -z "$c" ] && c="-"
  if [ $JSON -eq 1 ]; then
    [ $first -eq 0 ] && echo ","
    printf '  "%s": %s' "$t" "$([ "$c" = "-" ] && echo null || echo "$c")"
    first=0
  else
    printf '%-22s %8s\n' "$t" "$c"
  fi
done
[ $JSON -eq 1 ] && echo -e "\n}"
