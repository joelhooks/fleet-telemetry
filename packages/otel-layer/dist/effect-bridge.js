import { Clock, ConfigProvider, Context, Effect, Exit, Layer, Logger, Option, References, Tracer, } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/http";
import { OtlpExporter, OtlpMetrics, OtlpResource, OtlpSerialization, } from "effect/observability";
import { eventName, sanitizeAttribute, sanitizeAttributes, } from "./attributes.js";
export const resourceFromAttributes = (attributes) => ({
    attributes: OtlpResource.entriesToAttributes(Object.entries(attributes)),
    droppedAttributesCount: 0,
});
const errorType = (cause, onDrop) => {
    const [reason] = cause.reasons;
    if (!reason) {
        return;
    }
    // Never serialize a Cause, stack or message.
    onDrop("free_text");
    let value;
    if (reason._tag === "Fail") {
        value = reason.error;
    }
    else if (reason._tag === "Die") {
        value = reason.defect;
    }
    if (typeof value === "object" && value !== null) {
        for (const key of ["_tag", "name"]) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor && typeof descriptor.value === "string") {
                return eventName(descriptor.value, onDrop);
            }
        }
        if (value instanceof Error) {
            return "Error";
        }
    }
    return reason._tag;
};
const kinds = {
    client: 3,
    consumer: 5,
    internal: 1,
    producer: 4,
    server: 2,
};
const validTraceId = (value) => /^[a-f0-9]{32}$/iu.test(value);
const validSpanId = (value) => /^[a-f0-9]{16}$/iu.test(value);
const protect = (onDrop, run) => {
    try {
        run();
    }
    catch {
        onDrop("invalid_value");
    }
};
export const makeTracer = (offer, onDrop) => Tracer.make({
    span(options) {
        const span = new Tracer.NativeSpan({ ...options, links: [] });
        const events = [];
        const links = [];
        let ended = false;
        span.attribute = (key, value) => protect(onDrop, () => {
            if (ended) {
                return;
            }
            if (span.attributes.size >= 64 && !span.attributes.has(key)) {
                onDrop("limit");
                return;
            }
            const clean = sanitizeAttribute(key, value, onDrop);
            if (clean !== undefined) {
                span.attributes.set(key, clean);
            }
        });
        span.event = (name, time, attributes) => protect(onDrop, () => {
            if (ended) {
                return;
            }
            if (events.length >= 32) {
                onDrop("limit");
                return;
            }
            events.push({
                attributes: OtlpResource.entriesToAttributes(Object.entries(sanitizeAttributes(Object.entries(attributes ?? {}), onDrop))),
                droppedAttributesCount: 0,
                name: eventName(name, onDrop),
                timeUnixNano: String(time),
            });
        });
        span.addLinks = (newLinks) => protect(onDrop, () => {
            if (ended) {
                return;
            }
            for (const link of newLinks) {
                if (links.length >= 16) {
                    onDrop("limit");
                    break;
                }
                if (!validTraceId(link.span.traceId) ||
                    !validSpanId(link.span.spanId)) {
                    onDrop("invalid_value");
                    continue;
                }
                links.push({
                    attributes: OtlpResource.entriesToAttributes(Object.entries(sanitizeAttributes(Object.entries(link.attributes ?? {}), onDrop))),
                    droppedAttributesCount: 0,
                    spanId: link.span.spanId,
                    traceId: link.span.traceId,
                });
            }
        });
        span.addLinks(options.links);
        span.end = (time, exit) => protect(onDrop, () => {
            if (ended) {
                return;
            }
            // Retain no Exit in the export buffer: it can hold arbitrary application data.
            span.status = {
                _tag: "Ended",
                endTime: time,
                exit,
                startTime: options.startTime,
            };
            if (!span.sampled) {
                ended = true;
                return;
            }
            if (Exit.isFailure(exit)) {
                const type = errorType(exit.cause, onDrop);
                if (type) {
                    span.attribute("error.type", type);
                }
            }
            ended = true;
            const parent = Option.getOrUndefined(span.parent);
            if (!validTraceId(span.traceId) || !validSpanId(span.spanId)) {
                onDrop("invalid_value");
                return;
            }
            const record = {
                attributes: OtlpResource.entriesToAttributes(Object.entries(sanitizeAttributes(span.attributes, onDrop))),
                droppedAttributesCount: 0,
                droppedEventsCount: 0,
                droppedLinksCount: 0,
                endTimeUnixNano: String(time),
                events,
                kind: kinds[span.kind],
                links,
                name: eventName(span.name, onDrop),
                parentSpanId: parent && validSpanId(parent.spanId) ? parent.spanId : "",
                spanId: span.spanId,
                startTimeUnixNano: String(options.startTime),
                status: { code: Exit.isFailure(exit) ? 2 : 1 },
                traceId: span.traceId,
            };
            offer({ record, signal: "traces" });
        });
        return span;
    },
});
const severity = {
    All: 1,
    Debug: 5,
    Error: 17,
    Fatal: 21,
    Info: 9,
    None: 0,
    Trace: 1,
    Warn: 13,
};
export const makeLogger = (offer, onDrop) => Logger.make((options) => {
    try {
        const attributes = {
            ...options.fiber.getRef(References.CurrentLogAnnotations),
        };
        const type = errorType(options.cause, onDrop);
        if (type) {
            attributes["error.type"] = type;
        }
        const messages = Array.isArray(options.message)
            ? options.message
            : [options.message];
        const record = {
            attributes: OtlpResource.entriesToAttributes(Object.entries(sanitizeAttributes(Object.entries({
                ...attributes,
                "event.name": eventName(messages.length === 1 ? messages[0] : undefined, onDrop),
            }), onDrop))),
            body: { stringValue: "<redacted>" },
            droppedAttributesCount: 0,
            flags: 0,
            observedTimeUnixNano: String(options.fiber.getRef(Clock.Clock).currentTimeNanosUnsafe()),
            severityNumber: severity[options.logLevel],
            severityText: options.logLevel,
            timeUnixNano: String(BigInt(options.date.getTime()) * 1000000n),
        };
        const { span } = options.fiber.cache;
        if (span && validTraceId(span.traceId) && validSpanId(span.spanId)) {
            record.traceId = span.traceId;
            record.spanId = span.spanId;
        }
        offer({ record, signal: "logs" });
    }
    catch {
        onDrop("invalid_value");
    }
});
const fromWireValue = (value) => {
    if (value.stringValue !== undefined) {
        return value.stringValue;
    }
    if (value.boolValue !== undefined) {
        return value.boolValue;
    }
    if (value.doubleValue !== undefined) {
        return value.doubleValue;
    }
    if (value.intValue !== undefined) {
        return Number(value.intValue);
    }
    if (value.arrayValue) {
        return value.arrayValue.values.map(fromWireValue);
    }
};
const wireAttributes = (attributes, onDrop) => OtlpResource.entriesToAttributes(Object.entries(sanitizeAttributes(attributes.map(({ key, value }) => [key, fromWireValue(value)]), onDrop)));
const legacyUnits = Object.freeze({
    bytes: "By",
    microseconds: "us",
    milliseconds: "ms",
    nanoseconds: "ns",
    seconds: "s",
});
const cleanMetric = (metric, onDrop) => {
    const name = eventName(metric.name, onDrop);
    if (name === "<redacted>") {
        return [];
    }
    const candidateUnit = legacyUnits[metric.unit ?? ""] ?? metric.unit;
    const unit = candidateUnit &&
        /^(?:1|s|ms|us|ns|By|KiBy|MiBy|GiBy|Hz|%|\{[a-z_]{1,24}\})$/u.test(candidateUnit)
        ? candidateUnit
        : "1";
    const base = { name, unit };
    const point = (value) => ({
        ...value,
        attributes: wireAttributes(value.attributes ?? [], onDrop),
        exemplars: [],
    });
    // Keep the native numeric conversion, but omit descriptions and exemplars.
    return [
        ...(metric.sum?.dataPoints ?? []).map((value) => ({
            ...base,
            sum: {
                aggregationTemporality: metric.sum?.aggregationTemporality ?? 2,
                dataPoints: [point(value)],
                isMonotonic: metric.sum?.isMonotonic ?? false,
            },
        })),
        ...(metric.gauge?.dataPoints ?? []).map((value) => ({
            ...base,
            gauge: { dataPoints: [point(value)] },
        })),
        ...(metric.histogram?.dataPoints ?? []).map((value) => ({
            ...base,
            histogram: { ...metric.histogram, dataPoints: [point(value)] },
        })),
        ...(metric.exponentialHistogram?.dataPoints ?? []).map((value) => ({
            ...base,
            exponentialHistogram: {
                ...metric.exponentialHistogram,
                dataPoints: [point(value)],
            },
        })),
        ...(metric.summary?.dataPoints ?? []).map((value) => ({
            ...base,
            summary: {
                dataPoints: [
                    {
                        ...value,
                        attributes: wireAttributes(value.attributes ?? [], onDrop),
                    },
                ],
            },
        })),
    ];
};
// Snapshot conversion comes from Effect, including histogram/frequency/summary support.
// The native exporter only talks to this immediate in-memory adapter, never the network.
export const makeMetrics = (resource, offer, onDrop) => Effect.gen(function* acquireMetricsBridge() {
    const serialization = OtlpSerialization.OtlpSerialization.of({
        logs: () => HttpBody.empty,
        metrics: (data) => {
            for (const group of data.resourceMetrics) {
                for (const scope of group.scopeMetrics) {
                    for (const metric of scope.metrics) {
                        for (const record of cleanMetric(metric, onDrop)) {
                            offer({ record, signal: "metrics" });
                        }
                    }
                }
            }
            return HttpBody.empty;
        },
        traces: () => HttpBody.empty,
    });
    const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))));
    const context = yield* Layer.build(OtlpMetrics.layer({
        exportInterval: "1 day",
        resource: { serviceName: String(resource["service.name"]) },
        shutdownTimeout: 0,
        url: "http://localhost",
    }).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), Layer.succeed(OtlpSerialization.OtlpSerialization, serialization), ConfigProvider.layer(ConfigProvider.fromUnknown({}))))));
    return Context.get(context, OtlpExporter.Flusher).flush;
});
export const encode = (items, resource) => {
    const wireResource = resourceFromAttributes(resource);
    const scope = { name: "@fleet-telemetry/otel-layer", version: "0.1.0" };
    const spans = [];
    const logs = [];
    const metrics = [];
    for (const item of items) {
        if (item.signal === "traces") {
            spans.push(item.record);
        }
        else if (item.signal === "logs") {
            logs.push(item.record);
        }
        else {
            metrics.push(item.record);
        }
    }
    const result = [];
    if (spans.length) {
        result.push({
            body: HttpBody.jsonUnsafe({
                resourceSpans: [
                    { resource: wireResource, scopeSpans: [{ scope, spans }] },
                ],
            }),
            count: spans.length,
            signal: "traces",
        });
    }
    if (logs.length) {
        result.push({
            body: HttpBody.jsonUnsafe({
                resourceLogs: [
                    { resource: wireResource, scopeLogs: [{ logRecords: logs, scope }] },
                ],
            }),
            count: logs.length,
            signal: "logs",
        });
    }
    if (metrics.length) {
        result.push({
            body: HttpBody.jsonUnsafe({
                resourceMetrics: [
                    { resource: wireResource, scopeMetrics: [{ metrics, scope }] },
                ],
            }),
            count: metrics.length,
            signal: "metrics",
        });
    }
    return result;
};
