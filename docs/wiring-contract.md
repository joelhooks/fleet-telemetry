# Fleet telemetry wiring contract

For service owners lighting a service on the fleet collector. The collector is live; your part is the steps below.

## 1. Add the layer

`@fleet-telemetry/otel-layer` (this repo, `packages/otel-layer`). `effect` is a peer: `>=4.0.1 <5`. Both 4.0.1 and 4.0.5 are tested.

```ts
import { FleetTelemetry } from "@fleet-telemetry/otel-layer";

program.pipe(Effect.provide(FleetTelemetry.layer({ serviceName: "your-service" })));
// or FleetTelemetry.layerFromEnv() with OTEL_SERVICE_NAME set by the deployment
```

Until there is a package release, depend on it from this repo by path or git, pinned to a commit.

## 2. Point it at the collector

There is no default endpoint; with none set, the layer is a no-op.

| Where the service runs | `OTEL_EXPORTER_OTLP_ENDPOINT` |
| --- | --- |
| The collector host itself | `http://127.0.0.1:14318` |
| Any other fleet machine | `http://<collector host tailnet name>:4318` |

OTLP/HTTP only. Never a vendor endpoint. Nothing leaves our machines.

## 3. Name the service once, stably

- Set one `service.name` per service (argument or `OTEL_SERVICE_NAME`). Don't put rows, PIDs, timestamps or revisions in it.
- Tell the desk the exact name. It goes in the who's-dark inventory, which flags expected services that send nothing.
- Optional resource attributes come from env: `MUSTER_PROJECT`, `MUSTER_ROW`, `GIT_SHA`, `RATKING_NAME`.

## 4. What gets dropped (by design)

The layer drops these at the source, and the collector drops them again:

- Secret-shaped keys (`token`, `key`, `secret`, `password`, `authorization`, `cookie`, `session`).
- Content-shaped keys (`prompt`, `body`, `message`, `content`, `email`, `query`, `command`, `user`, `customer`, and similar).
- URLs and query strings.
- Log bodies: put a stable event name in `event.name` instead.
- Exception messages and stacks: use `error.type`, plus an optional `fleet.error_code`.

The only token-count exception is five integer counters:

```text
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens
gen_ai.usage.total_tokens
gen_ai.usage.cached_input_tokens
gen_ai.usage.reasoning_tokens
```

Adding a key needs a coordinated change to both the layer (`USAGE_COUNTER_KEYS`) and the collector. Dropped attributes are counted by class in `fleet.telemetry.attributes_dropped`; the key and value are never recorded.

## 5. Never block, never fail the caller

Export is bounded and drops the oldest records when full, with a 2 s timeout and failures swallowed. A dead collector costs you latency in microseconds, not errors. If your service has its own bounded channel before the layer (for example a fixed-size event channel), measure its drop count under load and expose it as a metric. The collector's no-loss guarantee starts at its ingress.

## 6. Prove it

1. **Tests:** use `FleetTelemetry.layerTest` to assert your key spans and logs.
2. **After deploy:** send the desk one trace id from the live service. The desk confirms it in ClickHouse (`otel.otel_traces`).
3. **24 h attribute audit:** the desk reviews retained attributes and dropped-class counts. Fix anything that leaks or anything you needed that was dropped.

## Don'ts

- Don't wire Alchemy's built-in Telemetry layer to this collector.
- Don't create ClickHouse tables or change the schema. Schema changes go through a reviewed plan.
- Don't restart running agents just to pick this up. Land it in your normal flow.
