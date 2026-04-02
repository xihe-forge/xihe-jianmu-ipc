#!/bin/bash
# Start Hub + feishu-bridge via PM2
cd "$(dirname "$0")/.."
pm2 start ecosystem.config.cjs
pm2 save
echo "jianmu started. Use 'pm2 status' to check, 'pm2 logs' to view logs."
