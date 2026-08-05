#!/bin/sh
# Container entrypoint: start the bridge daemon, wait for it to write go2rtc.yaml from the live device
# list, then hand off to go2rtc. This is the /usr/local/bin/eufy-sdk-bridge launcher the add-on execs.
set -e
APP="${BRIDGE_APP_DIR:-/app}"
CONF="${GO2RTC_CONFIG:-$APP/go2rtc.yaml}"

node "$APP/server.mjs" &
SERVER_PID=$!

i=0
until [ -s "$CONF" ]; do
  sleep 1; i=$((i + 1))
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "[bridge] daemon exited before writing $CONF"; exit 1; }
  [ "$i" -gt 60 ] && { echo "[bridge] timed out waiting for $CONF"; exit 1; }
done

exec go2rtc -config "$CONF"
