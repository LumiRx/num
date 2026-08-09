#!/usr/bin/env bash
# Build, sign, and upload Num to TestFlight — from a Mac, with Apple's own
# tools, no fastlane to install or trust.
#
#   bash scripts/ship-ios.sh
#
# ── What it needs, once ────────────────────────────────────────────────────
#  · Xcode installed, and the project opened once with your signing team set
#    (Xcode → App target → Signing & Capabilities → Team). Automatic signing
#    does the certificate dance for you after that.
#  · An App Store Connect API key at ~/.secrets/appstore/AuthKey_<KEYID>.p8
#    and two ids in ~/.secrets/appstore/env :
#        ASC_KEY_ID=XXXXXXXXXX
#        ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#    The .p8 downloads from App Store Connect exactly once. It lives in
#    ~/.secrets, never in this repo, never in a chat, never in an env var
#    that ends up in a shell history.
#
# ── Why altool with an API key ─────────────────────────────────────────────
#  No Apple ID password, no 2FA prompt mid-script, no app-specific password
#  to rotate. The key can be revoked from App Store Connect in one click
#  without touching the account. This is the same auth CI systems use.
set -euo pipefail

cd "$(dirname "$0")/.."

SECRETS="$HOME/.secrets/appstore"
mkdir -p "$SECRETS"

# ── self-configuring credentials ──────────────────────────────────────────
# Hand-editing an env file failed three times running; the script now sets
# itself up. The key id IS the filename — asking a human to retype it was
# a transcription step with no purpose. Only the issuer id (not derivable)
# is asked for, once, then remembered.

# If the key is still sitting in Downloads, file it.
if ! ls "$SECRETS"/AuthKey_*.p8 >/dev/null 2>&1; then
  if ls "$HOME/Downloads"/AuthKey_*.p8 >/dev/null 2>&1; then
    mv "$HOME/Downloads"/AuthKey_*.p8 "$SECRETS/"
    echo "· moved API key from Downloads into $SECRETS"
  else
    echo "No API key found."
    echo "App Store Connect → Users and Access → Integrations → Generate API Key"
    echo "(role: App Manager) → Download. Then run this script again — it will"
    echo "find the key in Downloads and file it itself."
    exit 1
  fi
fi

KEYFILE="$(ls "$SECRETS"/AuthKey_*.p8 | head -1)"
ASC_KEY_ID="$(basename "$KEYFILE" .p8)"; ASC_KEY_ID="${ASC_KEY_ID#AuthKey_}"
echo "· using key $ASC_KEY_ID"

# Issuer id: read from env if saved, ask once if not.
[ -f "$SECRETS/env" ] && source "$SECRETS/env" || true
if [ -z "${ASC_ISSUER_ID:-}" ] || [ "$ASC_ISSUER_ID" = "PASTE_ISSUER_ID" ]; then
  echo "Issuer ID (the long UUID at the top of the Integrations page):"
  read -r ASC_ISSUER_ID
  printf 'ASC_ISSUER_ID=%s\n' "$ASC_ISSUER_ID" > "$SECRETS/env"
  echo "· saved — you will not be asked again"
fi
[ -n "$ASC_ISSUER_ID" ] || { echo "No issuer id — cannot upload."; exit 1; }

# altool looks for keys in a fixed directory; a symlink keeps the real file
# in ~/.secrets where it belongs.
mkdir -p "$HOME/private_keys"
ln -sf "$SECRETS/AuthKey_${ASC_KEY_ID}.p8" "$HOME/private_keys/AuthKey_${ASC_KEY_ID}.p8"

echo "── 1/4 web build ────────────────────────────────────────"
npm run build

echo "── 2/4 capacitor sync ──────────────────────────────────"
npx cap sync ios

echo "── 3/4 archive + export ────────────────────────────────"
BUILD_DIR="$(mktemp -d)"
# Capacitor scaffolds differ by generation: CocoaPods projects build from
# App.xcworkspace, Swift Package Manager projects (Capacitor 7+) from
# App.xcodeproj. Detect rather than assume — this exact assumption cost a
# failed run on 9 Aug.
if [ -d ios/App/App.xcworkspace ]; then
  XCTARGET=(-workspace ios/App/App.xcworkspace)
else
  XCTARGET=(-project ios/App/App.xcodeproj)
fi
# Fully headless signing: the team id is stated here (it is printed in the
# developer portal header and inside every shipped binary — not a secret),
# and the ASC API key authenticates xcodebuild to create/refresh the
# provisioning profile itself. Nobody opens Xcode; nobody signs in.
TEAM_ID="6X2UDX3SUP"   # Lumi Enterprises Corp.
xcodebuild "${XCTARGET[@]}" -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$BUILD_DIR/Num.xcarchive" archive \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEYFILE" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" -quiet

cat > "$BUILD_DIR/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath "$BUILD_DIR/Num.xcarchive" \
  -exportOptionsPlist "$BUILD_DIR/export.plist" \
  -exportPath "$BUILD_DIR/out" -allowProvisioningUpdates \
  -authenticationKeyPath "$KEYFILE" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" -quiet

IPA="$(ls "$BUILD_DIR"/out/*.ipa)"
echo "built: $IPA"

echo "── 4/4 upload to App Store Connect ─────────────────────"
xcrun altool --upload-app --type ios -f "$IPA" \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo
echo "✓ Uploaded. Processing takes ~10–30 min, then the build appears in"
echo "  App Store Connect → TestFlight. Add testers there, or submit for review."
rm -rf "$BUILD_DIR"
