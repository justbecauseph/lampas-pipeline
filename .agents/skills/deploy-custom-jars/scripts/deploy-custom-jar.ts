import * as path from "node:path";
import * as fs from "node:fs";
import { addMod } from "../../../../tools/lampasctl/src/manager";
import { resolvePack } from "../../../../tools/lampasctl/src/resolver";
import { validatePack } from "../../../../tools/lampasctl/src/validator";
import { buildManifests } from "../../../../tools/lampasctl/src/manifest";

function printUsage() {
  console.log(`
Deploy Custom JAR Tool

Usage:
  bun run .agents/skills/deploy-custom-jars/scripts/deploy-custom-jar.ts <path-to-jar> [options]

Options:
  --side <client|server|both>   Distribution target (default: both)
  --name <display-name>         Human-readable mod title (defaults to jar filename)
  --pack <path>                 Pack directory (default: ./pack)
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  let jarPath = "";
  let side: "client" | "server" | "both" = "both";
  let packDir = path.resolve(process.cwd(), "pack");

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--side" && args[i + 1]) {
      side = args[++i] as any;
    } else if (arg === "--pack" && args[i + 1]) {
      packDir = path.resolve(args[++i]);
    } else if (!arg.startsWith("-")) {
      jarPath = path.resolve(arg);
    }
  }

  if (!jarPath || !fs.existsSync(jarPath)) {
    console.error(`❌ Error: JAR file not found at: ${jarPath}`);
    process.exit(1);
  }

  if (!["client", "server", "both"].includes(side)) {
    console.error(`❌ Error: Invalid side '${side}'. Must be 'client', 'server', or 'both'.`);
    process.exit(1);
  }

  console.log("=================================================");
  console.log("⚡ Deploying Custom JAR to Lampas Modpack");
  console.log("=================================================");
  console.log(`Source JAR: ${jarPath}`);
  console.log(`Target Side: ${side}`);
  console.log(`Pack Dir:   ${packDir}\n`);

  // Step 1: Add mod to pack
  console.log("📦 [1/4] Copying JAR to pack/custom and creating mod definition...");
  await addMod({
    packDir,
    query: jarPath,
    side,
  });

  // Step 2: Validate pack integrity
  console.log("\n🔍 [2/4] Validating pack integrity and fabric metadata...");
  const lockFile = path.join(packDir, "pack.lock.json");
  const isValid = await validatePack({ packDir, lockFile });
  if (!isValid) {
    throw new Error("Pack validation failed! Check for metadata or dependency errors.");
  }

  // Step 3: Dual Manifest Generation
  console.log("\n📑 [3/4] Generating manifests for localhost:3000 and https://dev.portal.town...");
  const rootDir = path.dirname(packDir);
  
  // Localhost
  const localOut = path.join(rootDir, "manifest/localhost");
  await buildManifests({
    packDir,
    lockFile,
    outDir: localOut,
    portalBaseUrl: "http://localhost:3000",
  });
  console.log(`  ✓ Localhost manifests -> ${localOut}`);

  // Dev Portal
  const devOut = path.join(rootDir, "manifest/dev");
  await buildManifests({
    packDir,
    lockFile,
    outDir: devOut,
    portalBaseUrl: "https://dev.portal.town",
  });
  console.log(`  ✓ Dev portal manifests -> ${devOut}`);

  // Root manifest
  const rootOut = path.join(rootDir, "manifest");
  await buildManifests({
    packDir,
    lockFile,
    outDir: rootOut,
    portalBaseUrl: "https://dev.portal.town",
  });
  console.log(`  ✓ Default root manifests -> ${rootOut}`);

  console.log("\n🎉 [4/4] Custom JAR deployed and dual manifests generated successfully!");
}

main().catch((err) => {
  console.error("\n❌ [Deploy Custom JAR Error]:", err.message || err);
  process.exit(1);
});
