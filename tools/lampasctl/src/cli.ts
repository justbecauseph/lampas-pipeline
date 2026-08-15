import * as path from "node:path";
import * as fs from "node:fs";
import { importExistingMods } from "./importer";
import { resolvePack } from "./resolver";
import { validatePack } from "./validator";
import { buildManifests } from "./manifest";
import { syncInstance } from "./sync";
import { publishRelease } from "./publisher";
import { checkPackUpdates } from "./checker";
import { diffManifests } from "./diff";
import { addMod, removeMod } from "./manager";

function printUsage() {
  console.log(`
Lampas Modpack Distribution CLI (lampasctl)

Usage:
  lampasctl <command> [options]

Commands:
  add <slug|url|jar>    Add a mod to the pack and auto-update lockfile & manifests
    --side <side>       Target side: client | server | both (default: both)
    --version <id>      Pin a specific version ID (optional, defaults to latest compatible)
    --pack <path>       Pack directory (default: ./pack)

  remove <mod-id>       Remove a mod from the pack and auto-update manifests (alias: rm)
    --pack <path>       Pack directory (default: ./pack)

  resolve               Resolve pack definitions into pack.lock.json
    --pack <path>       Pack directory (default: ./pack)
    --lock <path>       Lockfile destination (default: ./pack/pack.lock.json)

  validate              Validate pack definitions, lockfile, and integrity
    --pack <path>       Pack directory (default: ./pack)
    --lock <path>       Lockfile destination (default: ./pack/pack.lock.json)

  manifest              Generate client-manifest.json and server-manifest.json
    --pack <path>       Pack directory (default: ./pack)
    --lock <path>       Lockfile destination (default: ./pack/pack.lock.json)
    --out <path>        Manifest output directory (default: ./manifest)

  publish               Publish release and upload blobs to Lampas Portal
    --portal <url>      Lampas Portal URL (e.g. http://localhost:3000)
    --secret <token>    Publish bearer secret token
    --channel <name>    Channel pointer to update (dev | beta | stable)
    --pack <path>       Pack directory (default: ./pack)
    --manifest <path>   Manifest directory (default: ./manifest)

  install               Synchronize a Minecraft instance directory to a manifest
    --manifest <path>   Path to client-manifest.json or server-manifest.json
    --target <path>     Target Minecraft instance directory
    --portal <url>      Lampas Portal base URL (optional)

  check-updates         Check Modrinth & CurseForge for newer upstream releases
    --pack <path>       Pack directory (default: ./pack)
    --apply             Automatically update TOML descriptors with latest version IDs
    --markdown <path>   Write markdown summary to file (useful for GitHub Actions / PRs)

  diff                  Compare two pack manifests for added/removed/updated mods & size delta
    --from <path>       Base manifest (e.g. previous release client-manifest.json)
    --to <path>         Target manifest (e.g. new release client-manifest.json)
    --markdown <path>   Write markdown diff to file

  import                Bootstrap pack definitions from existing mod folders
    --client <path>     Path to client mods folder
    --server <path>     Path to server mods folder
    --out <path>        Output directory for pack definitions (default: ./pack)

  help                  Show this help message
`);
}

function parseArgs(args: string[]): { command: string; positional: string[]; flags: Record<string, string> } {
  const command = args[0] || "help";
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.substring(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();

  try {
    switch (command) {
      case "add": {
        const query = positional[0] || flags.query;
        if (!query) {
          console.error("Error: Please specify a mod slug, project ID, Modrinth URL, or .jar file path.");
          console.log("Example: lampasctl add appleskin --side client");
          process.exit(1);
        }

        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        const side = (flags.side as "client" | "server" | "both") || "both";

        await addMod({
          packDir,
          query,
          side,
          versionId: flags.version,
        });
        break;
      }

      case "remove":
      case "rm": {
        const modId = positional[0] || flags.id;
        if (!modId) {
          console.error("Error: Please specify the mod ID to remove.");
          console.log("Example: lampasctl remove appleskin");
          process.exit(1);
        }

        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        await removeMod({
          packDir,
          modId,
        });
        break;
      }

      case "import": {
        const clientDir = flags.client;
        const serverDir = flags.server;
        const outDir = path.resolve(flags.out || path.join(rootDir, "pack"));
        const modsOutDir = path.join(outDir, "mods");
        const customModsDir = path.join(outDir, "custom");

        await importExistingMods({
          clientDir,
          serverDir,
          outDir: modsOutDir,
          customModsDir,
        });
        break;
      }

      case "resolve": {
        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        const lockFile = path.resolve(flags.lock || path.join(packDir, "pack.lock.json"));

        await resolvePack({ packDir, lockFile });
        break;
      }

      case "validate": {
        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        const lockFile = path.resolve(flags.lock || path.join(packDir, "pack.lock.json"));

        const passed = await validatePack({ packDir, lockFile });
        if (!passed) {
          process.exit(1);
        }
        break;
      }

      case "manifest": {
        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        const lockFile = path.resolve(flags.lock || path.join(packDir, "pack.lock.json"));
        const outDir = path.resolve(flags.out || path.join(rootDir, "manifest"));

        await buildManifests({ packDir, lockFile, outDir, portalBaseUrl: flags.portal });
        break;
      }

      case "publish": {
        const portalUrl = flags.portal || "http://localhost:3000";
        const publishSecret = flags.secret || process.env.PACK_PUBLISH_SECRET || "lampas-secret-key";
        const manifestDir = path.resolve(flags.manifest || path.join(rootDir, "manifest"));
        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        const channel = (flags.channel as "dev" | "beta" | "stable") || "stable";

        await publishRelease({
          manifestDir,
          packDir,
          portalUrl,
          publishSecret,
          channel,
        });
        break;
      }

      case "install": {
        const manifestPath = flags.manifest;
        const targetDir = flags.target;

        if (!manifestPath || !targetDir) {
          console.error("Error: --manifest and --target are required for 'install'");
          printUsage();
          process.exit(1);
        }

        await syncInstance({
          manifestPath: path.resolve(manifestPath),
          targetDir: path.resolve(targetDir),
          portalBaseUrl: flags.portal,
        });
        break;
      }

      case "check-updates": {
        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        const apply = flags.apply === "true";
        const markdownOut = flags.markdown ? path.resolve(flags.markdown) : undefined;

        await checkPackUpdates({
          packDir,
          apply,
          markdownOut,
        });
        break;
      }

      case "diff": {
        const fromManifest = flags.from;
        const toManifest = flags.to;
        const markdownOut = flags.markdown ? path.resolve(flags.markdown) : undefined;

        if (!fromManifest || !toManifest) {
          console.error("Error: --from and --to are required for 'diff'");
          printUsage();
          process.exit(1);
        }

        await diffManifests({
          fromManifestPath: path.resolve(fromManifest),
          toManifestPath: path.resolve(toManifest),
          markdownOut,
        });
        break;
      }

      case "help":
      default:
        printUsage();
        break;
    }
  } catch (err: any) {
    console.error(`\n[lampasctl Error] ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
