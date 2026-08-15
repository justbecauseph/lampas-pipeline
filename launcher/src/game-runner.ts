import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { ConfigManager } from "./config";
import { MinecraftBootstrap } from "./minecraft-bootstrap";
import type { GameLogEntry, UserProfile } from "./types";

export class GameRunner {
  private static runningProcess: ChildProcess | null = null;

  static isGameRunning(): boolean {
    return this.runningProcess !== null && !this.runningProcess.killed;
  }

  private static findJavaExecutable(): string {
    const config = ConfigManager.get();
    if (config.javaPath && fs.existsSync(config.javaPath)) {
      return config.javaPath;
    }

    if (process.env.JAVA_HOME) {
      const homeJava = path.join(
        process.env.JAVA_HOME,
        "bin",
        process.platform === "win32" ? "javaw.exe" : "java"
      );
      if (fs.existsSync(homeJava)) return homeJava;
    }

    // Common Java 21 runtime locations on Windows
    if (process.platform === "win32") {
      const commonPaths = [
        "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.6.7-hotspot\\bin\\javaw.exe",
        "C:\\Program Files\\Microsoft\\jdk-21.0.6.7-hotspot\\bin\\javaw.exe",
        "C:\\Program Files\\Java\\jdk-21\\bin\\javaw.exe",
      ];
      for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
      }
    }

    return "java";
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
    const gameDir = config.gameDir;
    const ramGb = config.allocatedRamGb || 4;
    const username = user?.minecraftUsername || user?.name || "LampasPlayer";
    const uuid = user?.minecraftUuid || "00000000-0000-0000-0000-000000000000";
    const token = config.token || "0";

    const log = (level: "INFO" | "WARN" | "ERROR", message: string) => {
      onLog({
        timestamp: new Date().toLocaleTimeString(),
        level,
        message,
      });
    };

    log("INFO", `Preparing Standalone Minecraft + Fabric Environment...`);
    log("INFO", `Game Directory: ${gameDir}`);
    log("INFO", `Player: ${username} (UUID: ${uuid})`);

    // 1. Bootstrap Mojang & Fabric Libraries & Assets
    const { classpath, mainClass, assetIndex } = await MinecraftBootstrap.prepareGameEnvironment(
      gameDir,
      "1.21.1",
      "0.19.3",
      (msg) => log("INFO", msg)
    );

    const javaExe = this.findJavaExecutable();
    log("INFO", `Java Runtime: ${javaExe}`);

    // 2. Build JVM and Game Classpath
    const cpSeparator = process.platform === "win32" ? ";" : ":";
    const classpathString = classpath.join(cpSeparator);

    const jvmArgs = [
      `-Xmx${ramGb}G`,
      `-Xms${Math.min(2, ramGb)}G`,
      "-XX:+UseG1GC",
      "-XX:+ParallelRefProcEnabled",
      "-XX:MaxGCPauseMillis=200",
      "-XX:+UnlockExperimentalVMOptions",
      "-XX:+DisableExplicitGC",
      "-XX:+AlwaysPreTouch",
      `-Djava.library.path=${path.join(gameDir, "natives")}`,
      `-Dminecraft.applet.TargetDirectory=${gameDir}`,
      "-cp",
      classpathString,
      mainClass,
      "--username",
      username,
      "--version",
      "1.21.1",
      "--gameDir",
      gameDir,
      "--assetsDir",
      path.join(gameDir, "assets"),
      "--assetIndex",
      assetIndex,
      "--uuid",
      uuid.replace(/-/g, ""),
      "--accessToken",
      token,
      "--userType",
      "msa",
      "--versionType",
      "release",
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
