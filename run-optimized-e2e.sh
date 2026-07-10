#!/usr/bin/env bash
#
# Build a throwaway, off-tree OPTIMIZED frontend in /tmp and run the full music
# e2e suite against it. The backend serves `frontend-dist/` in preference to the
# raw `frontend/` source (see backend/app.py), so we build off-tree and point a
# `frontend-dist` symlink at it -- the hermetic harness then exercises the real
# production build path (optimize.js opt() transforms + minifier + bundled lib).
#
# Why: serving `frontend/` straight hides optimizer/bundler regressions -- e.g.
# the class-field ASI bug where a minified `static props={...}` gets glued to the
# next member. This reproduces the deploy build so those regressions fail loudly.
#
# Usage:  ./run-optimized-e2e.sh [run-e2e args...]
# Exit code is non-zero if the build or any e2e suite fails.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

BUILD="$(mktemp -d "${TMPDIR:-/tmp}/mrepo-opt-e2e.XXXXXX")"
LINK="$REPO/frontend-dist"

cleanup() {
    [ -L "$LINK" ] && rm -f "$LINK"
    rm -rf "$BUILD"
}
trap cleanup EXIT

# Never clobber a real (non-symlink) frontend-dist -- someone may have a build there.
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
    echo "error: $LINK exists and is not a symlink; remove it before running this script" >&2
    exit 1
fi

echo "==> Optimizing + minifying frontend -> $BUILD"
node tools/optimize.js -i frontend -o "$BUILD" -m -s -x vendor,sw.js
( cd "$BUILD" && node spider-deps.js >/dev/null )

echo "==> Pointing frontend-dist -> $BUILD (backend auto-serves it)"
ln -s "$BUILD" "$LINK"

echo "==> Running music e2e (parallel, --only-errors) against the optimized build"
cd tests
node run-e2e.js --only-errors "$@"
