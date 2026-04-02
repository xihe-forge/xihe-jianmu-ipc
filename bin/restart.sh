#!/bin/bash
cd "$(dirname "$0")/.."
pm2 restart ecosystem.config.cjs
echo "jianmu restarted."
