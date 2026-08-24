# ha-eufy-sdk-bridge: the SDK + the bridge daemon + go2rtc, in one image.
#
# go2rtc is a single static binary that does every media protocol we would otherwise hand-write
# (RTSP/WebRTC/MSE/HLS); bundling it means the user still installs exactly one thing.
#
# ── SDK sourcing ────────────────────────────────────────────────────────────────────────────────────
# The SDK (@mega-yfue/eufy-sdk) is a PRIVATE, scoped package; this bridge depends on it as
# `file:../eufy-sdk`. That resolves for local dev (sibling checkout) but not inside this build context,
# so the SDK source is supplied as a NAMED BUILD CONTEXT and built + packed here, then installed as a
# tarball (which also pulls its runtime deps: mqtt / protobufjs / werift). Build with:
#     docker build --build-context sdk=../eufy-sdk -t ha-eufy-sdk-bridge .
FROM node:24-alpine AS sdkbuild
WORKDIR /sdk
COPY --from=sdk package.json package-lock.json ./
RUN npm ci
COPY --from=sdk tsconfig.json tsconfig.build.json ./
COPY --from=sdk src ./src
RUN npm run build && mkdir -p /out && npm pack --pack-destination /out   # → /out/mega-yfue-eufy-sdk-<version>.tgz

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

# Install the bridge's deps: the SDK (as the packed tarball → pulls mqtt/protobufjs/werift) + ws.
COPY --from=sdkbuild /out/*.tgz /tmp/
COPY package.json ./
RUN npm pkg set "dependencies.@mega-yfue/eufy-sdk=file:$(ls /tmp/*.tgz)" \
 && npm install --omit=dev --no-audit --no-fund \
 && rm -f /tmp/*.tgz

COPY server.mjs streams.mjs go2rtc-config.mjs ./
COPY src ./src
COPY bin ./bin
RUN chmod +x bin/start.sh && ln -sf /app/bin/start.sh /usr/local/bin/eufy-sdk-bridge

ENV BRIDGE_APP_DIR=/app BRIDGE_PORT=3000 BRIDGE_HOST=0.0.0.0 \
    GO2RTC_CONFIG=/app/data/go2rtc.yaml EUFY_SESSION=/app/data/.eufy-session.json
RUN mkdir -p /app/data
EXPOSE 3000 1984 8554 8555/udp

CMD [ "eufy-sdk-bridge" ]
