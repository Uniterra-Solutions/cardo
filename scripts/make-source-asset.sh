#!/usr/bin/env bash
# Package the release source asset: the complete source tree INCLUDING the
# build artifacts the release workflow just produced (dist/lib) plus the
# `.uniterra-prebuilt` marker, tarred as `uniterra-src-<tag>.tar.gz` with the
# `uniterra-<tag>` root dir (the CLI's findSourceRoot contract). The CLI then
# skips `pnpm run build` on the user's machine.
#
# Usage: scripts/make-source-asset.sh <tag>   # e.g. v0.8.0
# Prints the asset filename. Excludes .git / node_modules / any asset from a
# previous run — the auto-generated archives never carried node_modules, and
# dependencies are installed on the user's machine.
set -euo pipefail

TAG="${1:?usage: make-source-asset.sh <tag> (e.g. v0.8.0)}"
cd "$(dirname "$0")/.."

ASSET="uniterra-src-${TAG}.tar.gz"
ROOT="uniterra-${TAG}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Copy the working tree (built artifacts included) without VCS metadata,
# installed deps, or a stale asset from a re-run in the same checkout.
mkdir -p "$STAGE/$ROOT"
tar -cf - \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='uniterra-src-*.tar.gz' \
  . | tar -xf - -C "$STAGE/$ROOT"

printf '%s\n' "$TAG" > "$STAGE/$ROOT/.uniterra-prebuilt"

tar -czf "$ASSET" -C "$STAGE" "$ROOT"
printf '%s\n' "$ASSET"
