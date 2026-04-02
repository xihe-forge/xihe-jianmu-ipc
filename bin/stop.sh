#!/bin/bash
cd "$(dirname "$0")/.."
pm2 stop ecosystem.config.cjs
echo "jianmu stopped."
