import * as fs from "node:fs";
import * as path from "node:path";
import { computeFileHashes, normalizeRelPath, parseTomlFile, readJsonFile, writeJsonFile } from "./utils";
import type { ManifestFile, PackConfig, PackLock, PackManifest, ReleaseDescriptor } from "./types";

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

  for (const artifact of Object.values(lock.artifacts)) {
    const fileEntry: ManifestFile = {
      path: `mods/${artifact.filename}`,
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

    if (artifact.side === "both" || artifact.side === "client") {
      clientModFiles.push(fileEntry);
    }
    if (artifact.side === "both" || artifact.side === "server") {
      serverModFiles.push(fileEntry);
    }
  }

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
  };

  const clientOut = path.join(options.outDir, "client-manifest.json");
  const serverOut = path.join(options.outDir, "server-manifest.json");
  const releaseOut = path.join(options.outDir, "release.json");

  writeJsonFile(clientOut, clientManifest, true);
  writeJsonFile(serverOut, serverManifest, true);
  writeJsonFile(releaseOut, release, true);

  console.log(`[Manifest] Built manifests for v${packConfig.pack.version}:`);
  console.log(`  - Client manifest (${clientManifest.files.length} files) -> ${clientOut}`);
  console.log(`  - Server manifest (${serverManifest.files.length} files) -> ${serverOut}`);
  console.log(`  - Release descriptor -> ${releaseOut}`);

  return { clientManifest, serverManifest, release };
}
