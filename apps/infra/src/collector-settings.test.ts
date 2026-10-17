import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectorSettings,
  DEFAULT_QUEUE_BYTES,
} from "./collector-settings.js";

const start = fileURLToPath(
  new URL("../../../scripts/collector.sh", import.meta.url)
);

const servers = new Set<Server>();
const listen = async (host = "127.0.0.1") => {
  const server = createServer();
  servers.add(server);
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP address");
  }
  return { port: address.port, server };
};
const close = (server: Server) => promisify(server.close.bind(server))();
const freePorts = async () => {
  const first = await listen();
  const second = await listen();
  await Promise.all([close(first.server), close(second.server)]);
  return [first.port, second.port] as const;
};
const preflight = (env: Record<string, string>) =>
  spawnSync("/bin/sh", [start, "/bin/sh", "-c", "echo executed"], {
    encoding: "utf-8",
    env: { OTEL_TAILNET_BIND: "127.0.0.2", ...env },
    timeout: 10_000,
  });
afterEach(async () => {
  await Promise.all(
    [...servers].filter((server) => server.listening).map(close)
  );
  servers.clear();
});

describe("Collector settings", () => {
  it("forwards an explicit address and the default 20 GiB per-signal byte cap", () => {
    expect(collectorSettings("127.0.0.2", DEFAULT_QUEUE_BYTES)).toEqual({
      OTEL_LOOPBACK_GRPC_PORT: "4317",
      OTEL_LOOPBACK_HTTP_PORT: "4318",
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

  it("preflight execs the pinned command with free loopback ports", async () => {
    const [grpc, http] = await freePorts();
    const result = preflight({
      OTEL_LOOPBACK_GRPC_PORT: String(grpc),
      OTEL_LOOPBACK_HTTP_PORT: String(http),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("executed\n");
  });

  it("forwards independent loopback overrides and accepts boundary ports", () => {
    const settings = collectorSettings(
      "127.0.0.2",
      DEFAULT_QUEUE_BYTES,
      14_317,
      14_318
    );
    expect(settings.OTEL_LOOPBACK_GRPC_PORT).toBe("14317");
    expect(settings.OTEL_LOOPBACK_HTTP_PORT).toBe("14318");
    expect(
      collectorSettings("127.0.0.2", DEFAULT_QUEUE_BYTES, 1024, 65_535)
    ).toMatchObject({
      OTEL_LOOPBACK_GRPC_PORT: "1024",
      OTEL_LOOPBACK_HTTP_PORT: "65535",
    });
  });

  it.each([
    0,
    1023,
    65_536,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    13_133,
    8888,
  ])(
    "refuses invalid or reserved loopback port %s in either stack input",
    (port) => {
      expect(() =>
        collectorSettings("127.0.0.2", DEFAULT_QUEUE_BYTES, port, 14_318)
      ).toThrow("OTEL_LOOPBACK_GRPC_PORT");
      expect(() =>
        collectorSettings("127.0.0.2", DEFAULT_QUEUE_BYTES, 14_317, port)
      ).toThrow("OTEL_LOOPBACK_HTTP_PORT");
    }
  );

  it("refuses identical loopback ports", () => {
    expect(() =>
      collectorSettings("127.0.0.2", DEFAULT_QUEUE_BYTES, 14_317, 14_317)
    ).toThrow("distinct");
  });

  it.each([
    "0",
    "1023",
    "65536",
    "-1",
    "1.5",
    "invalid",
    "04317",
    "13133",
    "8888",
    "14317",
  ])(
    "preflight refuses invalid, reserved or duplicate loopback port %s",
    (port) => {
      for (const name of [
        "OTEL_LOOPBACK_GRPC_PORT",
        "OTEL_LOOPBACK_HTTP_PORT",
      ]) {
        const result = preflight({
          OTEL_LOOPBACK_GRPC_PORT: "14317",
          OTEL_LOOPBACK_HTTP_PORT: "14317",
          [name]: port,
        });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("must be an integer");
      }
    }
  );

  it("preflight excludes overridden health and metrics ports", () => {
    for (const reserved of ["OTEL_HEALTH_PORT", "OTEL_METRICS_PORT"]) {
      const result = preflight({
        OTEL_LOOPBACK_GRPC_PORT: "14317",
        OTEL_LOOPBACK_HTTP_PORT: "14318",
        [reserved]: "14317",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("health and metrics ports");
    }
  });

  it.each(["grpc", "http"])(
    "preflight refuses an occupied loopback %s port before exec",
    async (signal) => {
      const occupied = await listen();
      const [other] = await freePorts();
      const env = {
        OTEL_LOOPBACK_GRPC_PORT: String(
          signal === "grpc" ? occupied.port : other
        ),
        OTEL_LOOPBACK_HTTP_PORT: String(
          signal === "http" ? occupied.port : other
        ),
      };
      const result = preflight(env);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `OTEL_LOOPBACK_${signal.toUpperCase()}_PORT: port in use at 127.0.0.1:${occupied.port}`
      );
    }
  );

  it("preflight treats wildcard listeners as loopback conflicts", async () => {
    const occupied = await listen("0.0.0.0");
    const [other] = await freePorts();
    const result = preflight({
      OTEL_LOOPBACK_GRPC_PORT: String(occupied.port),
      OTEL_LOOPBACK_HTTP_PORT: String(other),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("port in use");
    expect(result.stdout).toBe("");
  });

  it("preflight does not mistake a different interface's listener for loopback", async () => {
    const otherInterface = await listen("127.0.0.2");
    const [http] = await freePorts();
    const result = preflight({
      OTEL_LOOPBACK_GRPC_PORT: String(otherInterface.port),
      OTEL_LOOPBACK_HTTP_PORT: String(http),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("executed\n");
  });
});
