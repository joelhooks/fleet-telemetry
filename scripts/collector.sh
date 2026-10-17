#!/bin/sh
# Mandatory for both validate and run: bare :4317 would bind all interfaces.
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
# Arguments: pinned binary path, then its normal command/flags.
: "${1:?Usage: collector.sh BINARY [validate] --config CONFIG}"
exec "$@"
