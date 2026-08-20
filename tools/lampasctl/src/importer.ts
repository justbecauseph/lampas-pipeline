import * as fs from "node:fs";
import * as path from "node:path";
import { computeFileHashesStreaming, inspectJar, writeTomlFile, ensureDir } from "./utils";
import { ModrinthClient } from "./providers";
import type { ModDefinition, Side } from "./types";

export interface ImportOptions {
  clientDir?: string;
  serverDir?: string;
  outDir: string;
  customModsDir: string;
}

export interface DiscoveredJar {
  filename: string;
  clientPath?: string;
  serverPath?: string;
  side: Side;
  sha512: string;
  sha1: string;
  sha256: string;
  size: number;
  modId?: string;
  modName?: string;
}

export async function importExistingMods(options: ImportOptions): Promise<void> {
  const clientJars = new Map<string, string>();
  const serverJars = new Map<string, string>();

  if (options.clientDir && fs.existsSync(options.clientDir)) {
    const files = fs.readdirSync(options.clientDir);
    for (const f of files) {
      if (f.toLowerCase().endsWith(".jar")) {
        clientJars.set(f, path.join(options.clientDir, f));
      }
    }
  }

  if (options.serverDir && fs.existsSync(options.serverDir)) {
    const files = fs.readdirSync(options.serverDir);
    for (const f of files) {
      if (f.toLowerCase().endsWith(".jar")) {
        serverJars.set(f, path.join(options.serverDir, f));
      }
    }
  }

  console.log(`[Import] Found ${clientJars.size} client JARs and ${serverJars.size} server JARs.`);

  const allFilenames = new Set([...clientJars.keys(), ...serverJars.keys()]);
  const discovered: DiscoveredJar[] = [];

  for (const filename of allFilenames) {
    const inClient = clientJars.has(filename);
    const inServer = serverJars.has(filename);
    const side: Side = inClient && inServer ? "both" : inClient ? "client" : "server";
    const samplePath = inClient ? clientJars.get(filename)! : serverJars.get(filename)!;

    const hashes = await computeFileHashesStreaming(samplePath);
    const meta = inspectJar(samplePath);

    discovered.push({
      filename,
      clientPath: clientJars.get(filename),
      serverPath: serverJars.get(filename),
      side,
      sha512: hashes.sha512,
      sha1: hashes.sha1,
      sha256: hashes.sha256,
      size: hashes.size,
      modId: meta.fabricMod?.id,
      modName: meta.fabricMod?.name,
    });
  }

  console.log(`[Import] Total unique JARs to resolve: ${discovered.length}`);

  // Query Modrinth in batches of 50
  const sha512List = discovered.map((d) => d.sha512);
  const batchSize = 50;
  const modrinthMap: Record<string, any> = {};

  for (let i = 0; i < sha512List.length; i += batchSize) {
    const batch = sha512List.slice(i, i + batchSize);
    console.log(`[Import] Querying Modrinth for batch ${i / batchSize + 1}/${Math.ceil(sha512List.length / batchSize)}...`);
    const results = await ModrinthClient.getVersionsByHashes(batch, "sha512");
    Object.assign(modrinthMap, results);
  }

  // Also try sha1 for anything not found by sha512
  const notFoundSha512 = discovered.filter((d) => !modrinthMap[d.sha512]);
  if (notFoundSha512.length > 0) {
    console.log(`[Import] Trying SHA-1 lookup for ${notFoundSha512.length} unmatched JARs...`);
    const sha1List = notFoundSha512.map((d) => d.sha1);
    for (let i = 0; i < sha1List.length; i += batchSize) {
      const batch = sha1List.slice(i, i + batchSize);
      const results = await ModrinthClient.getVersionsByHashes(batch, "sha1");
      for (const [sha1, ver] of Object.entries(results)) {
        const item = discovered.find((d) => d.sha1 === sha1);
        if (item) {
          modrinthMap[item.sha512] = ver;
        }
      }
    }
  }

  ensureDir(options.outDir);
  ensureDir(options.customModsDir);

  let modrinthCount = 0;
  let customCount = 0;

  for (const jar of discovered) {
    const version = modrinthMap[jar.sha512];

    if (version) {
      modrinthCount++;
      const modSlug = jar.modId || path.basename(jar.filename, ".jar").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const outPath = path.join(options.outDir, `${modSlug}.toml`);

      const def: ModDefinition = {
        name: jar.modName || version.name || jar.filename,
        side: jar.side,
        provider: {
          type: "modrinth",
          project_id: version.project_id,
          version_id: version.id,
        },
      };

      writeTomlFile(outPath, def as unknown as Record<string, unknown>);
      console.log(`  ✓ [Modrinth] ${jar.filename} -> ${modSlug}.toml (${jar.side})`);
    } else {
      customCount++;
      const modSlug = jar.modId || path.basename(jar.filename, ".jar").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const samplePath = jar.clientPath || jar.serverPath!;
      const destPath = path.join(options.customModsDir, jar.filename);

      fs.copyFileSync(samplePath, destPath);

      const outPath = path.join(options.outDir, `${modSlug}.toml`);
      const def: ModDefinition = {
        name: jar.modName || jar.filename,
        side: jar.side,
        provider: {
          type: "lampas",
          file: `custom/${jar.filename}`,
        },
      };

      writeTomlFile(outPath, def as unknown as Record<string, unknown>);
      console.log(`  ★ [Lampas Custom] ${jar.filename} -> custom/${jar.filename} & ${modSlug}.toml (${jar.side})`);
    }
  }

  console.log("\n========================================================");
  console.log(`[Import Complete] Generated ${discovered.length} mod definitions.`);
  console.log(`  - Modrinth resolved: ${modrinthCount}`);
  console.log(`  - Lampas custom/local: ${customCount}`);
  console.log("========================================================\n");
}
