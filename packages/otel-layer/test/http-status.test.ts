import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Metric } from "effect";

import { FleetTelemetry } from "../src/index.js";

it.live("HTTP failure is counted without retrying or failing the caller", () =>
  Effect.gen(function* rejectedExport() {
    const paths: string[] = [];
    const instance = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((request, response) => {
          paths.push(request.url ?? "");
          response.writeHead(503);
          response.end("{}");
        })
      ),
      (server) =>
        Effect.promise(async () => {
          server.closeAllConnections();
          await promisify(server.close.bind(server))();
        })
    );
    yield* Effect.promise(() =>
      once(instance.listen(0, "localhost"), "listening")
    );
    const address = instance.address();
    if (!address || typeof address === "string") {
      return yield* Effect.die(new Error("missing test listener"));
    }
    yield* Effect.gen(function* exerciseRejectedExport() {
      const telemetry = yield* FleetTelemetry.Service;
      expect(
        yield* Effect.succeed(42).pipe(Effect.withSpan("fixture.rejected"))
      ).toBe(42);
      yield* telemetry.flush;
      expect((yield* telemetry.counters).failedExports).toBeGreaterThan(0);
      expect(paths.filter((path) => path === "/v1/traces")).toHaveLength(1);
    }).pipe(
      Effect.provide(
        FleetTelemetry.layer({
          endpoint: `http://localhost:${address.port}`,
          exportIntervalMs: 60_000,
          exportTimeoutMs: 100,
        })
      )
    );
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    Effect.provideService(Metric.MetricRegistry, new Map())
  )
);
