import { isIPv4 } from "node:net";

export const DEFAULT_QUEUE_BYTES = 20 * 1024 ** 3;

/** Validate before resource creation; launchd does not inherit shell variables. */
export const collectorSettings = (bind: string, queueBytes: number) => {
  if (!isIPv4(bind) || bind.startsWith("0.") || bind === "127.0.0.1") {
    throw new Error(
      "OTEL_TAILNET_BIND must be an explicit non-wildcard IPv4 address distinct from loopback"
    );
  }
  if (!Number.isSafeInteger(queueBytes) || queueBytes <= 0) {
    throw new Error("OTEL_QUEUE_BYTES must be a positive safe integer");
  }
  return {
    OTEL_QUEUE_BYTES: String(queueBytes),
    OTEL_TAILNET_BIND: bind,
  };
};
