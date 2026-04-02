#!/bin/bash
cd "$(dirname "$0")/.."
echo "=== PM2 Status ==="
pm2 status
echo ""
echo "=== Hub Health ==="
curl -s http://127.0.0.1:3179/health | python3 -m json.tool 2>/dev/null || echo "Hub not responding"
echo ""
echo "=== Recent Logs ==="
pm2 logs --lines 10 --nostream
