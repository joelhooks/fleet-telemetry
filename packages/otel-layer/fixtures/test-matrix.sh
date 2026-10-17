#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm run build
for version in 4.0.1 4.0.5; do
  fixture="fixtures/consumer-$version"
  pnpm --dir "$fixture" install --ignore-workspace --frozen-lockfile --ignore-scripts --force
  pnpm --dir "$fixture" check
  pnpm --dir "$fixture" smoke
done
