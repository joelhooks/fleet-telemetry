#!/bin/sh
# Mandatory for validate and run: refuse unsafe binds and occupied loopback ports.
set -eu
: "${OTEL_TAILNET_BIND:?OTEL_TAILNET_BIND must be an explicit non-wildcard IPv4 address distinct from loopback}"
if ! printf '%s\n' "$OTEL_TAILNET_BIND" | /usr/bin/awk -F. '
  NR != 1 || NF != 4 { exit 1 }
  { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i > 255 || length($i) > 3) exit 1 }
  $1 == 0 || ($1 == 127 && $2 == 0 && $3 == 0 && $4 == 1) { exit 1 }
'; then
  printf '%s\n' 'OTEL_TAILNET_BIND must be an explicit non-wildcard IPv4 address distinct from loopback' >&2
  exit 1
fi
grpc_port=${OTEL_LOOPBACK_GRPC_PORT:-4317}
http_port=${OTEL_LOOPBACK_HTTP_PORT:-4318}
validate_port() {
  if ! /usr/bin/awk -v port="$2" -v other="$3" \
    -v health="${OTEL_HEALTH_PORT:-13133}" -v metrics="${OTEL_METRICS_PORT:-8888}" '
    BEGIN { if (port !~ /^[1-9][0-9]*$/ || port < 1024 || port > 65535 || port + 0 == other + 0 || port + 0 == health + 0 || port + 0 == metrics + 0) exit 1 }
  '; then
    printf '%s\n' "$1 must be an integer from 1024 to 65535, distinct from the other loopback, health and metrics ports" >&2
    exit 1
  fi
}
validate_port OTEL_LOOPBACK_GRPC_PORT "$grpc_port" "$http_port"
validate_port OTEL_LOOPBACK_HTTP_PORT "$http_port" "$grpc_port"
# Use system lsof on macOS/Linux, not a shell-profile PATH or a new runtime.
if [ -x /usr/sbin/lsof ]; then
  lsof=/usr/sbin/lsof
elif [ -x /usr/bin/lsof ]; then
  lsof=/usr/bin/lsof
else
  printf '%s\n' 'Collector preflight requires system lsof to check loopback ports' >&2
  exit 1
fi
check_available() {
  status=0
  listeners=$("$lsof" -nP -w -b -a -iTCP:"$2" -sTCP:LISTEN -Fn 2>&1) || status=$?
  if [ "$status" -gt 1 ] || { [ "$status" -eq 1 ] && [ -n "$listeners" ]; }; then
    printf '%s\n' "Collector preflight could not inspect $1 with lsof: $listeners" >&2
    exit 1
  fi
  # A service on another concrete interface is not a loopback conflict.
  # Wildcard IPv4/IPv6 listeners are treated conservatively as conflicts.
  if printf '%s\n' "$listeners" | /usr/bin/awk -v port="$2" '
    $0 == "n127.0.0.1:" port || $0 == "n0.0.0.0:" port || $0 == "n*:" port || $0 == "n[::]:" port { found = 1 }
    END { exit !found }
  '; then
    printf '%s\n' "$1: port in use at 127.0.0.1:$2; choose a free OTEL_LOOPBACK_GRPC_PORT/OTEL_LOOPBACK_HTTP_PORT pair" >&2
    exit 1
  fi
}
check_available OTEL_LOOPBACK_GRPC_PORT "$grpc_port"
check_available OTEL_LOOPBACK_HTTP_PORT "$http_port"
# Arguments: pinned binary path, then its normal command/flags.
: "${1:?Usage: collector.sh BINARY [validate] --config CONFIG}"
exec "$@"
