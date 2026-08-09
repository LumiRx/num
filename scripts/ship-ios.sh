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
[ -f "$SECRETS/env" ] || { echo "Missing $SECRETS/env with ASC_KEY_ID and ASC_ISSUER_ID"; exit 1; }
# shellcheck disable=SC1091
source "$SECRETS/env"
[ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] || { echo "ASC_KEY_ID / ASC_ISSUER_ID not set in $SECRETS/env"; exit 1; }
[ -f "$SECRETS/AuthKey_${ASC_KEY_ID}.p8" ] || { echo "Missing $SECRETS/AuthKey_${ASC_KEY_ID}.p8"; exit 1; }

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
xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$BUILD_DIR/Num.xcarchive" archive \
  -allowProvisioningUpdates -quiet

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
  -exportPath "$BUILD_DIR/out" -allowProvisioningUpdates -quiet

IPA="$(ls "$BUILD_DIR"/out/*.ipa)"
echo "built: $IPA"

echo "── 4/4 upload to App Store Connect ─────────────────────"
xcrun altool --upload-app --type ios -f "$IPA" \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo
echo "✓ Uploaded. Processing takes ~10–30 min, then the build appears in"
echo "  App Store Connect → TestFlight. Add testers there, or submit for review."
rm -rf "$BUILD_DIR"
