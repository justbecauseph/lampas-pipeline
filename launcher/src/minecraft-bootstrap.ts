import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import * as zlib from "node:zlib";
import { ConfigManager } from "./config";
import type { GameLogEntry, UserProfile } from "./types";

interface MavenCoordinate {
  name: string;
  url?: string;
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

export class MinecraftBootstrap {
  private static async downloadFile(url: string, destPath: string, expectedSha1?: string): Promise<void> {
    if (fs.existsSync(destPath)) {
      if (!expectedSha1 || computeFileSha1(destPath) === expectedSha1) {
        return;
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
  }

  static async prepareGameEnvironment(
    gameDir: string,
    mcVersion = "1.21.1",
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

    onLog(`[Bootstrap] Resolving Mojang version metadata for Minecraft ${mcVersion}...`);

    // 1. Fetch Mojang Version Manifest
    let versionJson: any;
    const versionJsonPath = path.join(versionsDir, `${mcVersion}.json`);

    if (fs.existsSync(versionJsonPath)) {
      versionJson = JSON.parse(fs.readFileSync(versionJsonPath, "utf-8"));
    } else {
      const manifestResp = await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
      const manifest = await manifestResp.json();
      const versionMeta = manifest.versions.find((v: any) => v.id === mcVersion || v.id === "1.21.1");

      if (!versionMeta) {
        throw new Error(`Minecraft version ${mcVersion} not found in Mojang version manifest.`);
      }

      const vResp = await fetch(versionMeta.url);
      versionJson = await vResp.json();
      fs.writeFileSync(versionJsonPath, JSON.stringify(versionJson, null, 2), "utf-8");
    }

    // 2. Download Minecraft Client JAR
    const clientJarPath = path.join(versionsDir, `${mcVersion}-client.jar`);
    if (versionJson.downloads?.client) {
      onLog(`[Bootstrap] Verifying client JAR: ${path.basename(clientJarPath)}...`);
      await this.downloadFile(
        versionJson.downloads.client.url,
        clientJarPath,
        versionJson.downloads.client.sha1
      );
    }

    const classpath: string[] = [clientJarPath];

    // 3. Download Mojang Libraries
    onLog(`[Bootstrap] Checking ${versionJson.libraries?.length || 0} Mojang core libraries...`);
    for (const lib of versionJson.libraries || []) {
      // Check OS rules
      if (lib.rules) {
        let allowed = false;
        for (const rule of lib.rules) {
          if (rule.action === "allow") {
            if (!rule.os || (rule.os.name === "windows" && process.platform === "win32") || (rule.os.name === "linux" && process.platform === "linux")) {
              allowed = true;
            }
          } else if (rule.action === "disallow") {
            if (rule.os && ((rule.os.name === "windows" && process.platform === "win32") || (rule.os.name === "linux" && process.platform === "linux"))) {
              allowed = false;
            }
          }
        }
        if (!allowed) continue;
      }

      // Standard artifact
      if (lib.downloads?.artifact) {
        const libPath = path.join(librariesDir, lib.downloads.artifact.path);
        await this.downloadFile(
          lib.downloads.artifact.url,
          libPath,
          lib.downloads.artifact.sha1
        );
        classpath.push(libPath);
      }
    }

    // 4. Fetch Fabric Loader Meta
    onLog(`[Bootstrap] Resolving Fabric Loader v${fabricVersion} for Minecraft ${mcVersion}...`);
    let fabricMeta: any;
    try {
      const fabricResp = await fetch(
        `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${fabricVersion}/profile/json`
      );
      if (fabricResp.ok) {
        fabricMeta = await fabricResp.json();
      } else {
        // Fallback for custom version numbers like 26.2 to 1.21.1 loader meta
        const fallbackResp = await fetch(
          `https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.19.3/profile/json`
        );
        fabricMeta = await fallbackResp.json();
      }
    } catch (err: any) {
      throw new Error(`Failed to query Fabric Meta API: ${err.message}`);
    }

    // 5. Download Fabric Libraries
    for (const lib of fabricMeta.libraries || []) {
      const coord = parseMavenCoordinate(lib.name);
      const relPath = mavenToPath(coord);
      const destPath = path.join(librariesDir, relPath);
      const repoUrl = lib.url || "https://maven.fabricmc.net/";
      const downloadUrl = `${repoUrl.replace(/\/+$/, "")}/${relPath}`;

      await this.downloadFile(downloadUrl, destPath);
      classpath.push(destPath);
    }

    // 6. Download Asset Index
    const assetIndexId = versionJson.assetIndex?.id || "17";
    const assetIndexDir = path.join(assetsDir, "indexes");
    const assetIndexPath = path.join(assetIndexDir, `${assetIndexId}.json`);

    if (versionJson.assetIndex?.url && !fs.existsSync(assetIndexPath)) {
      onLog(`[Bootstrap] Downloading asset index ${assetIndexId}...`);
      await this.downloadFile(
        versionJson.assetIndex.url,
        assetIndexPath,
        versionJson.assetIndex.sha1
      );
    }

    const mainClass = fabricMeta.mainClass || "net.fabricmc.loader.impl.launch.knot.KnotClient";

    return {
      classpath,
      mainClass,
      assetIndex: assetIndexId,
    };
  }
}
