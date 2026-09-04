import * as path from "node:path";
import * as fs from "node:fs";
import { importExistingMods } from "./importer";
import { resolvePack } from "./resolver";
import { validatePack } from "./validator";
import { buildManifests } from "./manifest";
import { deployServer, syncInstance } from "./sync";
import { DeploymentTransaction } from "./transaction";
import { publishRelease } from "./publisher";
import { checkPackUpdates } from "./checker";
import { diffManifests } from "./diff";
import { addMod, removeMod } from "./manager";
import { enrichPackLock } from "./enricher";

declare const LAMPASCTL_VERSION: string | undefined;

export function getLampasctlVersion(): string {
  if (typeof LAMPASCTL_VERSION !== "undefined" && LAMPASCTL_VERSION) {
    return LAMPASCTL_VERSION;
  }
  return process.env.LAMPASCTL_VERSION || "dev";
}

function printUsage() {
  console.log(`
Lampas Modpack Distribution CLI (lampasctl v${getLampasctlVersion()})

Usage:
  lampasctl <command> [options]

Commands:
  version               Show lampasctl version (aliases: -v, --version)
  add <slug|url|jar>    Add a mod to the pack and auto-update lockfile & manifests
                        Supports:
                          lampasctl add appleskin
                          lampasctl add appleskin --version 2.5.1
                          lampasctl add appleskin@2.5.1
                          lampasctl add https://modrinth.com/mod/appleskin/version/mc1.21-2.5.1
                          lampasctl add https://www.curseforge.com/minecraft/mc-mods/appleskin
                          lampasctl add appleskin --provider curseforge
    -s, --side <side>   Target side: client | server | both (default: both)
    -v, --version <ver> Pin a Modrinth version or numeric CurseForge file ID
    --provider <name>   Source for slugs/IDs: modrinth | curseforge (default: modrinth)
    -p, --pack <path>   Pack directory (default: ./pack)

  remove <mod-id>       Remove a mod from the pack and auto-update manifests (alias: rm)
    -p, --pack <path>   Pack directory (default: ./pack)

  resolve               Resolve pack definitions into pack.lock.json
    -p, --pack <path>   Pack directory (default: ./pack)
    -l, --lock <path>   Lockfile destination (default: ./pack/pack.lock.json)

  validate              Validate pack definitions, lockfile, and integrity
    -p, --pack <path>   Pack directory (default: ./pack)
    -l, --lock <path>   Lockfile destination (default: ./pack/pack.lock.json)
    --skip-meta-check   Skip upstream Fabric Meta compatibility verification

  manifest              Generate client-manifest.json and server-manifest.json
    -p, --pack <path>   Pack directory (default: ./pack)
    -l, --lock <path>   Lockfile destination (default: ./pack/pack.lock.json)
    -o, --out <path>    Manifest output directory (default: ./manifest)
    --skip-meta-check   Skip upstream Fabric Meta compatibility verification

  publish               Publish release and upload blobs to Lampas Portal
    --portal <url>      Lampas Portal URL (e.g. http://localhost:3000)
    --secret <token>    Publish bearer secret token
    --channel <name>    Channel pointer to update (dev | beta | stable, or all if omitted)
    -p, --pack <path>   Pack directory (default: ./pack)
    -m, --manifest <p>  Manifest directory (default: ./manifest)

  deploy                Deploy a release from Portal to a dedicated Minecraft server
    -t, --target <path> Target Minecraft server directory (default: current directory)
    --portal <url>      Lampas Portal URL (default: https://dev.lampas.town)
    -c, --channel <nam> Release channel pointer (e.g. dev | beta | stable)
    -v, --version <ver> Specific release version to deploy (overrides channel)
    --verify <mode>     Verification mode: fast | full (default: fast)
    --no-backup         Skip automatic world backup before applying mutations

  recover               Recover an interrupted deployment transaction on a Minecraft server
    -t, --target <path> Target Minecraft server directory (default: current directory)

  install               Synchronize a Minecraft instance directory to a manifest
    -m, --manifest <p>  Path to client-manifest.json or server-manifest.json
    -t, --target <path> Target Minecraft instance directory
    --portal <url>      Lampas Portal base URL (optional)
    --verify <mode>     Verification mode: fast | full (default: fast)

  check-updates         Check Modrinth & CurseForge for newer upstream releases
    -p, --pack <path>   Pack directory (default: ./pack)
    --apply             Automatically update TOML descriptors with latest version IDs
    --markdown <path>   Write markdown summary to file (useful for GitHub Actions / PRs)

  diff                  Compare two pack manifests for added/removed/updated mods & size delta
    --from <path>       Base manifest (e.g. previous release client-manifest.json)
    --to <path>         Target manifest (e.g. new release client-manifest.json)
    --markdown <path>   Write markdown diff to file

  import                Bootstrap pack definitions from existing mod folders
    --client <path>     Path to client mods folder
    --server <path>     Path to server mods folder
    -o, --out <path>    Output directory for pack definitions (default: ./pack)

  help                  Show this help message
`);
}

function parseArgs(args: string[]): { command: string; positional: string[]; flags: Record<string, string> } {
  if (args.length === 0) {
    return { command: "help", positional: [], flags: {} };
  }

  const first = args[0];
  if (first === "--version" || first === "-v" || first === "-V" || first === "version") {
    return { command: "version", positional: [], flags: {} };
  }
  if (first === "--help" || first === "-h" || first === "help") {
    return { command: "help", positional: [], flags: {} };
  }

  const command = first;
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  const shortMap: Record<string, string> = {
    v: "version",
    s: "side",
    p: "pack",
    l: "lock",
    m: "manifest",
    o: "out",
    t: "target",
    c: "channel",
    h: "help",
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.substring(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const shortKey = arg.substring(1);
      const key = shortMap[shortKey] || shortKey;
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
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
      case "version": {
        console.log(`lampasctl ${getLampasctlVersion()}`);
        break;
      }

      case "add": {
        const query = positional[0] || flags.query;
        if (!query) {
          console.error("Error: Please specify a mod slug, project ID, Modrinth/CurseForge URL, or .jar file path.");
          console.log("Example: lampasctl add appleskin --side client");
          process.exit(1);
        }

        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        const side = flags.side as "client" | "server" | "both" | undefined;
        if (side && !["client", "server", "both"].includes(side)) {
          throw new Error("--side must be one of: client, server, both");
        }
        const provider = flags.provider as "modrinth" | "curseforge" | undefined;
        if (provider && !["modrinth", "curseforge"].includes(provider)) {
          throw new Error("--provider must be one of: modrinth, curseforge");
        }

        await addMod({
          packDir,
          query,
          side,
          provider,
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

        const passed = await validatePack({
          packDir,
          lockFile,
          checkFabricMeta: flags["skip-meta-check"] !== "true",
        });
        if (!passed) {
          process.exit(1);
        }
        break;
      }

      case "manifest": {
        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        const lockFile = path.resolve(flags.lock || path.join(packDir, "pack.lock.json"));
        const outDir = path.resolve(flags.out || path.join(rootDir, "manifest"));

        await buildManifests({
          packDir,
          lockFile,
          outDir,
          portalBaseUrl: flags.portal || flags["portal-base-url"] || process.env.PORTAL_BASE_URL || "https://portal.lampas.town",
          checkFabricMeta: flags["skip-meta-check"] !== "true",
        });
        break;
      }

      case "publish": {
        const portalUrl = flags.portal || process.env.PACK_PORTAL_URL || "";
        const publishSecret = flags.secret || process.env.PACK_PUBLISH_SECRET || "";
        const manifestDir = path.resolve(flags.manifest || path.join(rootDir, "manifest"));
        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        const channel = flags.channel;

        await publishRelease({
          manifestDir,
          packDir,
          portalUrl,
          publishSecret,
          channel,
        });
        break;
      }

      case "deploy": {
        const targetDir = path.resolve(flags.target || positional[0] || rootDir);
        const portalUrl = flags.portal || process.env.PORTAL_URL || "https://dev.lampas.town";
        const channel = flags.channel;
        const version = flags.version;
        const verificationMode = (flags.verify as "fast" | "full") || "fast";
        if (verificationMode !== "fast" && verificationMode !== "full") {
          throw new Error("--verify must be either 'fast' or 'full'");
        }
        const backupWorld = flags["no-backup"] !== "true" && flags.backup !== "false";

        await deployServer({
          targetDir,
          portalUrl,
          channel,
          version,
          verificationMode,
          backupWorld,
        });
        break;
      }

      case "recover": {
        const targetDir = path.resolve(flags.target || positional[0] || rootDir);
        const recovered = await DeploymentTransaction.recoverIfInterrupted(targetDir);
        if (recovered) {
          console.log(`[Recover] Successfully recovered interrupted transaction in ${targetDir}`);
        } else {
          console.log(`[Recover] No interrupted transaction found in ${targetDir}`);
        }
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

        const verificationMode = flags.verify || "fast";
        if (verificationMode !== "fast" && verificationMode !== "full") {
          throw new Error("--verify must be either 'fast' or 'full'");
        }

        await syncInstance({
          manifestPath: path.resolve(manifestPath),
          targetDir: path.resolve(targetDir),
          portalBaseUrl: flags.portal,
          verificationMode,
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

      case "enrich": {
        const packDir = path.resolve(flags.pack || path.join(rootDir, "pack"));
        const lockFile = path.resolve(flags.lock || path.join(packDir, "pack.lock.json"));
        const outDir = path.resolve(flags.out || path.join(rootDir, "manifest"));

        await enrichPackLock({ packDir, lockFile });
        await buildManifests({ packDir, lockFile, outDir, portalBaseUrl: flags.portal });
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
