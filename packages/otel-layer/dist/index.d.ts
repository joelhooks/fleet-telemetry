import { Context, Effect, Layer } from "effect";
import type { Attributes, DropClass } from "./attributes.js";
import type { LogRecord, MetricRecord, SpanRecord } from "./effect-bridge.js";
import { TestService } from "./test-service.js";
export { fleetAttributes, sanitizeAttribute, sanitizeAttributes, semanticPrefixes, USAGE_COUNTER_KEYS, } from "./attributes.js";
export type { Attributes, AttributeValue, DropClass } from "./attributes.js";
export type { LogRecord, MetricRecord, SpanRecord } from "./effect-bridge.js";
export interface Options {
    readonly serviceName?: string;
    readonly serviceVersion?: string;
    readonly hostName?: string;
    readonly environment?: string;
    readonly project?: string;
    readonly musterRow?: string;
    readonly revision?: string;
    readonly ratkingName?: string;
    readonly endpoint?: string;
    readonly bufferSize?: number;
    readonly exportIntervalMs?: number;
    readonly exportTimeoutMs?: number;
}
export interface Counters {
    readonly droppedAttributes: Readonly<Record<DropClass, number>>;
    readonly droppedItems: number;
    readonly failedExports: number;
    readonly exportedItems: number;
    readonly queuedItems: number;
}
export interface Interface {
    readonly enabled: boolean;
    readonly resource: Attributes;
    readonly counters: Effect.Effect<Counters>;
    /** Explicit opt-in wait. Normal instrumentation and scope closure never await HTTP. */
    readonly flush: Effect.Effect<void>;
}
declare const Service_base: Context.ServiceClass<Service, "@fleet-telemetry/otel-layer", Interface>;
export declare class Service extends Service_base {
}
export interface TestInterface extends Interface {
    readonly spans: Effect.Effect<readonly SpanRecord[]>;
    readonly logs: Effect.Effect<readonly LogRecord[]>;
    readonly metrics: Effect.Effect<readonly MetricRecord[]>;
    readonly findSpan: (name: string) => Effect.Effect<SpanRecord | undefined>;
    readonly clear: Effect.Effect<void>;
}
export { TestService } from "./test-service.js";
/** Install once at the application boundary. No endpoint means no exporter or runtime hooks. */
export declare const layer: (options?: Options) => Layer.Layer<Service>;
export declare const layerFromEnv: () => Layer.Layer<Service>;
/** Fresh capture state per layer build. No network, including when an endpoint is in the environment. */
export declare const layerTestWith: (options?: Options) => Layer.Layer<Service | TestService>;
export declare const layerTest: Layer.Layer<Service | TestService, never, never>;
export declare const FleetTelemetry: {
    Service: typeof Service;
    TestService: typeof TestService;
    USAGE_COUNTER_KEYS: readonly string[];
    layer: typeof layer;
    layerFromEnv: typeof layerFromEnv;
    layerTest: Layer.Layer<Service | TestService, never, never>;
    layerTestWith: typeof layerTestWith;
};
