#!/bin/bash
# Runs a node script in a loop, restarting on exit.
# Usage: bin/run-forever.sh <script.mjs>
SCRIPT="$1"
if [ -z "$SCRIPT" ]; then echo "Usage: $0 <script.mjs>"; exit 1; fi

cd "$(dirname "$0")/.."

while true; do
  echo "[run-forever] starting $SCRIPT..."
  node "$SCRIPT"
  EXIT_CODE=$?
  echo "[run-forever] $SCRIPT exited with code $EXIT_CODE, restarting in 3s..."
  sleep 3
done
