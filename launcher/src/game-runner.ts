import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { ConfigManager } from "./config";
import { LauncherAuth } from "./auth";
import { MinecraftBootstrap } from "./minecraft-bootstrap";
import { JavaRuntimeManager } from "./java-runtime";
import type { GameLogEntry, UserProfile } from "./types";

function generateOfflineUuid(username: string): string {
  const md5 = createHash("md5").update(`OfflinePlayer:${username}`).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // Version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // Variant RFC 4122
  return md5.toString("hex");
}

export class GameRunner {
  private static runningProcess: ChildProcess | null = null;

  static isGameRunning(): boolean {
    return this.runningProcess !== null && !this.runningProcess.killed;
  }

  static async launchGame(
    user: UserProfile | null,
    onLog: (entry: GameLogEntry) => void,
    onExit: (code: number | null) => void
  ): Promise<boolean> {
    if (this.isGameRunning()) {
      throw new Error("Minecraft is already running!");
    }

    const config = ConfigManager.get();
    if (!user || (!config.token && !config.refreshToken)) {
      throw new Error("Authentication required: Please log in with your Lampas Portal account before playing.");
    }

    const log = (level: "INFO" | "WARN" | "ERROR", message: string) => {
      onLog({
        timestamp: new Date().toLocaleTimeString(),
        level,
        message,
      });
    };

    log("INFO", "Refreshing authentication tokens via Lampas Portal...");
    const refreshed = await LauncherAuth.refreshSession(config.portalUrl);
    if (!refreshed.valid || !refreshed.user) {
      throw new Error("Session expired or invalid: Please log in with your Lampas Portal account.");
    }

    const activeUser = refreshed.user;
    const activeConfig = ConfigManager.get();
    const username = activeUser.minecraftUsername || activeUser.name;
    if (!username) {
      throw new Error("Authentication error: No Minecraft username found in your profile.");
    }

    const gameDir = activeConfig.gameDir;
    const ramGb = activeConfig.allocatedRamGb || 4;
    const rawUuid = activeUser.minecraftUuid && activeUser.minecraftUuid !== "00000000-0000-0000-0000-000000000000"
      ? activeUser.minecraftUuid.replace(/-/g, "")
      : generateOfflineUuid(username);
    const mcToken = activeUser.minecraftAccessToken || activeConfig.minecraftAccessToken;
    const isRealMsa = !!(mcToken && mcToken.startsWith("ey") && mcToken.length > 50);
    const token = isRealMsa ? mcToken : "0";
    const userType = isRealMsa ? "msa" : "legacy";

    log("INFO", `Preparing Standalone Minecraft + Fabric Environment (Java 25)...`);
    log("INFO", `Game Directory: ${gameDir}`);
    log("INFO", `Player: ${username} (UUID: ${rawUuid}, Auth: ${isRealMsa ? "Microsoft Services" : "Lampas Protocol"})`);

    // 1. Ensure OpenJDK 25 Runtime
    const javaExe = await JavaRuntimeManager.ensureJava25(gameDir, (msg) => log("INFO", msg));

    // 2. Bootstrap Mojang & Fabric Libraries & Assets
    const { classpath, mainClass, assetIndex } = await MinecraftBootstrap.prepareGameEnvironment(
      gameDir,
      "26.2",
      "0.19.3",
      (msg) => log("INFO", msg)
    );

    // 2. Build JVM and Game Classpath
    const cpSeparator = process.platform === "win32" ? ";" : ":";
    const classpathString = classpath.join(cpSeparator);

    const customJavaArgs = parseJavaArgs(activeConfig.javaArgs || "");
    const jvmArgs = [
      `-Xmx${ramGb}G`,
      `-Xms${Math.min(2, ramGb)}G`,
      "-XX:+UseG1GC",
      "-XX:+ParallelRefProcEnabled",
      "-XX:MaxGCPauseMillis=200",
      "-XX:+UnlockExperimentalVMOptions",
      "-XX:+DisableExplicitGC",
      "-XX:+AlwaysPreTouch",
      "-Dfabric.disableTelemetry=true",
      `-Djava.library.path=${path.join(gameDir, "natives")}`,
      `-Dminecraft.applet.TargetDirectory=${gameDir}`,
      ...customJavaArgs,
      "-cp",
      classpathString,
      mainClass,
      "--username",
      username,
      "--version",
      "26.2",
      "--gameDir",
      gameDir,
      "--assetsDir",
      path.join(gameDir, "assets"),
      "--assetIndex",
      assetIndex,
      "--uuid",
      rawUuid,
      "--accessToken",
      token,
      "--userType",
      userType,
      "--versionType",
      "release",
      "--userProperties",
      "{}",
    ];

    log("INFO", `Starting Minecraft client via KnotClient (${mainClass})...`);

    try {
      const proc = spawn(javaExe, jvmArgs, {
        cwd: gameDir,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.runningProcess = proc;

      proc.stdout?.on("data", (data) => {
        const text = data.toString().trim();
        if (text) {
          log("INFO", text);
        }
      });

      proc.stderr?.on("data", (data) => {
        const text = data.toString().trim();
        if (text) {
          const level = text.includes("ERROR") || text.includes("Exception") ? "ERROR" : "WARN";
          log(level, text);
        }
      });

      proc.on("exit", (code) => {
        this.runningProcess = null;
        log(code === 0 ? "INFO" : "ERROR", `Minecraft exited with code ${code}`);
        onExit(code);
      });

      return true;
    } catch (err: any) {
      log("ERROR", `Failed to launch Minecraft JVM: ${err.message}`);
      throw err;
    }
  }

  static killGame() {
    if (this.runningProcess) {
      this.runningProcess.kill("SIGTERM");
    }
  }
}

export function parseJavaArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const input = value.trim();
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      const next = input[index + 1];
      if (next === "\\" || next === '"' || next === "'" || /\s/.test(next || "")) escaped = true;
      else current += char;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Custom Java arguments contain an unclosed quote.");
  if (current) args.push(current);
  return args;
}
