import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerRuntimeState } from "./types";
import {
  computeFileHashesStreaming,
  ensureDir,
  readJsonFile,
  replaceFile,
  withAbortTimeout,
  writeJsonFile,
} from "./utils";

export const DEFAULT_FABRIC_SERVER_INSTALLER_VERSION = "1.0.1";
export const SUPPORTED_MINECRAFT_VERSIONS = new Set(["26.2"]);

export interface RuntimeDefinition {
  minecraft: string;
  loader: {
    type: "fabric";
    version: string;
  };
}

export function validateRuntimeDefinition(
  minecraft: unknown,
  loader: unknown
): RuntimeDefinition {
  if (typeof minecraft !== "string" || minecraft.trim().length === 0) {
    throw new Error("Invalid pack definition: 'pack.minecraft' must be a non-empty string.");
  }
  const mc = minecraft.trim();
  if (!SUPPORTED_MINECRAFT_VERSIONS.has(mc)) {
    throw new Error(
      `Unsupported Minecraft version '${mc}'. Only Minecraft 26.2 is currently supported.`
    );
  }

  if (!loader || typeof loader !== "object") {
    throw new Error("Invalid pack definition: '[loader]' section is missing or not an object.");
  }

  const l = loader as Record<string, any>;
  if (!l.type) {
    throw new Error("Invalid pack definition: '[loader.type]' is required.");
  }
  if (l.type !== "fabric") {
    throw new Error(`Unsupported mod loader '${l.type}'. Lampas supports Fabric releases only.`);
  }

  if (typeof l.version !== "string" || l.version.trim().length === 0) {
    throw new Error("Invalid loader version: 'loader.version' must be a non-empty string.");
  }

  return {
    minecraft: mc,
    loader: {
      type: "fabric",
      version: l.version.trim(),
    },
  };
}

export interface StagedFabricServerRuntime {
  isReused: boolean;
  runtimeState: ServerRuntimeState;
  activate: () => Promise<ServerRuntimeState>;
  cleanup: () => Promise<void>;
}

export interface PrepareFabricServerRuntimeOptions {
  targetDir: string;
  minecraft: string;
  loaderVersion: string;
  installerVersion?: string;
  verificationMode?: "fast" | "full";
  fabricMetaUrl?: string;
  fetchFn?: typeof fetch;
}

export async function prepareFabricServerRuntime(
  options: PrepareFabricServerRuntimeOptions
): Promise<StagedFabricServerRuntime> {
  const { targetDir, minecraft, loaderVersion } = options;
  const installerVersion = options.installerVersion || DEFAULT_FABRIC_SERVER_INSTALLER_VERSION;
  const verificationMode = options.verificationMode || "fast";
  const fetchFn = options.fetchFn || fetch;
  const fabricMetaBaseUrl = (
    options.fabricMetaUrl ||
    process.env.FABRIC_META_URL ||
    "https://meta.fabricmc.net"
  ).replace(/\/+$/, "");

  // Validate runtime definition & scope boundary
  validateRuntimeDefinition(minecraft, { type: "fabric", version: loaderVersion });

  const runtimeDir = path.join(targetDir, ".lampas", "runtime");
  const launcherJarPath = path.join(runtimeDir, "fabric-server-launch.jar");
  const runtimeStatePath = path.join(runtimeDir, "runtime.json");
  const stagingDir = path.join(runtimeDir, ".tmp-staging");

  // Check existing runtime on disk
  if (fs.existsSync(runtimeStatePath) && fs.existsSync(launcherJarPath)) {
    try {
      const cachedState = readJsonFile<ServerRuntimeState>(runtimeStatePath);
      const isMatch =
        cachedState.minecraft === minecraft &&
        cachedState.loader?.type === "fabric" &&
        cachedState.loader?.version === loaderVersion &&
        (cachedState.installerVersion === installerVersion || !cachedState.installerVersion);

      if (isMatch) {
        if (verificationMode === "fast") {
          console.log(`  ⚡ [Server Runtime] Reusing existing Fabric server runtime (${minecraft} / Fabric ${loaderVersion})`);
          return {
            isReused: true,
            runtimeState: cachedState,
            activate: async () => cachedState,
            cleanup: async () => {},
          };
        } else {
          // Full verification mode: recompute hash of existing launcher JAR
          const hashes = await computeFileHashesStreaming(launcherJarPath);
          if (hashes.sha256.toLowerCase() === cachedState.launcherSha256.toLowerCase()) {
            console.log(`  ✓ [Server Runtime Verified] Existing Fabric server runtime verified (${minecraft} / Fabric ${loaderVersion})`);
            return {
              isReused: true,
              runtimeState: cachedState,
              activate: async () => cachedState,
              cleanup: async () => {},
            };
          } else {
            console.warn(
              `  ⚠ [Server Runtime Checksum Mismatch] Corrupted server launcher JAR detected (expected ${cachedState.launcherSha256}, got ${hashes.sha256}), re-downloading...`
            );
          }
        }
      }
    } catch {
      // Corrupt or unreadable runtime.json; re-download
    }
  }

  // Staged download required
  console.log(
    `  ↓ [Server Runtime] Resolving Fabric server launcher for Minecraft ${minecraft} / Loader ${loaderVersion} (installer ${installerVersion})...`
  );

  ensureDir(stagingDir);
  const stagedJarPath = path.join(
    stagingDir,
    `fabric-server-launch.jar.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );

  const endpointUrl = `${fabricMetaBaseUrl}/v2/versions/loader/${encodeURIComponent(minecraft)}/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installerVersion)}/server/jar`;

  try {
    const res = await withAbortTimeout(
      `downloading Fabric server launcher from ${endpointUrl}`,
      (signal) =>
        fetchFn(endpointUrl, {
          signal,
          headers: {
            "User-Agent": "Lampas-Pipeline/1.0",
            Accept: "application/java-archive, application/octet-stream, */*",
          },
        }),
      30000
    );

    if (!res.ok) {
      throw new Error(
        `Failed to download Fabric server launcher for Minecraft ${minecraft} and Loader ${loaderVersion}: HTTP ${res.status} ${res.statusText}`
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate ZIP magic header PK\x03\x04
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
      throw new Error(
        `Invalid Fabric server launcher JAR received for ${minecraft} / ${loaderVersion} (invalid ZIP magic bytes)`
      );
    }

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    fs.writeFileSync(stagedJarPath, buffer);

    const runtimeState: ServerRuntimeState = {
      minecraft,
      loader: {
        type: "fabric",
        version: loaderVersion,
      },
      installerVersion,
      launcherJar: "fabric-server-launch.jar",
      launcherSha256: sha256,
      installedAt: new Date().toISOString(),
    };

    return {
      isReused: false,
      runtimeState,
      activate: async () => {
        ensureDir(runtimeDir);
        await replaceFile(stagedJarPath, launcherJarPath);
        writeJsonFile(runtimeStatePath, runtimeState, true);
        console.log(`  ✓ [Server Runtime Activated] Fabric server launcher ${loaderVersion} activated`);
        return runtimeState;
      },
      cleanup: async () => {
        if (fs.existsSync(stagedJarPath)) {
          await fs.promises.unlink(stagedJarPath).catch(() => {});
        }
      },
    };
  } catch (err) {
    if (fs.existsSync(stagedJarPath)) {
      await fs.promises.unlink(stagedJarPath).catch(() => {});
    }
    throw err;
  }
}

export async function ensureFabricServerRuntime(
  options: PrepareFabricServerRuntimeOptions
): Promise<ServerRuntimeState> {
  const staged = await prepareFabricServerRuntime(options);
  return staged.activate();
}
