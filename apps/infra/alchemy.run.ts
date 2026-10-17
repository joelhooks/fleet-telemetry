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
import { LaunchdAgent, LaunchdAgentProvider } from "./src/launchd-agent.js";
import { operation } from "./src/operation.js";

const configPath = fileURLToPath(
  new URL("../collector/collector.yaml", import.meta.url)
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
    const bind = yield* Config.String("OTEL_BIND").pipe(
      Config.withDefault("127.0.0.1")
    );
    const configDigest = yield* operation("CollectorConfig.digest", async () =>
      createHash("sha256")
        .update(await readFile(configPath))
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
        OTEL_BIND: bind,
        OTEL_COLLECTOR_HOST: collectorHost,
        // A config change changes the resource digest and restarts the agent.
        OTEL_CONFIG_SHA256: configDigest,
        OTEL_DATA_DIR: dataDirectory,
      },
      keepAlive: true,
      label: "com.fleet-telemetry.collector",
      programArguments: [binary.path, "--config", configPath],
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
