import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonFile, withAbortTimeout, writeJsonFile } from "./utils";
import type { PackLock, ResolvedArtifact } from "./types";
import { CurseForgeClient } from "./curseforge";

export interface EnrichOptions {
  packDir: string;
  lockFile: string;
}

export async function enrichPackLock(options: EnrichOptions): Promise<PackLock> {
  if (!fs.existsSync(options.lockFile)) {
    throw new Error(`Lockfile not found at ${options.lockFile}`);
  }

  const lock = readJsonFile<PackLock>(options.lockFile);
  const artifacts = lock.artifacts || {};
  const entries = Object.entries(artifacts);

  console.log(`[Enricher] Enriching metadata for ${entries.length} mod artifacts...`);

  // 1. Collect all Modrinth project IDs
  const modrinthMap: Record<string, string[]> = {}; // projectId -> artifact keys

  for (const [key, artifact] of entries) {
    if (artifact.provider.type === "modrinth" && artifact.provider.projectId) {
      const pid = String(artifact.provider.projectId);
      if (!modrinthMap[pid]) modrinthMap[pid] = [];
      modrinthMap[pid].push(key);
    }
  }

  const curseForgeMap: Record<string, string[]> = {};
  for (const [key, artifact] of entries) {
    if (artifact.provider.type === "curseforge" && artifact.provider.projectId) {
      const projectId = String(artifact.provider.projectId);
      if (!curseForgeMap[projectId]) curseForgeMap[projectId] = [];
      curseForgeMap[projectId].push(key);
    }
  }

  const projectIds = Object.keys(modrinthMap);
  console.log(`[Enricher] Fetching batch metadata for ${projectIds.length} Modrinth projects...`);

  // Batch query in chunks of 80
  const chunkSize = 80;
  let enrichedCount = 0;

  for (let i = 0; i < projectIds.length; i += chunkSize) {
    const chunk = projectIds.slice(i, i + chunkSize);
    try {
      const url = `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(chunk))}`;
      const projects = await withAbortTimeout(`fetching metadata for Modrinth project batch`, async (signal) => {
        const res = await fetch(url, {
          signal,
          headers: {
            "User-Agent": "Lampas-Pipeline/2.0 (enricher)",
            Accept: "application/json",
          },
        });

        if (!res.ok) {
          throw new Error(`Batch query returned status ${res.status}`);
        }

        return await res.json();
      });
      if (Array.isArray(projects)) {
        for (const proj of projects) {
          const keys = modrinthMap[proj.id] || modrinthMap[proj.slug] || [];
          for (const key of keys) {
            const art = artifacts[key];
            if (art) {
              art.name = proj.title || art.name;
              (art as any).metadata = {
                description: proj.description || "",
                iconUrl: proj.icon_url || undefined,
                categories: proj.categories || [],
                sourceUrl: `https://modrinth.com/mod/${proj.slug}`,
                clientSide: proj.client_side,
                serverSide: proj.server_side,
              };
              enrichedCount++;
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`[Enricher] Warning: Batch query failed: ${err.message}`);
    }
  }

  const curseForgeProjectIds = Object.keys(curseForgeMap).map(Number);
  console.log(`[Enricher] Fetching batch metadata for ${curseForgeProjectIds.length} CurseForge projects...`);
  for (let i = 0; i < curseForgeProjectIds.length; i += 50) {
    const chunk = curseForgeProjectIds.slice(i, i + 50);
    try {
      const projects = await CurseForgeClient.getMods(chunk);
      for (const project of projects) {
        const keys = curseForgeMap[String(project.id)] || [];
        for (const key of keys) {
          const artifact = artifacts[key];
          if (!artifact) continue;
          artifact.name = project.name || artifact.name;
          artifact.metadata = {
            description: project.summary || "",
            iconUrl: project.logo?.thumbnailUrl || project.logo?.url,
            categories: project.categories?.map((category) => category.name) || [],
            sourceUrl:
              project.links?.websiteUrl ||
              `https://www.curseforge.com/minecraft/mc-mods/${project.slug}`,
            author: project.authors?.map((author) => author.name).join(", ") || undefined,
          };
          enrichedCount++;
        }
      }
    } catch (err: any) {
      console.warn(`[Enricher] Warning: CurseForge batch query failed: ${err.message}`);
    }
  }

  // Add custom metadata for in-house/custom mods
  for (const [key, art] of entries) {
    if (art.provider.type === "lampas") {
      if (key.includes("lampas2-overrides") || key.includes("overrides")) {
        (art as any).metadata = {
          description: "Official Lampas SMP protocol verification handshake and client/server mixin bridge.",
          categories: ["protocol", "core", "utility"],
          sourceUrl: "https://github.com/justbecauseph/lampas2-overrides",
        };
        enrichedCount++;
      } else if (key.includes("camerapture")) {
        (art as any).metadata = {
          description: "In-game camera and photographic screenshot gallery engine for Minecraft 26.2.",
          categories: ["utility", "media"],
        };
        enrichedCount++;
      } else if (key.includes("figura")) {
        (art as any).metadata = {
          description: "Advanced customizable 3D avatar and Lua scripting engine (Minecraft 26.2 Port).",
          categories: ["cosmetic", "avatar"],
        };
        enrichedCount++;
      }
    }
  }

  writeJsonFile(options.lockFile, lock, true);
  console.log(`[Enricher] Successfully enriched ${enrichedCount} mods with descriptions, icons, and categories!`);

  return lock;
}
