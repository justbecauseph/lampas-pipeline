import * as fs from "node:fs";
import * as path from "node:path";
import { parseTomlFile, writeTomlFile, writeJsonFile, readJsonFile } from "./utils";
import { resolvePack } from "./resolver";
import { buildManifests } from "./manifest";
import {
  CURSEFORGE_FABRIC_LOADER_TYPE,
  CURSEFORGE_MINECRAFT_GAME_ID,
  CURSEFORGE_MODS_CLASS_ID,
  CurseForgeClient,
  type CurseForgeFile,
} from "./curseforge";
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
 * Returns a set of all project IDs and slugs currently defined in pack/mods/
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
      } else if (def.provider?.type === "curseforge") {
        ids.add(String(def.provider.project_id));
      }
    } catch {}
  }
  return ids;
}

function detectModSide(
  projData: { client_side?: string; server_side?: string },
  explicitSide?: "client" | "server" | "both"
): "client" | "server" | "both" {
  if (explicitSide) return explicitSide;

  const client = (projData.client_side || "").toLowerCase();
  const server = (projData.server_side || "").toLowerCase();

  if (server === "unsupported") {
    return "client";
  }
  if (client === "unsupported") {
    return "server";
  }
  return "both";
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

  let rawQuery = options.query.trim();
  let explicitVersion = options.versionId?.trim();

  // 1. Handle local file paths
  if (rawQuery.endsWith(".jar") && fs.existsSync(rawQuery)) {
    const filename = path.basename(rawQuery);
    const dest = path.join(customDir, filename);
    fs.copyFileSync(rawQuery, dest);

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
    let query = rawQuery;
    let detectedProvider: "modrinth" | "curseforge" | undefined;

    // 2. Parse URL patterns
    if (query.includes("modrinth.com/version/")) {
      detectedProvider = "modrinth";
      // Direct version URL: https://modrinth.com/version/{version_id}
      const versionIdFromUrl = query.split("modrinth.com/version/")[1].split("?")[0].split("/")[0];
      explicitVersion = versionIdFromUrl;
      const vRes = await fetch(`https://api.modrinth.com/v2/version/${versionIdFromUrl}`, {
        headers: { "User-Agent": "Lampas-Pipeline/2.0", Accept: "application/json" },
      });
      if (!vRes.ok) {
        throw new Error(`Modrinth version '${versionIdFromUrl}' not found (${vRes.status})`);
      }
      const vData = await vRes.json();
      query = vData.project_id;
    } else if (
      query.includes("modrinth.com/mod/") ||
      query.includes("modrinth.com/shader/") ||
      query.includes("modrinth.com/resourcepack/") ||
      query.includes("modrinth.com/datapack/")
    ) {
      detectedProvider = "modrinth";
      const match = query.match(/modrinth\.com\/(?:mod|shader|resourcepack|datapack)\/([^/?#]+)(?:\/version\/([^/?#]+))?/);
      if (match) {
        query = match[1];
        if (match[2]) {
          explicitVersion = match[2];
        }
      }
    } else if (query.includes("curseforge.com/minecraft/mc-mods/")) {
      detectedProvider = "curseforge";
      const afterMod = query.split("curseforge.com/minecraft/mc-mods/")[1].split("?")[0];
      const segments = afterMod.split("/").filter(Boolean);
      query = segments[0];
      if (segments.length >= 3 && segments[1] === "files" && segments[2]) {
        explicitVersion = segments[2];
      }
    }

    // 3. Parse inline version syntax if not already set (e.g. slug@version, slug:version, slug==version)
    if (!explicitVersion) {
      if (query.includes("@")) {
        const parts = query.split("@");
        query = parts[0];
        explicitVersion = parts[1];
      } else if (query.includes("==")) {
        const parts = query.split("==");
        query = parts[0];
        explicitVersion = parts[1];
      } else if (query.includes(":") && !query.startsWith("http://") && !query.startsWith("https://")) {
        const parts = query.split(":");
        query = parts[0];
        explicitVersion = parts[1];
      }
    }

    const providerType = options.provider || detectedProvider || "modrinth";

    if (providerType === "modrinth") {
      const indent = "  ".repeat(depth);
      const verDisplay = explicitVersion ? ` (Version: ${explicitVersion})` : "";
      console.log(`${indent}[Artifact Manager] Querying Modrinth for '${query}'${verDisplay} (Target: MC ${targetMc}, ${targetLoader})...`);

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
      const projectType = projData.project_type || "mod";

      // Determine side and target directory
      let targetSide = detectModSide(projData, options.side);
      let targetDir = modsDir;
      if (projectType === "shader") {
        targetSide = "client";
        targetDir = path.join(options.packDir, "shaderpacks");
      } else if (projectType === "resourcepack") {
        targetSide = "client";
        targetDir = path.join(options.packDir, "resourcepacks");
      }
      os_ensure_dir(targetDir);

      // 2. Query matching version
      let selectedVersion: any = null;

      // Fetch all project versions
      const allVersRes = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version`, {
        headers: { "User-Agent": "Lampas-Pipeline/2.0", Accept: "application/json" },
      });

      if (!allVersRes.ok) {
        throw new Error(`Failed to query versions for '${slug}' (${allVersRes.status})`);
      }

      const allVersions: any[] = await allVersRes.json();

      if (explicitVersion) {
        const needle = explicitVersion.toLowerCase();

        // 2a. Match exact ID, version_number, name, or filename
        selectedVersion = allVersions.find(
          (v) =>
            v.id === explicitVersion ||
            v.version_number?.toLowerCase() === needle ||
            v.name?.toLowerCase() === needle ||
            v.files?.some((f: any) => f.filename?.toLowerCase() === needle)
        );

        // 2b. Fuzzy / Prefix match if exact not found
        if (!selectedVersion) {
          selectedVersion = allVersions.find(
            (v) =>
              v.version_number?.toLowerCase().startsWith(needle) ||
              v.name?.toLowerCase().includes(needle) ||
              needle.startsWith(v.version_number?.toLowerCase() || "")
          );
        }

        // 2c. Direct version lookup by ID if still not found
        if (!selectedVersion) {
          const directVerRes = await fetch(`https://api.modrinth.com/v2/version/${explicitVersion}`, {
            headers: { "User-Agent": "Lampas-Pipeline/2.0", Accept: "application/json" },
          });
          if (directVerRes.ok) {
            selectedVersion = await directVerRes.json();
          }
        }

        if (!selectedVersion) {
          const availableList = allVersions
            .slice(0, 6)
            .map((v) => `  - ${v.version_number} (MC: ${v.game_versions?.join(", ")}) [ID: ${v.id}]`)
            .join("\n");
          throw new Error(
            `Specified version '${explicitVersion}' not found for '${modName}' (${slug}).\nAvailable versions on Modrinth:\n${availableList}`
          );
        }
      } else {
        if (projectType === "shader") {
          // Shaders are largely version-agnostic / Iris compatible
          const irisCompatible = allVersions.filter((v) =>
            v.loaders?.some((l: string) => ["iris", "canvas", "optifine"].includes(l.toLowerCase()))
          );
          selectedVersion = irisCompatible[0] || allVersions[0];
        } else if (projectType === "resourcepack") {
          const mcCompatible = allVersions.filter((v) => v.game_versions?.includes(targetMc));
          selectedVersion = mcCompatible[0] || allVersions[0];
        } else {
          // Find latest compatible with target MC and Loader
          const compatibleVersions = allVersions.filter(
            (v) => v.game_versions?.includes(targetMc) && v.loaders?.includes(targetLoader)
          );

          if (compatibleVersions.length === 0) {
            const availableList = allVersions
              .slice(0, 6)
              .map((v) => `  - ${v.version_number} (MC: ${v.game_versions?.join(", ")}, Loaders: ${v.loaders?.join(", ")}) [ID: ${v.id}]`)
              .join("\n");
            throw new Error(
              `No compatible version found for '${modName}' on Minecraft ${targetMc} (${targetLoader}).\n` +
                `You can explicitly install a specific version with:\n` +
                `  lampasctl add ${slug} --version <version_id_or_number>\n\n` +
                `Available upstream versions:\n${availableList}`
            );
          }

          selectedVersion = compatibleVersions[0];
        }
      }

      const versionId: string = selectedVersion.id;
      const versionName: string = selectedVersion.name || selectedVersion.version_number || versionId;
      const versionNumber: string = selectedVersion.version_number || "";
      const primaryFile = selectedVersion.files?.find((f: any) => f.primary) || selectedVersion.files?.[0];
      const filename: string = primaryFile?.filename || versionName;
      const dependencies: Array<{ project_id: string | null; version_id: string | null; dependency_type: string }> =
        selectedVersion.dependencies || [];

      const tomlPath = path.join(targetDir, `${slug}.toml`);
      const def: ModDefinition = {
        name: modName,
        side: targetSide,
        type: projectType as any,
        provider: {
          type: "modrinth",
          project_id: projectId,
          version_id: versionId,
        },
      };

      writeTomlFile(tomlPath, def);
      console.log(`\n${indent}✓ [Added ${projectType.toUpperCase()}] ${modName} (${slug})`);
      console.log(`${indent}   Provider: Modrinth (${projectId})`);
      console.log(`${indent}   Version:  ${versionNumber} [ID: ${versionId}] (${versionName})`);
      console.log(`${indent}   Side:     ${targetSide} ${options.side ? "(explicit)" : "(auto-detected)"}`);
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
              side: targetSide, // Inherit same side (client/server/both)
              versionId: dep.version_id || undefined,
              depth: depth + 1,
            });
            existingIds.add(depTarget.toLowerCase());
          } catch (depErr: any) {
            console.warn(`${indent}   ⚠️ Could not automatically install dependency '${depTarget}': ${depErr.message}`);
          }
        }
      }
    } else if (providerType === "curseforge") {
      const indent = "  ".repeat(depth);
      const verDisplay = explicitVersion ? ` (File: ${explicitVersion})` : "";
      console.log(
        `${indent}[Artifact Manager] Querying CurseForge for '${query}'${verDisplay} (Target: MC ${targetMc}, ${targetLoader})...`
      );

      const project = await CurseForgeClient.findMod(query);
      if (project.gameId !== CURSEFORGE_MINECRAFT_GAME_ID) {
        throw new Error(`CurseForge project '${query}' is not a Minecraft project.`);
      }
      if (project.classId !== undefined && project.classId !== CURSEFORGE_MODS_CLASS_ID) {
        throw new Error(`CurseForge project '${project.name}' is not a Minecraft mod project.`);
      }
      if (project.isAvailable === false) {
        throw new Error(`CurseForge project '${project.name}' (${project.id}) is not available.`);
      }
      if (project.allowModDistribution === false) {
        throw new Error(
          `CurseForge project '${project.name}' does not permit third-party downloads. Download the .jar manually and add the local file instead.`
        );
      }

      let selectedFile: CurseForgeFile;
      if (explicitVersion) {
        if (!/^\d+$/.test(explicitVersion)) {
          throw new Error(
            `CurseForge versions must be pinned by numeric file ID; received '${explicitVersion}'.`
          );
        }
        selectedFile = await CurseForgeClient.getFile(project.id, Number(explicitVersion));

        const versionNames = selectedFile.gameVersions.map((version) => version.toLowerCase());
        const matchesMinecraft = selectedFile.gameVersions.includes(targetMc);
        const matchesFabric = versionNames.some((version) => version === "fabric" || version.includes("fabric"));
        if (!matchesMinecraft || !matchesFabric) {
          console.warn(
            `${indent}⚠ [Compatibility Override] File ${selectedFile.id} is not explicitly tagged for Minecraft ${targetMc} + Fabric.`
          );
        }
      } else {
        const compatibleFiles = await CurseForgeClient.getModFiles(project.id, {
          gameVersion: targetMc,
          modLoaderType: CURSEFORGE_FABRIC_LOADER_TYPE,
        });
        selectedFile = compatibleFiles[0];
        if (!selectedFile) {
          throw new Error(
            `No compatible CurseForge file found for '${project.name}' on Minecraft ${targetMc} (Fabric). ` +
              `Use --version <file_id> only if you intentionally want to override compatibility filtering.`
          );
        }
      }

      await CurseForgeClient.getDownloadUrl(project.id, selectedFile.id, selectedFile);

      const slug = project.slug.toLowerCase();
      const targetSide = options.side || "both";
      const tomlPath = path.join(modsDir, `${slug}.toml`);
      if (fs.existsSync(tomlPath)) {
        const existing = parseTomlFile<ModDefinition>(tomlPath);
        const sameProject =
          existing.provider.type === "curseforge" && existing.provider.project_id === project.id;
        if (!sameProject) {
          throw new Error(
            `Cannot add CurseForge project '${project.name}': descriptor '${slug}.toml' already belongs to another project or provider.`
          );
        }
      }

      const def: ModDefinition = {
        name: project.name,
        side: targetSide,
        type: "mod",
        provider: {
          type: "curseforge",
          project_id: project.id,
          file_id: selectedFile.id,
        },
      };
      writeTomlFile(tomlPath, def);

      console.log(`\n${indent}✓ [Added MOD] ${project.name} (${slug})`);
      console.log(`${indent}   Provider: CurseForge (${project.id})`);
      console.log(`${indent}   File:     ${selectedFile.displayName} [ID: ${selectedFile.id}]`);
      console.log(`${indent}   Side:     ${targetSide} ${options.side ? "(explicit)" : "(default)"}`);
      console.log(`${indent}   JAR:      ${selectedFile.fileName}`);
      console.log(`${indent}   Saved to: ${tomlPath}\n`);

      const requiredDependencies = (selectedFile.dependencies || []).filter(
        (dependency) => dependency.relationType === 3
      );
      if (requiredDependencies.length > 0) {
        const existingIds = getExistingModIdentifiers(modsDir);
        console.log(
          `${indent}🔍 [Dependency Checker] Inspecting ${requiredDependencies.length} required dependencies for ${project.name}...`
        );

        for (const dependency of requiredDependencies) {
          const dependencyId = String(dependency.modId);
          if (existingIds.has(dependencyId)) {
            console.log(`${indent}   ✓ [Satisfied] CurseForge project '${dependencyId}' is already installed.`);
            continue;
          }

          console.log(`\n${indent}   ⚡ [Auto-Resolving Missing Dependency] Installing: ${dependencyId}...`);
          try {
            await addMod({
              packDir: options.packDir,
              query: dependencyId,
              side: targetSide,
              provider: "curseforge",
              depth: depth + 1,
            });
          } catch (error: any) {
            throw new Error(
              `Required CurseForge dependency '${dependencyId}' for '${project.name}' could not be installed: ${error.message}`,
              { cause: error }
            );
          }
          existingIds.add(dependencyId);
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
