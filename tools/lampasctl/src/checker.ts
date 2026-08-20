import * as fs from "node:fs";
import * as path from "node:path";
import { parseTomlFile, writeTomlFile } from "./utils";
import type { ModDefinition, PackConfig } from "./types";

interface ModUpdateInfo {
  modId: string;
  name: string;
  provider: string;
  projectId: string;
  currentVersionId: string;
  currentVersionName: string;
  latestVersionId: string;
  latestVersionName: string;
  latestVersionUrl: string;
  latestFileName: string;
  changelog?: string;
  publishedAt?: string;
}

export interface CheckUpdatesOptions {
  packDir: string;
  apply?: boolean;
  markdownOut?: string;
  concurrency?: number;
}

export async function checkPackUpdates(options: CheckUpdatesOptions): Promise<ModUpdateInfo[]> {
  const packConfigFile = path.join(options.packDir, "pack.toml");
  const modsDir = path.join(options.packDir, "mods");

  if (!fs.existsSync(packConfigFile)) {
    throw new Error(`pack.toml not found at ${packConfigFile}`);
  }

  const packConfig = parseTomlFile<PackConfig>(packConfigFile);
  const targetMc = packConfig.pack.minecraft;
  const targetLoader = packConfig.loader.type;

  console.log(`[Update Checker] Scanning upstream updates for Minecraft ${targetMc} (${targetLoader})...\n`);

  const modFiles = fs.readdirSync(modsDir).filter((f) => f.endsWith(".toml"));
  const updatesAvailable: ModUpdateInfo[] = [];
  let upToDateCount = 0;
  let skippedCount = 0;

  const queue = [...modFiles];
  const concurrency = options.concurrency || 12;

  async function worker() {
    while (queue.length > 0) {
      const file = queue.shift();
      if (!file) break;

      const modId = path.basename(file, ".toml");
      const filePath = path.join(modsDir, file);
      const def = parseTomlFile<ModDefinition>(filePath);

      if (def.provider.type === "modrinth") {
        const projectId = def.provider.project_id;
        const currentVersionId = def.provider.version_id;

        try {
          const url = `https://api.modrinth.com/v2/project/${projectId}/version?game_versions=[%22${targetMc}%22]&loaders=[%22${targetLoader}%22]`;
          const res = await fetch(url, {
            headers: {
              "User-Agent": "Lampas-Pipeline/2.0 (update-checker)",
              Accept: "application/json",
            },
          });

          if (!res.ok) {
            skippedCount++;
            continue;
          }

          const versions = await res.json();
          if (!Array.isArray(versions) || versions.length === 0) {
            skippedCount++;
            continue;
          }

          const latest = versions[0];
          if (latest.id !== currentVersionId) {
            let currentVersion = versions.find((version: any) => version.id === currentVersionId);
            if (!currentVersion) {
              try {
                const currentRes = await fetch(`https://api.modrinth.com/v2/version/${currentVersionId}`, {
                  headers: {
                    "User-Agent": "Lampas-Pipeline/2.0 (update-checker)",
                    Accept: "application/json",
                  },
                });
                if (currentRes.ok) currentVersion = await currentRes.json();
              } catch {
                // Keep reporting the update with its version ID if old metadata is unavailable.
              }
            }

            const primaryFile = latest.files.find((f: any) => f.primary) || latest.files[0];
            const updateInfo: ModUpdateInfo = {
              modId,
              name: def.name,
              provider: "modrinth",
              projectId,
              currentVersionId,
              currentVersionName: currentVersion?.version_number || currentVersion?.name || currentVersionId,
              latestVersionId: latest.id,
              latestVersionName: latest.version_number || latest.name,
              latestVersionUrl: `https://modrinth.com/mod/${projectId}/version/${latest.id}`,
              latestFileName: primaryFile?.filename || latest.name,
              changelog: latest.changelog ? latest.changelog.trim().substring(0, 300) : undefined,
              publishedAt: latest.date_published,
            };

            updatesAvailable.push(updateInfo);
            console.log(`  ⚡ [Update Found] ${def.name}`);
            console.log(`     Mod ID: ${modId}`);
            console.log(`     Project ID: ${projectId}`);
            console.log(`     Version: ${updateInfo.currentVersionName} -> ${updateInfo.latestVersionName}`);
            console.log(`     Version IDs: ${currentVersionId} -> ${latest.id}`);
            console.log(`     Updated version: ${updateInfo.latestVersionUrl}`);

            if (options.apply) {
              def.provider.version_id = latest.id;
              writeTomlFile(filePath, def);
              console.log(`     ✓ Applied to ${file}`);
            }
          } else {
            upToDateCount++;
          }
        } catch (err: any) {
          skippedCount++;
        }
      } else {
        skippedCount++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, modFiles.length) }, () => worker());
  await Promise.all(workers);

  console.log("\n" + "=".repeat(60));
  console.log(` [Update Summary] ${updatesAvailable.length} updates found, ${upToDateCount} up-to-date, ${skippedCount} custom/skipped.`);
  console.log("=".repeat(60) + "\n");

  if (options.markdownOut && updatesAvailable.length > 0) {
    let md = `## 📦 Upstream Mod Updates Available (${updatesAvailable.length})\n\n`;
    md += `Target: **Minecraft ${targetMc}** • **Fabric ${packConfig.loader.version}**\n\n`;
    md += `| Mod | Mod ID | Project ID | Version | Version IDs | Release Date |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    for (const u of updatesAvailable) {
      const dateStr = u.publishedAt ? new Date(u.publishedAt).toLocaleDateString() : "N/A";
      md += `| **${u.name}** | \`${u.modId}\` | \`${u.projectId}\` | **${u.currentVersionName}** → [**${u.latestVersionName}**](${u.latestVersionUrl}) | \`${u.currentVersionId}\` → \`${u.latestVersionId}\` | ${dateStr} |\n`;
    }

    fs.writeFileSync(options.markdownOut, md, "utf-8");
    console.log(`[Update Checker] Markdown report written to ${options.markdownOut}`);
  }

  return updatesAvailable;
}
