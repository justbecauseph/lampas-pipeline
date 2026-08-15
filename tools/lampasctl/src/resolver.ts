import * as fs from "node:fs";
import * as path from "node:path";
import { parseTomlFile, writeJsonFile } from "./utils";
import { ArtifactResolver } from "./providers";
import { enrichPackLock } from "./enricher";
import type { ModDefinition, PackConfig, PackLock, ResolvedArtifact } from "./types";

export interface ResolveOptions {
  packDir: string;
  lockFile: string;
}

interface DefinitionFile {
  id: string;
  filePath: string;
  defaultType: "mod" | "shader" | "resourcepack";
}

export async function resolvePack(options: ResolveOptions): Promise<PackLock> {
  const packTomlPath = path.join(options.packDir, "pack.toml");
  if (!fs.existsSync(packTomlPath)) {
    throw new Error(`pack.toml not found at ${packTomlPath}`);
  }

  const packConfig = parseTomlFile<PackConfig>(packTomlPath);
  const modsDir = path.join(options.packDir, "mods");
  const shaderpacksDir = path.join(options.packDir, "shaderpacks");
  const shadersDir = path.join(options.packDir, "shaders");
  const resourcepacksDir = path.join(options.packDir, "resourcepacks");

  const allDefinitions: DefinitionFile[] = [];

  // 1. Scan mods
  if (fs.existsSync(modsDir)) {
    const modFiles = fs.readdirSync(modsDir).filter((f) => f.endsWith(".toml")).sort();
    for (const f of modFiles) {
      allDefinitions.push({
        id: path.basename(f, ".toml"),
        filePath: path.join(modsDir, f),
        defaultType: "mod",
      });
    }
  }

  // 2. Scan shaderpacks / shaders
  for (const sDir of [shaderpacksDir, shadersDir]) {
    if (fs.existsSync(sDir)) {
      const sFiles = fs.readdirSync(sDir).filter((f) => f.endsWith(".toml")).sort();
      for (const f of sFiles) {
        allDefinitions.push({
          id: path.basename(f, ".toml"),
          filePath: path.join(sDir, f),
          defaultType: "shader",
        });
      }
    }
  }

  // 3. Scan resourcepacks
  if (fs.existsSync(resourcepacksDir)) {
    const rFiles = fs.readdirSync(resourcepacksDir).filter((f) => f.endsWith(".toml")).sort();
    for (const f of rFiles) {
      allDefinitions.push({
        id: path.basename(f, ".toml"),
        filePath: path.join(resourcepacksDir, f),
        defaultType: "resourcepack",
      });
    }
  }

  console.log(`[Resolver] Resolving ${allDefinitions.length} artifact definitions for ${packConfig.pack.name} v${packConfig.pack.version}...`);

  const artifacts: Record<string, ResolvedArtifact> = {};
  const baseDir = path.dirname(options.packDir);

  // Parallel resolution with concurrency limit
  const concurrency = 10;
  const queue = [...allDefinitions];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      const def = parseTomlFile<ModDefinition>(item.filePath);
      if (!def.type) {
        def.type = item.defaultType;
      }
      if (item.defaultType === "shader" || item.defaultType === "resourcepack") {
        if (!def.side) def.side = "client";
      }

      try {
        const artifact = await ArtifactResolver.resolveModDefinition(item.id, def, baseDir);
        artifacts[item.id] = artifact;
        console.log(`  ✓ [Resolved] ${item.id} -> ${artifact.targetDir || "mods"}/${artifact.filename} (${artifact.sha256.substring(0, 10)}...)`);
      } catch (err: any) {
        console.error(`  ✗ [Failed] ${item.id}: ${err.message}`);
        throw err;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, allDefinitions.length) }, () => worker());
  await Promise.all(workers);

  const lock: PackLock = {
    schema: 1,
    packName: packConfig.pack.name,
    packVersion: packConfig.pack.version,
    minecraft: packConfig.pack.minecraft,
    loader: {
      type: packConfig.loader.type,
      version: packConfig.loader.version,
    },
    updated: new Date().toISOString(),
    artifacts,
  };

  writeJsonFile(options.lockFile, lock, true);
  console.log(`\n[Resolver] Successfully resolved ${Object.keys(artifacts).length} artifacts to ${options.lockFile}`);

  // Automatically enrich metadata from Modrinth
  try {
    await enrichPackLock({ packDir: options.packDir, lockFile: options.lockFile });
  } catch (enrichErr: any) {
    console.warn(`[Resolver Warning] Failed to enrich metadata: ${enrichErr.message}`);
  }

  return lock;
}
