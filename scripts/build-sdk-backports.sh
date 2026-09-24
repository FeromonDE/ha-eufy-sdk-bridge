#!/bin/sh
set -eu

SDK_REPO="https://github.com/mega-yfue/eufy-sdk.git"
SDK_TAG="v0.2.0"
SDK_BASE_SHA="52e3c5d493f15c92ef8f5fd7531384669d2d7b05"

PR180_SHA="9408bfa8648f10faf8c2c310808d553ded46cdd3"
PR211_SHA="fa40f1bcb3ae2af6283433a387ce1e44affec205"
PR212_SHA="439d8d4f9c772be304129cdd1c5cfe500826dcd0"
PR234_SHA="c8060c4bbcf7e705b5abb48f702283231bfb8320"
PR235_SHA="62878f4868a3c126ebfb68a38ce4b16d57228449"

DEST="${1:-/tmp/eufy-sdk-backports}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

rm -rf "$DEST"
mkdir -p "$DEST"
git init -q "$DEST"
cd "$DEST"
git remote add origin "$SDK_REPO"

git fetch -q --depth=32 origin   "refs/tags/$SDK_TAG:refs/tags/$SDK_TAG"   "refs/pull/180/head:refs/remotes/origin/pr-180"   "refs/pull/211/head:refs/remotes/origin/pr-211"   "refs/pull/212/head:refs/remotes/origin/pr-212"   "refs/pull/234/head:refs/remotes/origin/pr-234"   "refs/pull/235/head:refs/remotes/origin/pr-235"

check_ref() {
  ref="$1"
  expected="$2"
  actual="$(git rev-parse "$ref^{commit}")"
  if [ "$actual" != "$expected" ]; then
    echo "Pinned SDK ref moved: $ref expected=$expected actual=$actual" >&2
    exit 1
  fi
}

check_ref "refs/tags/$SDK_TAG" "$SDK_BASE_SHA"
check_ref "refs/remotes/origin/pr-180" "$PR180_SHA"
check_ref "refs/remotes/origin/pr-211" "$PR211_SHA"
check_ref "refs/remotes/origin/pr-212" "$PR212_SHA"
check_ref "refs/remotes/origin/pr-234" "$PR234_SHA"
check_ref "refs/remotes/origin/pr-235" "$PR235_SHA"

git checkout -q --detach "refs/tags/$SDK_TAG"
git config user.name "Eufy SDK backport builder"
git config user.email "backport-builder@localhost"

merge_pr() {
  number="$1"
  if ! git merge -q --no-ff --no-edit "refs/remotes/origin/pr-$number"; then
    echo "SDK backport merge failed for PR #$number" >&2
    git status --short >&2 || true
    git diff -- src/transport/p2p/p2p-session.ts >&2 || true
    exit 1
  fi
}

# These four branches merge cleanly onto stable 0.2.0. PR #235 overlaps #211 in
# P2PSession.onMessage/onConnected, so its source is ported explicitly below instead
# of relying on a conflict-prone merge.
merge_pr 180
merge_pr 211

# PR #212 and #211 both insert constants next to STALE_RETRANSMIT_DEPTH.
# Resolve only that reviewed overlap; fail if Git reports anything else.
if ! git merge -q --no-ff --no-edit "refs/remotes/origin/pr-212"; then
  node "$SCRIPT_DIR/resolve-sdk-pr212.mjs" "$DEST"
  git add src/transport/p2p/p2p-session.ts src/transport/p2p/__tests__/data-reassembly.spec.ts
  git diff --cached --check
  git commit -q --no-edit
fi

merge_pr 234

node "$SCRIPT_DIR/apply-sdk-pr235.mjs" "$DEST"

# Run the original upstream PR #235 regression tests against the combined source.
git show "$PR235_SHA:src/transport/p2p/__tests__/path-liveness.spec.ts"   > src/transport/p2p/__tests__/path-liveness.spec.ts
git show "$PR235_SHA:src/transport/p2p/__tests__/live_stream.spec.ts"   > src/transport/p2p/__tests__/live_stream.spec.ts

npm ci --no-audit --no-fund

if [ "${SDK_BACKPORT_VERIFY:-0}" = "1" ]; then
  npm run verify
else
  npm run build
fi

echo "Built eufy-sdk 0.2.0 + PRs #180 #211 #212 #234 #235 at $DEST"
