import * as fs from "node:fs";
import * as path from "node:path";
import { parseTomlFile, readJsonFile } from "./utils";
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

  if (hasErrors) {
    console.error("\n[Validation Failed] Pack contains errors.");
    return false;
  }

  console.log(`\n[Validation Passed] All ${Object.keys(lock.artifacts).length} artifacts and definitions are valid!`);
  return true;
}
