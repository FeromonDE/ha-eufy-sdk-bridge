#!/bin/sh
# Container entrypoint: run the bridge daemon (PID 1). The daemon serves the WS immediately — so a
# frontend can drive 2FA/captcha before login completes — and spawns go2rtc itself once authenticated.
# (Earlier this script started go2rtc and exited if go2rtc.yaml never appeared, which killed the
# container mid-2FA; go2rtc lifecycle now lives inside server.mjs.)
set -e
exec node "${BRIDGE_APP_DIR:-/app}/server.mjs"
