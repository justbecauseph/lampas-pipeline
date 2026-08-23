import * as path from "node:path";
import * as fs from "node:fs";
import { addMod } from "../../../../tools/lampasctl/src/manager";
import { validatePack } from "../../../../tools/lampasctl/src/validator";

function printUsage() {
  console.log(`
Install Modrinth Mod Tool

Usage:
  bun run .agents/skills/install-modrinth-mods/scripts/install-modrinth.ts <query> [options]

Arguments:
  <query>                       Modrinth slug, project ID, version URL, or slug@version (e.g. sodium, appleskin@2.5.1)

Options:
  -s, --side <client|server|both>   Target distribution side (default: auto-detect from Modrinth)
  -v, --version <version>           Specific version number or Modrinth version ID
  -p, --pack <path>                 Pack directory path (default: ./pack)
  --skip-validate                   Skip Fabric metadata and JiJ validation check

Examples:
  bun run .agents/skills/install-modrinth-mods/scripts/install-modrinth.ts sodium --side client
  bun run .agents/skills/install-modrinth-mods/scripts/install-modrinth.ts appleskin --version 2.5.1
  bun run .agents/skills/install-modrinth-mods/scripts/install-modrinth.ts https://modrinth.com/mod/ferrite-core
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  let query = "";
  let side: "client" | "server" | "both" | undefined = undefined;
  let versionId: string | undefined = undefined;
  let packDir = path.resolve(process.cwd(), "pack");
  let skipValidate = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-s" || arg === "--side") && args[i + 1]) {
      side = args[++i] as any;
    } else if ((arg === "-v" || arg === "--version") && args[i + 1]) {
      versionId = args[++i];
    } else if ((arg === "-p" || arg === "--pack") && args[i + 1]) {
      packDir = path.resolve(args[++i]);
    } else if (arg === "--skip-validate") {
      skipValidate = true;
    } else if (!arg.startsWith("-")) {
      query = arg;
    }
  }

  if (!query) {
    console.error("❌ Error: Please specify a mod slug, project ID, or Modrinth URL.");
    process.exit(1);
  }

  if (side && !["client", "server", "both"].includes(side)) {
    console.error(`❌ Error: Invalid side '${side}'. Must be 'client', 'server', or 'both'.`);
    process.exit(1);
  }

  console.log("=================================================");
  console.log("⚡ Installing Modrinth Mod into Lampas Modpack");
  console.log("=================================================");
  console.log(`Query:       ${query}`);
  console.log(`Side:        ${side || "auto-detect"}`);
  console.log(`Version:     ${versionId || "latest-compatible"}`);
  console.log(`Pack Dir:    ${packDir}\n`);

  // Step 1: Add Modrinth mod (fetches metadata, writes TOML, resolves deps, updates lockfile and manifests)
  await addMod({
    packDir,
    query,
    side,
    provider: "modrinth",
    versionId,
  });

  // Step 2: Validate pack
  if (!skipValidate) {
    console.log("\n🔍 Validating pack metadata and dependency constraints...");
    const lockFile = path.join(packDir, "pack.lock.json");
    const passed = await validatePack({ packDir, lockFile });
    if (!passed) {
      console.warn("⚠️ Warning: Pack validation reported issues. Review the logs above.");
    }
  }

  console.log("\n🎉 Modrinth installation and manifest synchronization completed successfully!");
}

main().catch((err) => {
  console.error("\n❌ [Install Modrinth Mod Error]:", err.message || err);
  process.exit(1);
});
