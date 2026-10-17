# fleet-telemetry

One collector and one shared Effect layer, so every fleet service gets OpenTelemetry in one line and nothing blocks when the collector is down.

- `apps/collector`: the OpenTelemetry Collector (contrib), declared as an Alchemy resource, with a persistent on-disk queue and a ClickHouse exporter.
- `packages/otel-layer`: the shared Effect layer: standard resource attributes, an attribute allowlist, never blocks the caller, and a test Layer.

Rules: nothing leaves our machines; no secrets, tokens, prompt or message bodies, or customer data in attributes; ClickHouse schema changes go through a reviewed plan; Effect and rat-stack idioms, Alchemy for infra.
