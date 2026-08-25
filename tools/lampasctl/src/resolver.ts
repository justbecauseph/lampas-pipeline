import * as fs from "node:fs";
import * as path from "node:path";
import { parseTomlFile, readJsonFile, writeJsonFile } from "./utils";
import { ArtifactResolver, ModrinthClient } from "./providers";
import { CurseForgeClient } from "./curseforge";
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

  let existingLock: PackLock | undefined;
  if (fs.existsSync(options.lockFile)) {
    try {
      existingLock = readJsonFile<PackLock>(options.lockFile);
    } catch {
      // ignore corrupted lock
    }
  }

  const artifacts: Record<string, ResolvedArtifact> = {};
  const baseDir = path.dirname(options.packDir);

  const parsedDefinitions = allDefinitions.map((item) => {
    const def = parseTomlFile<ModDefinition>(item.filePath);
    if (!def.type) def.type = item.defaultType;
    if (def.type === "shader" || def.type === "resourcepack" || item.defaultType === "shader" || item.defaultType === "resourcepack") {
      def.side = "client";
    }
    return { item, def };
  });

  const versionIds = [...new Set(parsedDefinitions.flatMap(({ def }) =>
    def.provider.type === "modrinth" ? [def.provider.version_id] : []
  ))];
  const versionChunks: string[][] = [];
  for (let i = 0; i < versionIds.length; i += 80) versionChunks.push(versionIds.slice(i, i + 80));
  const versionResponses = await Promise.all(versionChunks.map((chunk) => ModrinthClient.getVersions(chunk)));
  const versionsById = new Map(versionResponses.flat().map((version) => [version.id, version]));

  const curseForgeFileIds = [...new Set(parsedDefinitions.flatMap(({ def }) =>
    def.provider.type === "curseforge" ? [def.provider.file_id] : []
  ))];
  const curseForgeFileChunks: number[][] = [];
  for (let i = 0; i < curseForgeFileIds.length; i += 50) {
    curseForgeFileChunks.push(curseForgeFileIds.slice(i, i + 50));
  }
  const curseForgeFileResponses = await Promise.all(
    curseForgeFileChunks.map((chunk) => CurseForgeClient.getFiles(chunk))
  );
  const curseForgeFilesById = new Map(curseForgeFileResponses.flat().map((file) => [file.id, file]));

  // Parallel resolution with concurrency limit
  const concurrency = 10;
  let nextDefinition = 0;

  async function worker() {
    while (nextDefinition < parsedDefinitions.length) {
      const { item, def } = parsedDefinitions[nextDefinition++];

      try {
        const prefetchedVersion = def.provider.type === "modrinth"
          ? versionsById.get(def.provider.version_id)
          : undefined;
        if (def.provider.type === "modrinth" && !prefetchedVersion) {
          throw new Error(`Modrinth version '${def.provider.version_id}' was not returned by the bulk API.`);
        }
        const prefetchedCurseForgeFile = def.provider.type === "curseforge"
          ? curseForgeFilesById.get(def.provider.file_id)
          : undefined;
        if (def.provider.type === "curseforge" && !prefetchedCurseForgeFile) {
          throw new Error(`CurseForge file '${def.provider.file_id}' was not returned by the bulk API.`);
        }
        const cachedArtifact =
          existingLock?.artifacts?.[item.id] ||
          existingLock?.artifacts?.[item.id.replace(/_/g, "-")] ||
          existingLock?.artifacts?.[item.id.replace(/-/g, "_")];
        const artifact = await ArtifactResolver.resolveModDefinition(
          item.id,
          def,
          baseDir,
          prefetchedVersion,
          prefetchedCurseForgeFile,
          cachedArtifact
        );
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
