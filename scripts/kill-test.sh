#!/usr/bin/env bash
# Uses only local binaries and a new, isolated ClickHouse data directory.
set -euo pipefail
: "${KILL_TEST_MACHINE:?Set to the authorized test machine name; the script refuses any other machine}"
[[ "$(hostname -s)" == "$KILL_TEST_MACHINE" ]] || { echo 'Wrong test machine' >&2; exit 1; }
: "${OTELCOL_BINARY:?Path to the pinned Linux otelcol-contrib binary}"
: "${CLICKHOUSE_BINARY:?Path to the local ClickHouse 24.12.6.70 binary}"
: "${KILL_TEST_ROOT:?An existing disposable scratch directory outside the repo}"
exec python3 "$(dirname "$0")/kill-test.py" "$@"
