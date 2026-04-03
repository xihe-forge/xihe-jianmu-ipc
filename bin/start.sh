#!/bin/bash
# Start Hub + feishu-bridge with auto-restart
cd "$(dirname "$0")/.."

echo "[jianmu] starting hub..."
setsid nohup bash bin/run-forever.sh hub.mjs > /tmp/hub-stderr.log 2>&1 < /dev/null &
echo "[jianmu] hub started (pid=$!)"

echo "[jianmu] starting feishu-bridge..."
setsid nohup bash bin/run-forever.sh feishu-bridge.mjs > /tmp/feishu-bridge.log 2>&1 < /dev/null &
echo "[jianmu] feishu-bridge started (pid=$!)"

sleep 3
echo "[jianmu] checking health..."
curl -s http://127.0.0.1:3179/health | head -1 || echo "hub not responding yet"
