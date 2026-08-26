import * as path from "node:path";
import * as fs from "node:fs";
import { buildManifests } from "../../../../tools/lampasctl/src/manifest";

interface TargetEnv {
  name: string;
  portalUrl: string;
  outDir: string;
}

const TARGET_ENVIRONMENTS: TargetEnv[] = [
  {
    name: "Localhost Development",
    portalUrl: "http://localhost:3000",
    outDir: path.resolve(process.cwd(), "manifest/localhost"),
  },
  {
    name: "Dev Portal Cloud",
    portalUrl: "https://dev.lampas.town",
    outDir: path.resolve(process.cwd(), "manifest/dev"),
  },
];

async function main() {
  const rootDir = process.cwd();
  const packDir = path.resolve(rootDir, "pack");
  const lockFile = path.resolve(packDir, "pack.lock.json");
  const defaultManifestDir = path.resolve(rootDir, "manifest");

  console.log("=================================================");
  console.log("⚡ Lampas Dual Manifest Generation");
  console.log("=================================================");
  console.log(`Pack Directory: ${packDir}`);
  console.log(`Lockfile:       ${lockFile}\n`);

  if (!fs.existsSync(lockFile)) {
    throw new Error(`Lockfile not found at ${lockFile}. Please run 'bun run lampasctl resolve' first.`);
  }

  for (const env of TARGET_ENVIRONMENTS) {
    console.log(`\n📦 Generating manifests for [${env.name}] (${env.portalUrl})...`);
    if (!fs.existsSync(env.outDir)) {
      fs.mkdirSync(env.outDir, { recursive: true });
    }

    const { clientManifest, serverManifest, release } = await buildManifests({
      packDir,
      lockFile,
      outDir: env.outDir,
      portalBaseUrl: env.portalUrl,
    });

    console.log(`  ✓ Written to: ${env.outDir}`);
    console.log(`    • Client Manifest: ${clientManifest.files.length} files`);
    console.log(`    • Server Manifest: ${serverManifest.files.length} files`);
    console.log(`    • Release Pointer: ${release.clientManifest}`);
  }

  // Also update root manifest/ with default dev portal URL for repo consistency
  console.log(`\n📦 Updating root manifest directory (default dev portal: https://dev.lampas.town)...`);
  await buildManifests({
    packDir,
    lockFile,
    outDir: defaultManifestDir,
    portalBaseUrl: "https://dev.lampas.town",
  });
  console.log(`  ✓ Written to: ${defaultManifestDir}`);

  console.log("\n✨ Dual manifest generation complete for localhost:3000 and https://dev.lampas.town!");
}

main().catch((err) => {
  console.error("\n❌ [Dual Manifest Error]:", err.message || err);
  process.exit(1);
});
