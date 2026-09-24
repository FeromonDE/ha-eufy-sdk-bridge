# ha-eufy-sdk-bridge: the SDK + the bridge daemon + go2rtc, in one image.
#
# go2rtc is a single static binary that does every media protocol we would otherwise hand-write
# (RTSP/WebRTC/MSE/HLS); bundling it means the user still installs exactly one thing.
#
# ── SDK sourcing ────────────────────────────────────────────────────────────────────────────────────
# The SDK (@mega-yfue/eufy-sdk) is a PUBLIC scoped package on npm, so it installs like any dependency —
# `npm install` pulls it (and its runtime deps: mqtt / protobufjs / werift) from the registry, no auth,
# no build context, no sibling checkout. The pinned version lives in package.json; bump it there to move
# the bridge to a newer SDK release. Build with just:
#     docker build -t ha-eufy-sdk-bridge .
FROM --platform=$BUILDPLATFORM node:24-alpine AS sdk-backport
RUN apk add --no-cache git
WORKDIR /bridge-build
COPY scripts/build-sdk-backports.sh scripts/apply-sdk-pr235.mjs ./scripts/
RUN chmod +x ./scripts/build-sdk-backports.sh \
 && ./scripts/build-sdk-backports.sh /tmp/eufy-sdk-backports

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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Keep npm dependency metadata pinned to official eufy-sdk 0.2.0, but replace only
# its compiled dist/ with the reviewed P2P/push backports built above.
COPY --from=sdk-backport /tmp/eufy-sdk-backports/dist /tmp/eufy-sdk-dist
RUN rm -rf node_modules/@mega-yfue/eufy-sdk/dist \
 && cp -R /tmp/eufy-sdk-dist node_modules/@mega-yfue/eufy-sdk/dist \
 && rm -rf /tmp/eufy-sdk-dist

COPY server.mjs streams.mjs go2rtc-config.mjs ./
COPY src ./src
COPY bin ./bin
RUN chmod +x bin/start.sh && ln -sf /app/bin/start.sh /usr/local/bin/eufy-sdk-bridge

ENV BRIDGE_APP_DIR=/app BRIDGE_PORT=3000 BRIDGE_HOST=0.0.0.0 \
    GO2RTC_CONFIG=/app/data/go2rtc.yaml EUFY_SESSION=/app/data/.eufy-session.json
RUN mkdir -p /app/data
EXPOSE 3000 1984 8554 8555/udp

CMD [ "eufy-sdk-bridge" ]
