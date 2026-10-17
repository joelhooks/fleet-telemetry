import { isIPv4 } from "node:net";

export const DEFAULT_QUEUE_BYTES = 20 * 1024 ** 3;
export const DEFAULT_LOOPBACK_GRPC_PORT = 4317;
export const DEFAULT_LOOPBACK_HTTP_PORT = 4318;

/** Validate before resource creation; launchd does not inherit shell variables. */
export const collectorSettings = (
  bind: string,
  queueBytes: number,
  grpcPort = DEFAULT_LOOPBACK_GRPC_PORT,
  httpPort = DEFAULT_LOOPBACK_HTTP_PORT
) => {
  if (!isIPv4(bind) || bind.startsWith("0.") || bind === "127.0.0.1") {
    throw new Error(
      "OTEL_TAILNET_BIND must be an explicit non-wildcard IPv4 address distinct from loopback"
    );
  }
  if (!Number.isSafeInteger(queueBytes) || queueBytes <= 0) {
    throw new Error("OTEL_QUEUE_BYTES must be a positive safe integer");
  }
  for (const [name, port] of [
    ["OTEL_LOOPBACK_GRPC_PORT", grpcPort],
    ["OTEL_LOOPBACK_HTTP_PORT", httpPort],
  ] as const) {
    if (
      !Number.isSafeInteger(port) ||
      port < 1024 ||
      port > 65_535 ||
      [13_133, 8888].includes(port)
    ) {
      throw new Error(
        `${name} must be an integer from 1024 to 65535, excluding health and metrics ports`
      );
    }
  }
  if (grpcPort === httpPort) {
    throw new Error(
      "OTEL_LOOPBACK_GRPC_PORT and OTEL_LOOPBACK_HTTP_PORT must be distinct"
    );
  }
  return {
    OTEL_LOOPBACK_GRPC_PORT: String(grpcPort),
    OTEL_LOOPBACK_HTTP_PORT: String(httpPort),
    OTEL_QUEUE_BYTES: String(queueBytes),
    OTEL_TAILNET_BIND: bind,
  };
};
