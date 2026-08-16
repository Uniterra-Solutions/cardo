#!/usr/bin/env bash
# Build and run the Cardo CLI-flow verification container.
#
# Usage: scripts/verify-cli-container/run.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

docker build -f scripts/verify-cli-container/Dockerfile -t cardo-cli-verify .
docker run --rm cardo-cli-verify
