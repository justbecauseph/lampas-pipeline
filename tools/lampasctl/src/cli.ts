import { buildManifests } from "./manifest";
import { syncInstance } from "./sync";
import { publishRelease } from "./publisher";

function printUsage() {
  console.log(`
Lampas Modpack Distribution CLI (lampasctl)

Usage:
  lampasctl <command> [options]

Commands:
  import                Bootstrap pack definitions from existing mod folders
    --client <path>     Path to client mods folder
    --server <path>     Path to server mods folder
    --out <path>        Output directory for pack definitions (default: ./pack)

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

  help                  Show this help message
`);
}

function parseArgs(args: string[]): { command: string; flags: Record<string, string> } {
  const command = args[0] || "help";
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
    }
  }

  return { command, flags };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();

  try {
    switch (command) {
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
