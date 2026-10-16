import * as path from "node:path";
import * as fs from "node:fs";
import { importExistingMods } from "./importer";
import { resolvePack } from "./resolver";
import { validatePack } from "./validator";
import { buildManifests } from "./manifest";
import { DEFAULT_PORTAL_BASE_URL, resolvePortalBaseUrl } from "./portal";
import { comparePortalRelease, isPortalChannel, printPortalComparison } from "./portal-compare";
import type { PackConfig } from "./types";
import { parseTomlFile } from "./utils";
import { deployServer, syncInstance } from "./sync";
import { DeploymentTransaction } from "./transaction";
import { publishRelease } from "./publisher";
import { checkPackUpdates } from "./checker";
import { diffManifests } from "./diff";
import { addMod, removeMod } from "./manager";
import { enrichPackLock } from "./enricher";
import { startServer } from "./launcher/start";
import { runMonitor } from "./monitor";
import { runScheduledRestart } from "./restart";
import { cleanupPreviousExecutables, selfUpdate } from "./self-update";

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
  self-update           Replace this lampasctl binary with a release from GitHub Releases
    --check             Report whether a newer release exists without installing it
    -v, --version <ver> Install this exact version (allows reinstalling or downgrading)
    --prerelease        Include prereleases when looking for the newest release
    --force             Reinstall the installed version (never downgrades without --version)
                        (GITHUB_TOKEN or GH_TOKEN raises the GitHub API rate limit)
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
    --portal <url>      Portal base URL for blob/release URLs
                        (default: PORTAL_BASE_URL, pack.toml [portal] base_url,
                        then https://portal.lampas.town)
    -c, --channel <ch>  Portal channel to compare against: dev | beta | stable (default: stable)
    --no-portal-diff    Skip comparing generated manifests with the Portal release
    --skip-meta-check   Skip upstream Fabric Meta compatibility verification

  publish               Publish release and upload blobs to Lampas Portal
    --portal <url>      Lampas Portal URL (default: PACK_PORTAL_URL, then
                        pack.toml [portal] base_url)
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

  start                 Synchronize and launch a dedicated Minecraft server
    -t, --target <path> Target Minecraft server directory (default: current directory)
    --no-sync           Skip automatic pack synchronization before launch
    --allow-stale       Allow server launch even if pack synchronization fails
    --memory <size>     JVM heap size, e.g. 4G (default: computed from detected RAM)
    --gc <g1|zgc>       Garbage collector: g1 | zgc (default: g1)
    --dry-run           Print computed Java command and exit without launching
    --portal <url>      Lampas Portal URL for sync (default: https://dev.lampas.town)
    -c, --channel <nam> Release channel pointer (e.g. dev | beta | stable)
    -v, --version <ver> Specific release version to deploy (overrides channel)
    --no-backup         Skip automatic world backup during deployment
    --verify <mode>     Verification mode: fast | full (default: fast)
    -- <extra-jvm-args> Extra JVM arguments appended to the Java command

  monitor               Monitor Minecraft server status and dispatch Discord webhooks
    --host <host>       Server host to ping (default: MC_HOST or 127.0.0.1)
    -p, --port <port>   Server port to ping (default: MC_PORT or 25576)
    --public-address <addr> Public server address advertised in embeds (default: play.lampas.town:25576)
    --webhook <url>     Discord webhook URL (default: DISCORD_WEBHOOK_URL or from .minecraft-env)
    --state-file <path> Path to monitor state JSON file (default: ~/.lampas-monitor-state.json)
    --interval <sec>    Polling interval in seconds (default: 10)
    --threshold <num>   Consecutive failure count before declaring OFFLINE (default: 2)
    --once              Perform a single ping probe and exit (exit code 0 if online, 1 if offline)

  restart               Perform scheduled or immediate Minecraft server restart
    --service <name>    Systemd service name to restart (default: lampas-server.service)
    --countdown <min>   Countdown duration in minutes (default: 5)
    --immediate         Skip countdown warnings and restart immediately
    --rcon-host <host>  Minecraft RCON host (default: RCON_HOST, 127.0.0.1)
    -p, --rcon-port <p> Minecraft RCON port (default: RCON_PORT, server.properties, 25575)
    --rcon-password <p> Minecraft RCON password (default: RCON_PASSWORD or server.properties)
    --dry-run           Perform countdown & RCON notices but skip systemctl restart
    -t, --target <path> Target Minecraft server directory (default: current directory)

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
    --force             Ignore blacklist rules for this invocation only
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

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
  extra: string[];
}

export function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) {
    return { command: "help", positional: [], flags: {}, extra: [] };
  }

  const dashDashIdx = args.indexOf("--");
  const mainArgs = dashDashIdx !== -1 ? args.slice(0, dashDashIdx) : args;
  const extra = dashDashIdx !== -1 ? args.slice(dashDashIdx + 1) : [];

  if (mainArgs.length === 0) {
    return { command: "help", positional: [], flags: {}, extra };
  }

  const first = mainArgs[0];
  if (first === "--version" || first === "-v" || first === "-V" || first === "version") {
    return { command: "version", positional: [], flags: {}, extra };
  }
  if (first === "--help" || first === "-h" || first === "help") {
    return { command: "help", positional: [], flags: {}, extra };
  }

  const command = first;
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  const shortMap: Record<string, string> = {
    v: "version",
    s: "side",
    p: command === "monitor" || command === "restart" ? "port" : "pack",
    l: "lock",
    m: "manifest",
    o: "out",
    t: "target",
    c: "channel",
    h: "help",
  };

  const BOOLEAN_FLAGS = new Set([
    "no-sync",
    "allow-stale",
    "dry-run",
    "no-backup",
    "no-portal-diff",
    "apply",
    "force",
    "skip-meta-check",
    "once",
    "immediate",
    "check",
    "prerelease",
  ]);

  for (let i = 1; i < mainArgs.length; i++) {
    const arg = mainArgs[i];
    if (arg.startsWith("--")) {
      let key = arg.substring(2);
      if (key.includes("=")) {
        const eqIdx = key.indexOf("=");
        flags[key.substring(0, eqIdx)] = key.substring(eqIdx + 1);
      } else if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = "true";
      } else {
        const next = mainArgs[i + 1];
        if (next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = "true";
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const shortKey = arg.substring(1);
      const key = shortMap[shortKey] || shortKey;
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = "true";
      } else {
        const next = mainArgs[i + 1];
        if (next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = "true";
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags, extra };
}

async function main() {
  const { command, positional, flags, extra } = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  if (process.platform === "win32") {
    cleanupPreviousExecutables();
  }

  try {
    switch (command) {
      case "version": {
        console.log(`lampasctl ${getLampasctlVersion()}`);
        break;
      }

      case "self-update": {
        if (flags.help === "true") {
          printUsage();
          break;
        }
        const allowed = new Set(["check", "version", "prerelease", "force"]);
        const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
        if (positional.length > 0 || unknown.length > 0) {
          const extraArgs = [...positional, ...unknown.map((key) => `--${key}`)].join(", ");
          throw new Error(`self-update does not accept ${extraArgs}. Use --version <ver> to pick a version.`);
        }
        if (flags.version !== undefined && (flags.version === "" || flags.version === "true")) {
          throw new Error("--version needs a value, e.g. --version 1.2.0");
        }
        await selfUpdate({
          currentVersion: getLampasctlVersion(),
          version: flags.version,
          checkOnly: flags.check === "true",
          includePrerelease: flags.prerelease === "true",
          force: flags.force === "true",
        });
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
        const portalOverride = flags.portal || flags["portal-base-url"] || process.env.PORTAL_BASE_URL;

        const { clientManifest, serverManifest, release } = await buildManifests({
          packDir,
          lockFile,
          outDir,
          portalBaseUrl: portalOverride,
          defaultPortalBaseUrl: DEFAULT_PORTAL_BASE_URL,
          checkFabricMeta: flags["skip-meta-check"] !== "true",
        });

        if (flags["no-portal-diff"] !== "true") {
          const requestedChannel = flags.channel ?? "stable";
          const channel = requestedChannel.toLowerCase();
          if (!isPortalChannel(channel)) {
            const got = requestedChannel === "true" ? "--channel needs a value" : `got '${requestedChannel}'`;
            console.warn(`[Portal] Comparison skipped: --channel must be dev, beta, or stable (${got}).`);
          } else {
            try {
              const packConfig = parseTomlFile<PackConfig>(path.join(packDir, "pack.toml"));
              const portalUrl =
                resolvePortalBaseUrl(packConfig, portalOverride, DEFAULT_PORTAL_BASE_URL) ?? DEFAULT_PORTAL_BASE_URL;
              const comparison = await comparePortalRelease({
                portalUrl,
                channel,
                client: clientManifest,
                server: serverManifest,
                release,
              });
              printPortalComparison(comparison);
            } catch (err) {
              console.warn(`[Portal] Comparison failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
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

      case "start": {
        const targetDir = path.resolve(flags.target || positional[0] || rootDir);
        const noSync = flags["no-sync"] === "true";
        const allowStale = flags["allow-stale"] === "true";
        const memory = flags.memory;
        const gc = flags.gc as "g1" | "zgc" | undefined;
        if (gc && gc !== "g1" && gc !== "zgc") {
          throw new Error("--gc must be one of: g1, zgc");
        }
        const dryRun = flags["dry-run"] === "true";
        const portalUrl = flags.portal || flags["portal-url"];
        const channel = flags.channel;
        const version = flags.version;
        const noBackup = flags["no-backup"] === "true" || flags.backup === "false";
        const verify = flags.verify as "fast" | "full" | undefined;
        if (verify && verify !== "fast" && verify !== "full") {
          throw new Error("--verify must be either 'fast' or 'full'");
        }
        const extraJavaArgs = extra;

        const exitCode = await startServer({
          targetDir,
          noSync,
          allowStale,
          memory,
          gc,
          dryRun,
          portalUrl,
          channel,
          version,
          noBackup,
          verify,
          extraJavaArgs,
        });
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
        break;
      }

      case "monitor": {
        const host = flags.host;
        const portStr = flags.port || flags.p;
        const port = portStr ? parseInt(portStr, 10) : undefined;
        const publicAddress = flags["public-address"] || flags.publicAddress;
        const webhookUrl = flags.webhook || flags["webhook-url"] || flags.webhookUrl;
        const stateFile = flags["state-file"] || flags.stateFile;
        const intervalSec = flags.interval ? parseInt(flags.interval, 10) : undefined;
        const failureThreshold = flags.threshold ? parseInt(flags.threshold, 10) : undefined;
        const once = flags.once === "true";

        const exitCode = await runMonitor({
          host,
          port,
          publicAddress,
          webhookUrl,
          stateFile,
          intervalSec,
          failureThreshold,
          once,
          targetDir: rootDir,
        });
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
        break;
      }

      case "restart": {
        // parseArgs reads "--rcon-password -secret" as a flag with no value plus a positional, so a
        // dash-led positional is an option value. Refuse it without echoing it, since it may be a password.
        if (positional[0]?.startsWith("-")) {
          console.error(
            'restart: unexpected argument beginning with "-". If it is a value for an option such as --rcon-password, ' +
              "write it as --option=<value>. Pass the server directory with --target."
          );
          process.exit(2);
        }
        const targetDir = flags.target || positional[0] || rootDir;
        const serviceName = flags.service || "lampas-server.service";
        const countdownMinutes = flags.countdown ? parseInt(flags.countdown, 10) : 5;
        const immediate = flags.immediate === "true";
        const rconHost = flags["rcon-host"] || flags.host;
        const portStr = flags["rcon-port"] || flags.port || flags.p;
        const rconPort = portStr ? parseInt(portStr, 10) : undefined;
        const rconPassword = flags["rcon-password"] || flags.password;
        const dryRun = flags["dry-run"] === "true";

        const exitCode = await runScheduledRestart({
          targetDir: path.resolve(targetDir),
          serviceName,
          countdownMinutes,
          immediate,
          rconHost,
          rconPort,
          rconPassword,
          dryRun,
        });
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
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
          force: flags.force === "true",
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
