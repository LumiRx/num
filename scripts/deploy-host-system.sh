#!/usr/bin/env bash
#
# Deploy the VIP host system. Run this from the repo root, on a machine where
# `npx wrangler whoami` works.
#
# ── THE ORDER MATTERS, AND HERE IS WHY ──────────────────────────────────
# Schema first, then the code that reads it. Deploy the workers before the
# migrations and there is a window where /host/ loads, calls /api/host/clients,
# and gets a 500 because num_host_clients does not exist yet. With zero hosts
# today that window harms nobody — but the habit is what matters, because the
# tenth deploy will not be at zero hosts.
#
# Every step stops the script on failure. Nothing here is best-effort.
set -euo pipefail

cd "$(dirname "$0")/.."
echo "▸ repo: $(pwd)"

# ── 0. WHO ARE WE DEPLOYING AS ──────────────────────────────────────────
echo
echo "▸ Cloudflare account"
npx wrangler whoami | tail -6

read -r -p $'\nDeploy the VIP host system to PRODUCTION as this account? [y/N] ' ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Stopped. Nothing was changed."; exit 0; }

# ── 1. THE SUITE ────────────────────────────────────────────────────────
# Not optional and not last. A deploy that ships a red suite is a deploy
# nobody can reason about afterwards.
echo
echo "▸ Tests"
npm test

# ── 1b. WHAT ELSE IS GOING OUT ──────────────────────────────────────────
# This repo is worked in by more than one person and more than one agent.
# num-console ships EVERYTHING in public/, so a file someone is halfway
# through editing ships too. The test gate above is the real protection; this
# is so you can see it rather than infer it afterwards.
echo
echo "▸ Changed in the last 30 minutes (all of this deploys):"
find . -path ./node_modules -prune -o -newermt '-30 minutes' -type f -print 2>/dev/null \
  | grep -v -e '^./node_modules' -e '^./dist' -e '.wrangler' -e 'tsbuildinfo' -e 'timestamp-' \
  | head -20 || true
read -r -p $'\nStill happy to ship all of that? [y/N] ' ok2
[[ "$ok2" == "y" || "$ok2" == "Y" ]] || { echo "Stopped. Nothing was changed."; exit 0; }

# ── 2. THE BUILD ────────────────────────────────────────────────────────
echo
echo "▸ Build"
npm run build

# ── 3. SCHEMA ───────────────────────────────────────────────────────────
# Statement by statement, tolerating "already applied". Safe to re-run, and
# re-running is how you finish a partial apply.
echo
echo "▸ Migrations → num-db (remote)"
node scripts/apply-host-migrations.mjs

# ── 3b. DOES THE DATABASE NOW HAVE WHAT THE CODE BELIEVES IN? ───────────
# On 7 Sep 2026 /api/host/requests had been returning 500 for every host for
# weeks, because num_host_requests.booking_fee_minor was declared inside a
# CREATE TABLE IF NOT EXISTS on a table that already existed — a silent no-op.
# The column reached fresh databases and no existing one. Nothing compared the
# two, so nothing noticed.
#
# This runs AFTER the migrations on purpose: it is asking whether the apply we
# just did actually left the database in the shape the code expects, which is a
# different question from whether the apply reported success.
#
# It stops the deploy. A worker shipped against a database missing a column it
# selects is a 500 for every user of that endpoint, and it fails silently in
# the console — which is exactly how the last one went unnoticed.
echo
echo "▸ Schema drift — does production have every column the migrations declare?"
node scripts/schema-drift.mjs

# ── 4. BACKFILL ─────────────────────────────────────────────────────────
# Client rows created before 0015 have no member_token, which means those
# people have no way to remove themselves. The integrity check reports them as
# `client_cannot_leave` until this runs.
echo
echo "▸ Backfill: a way out for every existing client"
npx wrangler d1 execute num-db --remote --command \
  "UPDATE num_host_clients SET member_token = lower(hex(randomblob(20))) WHERE member_token IS NULL"

# ── 5. THE WORKERS ──────────────────────────────────────────────────────
# num-console serves ./public and holds itsnum.com/* — it is what actually
# ships /hosts/, /host/, /my-host/ and /find-a-host/. Deploying only num-app
# (the SPA) would ship none of the pages, which is the mistake this comment
# exists to prevent.
echo
echo "▸ num-console  (the pages: /hosts/ /host/ /my-host/ /find-a-host/)"
npx wrangler deploy

echo
echo "▸ num-growth   (the host API: /api/host/*)"
npx wrangler deploy --config growth/wrangler.jsonc

echo
echo "▸ num-app      (the SPA and the app worker)"
npx wrangler deploy --config wrangler.app.jsonc

# ── 6. DOES IT AGREE WITH ITSELF ────────────────────────────────────────
echo
echo "▸ Smoke test"
for path in /hosts/ /find-a-host/ /my-host/ /host/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://itsnum.com${path}")
  printf '   %-16s %s\n' "$path" "$code"
done

echo "   /api/host/nearby?city=edinburgh"
curl -s "https://itsnum.com/api/host/nearby?city=edinburgh" | head -c 300
echo

if [[ -n "${ADMIN_KEY:-}" ]]; then
  echo
  echo "▸ Integrity"
  curl -s "https://itsnum.com/api/host/integrity?key=${ADMIN_KEY}" | head -c 900
  echo
else
  echo
  echo "▸ Integrity — set ADMIN_KEY and run:"
  echo '   curl -s "https://itsnum.com/api/host/integrity?key=$ADMIN_KEY"'
fi

echo
echo "Done. Sign up as a host at https://itsnum.com/hosts to walk it end to end."
