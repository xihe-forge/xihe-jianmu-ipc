#!/bin/bash
# Pull latest code. File watchers in Hub and bridge will auto-restart.
cd "$(dirname "$0")/.."
echo "[jianmu] pulling latest code..."
git pull origin master
echo "[jianmu] code updated. Hub and bridge will auto-restart within 5 seconds."
