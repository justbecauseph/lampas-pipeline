import * as fs from "node:fs";
import * as path from "node:path";
import {
  computeFileHashesStreaming,
  copyFileAtomic,
  copyFileVerified,
  downloadFileVerified,
  ensureDir,
  formatPromptJson,
  readJsonFile,
  writeJsonFile,
} from "./utils";
import type { InstallationState, ManifestFile, PackManifest } from "./types";

export interface SyncOptions {
  manifestPath: string;
  targetDir: string;
  portalBaseUrl?: string;
  concurrency?: number;
  verificationMode?: "fast" | "full";
}

const PROTECTED_PREFIXES = [
  "saves/",
  "screenshots/",
  "resourcepacks/",
  "shaderpacks/",
  "logs/",
  "crash-reports/",
  "options.txt",
];

function isPathProtected(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return PROTECTED_PREFIXES.some((prefix) => norm === prefix || norm.startsWith(prefix));
}

export async function syncInstance(options: SyncOptions): Promise<void> {
  const manifest = readJsonFile<PackManifest>(options.manifestPath);
  const targetDir = path.resolve(options.targetDir);
  ensureDir(targetDir);

  const stateDir = path.join(targetDir, ".lampas");
  const stateFile = path.join(stateDir, "installation.json");
  const cacheDir = path.join(stateDir, "cache", "sha256");
  ensureDir(cacheDir);

  let prevState: InstallationState = {
    pack: manifest.pack,
    version: "0.0.0",
    installedAt: new Date().toISOString(),
    files: {},
  };

  if (fs.existsSync(stateFile)) {
    try {
      prevState = readJsonFile<InstallationState>(stateFile);
    } catch {
      // fresh or corrupted state
    }
  }

  console.log(`[Sync] Synchronizing ${manifest.pack} (${manifest.target}) v${manifest.version} to: ${targetDir}`);

  const desiredFilesMap = new Map<string, ManifestFile>();
  for (const f of manifest.files) {
    desiredFilesMap.set(f.path, f);
  }

  const toDownload: ManifestFile[] = [];
  const toKeep: string[] = [];
  const verifiedAt = new Map<string, string>();

  for (const file of manifest.files) {
    const localPath = path.join(targetDir, file.path);

    if (file.policy === "PRESERVE" || isPathProtected(file.path)) {
      if (fs.existsSync(localPath)) {
        toKeep.push(file.path);
        continue;
      }
    }

    if (fs.existsSync(localPath)) {
      const stat = fs.statSync(localPath);
      const previous = prevState.files[file.path];
      const metadataMatches =
        options.verificationMode !== "full" &&
        previous?.sha256 === file.hashes.sha256 &&
        previous.size === file.size &&
        previous.mtimeMs === stat.mtimeMs &&
        stat.size === file.size;

      if (metadataMatches) {
        toKeep.push(file.path);
        continue;
      }

      const hashes = await computeFileHashesStreaming(localPath);
      if (hashes.sha256 === file.hashes.sha256) {
        toKeep.push(file.path);
        verifiedAt.set(file.path, new Date().toISOString());
        continue;
      }
    }

    toDownload.push(file);
  }

  // Identify obsolete managed files from previous installation AND unmanifested mods on disk
  const toDeleteSet = new Set<string>();
  for (const [prevPath, info] of Object.entries(prevState.files)) {
    if (info.policy === "MANAGED" && !desiredFilesMap.has(prevPath) && !isPathProtected(prevPath)) {
      toDeleteSet.add(prevPath);
    }
  }

  // Direct disk reconciliation: scan mods/ directory for any unmanifested JAR files
  const modsDir = path.join(targetDir, "mods");
  if (fs.existsSync(modsDir)) {
    try {
      const diskFiles = fs.readdirSync(modsDir);
      for (const file of diskFiles) {
        if (file.endsWith(".jar")) {
          const relModPath = `mods/${file}`;
          if (!desiredFilesMap.has(relModPath) && !isPathProtected(relModPath)) {
            toDeleteSet.add(relModPath);
          }
        }
      }
    } catch {
      // ignore read error
    }
  }

  const toDelete = Array.from(toDeleteSet);

  console.log(`[Sync] Plan: ${toDownload.length} to download, ${toKeep.length} already up-to-date, ${toDelete.length} obsolete to remove.`);

  // Download needed files
  const concurrency = options.concurrency || 6;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < toDownload.length) {
      const file = toDownload[nextIndex++];
      if (!file) break;

      let downloadUrl = file.download.url;
      if (downloadUrl.startsWith("/") && options.portalBaseUrl) {
        downloadUrl = `${options.portalBaseUrl}${downloadUrl}`;
      }

      // Check blob cache first
      const cachePath = path.join(cacheDir, file.hashes.sha256.substring(0, 2), file.hashes.sha256);
      if (fs.existsSync(cachePath)) {
        const hashes = await computeFileHashesStreaming(cachePath);
        if (hashes.sha256 === file.hashes.sha256) {
          verifiedAt.set(file.path, new Date().toISOString());
          console.log(`  ⚡ [Cache Hit] ${file.path}`);
          continue;
        }
        await fs.promises.rm(cachePath, { force: true });
      }

      if (downloadUrl.startsWith("/")) {
        if (options.portalBaseUrl) {
          downloadUrl = `${options.portalBaseUrl}${downloadUrl}`;
          console.log(`  ↓ [Downloading Blob] ${file.path}...`);
          await downloadFileVerified(downloadUrl, cachePath, {
            expectedHash: file.hashes.sha256,
            expectedSize: file.size,
            headers: { "User-Agent": "Lampas-Launcher/1.0" },
          });
        } else {
          // Local fallback: search in pack/
          const candidatePaths = [
            path.resolve("pack", "common", file.path),
            path.resolve("pack", "client", file.path),
            path.resolve("pack", "server", file.path),
            path.resolve("pack", "custom", path.basename(file.path)),
          ];

          const foundPath = candidatePaths.find((p) => fs.existsSync(p));
          if (!foundPath) {
            throw new Error(`Local blob source for ${file.path} not found in pack/ directories. Provide --portal URL.`);
          }
          await copyFileVerified(foundPath, cachePath, {
            expectedHash: file.hashes.sha256,
            expectedSize: file.size,
          });
        }
      } else {
        console.log(`  ↓ [Downloading] ${file.path}...`);
        await downloadFileVerified(downloadUrl, cachePath, {
          expectedHash: file.hashes.sha256,
          expectedSize: file.size,
          headers: { "User-Agent": "Lampas-Launcher/1.0" },
        });
      }

      verifiedAt.set(file.path, new Date().toISOString());
      console.log(`  ✓ [Downloaded] ${file.path} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, toDownload.length) }, () => worker());
  await Promise.all(workers);

  // Apply only after every artifact is present and verified in the cache.
  for (const file of toDownload) {
    const cachePath = path.join(cacheDir, file.hashes.sha256.substring(0, 2), file.hashes.sha256);
    await copyFileAtomic(cachePath, path.join(targetDir, file.path));
  }

  // Delete obsolete managed files
  for (const relPath of toDelete) {
    const fullPath = path.join(targetDir, relPath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      console.log(`  🗑 [Deleted Obsolete] ${relPath}`);
    }
  }

  // Update installation state
  const newState: InstallationState = {
    pack: manifest.pack,
    version: manifest.version,
    installedAt: new Date().toISOString(),
    files: {},
  };

  for (const file of manifest.files) {
    const filePath = path.join(targetDir, file.path);
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : undefined;
    const previous = prevState.files[file.path];
    newState.files[file.path] = {
      sha256: file.hashes.sha256,
      size: file.size,
      policy: file.policy,
      mtimeMs: stat?.mtimeMs,
      verifiedAt: verifiedAt.get(file.path) || previous?.verifiedAt,
    };
  }

  writeJsonFile(stateFile, newState, true);

  // Apply server-side resource pack configuration to server.properties
  if (manifest.target === "server" && manifest.resourcePack) {
    applyServerResourcePackProperties(targetDir, manifest.resourcePack);
  }

  console.log(`\n[Sync Complete] Successfully synchronized ${manifest.pack} v${manifest.version}`);
}

export function applyServerResourcePackProperties(
  targetDir: string,
  srp: { url: string; sha1?: string; required: boolean; prompt?: string; id?: string; uuid?: string }
): void {
  const propsPath = path.join(targetDir, "server.properties");
  let content = "";
  if (fs.existsSync(propsPath)) {
    content = fs.readFileSync(propsPath, "utf-8");
  }

  const lines = content ? content.split(/\r?\n/) : [];
  const keysToSet: Record<string, string> = {
    "resource-pack": srp.url,
    "resource-pack-sha1": srp.sha1 || "",
    "require-resource-pack": String(srp.required),
  };
  if (srp.prompt) {
    keysToSet["resource-pack-prompt"] = formatPromptJson(srp.prompt);
  }
  const packId = srp.id || srp.uuid;
  if (packId) {
    keysToSet["resource-pack-id"] = packId;
  }

  const seenKeys = new Set<string>();
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) {
      return line;
    }
    const eqIdx = line.indexOf("=");
    const key = line.substring(0, eqIdx).trim();
    if (key in keysToSet) {
      seenKeys.add(key);
      return `${key}=${keysToSet[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(keysToSet)) {
    if (!seenKeys.has(key)) {
      newLines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(propsPath, newLines.join("\n"), "utf-8");
  console.log(`  ⚙ [Server Config] Configured resource-pack settings in server.properties`);
}
