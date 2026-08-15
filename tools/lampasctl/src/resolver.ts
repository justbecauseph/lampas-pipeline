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

export async function resolvePack(options: ResolveOptions): Promise<PackLock> {
  const packTomlPath = path.join(options.packDir, "pack.toml");
  if (!fs.existsSync(packTomlPath)) {
    throw new Error(`pack.toml not found at ${packTomlPath}`);
  }

  const packConfig = parseTomlFile<PackConfig>(packTomlPath);
  const modsDir = path.join(options.packDir, "mods");

  if (!fs.existsSync(modsDir)) {
    throw new Error(`mods directory not found at ${modsDir}`);
  }

  const modFiles = fs
    .readdirSync(modsDir)
    .filter((f) => f.endsWith(".toml"))
    .sort();

  console.log(`[Resolver] Resolving ${modFiles.length} mod definitions for ${packConfig.pack.name} v${packConfig.pack.version}...`);

  const artifacts: Record<string, ResolvedArtifact> = {};
  const baseDir = path.dirname(options.packDir);

  // Parallel resolution with concurrency limit
  const concurrency = 10;
  const queue = [...modFiles];

  async function worker() {
    while (queue.length > 0) {
      const file = queue.shift();
      if (!file) break;

      const modId = path.basename(file, ".toml");
      const filePath = path.join(modsDir, file);
      const def = parseTomlFile<ModDefinition>(filePath);

      try {
        const artifact = await ArtifactResolver.resolveModDefinition(modId, def, baseDir);
        artifacts[modId] = artifact;
        console.log(`  ✓ [Resolved] ${modId} -> ${artifact.filename} (${artifact.sha256.substring(0, 10)}...)`);
      } catch (err: any) {
        console.error(`  ✗ [Failed] ${modId}: ${err.message}`);
        throw err;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, modFiles.length) }, () => worker());
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
