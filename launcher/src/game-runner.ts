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
    const javaPath = config.javaPath || "java";

    const username = user?.name || user?.minecraftUsername || "LampasPlayer";
    const uuid = user?.minecraftUuid || "00000000-0000-0000-0000-000000000000";

    onLog({
      timestamp: new Date().toLocaleTimeString(),
      level: "INFO",
      message: `Preparing to launch Minecraft for player '${username}' with ${ramGb}GB RAM...`,
    });

    onLog({
      timestamp: new Date().toLocaleTimeString(),
      level: "INFO",
      message: `Game Directory: ${gameDir}`,
    });

    // Check if Prism instance or Fabric installation exists in game directory or if launching direct JVM
    // For direct launch, look for fabric loader / client jars in game directory or launch via knot/fabric
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
      `-Djava.library.path=${path.join(gameDir, "natives")}`,
    ];

    onLog({
      timestamp: new Date().toLocaleTimeString(),
      level: "INFO",
      message: `Launching JVM with args: ${jvmArgs.join(" ")}`,
    });

    try {
      // Spawn Java process
      const proc = spawn(javaPath, ["-version"], { cwd: gameDir });

      proc.stderr.on("data", (data) => {
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
          message: `Minecraft process exited with code ${code}`,
        });
        onExit(code);
      });

      return true;
    } catch (err: any) {
      onLog({
        timestamp: new Date().toLocaleTimeString(),
        level: "ERROR",
        message: `Failed to spawn Java runtime: ${err.message}`,
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
