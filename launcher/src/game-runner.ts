import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { ConfigManager } from "./config";
import type { GameLogEntry, UserProfile } from "./types";

export class GameRunner {
  private static runningProcess: ChildProcess | null = null;

  static isGameRunning(): boolean {
    return this.runningProcess !== null && !this.runningProcess.killed;
  }

  private static findPrismLauncher(): string | null {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "PrismLauncher", "prismlauncher.exe"),
      "C:\\Program Files\\PrismLauncher\\prismlauncher.exe",
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  private static findJavaExecutable(): string {
    const config = ConfigManager.get();
    if (config.javaPath && fs.existsSync(config.javaPath)) {
      return config.javaPath;
    }

    // Common Java 21 / 25 runtimes installed by Prism or Mojang
    const prismJava = path.join(
      process.env.APPDATA || "",
      "PrismLauncher",
      "java",
      "java-runtime-epsilon",
      "bin",
      process.platform === "win32" ? "java.exe" : "java"
    );
    if (fs.existsSync(prismJava)) return prismJava;

    if (process.env.JAVA_HOME) {
      const homeJava = path.join(
        process.env.JAVA_HOME,
        "bin",
        process.platform === "win32" ? "java.exe" : "java"
      );
      if (fs.existsSync(homeJava)) return homeJava;
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
    const username = user?.name || user?.minecraftUsername || "LampasPlayer";

    onLog({
      timestamp: new Date().toLocaleTimeString(),
      level: "INFO",
      message: `Starting Lampas 2 for player '${username}' (${ramGb} GB RAM)...`,
    });

    const prismExe = this.findPrismLauncher();
    const prismInstanceDir = path.join(
      process.env.APPDATA || "",
      "PrismLauncher",
      "instances",
      "26.2-fabric"
    );

    // If PrismLauncher is available and 26.2-fabric instance exists, launch via Prism CLI
    if (prismExe && fs.existsSync(prismInstanceDir)) {
      onLog({
        timestamp: new Date().toLocaleTimeString(),
        level: "INFO",
        message: `Found PrismLauncher: ${prismExe} -> Launching instance '26.2-fabric'...`,
      });

      const args = ["--launch", "26.2-fabric"];
      if (username) {
        args.push("--offline", username);
      }

      const proc = spawn(prismExe, args, { cwd: gameDir, detached: false });
      this.runningProcess = proc;

      proc.stdout?.on("data", (data) => {
        onLog({
          timestamp: new Date().toLocaleTimeString(),
          level: "INFO",
          message: data.toString().trim(),
        });
      });

      proc.stderr?.on("data", (data) => {
        onLog({
          timestamp: new Date().toLocaleTimeString(),
          level: "WARN",
          message: data.toString().trim(),
        });
      });

      proc.on("exit", (code) => {
        this.runningProcess = null;
        onLog({
          timestamp: new Date().toLocaleTimeString(),
          level: code === 0 ? "INFO" : "ERROR",
          message: `PrismLauncher session exited with code ${code}`,
        });
        onExit(code);
      });

      return true;
    }

    // Direct Java fallback
    const javaExe = this.findJavaExecutable();
    onLog({
      timestamp: new Date().toLocaleTimeString(),
      level: "INFO",
      message: `Using Java Runtime: ${javaExe}`,
    });

    const jvmArgs = [
      `-Xmx${ramGb}G`,
      `-Xms${Math.min(2, ramGb)}G`,
      "-XX:+UseG1GC",
      "-XX:+ParallelRefProcEnabled",
      "-XX:MaxGCPauseMillis=200",
      "-XX:+UnlockExperimentalVMOptions",
      "-XX:+DisableExplicitGC",
      "-XX:+AlwaysPreTouch",
      `-Dminecraft.applet.TargetDirectory=${gameDir}`,
    ];

    try {
      const proc = spawn(javaExe, ["-version"], { cwd: gameDir });

      proc.stderr?.on("data", (data) => {
        onLog({
          timestamp: new Date().toLocaleTimeString(),
          level: "INFO",
          message: data.toString().trim(),
        });
      });

      this.runningProcess = proc;

      proc.on("exit", (code) => {
        this.runningProcess = null;
        onLog({
          timestamp: new Date().toLocaleTimeString(),
          level: code === 0 ? "INFO" : "ERROR",
          message: `Game process exited with code ${code}`,
        });
        onExit(code);
      });

      return true;
    } catch (err: any) {
      onLog({
        timestamp: new Date().toLocaleTimeString(),
        level: "ERROR",
        message: `Failed to launch Java process: ${err.message}`,
      });
      throw err;
    }
  }

  static killGame() {
    if (this.runningProcess) {
      this.runningProcess.kill("SIGTERM");
    }
  }
}
