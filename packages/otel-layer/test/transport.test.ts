import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Exit, Metric, Option } from "effect";

import { FleetTelemetry } from "../src/index.js";

const env = ConfigProvider.layer(ConfigProvider.fromUnknown({}));
const isolated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(env),
    Effect.provideService(Metric.MetricRegistry, new Map())
  );
const close = (instance: Server) =>
  Effect.promise(async () => {
    instance.closeAllConnections();
    await promisify(instance.close.bind(instance))().catch(() => {});
  });
const server = (
  handler: (request: IncomingMessage, response: ServerResponse) => void
) =>
  Effect.gen(function* createTestServer() {
    const instance = yield* Effect.acquireRelease(
      Effect.sync(() => createServer(handler)),
      close
    );
    yield* Effect.promise(() =>
      once(instance.listen(0, "localhost"), "listening")
    );
    const address = instance.address();
    if (!address || typeof address === "string") {
      return yield* Effect.die(new Error("missing test listener"));
    }
    return {
      close: close(instance),
      endpoint: `http://localhost:${address.port}`,
    };
  });
const trace = Effect.succeed(42).pipe(Effect.withSpan("operation"));
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const sample = Effect.gen(function* sampleLatency() {
  const values: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const before = performance.now();
    expect(yield* trace).toBe(42);
    values.push(performance.now() - before);
  }
  return median(values);
});

it.live(
  "closed collector does not delay traces or alter success/failure; failures are counted",
  () =>
    isolated(
      Effect.gen(function* closedCollector() {
        const listener = yield* server((_request, response) => response.end());
        const { endpoint } = listener;
        yield* listener.close;
        const baseline = yield* sample;
        yield* Effect.gen(function* exerciseClosedCollector() {
          const telemetry = yield* FleetTelemetry.Service;
          const latency = yield* sample;
          expect(latency - baseline).toBeLessThan(5);
          const error = { _tag: "ExpectedFailure" };
          const exit = yield* Effect.fail(error).pipe(
            Effect.withSpan("failed"),
            Effect.exit
          );
          expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBe(error);
          yield* telemetry.flush;
          const counters = yield* telemetry.counters;
          expect(counters.failedExports).toBeGreaterThan(0);
          expect(counters.droppedItems).toBeGreaterThan(0);
        }).pipe(
          Effect.provide(
            FleetTelemetry.layer({
              endpoint,
              exportIntervalMs: 60_000,
              exportTimeoutMs: 100,
            })
          )
        );
      })
    )
);

it.live(
  "a hung collector cannot delay the caller, and scope close cancels in-flight HTTP",
  () =>
    isolated(
      Effect.gen(function* hungCollector() {
        const received = yield* Deferred.make<true>();
        const listener = yield* server((_request, _response) => {
          Deferred.doneUnsafe(received, Effect.succeed(true as const));
        });
        const baseline = yield* sample;
        let closingAt = 0;
        yield* Effect.gen(function* exerciseHungCollector() {
          yield* trace;
          // Observe the real background request, not a manually cancelled flush fiber.
          yield* Deferred.await(received);
          expect((yield* sample) - baseline).toBeLessThan(5);
          const error = { _tag: "ExpectedFailure" };
          const exit = yield* Effect.fail(error).pipe(
            Effect.withSpan("failed"),
            Effect.exit
          );
          expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBe(error);
          closingAt = performance.now();
        }).pipe(
          Effect.provide(
            FleetTelemetry.layer({
              endpoint: listener.endpoint,
              exportIntervalMs: 1,
              exportTimeoutMs: 2000,
            })
          )
        );
        expect(performance.now() - closingAt).toBeLessThan(50);
      })
    )
);

it.live("timeout and overflow counts rise against a hung collector", () =>
  isolated(
    Effect.gen(function* hungTimeout() {
      const listener = yield* server((_request, response) => {
        // Send headers but never finish the response body.
        response.writeHead(200);
        response.write("fixture");
      });
      yield* Effect.gen(function* exerciseHungTimeout() {
        const telemetry = yield* FleetTelemetry.Service;
        for (let index = 0; index < 20; index += 1) {
          yield* trace;
        }
        expect((yield* telemetry.counters).queuedItems).toBe(4);
        expect((yield* telemetry.counters).droppedItems).toBe(16);
        yield* telemetry.flush;
        const counters = yield* telemetry.counters;
        expect(counters.failedExports).toBeGreaterThan(0);
        expect(counters.droppedItems).toBeGreaterThan(16);
      }).pipe(
        Effect.provide(
          FleetTelemetry.layer({
            bufferSize: 4,
            endpoint: listener.endpoint,
            exportIntervalMs: 60_000,
            exportTimeoutMs: 80,
          })
        )
      );
    })
  )
);

it.live(
  "posts all three OTLP signals with sanitized resources and attributes",
  () =>
    isolated(
      Effect.gen(function* wireContract() {
        const requests: { path: string; body: string }[] = [];
        const listener = yield* server((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            requests.push({
              body: Buffer.concat(chunks).toString(),
              path: request.url ?? "",
            });
            response.end("{}");
          });
        });
        yield* Effect.gen(function* exerciseWireContract() {
          const telemetry = yield* FleetTelemetry.Service;
          yield* Effect.void.pipe(
            Effect.withSpan("wire.span", {
              attributes: {
                "http.request.method": "GET",
                "rpc.secret": "fixture",
              },
            })
          );
          yield* Effect.log("queue.ready").pipe(
            Effect.annotateLogs({ "http.token": "fixture" })
          );
          yield* Metric.update(
            Metric.counter("requests", {
              attributes: {
                "http.request.method": "GET",
                "rpc.password": "fixture",
              },
            }),
            1
          );
          yield* telemetry.flush;
          expect(requests.map((request) => request.path)).toEqual(
            expect.arrayContaining(["/v1/traces", "/v1/logs", "/v1/metrics"])
          );
          const wire = requests.map((request) => request.body).join("\n");
          for (const kept of [
            "service.name",
            "wire-service",
            "http.request.method",
            "event.name",
            "<redacted>",
          ]) {
            expect(wire).toContain(kept);
          }
          for (const forbidden of [
            "http.token",
            "rpc.secret",
            "rpc.password",
          ]) {
            expect(wire).not.toContain(forbidden);
          }
        }).pipe(
          Effect.provide(
            FleetTelemetry.layer({
              endpoint: listener.endpoint,
              exportIntervalMs: 60_000,
              serviceName: "wire-service",
            })
          )
        );
      })
    )
);

it.live("production ingress drops the oldest span, not the newest", () =>
  isolated(
    Effect.gen(function* productionOverflow() {
      const bodies: string[] = [];
      const listener = yield* server((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (request.url === "/v1/traces") {
            bodies.push(Buffer.concat(chunks).toString());
          }
          response.end("{}");
        });
      });
      yield* Effect.gen(function* exerciseProductionOverflow() {
        const telemetry = yield* FleetTelemetry.Service;
        for (const name of ["first", "second", "third"]) {
          yield* Effect.void.pipe(Effect.withSpan(name));
        }
        expect((yield* telemetry.counters).droppedItems).toBe(1);
        yield* telemetry.flush;
        expect(bodies.join(",")).not.toContain('"name":"first"');
        expect(bodies.join(",")).toContain('"name":"second"');
        expect(bodies.join(",")).toContain('"name":"third"');
      }).pipe(
        Effect.provide(
          FleetTelemetry.layer({
            bufferSize: 2,
            endpoint: listener.endpoint,
            exportIntervalMs: 60_000,
          })
        )
      );
    })
  )
);
