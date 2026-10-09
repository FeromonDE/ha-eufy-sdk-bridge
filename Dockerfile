# ha-eufy-sdk-bridge: the SDK + the bridge daemon + go2rtc, in one image.
#
# go2rtc is a single static binary that does every media protocol we would otherwise hand-write
# (RTSP/WebRTC/MSE/HLS); bundling it means the user still installs exactly one thing.
#
# ── SDK sourcing ────────────────────────────────────────────────────────────────────────────────────
# The SDK (@mega-yfue/eufy-sdk) is a PUBLIC scoped package on npm, so it installs like any dependency —
# `npm install` pulls it (and its runtime deps: mqtt / protobufjs / werift) from the registry, no auth,
# no build context, no sibling checkout. The pinned STABLE version lives in package.json/package-lock.json
# (the same pin as `main` — the committed files never drift onto the beta line just to feed the dev image).
# Build with just:
#     docker build -t ha-eufy-sdk-bridge .
#
# ── Dev-channel override (SDK_DIST_TAG) ──────────────────────────────────────────────────────────────
# Empty (default) → the image uses the EXACT SDK pinned in the lockfile: reproducible, what a release /
# stable build wants. Set to an npm dist-tag or version → after the locked install, the SDK is re-installed
# at that tag, pulling the LATEST matching publish from npm at build time (no lockfile pin, so it can never
# go stale). This is the ONLY place the dev line diverges from stable: `publish-dev.yml` passes
# `SDK_DIST_TAG=beta`, so every :dev image tracks the newest eufy-sdk beta without any committed change.
#     docker build --build-arg SDK_DIST_TAG=beta -t ha-eufy-sdk-bridge:dev .
FROM node:24-alpine
RUN apk add --no-cache ffmpeg curl
WORKDIR /app

# go2rtc — pin the version so an image rebuild cannot change media behaviour. Select the binary by
# TARGETARCH (Docker BuildKit sets it) so the image builds on arm64 (Raspberry Pi / HA OS) too, not
# just amd64 — the bug the first bridge had.
ARG GO2RTC_VERSION=1.9.9
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) g2="go2rtc_linux_amd64" ;; \
      arm64) g2="go2rtc_linux_arm64" ;; \
      arm) g2="go2rtc_linux_arm" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/go2rtc \
      "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/${g2}" \
 && chmod +x /usr/local/bin/go2rtc

# Install the bridge's deps from npm: the SDK (@mega-yfue/eufy-sdk → pulls mqtt/protobufjs/werift) + ws.
# `npm ci` installs the exact locked (stable) tree; the dev build then overlays the requested SDK dist-tag
# on top (see SDK_DIST_TAG above). `--no-save` keeps package.json/lock untouched, so no drift leaks in.
ARG SDK_DIST_TAG=
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && if [ -n "$SDK_DIST_TAG" ]; then \
      echo "SDK_DIST_TAG=$SDK_DIST_TAG → overlaying @mega-yfue/eufy-sdk@$SDK_DIST_TAG (dev channel)"; \
      npm install --omit=dev --no-audit --no-fund --no-save "@mega-yfue/eufy-sdk@$SDK_DIST_TAG"; \
      node -e "console.log('SDK now:', JSON.parse(require('fs').readFileSync('node_modules/@mega-yfue/eufy-sdk/package.json')).version)"; \
    fi

COPY server.mjs streams.mjs go2rtc-config.mjs ./
COPY src ./src
COPY bin ./bin
RUN chmod +x bin/start.sh && ln -sf /app/bin/start.sh /usr/local/bin/eufy-sdk-bridge

ENV BRIDGE_APP_DIR=/app BRIDGE_PORT=3000 BRIDGE_HOST=0.0.0.0 \
    GO2RTC_CONFIG=/app/data/go2rtc.yaml EUFY_SESSION=/app/data/.eufy-session.json
RUN mkdir -p /app/data
EXPOSE 3000 1984 8554 8555/udp

CMD [ "eufy-sdk-bridge" ]
