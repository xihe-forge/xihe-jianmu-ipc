#!/usr/bin/env bash
# feishu-reply.sh — Send a reply to Feishu via the Hub's /feishu-reply endpoint.
#
# Usage:
#   echo "reply text" | feishu-reply.sh [app-name]
#   feishu-reply.sh [app-name] "reply text"
#
# Env:
#   IPC_PORT        Hub port (default: 3179)
#   IPC_AUTH_TOKEN   Auth token (optional)
#   FEISHU_APP      Default app name (default: jianmu-pm)

APP="${1:-${FEISHU_APP:-jianmu-pm}}"
IPC_PORT="${IPC_PORT:-3179}"

# Content from argument or stdin
if [ -n "$2" ]; then
  CONTENT="$2"
else
  CONTENT="$(cat)"
fi

if [ -z "$CONTENT" ]; then
  echo "Error: no content provided" >&2
  exit 1
fi

# Escape content for JSON (handle newlines, quotes, backslashes)
JSON_CONTENT=$(printf '%s' "$CONTENT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_CONTENT" ]; then
  # Fallback: simple escape (no python3)
  JSON_CONTENT="\"$(printf '%s' "$CONTENT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ')\""
fi

AUTH_HEADER=""
if [ -n "$IPC_AUTH_TOKEN" ]; then
  AUTH_HEADER="-H \"Authorization: Bearer $IPC_AUTH_TOKEN\""
fi

curl -s -X POST "http://127.0.0.1:${IPC_PORT}/feishu-reply" \
  -H "Content-Type: application/json" \
  ${AUTH_HEADER:+-H "Authorization: Bearer $IPC_AUTH_TOKEN"} \
  -d "{\"app\":\"${APP}\",\"content\":${JSON_CONTENT}}"
