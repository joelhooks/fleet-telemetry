# @fleet-telemetry/otel-layer

One Effect layer for fleet traces, logs and metrics. Telemetry is best effort. A missing or invalid endpoint disables export. A slow or dead collector does not change the application's result or error channel.

```ts
import { Effect } from "effect";
import { FleetTelemetry } from "@fleet-telemetry/otel-layer";

const instrumented = program.pipe(
  Effect.provide(FleetTelemetry.layer({ serviceName: "capture-cell" }))
);
// Or let the deployment supply OTEL_SERVICE_NAME and the endpoint:
const fromEnv = program.pipe(Effect.provide(FleetTelemetry.layerFromEnv()));
```

Provide the layer once at the application's outer boundary. `effect` is a peer dependency (`>=4.0.1 <5`), not a second runtime. The development pin is **4.0.5**. The built-package consumer matrix typechecks and runs against **4.0.1 and 4.0.5** without `skipLibCheck`. Later releases in the peer range are not verified until the matrix covers them.

## Configuration and identity

Arguments win over environment values. Blank resource strings count as missing. The resolution order is:

| Resource attribute | Argument | Environment, in order | Fallback |
| --- | --- | --- | --- |
| `service.name` | `serviceName` | `OTEL_SERVICE_NAME` | `unknown_service` |
| `service.version` | `serviceVersion` | `OTEL_SERVICE_VERSION` | `unknown` |
| `host.name` | `hostName` | `OTEL_HOST_NAME`, `HOSTNAME` | `unknown` |
| `deployment.environment` | `environment` | `DEPLOYMENT_ENVIRONMENT`, `OTEL_DEPLOYMENT_ENVIRONMENT`, `NODE_ENV` | `unknown` |
| `fleet.project` | `project` | `MUSTER_PROJECT` | `unknown` |
| `fleet.muster_row` | `musterRow` | `MUSTER_ROW` | `unknown` |
| `vcs.revision` | `revision` | `GIT_SHA` | `unknown` |
| `fleet.ratking_name` | `ratkingName` | `RATKING_NAME` | `unknown` |

`service.name` is always present. An unsafe name becomes `unknown_service`; other unsafe resource values are omitted. The resource passes through the same attribute filter as the signals and is frozen before export. No process execution, git command or host probing occurs.

**Production owners must set a stable service name.** Do not include a row, PID, timestamp or revision in it. The missing-service scanner must use the same name as the deployment. `unknown_service` is a diagnostic fallback, not an inventory identity.

`endpoint` overrides `OTEL_EXPORTER_OTLP_ENDPOINT`. There is no default endpoint and no vendor integration. An explicit empty endpoint disables export even when the environment has one. Only HTTP(S) base URLs without credentials, query strings or fragments are accepted. Signals go to `<base>/v1/traces`, `<base>/v1/logs` and `<base>/v1/metrics`. Redirects are refused and request credentials are omitted. Operators must configure an internal collector: URL validation is not an egress firewall. Nothing should leave our machines.

This package deliberately does **not** consume `OTEL_RESOURCE_ATTRIBUTES`, OTLP auth headers or signal-specific endpoints. That prevents arbitrary environment attributes and credentials from bypassing the filter.

| Argument           | Default       | Bound           |
| ------------------ | ------------- | --------------- |
| `bufferSize`       | 2,048 records | 1–65,536        |
| `exportIntervalMs` | 1,000 ms      | 1–86,400,000 ms |
| `exportTimeoutMs`  | 2,000 ms      | 1–2,000 ms      |

Non-finite or non-positive numeric settings use defaults. Fractions are rounded down and values above the maximum are clamped.

## Privacy boundary

Attribute filtering alone cannot stop prompt or customer data leaking through log bodies, span events or error messages. This layer filters those fields too.

| Allowlist | Accepted values | Notes |
| --- | --- | --- |
| OTEL namespaces in `semanticPrefixes` | Filtered primitives and short primitive arrays | Secret/content exclusions still apply. |
| Reviewed keys in `fleetAttributes` | Filtered primitives and short primitive arrays | Ordinary fleet attributes are a finite list. |
| `USAGE_COUNTER_KEYS` (listed below) | JavaScript integer numbers only | The same five keys as the collector; exports as OTLP `intValue`. |

`USAGE_COUNTER_KEYS` is exported from the package and from `FleetTelemetry`. It is a frozen list containing exactly:

- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`
- `gen_ai.usage.total_tokens`
- `gen_ai.usage.cached_input_tokens`
- `gen_ai.usage.reasoning_tokens`

These five keys are the only token-key exception. There is no `fleet.*_tokens` exception and no wildcard. Adding a usage key requires a coordinated collector and layer change. String-valued counts, numeric strings, fractions, non-finite values, booleans and arrays are dropped under `secret_key`. Every other key containing `token` is dropped under `secret_key`, even when its value is numeric. No string coercion occurs. Attribute keys remain limited to 128 lowercase characters.

- `semanticPrefixes` in `src/attributes.ts` declares the accepted OTEL semantic-convention namespaces. `fleetAttributes` declares the finite fleet key set. Both lists are frozen.
- Secret-shaped keys are dropped, case-insensitively: `token`, `key`, `secret`, `password`, `authorization`, `cookie`, `session`. Only the five integer-count keys above take precedence.
- Content-shaped keys are dropped: `prompt`, `body`, `message`, `content`, `email`, `stack`, `statement`, `query`, `command`, `args`, `user`, `customer`. Raw URLs, HTTP headers, client/peer addresses and source/executable paths are also blocked.
- String values are checked **before** truncation. JWTs, `sk-`/GitHub credential prefixes, bearer/basic credentials, hex runs of 32+ characters and base64-like runs of 40+ characters are dropped. Email-shaped values are dropped. Exact 7–64 character hex revisions are allowed **only** under `vcs.revision`.
- Remaining strings are truncated to 256 characters. Values must be finite numbers, booleans, strings, or arrays of at most 16 of those primitives. Nested objects are dropped. Each attribute set is limited to 64 entries.
- Log bodies are always `"<redacted>"`. A single identifier-shaped message becomes `event.name`; otherwise that name is redacted too. Severity and valid trace/span IDs remain. Production logging is additive: existing local loggers keep their own behavior and are outside this export boundary.
- Span names and event names must be static identifiers under 80 characters, using letters, digits, `_`, `.`, `:`, `-`, starting with a letter. This is intentionally stricter than free-text phrases. Event and link attributes use the same filter. A span keeps at most 32 events and 16 links. Invalid trace/link IDs are not exported.
- Causes, exception messages, stacks, metric descriptions and exemplars never enter the export buffer. Errors retain only a safe class/tag in `error.type`; callers can add the reviewed `fleet.error_code` attribute.
- Metrics keep native numeric conversion. Known UCUM units remain; common legacy time/byte unit names are normalized, and unknown unit text becomes `1`. Generated metric labels receive no bypass: native Frequency's literal `key` label and 4.0.1 summary's non-semconv `quantile` label are dropped.

The filter is conservative, not a customer-data classifier. Never put customer content into a permitted attribute such as `http.route`, an event name, a metric name or a frequency category. Use static route templates and bounded categories. Filtering can remove dimensions; do not rely on forbidden labels to distinguish metric series. In particular, do not use native Frequency categories or 4.0.1 summary quantile series for dashboards: their distinguishing labels are filtered out. Use counters with reviewed semantic labels, and use 4.0.5 for native Summary quantiles. Legacy summary count/sum series remain available.

To add a `fleet.*` attribute, edit `fleetAttributes` in `src/attributes.ts`, add retention and rejection tests, document its bounded values, and review its privacy implications. There is no caller-supplied bypass.

## Buffer, failures and shutdown

Span completion and log emission synchronously sanitize and offer a record to an Effect sliding queue. They never wait for HTTP. Overflow evicts the **oldest queued record**. Metrics enter the same queue when the scoped exporter snapshots the application's active metric registry.

One transport pass runs at a time, including explicit flushes. It drains existing traces/logs first, snapshots metrics, then drains again, so a small buffer's metric snapshot cannot evict the spans already waiting for that pass. A drained batch is bounded by `bufferSize`; another `bufferSize` records may queue while that batch is in flight. The bound counts records, not bytes. Application metric registries, histogram buckets and frequency cardinality remain the application's responsibility.

The lifecycle is `disabled`, or `active.sleeping → active.exporting → active.sleeping`; scope closure transitions to `closed` and interrupts the worker. There are no detached workers, retries, persistence or final network flush. Closing counts and discards pending records instead of waiting for the collector. Transport errors, HTTP failures, response-body hangs, timeouts, interrupted exports and unexpected converter/encoder defects are counted. They never enter the application's error channel. Acquisition defects fall back to a no-op production layer.

For an intentional best-effort flush, opt in explicitly:

```ts
const telemetry = yield * FleetTelemetry.Service;
yield * telemetry.flush;
const counters = yield * telemetry.counters;
```

`flush` waits at most the configured timeout for the whole pass, including waiting for another pass. It does not guarantee delivery or flush everything produced concurrently. A cancelled batch is counted as dropped. Normal tracing and logging never call it.

The same counters are available locally and through cumulative OTLP metrics:

- `fleet.telemetry.attributes_dropped`, with `fleet.drop_class` from the finite classes `secret_key`, `content_key`, `not_allowed`, `credential_value`, `invalid_value`, `limit`, `free_text`. It never includes the dropped key or value. A redacted name or cause counts as `free_text`.
- `fleet.telemetry.items_dropped`, including queue overflow, failed exports and closure loss.
- `fleet.telemetry.exports_failed`, per failed HTTP export, including timeout/interruption.

Active layers register these counters at startup, so the first metric snapshot includes explicit zeros before any drops or export failures. Attribute-drop counters use only the seven `fleet.drop_class` values listed above; the other two counters have no labels. Drops found while filtering resources are included in the first snapshot rather than replaced with zero. Disabled layers register no metrics.

`Service.counters` also exposes queued and exported record counts. Drops discovered during metric sanitization appear in the next metric snapshot. Counters remain readable locally while the collector is unavailable; remote counts require a later successful export. The layer uses the consumer's metric registry, so it sees metrics registered before and after layer acquisition.

## Test layer

`FleetTelemetry.layerTest` captures sanitized wire records without a network client. Every layer build gets fresh state. `layerTestWith(options)` lets tests specify resources and capacity; any supplied endpoint is ignored. Its shared in-memory capture buffer is bounded and drops oldest records too.

```ts
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FleetTelemetry } from "@fleet-telemetry/otel-layer";

it.effect("proves its span", () =>
  Effect.gen(function* proveSpan() {
    const captured = yield* FleetTelemetry.TestService;
    yield* Effect.void.pipe(Effect.withSpan("mail.deliver"));
    expect(yield* captured.findSpan("mail.deliver")).toBeDefined();
    expect(captured.resource["service.name"]).toBe("test-service");
  }).pipe(Effect.provide(FleetTelemetry.layerTest))
);
```

`TestService` exposes `spans`, `logs`, `metrics`, `findSpan(name)`, `clear`, `resource`, `counters` and `flush`. Reading `metrics` triggers a native metric snapshot. Use an isolated `Metric.MetricRegistry` in tests that need exact metric counts. Capture helpers return the same filtered shapes that the HTTP encoder uses; test mode replaces loggers to avoid emitting fixture content to the console.

## Effect adapter and version gate

Effect 4 provides OTLP through **`effect/observability`**, not the older suggested `effect/unstable/observability` path. We use its OTLP resource/value conversion and metrics snapshot converter with an immediate in-memory HTTP adapter. Trace/log hooks use Effect's public tracer/logger interfaces and map only the permitted fields into the native OTLP types. JSON export uses Effect's HTTP body/client modules. There are no runtime dependencies besides the Effect peer.

We do **not** use the native `OtlpExporter` for real network traffic. Its `maxBatchSize` triggers exports; it is not a hard memory capacity or a drop-oldest policy. Its array buffer, batch-triggered export fibers, retries and shutdown flush do not provide this package's contract. The native metrics converter only calls our immediate in-memory adapter. The package-owned bounded queue and single transport pass own actual HTTP.

`src/effect-bridge.ts` isolates the native wire shapes and conversion. The exact source used for review is `effect@4.0.5`. `test/layer.test.ts` fails if the development pin moves without review. Both isolated consumers exercise the bridge against their exact Effect versions, including counters, histograms and summaries. Effect 4.0.1 produces legacy summary Sum series; 4.0.5 produces OTLP Summary records and normalizes units. The adapter accepts both shapes. No API introduced after 4.0.1 is required. Never use Alchemy's telemetry layer here.

Run the gates from the workspace root:

```sh
pnpm --filter @fleet-telemetry/otel-layer check
pnpm --filter @fleet-telemetry/otel-layer test
pnpm --filter @fleet-telemetry/otel-layer test:matrix
pnpm exec oxlint packages/otel-layer
pnpm exec oxfmt --check packages/otel-layer
```

The matrix builds the package, installs it as a file dependency in isolated 4.0.1/4.0.5 consumers, runs `tsc --noEmit`, then runs each smoke test. Both tests capture a real Effect span/log/metric and verify that a closed local collector preserves latency and the original typed error object. The main suite also starts a deliberately hanging local server and verifies cancellation and timeout counters. No test contacts a real collector.

## Consumer wiring contract

The first consumers are **celld, the Rat King mailbox, Mischief, Muster, the priority controller and capture-cell**. Each owner must:

1. Declare one stable `service.name` in code or deployment configuration and register that exact value in the missing-service inventory.
2. Provide this layer once, configure the internal collector endpoint and supply version/project/row/revision/Rat King identity where available.
3. Prove one representative operation with `layerTest` and keep names/attributes static and content-free.
4. Run the 24-hour real-data attribute audit after wiring. Review dropped-class counts as well as retained attributes. This package's localhost tests are not that audit.

Wiring those services, deploying the collector, applying database DDL and proving the live 24-hour audit are separate owner actions. This package never creates tables or deploys infrastructure. Rollback is removing the provider or unsetting the endpoint.
