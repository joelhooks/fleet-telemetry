#!/usr/bin/env bash
# Fail if packages/otel-layer/dist differs from a fresh build of src.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="$root/packages/otel-layer"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$pkg" && pnpm exec tsc -p tsconfig.build.json --outDir "$tmp/dist")
if ! diff -r "$tmp/dist" "$pkg/dist" >"$tmp/diff" 2>&1; then
  cat "$tmp/diff" >&2
  echo "ERROR: packages/otel-layer/dist is out of date. Run 'pnpm --filter @fleet-telemetry/otel-layer build' and commit dist/." >&2
  exit 1
fi
echo "otel-layer dist matches src"
