import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { deployServer } from "../sync";
import { DeploymentTransaction } from "../transaction";
import { detectHost, formatSize, parseSize, readThpMode, type ThpMode } from "./host";
import { findJavaBinary, isOracleGraalvm } from "./java";
import { buildJvmFlags, MIN_HEAP, planHeap, type GcKind } from "./jvm-flags";

export interface StartOptions {
  targetDir?: string;
  noSync?: boolean;
  allowStale?: boolean;
  memory?: string;
  gc?: "g1" | "zgc";
  dryRun?: boolean;
  portalUrl?: string;
  channel?: string;
  version?: string;
  noBackup?: boolean;
  verify?: "fast" | "full";
  extraJavaArgs?: string[];
  /** Optional override for deployServer (used in testing). */
  deployServerFn?: typeof deployServer;
  /** Controls if process.exit is called on error (default: true). */
  exitOnError?: boolean;
}

/**
 * Loads environment variables from <targetDir>/.minecraft-env if present.
 * Does NOT overwrite existing process.env variables.
 */
export function loadMinecraftEnv(targetDir: string): Record<string, string> {
  const envPath = path.join(targetDir, ".minecraft-env");
  const loaded: Record<string, string> = {};
  if (!fs.existsSync(envPath)) {
    return loaded;
  }

  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf-8");
  } catch {
    return loaded;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.slice(7).trim();
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    if (!key) {
      continue;
    }
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    loaded[key] = val;
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  return loaded;
}

/**
 * Starts a dedicated Minecraft server with adaptive JVM sizing and pack synchronization.
 * Ported from tools/scripts/start.py.
 */
export async function startServer(options: StartOptions = {}): Promise<number> {
  const targetDir = path.resolve(options.targetDir || process.cwd());

  // a. Load .minecraft-env if it exists (existing process.env keys are preserved)
  loadMinecraftEnv(targetDir);

  // b. Synchronize Pack via deployServer
  if (!options.noSync) {
    const portalUrl = options.portalUrl || process.env.PORTAL_URL || "https://dev.lampas.town";
    const channel = options.channel || process.env.RELEASE_CHANNEL || "dev";
    const version = options.version;
    const verificationMode = options.verify ?? "fast";
    const backupWorld = options.noBackup !== true;

    const deployFn = options.deployServerFn ?? deployServer;

    try {
      console.log("[Starter] Checking for server pack updates via lampasctl deploy...");
      await deployFn({
        targetDir,
        portalUrl,
        channel,
        version,
        verificationMode,
        backupWorld,
      });
    } catch (err: any) {
      console.error(`[Starter Error] Pack deployment failed: ${err.message}`);
      if (!options.allowStale) {
        console.error(
          "[Starter Error] Aborting server launch to prevent inconsistent state. (Use --allow-stale or --no-sync to bypass)"
        );
        if (options.exitOnError !== false) process.exit(1);
        return 1;
      } else {
        console.log(
          "[Starter Warning] Deployment failed. Attempting transaction recovery before stale launch (--allow-stale enabled)..."
        );
        try {
          await DeploymentTransaction.recoverIfInterrupted(targetDir);
        } catch (recErr: any) {
          console.error(
            `[Starter Error] Failed to recover deployment transaction: ${recErr.message}. Aborting launch to prevent running corrupted server.`
          );
          if (options.exitOnError !== false) process.exit(1);
          return 1;
        }
        console.log(
          "[Starter Warning] Continuing server launch with recovered installation state (--allow-stale enabled)."
        );
      }
    }
  }

  // c. Interrupted transaction journal check
  const journalPath = path.join(targetDir, ".lampas", ".tx-rollback", "journal.json");
  if (fs.existsSync(journalPath)) {
    console.log(
      "[Starter Warning] Detected interrupted deployment transaction journal. Running recovery before launch..."
    );
    try {
      await DeploymentTransaction.recoverIfInterrupted(targetDir);
      console.log("[Starter] Transaction recovery completed successfully.");
    } catch (err: any) {
      console.error(
        `[Starter Error] Transaction recovery failed: ${err.message}. Aborting server launch.`
      );
      if (options.exitOnError !== false) process.exit(1);
      return 1;
    }
  }

  // d. Runtime check: managed Fabric server runtime jar
  const serverJar = path.join(targetDir, ".lampas", "runtime", "fabric-server-launch.jar");
  if (!fs.existsSync(serverJar)) {
    console.error(
      "[Starter Error] No managed Fabric runtime is installed. Run lampasctl start without --no-sync first."
    );
    if (options.exitOnError !== false) process.exit(1);
    return 1;
  }

  // e. Host detection & JVM sizing
  const host = detectHost();
  const ramText = host.ram ? formatSize(host.ram) : "unknown";
  console.log(`\n[Starter] Host: ${host.cpus} CPUs (${host.cpuSource}), ${ramText} RAM (${host.ramSource})`);

  const gc: GcKind = (options.gc || process.env.LAMPAS_GC || "g1") as GcKind;
  if (gc !== "g1" && gc !== "zgc") {
    console.error(`[Starter Error] Invalid GC '${gc}'. Must be 'g1' or 'zgc'.`);
    if (options.exitOnError !== false) process.exit(1);
    return 1;
  }

  let heap: string;
  let heapSource: string;

  const memoryArg = options.memory || process.env.JAVA_MEMORY;
  if (memoryArg) {
    heap = memoryArg;
    heapSource = "--memory/JAVA_MEMORY";
  } else {
    if (!host.ram) {
      console.error("[Starter Error] Could not detect system RAM. Set --memory or JAVA_MEMORY.");
      if (options.exitOnError !== false) process.exit(1);
      return 1;
    }
    let extraReserve = 0;
    if (process.env.LAMPAS_EXTRA_RESERVE) {
      try {
        extraReserve = parseSize(process.env.LAMPAS_EXTRA_RESERVE);
      } catch (err: any) {
        console.error(`[Starter Error] Invalid LAMPAS_EXTRA_RESERVE: ${err.message}`);
        if (options.exitOnError !== false) process.exit(1);
        return 1;
      }
    }
    const heapBytes = planHeap(host.ram, host.container, extraReserve, gc);
    if (heapBytes < MIN_HEAP) {
      console.error(
        `[Starter Error] Computed heap ${formatSize(heapBytes)} is below the ${formatSize(MIN_HEAP)} minimum for this modpack. Add RAM or set --memory explicitly.`
      );
      if (options.exitOnError !== false) process.exit(1);
      return 1;
    }
    heap = formatSize(heapBytes);
    heapSource = "computed";
  }

  const javaBin = findJavaBinary(process.env, process.platform);
  const oracleGraal = isOracleGraalvm(javaBin);
  const compactHeaders = process.env.LAMPAS_COMPACT_HEADERS !== "0";
  const cpuOverride = Boolean(process.env.LAMPAS_CPUS);
  const thp = process.platform === "linux" ? readThpMode() : ([null, null] as ThpMode);

  const jarName = path.basename(serverJar);
  console.log(`[Starter] Using Java: ${javaBin}${oracleGraal ? " (Oracle GraalVM)" : ""}`);
  console.log(
    `[Starter] Starting Minecraft Fabric Server (${jarName}) with ${heap} heap (${heapSource}), GC ${gc}...`
  );

  // f. JVM Flags & config
  const optimizedJvmFlags = buildJvmFlags({
    heap,
    gc,
    cpus: host.cpus,
    cpuOverride,
    thp,
    oracleGraal,
    compactHeaders,
  });

  const log4jCfg = path.join(targetDir, "log4j2.xml");
  if (fs.existsSync(log4jCfg)) {
    optimizedJvmFlags.push(`-Dlog4j2.configurationFile=${log4jCfg}`);
  }

  const logsDir = path.join(targetDir, "logs");
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    // ignore
  }
  let logsWritable = false;
  try {
    fs.accessSync(logsDir, fs.constants.W_OK);
    logsWritable = true;
  } catch {
    logsWritable = false;
  }
  if (logsWritable) {
    optimizedJvmFlags.push("-Xlog:gc*:file=logs/gc.log:time,uptime:filecount=5,filesize=10m");
  }

  const isWin = process.platform === "win32";
  const isBatch =
    isWin &&
    (javaBin.toLowerCase().endsWith(".bat") || javaBin.toLowerCase().endsWith(".cmd"));
  const baseCmd = isBatch ? ["cmd.exe", "/c", javaBin] : [javaBin];
  const jvmCmd = [
    ...baseCmd,
    ...optimizedJvmFlags,
    ...(options.extraJavaArgs ?? []),
    "-jar",
    serverJar,
    "nogui",
  ];

  // g. Dry Run
  if (options.dryRun) {
    console.log(`[Starter] Dry run: ${jvmCmd.join(" ")}`);
    return 0;
  }

  // h. Process launch & signal forwarding
  const [executable, ...cmdArgs] = jvmCmd;
  const child = spawn(executable, cmdArgs, {
    cwd: targetDir,
    stdio: "inherit",
  });

  const handleSignal = (sig: NodeJS.Signals) => {
    console.log(`\n[Starter] Received signal ${sig}, forwarding to Minecraft server...`);
    if (!child.killed) {
      try {
        child.kill(sig);
      } catch {
        // ignore
      }
    }
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code, signal) => {
      process.removeListener("SIGINT", handleSignal);
      process.removeListener("SIGTERM", handleSignal);
      if (signal) {
        resolve(1);
      } else {
        resolve(code ?? 0);
      }
    });
    child.on("error", (err) => {
      process.removeListener("SIGINT", handleSignal);
      process.removeListener("SIGTERM", handleSignal);
      console.error(`[Starter Error] Failed to launch server process: ${err.message}`);
      resolve(1);
    });
  });

  if (options.exitOnError !== false && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
}
