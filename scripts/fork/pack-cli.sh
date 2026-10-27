#!/usr/bin/env bash
#
# Fork-only (maxfangx): pack the npm packages behind the `paseo` CLI and
# daemon as tarballs. Fork releases ship them beside the macOS app, so hosts
# without the app (Linux) run the fork's CLI and daemon rather than
# upstream's npm release.
#
# Usage: scripts/fork/pack-cli.sh <out-dir>
#
# Same packages and order as the root `release:publish` script. Each
# package's prepack script builds it, so this needs no separate build.

set -euo pipefail

cd "$(dirname "$0")/../.."

OUT_DIR="${1:?usage: scripts/fork/pack-cli.sh <out-dir>}"
mkdir -p "$OUT_DIR"

for pkg in highlight relay protocol client plugin server cli; do
  npm pack --workspace="@getpaseo/$pkg" --pack-destination "$OUT_DIR"
done
