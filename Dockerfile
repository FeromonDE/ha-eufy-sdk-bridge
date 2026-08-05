# ha-eufy-sdk-bridge: the SDK + the bridge daemon + go2rtc, in one image.
#
# go2rtc is a single static binary that does every media protocol we would otherwise hand-write
# (RTSP/WebRTC/MSE/HLS); bundling it means the user still installs exactly one thing.
#
# ── SDK sourcing (wire-later) ─────────────────────────────────────────────────────────────────────
# The SDK (eufy-mega) is a PRIVATE repo and this bridge depends on it as `file:../eufy-mega`. That
# resolves for local dev (sibling checkout) but not inside this build context. Until the SDK is
# published or a build secret is wired, provide it by building with the SDK vendored next to this repo,
# e.g. from a parent dir that holds both:
#     docker build -f ha-eufy-sdk-bridge/Dockerfile --build-context sdk=./eufy-mega ha-eufy-sdk-bridge
# The `COPY --from=sdk` below consumes that named build context.
FROM node:24-alpine AS sdk
WORKDIR /sdk
# `--build-context sdk=../eufy-mega` supplies the SDK source here.
COPY --from=sdk . .
RUN npm ci && npm run build

FROM node:24-alpine
RUN apk add --no-cache ffmpeg curl
WORKDIR /app

# go2rtc — pin the version so an image rebuild cannot change media behaviour. Select the binary by
# TARGETARCH (Docker BuildKit sets it) so the image builds on arm64 (Raspberry Pi / HA OS) too, not
# just amd64 — the bug the first bridge had.
ARG GO2RTC_VERSION=1.9.9
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) g2="go2rtc_linux_amd64" ;; \
      arm64) g2="go2rtc_linux_arm64" ;; \
      arm) g2="go2rtc_linux_arm" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH:-<unset — use BuildKit>}" && exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/go2rtc \
      "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/${g2}" \
 && chmod +x /usr/local/bin/go2rtc

# The SDK, built in the first stage, dropped in as a resolvable bare dependency.
COPY --from=sdk /sdk/dist ./node_modules/eufy-mega/dist
COPY --from=sdk /sdk/package.json ./node_modules/eufy-mega/package.json

# Bridge deps (ws) + source. The SDK file: dep is already satisfied above, so omit it here.
COPY package.json ./
RUN npm install --omit=dev --no-package-lock ws@^8.18.0
COPY server.mjs streams.mjs go2rtc-config.mjs ./
COPY bin ./bin
RUN chmod +x bin/start.sh && ln -sf /app/bin/start.sh /usr/local/bin/eufy-sdk-bridge

ENV BRIDGE_APP_DIR=/app BRIDGE_PORT=3000 BRIDGE_HOST=0.0.0.0 \
    GO2RTC_CONFIG=/app/data/go2rtc.yaml EUFY_SESSION=/app/data/.eufy-session.json
RUN mkdir -p /app/data
EXPOSE 3000 1984 8554 8555/udp

CMD [ "eufy-sdk-bridge" ]
