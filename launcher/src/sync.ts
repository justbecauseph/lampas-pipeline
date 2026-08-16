import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ConfigManager } from "./config";
import { MinecraftBootstrap } from "./minecraft-bootstrap";
import { JavaRuntimeManager } from "./java-runtime";
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
    if (!config.token) {
      throw new Error("Authentication required: Please log in with your Lampas Portal account.");
    }
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

    // Identify obsolete managed files from previous state AND unmanifested mods on disk
    const toDeleteSet = new Set<string>();
    for (const [prevPath, info] of Object.entries(prevState.files)) {
      if (info.policy === "MANAGED" && !desiredFilesMap.has(prevPath) && !isPathProtected(prevPath)) {
        toDeleteSet.add(prevPath);
      }
    }

    // Direct disk reconciliation: scan mods/ directory for any unmanifested JAR files
    const modsDir = path.join(gameDir, "mods");
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

  static async repairInstallation(
    onProgress: (progress: SyncProgress) => void,
    onLog?: (entry: { level: "INFO" | "WARN" | "ERROR"; message: string; timestamp: string }) => void
  ): Promise<{ success: boolean; message: string; version: string; packName: string }> {
    const config = ConfigManager.get();
    const gameDir = config.gameDir;
    const log = (level: "INFO" | "WARN" | "ERROR", msg: string) => {
      if (onLog) {
        onLog({ level, message: msg, timestamp: new Date().toLocaleTimeString() });
      }
    };

    log("INFO", "[Repair] Starting full installation repair and integrity verification...");

    // 1. Force full synchronization of all modpack files with SHA-256 validation
    onProgress({
      status: "repairing",
      message: "Verifying and repairing modpack files...",
      filesCompleted: 0,
      totalFiles: 100,
      percent: 5,
      bytesDownloaded: 0,
      totalBytes: 0,
    });

    const syncResult = await this.syncClient((p) => {
      onProgress({
        ...p,
        status: "repairing",
        percent: Math.round(p.percent * 0.4), // 0% - 40%
      });
    });

    log("INFO", `[Repair] Modpack files verified and repaired (${syncResult.packName} v${syncResult.version}).`);

    // 2. Minecraft 26.2 client JAR, Fabric Loader, libraries, natives, and 5,000+ asset objects
    onProgress({
      status: "repairing",
      message: "Verifying Minecraft libraries, natives, and asset objects...",
      filesCompleted: 40,
      totalFiles: 100,
      percent: 45,
      bytesDownloaded: 0,
      totalBytes: 0,
    });

    await MinecraftBootstrap.prepareGameEnvironment(
      gameDir,
      "26.2",
      "0.19.3",
      (msg) => {
        log("INFO", msg);
        onProgress({
          status: "repairing",
          message: msg,
          filesCompleted: 70,
          totalFiles: 100,
          percent: 75,
          bytesDownloaded: 0,
          totalBytes: 0,
        });
      }
    );

    // 3. Java 25 verification
    onProgress({
      status: "repairing",
      message: "Verifying OpenJDK 25 runtime environment...",
      filesCompleted: 85,
      totalFiles: 100,
      percent: 85,
      bytesDownloaded: 0,
      totalBytes: 0,
    });

    const javaExe = await JavaRuntimeManager.ensureJava25(gameDir, (msg) => log("INFO", msg));
    log("INFO", `[Repair] Java runtime verified: ${javaExe}`);

    onProgress({
      status: "complete",
      message: "Repair complete! All modpack files, assets, and libraries are verified.",
      filesCompleted: 100,
      totalFiles: 100,
      percent: 100,
      bytesDownloaded: 0,
      totalBytes: 0,
    });

    log("INFO", "[Repair] All installation components successfully repaired.");

    return {
      success: true,
      message: "Installation repaired successfully.",
      version: syncResult.version,
      packName: syncResult.packName,
    };
  }

  static async getModCatalog(): Promise<any[]> {
    const config = ConfigManager.get();
    const portalUrl = (config.portalUrl || "http://localhost:3000").replace(/\/+$/, "");
    const channel = config.selectedChannel || "stable";

    try {
      const channelResp = await fetch(`${portalUrl}/api/v1/channels/${channel}`);
      if (channelResp.ok) {
        const channelData = await channelResp.json();
        const manifestResp = await fetch(`${portalUrl}/api/v1/releases/${channelData.version}/client-manifest`);
        if (manifestResp.ok) {
          const manifest = await manifestResp.json();
          if (manifest.mods && Array.isArray(manifest.mods)) {
            return manifest.mods;
          }
        }
      }
    } catch {}

    const localManifestPath = path.join(__dirname, "../../manifest/client-manifest.json");
    if (fs.existsSync(localManifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(localManifestPath, "utf-8"));
        return manifest.mods || [];
      } catch {}
    }

    return [];
  }
}
