import * as fs from "node:fs";
import * as path from "node:path";
import { parseTomlFile, writeTomlFile, writeJsonFile, readJsonFile } from "./utils";
import { resolvePack } from "./resolver";
import { buildManifests } from "./manifest";
import type { ModDefinition, PackConfig, PackLock } from "./types";

export interface AddModOptions {
  packDir: string;
  query: string;
  side?: "client" | "server" | "both";
  provider?: "modrinth" | "curseforge" | "lampas";
  versionId?: string;
  depth?: number;
}

export interface RemoveModOptions {
  packDir: string;
  modId: string;
}

/**
 * Returns a map of all project IDs and slugs currently defined in pack/mods/
 */
function getExistingModIdentifiers(modsDir: string): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(modsDir)) return ids;

  const files = fs.readdirSync(modsDir).filter((f) => f.endsWith(".toml"));
  for (const file of files) {
    const slug = path.basename(file, ".toml");
    ids.add(slug.toLowerCase());

    try {
      const def = parseTomlFile<ModDefinition>(path.join(modsDir, file));
      if (def.provider?.type === "modrinth") {
        if (def.provider.project_id) ids.add(def.provider.project_id.toLowerCase());
      }
    } catch {}
  }
  return ids;
}

export async function addMod(options: AddModOptions) {
  const packConfigFile = path.join(options.packDir, "pack.toml");
  const modsDir = path.join(options.packDir, "mods");
  const customDir = path.join(options.packDir, "custom");

  if (!fs.existsSync(packConfigFile)) {
    throw new Error(`pack.toml not found at ${packConfigFile}`);
  }

  const packConfig = parseTomlFile<PackConfig>(packConfigFile);
  const targetMc = packConfig.pack.minecraft;
  const targetLoader = packConfig.loader.type;
  const side = options.side || "both";
  const depth = options.depth || 0;

  os_ensure_dir(modsDir);
  os_ensure_dir(customDir);

  let query = options.query.trim();

  // 1. Handle local file paths
  if (query.endsWith(".jar") && fs.existsSync(query)) {
    const filename = path.basename(query);
    const dest = path.join(customDir, filename);
    fs.copyFileSync(query, dest);

    const modId = filename.replace(/\.jar$/i, "").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const tomlPath = path.join(modsDir, `${modId}.toml`);

    const def: ModDefinition = {
      name: filename.replace(/\.jar$/i, ""),
      side,
      provider: {
        type: "lampas",
        file: `custom/${filename}`,
      },
    };

    writeTomlFile(tomlPath, def);
    console.log(`✓ [Added Custom Mod] ${filename} -> ${tomlPath}`);
  } else {
    // Clean URL into slug/ID
    if (query.includes("modrinth.com/mod/")) {
      query = query.split("modrinth.com/mod/")[1].split("/")[0].split("?")[0];
    } else if (query.includes("curseforge.com/minecraft/mc-mods/")) {
      query = query.split("curseforge.com/minecraft/mc-mods/")[1].split("/")[0].split("?")[0];
    }

    const providerType = options.provider || "modrinth";

    if (providerType === "modrinth") {
      const indent = "  ".repeat(depth);
      console.log(`${indent}[Mod Manager] Querying Modrinth for '${query}' (MC ${targetMc}, ${targetLoader})...`);

      // 1. Query project metadata
      const projRes = await fetch(`https://api.modrinth.com/v2/project/${query}`, {
        headers: { "User-Agent": "Lampas-Pipeline/2.0", Accept: "application/json" },
      });

      if (!projRes.ok) {
        throw new Error(`Modrinth project '${query}' not found (${projRes.status})`);
      }

      const projData = await projRes.json();
      const projectId = projData.id;
      const slug = projData.slug;
      const modName = projData.title;

      // 2. Query matching versions
      let versionId = options.versionId;
      let versionName = "";
      let filename = "";
      let dependencies: Array<{ project_id: string | null; version_id: string | null; dependency_type: string }> = [];

      if (!versionId) {
        const verUrl = `https://api.modrinth.com/v2/project/${projectId}/version?game_versions=[%22${targetMc}%22]&loaders=[%22${targetLoader}%22]`;
        const verRes = await fetch(verUrl, {
          headers: { "User-Agent": "Lampas-Pipeline/2.0", Accept: "application/json" },
        });

        if (!verRes.ok) {
          throw new Error(`Failed to query versions for ${slug}`);
        }

        const versions = await verRes.json();
        if (!Array.isArray(versions) || versions.length === 0) {
          throw new Error(`No compatible version found for '${modName}' on Minecraft ${targetMc} (${targetLoader})`);
        }

        const latest = versions[0];
        versionId = latest.id;
        versionName = latest.name;
        filename = (latest.files.find((f: any) => f.primary) || latest.files[0])?.filename || latest.name;
        dependencies = latest.dependencies || [];
      } else {
        // Query specific version for dependencies
        const verRes = await fetch(`https://api.modrinth.com/v2/version/${versionId}`, {
          headers: { "User-Agent": "Lampas-Pipeline/2.0", Accept: "application/json" },
        });
        if (verRes.ok) {
          const verData = await verRes.json();
          dependencies = verData.dependencies || [];
        }
      }

      const tomlPath = path.join(modsDir, `${slug}.toml`);
      const def: ModDefinition = {
        name: modName,
        side,
        provider: {
          type: "modrinth",
          project_id: projectId,
          version_id: versionId,
        },
      };

      writeTomlFile(tomlPath, def);
      console.log(`\n${indent}✓ [Added Mod] ${modName} (${slug})`);
      console.log(`${indent}   Provider: Modrinth (${projectId})`);
      console.log(`${indent}   Version:  ${versionId} ${versionName ? `(${versionName})` : ""}`);
      console.log(`${indent}   Side:     ${side}`);
      console.log(`${indent}   File:     ${filename}`);
      console.log(`${indent}   Saved to: ${tomlPath}\n`);

      // 3. Intelligent Recursive Dependency Resolution
      const existingIds = getExistingModIdentifiers(modsDir);

      const requiredDeps = dependencies.filter(
        (d) => d.dependency_type === "required" && (d.project_id || d.version_id)
      );

      if (requiredDeps.length > 0) {
        console.log(`${indent}🔍 [Dependency Checker] Inspecting ${requiredDeps.length} required dependencies for ${modName}...`);

        for (const dep of requiredDeps) {
          const depTarget = dep.project_id || dep.version_id;
          if (!depTarget) continue;

          // Check if already in pack
          if (existingIds.has(depTarget.toLowerCase())) {
            console.log(`${indent}   ✓ [Satisfied] Required dependency '${depTarget}' is already installed.`);
            continue;
          }

          console.log(`\n${indent}   ⚡ [Auto-Resolving Missing Dependency] Installing: ${depTarget}...`);
          try {
            await addMod({
              packDir: options.packDir,
              query: depTarget,
              side, // Inherit same side (client/server/both)
              versionId: dep.version_id || undefined,
              depth: depth + 1,
            });
            existingIds.add(depTarget.toLowerCase());
          } catch (depErr: any) {
            console.warn(`${indent}   ⚠️ Could not automatically install dependency '${depTarget}': ${depErr.message}`);
          }
        }
      }
    } else {
      throw new Error(`Provider '${providerType}' not supported for automatic resolution yet.`);
    }
  }

  // Only perform root-level lockfile and manifest builds
  if (depth === 0) {
    console.log("[Mod Manager] Updating pack.lock.json and manifests...");
    const lockFile = path.join(options.packDir, "pack.lock.json");
    const manifestDir = path.resolve(path.join(options.packDir, "..", "manifest"));

    await resolvePack({ packDir: options.packDir, lockFile });
    await buildManifests({ packDir: options.packDir, lockFile, outDir: manifestDir });

    console.log(`\n🎉 Mod and all required dependencies added and synchronized successfully!`);
  }
}

export async function removeMod(options: RemoveModOptions) {
  const modsDir = path.join(options.packDir, "mods");
  const lockFile = path.join(options.packDir, "pack.lock.json");
  const manifestDir = path.resolve(path.join(options.packDir, "..", "manifest"));

  const targetToml = path.join(modsDir, `${options.modId}.toml`);
  if (!fs.existsSync(targetToml)) {
    throw new Error(`Mod descriptor not found: ${targetToml}`);
  }

  const def = parseTomlFile<ModDefinition>(targetToml);
  fs.unlinkSync(targetToml);
  console.log(`✓ [Deleted] ${targetToml} (${def.name})`);

  // Remove from lockfile if present
  if (fs.existsSync(lockFile)) {
    const lock = readJsonFile<PackLock>(lockFile);
    if (lock.artifacts && lock.artifacts[options.modId]) {
      delete lock.artifacts[options.modId];
      writeJsonFile(lockFile, lock, true);
      console.log(`✓ [Removed from Lockfile] ${options.modId}`);
    }
  }

  // Re-build manifests
  console.log("[Mod Manager] Re-building manifests...");
  await buildManifests({ packDir: options.packDir, lockFile, outDir: manifestDir });

  console.log(`\n🎉 Mod '${options.modId}' removed and manifests synchronized successfully!`);
}

function os_ensure_dir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
