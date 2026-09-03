import * as fs from "node:fs";
import * as path from "node:path";
import { computeFileHashesStreaming, formatPromptJson, generateDeterministicUuid, isValidServerAddress, normalizeRelPath, parseTomlFile, readJsonFile, writeJsonFile } from "./utils";
import type { ConfigPatch, ManifestFile, ModCatalogEntry, PackConfig, PackLock, PackManifest, ReleaseDescriptor, ReleaseLaunchConfig, ReleaseRequiredResourcePack, ServerResourcePackConfig } from "./types";
import { validateConfigPatches } from "./config-patches";

export interface ManifestOptions {
  packDir: string;
  lockFile: string;
  outDir: string;
  portalBaseUrl?: string;
}

async function scanStaticDir(baseDir: string, relDir: string): Promise<ManifestFile[]> {
  const dirPath = path.join(baseDir, relDir);
  if (!fs.existsSync(dirPath)) return [];

  const files: Array<{ fullPath: string; relPath: string }> = [];

  function walk(currentPath: string) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = normalizeRelPath(path.relative(dirPath, fullPath));
        files.push({ fullPath, relPath });
      }
    }
  }

  walk(dirPath);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const results = new Array<ManifestFile>(files.length);
  let nextFile = 0;
  async function worker() {
    while (nextFile < files.length) {
      const index = nextFile++;
      const { fullPath, relPath } = files[index];
      const hashes = await computeFileHashesStreaming(fullPath);
      results[index] = {
        path: relPath,
        size: hashes.size,
        hashes: { sha256: hashes.sha256, sha512: hashes.sha512 },
        download: { url: `/api/v1/blobs/${hashes.sha256}`, provider: "lampas" },
        policy: "MANAGED",
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, () => worker()));
  return results;
}

export async function buildManifests(options: ManifestOptions): Promise<{
  clientManifest: PackManifest;
  serverManifest: PackManifest;
  release: ReleaseDescriptor;
}> {
  const packConfigPath = path.join(options.packDir, "pack.toml");
  const packConfig = parseTomlFile<PackConfig>(packConfigPath);
  const lock = readJsonFile<PackLock>(options.lockFile);

  // Validate launcher play configuration
  if (packConfig.launcher?.play) {
    const { auto_connect, server } = packConfig.launcher.play;
    if (server && !isValidServerAddress(server)) {
      throw new Error(`Invalid server address in pack.toml ([launcher.play] server = '${server}'): malformed address.`);
    }
    if (auto_connect && !server) {
      throw new Error(
        `Auto-connect is enabled in pack.toml ([launcher.play] auto_connect = true) but no valid server address was specified.`
      );
    }
  }

  // Dual-delivery validation: an artifact must not be both launcher-managed and server-enforced
  const launcherRequiredPacks = packConfig.launcher?.resourcepacks?.required || [];
  const srpDef = packConfig.server?.resourcepack || packConfig.server?.resource_pack;
  if (srpDef?.artifact && launcherRequiredPacks.includes(srpDef.artifact)) {
    throw new Error(
      `Resource pack '${srpDef.artifact}' is configured for both launcher-local and server-resource-pack delivery. Choose one delivery mechanism.`
    );
  }

  // Validate and resolve launcher required resource packs
  const requiredResourcePacks: ReleaseRequiredResourcePack[] = [];
  if (packConfig.launcher?.resourcepacks?.required) {
    for (const packId of packConfig.launcher.resourcepacks.required) {
      const artifact = lock.artifacts[packId];
      if (!artifact) {
        throw new Error(`Required resource pack '${packId}' was not found in pack.lock.json.`);
      }
      const artifactType = artifact.artifactType || (artifact.targetDir === "resourcepacks" ? "resourcepack" : "mod");
      if (artifactType !== "resourcepack") {
        throw new Error(`Artifact '${packId}' is configured as a required resource pack but has type '${artifactType}'.`);
      }
      if (artifact.side !== "client" && artifact.side !== "both") {
        throw new Error(`Artifact '${packId}' is configured as a required resource pack but is not available to the client (side='${artifact.side}').`);
      }
      if (!artifact.filename) {
        throw new Error(`Artifact '${packId}' is configured as a required resource pack but has no filename.`);
      }
      const targetDir = artifact.targetDir || "resourcepacks";
      if (targetDir !== "resourcepacks") {
        throw new Error(`Artifact '${packId}' is configured as a required resource pack but its path does not resolve to resourcepacks/ (${targetDir}/${artifact.filename}).`);
      }
      if (!artifact.sha256 || !/^[0-9a-fA-F]{64}$/.test(artifact.sha256)) {
        throw new Error(`Artifact '${packId}' is configured as a required resource pack but has invalid SHA-256: '${artifact.sha256}'.`);
      }

      requiredResourcePacks.push({
        id: packId,
        filename: artifact.filename,
        path: `resourcepacks/${artifact.filename}`,
        sha256: artifact.sha256,
        ...(artifact.sha1 ? { sha1: artifact.sha1 } : {}),
      });
    }
  }

  const commonFiles = await scanStaticDir(options.packDir, "common");
  const clientStaticFiles = await scanStaticDir(options.packDir, "client");
  const serverStaticFiles = await scanStaticDir(options.packDir, "server");

  const clientModFiles: ManifestFile[] = [];
  const serverModFiles: ManifestFile[] = [];

  const clientModsCatalog: ModCatalogEntry[] = [];
  const serverModsCatalog: ModCatalogEntry[] = [];

  const srpArtifactId = srpDef?.artifact;

  for (const [modId, artifact] of Object.entries(lock.artifacts)) {
    // If an artifact is designated as the server-enforced resource pack, it must NOT be
    // included in client or server installation file lists (launcher-local files).
    // The server resource pack is delivered exclusively on-demand over Minecraft's server protocol.
    if (srpArtifactId && modId === srpArtifactId) {
      continue;
    }

    const targetDir = artifact.targetDir || (artifact.artifactType === "shader" ? "shaderpacks" : artifact.artifactType === "resourcepack" ? "resourcepacks" : "mods");
    const fileEntry: ManifestFile = {
      path: `${targetDir}/${artifact.filename}`,
      size: artifact.size,
      hashes: {
        sha256: artifact.sha256,
        sha512: artifact.sha512,
      },
      download: {
        url: artifact.downloadUrl,
        provider: artifact.provider.type,
      },
      policy: "MANAGED",
    };

    const categories = [...(artifact.metadata?.categories || [])];
    if (artifact.artifactType === "shader" && !categories.includes("shader")) {
      categories.unshift("shader");
    }

    const catalogEntry: ModCatalogEntry = {
      id: modId,
      name: artifact.name || modId,
      side: artifact.side,
      filename: artifact.filename,
      size: artifact.size,
      description: artifact.metadata?.description || undefined,
      iconUrl: artifact.metadata?.iconUrl || undefined,
      categories,
      sourceUrl: artifact.metadata?.sourceUrl || undefined,
    };

    if (artifact.side === "both" || artifact.side === "client") {
      clientModFiles.push(fileEntry);
      clientModsCatalog.push(catalogEntry);
    }
    if (artifact.side === "both" || artifact.side === "server") {
      serverModFiles.push(fileEntry);
      serverModsCatalog.push(catalogEntry);
    }
  }

  // Sort mod catalogs alphabetically by name
  clientModsCatalog.sort((a, b) => a.name.localeCompare(b.name));
  serverModsCatalog.sort((a, b) => a.name.localeCompare(b.name));

  // Scan and validate client config patches
  const allClientFiles = [...clientModFiles, ...commonFiles, ...clientStaticFiles];
  const allServerFiles = [...serverModFiles, ...commonFiles, ...serverStaticFiles];

  const clientPatchesPath = path.join(options.packDir, "config-patches", "client.json");
  let clientConfigPatches: ConfigPatch[] | undefined = undefined;
  if (fs.existsSync(clientPatchesPath)) {
    const rawPatches = readJsonFile<any>(clientPatchesPath);
    clientConfigPatches = validateConfigPatches(rawPatches, allClientFiles);
  }

  const clientManifest: PackManifest = {
    schemaVersion: clientConfigPatches && clientConfigPatches.length > 0 ? 2 : 1,
    pack: packConfig.pack.name,
    version: packConfig.pack.version,
    target: "client",
    minecraft: packConfig.pack.minecraft,
    loader: {
      type: packConfig.loader.type,
      version: packConfig.loader.version,
    },
    protocol: packConfig.launcher?.protocol || 1,
    mods: clientModsCatalog,
    files: allClientFiles,
    ...(clientConfigPatches && clientConfigPatches.length > 0 ? { configPatches: clientConfigPatches } : {}),
  };

  const serverManifest: PackManifest = {
    schemaVersion: 1,
    pack: packConfig.pack.name,
    version: packConfig.pack.version,
    target: "server",
    minecraft: packConfig.pack.minecraft,
    loader: {
      type: packConfig.loader.type,
      version: packConfig.loader.version,
    },
    protocol: packConfig.launcher?.protocol || 1,
    mods: serverModsCatalog,
    files: allServerFiles,
  };

  // Build resolved release launch configuration
  let launchConfig: ReleaseLaunchConfig | undefined = undefined;
  const playConfig = packConfig.launcher?.play;
  const hasPlay = playConfig && (playConfig.auto_connect !== undefined || playConfig.server !== undefined);
  const hasRequiredPacks = requiredResourcePacks.length > 0;

  if (hasPlay || hasRequiredPacks) {
    launchConfig = {};
    if (playConfig?.auto_connect !== undefined) {
      launchConfig.autoConnect = playConfig.auto_connect;
    }
    if (playConfig?.server !== undefined) {
      launchConfig.server = playConfig.server;
    }
    if (hasRequiredPacks) {
      launchConfig.requiredResourcePacks = requiredResourcePacks;
    }
  }

  // Build server resource pack configuration
  let serverResourcePackConfig: ServerResourcePackConfig | undefined = undefined;
  const portalBase = options.portalBaseUrl || "";

  if (srpDef?.artifact) {
    const artifact = lock.artifacts[srpDef.artifact];
    if (!artifact) {
      throw new Error(`Server resource pack artifact '${srpDef.artifact}' was not found in pack.lock.json.`);
    }
    const artifactType = artifact.artifactType || (artifact.targetDir === "resourcepacks" ? "resourcepack" : "mod");
    if (artifactType !== "resourcepack") {
      throw new Error(`Artifact '${srpDef.artifact}' is configured as server resource pack but has type '${artifactType}'.`);
    }
    if (!artifact.sha1 || !/^[0-9a-fA-F]{40}$/.test(artifact.sha1)) {
      throw new Error(`Server resource pack artifact '${srpDef.artifact}' requires a valid 40-character SHA-1 hash for Minecraft dedicated server.`);
    }
    if (!artifact.sha256 || !/^[0-9a-fA-F]{64}$/.test(artifact.sha256)) {
      throw new Error(`Server resource pack artifact '${srpDef.artifact}' has invalid SHA-256: '${artifact.sha256}'.`);
    }
    let downloadUrl = artifact.downloadUrl;
    if (downloadUrl.startsWith("/") && portalBase) {
      downloadUrl = `${portalBase}${downloadUrl}`;
    }
    const packId = srpDef.id || (srpDef as any).uuid || (artifact as any).uuid || generateDeterministicUuid(`resourcepack:${artifact.id}`);
    serverResourcePackConfig = {
      artifact: srpDef.artifact,
      required: srpDef.required !== false,
      filename: artifact.filename,
      path: `resourcepacks/${artifact.filename}`,
      size: artifact.size,
      url: downloadUrl,
      sha1: artifact.sha1,
      sha256: artifact.sha256,
      ...(srpDef.prompt ? { prompt: formatPromptJson(srpDef.prompt) } : {}),
      id: packId,
      provider: artifact.provider.type,
    };
  }

  if (serverResourcePackConfig) {
    serverManifest.resourcePack = serverResourcePackConfig;
  }

  const release: ReleaseDescriptor = {
    schemaVersion: 1,
    pack: packConfig.pack.name,
    version: packConfig.pack.version,
    minecraft: packConfig.pack.minecraft,
    loader: {
      type: packConfig.loader.type,
      version: packConfig.loader.version,
    },
    minimumLauncherVersion: packConfig.launcher?.minimum_version || "1.0.0",
    protocol: packConfig.launcher?.protocol || 1,
    created: new Date().toISOString(),
    clientManifest: `${portalBase}/api/v1/releases/${packConfig.pack.version}/client-manifest`,
    serverManifest: `${portalBase}/api/v1/releases/${packConfig.pack.version}/server-manifest`,
    totalMods: Object.keys(lock.artifacts).length,
    totalFiles: clientManifest.files.length,
    ...(launchConfig ? { launch: launchConfig } : {}),
    ...(serverResourcePackConfig ? { serverResourcePack: serverResourcePackConfig } : {}),
  };

  const clientOut = path.join(options.outDir, "client-manifest.json");
  const serverOut = path.join(options.outDir, "server-manifest.json");
  const releaseOut = path.join(options.outDir, "release.json");

  writeJsonFile(clientOut, clientManifest, true);
  writeJsonFile(serverOut, serverManifest, true);
  writeJsonFile(releaseOut, release, true);

  console.log(`[Manifest] Built manifests for v${packConfig.pack.version}:`);
  console.log(`  - Client manifest (${clientManifest.files.length} files, ${clientModsCatalog.length} cataloged mods) -> ${clientOut}`);
  console.log(`  - Server manifest (${serverManifest.files.length} files, ${serverModsCatalog.length} cataloged mods) -> ${serverOut}`);
  console.log(`  - Release descriptor -> ${releaseOut}`);

  // Optional: Generate server-side resource-pack configuration if server resource pack is present
  if (serverResourcePackConfig) {
    const serverPropsOut = path.join(options.outDir, "server-resource-pack.properties");
    const serverPropsLines = [
      `resource-pack=${serverResourcePackConfig.url}`,
      `resource-pack-sha1=${serverResourcePackConfig.sha1 || ""}`,
      `resource-pack-prompt=${serverResourcePackConfig.prompt || ""}`,
      `resource-pack-id=${serverResourcePackConfig.id || ""}`,
      `require-resource-pack=${serverResourcePackConfig.required}`,
      "",
    ];
    fs.writeFileSync(serverPropsOut, serverPropsLines.join("\n"), "utf-8");

    const serverJsonOut = path.join(options.outDir, "server-resource-pack.json");
    writeJsonFile(serverJsonOut, serverResourcePackConfig, true);
    console.log(`  - Server resource-pack properties -> ${serverPropsOut}`);
  }

  return { clientManifest, serverManifest, release };
}
