/* oxlint-disable eslint/require-await -- Async test doubles must return rejected Promises rather than throw synchronously. */
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Effect, Redacted } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import {
  COLLECTOR_VERSION,
  DARWIN_ARM64_SHA256,
  makeBinaryDriver,
  verifyArchive,
} from "./collector-binary.js";
import { makeLaunchdDriver, renderPlist } from "./launchd-agent.js";
import type { Launchctl, LaunchdAgentProps } from "./launchd-agent.js";
import { operation } from "./operation.js";

const root =
  process.env.FLEET_TEST_ROOT ??
  path.join(homedir(), ".cache", "fleet-telemetry-tests");
beforeAll(async () => {
  await mkdir(root, { mode: 0o700, recursive: true });
});
const fixture = () => mkdtemp(path.join(root, "resource-test-"));
const propsFor = (home: string): LaunchdAgentProps => ({
  env: { TEST_VALUE: Redacted.make("a&b<secret>") },
  label: "com.example.collector-test",
  programArguments: ["/usr/bin/true", "argument with <&>"],
  stderrPath: path.join(home, "logs", "stderr"),
  stdoutPath: path.join(home, "logs", "stdout"),
  workingDirectory: path.join(home, "work"),
});

const missing = () =>
  Object.assign(new Error("service absent"), {
    stderr: "Could not find service",
  });
const fakeLaunchctl = () => {
  const calls: (readonly string[])[] = [];
  let state: "absent" | "running" = "absent";
  const run: Launchctl = async (args) => {
    calls.push(args);
    switch (args[0]) {
      case "print": {
        if (state === "absent") {
          throw missing();
        }
        return "state = running\n";
      }
      case "bootout": {
        if (state === "absent") {
          throw missing();
        }
        state = "absent";
        return "";
      }
      case "bootstrap": {
        state = "running";
        return "";
      }
      default: {
        throw new Error("Unexpected launchctl command");
      }
    }
  };
  return { calls, run };
};

describe("LaunchdAgent generic resource", () => {
  it("renders escaped arguments, env and launchd lifecycle flags", async () => {
    const home = await fixture();
    const text = renderPlist(propsFor(home), "test:owner");
    expect(text).toContain("a&amp;b&lt;secret&gt;");
    expect(text).toContain("argument with &lt;&amp;&gt;");
    expect(text).toContain("<key>KeepAlive</key><true/>");
    expect(text).toContain("<key>ThrottleInterval</key><integer>10</integer>");
    expect(text).not.toContain("collector.yaml");
  });

  it("creates mode-600 plist, updates, reads running and deletes idempotently", async () => {
    const home = await fixture();
    const fake = fakeLaunchctl();
    const driver = makeLaunchdDriver({
      home,
      launchctl: fake.run,
      platform: "darwin",
      uid: 501,
    });
    const props = propsFor(home);
    expect(await driver.read(props, "test:owner")).toBeUndefined();
    const created = await driver.reconcile(props, "test:owner");
    const stat = await lstat(created.plistPath);
    // oxlint-disable-next-line eslint/no-bitwise -- Verify Unix permission bits.
    expect(stat.mode & 0o777).toBe(0o600);
    expect(created.running).toBe(true);
    const changed = await driver.reconcile(
      { ...props, keepAlive: false, throttleInterval: 20 },
      "test:owner"
    );
    expect(changed.digest).not.toBe(created.digest);
    expect(await readFile(created.plistPath, "utf-8")).toContain(
      "<key>KeepAlive</key><false/>"
    );
    expect(fake.calls.filter((call) => call[0] === "bootstrap")).toHaveLength(
      2
    );
    expect(
      fake.calls.some(
        (call) => call[0] === "bootstrap" && call[1] === "gui/501"
      )
    ).toBe(true);
    await driver.delete(props, "test:owner");
    await driver.delete(props, "test:owner");
    expect(await driver.read(props, "test:owner")).toBeUndefined();
  });

  it("does not overwrite, adopt or delete an unmanaged plist", async () => {
    const home = await fixture();
    const props = propsFor(home);
    const dir = path.join(home, "Library", "LaunchAgents");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${props.label}.plist`);
    await writeFile(file, "USER WORK");
    const fake = fakeLaunchctl();
    const driver = makeLaunchdDriver({
      home,
      launchctl: fake.run,
      platform: "darwin",
      uid: 501,
    });
    await expect(driver.reconcile(props, "test:owner")).rejects.toThrow(
      "unmanaged"
    );
    await expect(driver.delete(props, "test:owner")).rejects.toThrow(
      "unmanaged"
    );
    expect(await readFile(file, "utf-8")).toBe("USER WORK");
    expect(fake.calls).toHaveLength(0);
  });

  it("does not swallow launchctl permission failures", async () => {
    const home = await fixture();
    const driver = makeLaunchdDriver({
      home,
      launchctl: async () => {
        throw Object.assign(new Error("denied"), {
          stderr: "Operation not permitted",
        });
      },
      platform: "darwin",
      uid: 501,
    });
    await expect(
      driver.reconcile(propsFor(home), "test:owner")
    ).rejects.toThrow("denied");
  });

  it("rejects path traversal, relative program paths and XML control characters", async () => {
    const props = propsFor(await fixture());
    expect(() =>
      renderPlist({ ...props, label: "../../owned" }, "owner")
    ).toThrow("Label");
    expect(() =>
      renderPlist({ ...props, programArguments: ["relative"] }, "owner")
    ).toThrow("absolute");
    expect(() =>
      renderPlist(
        { ...props, env: { INVALID: String.fromCodePoint(0) } },
        "owner"
      )
    ).toThrow("control");
  });

  it("refuses Linux without invoking launchctl", async () => {
    const home = await fixture();
    const fake = fakeLaunchctl();
    const driver = makeLaunchdDriver({
      home,
      launchctl: fake.run,
      platform: "linux",
      uid: 501,
    });
    await expect(
      driver.reconcile(propsFor(home), "test:owner")
    ).rejects.toThrow("macOS");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("CollectorBinary pinned installer", () => {
  it("rejects checksum-file substitution and archive tampering", () => {
    expect(() =>
      verifyArchive(new Uint8Array([1]), DARWIN_ARM64_SHA256)
    ).toThrow("sha256");
    expect(() => verifyArchive(new Uint8Array([1]), "a".repeat(64))).toThrow(
      "sha256"
    );
  });

  it("is idempotent for a verified installation and detects binary corruption", async () => {
    const home = await fixture();
    const directory = path.join(
      home,
      ".local",
      "opt",
      "otelcol-contrib",
      COLLECTOR_VERSION
    );
    await mkdir(directory, { recursive: true });
    const binary = path.join(directory, "otelcol-contrib");
    await writeFile(binary, "fixture binary", { mode: 0o700 });
    await writeFile(
      path.join(directory, "verified.json"),
      JSON.stringify({
        archiveSha256: DARWIN_ARM64_SHA256,
        binarySha256: createHash("sha256")
          .update("fixture binary")
          .digest("hex"),
      })
    );
    const driver = makeBinaryDriver({
      arch: "arm64",
      download: async () => {
        throw new Error("Must not download");
      },
      home,
      platform: "darwin",
    });
    const installed = await driver.reconcile({ version: COLLECTOR_VERSION });
    expect(installed.path).toBe(binary);
    await writeFile(binary, "corrupted");
    await expect(driver.read()).rejects.toThrow("hash changed");
  });

  it("rejects unsupported platforms without touching the filesystem", async () => {
    const driver = makeBinaryDriver({
      arch: "x64",
      home: await fixture(),
      platform: "linux",
    });
    await expect(driver.read()).rejects.toThrow("darwin-arm64");
  });

  it("cleans failed staging without creating an installation", async () => {
    const home = await fixture();
    const driver = makeBinaryDriver({
      arch: "arm64",
      download: async () => new Uint8Array([1]),
      home,
      platform: "darwin",
    });
    await expect(
      driver.reconcile({ version: COLLECTOR_VERSION })
    ).rejects.toThrow("sha256");
    expect(
      await readdir(path.join(home, ".local", "opt", "otelcol-contrib"))
    ).toEqual([]);
  });

  it.skipIf(!process.env.COLLECTOR_TEST_ARCHIVE)(
    "installs the actual verified release and skips download on a second reconcile",
    async () => {
      const archivePath = process.env.COLLECTOR_TEST_ARCHIVE;
      if (!archivePath) {
        throw new Error("COLLECTOR_TEST_ARCHIVE required");
      }
      const archive = await readFile(archivePath);
      const home = await fixture();
      let downloads = 0;
      const driver = makeBinaryDriver({
        arch: "arm64",
        download: async (url) => {
          downloads += 1;
          return url.endsWith(".sha256")
            ? new TextEncoder().encode(DARWIN_ARM64_SHA256)
            : archive;
        },
        home,
        platform: "darwin",
      });
      const installed = await driver.reconcile({ version: COLLECTOR_VERSION });
      expect(installed.archiveSha256).toBe(DARWIN_ARM64_SHA256);
      expect(await driver.reconcile({ version: COLLECTOR_VERSION })).toEqual(
        installed
      );
      expect(downloads).toBe(2);
    }
  );
});

it("keeps adapter errors in the typed Effect failure channel", async () => {
  const effect = operation("test", async () => {
    throw new Error("failure");
  });
  const result = await Effect.runPromise(Effect.flip(effect));
  expect(result._tag).toBe("LocalResourceError");
  expect(result.operation).toBe("test");
});
