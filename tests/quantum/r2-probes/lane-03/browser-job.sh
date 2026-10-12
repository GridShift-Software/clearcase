#!/usr/bin/env bash
# run inside the browser-lock slot: wait for > 3500 MB available (every 2 min, up to 20 min), then the probe (10 min cap)
for i in $(seq 0 10); do
  avail=$(free -m | awk '/^Mem:/{print $7}')
  echo "browser-job: available ${avail} MB"
  [ "$avail" -gt 3500 ] && break
  [ "$i" -eq 10 ] && { echo "browser-job: memory never above 3500 MB in 20 min"; exit 76; }
  sleep 120
done
exec timeout --kill-after=20 600 bun run --bun "$1" "$2"
