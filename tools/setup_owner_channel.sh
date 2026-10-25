#!/usr/bin/env bash
# Connect the Virtual Office owner channel to Telegram.
#
#   ./tools/setup_owner_channel.sh <BOT_TOKEN> [REPORT_HOUR]
#
# Get the token from @BotFather in Telegram: /newbot -> copy the token.
# The bot must be able to message you, so send it /start once after setup.
set -euo pipefail

BASE="${OFFICE_URL:-http://127.0.0.1:9012}"
TOKEN="${1:-}"
REPORT_HOUR="${2:-}"

if [ -z "$TOKEN" ]; then
  echo "usage: $0 <BOT_TOKEN> [REPORT_HOUR]" >&2
  echo "  BOT_TOKEN   from @BotFather" >&2
  echo "  REPORT_HOUR local hour for the daily report (0-23, default 8)" >&2
  exit 2
fi

BODY="{\"botToken\":\"$TOKEN\""
if [ -n "$REPORT_HOUR" ]; then
  BODY="$BODY,\"reportHour\":$REPORT_HOUR"
fi
BODY="$BODY}"

echo "-> verifying token with Telegram"
RESP=$(curl -s -m 30 -X POST "$BASE/api/client/setup" \
  -H 'Content-Type: application/json' -d "$BODY")

echo "$RESP" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("ok"):
    print("FAILED:", d.get("error", d))
    sys.exit(1)
bot = d.get("bot") or {}
print("  connected as @%s (%s)" % (bot.get("username"), bot.get("botName")))
print("  bot token stored in state/client.json (0600)")
print()
print("NEXT: open Telegram and send /start to your bot.")
print("      The office will capture your chat id and start sending:")
print("        /status      project status now")
print("        /decisions   decisions waiting on you")
print("        /decide <id> <option>")
print("        /token       token budget per role")
'

echo
echo "-> channel state"
curl -s -m 15 "$BASE/api/client/status" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("  configured:", d.get("configured"))
print("  chatId:    ", d.get("chatId") or "(waiting for you to send /start)")
print("  report at: ", d.get("reportHour"), ":00 local, enabled:", d.get("reportsEnabled"))
'
