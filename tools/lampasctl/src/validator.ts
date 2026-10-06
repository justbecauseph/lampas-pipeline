import * as fs from "node:fs";
import * as path from "node:path";
import { isValidServerAddress, parseTomlFile, readJsonFile } from "./utils";
import type { BlacklistTarget, PackConfig, PackLock, ProviderConfig } from "./types";
import { describeBlacklistRule, matchingBlacklistRules, parsePackBlacklistRules } from "./blacklist";
import { validateConfigPatches } from "./config-patches";
import { verifyFabricLoaderCompatibility } from "./fabric-meta-validator";

function requireExactStringIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /\s/.test(value)) {
    throw new Error(`${label} must be a non-empty exact string without whitespace.`);
  }
  return value;
}

function requirePositiveIntegerIdentity(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function blacklistTarget(
  modId: string,
  providerInput: unknown,
  sourceKind: "descriptor" | "lock"
): BlacklistTarget {
  const provider = providerInput && typeof providerInput === "object"
    ? providerInput as Record<string, unknown>
    : {};
  const type = typeof provider.type === "string" ? provider.type : "direct";
  const target: BlacklistTarget = {
    modId,
    provider: type as ProviderConfig["type"],
  };

  if (type === "modrinth") {
    const projectId = sourceKind === "descriptor" ? provider.project_id : provider.projectId;
    const versionId = sourceKind === "descriptor" ? provider.version_id : provider.versionId;
    target.projectId = requireExactStringIdentity(projectId, "Modrinth project_id");
    target.versionId = requireExactStringIdentity(versionId, "Modrinth version_id");
  } else if (type === "curseforge") {
    const projectId = sourceKind === "descriptor" ? provider.project_id : provider.projectId;
    const fileId = sourceKind === "descriptor" ? provider.file_id : provider.fileId;
    target.projectId = requirePositiveIntegerIdentity(projectId, "CurseForge project_id");
    target.versionId = requirePositiveIntegerIdentity(fileId, sourceKind === "descriptor" ? "CurseForge file_id" : "CurseForge fileId");

    if (sourceKind === "lock" && provider.versionId !== undefined && provider.versionId !== provider.fileId) {
      throw new Error("CurseForge lock versionId must equal its authoritative fileId when both are present.");
    }
  }
  return target;
}

function logBlacklistMatches(
  rules: ReturnType<typeof parsePackBlacklistRules>,
  target: BlacklistTarget,
  source: string
): boolean {
  const matches = matchingBlacklistRules(rules, target);
  for (const rule of matches) {
    console.error(`  ✗ [Blacklisted Artifact] ${source} matches ${describeBlacklistRule(rule)}`);
  }
  return matches.length > 0;
}

export interface LoaderDefinition {
  type: "fabric";
  version: string;
}

export function validateLoaderDefinition(
  minecraft: unknown,
  loader: unknown
): LoaderDefinition {
  if (typeof minecraft !== "string" || minecraft.trim().length === 0) {
    throw new Error("Invalid pack definition: 'pack.minecraft' must be a non-empty string.");
  }

  if (!loader || typeof loader !== "object") {
    throw new Error("Invalid pack definition: '[loader]' section is missing or not an object.");
  }

  const l = loader as Record<string, any>;
  if (!l.type) {
    throw new Error("Invalid pack definition: '[loader.type]' is required.");
  }
  if (l.type !== "fabric") {
    throw new Error(`Unsupported mod loader '${l.type}'. Lampas supports Fabric releases only.`);
  }

  if (typeof l.version !== "string" || l.version.trim().length === 0) {
    throw new Error("Invalid loader version: 'loader.version' must be a non-empty string.");
  }

  return {
    type: "fabric",
    version: l.version.trim(),
  };
}

export interface ValidateOptions {
  packDir: string;
  lockFile: string;
  checkFabricMeta?: boolean;
}

export async function validatePack(options: ValidateOptions): Promise<boolean> {
  const packTomlPath = path.join(options.packDir, "pack.toml");
  if (!fs.existsSync(packTomlPath)) {
    console.error(`[Validate Error] pack.toml missing at ${packTomlPath}`);
    return false;
  }

  const packConfig = parseTomlFile<PackConfig>(packTomlPath);
  let blacklistRules: ReturnType<typeof parsePackBlacklistRules>;
  try {
    blacklistRules = parsePackBlacklistRules(packConfig, "pack.toml");
  } catch (err: any) {
    console.error(`  ✗ [Invalid Blacklist] ${err.message}`);
    return false;
  }
  console.log(`[Validator] Validating ${packConfig.pack.name} v${packConfig.pack.version}...`);

  let loaderDef: LoaderDefinition;
  try {
    loaderDef = validateLoaderDefinition(packConfig.pack?.minecraft, packConfig.loader);
  } catch (err: any) {
    console.error(`  ✗ [Invalid Loader] ${err.message}`);
    return false;
  }

  if (!fs.existsSync(options.lockFile)) {
    console.error(`[Validate Error] Lock file missing at ${options.lockFile}. Run 'lampasctl resolve' first.`);
    return false;
  }

  const lock = readJsonFile<PackLock>(options.lockFile);

  let hasErrors = false;

  // Apply exact blacklist identities from descriptors and the lock before any optional network checks.
  if (blacklistRules.length > 0) {
    for (const directory of ["mods", "shaderpacks", "shaders", "resourcepacks"]) {
      const artifactDir = path.join(options.packDir, directory);
      if (!fs.existsSync(artifactDir)) continue;

      for (const file of fs.readdirSync(artifactDir).filter((name) => name.endsWith(".toml"))) {
        const modId = path.basename(file, ".toml");
        const source = `pack/${directory}/${file}`;
        let definition: Record<string, unknown>;
        try {
          definition = parseTomlFile<Record<string, unknown>>(path.join(artifactDir, file));
        } catch (err: any) {
          console.error(`  ✗ [Invalid Artifact Definition] ${source}: ${err.message}`);
          hasErrors = true;
          continue;
        }
        try {
          const target = blacklistTarget(modId, definition.provider, "descriptor");
          if (logBlacklistMatches(blacklistRules, target, source)) hasErrors = true;
        } catch (err: any) {
          console.error(`  ✗ [Invalid Provider Identity] ${source}: ${err.message}`);
          hasErrors = true;
        }
      }
    }

    for (const [id, artifact] of Object.entries(lock.artifacts)) {
      const source = `pack.lock.json artifact '${id}'`;
      try {
        const target = blacklistTarget(id, artifact.provider, "lock");
        if (logBlacklistMatches(blacklistRules, target, source)) hasErrors = true;
      } catch (err: any) {
        console.error(`  ✗ [Invalid Provider Identity] ${source}: ${err.message}`);
        hasErrors = true;
      }
    }
  }

  // Check lock consistency with pack.toml
  if (lock.minecraft !== packConfig.pack.minecraft) {
    console.error(
      `  ✗ [Lock Mismatch] pack.lock.json was generated for Minecraft ${lock.minecraft}, but pack.toml requires ${packConfig.pack.minecraft}. Regenerate the lock before publishing.`
    );
    hasErrors = true;
  }

  if (
    !lock.loader ||
    lock.loader.type !== loaderDef.type ||
    lock.loader.version !== loaderDef.version
  ) {
    console.error(
      `  ✗ [Lock Mismatch] pack.lock.json was generated for Fabric Loader ${lock.loader?.version ?? "unknown"}, but pack.toml requires ${loaderDef.version}. Regenerate the lock before publishing.`
    );
    hasErrors = true;
  }

  // Validate Fabric Meta compatibility
  if (options.checkFabricMeta !== false) {
    try {
      await verifyFabricLoaderCompatibility(packConfig.pack.minecraft, loaderDef.version);
      console.log(`  ✓ [Loader Verified] Fabric Loader ${loaderDef.version} is compatible with Minecraft ${packConfig.pack.minecraft}`);
    } catch (err: any) {
      console.error(`  ✗ ${err.message}`);
      hasErrors = true;
    }
  }

  const modsDir = path.join(options.packDir, "mods");
  const modFiles = fs.readdirSync(modsDir).filter((f) => f.endsWith(".toml"));

  // Check that every mod TOML has a corresponding entry in pack.lock.json
  for (const file of modFiles) {
    const modId = path.basename(file, ".toml");
    if (!lock.artifacts[modId]) {
      console.error(`  ✗ [Missing from Lock] ${modId}.toml is defined in pack/mods but missing from lockfile!`);
      hasErrors = true;
    }
  }

  // Check that every lock entry has a valid sha256 and size > 0
  for (const [id, artifact] of Object.entries(lock.artifacts)) {
    if (!artifact.sha256 || artifact.sha256.length !== 64) {
      console.error(`  ✗ [Invalid Hash] Artifact '${id}' has invalid SHA-256: ${artifact.sha256}`);
      hasErrors = true;
    }
    if (!artifact.size || artifact.size <= 0) {
      console.error(`  ✗ [Invalid Size] Artifact '${id}' has non-positive size: ${artifact.size}`);
      hasErrors = true;
    }
  }

  // Check launcher play configuration
  if (packConfig.launcher?.play) {
    const { auto_connect, server } = packConfig.launcher.play;
    if (auto_connect && (!server || !isValidServerAddress(server))) {
      console.error(`  ✗ [Invalid Play Config] auto_connect is true but server is missing or invalid: '${server || ""}'`);
      hasErrors = true;
    }
    if (server && !isValidServerAddress(server)) {
      console.error(`  ✗ [Invalid Server Address] server '${server}' is malformed.`);
      hasErrors = true;
    }
  }

  // Check dual-delivery conflict
  const launcherRequiredPacks = packConfig.launcher?.resourcepacks?.required || [];
  const serverResourcePack = packConfig.server?.resourcepack || packConfig.server?.resource_pack;
  if (serverResourcePack?.artifact && launcherRequiredPacks.includes(serverResourcePack.artifact)) {
    console.error(`  ✗ [Dual-Delivery Conflict] Resource pack '${serverResourcePack.artifact}' is configured for both launcher-local and server-resource-pack delivery. Choose one delivery mechanism.`);
    hasErrors = true;
  }

  // Check launcher required resource packs
  if (packConfig.launcher?.resourcepacks?.required) {
    for (const packId of packConfig.launcher.resourcepacks.required) {
      const artifact = lock.artifacts[packId];
      if (!artifact) {
        console.error(`  ✗ [Missing Required Resource Pack] Required resource pack '${packId}' was not found in pack.lock.json.`);
        hasErrors = true;
      } else {
        const artifactType = artifact.artifactType || (artifact.targetDir === "resourcepacks" ? "resourcepack" : "mod");
        if (artifactType !== "resourcepack") {
          console.error(`  ✗ [Invalid Artifact Type] Artifact '${packId}' is configured as a required resource pack but has type '${artifactType}'.`);
          hasErrors = true;
        }
        if (artifact.side !== "client" && artifact.side !== "both") {
          console.error(`  ✗ [Invalid Side] Artifact '${packId}' is configured as a required resource pack but is not available to client (side='${artifact.side}').`);
          hasErrors = true;
        }
        const targetDir = artifact.targetDir || "resourcepacks";
        if (targetDir !== "resourcepacks") {
          console.error(`  ✗ [Invalid Target Dir] Artifact '${packId}' is configured as a required resource pack but targetDir '${targetDir}' must be 'resourcepacks'.`);
          hasErrors = true;
        }
        if (!artifact.sha256 || !/^[0-9a-fA-F]{64}$/.test(artifact.sha256)) {
          console.error(`  ✗ [Invalid Hash] Required resource pack '${packId}' has invalid SHA-256: '${artifact.sha256}'.`);
          hasErrors = true;
        }
      }
    }
  }

  // Check server resourcepack configuration
  if (serverResourcePack?.artifact) {
    const packId = serverResourcePack.artifact;
    const artifact = lock.artifacts[packId];
    if (!artifact) {
      console.error(`  ✗ [Missing Server Resource Pack] Server resource pack '${packId}' was not found in pack.lock.json.`);
      hasErrors = true;
    } else {
      const artifactType = artifact.artifactType || (artifact.targetDir === "resourcepacks" ? "resourcepack" : "mod");
      if (artifactType !== "resourcepack") {
        console.error(`  ✗ [Invalid Artifact Type] Artifact '${packId}' is configured as server resource pack but has type '${artifactType}'.`);
        hasErrors = true;
      }
      const targetDir = artifact.targetDir || "resourcepacks";
      if (targetDir !== "resourcepacks") {
        console.error(`  ✗ [Invalid Target Dir] Artifact '${packId}' is configured as server resource pack but targetDir '${targetDir}' must be 'resourcepacks'.`);
        hasErrors = true;
      }
      if (!artifact.sha1 || !/^[0-9a-fA-F]{40}$/.test(artifact.sha1)) {
        console.error(`  ✗ [Missing SHA-1] Server resource pack '${packId}' requires a valid 40-character SHA-1 hash for Minecraft dedicated server.`);
        hasErrors = true;
      }
      if (!artifact.sha256 || !/^[0-9a-fA-F]{64}$/.test(artifact.sha256)) {
        console.error(`  ✗ [Invalid SHA-256] Server resource pack '${packId}' has invalid SHA-256: '${artifact.sha256}'.`);
        hasErrors = true;
      }
    }
  }

  // Check config patches if present
  const patchesFile = path.join(options.packDir, "config-patches", "client.json");
  if (fs.existsSync(patchesFile)) {
    try {
      const raw = readJsonFile<any>(patchesFile);
      const staticDirs = ["common", "client"];
      const manifestFiles: any[] = [];
      for (const dir of staticDirs) {
        const fullDir = path.join(options.packDir, dir);
        if (fs.existsSync(fullDir)) {
          const walk = (cur: string) => {
            for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
              const full = path.join(cur, entry.name);
              if (entry.isDirectory()) walk(full);
              else if (entry.isFile()) {
                manifestFiles.push({
                  path: path.relative(fullDir, full).replace(/\\/g, "/"),
                  policy: "MANAGED",
                });
              }
            }
          };
          walk(fullDir);
        }
      }
      for (const art of Object.values(lock.artifacts)) {
        const targetDir =
          art.targetDir ||
          (art.artifactType === "shader"
            ? "shaderpacks"
            : art.artifactType === "resourcepack"
            ? "resourcepacks"
            : "mods");
        manifestFiles.push({ path: `${targetDir}/${art.filename}`, policy: "MANAGED" });
      }
      validateConfigPatches(raw, manifestFiles);
    } catch (err: any) {
      console.error(`  ✗ [Invalid Config Patches] ${err.message}`);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    console.error("\n[Validation Failed] Pack contains errors.");
    return false;
  }

  console.log(`\n[Validation Passed] All ${Object.keys(lock.artifacts).length} artifacts and definitions are valid!`);
  return true;
}
