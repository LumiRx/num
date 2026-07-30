#!/usr/bin/env bash
# Set Twilio credentials on the Railway backend — without the secret ever
# appearing in your shell history, on screen, or in a chat window.
#
#   ./ops/set_twilio_secrets.sh
#
# WHY THIS MATTERS RIGHT NOW
#   apps/api/adapters/twilio.py verifies the X-Twilio-Signature header, but it
#   fails OPEN when TWILIO_AUTH_TOKEN is unset (so local dev and tests work).
#   That token is currently unset in Railway, which means the /sms and
#   /whatsapp webhooks accept unsigned requests from anyone who knows the URL.
#   Today that is survivable only because the Anthropic key is invalid, so
#   there is no LLM spend to burn. Set this BEFORE fixing the Anthropic key.
#
# Find both values at console.twilio.com → Account Info.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."

command -v railway >/dev/null || { echo "railway CLI not found: brew install railway" >&2; exit 1; }
railway status >/dev/null 2>&1 || { echo "Not linked. Run: railway link" >&2; exit 1; }

echo "Setting Twilio credentials on: $(railway status 2>/dev/null | grep -i '^Project:' || echo '?')"
echo

read -rp  "TWILIO_ACCOUNT_SID (starts AC…): " SID
# -s: no echo. Neither value is passed as a CLI arg in a way bash records,
# and `read` builtins never enter history.
read -rsp "TWILIO_AUTH_TOKEN  (hidden): " TOK; echo
read -rp  "TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886, blank to skip): " WA

[ -n "$SID" ] && [ -n "$TOK" ] || { echo "SID and token are both required." >&2; exit 1; }

railway variables --set "TWILIO_ACCOUNT_SID=$SID" --set "TWILIO_AUTH_TOKEN=$TOK" >/dev/null
[ -n "$WA" ] && railway variables --set "TWILIO_WHATSAPP_FROM=$WA" >/dev/null
unset SID TOK WA

echo
echo "Set. Railway will redeploy automatically."
echo
echo "AFTER IT REDEPLOYS — signature checking is now ACTIVE, so verify real"
echo "traffic still gets through before you walk away:"
echo "  1. Send a real message to the Twilio number."
echo "  2. railway logs | grep -i twilio_signature"
echo "     'twilio_signature_skipped_no_token' should be GONE."
echo "     If you see 403s instead of replies, the URL Twilio calls does not"
echo "     match the one the app rebuilds — check the webhook URL in the Twilio"
echo "     console matches your Railway domain exactly, including https and path."
echo
echo "Unsigned requests should now be rejected:"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' -X POST \\"
echo "    https://web-production-d6ed4.up.railway.app/whatsapp \\"
echo "    -d 'From=whatsapp:+10000000000&Body=test&NumMedia=0'"
echo "  → expect 403 (was 200)"
