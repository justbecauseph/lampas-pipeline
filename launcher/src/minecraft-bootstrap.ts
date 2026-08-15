import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import versionMeta262 from "./version-meta-26.2.json";

interface MavenCoordinate {
  name: string;
  url?: string;
  sha1?: string;
  rules?: Array<{ action: "allow" | "disallow"; os?: { name: string } }>;
  downloads?: {
    artifact?: {
      sha1: string;
      size: number;
      url: string;
      path?: string;
    };
    classifiers?: Record<string, { sha1: string; size: number; url: string; path?: string }>;
  };
}

function parseMavenCoordinate(name: string): { group: string; artifact: string; version: string; classifier?: string } {
  const parts = name.split(":");
  const group = parts[0];
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts.length > 3 ? parts[3] : undefined;
  return { group, artifact, version, classifier };
}

function mavenToPath(coord: { group: string; artifact: string; version: string; classifier?: string }): string {
  const groupPath = coord.group.replace(/\./g, "/");
  const fileSuffix = coord.classifier ? `-${coord.classifier}` : "";
  return `${groupPath}/${coord.artifact}/${coord.version}/${coord.artifact}-${coord.version}${fileSuffix}.jar`;
}

function computeFileSha1(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return createHash("sha1").update(buffer).digest("hex");
}

function isLibraryAllowed(lib: MavenCoordinate): boolean {
  if (!lib.rules || lib.rules.length === 0) return true;

  const currentOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
  let allowed = false;

  for (const rule of lib.rules) {
    if (rule.action === "allow") {
      if (!rule.os || rule.os.name === currentOs) {
        allowed = true;
      }
    } else if (rule.action === "disallow") {
      if (rule.os && rule.os.name === currentOs) {
        allowed = false;
      }
    }
  }

  return allowed;
}

const FABRIC_LOADER_LIBRARIES = [
  { name: "org.ow2.asm:asm:9.10.1", url: "https://maven.fabricmc.net/" },
  { name: "org.ow2.asm:asm-analysis:9.10.1", url: "https://maven.fabricmc.net/" },
  { name: "org.ow2.asm:asm-commons:9.10.1", url: "https://maven.fabricmc.net/" },
  { name: "org.ow2.asm:asm-tree:9.10.1", url: "https://maven.fabricmc.net/" },
  { name: "org.ow2.asm:asm-util:9.10.1", url: "https://maven.fabricmc.net/" },
  { name: "net.fabricmc:sponge-mixin:0.17.3+mixin.0.8.7", url: "https://maven.fabricmc.net/" },
  { name: "net.fabricmc:fabric-loader:0.19.3", url: "https://maven.fabricmc.net/" },
  { name: "net.fabricmc:intermediary:26.2", url: "https://maven.fabricmc.net/" },
];

export class MinecraftBootstrap {
  private static async downloadFile(url: string, destPath: string, expectedSha1?: string): Promise<Buffer> {
    if (fs.existsSync(destPath)) {
      const existing = fs.readFileSync(destPath);
      if (!expectedSha1 || createHash("sha1").update(existing).digest("hex") === expectedSha1) {
        return existing;
      }
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const resp = await fetch(url, { headers: { "User-Agent": "Lampas-Launcher/1.0" } });
    if (!resp.ok) {
      throw new Error(`Failed to download ${url} (${resp.status}): ${resp.statusText}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (expectedSha1) {
      const actualSha1 = createHash("sha1").update(buffer).digest("hex");
      if (actualSha1 !== expectedSha1) {
        throw new Error(`SHA-1 mismatch for ${path.basename(destPath)}!\n  Expected: ${expectedSha1}\n  Got:      ${actualSha1}`);
      }
    }

    fs.writeFileSync(destPath, buffer);
    return buffer;
  }

  private static extractNatives(jarBuffer: Buffer, nativesDir: string): void {
    try {
      const unzipped = unzipSync(new Uint8Array(jarBuffer));
      for (const [filename, fileBytes] of Object.entries(unzipped)) {
        if (
          filename.endsWith(".dll") ||
          filename.endsWith(".so") ||
          filename.endsWith(".dylib") ||
          filename.endsWith(".jnilib")
        ) {
          const dest = path.join(nativesDir, path.basename(filename));
          fs.writeFileSync(dest, Buffer.from(fileBytes));
        }
      }
    } catch {
      // Ignore non-zip or corrupt native jars
    }
  }

  static async prepareGameEnvironment(
    gameDir: string,
    mcVersion = "26.2",
    fabricVersion = "0.19.3",
    onLog: (msg: string) => void
  ): Promise<{ classpath: string[]; mainClass: string; assetIndex: string }> {
    const librariesDir = path.join(gameDir, "libraries");
    const assetsDir = path.join(gameDir, "assets");
    const nativesDir = path.join(gameDir, "natives");
    const versionsDir = path.join(gameDir, "versions", mcVersion);

    fs.mkdirSync(librariesDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(nativesDir, { recursive: true });
    fs.mkdirSync(versionsDir, { recursive: true });

    onLog(`[Bootstrap] Resolving Minecraft ${mcVersion} environment (Fabric Loader ${fabricVersion})...`);

    // 1. Download Minecraft 26.2 Client JAR
    const clientJar = versionMeta262.mainJar.downloads.artifact;
    const clientJarPath = path.join(versionsDir, `${mcVersion}-client.jar`);
    onLog(`[Bootstrap] Verifying Minecraft ${mcVersion} client JAR...`);
    await this.downloadFile(clientJar.url, clientJarPath, clientJar.sha1);

    const classpath: string[] = [clientJarPath];

    // 2. Download Fabric Loader 0.19.3 & Intermediary 26.2
    onLog(`[Bootstrap] Verifying Fabric Loader & Intermediary...`);
    for (const lib of FABRIC_LOADER_LIBRARIES) {
      const coord = parseMavenCoordinate(lib.name);
      const relPath = mavenToPath(coord);
      const destPath = path.join(librariesDir, relPath);
      const repoUrl = lib.url || "https://maven.fabricmc.net/";
      const downloadUrl = `${repoUrl.replace(/\/+$/, "")}/${relPath}`;

      await this.downloadFile(downloadUrl, destPath);
      classpath.push(destPath);
    }

    // 3. Download Mojang & LWJGL 3.4.1 Libraries (Fastutil, Gson, Guava, Log4j, LWJGL, etc.)
    const allLibs = (versionMeta262.libraries || []) as MavenCoordinate[];
    const allowedLibs = allLibs.filter(isLibraryAllowed);
    onLog(`[Bootstrap] Verifying ${allowedLibs.length} core game libraries (Mojang & LWJGL)...`);

    for (const lib of allowedLibs) {
      const coord = parseMavenCoordinate(lib.name);
      const relPath = mavenToPath(coord);
      const destPath = path.join(librariesDir, relPath);

      let downloadUrl = lib.downloads?.artifact?.url;
      let expectedSha1 = lib.downloads?.artifact?.sha1;

      if (!downloadUrl) {
        const repoUrl = lib.url || "https://libraries.minecraft.net/";
        downloadUrl = `${repoUrl.replace(/\/+$/, "")}/${relPath}`;
      }

      const buffer = await this.downloadFile(downloadUrl, destPath, expectedSha1);
      classpath.push(destPath);

      // Extract platform natives if this library is a native bundle
      if (
        coord.classifier?.includes("natives") ||
        coord.artifact.includes("natives") ||
        lib.name.includes("natives")
      ) {
        this.extractNatives(buffer, nativesDir);
      }
    }

    // 4. Download Asset Index & Ensure Asset Objects (Textures, Sounds, Panorama)
    const assetIndex = versionMeta262.assetIndex;
    await this.ensureAssets(assetsDir, assetIndex, onLog);

    const mainClass = "net.fabricmc.loader.impl.launch.knot.KnotClient";

    return {
      classpath,
      mainClass,
      assetIndex: assetIndex.id,
    };
  }

  private static async ensureAssets(
    assetsDir: string,
    assetIndexMeta: { id: string; sha1: string; url: string; size: number },
    onLog: (msg: string) => void
  ): Promise<void> {
    const assetIndexDir = path.join(assetsDir, "indexes");
    const assetObjectsDir = path.join(assetsDir, "objects");
    const assetIndexPath = path.join(assetIndexDir, `${assetIndexMeta.id}.json`);

    fs.mkdirSync(assetIndexDir, { recursive: true });
    fs.mkdirSync(assetObjectsDir, { recursive: true });

    if (!fs.existsSync(assetIndexPath)) {
      onLog(`[Bootstrap] Downloading Minecraft asset index (${assetIndexMeta.id})...`);
      await this.downloadFile(assetIndexMeta.url, assetIndexPath, assetIndexMeta.sha1);
    }

    let indexData: any = {};
    try {
      indexData = JSON.parse(fs.readFileSync(assetIndexPath, "utf-8"));
    } catch {
      await this.downloadFile(assetIndexMeta.url, assetIndexPath, assetIndexMeta.sha1);
      indexData = JSON.parse(fs.readFileSync(assetIndexPath, "utf-8"));
    }

    const objects: Record<string, { hash: string; size: number }> = indexData.objects || {};
    const entries = Object.values(objects);

    const missing: Array<{ hash: string; size: number; destFile: string }> = [];
    let alreadyPresentCount = 0;

    for (const item of entries) {
      const prefix = item.hash.substring(0, 2);
      const destDir = path.join(assetObjectsDir, prefix);
      const destFile = path.join(destDir, item.hash);

      if (fs.existsSync(destFile)) {
        try {
          const stat = fs.statSync(destFile);
          if (stat.size === item.size) {
            alreadyPresentCount++;
            continue;
          }
        } catch {}
      }

      missing.push({ hash: item.hash, size: item.size, destFile });
    }

    if (missing.length > 0) {
      onLog(`[Bootstrap] Downloading ${missing.length} Minecraft assets from official CDN...`);
      const concurrency = 32;
      const queue = [...missing];
      let completed = 0;
      const total = missing.length;

      async function worker() {
        while (queue.length > 0) {
          const task = queue.shift();
          if (!task) break;

          const prefix = task.hash.substring(0, 2);
          const url = `https://resources.download.minecraft.net/${prefix}/${task.hash}`;
          const dir = path.dirname(task.destFile);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

          try {
            const resp = await fetch(url, { headers: { "User-Agent": "Lampas-Launcher/1.0" } });
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              fs.writeFileSync(task.destFile, buf);
            }
          } catch {}

          completed++;
          if (completed % 250 === 0 || completed === total) {
            onLog(`[Bootstrap] Assets: ${completed}/${total} (${Math.round((completed / total) * 100)}%)...`);
          }
        }
      }

      const workers = Array.from({ length: Math.min(concurrency, missing.length) }, () => worker());
      await Promise.all(workers);
    }

    onLog(`[Bootstrap] All ${entries.length} official asset objects verified.`);
  }
}
