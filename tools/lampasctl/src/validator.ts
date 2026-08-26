import * as fs from "node:fs";
import * as path from "node:path";
import { isValidServerAddress, parseTomlFile, readJsonFile } from "./utils";
import type { PackConfig, PackLock } from "./types";

export interface ValidateOptions {
  packDir: string;
  lockFile: string;
}

export async function validatePack(options: ValidateOptions): Promise<boolean> {
  const packTomlPath = path.join(options.packDir, "pack.toml");
  if (!fs.existsSync(packTomlPath)) {
    console.error(`[Validate Error] pack.toml missing at ${packTomlPath}`);
    return false;
  }

  const packConfig = parseTomlFile<PackConfig>(packTomlPath);
  console.log(`[Validator] Validating ${packConfig.pack.name} v${packConfig.pack.version}...`);

  if (!fs.existsSync(options.lockFile)) {
    console.error(`[Validate Error] Lock file missing at ${options.lockFile}. Run 'lampasctl resolve' first.`);
    return false;
  }

  const lock = readJsonFile<PackLock>(options.lockFile);
  const modsDir = path.join(options.packDir, "mods");
  const modFiles = fs.readdirSync(modsDir).filter((f) => f.endsWith(".toml"));

  let hasErrors = false;

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

  if (hasErrors) {
    console.error("\n[Validation Failed] Pack contains errors.");
    return false;
  }

  console.log(`\n[Validation Passed] All ${Object.keys(lock.artifacts).length} artifacts and definitions are valid!`);
  return true;
}
