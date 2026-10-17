import { Effect, Logger, Tracer } from "effect";
import { HttpBody } from "effect/http";
import { OtlpMetrics, OtlpResource } from "effect/observability";
import type { OtlpLogger, OtlpTracer } from "effect/observability";
import type { Attributes, OnDrop } from "./attributes.js";
type WireSpan = OtlpTracer.TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number];
type WireLog = NonNullable<OtlpLogger.LogsData["resourceLogs"][number]["scopeLogs"][number]["logRecords"]>[number];
type WireMetric = OtlpMetrics.MetricsData["resourceMetrics"][number]["scopeMetrics"][number]["metrics"][number];
export type RecordItem = {
    readonly signal: "traces";
    readonly record: WireSpan;
} | {
    readonly signal: "logs";
    readonly record: WireLog;
} | {
    readonly signal: "metrics";
    readonly record: WireMetric;
};
export type SpanRecord = WireSpan;
export type LogRecord = WireLog;
export type MetricRecord = WireMetric;
export type Resource = OtlpResource.Resource;
export declare const resourceFromAttributes: (attributes: Attributes) => Resource;
export declare const makeTracer: (offer: (item: RecordItem) => void, onDrop: OnDrop) => Tracer.Tracer;
export declare const makeLogger: (offer: (item: RecordItem) => void, onDrop: OnDrop) => Logger.Logger<unknown, void>;
export declare const makeMetrics: (resource: Attributes, offer: (item: RecordItem) => void, onDrop: OnDrop) => Effect.Effect<Effect.Effect<void, never, never>, never, import("effect/Scope").Scope>;
export declare const encode: (items: readonly RecordItem[], resource: Attributes) => readonly {
    signal: RecordItem["signal"];
    body: HttpBody.HttpBody;
    count: number;
}[];
export {};
