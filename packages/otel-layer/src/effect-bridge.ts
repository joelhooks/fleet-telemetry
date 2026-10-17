// Effect 4.0.5 compatibility boundary. Only this module knows OTLP wire shapes.
import type { Cause } from "effect";
import {
  Clock,
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  References,
  Tracer,
} from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/http";
import {
  OtlpExporter,
  OtlpMetrics,
  OtlpResource,
  OtlpSerialization,
} from "effect/observability";
import type { OtlpLogger, OtlpTracer } from "effect/observability";

import {
  eventName,
  sanitizeAttribute,
  sanitizeAttributes,
} from "./attributes.js";
import type { Attributes, OnDrop } from "./attributes.js";

type WireSpan =
  OtlpTracer.TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number];
type WireLog = NonNullable<
  OtlpLogger.LogsData["resourceLogs"][number]["scopeLogs"][number]["logRecords"]
>[number];
type WireMetric =
  OtlpMetrics.MetricsData["resourceMetrics"][number]["scopeMetrics"][number]["metrics"][number];
export type RecordItem =
  | { readonly signal: "traces"; readonly record: WireSpan }
  | { readonly signal: "logs"; readonly record: WireLog }
  | { readonly signal: "metrics"; readonly record: WireMetric };
export type SpanRecord = WireSpan;
export type LogRecord = WireLog;
export type MetricRecord = WireMetric;
export type Resource = OtlpResource.Resource;

export const resourceFromAttributes = (attributes: Attributes): Resource => ({
  attributes: OtlpResource.entriesToAttributes(Object.entries(attributes)),
  droppedAttributesCount: 0,
});

const errorType = (
  cause: Cause.Cause<unknown>,
  onDrop: OnDrop
): string | undefined => {
  const [reason] = cause.reasons;
  if (!reason) {
    return;
  }
  // Never serialize a Cause, stack or message.
  onDrop("free_text");
  let value: unknown;
  if (reason._tag === "Fail") {
    value = reason.error;
  } else if (reason._tag === "Die") {
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
} as const;

const validTraceId = (value: string): boolean => /^[a-f0-9]{32}$/iu.test(value);
const validSpanId = (value: string): boolean => /^[a-f0-9]{16}$/iu.test(value);

const protect = (onDrop: OnDrop, run: () => void) => {
  try {
    run();
  } catch {
    onDrop("invalid_value");
  }
};

export const makeTracer = (
  offer: (item: RecordItem) => void,
  onDrop: OnDrop
): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan({ ...options, links: [] });
      const events: WireSpan["events"] = [];
      const links: WireSpan["links"] = [];
      let ended = false;
      span.attribute = (key, value) =>
        protect(onDrop, () => {
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
      span.event = (name, time, attributes) =>
        protect(onDrop, () => {
          if (ended) {
            return;
          }
          if (events.length >= 32) {
            onDrop("limit");
            return;
          }
          events.push({
            attributes: OtlpResource.entriesToAttributes(
              Object.entries(
                sanitizeAttributes(Object.entries(attributes ?? {}), onDrop)
              )
            ),
            droppedAttributesCount: 0,
            name: eventName(name, onDrop),
            timeUnixNano: String(time),
          });
        });
      span.addLinks = (newLinks) =>
        protect(onDrop, () => {
          if (ended) {
            return;
          }
          for (const link of newLinks) {
            if (links.length >= 16) {
              onDrop("limit");
              break;
            }
            if (
              !validTraceId(link.span.traceId) ||
              !validSpanId(link.span.spanId)
            ) {
              onDrop("invalid_value");
              continue;
            }
            links.push({
              attributes: OtlpResource.entriesToAttributes(
                Object.entries(
                  sanitizeAttributes(
                    Object.entries(link.attributes ?? {}),
                    onDrop
                  )
                )
              ),
              droppedAttributesCount: 0,
              spanId: link.span.spanId,
              traceId: link.span.traceId,
            });
          }
        });
      span.addLinks(options.links);
      span.end = (time, exit) =>
        protect(onDrop, () => {
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
          const record: WireSpan = {
            attributes: OtlpResource.entriesToAttributes(
              Object.entries(sanitizeAttributes(span.attributes, onDrop))
            ),
            droppedAttributesCount: 0,
            droppedEventsCount: 0,
            droppedLinksCount: 0,
            endTimeUnixNano: String(time),
            events,
            kind: kinds[span.kind],
            links,
            name: eventName(span.name, onDrop),
            parentSpanId:
              parent && validSpanId(parent.spanId) ? parent.spanId : "",
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
} as const;

export const makeLogger = (
  offer: (item: RecordItem) => void,
  onDrop: OnDrop
): Logger.Logger<unknown, void> =>
  Logger.make((options) => {
    try {
      const attributes: Record<string, unknown> = {
        ...options.fiber.getRef(References.CurrentLogAnnotations),
      };
      const type = errorType(options.cause, onDrop);
      if (type) {
        attributes["error.type"] = type;
      }
      const messages = Array.isArray(options.message)
        ? options.message
        : [options.message];
      const record: WireLog = {
        attributes: OtlpResource.entriesToAttributes(
          Object.entries(
            sanitizeAttributes(
              Object.entries({
                ...attributes,
                "event.name": eventName(
                  messages.length === 1 ? messages[0] : undefined,
                  onDrop
                ),
              }),
              onDrop
            )
          )
        ),
        body: { stringValue: "<redacted>" },
        droppedAttributesCount: 0,
        flags: 0,
        observedTimeUnixNano: String(
          options.fiber.getRef(Clock.Clock).currentTimeNanosUnsafe()
        ),
        severityNumber: severity[options.logLevel],
        severityText: options.logLevel,
        timeUnixNano: String(BigInt(options.date.getTime()) * 1_000_000n),
      };
      const { span } = options.fiber.cache;
      if (span && validTraceId(span.traceId) && validSpanId(span.spanId)) {
        record.traceId = span.traceId;
        record.spanId = span.spanId;
      }
      offer({ record, signal: "logs" });
    } catch {
      onDrop("invalid_value");
    }
  });

const fromWireValue = (value: OtlpResource.AnyValue): unknown => {
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

const wireAttributes = (
  attributes: readonly OtlpResource.KeyValue[],
  onDrop: OnDrop
) =>
  OtlpResource.entriesToAttributes(
    Object.entries(
      sanitizeAttributes(
        attributes.map(
          ({ key, value }) => [key, fromWireValue(value)] as const
        ),
        onDrop
      )
    )
  );

const legacyUnits: Readonly<Record<string, string>> = Object.freeze({
  bytes: "By",
  microseconds: "us",
  milliseconds: "ms",
  nanoseconds: "ns",
  seconds: "s",
});

const cleanMetric = (metric: WireMetric, onDrop: OnDrop): WireMetric[] => {
  const name = eventName(metric.name, onDrop);
  if (name === "<redacted>") {
    return [];
  }
  const candidateUnit = legacyUnits[metric.unit ?? ""] ?? metric.unit;
  const unit =
    candidateUnit &&
    /^(?:1|s|ms|us|ns|By|KiBy|MiBy|GiBy|Hz|%|\{[a-z_]{1,24}\})$/u.test(
      candidateUnit
    )
      ? candidateUnit
      : "1";
  const base = { name, unit };
  const point = <T extends { attributes?: OtlpResource.KeyValue[] }>(
    value: T
  ) => ({
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
export const makeMetrics = (
  resource: Attributes,
  offer: (item: RecordItem) => void,
  onDrop: OnDrop
) =>
  Effect.gen(function* acquireMetricsBridge() {
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
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))
      )
    );
    const context = yield* Layer.build(
      OtlpMetrics.layer({
        exportInterval: "1 day",
        resource: { serviceName: String(resource["service.name"]) },
        shutdownTimeout: 0,
        url: "http://localhost",
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, client),
            Layer.succeed(OtlpSerialization.OtlpSerialization, serialization),
            ConfigProvider.layer(ConfigProvider.fromUnknown({}))
          )
        )
      )
    );
    return Context.get(context, OtlpExporter.Flusher).flush;
  });

export const encode = (
  items: readonly RecordItem[],
  resource: Attributes
): readonly {
  signal: RecordItem["signal"];
  body: HttpBody.HttpBody;
  count: number;
}[] => {
  const wireResource = resourceFromAttributes(resource);
  const scope = { name: "@fleet-telemetry/otel-layer", version: "0.1.0" };
  const spans: WireSpan[] = [];
  const logs: WireLog[] = [];
  const metrics: WireMetric[] = [];
  for (const item of items) {
    if (item.signal === "traces") {
      spans.push(item.record);
    } else if (item.signal === "logs") {
      logs.push(item.record);
    } else {
      metrics.push(item.record);
    }
  }
  const result: {
    signal: RecordItem["signal"];
    body: HttpBody.HttpBody;
    count: number;
  }[] = [];
  if (spans.length) {
    result.push({
      body: HttpBody.jsonUnsafe({
        resourceSpans: [
          { resource: wireResource, scopeSpans: [{ scope, spans }] },
        ],
      } satisfies OtlpTracer.TraceData),
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
      } satisfies OtlpLogger.LogsData),
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
      } satisfies OtlpMetrics.MetricsData),
      count: metrics.length,
      signal: "metrics",
    });
  }
  return result;
};
