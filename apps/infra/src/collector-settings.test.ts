import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  collectorSettings,
  DEFAULT_QUEUE_BYTES,
} from "./collector-settings.js";

const start = fileURLToPath(
  new URL("../../../scripts/collector.sh", import.meta.url)
);

describe("Collector settings", () => {
  it("forwards an explicit address and the default 20 GiB per-signal byte cap", () => {
    expect(collectorSettings("127.0.0.2", DEFAULT_QUEUE_BYTES)).toEqual({
      OTEL_QUEUE_BYTES: "21474836480",
      OTEL_TAILNET_BIND: "127.0.0.2",
    });
    expect(collectorSettings("127.0.0.2", 1_048_576).OTEL_QUEUE_BYTES).toBe(
      "1048576"
    );
  });

  it.each([
    "",
    "0.0.0.0",
    "::",
    "[::]",
    "127.0.0.1",
    "example.invalid",
    "127.0.0.2:4317",
  ])("refuses invalid, wildcard or colliding stack address %s", (bind) =>
    expect(() => collectorSettings(bind, DEFAULT_QUEUE_BYTES)).toThrow(
      "OTEL_TAILNET_BIND"
    )
  );

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("refuses invalid byte budgets %s", (size) =>
    expect(() => collectorSettings("127.0.0.2", size)).toThrow(
      "OTEL_QUEUE_BYTES"
    )
  );

  it.each([
    undefined,
    "",
    "0.0.0.0",
    "::",
    "[::]",
    "127.0.0.1",
    "example.invalid",
    "127.0.0.2:4317",
    "127.0.0.2\n127.0.0.3",
  ])("preflight fails before exec with missing or unsafe bind %s", (bind) => {
    const result = spawnSync(
      "/bin/sh",
      [start, "/bin/sh", "-c", "echo executed"],
      {
        encoding: "utf-8",
        env: bind === undefined ? {} : { OTEL_TAILNET_BIND: bind },
      }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OTEL_TAILNET_BIND");
    expect(result.stdout).toBe("");
  });

  it("preflight execs the pinned command for a concrete second address", () => {
    const result = spawnSync(
      "/bin/sh",
      [start, "/bin/sh", "-c", "echo executed"],
      {
        encoding: "utf-8",
        env: { OTEL_TAILNET_BIND: "127.0.0.2" },
      }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("executed\n");
  });
});
