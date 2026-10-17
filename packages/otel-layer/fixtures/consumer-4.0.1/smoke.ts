import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
  FleetTelemetry,
  USAGE_COUNTER_KEYS,
} from "@fleet-telemetry/otel-layer";
import type { MetricRecord } from "@fleet-telemetry/otel-layer";
import { ConfigProvider, Effect, Exit, Metric, Option } from "effect";
import effectPackage from "effect/package.json" with { type: "json" };

import fixture from "./package.json" with { type: "json" };

assert.equal(effectPackage.version, fixture.dependencies.effect);
assert.equal(USAGE_COUNTER_KEYS.length, 5);
assert.deepEqual(FleetTelemetry.USAGE_COUNTER_KEYS, USAGE_COUNTER_KEYS);
const assertScalars = (metrics: readonly MetricRecord[]) => {
  assert.equal(
    metrics.find((metric) => metric.name === "fixture.counter")?.sum
      ?.dataPoints[0]?.asDouble,
    2
  );
  assert.equal(
    metrics.find((metric) => metric.name === "fixture.gauge")?.gauge
      ?.dataPoints[0]?.asDouble,
    3
  );
};
const assertFrequency = (metrics: readonly MetricRecord[]) => {
  const frequency = metrics.filter(
    (metric) => metric.name === "fixture.frequency"
  );
  assert.equal(
    frequency.flatMap((metric) => metric.sum?.dataPoints ?? []).length,
    2
  );
  assert.ok(!JSON.stringify(frequency).includes("queued"));
  assert.ok(!JSON.stringify(frequency).includes("delivered"));
  assert.ok(!JSON.stringify(frequency).includes('"key":"key"'));
};
const isolate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    Effect.provideService(Metric.MetricRegistry, new Map())
  );

await Effect.runPromise(
  isolate(
    Effect.gen(function* captureContract() {
      const capture = yield* FleetTelemetry.TestService;
      yield* Effect.log("fixture.ready").pipe(
        Effect.withSpan("fixture.span", {
          attributes: {
            "fleet.total_tokens": 5,
            "gen_ai.usage.cached_input_tokens": 9,
            "gen_ai.usage.foo_tokens": 3,
            "gen_ai.usage.input_tokens": 7,
            "gen_ai.usage.output_tokens": "8",
            "http.request.method": "GET",
            "rpc.secret": "fixture",
          },
        })
      );
      const span = yield* capture.findSpan("fixture.span");
      assert.ok(span);
      assert.match(span.traceId, /^[a-f0-9]{32}$/u);
      assert.equal(
        span.attributes.find(
          (attribute) => attribute.key === "gen_ai.usage.input_tokens"
        )?.value.intValue,
        7
      );
      assert.equal(
        span.attributes.find(
          (attribute) => attribute.key === "gen_ai.usage.cached_input_tokens"
        )?.value.intValue,
        9
      );
      assert.ok(
        !span.attributes.some((attribute) =>
          [
            "gen_ai.usage.output_tokens",
            "gen_ai.usage.foo_tokens",
            "fleet.total_tokens",
          ].includes(attribute.key)
        )
      );
      const [log] = yield* capture.logs;
      assert.equal(log?.body?.stringValue, "<redacted>");
      assert.ok(
        log?.attributes.some(
          (attribute) =>
            attribute.key === "event.name" &&
            attribute.value.stringValue === "fixture.ready"
        )
      );
      assert.equal(log?.traceId, span.traceId);
      yield* Metric.update(
        Metric.counter("fixture.counter", { incremental: true }),
        2
      );
      yield* Metric.update(Metric.gauge("fixture.gauge"), 3);
      yield* Metric.update(
        Metric.histogram("fixture.histogram", {
          attributes: { unit: "milliseconds" },
          boundaries: [1, 5, 10],
        }),
        4
      );
      yield* Metric.update(
        Metric.summary("fixture.summary", {
          maxAge: "1 hour",
          maxSize: 10,
          quantiles: [0.5],
        }),
        4
      );
      yield* Metric.update(Metric.frequency("fixture.frequency"), "queued");
      yield* Metric.update(Metric.frequency("fixture.frequency"), "delivered");
      const metrics = yield* capture.metrics;
      assert.equal(
        metrics.find((metric) => metric.name === "fixture.histogram")?.unit,
        "ms"
      );
      assertFrequency(metrics);
      assertScalars(metrics);
      assert.equal(
        metrics.find((metric) => metric.name === "fixture.histogram")?.histogram
          ?.dataPoints[0]?.count,
        1
      );
      // 4.0.1 emits legacy Sum series; 4.0.5 emits native OTLP Summary.
      const summary = metrics.find(
        (metric) => metric.name === "fixture.summary"
      )?.summary?.dataPoints[0]?.count;
      const legacyCount = metrics.find(
        (metric) => metric.name === "fixture.summary_count"
      )?.sum?.dataPoints[0]?.asInt;
      assert.equal(summary ?? legacyCount, 1);
      assert.equal(capture.resource["service.name"], "test-service");
      assert.ok(!JSON.stringify({ log, metrics, span }).includes("rpc.secret"));
    }).pipe(Effect.provide(FleetTelemetry.layerTest))
  )
);

const listener = createServer();
listener.listen(0, "localhost");
await once(listener, "listening");
const address = listener.address();
assert.ok(address && typeof address !== "string");
const endpoint = `http://localhost:${address.port}`;
await promisify(listener.close.bind(listener))();

const trace = Effect.succeed(42).pipe(Effect.withSpan("fixture.dead-endpoint"));
const baseline = await Effect.runPromise(
  isolate(
    Effect.gen(function* baselineLatency() {
      const started = performance.now();
      for (let index = 0; index < 100; index += 1) {
        yield* trace;
      }
      return (performance.now() - started) / 100;
    })
  )
);
let overheadMs = 0;
await Effect.runPromise(
  isolate(
    Effect.gen(function* deadEndpointContract() {
      const telemetry = yield* FleetTelemetry.Service;
      const started = performance.now();
      for (let index = 0; index < 100; index += 1) {
        assert.equal(yield* trace, 42);
      }
      overheadMs = (performance.now() - started) / 100 - baseline;
      assert.ok(overheadMs < 5, `trace overhead ${overheadMs}ms`);
      const expected = { _tag: "FixtureError" };
      const exit = yield* Effect.fail(expected).pipe(
        Effect.withSpan("fixture.failure"),
        Effect.exit
      );
      assert.equal(Option.getOrUndefined(Exit.findErrorOption(exit)), expected);
      yield* telemetry.flush;
      const counters = yield* telemetry.counters;
      assert.ok(counters.failedExports > 0);
      assert.ok(counters.droppedItems > 0);
    }).pipe(
      Effect.provide(
        FleetTelemetry.layer({
          endpoint,
          exportIntervalMs: 60_000,
          exportTimeoutMs: 100,
          serviceName: "fixture-service",
        })
      )
    )
  )
);
console.log(
  `PASS Effect ${effectPackage.version}: built-package span/log/metrics bridge, dead collector, error identity; overhead=${overheadMs.toFixed(3)}ms`
);
