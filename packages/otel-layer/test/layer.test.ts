import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Metric, Tracer } from "effect";
import effectPackage from "effect/package.json" with { type: "json" };

import { FleetTelemetry } from "../src/index.js";

const env = ConfigProvider.layer(ConfigProvider.fromUnknown({}));
const isolated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(env),
    Effect.provideService(Metric.MetricRegistry, new Map())
  );
const attrs = (
  values: readonly { readonly key: string; readonly value: unknown }[]
) => Object.fromEntries(values.map(({ key, value }) => [key, value]));

describe("Effect compatibility and capture", () => {
  it("pins the native OTLP bridge contract to the verified Effect release", () => {
    expect(
      effectPackage.version,
      "Reverify effect-bridge.ts with effect_source before changing this pin"
    ).toBe("4.0.5");
  });

  it.effect(
    "captures spans, logs, resources, events, links and typed errors without raw bodies",
    () =>
      isolated(
        Effect.gen(function* scenario() {
          const capture = yield* FleetTelemetry.TestService;
          const expected = {
            _tag: "Unavailable",
            message: "private failure text",
          };
          yield* Effect.gen(function* emitTelemetry() {
            const span = yield* Effect.currentSpan;
            span.addLinks([
              {
                attributes: { "rpc.system": "fixture", "rpc.token": "fixture" },
                span: Tracer.externalSpan({
                  spanId: "b".repeat(16),
                  traceId: "a".repeat(32),
                }),
              },
              {
                attributes: {},
                span: Tracer.externalSpan({
                  spanId: "private text",
                  traceId: "ghp_fixture",
                }),
              },
            ]);
            span.event("queue.ready", 1n, {
              "http.request.method": "GET",
              "rpc.secret": "fixture",
            });
            span.event("private event text", 2n, {
              "exception.message": "private",
            });
            yield* Effect.logWarning("queue.ready").pipe(
              Effect.annotateLogs({
                "http.response.status_code": 202,
                "rpc.password": "fixture",
              })
            );
            yield* Effect.log("private message text");
            yield* Effect.void.pipe(Effect.withSpan("child"));
          }).pipe(
            Effect.withSpan("parent", {
              attributes: {
                "fleet.error_code": "FixtureError",
                "fleet.total_tokens": 15,
                "gen_ai.usage.cached_input_tokens": 15,
                "gen_ai.usage.input_tokens": 7,
                "gen_ai.usage.output_tokens": "8",
                "http.authorization": "fixture",
                "http.route": "safe ".repeat(100),
              },
            })
          );
          const exit = yield* Effect.fail(expected).pipe(
            Effect.withSpan("failure"),
            Effect.exit
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(Exit.findErrorOption(exit)).toMatchObject({
            _tag: "Some",
            value: expected,
          });
          const parent = yield* capture.findSpan("parent");
          const child = yield* capture.findSpan("child");
          const failure = yield* capture.findSpan("failure");
          expect(parent).toBeDefined();
          expect(child?.parentSpanId).toBe(parent?.spanId);
          expect(child?.traceId).toBe(parent?.traceId);
          expect(parent?.links).toHaveLength(1);
          expect(parent?.links[0]?.traceId).toBe("a".repeat(32));
          expect(parent?.events.map((event) => event.name)).toEqual([
            "queue.ready",
            "<redacted>",
          ]);
          expect(attrs(parent?.attributes ?? [])).toMatchObject({
            "gen_ai.usage.cached_input_tokens": { intValue: 15 },
            "gen_ai.usage.input_tokens": { intValue: 7 },
          });
          expect(
            parent?.attributes.some((attribute) =>
              ["gen_ai.usage.output_tokens", "fleet.total_tokens"].includes(
                attribute.key
              )
            )
          ).toBe(false);
          expect(parent?.attributes).toEqual(
            expect.arrayContaining([
              {
                key: "fleet.error_code",
                value: { stringValue: "FixtureError" },
              },
            ])
          );
          expect(attrs(failure?.attributes ?? [])).toMatchObject({
            "error.type": { stringValue: "Unavailable" },
          });
          const logs = yield* capture.logs;
          expect(logs).toHaveLength(2);
          expect(logs[0]?.severityNumber).toBe(13);
          expect(logs[0]?.body).toEqual({ stringValue: "<redacted>" });
          expect(attrs(logs[0]?.attributes ?? [])).toMatchObject({
            "event.name": { stringValue: "queue.ready" },
          });
          const encoded = JSON.stringify({ logs, spans: yield* capture.spans });
          for (const forbidden of [
            "private failure text",
            "private message text",
            "private event text",
            "rpc.password",
            "rpc.token",
            "ghp_fixture",
            "rpc.secret",
            "authorization",
            "exception.message",
          ]) {
            expect(encoded).not.toContain(forbidden);
          }
          expect(capture.resource).toEqual({
            "deployment.environment": "test",
            "fleet.muster_row": "row",
            "fleet.project": "project",
            "fleet.ratking_name": "fixture/worker",
            "host.name": "test-host",
            "service.name": "capture-cell",
            "service.version": "1.2.3",
            "vcs.revision": "b".repeat(40),
          });
          const counters = yield* capture.counters;
          expect(counters.droppedAttributes.secret_key).toBeGreaterThan(0);
          expect(counters.droppedAttributes.free_text).toBeGreaterThan(0);
        }).pipe(
          Effect.provide(
            FleetTelemetry.layerTestWith({
              environment: "test",
              hostName: "test-host",
              musterRow: "row",
              project: "project",
              ratkingName: "fixture/worker",
              revision: "b".repeat(40),
              serviceName: "capture-cell",
              serviceVersion: "1.2.3",
            })
          )
        )
      )
  );

  it.effect(
    "uses the real native metrics converter and filters every metric attribute",
    () =>
      isolated(
        Effect.gen(function* scenario() {
          const capture = yield* FleetTelemetry.TestService;
          yield* Metric.update(
            Metric.counter("requests", {
              attributes: {
                "fleet.output_tokens": "8",
                "http.request.method": "POST",
                "http.route": "ghp_fixture",
                "rpc.secret": "fixture",
              },
              description: "private description",
              incremental: true,
            }),
            2
          );
          yield* Metric.update(Metric.gauge("active"), 3);
          yield* Metric.update(Metric.frequency("states"), "queued");
          yield* Metric.update(Metric.frequency("states"), "delivered");
          yield* Metric.update(
            Metric.histogram("latency", {
              attributes: { unit: "milliseconds" },
              boundaries: [1, 5, 10],
            }),
            4
          );
          yield* Metric.update(
            Metric.summary("summary", {
              maxAge: "1 hour",
              maxSize: 10,
              quantiles: [0.5],
            }),
            4
          );
          yield* capture.metrics;
          const metrics = yield* capture.metrics;
          expect(
            metrics.find((metric) => metric.name === "requests")?.sum
              ?.dataPoints[0]?.asDouble
          ).toBe(2);
          expect(
            metrics.find((metric) => metric.name === "active")?.gauge
              ?.dataPoints[0]?.asDouble
          ).toBe(3);
          expect(
            metrics.find((metric) => metric.name === "latency")?.unit
          ).toBe("ms");
          expect(
            metrics.find((metric) => metric.name === "latency")?.histogram
              ?.dataPoints[0]?.count
          ).toBe(1);
          expect(
            metrics.find((metric) => metric.name === "summary")?.summary
              ?.dataPoints[0]?.count
          ).toBe(1);
          const frequency = metrics.filter(
            (metric) => metric.name === "states"
          );
          expect(frequency.length).toBeGreaterThanOrEqual(2);
          // Native Frequency's label is literally `key`; privacy takes precedence.
          expect(JSON.stringify(frequency)).not.toContain("queued");
          expect(JSON.stringify(frequency)).not.toContain("delivered");
          const dropped = metrics.filter(
            (metric) => metric.name === "fleet.telemetry.attributes_dropped"
          );
          expect(dropped.length).toBeGreaterThan(0);
          expect(JSON.stringify(dropped)).toContain("fleet.drop_class");
          const serialized = JSON.stringify(metrics);
          for (const forbidden of [
            "rpc.secret",
            "ghp_fixture",
            "private description",
          ]) {
            expect(serialized).not.toContain(forbidden);
          }
          expect(serialized).toContain("http.request.method");
          expect(serialized).not.toContain("fleet.output_tokens");
        }).pipe(Effect.provide(FleetTelemetry.layerTest))
      )
  );

  it.effect("test capture is fresh and overflow drops the oldest", () =>
    isolated(
      Effect.gen(function* scenario() {
        const capture = yield* FleetTelemetry.TestService;
        for (const name of ["first", "second", "third"]) {
          yield* Effect.void.pipe(Effect.withSpan(name));
        }
        expect((yield* capture.spans).map((span) => span.name)).toEqual([
          "second",
          "third",
        ]);
        expect((yield* capture.counters).droppedItems).toBe(1);
        yield* capture.clear;
        expect(yield* capture.spans).toEqual([]);
      }).pipe(Effect.provide(FleetTelemetry.layerTestWith({ bufferSize: 2 })))
    )
  );
});

describe("configuration and no-op", () => {
  it.effect("no endpoint leaves the existing tracer and loggers alone", () =>
    isolated(
      Effect.gen(function* scenario() {
        const originalTracer = yield* Effect.tracer;
        yield* Effect.gen(function* inspectNoOp() {
          const service = yield* FleetTelemetry.Service;
          expect(service.enabled).toBe(false);
          expect(yield* Effect.tracer).toBe(originalTracer);
          expect(yield* Effect.succeed(42).pipe(Effect.withSpan("noop"))).toBe(
            42
          );
          expect((yield* service.counters).queuedItems).toBe(0);
        }).pipe(Effect.provide(FleetTelemetry.layerFromEnv()));
      })
    )
  );

  it.effect("args override env and resource identity stays stable", () =>
    Effect.gen(function* scenario() {
      const service = yield* FleetTelemetry.TestService;
      expect(service.resource).toMatchObject({
        "deployment.environment": "test",
        "fleet.muster_row": "env-row",
        "fleet.project": "env-project",
        "fleet.ratking_name": "env/worker",
        "host.name": "env-host",
        "service.name": "explicit",
        "service.version": "env-version",
        "vcs.revision": "c".repeat(40),
      });
    }).pipe(
      Effect.provide(FleetTelemetry.layerTestWith({ serviceName: "explicit" })),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            DEPLOYMENT_ENVIRONMENT: "test",
            GIT_SHA: "c".repeat(40),
            HOSTNAME: "env-host",
            MUSTER_PROJECT: "env-project",
            MUSTER_ROW: "env-row",
            OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url",
            OTEL_SERVICE_NAME: "env-name",
            OTEL_SERVICE_VERSION: "env-version",
            RATKING_NAME: "env/worker",
          })
        )
      ),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  );

  it.effect("unsafe or empty service names fall back to unknown_service", () =>
    isolated(
      Effect.gen(function* scenario() {
        const service = yield* FleetTelemetry.TestService;
        expect(service.resource["service.name"]).toBe("unknown_service");
      }).pipe(
        Effect.provide(
          FleetTelemetry.layerTestWith({ serviceName: "sk-fixture" })
        )
      )
    )
  );

  it.effect(
    "invalid endpoints disable telemetry rather than failing construction",
    () =>
      isolated(
        Effect.gen(function* scenario() {
          for (const endpoint of [
            "not-a-url",
            "file:///fixture",
            "https://user:password@example.test",
            "https://example.test?token=fixture",
          ]) {
            yield* Effect.gen(function* inspectEndpoint() {
              expect((yield* FleetTelemetry.Service).enabled).toBe(false);
            }).pipe(Effect.provide(FleetTelemetry.layer({ endpoint })));
          }
        })
      )
  );
});
