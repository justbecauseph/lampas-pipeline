import * as fs from "node:fs";
import * as path from "node:path";
import { computeFileHashes, normalizeRelPath, parseTomlFile, readJsonFile, writeJsonFile } from "./utils";
import type { ManifestFile, ModCatalogEntry, PackConfig, PackLock, PackManifest, ReleaseDescriptor } from "./types";

export interface ManifestOptions {
  packDir: string;
  lockFile: string;
  outDir: string;
  portalBaseUrl?: string;
}

function scanStaticDir(baseDir: string, relDir: string): ManifestFile[] {
  const dirPath = path.join(baseDir, relDir);
  if (!fs.existsSync(dirPath)) return [];

  const results: ManifestFile[] = [];

  function walk(currentPath: string) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = normalizeRelPath(path.relative(dirPath, fullPath));
        const hashes = computeFileHashes(fullPath);

        results.push({
          path: relPath,
          size: hashes.size,
          hashes: {
            sha256: hashes.sha256,
            sha512: hashes.sha512,
          },
          download: {
            url: `/api/v1/blobs/${hashes.sha256}`,
            provider: "lampas",
          },
          policy: "MANAGED",
        });
      }
    }
  }

  walk(dirPath);
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

  const commonFiles = scanStaticDir(options.packDir, "common");
  const clientStaticFiles = scanStaticDir(options.packDir, "client");
  const serverStaticFiles = scanStaticDir(options.packDir, "server");

  const clientModFiles: ManifestFile[] = [];
  const serverModFiles: ManifestFile[] = [];

  const clientModsCatalog: ModCatalogEntry[] = [];
  const serverModsCatalog: ModCatalogEntry[] = [];

  for (const [modId, artifact] of Object.entries(lock.artifacts)) {
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

  const clientManifest: PackManifest = {
    schemaVersion: 1,
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
    files: [...clientModFiles, ...commonFiles, ...clientStaticFiles],
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
    files: [...serverModFiles, ...commonFiles, ...serverStaticFiles],
  };

  const portalBase = options.portalBaseUrl || "";
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

  return { clientManifest, serverManifest, release };
}
