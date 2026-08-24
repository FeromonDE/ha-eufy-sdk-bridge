#!/usr/bin/env bash
# Build and push the bridge image as a MULTI-ARCH manifest to GitHub Container Registry.
#
# Why this exists: the add-on (ha-eufy-sdk-addon) builds FROM this image on aarch64 / armv7 / amd64
# (Home Assistant OS runs on Raspberry Pi as often as on x86), so a single-arch `docker build … && push`
# leaves ARM installs unable to resolve the base. `docker buildx --platform …` produces one manifest
# that carries all three; the Dockerfile already selects the go2rtc binary by TARGETARCH, so no
# per-arch edits are needed here.
#
# Prerequisites:
#   - Docker with buildx (Docker 20.10+).
#   - Logged in to ghcr.io:  echo "$GHCR_PAT" | docker login ghcr.io -u <user> --password-stdin
#     (the PAT needs `write:packages`.)
#   - The SDK sibling checkout at ../eufy-sdk (supplied as the `sdk` named build context — the bridge
#     depends on it as file:../eufy-sdk, which does not resolve inside the build otherwise).
#
# Usage:
#   scripts/publish-multiarch.sh              # version from package.json, tags :<version> + :latest
#   scripts/publish-multiarch.sh 0.1.36       # explicit version
#   PLATFORMS=linux/amd64,linux/arm64 scripts/publish-multiarch.sh   # override the platform set
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="ghcr.io/mega-yfue/ha-eufy-sdk-bridge"
SDK_DIR="${SDK_DIR:-../eufy-sdk}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64,linux/arm/v7}"
VERSION="${1:-$(node -p "require('./package.json').version")}"

if [ ! -f "${SDK_DIR}/package.json" ]; then
  echo "error: SDK checkout not found at ${SDK_DIR} (set SDK_DIR=… to point at it)" >&2
  exit 1
fi

# A dedicated builder so the host's default (often the docker driver, which can't do multi-platform)
# is left untouched. Reuse it across runs.
if ! docker buildx inspect eufy-multiarch >/dev/null 2>&1; then
  docker buildx create --name eufy-multiarch --driver docker-container >/dev/null
fi

echo "Building ${IMAGE}:${VERSION} (+ :latest) for ${PLATFORMS}"
docker buildx build \
  --builder eufy-multiarch \
  --platform "${PLATFORMS}" \
  --build-context "sdk=${SDK_DIR}" \
  --tag "${IMAGE}:${VERSION}" \
  --tag "${IMAGE}:latest" \
  --push \
  .

echo "Pushed ${IMAGE}:${VERSION} and ${IMAGE}:latest"
echo "Verify:  docker buildx imagetools inspect ${IMAGE}:${VERSION}"
