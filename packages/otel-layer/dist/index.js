import { Config, Context, Effect, Exit, Layer, Logger, Metric, Queue, Semaphore, Stream, Tracer, } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { sanitizeAttributes, USAGE_COUNTER_KEYS } from "./attributes.js";
import { encode, makeLogger, makeMetrics, makeTracer, } from "./effect-bridge.js";
import { TestService } from "./test-service.js";
export { fleetAttributes, sanitizeAttribute, sanitizeAttributes, semanticPrefixes, USAGE_COUNTER_KEYS, } from "./attributes.js";
export class Service extends Context.Service()("@fleet-telemetry/otel-layer") {
}
export { TestService } from "./test-service.js";
const droppedClasses = [
    "secret_key",
    "content_key",
    "not_allowed",
    "credential_value",
    "invalid_value",
    "limit",
    "free_text",
];
const emptyDrops = () => ({
    content_key: 0,
    credential_value: 0,
    free_text: 0,
    invalid_value: 0,
    limit: 0,
    not_allowed: 0,
    secret_key: 0,
});
const integer = (value, fallback, max) => value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.min(max, Math.floor(value))
    : fallback;
const first = (...values) => values.find((value) => value?.trim()) ?? "unknown";
const resolve = (options) => Effect.gen(function* readConfiguration() {
    const env = yield* Config.all({
        endpoint: Config.String("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.withDefault("")),
        environment: Config.String("DEPLOYMENT_ENVIRONMENT").pipe(Config.withDefault("")),
        host: Config.String("HOSTNAME").pipe(Config.withDefault("")),
        hostName: Config.String("OTEL_HOST_NAME").pipe(Config.withDefault("")),
        musterRow: Config.String("MUSTER_ROW").pipe(Config.withDefault("")),
        nodeEnv: Config.String("NODE_ENV").pipe(Config.withDefault("")),
        otelEnvironment: Config.String("OTEL_DEPLOYMENT_ENVIRONMENT").pipe(Config.withDefault("")),
        project: Config.String("MUSTER_PROJECT").pipe(Config.withDefault("")),
        ratkingName: Config.String("RATKING_NAME").pipe(Config.withDefault("")),
        revision: Config.String("GIT_SHA").pipe(Config.withDefault("")),
        serviceName: Config.String("OTEL_SERVICE_NAME").pipe(Config.withDefault("")),
        serviceVersion: Config.String("OTEL_SERVICE_VERSION").pipe(Config.withDefault("")),
    }).pipe(Effect.catchCause(() => Effect.succeed({
        endpoint: "",
        environment: "",
        host: "",
        hostName: "",
        musterRow: "",
        nodeEnv: "",
        otelEnvironment: "",
        project: "",
        ratkingName: "",
        revision: "",
        serviceName: "",
        serviceVersion: "",
    })));
    return {
        attributes: {
            "deployment.environment": first(options.environment, env.environment, env.otelEnvironment, env.nodeEnv),
            "fleet.muster_row": first(options.musterRow, env.musterRow),
            "fleet.project": first(options.project, env.project),
            "fleet.ratking_name": first(options.ratkingName, env.ratkingName),
            "host.name": first(options.hostName, env.hostName, env.host),
            "service.name": first(options.serviceName, env.serviceName, "unknown_service"),
            "service.version": first(options.serviceVersion, env.serviceVersion),
            "vcs.revision": first(options.revision, env.revision),
        },
        capacity: integer(options.bufferSize, 2048, 65_536),
        endpoint: options.endpoint ?? env.endpoint,
        interval: integer(options.exportIntervalMs, 1000, 86_400_000),
        timeout: integer(options.exportTimeoutMs, 2000, 2000),
    };
});
const endpointUrl = (value) => {
    if (!value) {
        return;
    }
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash) {
            return;
        }
        return url.toString().replace(/\/$/u, "");
    }
    catch {
        /* Invalid configuration disables export. */
    }
};
const noOp = (resource) => Layer.succeed(Service, {
    counters: Effect.sync(() => ({
        droppedAttributes: emptyDrops(),
        droppedItems: 0,
        exportedItems: 0,
        failedExports: 0,
        queuedItems: 0,
    })),
    enabled: false,
    flush: Effect.void,
    resource,
});
const make = (options, test) => Effect.gen(function* acquireTelemetry() {
    const config = yield* resolve(options);
    const drops = emptyDrops();
    const onDrop = (reason) => {
        drops[reason] += 1;
    };
    const clean = sanitizeAttributes(Object.entries(config.attributes), onDrop);
    const resource = Object.freeze({
        ...clean,
        "service.name": typeof clean["service.name"] === "string" &&
            clean["service.name"].trim()
            ? clean["service.name"]
            : "unknown_service",
    });
    const endpoint = endpointUrl(config.endpoint);
    return yield* Effect.gen(function* acquireHooks() {
        const queue = yield* Queue.sliding(config.capacity);
        const semaphore = yield* Semaphore.make(1);
        const context = yield* Effect.context();
        const captured = [];
        let droppedItems = 0;
        let failedExports = 0;
        let exportedItems = 0;
        const increment = (name, value, attributes) => {
            Metric.counter(name, {
                incremental: true,
                ...(attributes ? { attributes } : {}),
            }).updateUnsafe(value, context);
        };
        const countDrop = (reason) => {
            onDrop(reason);
            increment("fleet.telemetry.attributes_dropped", 1, {
                "fleet.drop_class": reason,
            });
        };
        // Register every self-counter series before the first snapshot.
        increment("fleet.telemetry.items_dropped", 0);
        increment("fleet.telemetry.exports_failed", 0);
        // Resource filtering precedes the registry; retain any drops it found.
        for (const reason of droppedClasses) {
            increment("fleet.telemetry.attributes_dropped", drops[reason], {
                "fleet.drop_class": reason,
            });
        }
        const offer = (item) => {
            if (test) {
                if (captured.length >= config.capacity) {
                    captured.shift();
                    droppedItems += 1;
                    increment("fleet.telemetry.items_dropped", 1);
                }
                captured.push(item);
            }
            else {
                if (Queue.sizeUnsafe(queue) >= config.capacity) {
                    droppedItems += 1;
                    increment("fleet.telemetry.items_dropped", 1);
                }
                if (!Queue.offerUnsafe(queue, item)) {
                    droppedItems += 1;
                    increment("fleet.telemetry.items_dropped", 1);
                }
            }
        };
        const snapshotMetrics = yield* makeMetrics(resource, offer, countDrop);
        const counters = Effect.sync(() => ({
            droppedAttributes: { ...drops },
            droppedItems,
            exportedItems,
            failedExports,
            queuedItems: test ? captured.length : Queue.sizeUnsafe(queue),
        }));
        const tracer = makeTracer(offer, countDrop);
        const logger = makeLogger(offer, countDrop);
        const drain = test
            ? Effect.void
            : Effect.gen(function* drain() {
                const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
                const items = yield* Queue.clear(queue);
                let remaining = items.length;
                yield* Effect.suspend(() => Effect.forEach(encode(items, resource), (batch) => Effect.scoped(client
                    .execute(HttpClientRequest.post(`${endpoint}/v1/${batch.signal}`, {
                    body: batch.body,
                }))
                    .pipe(Effect.flatMap((response) => Stream.runDrain(response.stream)), Effect.timeout(config.timeout), Effect.onExit((exit) => Effect.sync(() => {
                    remaining -= batch.count;
                    if (Exit.isFailure(exit)) {
                        failedExports += 1;
                        droppedItems += batch.count;
                        increment("fleet.telemetry.exports_failed", 1);
                        increment("fleet.telemetry.items_dropped", batch.count);
                    }
                    else {
                        exportedItems += batch.count;
                    }
                })), Effect.ignoreCause)), { discard: true })).pipe(Effect.ensuring(Effect.sync(() => {
                    // Account for drained batches cancelled before their request starts.
                    droppedItems += remaining;
                    if (remaining > 0) {
                        increment("fleet.telemetry.items_dropped", remaining);
                    }
                })));
            }).pipe(Effect.withTracerEnabled(false), Effect.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, {
                credentials: "omit",
                redirect: "error",
            })))));
        const runPass = semaphore
            .withPermits(1)(Effect.andThen(drain, Effect.andThen(snapshotMetrics, drain)))
            .pipe(Effect.catchCause(() => Effect.sync(() => {
            // Guard unexpected converter/encoder defects as well as transport errors.
            failedExports += 1;
            increment("fleet.telemetry.exports_failed", 1);
        })));
        // Lifecycle: active.sleeping -> active.exporting -> active.sleeping; scope close -> closed.
        // No detach, retry or final network flush. Closing interrupts the scoped worker.
        if (!test) {
            yield* Effect.sleep(config.interval).pipe(Effect.andThen(runPass), Effect.forever, Effect.forkScoped);
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => {
            const pending = Queue.sizeUnsafe(queue);
            droppedItems += pending;
            if (pending > 0) {
                increment("fleet.telemetry.items_dropped", pending);
            }
            Queue.shutdownUnsafe(queue);
        }));
        const flush = runPass.pipe(Effect.interruptible, Effect.timeoutOption(config.timeout), Effect.asVoid);
        const service = { counters, enabled: true, flush, resource };
        const live = Layer.mergeAll(Layer.succeed(Service, service), Layer.succeed(Tracer.Tracer, tracer), Logger.layer([logger], { mergeWithExisting: true }));
        const spans = Effect.sync(() => captured
            .filter((item) => item.signal === "traces")
            .map((item) => item.record));
        const logs = Effect.sync(() => captured
            .filter((item) => item.signal === "logs")
            .map((item) => item.record));
        const metrics = Effect.andThen(snapshotMetrics, Effect.sync(() => captured
            .filter((item) => item.signal === "metrics")
            .map((item) => item.record)));
        const capture = {
            ...service,
            clear: Effect.sync(() => {
                captured.length = 0;
            }),
            findSpan: (name) => spans.pipe(Effect.map((values) => values.find((span) => span.name === name))),
            logs,
            metrics,
            spans,
        };
        const testing = Layer.mergeAll(Layer.succeed(Service, capture), Layer.succeed(TestService, capture), Layer.succeed(Tracer.Tracer, tracer), Logger.layer([logger]));
        return { live, testing };
    });
});
/** Install once at the application boundary. No endpoint means no exporter or runtime hooks. */
export const layer = (options = {}) => Layer.unwrap(Effect.gen(function* installTelemetry() {
    const config = yield* resolve(options);
    if (!endpointUrl(config.endpoint)) {
        const clean = sanitizeAttributes(Object.entries(config.attributes), () => {
            /* Disabled telemetry does not register metrics. */
        });
        return noOp({
            ...clean,
            "service.name": typeof clean["service.name"] === "string" &&
                clean["service.name"].trim()
                ? clean["service.name"]
                : "unknown_service",
        });
    }
    const layers = yield* make(options, false);
    return layers.live;
})).pipe(Layer.catchCause(() => noOp(Object.freeze({ "service.name": "unknown_service" }))));
export const layerFromEnv = () => layer();
/** Fresh capture state per layer build. No network, including when an endpoint is in the environment. */
export const layerTestWith = (options = {}) => Layer.unwrap(Effect.map(make(options, true), (layers) => layers.testing));
export const layerTest = layerTestWith({ serviceName: "test-service" });
export const FleetTelemetry = {
    Service,
    TestService,
    USAGE_COUNTER_KEYS,
    layer,
    layerFromEnv,
    layerTest,
    layerTestWith,
};
