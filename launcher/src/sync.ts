import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ConfigManager } from "./config";
import type { SyncProgress } from "./types";

const PROTECTED_PREFIXES = [
  "saves/",
  "screenshots/",
  "resourcepacks/",
  "shaderpacks/",
  "logs/",
  "crash-reports/",
  "options.txt",
  "servers.dat",
];

function isPathProtected(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return PROTECTED_PREFIXES.some((p) => norm === p || norm.startsWith(p));
}

function computeFileSha256(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function computeBufferSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export class LauncherSync {
  static async syncClient(
    onProgress: (progress: SyncProgress) => void
  ): Promise<{ success: boolean; version: string; packName: string }> {
    const config = ConfigManager.get();
    const portalUrl = (config.portalUrl || "http://localhost:3000").replace(/\/+$/, "");
    const channel = config.selectedChannel || "stable";
    const gameDir = config.gameDir;

    if (!fs.existsSync(gameDir)) {
      fs.mkdirSync(gameDir, { recursive: true });
    }

    const stateDir = path.join(gameDir, ".lampas");
    const stateFile = path.join(stateDir, "installation.json");
    const cacheDir = path.join(stateDir, "cache", "sha256");
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    onProgress({
      status: "checking",
      message: `Connecting to Lampas Portal channel '${channel}'...`,
      filesCompleted: 0,
      totalFiles: 0,
      percent: 5,
      bytesDownloaded: 0,
      totalBytes: 0,
    });

    let targetVersion = "2.0.0";
    let manifest: any;
    let releaseData: any = { pack: "Lampas 2" };

    try {
      // 1. Fetch channel pointer
      const channelHeaders: Record<string, string> = { "User-Agent": "Lampas-Launcher/1.0" };
      if (config.token) {
        channelHeaders["Authorization"] = `Bearer ${config.token}`;
      }

      const channelResp = await fetch(`${portalUrl}/api/v1/channels/${channel}`, { headers: channelHeaders });
      if (!channelResp.ok) {
        throw new Error(`Failed to query channel '${channel}': ${channelResp.statusText}`);
      }

      const channelData = await channelResp.json();
      targetVersion = channelData.version;

      // 2. Fetch release descriptor
      const releaseResp = await fetch(`${portalUrl}/api/v1/releases/${targetVersion}`, { headers: channelHeaders });
      if (!releaseResp.ok) {
        if (releaseResp.status === 410) {
          throw new Error(`Release v${targetVersion} has been REVOKED due to critical issues. Please select another channel.`);
        }
        throw new Error(`Failed to fetch release descriptor: ${releaseResp.statusText}`);
      }

      releaseData = await releaseResp.json();

      // 3. Fetch client manifest
      onProgress({
        status: "checking",
        message: `Fetching client manifest v${targetVersion}...`,
        filesCompleted: 0,
        totalFiles: 0,
        percent: 15,
        bytesDownloaded: 0,
        totalBytes: 0,
      });

      const manifestResp = await fetch(`${portalUrl}/api/v1/releases/${targetVersion}/client-manifest`, {
        headers: channelHeaders,
      });
      if (!manifestResp.ok) {
        throw new Error(`Failed to fetch client manifest: ${manifestResp.statusText}`);
      }

      manifest = await manifestResp.json();
    } catch (portalErr: any) {
      // Offline / Local pipeline fallback
      const localManifestPath = path.join(__dirname, "../../manifest/client-manifest.json");
      if (fs.existsSync(localManifestPath)) {
        manifest = JSON.parse(fs.readFileSync(localManifestPath, "utf-8"));
        targetVersion = manifest.version || "2.0.0";
      } else {
        throw new Error(`Portal unavailable (${portalErr.message}) and no local manifest found.`);
      }
    }

    const manifestFiles: any[] = manifest.files || [];

    // 4. Reconcile with local files
    let prevState = { files: {} as Record<string, any> };
    if (fs.existsSync(stateFile)) {
      try {
        prevState = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      } catch {
        // fresh state
      }
    }

    const desiredFilesMap = new Map<string, any>();
    for (const f of manifestFiles) {
      desiredFilesMap.set(f.path, f);
    }

    const toDownload: any[] = [];
    let upToDateCount = 0;

    for (const file of manifestFiles) {
      const localPath = path.join(gameDir, file.path);
      const policy = file.policy || "MANAGED";

      if (policy === "PRESERVE" || isPathProtected(file.path)) {
        if (fs.existsSync(localPath)) {
          upToDateCount++;
          continue;
        }
      }

      if (fs.existsSync(localPath)) {
        const hash = computeFileSha256(localPath);
        if (hash === file.hashes.sha256) {
          upToDateCount++;
          continue;
        }
      }

      toDownload.push(file);
    }

    // Identify obsolete managed files
    const toDelete: string[] = [];
    for (const [prevPath, info] of Object.entries(prevState.files)) {
      if (info.policy === "MANAGED" && !desiredFilesMap.has(prevPath) && !isPathProtected(prevPath)) {
        toDelete.push(prevPath);
      }
    }

    // 5. Download missing/modified files
    const totalFiles = manifestFiles.length;
    let completedCount = upToDateCount;
    let totalBytes = toDownload.reduce((acc, f) => acc + (f.size || 0), 0);
    let bytesDownloaded = 0;

    if (toDownload.length > 0) {
      const concurrency = 6;
      const queue = [...toDownload];
      const downloadedMap = new Map<string, Buffer>();

      async function worker() {
        while (queue.length > 0) {
          const file = queue.shift();
          if (!file) break;

          let downloadUrl = file.download.url;
          if (downloadUrl.startsWith("/")) {
            downloadUrl = `${portalUrl}${downloadUrl}`;
          }

          // Check blob cache first
          const cachePath = path.join(cacheDir, file.hashes.sha256.substring(0, 2), file.hashes.sha256);
          let buf: Buffer;

          if (fs.existsSync(cachePath)) {
            const cachedBuf = fs.readFileSync(cachePath);
            if (computeBufferSha256(cachedBuf) === file.hashes.sha256) {
              buf = cachedBuf;
            } else {
              buf = await downloadBinary(file);
              fs.writeFileSync(cachePath, buf);
            }
          } else {
            buf = await downloadBinary(file);
            if (!fs.existsSync(path.dirname(cachePath))) {
              fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            }
            fs.writeFileSync(cachePath, buf);
          }

          downloadedMap.set(file.path, buf);
          completedCount++;
          bytesDownloaded += buf.length;

          const percent = Math.min(95, Math.round(15 + (completedCount / totalFiles) * 80));
          onProgress({
            status: "downloading",
            message: `Downloading ${path.basename(file.path)}...`,
            currentFile: file.path,
            filesCompleted: completedCount,
            totalFiles,
            percent,
            bytesDownloaded,
            totalBytes,
          });
        }
      }

      async function downloadBinary(fileEntry: any): Promise<Buffer> {
        let url = fileEntry.download.url;
        const expectedSha256 = fileEntry.hashes.sha256;

        if (url.startsWith("/")) {
          const candidates = [
            path.join(__dirname, "../../pack/common", fileEntry.path),
            path.join(__dirname, "../../pack/client", fileEntry.path),
            path.join(__dirname, "../../pack/custom", path.basename(fileEntry.path)),
          ];
          for (const c of candidates) {
            if (fs.existsSync(c)) {
              const buf = fs.readFileSync(c);
              if (computeBufferSha256(buf) === expectedSha256) {
                return buf;
              }
            }
          }
          url = `${portalUrl}${url}`;
        }

        const resp = await fetch(url, { headers: { "User-Agent": "Lampas-Launcher/1.0" } });
        if (!resp.ok) {
          throw new Error(`Failed to download ${url}: ${resp.statusText}`);
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        const hash = computeBufferSha256(buffer);
        if (hash !== expectedSha256) {
          throw new Error(`SHA-256 mismatch for ${url}! Expected ${expectedSha256}, got ${hash}`);
        }
        return buffer;
      }

      const workers = Array.from({ length: Math.min(concurrency, toDownload.length) }, () => worker());
      await Promise.all(workers);

      // Apply staged files atomically
      onProgress({
        status: "staging",
        message: "Staging and applying modpack files...",
        filesCompleted: completedCount,
        totalFiles,
        percent: 96,
        bytesDownloaded,
        totalBytes,
      });

      for (const [relPath, buffer] of downloadedMap.entries()) {
        const destPath = path.join(gameDir, relPath);
        if (!fs.existsSync(path.dirname(destPath))) {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
        }
        const tmpPath = `${destPath}.tmp.${Date.now()}`;
        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, destPath);
      }
    }

    // 6. Delete obsolete managed files
    for (const relPath of toDelete) {
      const fullPath = path.join(gameDir, relPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }

    // 7. Write installation state
    const newState = {
      pack: manifest.pack || releaseData.pack || "Lampas 2",
      version: targetVersion,
      installedAt: new Date().toISOString(),
      files: {} as Record<string, any>,
    };

    for (const file of manifestFiles) {
      newState.files[file.path] = {
        sha256: file.hashes.sha256,
        size: file.size,
        policy: file.policy,
      };
    }

    fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2), "utf-8");

    onProgress({
      status: "complete",
      message: `Lampas Modpack v${targetVersion} is ready!`,
      filesCompleted: totalFiles,
      totalFiles,
      percent: 100,
      bytesDownloaded: totalBytes,
      totalBytes,
    });

    return {
      success: true,
      version: targetVersion,
      packName: newState.pack,
    };
  }
}
