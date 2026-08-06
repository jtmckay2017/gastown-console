#!/usr/bin/env bash
# Start (or restart) the Gas Town admin console.
#   ./start.sh              → localhost only, no token
#   ./start.sh --lan        → bind all interfaces with a generated token
set -euo pipefail
cd "$(dirname "$0")"

PORT=${PORT:-8099}
ARGS=(--port "$PORT")
[[ "${1:-}" == "--lan" ]] && ARGS+=(--bind 0.0.0.0)

if pid=$(lsof -ti "TCP:$PORT" 2>/dev/null); then
  kill $pid 2>/dev/null || true
  sleep 1
fi

nohup python3 server.py "${ARGS[@]}" > /tmp/gt-admin.log 2>&1 &
sleep 2
sed -n '1,3p' /tmp/gt-admin.log

if [[ "${1:-}" == "--lan" ]]; then
  ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "your-ip")
  tok=$(grep -o 't=[A-Za-z0-9_-]*' /tmp/gt-admin.log | head -1 || true)
  echo "  from your phone:  http://$ip:$PORT/?$tok"
fi
