/* oxlint-disable eslint/func-style, eslint/no-redeclare -- Named adapter helpers and Alchemy's paired resource type/value are intentional. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import pathModule from "node:path";
import { promisify } from "node:util";

import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Effect } from "effect";

import { operation } from "./operation.js";

export const COLLECTOR_VERSION = "0.163.1";
export const DARWIN_ARM64_SHA256 =
  "c25aa7abb438d0474ffec02b0abeb04aeb688ad72e083cc1af0bed1f84dae856";
const ASSET = `otelcol-contrib_${COLLECTOR_VERSION}_darwin_arm64.tar.gz`;
const BASE = `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${COLLECTOR_VERSION}`;
const execute = promisify(execFile);
const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

export interface CollectorBinaryProps {
  readonly version: typeof COLLECTOR_VERSION;
}
export interface CollectorBinaryAttributes {
  readonly path: string;
  readonly version: string;
  readonly archiveSha256: string;
  readonly binarySha256: string;
}
export type CollectorBinary = Resource<
  "Fleet.CollectorBinary",
  CollectorBinaryProps,
  CollectorBinaryAttributes
>;
export const CollectorBinary = Resource<CollectorBinary>(
  "Fleet.CollectorBinary"
);

export function verifyArchive(archive: Uint8Array, checksums: string): void {
  const [checksum] = checksums.trim().split(/\s+/u);
  if (
    checksum !== DARWIN_ARM64_SHA256 ||
    sha256(archive) !== DARWIN_ARM64_SHA256
  ) {
    throw new Error(
      "Collector archive failed pinned and release-file sha256 verification"
    );
  }
}

async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`Release download failed: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function makeBinaryDriver(
  options: {
    readonly home?: string;
    readonly platform?: string;
    readonly arch?: string;
    readonly download?: typeof download;
  } = {}
) {
  const home = options.home ?? homedir();
  const base = pathModule.join(home, ".local", "opt", "otelcol-contrib");
  const directory = pathModule.join(base, COLLECTOR_VERSION);
  const path = pathModule.join(directory, "otelcol-contrib");
  const manifest = pathModule.join(directory, "verified.json");
  const get = options.download ?? download;
  const assertPlatform = () => {
    if (
      (options.platform ?? process.platform) !== "darwin" ||
      (options.arch ?? process.arch) !== "arm64"
    ) {
      throw new Error(
        "CollectorBinary installs only the pinned darwin-arm64 artifact"
      );
    }
  };
  async function read(): Promise<CollectorBinaryAttributes | undefined> {
    assertPlatform();
    try {
      const meta: unknown = JSON.parse(await readFile(manifest, "utf-8"));
      if (
        typeof meta !== "object" ||
        meta === null ||
        !("binarySha256" in meta) ||
        typeof meta.binarySha256 !== "string" ||
        !("archiveSha256" in meta) ||
        meta.archiveSha256 !== DARWIN_ARM64_SHA256
      ) {
        throw new Error("Invalid collector verification manifest");
      }
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Collector binary is not a regular executable");
      }
      await access(path, constants.X_OK);
      if (sha256(await readFile(path)) !== meta.binarySha256) {
        throw new Error("Installed collector binary hash changed");
      }
      return {
        archiveSha256: DARWIN_ARM64_SHA256,
        binarySha256: meta.binarySha256,
        path,
        version: COLLECTOR_VERSION,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }
  return {
    read,
    async reconcile(
      props: CollectorBinaryProps
    ): Promise<CollectorBinaryAttributes> {
      assertPlatform();
      if (props.version !== COLLECTOR_VERSION) {
        throw new Error("Unsupported collector version");
      }
      const installed = await read();
      if (installed) {
        return installed;
      }
      // A versioned directory is immutable once published. Refuse unmanaged/partial installs.
      try {
        await lstat(directory);
        throw new Error(
          "Refusing an existing unverified collector directory; inspect it before retrying"
        );
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
      await mkdir(base, { mode: 0o700, recursive: true });
      const staging = await mkdtemp(pathModule.join(base, ".install-"));
      try {
        const [archive, checksum] = await Promise.all([
          get(`${BASE}/${ASSET}`),
          get(`${BASE}/${ASSET}.sha256`),
        ]);
        verifyArchive(archive, new TextDecoder().decode(checksum));
        const archivePath = pathModule.join(staging, "release.tar.gz");
        await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
        // Extract only the expected member, never arbitrary paths from the archive.
        await execute(
          "/usr/bin/tar",
          ["-xzf", archivePath, "-C", staging, "otelcol-contrib"],
          { timeout: 30_000 }
        );
        const binaryPath = pathModule.join(staging, "otelcol-contrib");
        const stat = await lstat(binaryPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error("Invalid binary archive member");
        }
        await chmod(binaryPath, 0o700);
        const binarySha256 = sha256(await readFile(binaryPath));
        await writeFile(
          pathModule.join(staging, "verified.json"),
          JSON.stringify({ archiveSha256: DARWIN_ARM64_SHA256, binarySha256 }),
          { flag: "wx", mode: 0o600 }
        );
        await unlink(archivePath);
        await rename(staging, directory);
        return {
          archiveSha256: DARWIN_ARM64_SHA256,
          binarySha256,
          path,
          version: COLLECTOR_VERSION,
        };
      } finally {
        // Delete only our three known staging files. Never recursively delete a directory.
        for (const file of [
          "release.tar.gz",
          "otelcol-contrib",
          "verified.json",
        ]) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Remove only our three known files, in a bounded cleanup.
          await unlink(pathModule.join(staging, file)).catch(
            (error: unknown) => {
              if (
                !(
                  error instanceof Error &&
                  "code" in error &&
                  error.code === "ENOENT"
                )
              ) {
                throw error;
              }
            }
          );
        }
        await rmdir(staging).catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          ) {
            throw error;
          }
        });
      }
    },
  };
}

export const CollectorBinaryProvider = () => {
  const driver = makeBinaryDriver();
  return Provider.succeed(CollectorBinary, {
    // Keep immutable, verified versioned binaries for rollback. Destroy only unloads the agent.
    delete: () => Effect.void,
    read: () => operation("CollectorBinary.read", () => driver.read()),
    reconcile: ({ news }) =>
      operation("CollectorBinary.reconcile", () => driver.reconcile(news)),
  });
};
