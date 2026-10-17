# Fleet collector

A pinned `otelcol-contrib` receives OTLP traces, logs and metrics, writes requests to a disk queue, then exports to ClickHouse. Alchemy manages the macOS user LaunchAgent. It does not create a database or table.

## Pins and schema review

- Collector: **0.163.1**, darwin-arm64 for deployment, linux-amd64 for the local proof.
- ClickHouse exporter: **0.163.0**, as listed in the collector distribution's [manifest](https://github.com/open-telemetry/opentelemetry-collector-releases/blob/v0.163.1/distributions/otelcol-contrib/manifest.yaml).
- ClickHouse compatibility proof: **24.12.6.70**.
- Alchemy: **2.0.0-beta.83**. Effect and Node platform: **4.0.5**.

`plans/clickhouse-otel-ddl.sql` renders the exporter's own [SQL templates](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.163.0/exporter/clickhouseexporter/internal/sqltemplates): logs, traces, trace-ID timestamp lookup, its materialized view, and five metric tables. Every physical table has a 30-day TTL. It uses Map attributes, MergeTree and the fallback indexes supported by ClickHouse 24.12, not the newer full-text indexes or JSON columns.

Review this plan before an operator applies it to database `otel`. Never apply it to an existing event database. Neither Alchemy nor the collector applies DDL. The kill test is the only code that applies the plan, and it starts its own disposable local database first.

To verify the plan still matches the pinned upstream templates without connecting to ClickHouse:

```sh
python3 scripts/render-clickhouse-ddl.py --check
```

## Queue and delivery boundary

Each signal has a **20 GiB serialized-payload cap**, configured with `sizer: bytes` and `OTEL_QUEUE_BYTES` (default `21474836480`). The same cap applies independently to traces, logs and metrics: **60 GiB aggregate** at the default, before storage overhead and logs. Set a smaller per-signal budget from the deployment host's free disk space, allowing headroom for all three queues. A larger request cannot bypass this cap: an offer that exceeds remaining capacity is rejected.

The pinned exporterhelper supports bytes with persistent storage. Its [persistent queue reports `metadata.BytesSize`](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.163.0/exporter/exporterhelper/internal/queue/persistent_queue.go#L132-L135), and its [offer path checks active size against capacity before storage](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.163.0/exporter/exporterhelper/internal/queue/persistent_queue.go#L269-L287). A stale comment in the config validator mentions request-only sizing; the implementation and actual recovery proof support bytes.

This is a **payload byte cap, not a filesystem quota**. The storage database also needs metadata and free pages, can retain its high-water file size after draining, and shares disk with logs. `OTEL_QUEUE_BYTES` therefore must be comfortably below one third of the space available to this collector. Alert on free disk space and queue utilization before enabling fleet traffic. There is no automatic deletion of queued data.

The old 250,000-request limit had no byte cap. The ten-minute proof measured a weighted mean of **7,239.67 serialized bytes per queued request**, versus 41,780.33 HTTP JSON bytes per ingress request. Its per-signal means give this sizing example for the old request limit:

| Signal | Mean serialized bytes/request | 250,000 requests at that mean |
| --- | ---: | ---: |
| Traces | 12,549 | 2.922 GiB |
| Logs | 6,889 | 1.604 GiB |
| Metrics | 2,281 | 0.531 GiB |

That is **5.057 GiB aggregate payload** for these request shapes, before overhead. At the proof's peak, 13,031,400 payload bytes occupied queue files with 29,360,128 bytes of logical file length (28 MiB) and 16,076,800 allocated bytes (15.33 MiB). These are measurements, not a universal storage-overhead ratio. `docs/collector-fix-proof.json` records the full figures and source hashes.

There is **no finite worst-case disk bound derivable from a request limit and a mean size alone**. Requests can grow. The new byte cap, not that estimate, enforces the payload limit. At roughly 220,000 events per day, provision a 24-hour budget from measured serialized bytes per day rather than assuming every event has a fixed size.

`file_storage` uses `fsync: true`. Batching happens in `sending_queue.batch`, **after persistent enqueue**, rather than in a volatile `batch` processor. This is supported by the pinned [exporterhelper queue batcher](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.163.0/exporter/exporterhelper/internal/queuebatch/config.go). The memory limiter runs first. The queue does not wait for export results or block on overflow. A full queue, memory pressure, invalid telemetry or a disk error can still cause ingress rejection. Callers must handle OTLP errors.

Retries have no elapsed-time limit. `async_insert: false` requires a ClickHouse insert acknowledgment instead of accepting only an asynchronous server buffer. Delivery is **at least once**, not exactly once: an acknowledgment lost after an insert can produce duplicates on retry.

The no-loss proof is scoped to **successful collector ingress through disk queue recovery and ClickHouse delivery during the tested outage**. It does not cover producers that drop data before sending, rejected ingress, exhausted disk, corrupted storage or permanent server-side errors. In particular, celld can drop events beyond its own bounded 8,192-event channel before collector ingress. The proof verifies exact counts for its controlled run, not universal exactly-once delivery.

## Privacy

The collector deletes case-insensitive secret-shaped attribute keys containing token, key, secret, password, authorization, cookie, prompt, body or message, with five **integer-only** exceptions:

- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`
- `gen_ai.usage.total_tokens`
- `gen_ai.usage.cached_input_tokens`
- `gen_ai.usage.reasoning_tokens`

Each context clears a temporary cache, saves only integer values for those exact keys, deletes secret-shaped keys, restores the approved counters, and removes the cache. The exporter stores attributes in `Map(String, String)`, so persisted counter values are string representations of validated integers. Strings, floats, booleans and unlisted keys such as `foo_tokens` remain subject to deletion. There is no wildcard token exception and no experimental feature gate. The producer layer currently generates no `fleet.usage.*_tokens` attributes; review an explicit key before adding one to the collector's list.

The filter also drops URL-shaped keys, including `url.full`, `http.url`, `http.target`, `url.query` and `url.path`, rather than retaining IDs in paths. It strips query suffixes from other string attribute values. Resource, scope and span-event maps receive the same treatment. Log bodies become `<redacted>` and span status messages become empty strings. Put a short, stable event name in **`event.name`**, which survives these filters.

`redaction-fixture.json` contains a celld-shaped console log, token-bearing URLs, `api_token="x"`, an integer `foo_tokens`, and all five approved integer counters including `gen_ai.usage.input_tokens=123`. The kill test alternates integer and string-valued usage records to detect cache leakage. It checks span, span-event, log, all five metric datapoint types, resource and available scope columns for retained counters and removed secrets, plus stripped query strings, redacted bodies and preserved `event.name`.

This is defense in depth, not a replacement for a producer-side attribute allowlist. Do not send secrets, arbitrary payloads, customer data, prompts, dynamic span names or nested untrusted structures. The filtering contract covers the tested attribute maps; it is not a general sanitizer for every possible OTLP field, nested map, link or exemplar.

## Configuration

The collector expands `${env:...}` itself. Alchemy forwards the deployment values into the plist; an interactive shell's environment is not automatically inherited by launchd.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLICKHOUSE_ENDPOINT` | required | HTTP or native endpoint reachable by this collector. No embedded credentials. |
| `CLICKHOUSE_USERNAME` | `default` | ClickHouse user with INSERT permission on reviewed `otel` tables. |
| `CLICKHOUSE_PASSWORD` | empty | Optional credential, passed as an Effect `Redacted` value to the resource. |
| `OTEL_COLLECTOR_HOST` | required | Operator-selected collector identity, added as `collector.host`. |
| `OTEL_TAILNET_BIND` | required, no fallback | Explicit approved private IPv4 address for the second OTLP receiver. Loopback remains enabled independently. |
| `OTEL_QUEUE_BYTES` | `21474836480` (20 GiB) | Serialized payload cap **per signal**, not a filesystem quota. Three signals allow 60 GiB aggregate at the default. |
| `OTEL_DATA_DIR` | `$HOME/.local/share/fleet-telemetry` in the stack | Persistent queue and collector logs. Retain across redeploys. Required for standalone collector execution. |
| `HOME` | user's environment | LaunchAgent and versioned binary location. |

Standalone config also supports `OTEL_GRPC_PORT` (4317), `OTEL_HTTP_PORT` (4318), `OTEL_HEALTH_BIND` (loopback), `OTEL_HEALTH_PORT` (13133), and `OTEL_METRICS_PORT` (8888). These are proof overrides, not exposed stack props. Health and internal metrics stay loopback-only by default.

Both OTLP receivers feed all three pipelines. `otlp` binds loopback; `otlp/tailnet` binds `OTEL_TAILNET_BIND`, with the same gRPC and HTTP ports. There is no Serve hop and no extra LaunchAgent right is needed to bind the private interface. The second address is mandatory, even during validation. Alchemy checks the input and launches through `scripts/collector.sh`, which refuses missing, wildcard, malformed or colliding addresses **before executing the collector**. Always use this wrapper: bare env interpolation can turn a missing host into `:4317`, an unsafe all-interfaces bind.

The unauthenticated second receiver belongs only on the approved, access-controlled private network. Do not expose it to the internet or use `0.0.0.0`. The health endpoint reports process health, **not** ClickHouse availability or completed delivery.

## Deploy: operator review required

Deployment requires macOS arm64, a logged-in GUI user session and the reviewed ClickHouse schema. The Linux proof does not prove launchd integration; run the readback below during the approved macOS deployment.

1. List all listening ports and resolve conflicts before choosing the bind address. The standard OTLP ports may already be occupied.
2. Review the DDL, collector config and Alchemy plan. Confirm the endpoint, database `otel`, user permissions and free disk capacity. Keep credentials out of source files, shell history and plan artifacts.
3. Use the same checkout, working directory and stage for plan, deploy and destroy. Keep it in place: the LaunchAgent uses absolute config and preflight paths in this checkout. Alchemy hashes both files into the agent props so changes restart it.
4. Set the variables above through the approved local secret/environment mechanism, then:

```sh
umask 077
pnpm install --frozen-lockfile
cd apps/infra
# Disable this CLI invocation's own vendor telemetry; it is not our telemetry layer.
ALCHEMY_TELEMETRY_DISABLED=1 pnpm exec alchemy plan --stage local --no-input
# Only after plan and schema approval:
ALCHEMY_TELEMETRY_DISABLED=1 pnpm exec alchemy deploy --stage local --no-input
launchctl print "gui/$(id -u)/com.fleet-telemetry.collector"
```

Readback must contain `state = running`. Check the collector health endpoint and internal metrics with the configured loopback ports. Send one synthetic trace and log, then confirm them in the reviewed `otel` tables. Verify `otelcol_exporter_queue_size` returns to zero and the send-failure counters stop increasing. A running LaunchAgent alone is not delivery proof.

The binary installer downloads the pinned release and its `.sha256` file. Both must match the SHA-256 embedded in `src/collector-binary.ts`. Installation is atomic under `$HOME/.local/opt/otelcol-contrib/0.163.1/`. Later reconciles verify the installed binary hash and avoid downloading it again. A changed or unverified installation fails closed rather than overwriting it.

`LaunchdAgent` is generic: label, arguments, environment, paths, KeepAlive and ThrottleInterval. It owns only its marked plist, writes mode 600, boots out before bootstrapping, and refuses unmanaged plists. It does not contain collector logic. Plists and local Alchemy state can contain credentials; `Redacted` hides display, **not storage**. Keep `umask 077`, protect local state, and never publish either file.

## Point a service at it

Set the service's OTLP exporter endpoint to the collector's approved private address using `OTEL_EXPORTER_OTLP_ENDPOINT`. Use `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` for HTTP on port 4318, or `grpc` on port 4317. Standard HTTP exporters append `/v1/traces`, `/v1/logs` and `/v1/metrics` to the base endpoint. A signal-specific endpoint must include its signal path. Use a stable `service.name` and the shared producer layer's attribute allowlist. Do not connect Alchemy's own `Telemetry/Layer` to this collector.

## Rollback

From the same `apps/infra` directory and stage:

```sh
ALCHEMY_TELEMETRY_DISABLED=1 pnpm exec alchemy destroy --stage local --no-input
```

Destroy unloads the agent and removes its owned plist. It preserves the disk queue, logs, database and verified versioned binaries. This is intentional: never destroy queued data to roll back a process. For an emergency unload without editing Alchemy state:

```sh
launchctl bootout "gui/$(id -u)/com.fleet-telemetry.collector"
```

Redeploy to reload it. Restore a previously reviewed checkout and deploy to roll back config or code. Review exporter/storage compatibility before changing collector versions while a queue exists.

## Proof and gates

Run the outage proof only on the assigned Linux test worker, never on a deployment host. Docker socket access is not required: install a local ClickHouse 24.12.6.70 binary and a checksum-verified linux-amd64 collector 0.163.1 in disposable scratch. The script constructs a new local endpoint and data directory. It never accepts an existing ClickHouse URL.

```sh
# Export KILL_TEST_MACHINE to the authorized test machine name out of band.
# OTELCOL_BINARY and CLICKHOUSE_BINARY point to the pinned local executables.
# KILL_TEST_ROOT is an existing private scratch directory outside this repo.
scripts/kill-test.sh
```

The proof first sends a full request of each signal through **each** HTTP receiver. The second receiver uses a separate local loopback address as a stand-in, never a real network interface. It then stops ClickHouse for **600 seconds** while sending 20 spans, 20 logs and one point of each of five metric types every second. It measures sender latency, serialized queue bytes and physical storage sizes, SIGKILLs the collector, recovers exactly the same queued bytes while ClickHouse remains down, restores ClickHouse, and verifies counts, unique span IDs, the redaction fixture and integer-only usage counters. It also verifies that each queue reports the configured byte capacity. All owned processes stop on completion or failure. Evidence remains in a new `kill-test-*` directory; preserve `result.json`, then reversibly trash disposable data. `--outage-seconds 5` is a smoke test, not the acceptance proof.

Code gates:

```sh
pnpm --filter @fleet-telemetry/infra check
pnpm exec oxlint apps
pnpm --filter @fleet-telemetry/infra test
python3 scripts/render-clickhouse-ddl.py --check
# With the required env values set; validation resolves the template:
scripts/collector.sh "$OTELCOL_BINARY" validate --config apps/collector/collector.yaml
```

Set `FLEET_TEST_ROOT` to disposable scratch for resource tests. Set `COLLECTOR_TEST_ARCHIVE` to the real darwin-arm64 release archive to run the optional real-archive installation/idempotence test on Linux without executing the macOS binary. Fake launchctl tests cover lifecycle calls and file modes, not actual macOS service behavior.
