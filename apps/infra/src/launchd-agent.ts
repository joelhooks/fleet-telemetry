/* oxlint-disable eslint/func-style, eslint/no-redeclare, unicorn/consistent-function-scoping -- Named lifecycle helpers and Alchemy's paired resource type/value are intentional. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import pathModule from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Effect, Redacted } from "effect";

import { operation } from "./operation.js";

export interface LaunchdAgentProps {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly env?: Readonly<Record<string, string | Redacted.Redacted<string>>>;
  readonly workingDirectory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly keepAlive?: boolean;
  readonly throttleInterval?: number;
}

export interface LaunchdAgentAttributes {
  readonly label: string;
  readonly plistPath: string;
  readonly digest: string;
  readonly running: boolean;
}

export type LaunchdAgent = Resource<
  "Fleet.LaunchdAgent",
  LaunchdAgentProps,
  LaunchdAgentAttributes
>;
export const LaunchdAgent = Resource<LaunchdAgent>("Fleet.LaunchdAgent");

const execute = promisify(execFile);
export type Launchctl = (args: readonly string[]) => Promise<string>;

const xml = (value: string) => {
  // oxlint-disable-next-line eslint/no-control-regex -- XML 1.0 forbids these control characters.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
    throw new Error("Invalid XML control character");
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
};

function validate(props: LaunchdAgentProps) {
  if (!/^[a-z\d][a-z\d.-]+$/iu.test(props.label)) {
    throw new Error(
      "Label must contain only letters, digits, dots and hyphens"
    );
  }
  for (const path of [
    props.programArguments[0],
    props.workingDirectory,
    props.stdoutPath,
    props.stderrPath,
  ]) {
    if (!path || !pathModule.isAbsolute(path)) {
      throw new Error(
        "Program, working directory and log paths must be absolute"
      );
    }
  }
  if (
    !Number.isInteger(props.throttleInterval ?? 10) ||
    (props.throttleInterval ?? 10) < 1
  ) {
    throw new Error("ThrottleInterval must be a positive integer");
  }
}

export function renderPlist(props: LaunchdAgentProps, owner: string): string {
  validate(props);
  const env = Object.entries(props.env ?? {})
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) =>
        `<key>${xml(key)}</key><string>${xml(Redacted.isRedacted(value) ? Redacted.value(value) : value)}</string>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>AlchemyOwner</key><string>${xml(owner)}</string>
<key>Label</key><string>${xml(props.label)}</string>
<key>ProgramArguments</key><array>${props.programArguments.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${env}</dict>
<key>WorkingDirectory</key><string>${xml(props.workingDirectory)}</string>
<key>StandardOutPath</key><string>${xml(props.stdoutPath)}</string>
<key>StandardErrorPath</key><string>${xml(props.stderrPath)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><${props.keepAlive === false ? "false" : "true"}/>
<key>ThrottleInterval</key><integer>${props.throttleInterval ?? 10}</integer>
</dict></plist>
`;
}

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const isMissingFile = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
const missingService = (cause: unknown) =>
  cause instanceof Error &&
  "stderr" in cause &&
  typeof cause.stderr === "string" &&
  /Could not find service|No such process/iu.test(cause.stderr);

// Lifecycle sketch: absent -> write -> bootout -> bootstrap -> running.
// Update re-enters write; delete: running -> bootout -> absent. Failed commands
// fail the reconcile, not a fictitious running readback. Alchemy retries reconcile.
export function makeLaunchdDriver(
  options: {
    readonly home?: string;
    readonly platform?: string;
    readonly uid?: number;
    readonly launchctl?: Launchctl;
  } = {}
) {
  const home = options.home ?? homedir();
  const uid = options.uid ?? process.getuid?.();
  const platform = options.platform ?? process.platform;
  const launchctl: Launchctl =
    options.launchctl ??
    (async (args) => {
      const result = await execute("/bin/launchctl", [...args], {
        timeout: 15_000,
      });
      return result.stdout;
    });
  const assertPlatform = () => {
    if (platform !== "darwin" || uid === undefined) {
      throw new Error(
        "LaunchdAgent requires macOS and the logged-in user's GUI session"
      );
    }
  };
  const target = (label: string) => `gui/${uid}/${label}`;
  const plistPath = (label: string) =>
    pathModule.join(home, "Library", "LaunchAgents", `${label}.plist`);
  async function existing(path: string) {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Refusing a non-regular LaunchAgent plist");
      }
      return await readFile(path, "utf-8");
    } catch (error) {
      if (isMissingFile(error)) {
        return;
      }
      throw error;
    }
  }
  async function print(label: string) {
    try {
      return await launchctl(["print", target(label)]);
    } catch (error) {
      if (missingService(error)) {
        return;
      }
      throw error;
    }
  }
  async function bootout(label: string) {
    try {
      await launchctl(["bootout", target(label)]);
    } catch (error) {
      if (!missingService(error)) {
        throw error;
      }
    }
  }
  function assertOwned(text: string, owner: string) {
    if (
      !text.includes(`<key>AlchemyOwner</key><string>${xml(owner)}</string>`)
    ) {
      throw new Error("Refusing to change an unmanaged LaunchAgent plist");
    }
  }
  return {
    async delete(props: LaunchdAgentProps, owner: string): Promise<void> {
      assertPlatform();
      validate(props);
      const path = plistPath(props.label);
      const text = await existing(path);
      if (text === undefined) {
        return;
      }
      assertOwned(text, owner);
      await bootout(props.label);
      await unlink(path);
    },
    async read(
      props: LaunchdAgentProps,
      owner: string
    ): Promise<LaunchdAgentAttributes | undefined> {
      assertPlatform();
      validate(props);
      const path = plistPath(props.label);
      const text = await existing(path);
      if (text === undefined) {
        return undefined;
      }
      assertOwned(text, owner);
      const state = await print(props.label);
      return {
        digest: digest(text),
        label: props.label,
        plistPath: path,
        running: /\bstate = running\b/u.test(state ?? ""),
      };
    },
    async reconcile(
      props: LaunchdAgentProps,
      owner: string
    ): Promise<LaunchdAgentAttributes> {
      assertPlatform();
      const text = renderPlist(props, owner);
      const path = plistPath(props.label);
      const previous = await existing(path);
      if (previous !== undefined) {
        assertOwned(previous, owner);
      } else if ((await print(props.label)) !== undefined) {
        throw new Error("Label is already registered without an owned plist");
      }
      await Promise.all(
        [
          pathModule.dirname(path),
          props.workingDirectory,
          pathModule.dirname(props.stdoutPath),
          pathModule.dirname(props.stderrPath),
        ].map((dir) => mkdir(dir, { mode: 0o700, recursive: true }))
      );
      if (previous !== text) {
        const temporary = `${path}.${randomUUID()}.pending`;
        await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
        try {
          await rename(temporary, path);
        } finally {
          await unlink(temporary).catch((error: unknown) => {
            if (!isMissingFile(error)) {
              throw error;
            }
          });
        }
      }
      await chmod(path, 0o600);
      // Restart on every requested reconcile (including --force).
      await bootout(props.label);
      await launchctl(["bootstrap", `gui/${uid}`, path]);
      // bootstrap returns before the process necessarily enters running state.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded lifecycle readback, not independent work.
        const result = await this.read(props, owner);
        if (result?.running) {
          return result;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- launchd has no readiness event API.
        await delay(100);
      }
      throw new Error(
        "launchctl print did not show state = running within 5 seconds"
      );
    },
  };
}

export const LaunchdAgentProvider = () => {
  const driver = makeLaunchdDriver();
  return Provider.succeed(LaunchdAgent, {
    delete: ({ olds, fqn, instanceId }) =>
      operation("LaunchdAgent.delete", () =>
        driver.delete(olds, `${fqn}:${instanceId}`)
      ),
    diff: ({ olds, news, output, fqn, instanceId }) =>
      Effect.sync(() => {
        if (!isResolved(news)) {
          return;
        }
        if (olds.label !== news.label) {
          return { action: "replace", deleteFirst: true };
        }
        return {
          action:
            output?.running &&
            output.digest === digest(renderPlist(news, `${fqn}:${instanceId}`))
              ? "noop"
              : "update",
        };
      }),
    read: ({ olds, fqn, instanceId }) =>
      operation("LaunchdAgent.read", () =>
        driver.read(olds, `${fqn}:${instanceId}`)
      ),
    reconcile: ({ news, fqn, instanceId }) =>
      operation("LaunchdAgent.reconcile", () =>
        driver.reconcile(news, `${fqn}:${instanceId}`)
      ),
  });
};
