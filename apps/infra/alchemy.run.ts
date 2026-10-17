import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as Alchemy from "alchemy";
import { localState } from "alchemy/State";
import { Config, Effect, Layer } from "effect";

import {
  CollectorBinary,
  CollectorBinaryProvider,
  COLLECTOR_VERSION,
} from "./src/collector-binary.js";
import {
  collectorSettings,
  DEFAULT_LOOPBACK_GRPC_PORT,
  DEFAULT_LOOPBACK_HTTP_PORT,
  DEFAULT_QUEUE_BYTES,
} from "./src/collector-settings.js";
import { LaunchdAgent, LaunchdAgentProvider } from "./src/launchd-agent.js";
import { operation } from "./src/operation.js";

const configPath = fileURLToPath(
  new URL("../collector/collector.yaml", import.meta.url)
);
const startPath = fileURLToPath(
  new URL("../../scripts/collector.sh", import.meta.url)
);

export default Alchemy.Stack(
  "fleet-telemetry",
  {
    providers: Layer.merge(CollectorBinaryProvider(), LaunchdAgentProvider()),
    state: localState(),
  },
  Effect.gen(function* collectorStack() {
    const home = yield* Config.String("HOME");
    const dataDirectory = yield* Config.String("OTEL_DATA_DIR").pipe(
      Config.withDefault(path.join(home, ".local", "share", "fleet-telemetry"))
    );
    const collectorHost = yield* Config.String("OTEL_COLLECTOR_HOST");
    const endpoint = yield* Config.String("CLICKHOUSE_ENDPOINT");
    const username = yield* Config.String("CLICKHOUSE_USERNAME").pipe(
      Config.withDefault("default")
    );
    const password = yield* Config.Redacted("CLICKHOUSE_PASSWORD").pipe(
      Config.withDefault("")
    );
    const bind = yield* Config.String("OTEL_TAILNET_BIND");
    const queueBytes = yield* Config.Int("OTEL_QUEUE_BYTES").pipe(
      Config.withDefault(DEFAULT_QUEUE_BYTES)
    );
    const loopbackGrpcPort = yield* Config.Int("OTEL_LOOPBACK_GRPC_PORT").pipe(
      Config.withDefault(DEFAULT_LOOPBACK_GRPC_PORT)
    );
    const loopbackHttpPort = yield* Config.Int("OTEL_LOOPBACK_HTTP_PORT").pipe(
      Config.withDefault(DEFAULT_LOOPBACK_HTTP_PORT)
    );
    const settings = yield* operation("CollectorSettings.validate", () =>
      Promise.resolve(
        collectorSettings(bind, queueBytes, loopbackGrpcPort, loopbackHttpPort)
      )
    ).pipe(Effect.orDie);
    const configDigest = yield* operation("CollectorConfig.digest", async () =>
      createHash("sha256")
        .update(await readFile(configPath))
        .update(await readFile(startPath))
        .digest("hex")
    ).pipe(Effect.orDie);
    const binary = yield* CollectorBinary("Binary", {
      version: COLLECTOR_VERSION,
    });
    const agent = yield* LaunchdAgent("Collector", {
      env: {
        CLICKHOUSE_ENDPOINT: endpoint,
        CLICKHOUSE_PASSWORD: password,
        CLICKHOUSE_USERNAME: username,
        ...settings,
        OTEL_COLLECTOR_HOST: collectorHost,
        // Config or preflight changes restart the agent.
        OTEL_CONFIG_SHA256: configDigest,
        OTEL_DATA_DIR: dataDirectory,
      },
      keepAlive: true,
      label: "com.fleet-telemetry.collector",
      programArguments: [
        "/bin/sh",
        startPath,
        binary.path,
        "--config",
        configPath,
      ],
      stderrPath: path.join(dataDirectory, "collector.stderr.log"),
      stdoutPath: path.join(dataDirectory, "collector.stdout.log"),
      throttleInterval: 10,
      workingDirectory: dataDirectory,
    });
    return {
      binary: binary.path,
      label: agent.label,
      plistPath: agent.plistPath,
      running: agent.running,
    };
  })
);
