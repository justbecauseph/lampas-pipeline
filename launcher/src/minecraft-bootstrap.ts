import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

interface MavenCoordinate {
  name: string;
  url?: string;
  sha1?: string;
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

// Minecraft 26.2 Official Client Metadata & Core Libraries
const MC_26_2_CLIENT_JAR = {
  url: "https://piston-data.mojang.com/v1/objects/2dc72797acbc1b63fc16a11c4ac393605f453754/client.jar",
  sha1: "2dc72797acbc1b63fc16a11c4ac393605f453754",
  size: 39193383,
};

const MC_26_2_ASSET_INDEX = {
  id: "32",
  url: "https://piston-meta.mojang.com/v1/packages/cf75b185cb35b32e299b0c8e674fa202d7911a3c/32.json",
  sha1: "cf75b185cb35b32e299b0c8e674fa202d7911a3c",
};

const FABRIC_LOADER_LIBRARIES: MavenCoordinate[] = [
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
    const clientJarPath = path.join(versionsDir, `${mcVersion}-client.jar`);
    onLog(`[Bootstrap] Verifying Minecraft ${mcVersion} client JAR...`);
    await this.downloadFile(MC_26_2_CLIENT_JAR.url, clientJarPath, MC_26_2_CLIENT_JAR.sha1);

    const classpath: string[] = [clientJarPath];

    // 2. Download Fabric Loader 0.19.3 & Intermediary 26.2 libraries
    onLog(`[Bootstrap] Verifying Fabric Loader & Intermediary libraries...`);
    for (const lib of FABRIC_LOADER_LIBRARIES) {
      const coord = parseMavenCoordinate(lib.name);
      const relPath = mavenToPath(coord);
      const destPath = path.join(librariesDir, relPath);
      const repoUrl = lib.url || "https://maven.fabricmc.net/";
      const downloadUrl = `${repoUrl.replace(/\/+$/, "")}/${relPath}`;

      await this.downloadFile(downloadUrl, destPath);
      classpath.push(destPath);
    }

    // 3. Download Asset Index 32
    const assetIndexDir = path.join(assetsDir, "indexes");
    const assetIndexPath = path.join(assetIndexDir, `${MC_26_2_ASSET_INDEX.id}.json`);
    if (!fs.existsSync(assetIndexPath)) {
      onLog(`[Bootstrap] Downloading Minecraft 26.2 asset index (${MC_26_2_ASSET_INDEX.id})...`);
      await this.downloadFile(MC_26_2_ASSET_INDEX.url, assetIndexPath, MC_26_2_ASSET_INDEX.sha1);
    }

    const mainClass = "net.fabricmc.loader.impl.launch.knot.KnotClient";

    return {
      classpath,
      mainClass,
      assetIndex: MC_26_2_ASSET_INDEX.id,
    };
  }
}
