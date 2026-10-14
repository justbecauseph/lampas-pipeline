import * as fs from "node:fs";
import * as path from "node:path";
import {
  blobCachePath,
  computeFileHashesStreaming,
  copyFileAtomic,
  copyFileVerified,
  downloadFileVerified,
  ensureDir,
  formatPromptJson,
  isSafeRelativePath,
  readJsonFile,
  writeJsonFile,
} from "./utils";
import { backupDirectory } from "./backup";
import { resolveRelease } from "./release-resolver";
import { prepareFabricServerRuntime, validateRuntimeDefinition } from "./fabric-runtime";
import { DeploymentTransaction } from "./transaction";
import type { InstallationState, ManifestFile, PackManifest, ServerRuntimeState } from "./types";

export interface SyncOptions {
  manifestPath?: string;
  manifest?: PackManifest;
  targetDir: string;
  portalBaseUrl?: string;
  concurrency?: number;
  verificationMode?: "fast" | "full";
  backupWorld?: boolean;
  runtime?: ServerRuntimeState;
  tx?: DeploymentTransaction;
  deferStateWrite?: boolean;
}

export interface DeployOptions {
  targetDir: string;
  portalUrl?: string;
  channel?: string;
  version?: string;
  verificationMode?: "fast" | "full";
  backupWorld?: boolean;
  installerVersion?: string;
  fabricMetaUrl?: string;
  fetchFn?: typeof fetch;
  _testHooks?: {
    forceActivationFailure?: boolean;
  };
}

export const CLIENT_PROTECTED = [
  "saves/",
  "screenshots/",
  "logs/",
  "crash-reports/",
  "options.txt",
  "servers.dat",
  ".lampas/",
];

export const SERVER_PROTECTED = [
  "world/",
  "saves/",
  "logs/",
  "crash-reports/",
  "server.properties",
  "usercache.json",
  "whitelist.json",
  "ops.json",
  "banned-players.json",
  "banned-ips.json",
  "eula.txt",
  "start.py",
  "start.sh",
  ".lampas/",
  ".backups/",
];

export function isPathProtected(target: "client" | "server", relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const prefixes = target === "server" ? SERVER_PROTECTED : CLIENT_PROTECTED;
  return prefixes.some((prefix) => norm === prefix || norm.startsWith(prefix));
}

export function validateManifestForSync(
  manifest: any,
  options?: {
    expectedTarget?: "client" | "server";
    expectedVersion?: string;
  }
): void {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Invalid manifest: expected a JSON object");
  }
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    throw new Error(`Invalid manifest: unsupported schemaVersion ${manifest.schemaVersion} (expected 1 or 2)`);
  }
  if (!manifest.pack || typeof manifest.pack !== "string" || manifest.pack.trim() === "") {
    throw new Error("Invalid manifest: 'pack' must be a non-empty string");
  }
  if (!manifest.version || typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("Invalid manifest: 'version' must be a non-empty string");
  }
  if (options?.expectedVersion && manifest.version !== options.expectedVersion) {
    throw new Error(`Manifest version mismatch: expected '${options.expectedVersion}', got '${manifest.version}'`);
  }
  if (manifest.target !== "client" && manifest.target !== "server") {
    throw new Error(`Invalid manifest target '${manifest.target}': must be 'client' or 'server'`);
  }
  if (options?.expectedTarget && manifest.target !== options.expectedTarget) {
    throw new Error(`Manifest target mismatch: expected '${options.expectedTarget}', got '${manifest.target}'`);
  }
  if (!manifest.minecraft || typeof manifest.minecraft !== "string") {
    throw new Error("Invalid manifest: 'minecraft' version is required");
  }
  if (!manifest.loader || typeof manifest.loader !== "object" || manifest.loader.type !== "fabric" || !manifest.loader.version) {
    throw new Error("Invalid manifest: 'loader' must be a valid Fabric configuration");
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error("Invalid manifest: 'files' must be an array");
  }

  const seenPaths = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file !== "object") {
      throw new Error("Invalid manifest: file entry must be an object");
    }
    if (!file.path || typeof file.path !== "string") {
      throw new Error("Invalid manifest: file entry missing 'path'");
    }
    if (!isSafeRelativePath(file.path)) {
      throw new Error(`Unsafe relative path in manifest: '${file.path}'`);
    }
    if (seenPaths.has(file.path)) {
      throw new Error(`Duplicate file path in manifest: '${file.path}'`);
    }
    seenPaths.add(file.path);

    const validPolicies = new Set(["MANAGED", "PRESERVE", "OPTIONAL", "GENERATED"]);
    if (!validPolicies.has(file.policy)) {
      throw new Error(`Invalid file policy '${file.policy}' for '${file.path}' (must be MANAGED, PRESERVE, OPTIONAL, or GENERATED)`);
    }

    if (isPathProtected(manifest.target, file.path) && file.policy === "MANAGED") {
      throw new Error(`${manifest.target === "server" ? "Server" : "Client"} manifest attempts to manage protected path '${file.path}'`);
    }

    if (typeof file.size !== "number" || file.size < 0) {
      throw new Error(`Invalid size for file '${file.path}': must be a non-negative number`);
    }

    const sha256 = file.hashes?.sha256;
    if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
      throw new Error(`Invalid or missing SHA-256 hash for file '${file.path}'`);
    }

    if (!file.download || typeof file.download.url !== "string" || file.download.url.trim() === "") {
      throw new Error(`Missing or empty download URL for file '${file.path}'`);
    }
  }

  if (manifest.resourcePack) {
    const srp = manifest.resourcePack;
    if (!srp.artifact || typeof srp.artifact !== "string") {
      throw new Error("Invalid server resourcePack: missing 'artifact' identifier");
    }
    if (typeof srp.required !== "boolean") {
      throw new Error("Invalid server resourcePack: 'required' must be a boolean");
    }
    if (!Number.isSafeInteger(srp.size) || srp.size < 0) {
      throw new Error("Invalid server resourcePack: 'size' must be a non-negative integer");
    }
    if (!srp.url || typeof srp.url !== "string") {
      throw new Error("Invalid server resourcePack: missing 'url'");
    }
    if (!srp.sha256 || !/^[0-9a-f]{64}$/i.test(srp.sha256)) {
      throw new Error("Invalid server resourcePack: invalid or missing SHA-256 hash");
    }
    if (!srp.sha1 || !/^[0-9a-f]{40}$/i.test(srp.sha1)) {
      throw new Error("Invalid server resourcePack: SHA-1 is required and must be 40 hex characters");
    }
    const packId = srp.id || srp.uuid;
    if (packId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(packId)) {
      throw new Error(`Invalid server resourcePack ID '${packId}': expected valid UUID`);
    }
    if (srp.prompt) {
      try {
        JSON.parse(formatPromptJson(srp.prompt));
      } catch {
        throw new Error("Invalid server resourcePack prompt: must be valid JSON text component");
      }
    }
  }
}

export async function syncInstance(options: SyncOptions): Promise<InstallationState> {
  const manifest = options.manifest || readJsonFile<PackManifest>(options.manifestPath!);
  if (!manifest) {
    throw new Error("syncInstance requires either 'manifest' or 'manifestPath'.");
  }
  validateManifestForSync(manifest);

  const targetDir = path.resolve(options.targetDir);
  ensureDir(targetDir);

  const stateDir = path.join(targetDir, ".lampas");
  const stateFile = path.join(stateDir, "installation.json");
  const cacheDir = path.join(stateDir, "cache", "sha256");
  ensureDir(cacheDir);

  let prevState: InstallationState = {
    pack: manifest.pack,
    version: "0.0.0",
    installedAt: new Date().toISOString(),
    files: {},
  };

  if (fs.existsSync(stateFile)) {
    try {
      prevState = readJsonFile<InstallationState>(stateFile);
    } catch {
      // fresh or corrupted state
    }
  }

  console.log(`[Sync] Synchronizing ${manifest.pack} (${manifest.target}) v${manifest.version} to: ${targetDir}`);

  const desiredFilesMap = new Map<string, ManifestFile>();
  for (const f of manifest.files) {
    desiredFilesMap.set(f.path, f);
  }

  const toDownload: ManifestFile[] = [];
  const toKeep: string[] = [];
  const verifiedAt = new Map<string, string>();

  for (const file of manifest.files) {
    const localPath = path.join(targetDir, file.path);

    if (file.policy === "PRESERVE" || isPathProtected(manifest.target, file.path)) {
      if (fs.existsSync(localPath)) {
        toKeep.push(file.path);
        continue;
      }
    }

    if (fs.existsSync(localPath)) {
      const stat = fs.statSync(localPath);
      const previous = prevState.files[file.path];
      const metadataMatches =
        options.verificationMode !== "full" &&
        previous?.sha256 === file.hashes.sha256 &&
        previous.size === file.size &&
        previous.mtimeMs === stat.mtimeMs &&
        stat.size === file.size;

      if (metadataMatches) {
        toKeep.push(file.path);
        continue;
      }

      const hashes = await computeFileHashesStreaming(localPath);
      if (hashes.sha256 === file.hashes.sha256) {
        toKeep.push(file.path);
        verifiedAt.set(file.path, new Date().toISOString());
        continue;
      }
    }

    toDownload.push(file);
  }

  // Identify obsolete managed files from previous installation AND unmanifested mods on disk
  const toDeleteSet = new Set<string>();
  for (const [prevPath, info] of Object.entries(prevState.files)) {
    if (info.policy === "MANAGED" && !desiredFilesMap.has(prevPath) && !isPathProtected(manifest.target, prevPath)) {
      toDeleteSet.add(prevPath);
    }
  }

  // Direct disk reconciliation: scan mods/ directory for any unmanifested JAR files
  const modsDir = path.join(targetDir, "mods");
  if (fs.existsSync(modsDir)) {
    try {
      const diskFiles = fs.readdirSync(modsDir);
      for (const file of diskFiles) {
        if (file.endsWith(".jar")) {
          const relModPath = `mods/${file}`;
          if (!desiredFilesMap.has(relModPath) && !isPathProtected(manifest.target, relModPath)) {
            toDeleteSet.add(relModPath);
          }
        }
      }
    } catch {
      // ignore read error
    }
  }

  const toDelete = Array.from(toDeleteSet);

  console.log(`[Sync] Plan: ${toDownload.length} to download, ${toKeep.length} already up-to-date, ${toDelete.length} obsolete to remove.`);

  // Perform world backup if requested and mutations are planned
  if (options.backupWorld) {
    const hasMutations = toDownload.length > 0 || toDelete.length > 0 || manifest.version !== prevState.version;
    if (hasMutations) {
      await backupDirectory({
        source: path.join(targetDir, "world"),
        destinationRoot: path.join(targetDir, ".backups"),
        label: "world",
      });
    }
  }

  // Download needed files
  const concurrency = options.concurrency || 6;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < toDownload.length) {
      const file = toDownload[nextIndex++];
      if (!file) break;

      let downloadUrl = file.download.url;
      if (downloadUrl.startsWith("/") && options.portalBaseUrl) {
        downloadUrl = `${options.portalBaseUrl}${downloadUrl}`;
      }

      // Check blob cache first
      const cachePath = blobCachePath(cacheDir, file.hashes.sha256);
      if (fs.existsSync(cachePath)) {
        const hashes = await computeFileHashesStreaming(cachePath);
        if (hashes.sha256 === file.hashes.sha256) {
          verifiedAt.set(file.path, new Date().toISOString());
          console.log(`  ⚡ [Cache Hit] ${file.path}`);
          continue;
        }
        await fs.promises.rm(cachePath, { force: true });
      }

      if (downloadUrl.startsWith("/")) {
        if (options.portalBaseUrl) {
          downloadUrl = `${options.portalBaseUrl}${downloadUrl}`;
          console.log(`  ↓ [Downloading Blob] ${file.path}...`);
          await downloadFileVerified(downloadUrl, cachePath, {
            expectedHash: file.hashes.sha256,
            expectedSize: file.size,
            headers: { "User-Agent": "Lampas-Launcher/1.0" },
          });
        } else {
          // Local fallback: search in pack/
          const candidatePaths = [
            path.resolve("pack", "common", file.path),
            path.resolve("pack", "client", file.path),
            path.resolve("pack", "server", file.path),
            path.resolve("pack", "custom", path.basename(file.path)),
          ];

          const foundPath = candidatePaths.find((p) => fs.existsSync(p));
          if (!foundPath) {
            throw new Error(`Local blob source for ${file.path} not found in pack/ directories. Provide --portal URL.`);
          }
          await copyFileVerified(foundPath, cachePath, {
            expectedHash: file.hashes.sha256,
            expectedSize: file.size,
          });
        }
      } else {
        console.log(`  ↓ [Downloading] ${file.path}...`);
        await downloadFileVerified(downloadUrl, cachePath, {
          expectedHash: file.hashes.sha256,
          expectedSize: file.size,
          headers: { "User-Agent": "Lampas-Launcher/1.0" },
        });
      }

      verifiedAt.set(file.path, new Date().toISOString());
      console.log(`  ✓ [Downloaded] ${file.path} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, toDownload.length) }, () => worker());
  await Promise.all(workers);

  // Take rollback snapshot before modifying files on disk
  if (options.tx) {
    await options.tx.snapshot({ toDownload, toDelete });
  }

  // Apply only after every artifact is present and verified in the cache.
  for (const file of toDownload) {
    const fullPath = path.join(targetDir, file.path);
    if (!fs.existsSync(fullPath) && options.tx) {
      await options.tx.recordNewFile(file.path);
    }
    const cachePath = blobCachePath(cacheDir, file.hashes.sha256);
    await copyFileAtomic(cachePath, fullPath);
  }

  // Delete obsolete managed files
  for (const relPath of toDelete) {
    const fullPath = path.join(targetDir, relPath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      console.log(`  🗑 [Deleted Obsolete] ${relPath}`);
    }
  }

  // Apply server-side resource pack configuration to server.properties
  if (manifest.target === "server") {
    if (manifest.resourcePack) {
      applyServerResourcePackProperties(targetDir, manifest.resourcePack);
    } else if (prevState.serverResourcePack?.managed) {
      // Clear/reset managed properties
      resetServerResourcePackProperties(targetDir);
    }
  }

  // Final verification pass before writing installation state
  for (const file of manifest.files) {
    if (file.policy === "MANAGED") {
      const localPath = path.join(targetDir, file.path);
      if (!fs.existsSync(localPath)) {
        throw new Error(`Final verification failed: managed file '${file.path}' is missing on disk.`);
      }
      const stat = fs.statSync(localPath);
      if (typeof file.size === "number" && stat.size !== file.size) {
        throw new Error(`Final verification failed: size mismatch for '${file.path}' (expected ${file.size}, got ${stat.size})`);
      }
      const wasDownloaded = toDownload.some((f) => f.path === file.path);
      if (options.verificationMode === "full" || wasDownloaded) {
        const hashes = await computeFileHashesStreaming(localPath);
        if (hashes.sha256.toLowerCase() !== file.hashes.sha256.toLowerCase()) {
          throw new Error(`Final verification failed: SHA-256 mismatch for '${file.path}' (expected ${file.hashes.sha256}, got ${hashes.sha256})`);
        }
      }
    }
  }

  if (manifest.target === "server") {
    const props = readServerPropertiesMap(targetDir);
    if (manifest.resourcePack) {
      const srp = manifest.resourcePack;
      if (props["resource-pack"] !== srp.url) {
        throw new Error(`Final verification failed: server.properties 'resource-pack' mismatch (expected '${srp.url}', got '${props["resource-pack"]}')`);
      }
      if (props["resource-pack-sha1"] !== (srp.sha1 || "")) {
        throw new Error(`Final verification failed: server.properties 'resource-pack-sha1' mismatch (expected '${srp.sha1 || ""}', got '${props["resource-pack-sha1"]}')`);
      }
      const expectedId = srp.id || srp.uuid || "";
      if (props["resource-pack-id"] !== expectedId) {
        throw new Error(`Final verification failed: server.properties 'resource-pack-id' mismatch (expected '${expectedId}', got '${props["resource-pack-id"]}')`);
      }
      const expectedPrompt = srp.prompt ? formatPromptJson(srp.prompt) : "";
      if (props["resource-pack-prompt"] !== expectedPrompt) {
        throw new Error(`Final verification failed: server.properties 'resource-pack-prompt' mismatch (expected '${expectedPrompt}', got '${props["resource-pack-prompt"]}')`);
      }
      const expectedReq = String(srp.required ?? true).toLowerCase();
      if (props["require-resource-pack"] !== expectedReq) {
        throw new Error(`Final verification failed: server.properties 'require-resource-pack' mismatch (expected '${expectedReq}', got '${props["require-resource-pack"]}')`);
      }
    } else if (prevState.serverResourcePack?.managed) {
      if (props["resource-pack"] && props["resource-pack"] !== "") {
        throw new Error(`Final verification failed: server.properties 'resource-pack' was not cleared on pack removal`);
      }
      if (props["resource-pack-sha1"] && props["resource-pack-sha1"] !== "") {
        throw new Error(`Final verification failed: server.properties 'resource-pack-sha1' was not cleared on pack removal`);
      }
      if (props["resource-pack-id"] && props["resource-pack-id"] !== "") {
        throw new Error(`Final verification failed: server.properties 'resource-pack-id' was not cleared on pack removal`);
      }
      if (props["resource-pack-prompt"] && props["resource-pack-prompt"] !== "") {
        throw new Error(`Final verification failed: server.properties 'resource-pack-prompt' was not cleared on pack removal`);
      }
      if (props["require-resource-pack"] && props["require-resource-pack"].toLowerCase() !== "false") {
        throw new Error(`Final verification failed: server.properties 'require-resource-pack' was not reset to false on pack removal`);
      }
    }
  }

  // Update installation state LAST (only after all mutations & verification succeed)
  const newState: InstallationState = {
    pack: manifest.pack,
    version: manifest.version,
    installedAt: new Date().toISOString(),
    files: {},
  };

  if (options.runtime) {
    newState.runtime = options.runtime;
  } else if (prevState.runtime) {
    newState.runtime = prevState.runtime;
  }

  for (const file of manifest.files) {
    const filePath = path.join(targetDir, file.path);
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : undefined;
    const previous = prevState.files[file.path];
    newState.files[file.path] = {
      sha256: file.hashes.sha256,
      size: file.size,
      policy: file.policy,
      mtimeMs: stat?.mtimeMs,
      verifiedAt: verifiedAt.get(file.path) || previous?.verifiedAt,
    };
  }

  if (manifest.target === "server" && manifest.resourcePack) {
    newState.serverResourcePack = {
      managed: true,
      artifact: manifest.resourcePack.artifact,
      url: manifest.resourcePack.url,
      sha1: manifest.resourcePack.sha1,
      sha256: manifest.resourcePack.sha256,
      id: manifest.resourcePack.id || manifest.resourcePack.uuid,
      required: manifest.resourcePack.required,
    };
  } else if (manifest.target === "server" && prevState.serverResourcePack?.managed) {
    newState.serverResourcePack = { managed: false };
  }

  if (!options.deferStateWrite) {
    writeJsonFile(stateFile, newState, true);
  }

  console.log(`\n[Sync Complete] Successfully synchronized ${manifest.pack} v${manifest.version}`);
  return newState;
}

export function readServerPropertiesMap(targetDir: string): Record<string, string> {
  const propsPath = path.join(targetDir, "server.properties");
  if (!fs.existsSync(propsPath)) return {};
  const content = fs.readFileSync(propsPath, "utf-8");
  const res: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("!") || !line.includes("=")) continue;
    const eqIdx = line.indexOf("=");
    const k = line.substring(0, eqIdx).trim();
    const v = line.substring(eqIdx + 1).trim();
    res[k] = v;
  }
  return res;
}

export function applyServerResourcePackProperties(
  targetDir: string,
  srp: { url: string; sha1?: string; required: boolean; prompt?: string; id?: string; uuid?: string }
): void {
  const propsPath = path.join(targetDir, "server.properties");
  let content = "";
  let eol = "\n";
  if (fs.existsSync(propsPath)) {
    const raw = fs.readFileSync(propsPath);
    if (raw.includes(Buffer.from("\r\n"))) {
      eol = "\r\n";
    }
    content = raw.toString("utf-8");

    // Backup existing server.properties
    const backupsDir = path.join(targetDir, ".lampas", "backups");
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    fs.copyFileSync(propsPath, path.join(backupsDir, `server.properties.${ts}`));
  }

  const lines = content ? content.split(/\r?\n/) : [];
  const keysToSet: Record<string, string> = {
    "resource-pack": srp.url,
    "resource-pack-sha1": srp.sha1 || "",
    "resource-pack-id": srp.id || srp.uuid || "",
    "resource-pack-prompt": srp.prompt ? formatPromptJson(srp.prompt) : "",
    "require-resource-pack": String(srp.required ?? true).toLowerCase(),
  };

  const seenKeys = new Set<string>();
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("!") || !trimmed.includes("=")) {
      return line;
    }
    const eqIdx = line.indexOf("=");
    const key = line.substring(0, eqIdx).trim();
    if (key in keysToSet) {
      seenKeys.add(key);
      return `${key}=${keysToSet[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(keysToSet)) {
    if (!seenKeys.has(key)) {
      newLines.push(`${key}=${value}`);
    }
  }

  const tmpPath = `${propsPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, newLines.join(eol) + eol, "utf-8");
  fs.renameSync(tmpPath, propsPath);
  console.log(`  ⚙ [Server Config] Configured resource-pack settings in server.properties`);
}

export function resetServerResourcePackProperties(targetDir: string): void {
  const propsPath = path.join(targetDir, "server.properties");
  if (!fs.existsSync(propsPath)) return;

  let eol = "\n";
  const raw = fs.readFileSync(propsPath);
  if (raw.includes(Buffer.from("\r\n"))) {
    eol = "\r\n";
  }
  const content = raw.toString("utf-8");

  // Backup existing server.properties
  const backupsDir = path.join(targetDir, ".lampas", "backups");
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  fs.copyFileSync(propsPath, path.join(backupsDir, `server.properties.${ts}`));

  const lines = content.split(/\r?\n/);
  const keysToReset: Record<string, string> = {
    "resource-pack": "",
    "resource-pack-sha1": "",
    "resource-pack-id": "",
    "resource-pack-prompt": "",
    "require-resource-pack": "false",
  };

  const seenKeys = new Set<string>();
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("!") || !trimmed.includes("=")) {
      return line;
    }
    const eqIdx = line.indexOf("=");
    const key = line.substring(0, eqIdx).trim();
    if (key in keysToReset) {
      seenKeys.add(key);
      return `${key}=${keysToReset[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(keysToReset)) {
    if (!seenKeys.has(key)) {
      newLines.push(`${key}=${value}`);
    }
  }

  const tmpPath = `${propsPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, newLines.join(eol) + eol, "utf-8");
  fs.renameSync(tmpPath, propsPath);
  console.log(`  ⚙ [Server Config] Reset Lampas resource-pack settings in server.properties`);
}

export async function deployServer(options: DeployOptions): Promise<void> {
  const portalUrl = options.portalUrl || process.env.PORTAL_URL || "https://dev.lampas.town";
  const { version, release, manifest } = await resolveRelease({
    portalUrl,
    channel: options.channel || (options.version ? undefined : "dev"),
    version: options.version,
    target: "server",
  });

  validateManifestForSync(manifest, {
    expectedTarget: "server",
    expectedVersion: version,
  });

  // Cross-validate release descriptor and server manifest runtime
  if (release) {
    if (release.minecraft !== manifest.minecraft) {
      throw new Error(
        `Release Minecraft version mismatch: release requires '${release.minecraft}', server manifest requires '${manifest.minecraft}'`
      );
    }
    if (
      release.loader?.type !== manifest.loader?.type ||
      release.loader?.version !== manifest.loader?.version
    ) {
      throw new Error(
        `Invalid Lampas release: release descriptor requires Fabric ${release.loader?.version}, server manifest requires Fabric ${manifest.loader?.version}.`
      );
    }
  }

  const runtime = validateRuntimeDefinition(manifest.minecraft, manifest.loader);
  const targetDir = path.resolve(options.targetDir);
  console.log(`[Deploy] Target Minecraft server directory: ${targetDir}`);
  console.log(`[Deploy] Deploying ${manifest.pack} v${manifest.version}...`);

  // Recover interrupted transaction if one exists
  await DeploymentTransaction.recoverIfInterrupted(targetDir);

  // Stage Fabric server runtime before any server pack mutation
  const stagedRuntime = await prepareFabricServerRuntime({
    targetDir,
    minecraft: runtime.minecraft,
    loaderVersion: runtime.loader.version,
    installerVersion: options.installerVersion,
    verificationMode: options.verificationMode,
    fabricMetaUrl: options.fabricMetaUrl,
    fetchFn: options.fetchFn,
  });

  const tx = new DeploymentTransaction(targetDir);

  try {
    const newState = await syncInstance({
      manifest,
      targetDir,
      portalBaseUrl: portalUrl,
      verificationMode: options.verificationMode || "fast",
      backupWorld: options.backupWorld !== false,
      runtime: stagedRuntime.runtimeState,
      tx,
      deferStateWrite: true,
    });

    if (options._testHooks?.forceActivationFailure) {
      throw new Error("Forced runtime activation failure for test verification");
    }

    // Atomically activate runtime only after pack files are synced & verified
    await stagedRuntime.activate();

    // Write installation.json ONLY after runtime activation succeeds
    const stateFile = path.join(targetDir, ".lampas", "installation.json");
    writeJsonFile(stateFile, newState, true);

    // Commit transaction and cleanup rollback snapshot
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch((e) => console.error("Rollback error:", e));
    await stagedRuntime.cleanup().catch(() => {});
    throw err;
  }

  console.log(`\n[Deploy Complete] Successfully deployed ${manifest.pack} v${manifest.version} to ${targetDir}`);
}
