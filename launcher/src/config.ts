import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { LauncherConfig } from "./types";

const DEFAULT_CONFIG: LauncherConfig = {
  portalUrl: "http://localhost:3000",
  selectedChannel: "stable",
  allocatedRamGb: 4,
  gameDir: "",
  javaArgs: "",
  disabledClientMods: [],
  customClientMods: [],
};

export class ConfigManager {
  private static configPath: string;
  private static cachedConfig: LauncherConfig | null = null;

  private static initPath() {
    if (!this.configPath) {
      const userDataDir = app ? app.getPath("userData") : path.join(process.env.APPDATA || process.cwd(), ".lampas-launcher");
      if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
      }
      this.configPath = path.join(userDataDir, "config.json");
    }
  }

  static get(): LauncherConfig {
    this.initPath();
    if (this.cachedConfig) return this.cachedConfig;

    let loaded: LauncherConfig;

    if (fs.existsSync(this.configPath)) {
      try {
        const data = fs.readFileSync(this.configPath, "utf-8");
        loaded = { ...DEFAULT_CONFIG, ...JSON.parse(data) };
      } catch {
        loaded = { ...DEFAULT_CONFIG };
      }
    } else {
      loaded = { ...DEFAULT_CONFIG };
    }

    if (!loaded.gameDir) {
      const defaultGameDir = path.join(
        process.env.APPDATA || process.env.HOME || process.cwd(),
        ".minecraft-lampas"
      );
      loaded.gameDir = defaultGameDir;
    }

    this.cachedConfig = loaded;
    return loaded;
  }

  static set(newConfig: Partial<LauncherConfig>): LauncherConfig {
    this.initPath();
    const current = this.get();
    const updated = { ...current, ...newConfig };
    for (const key of Object.keys(updated) as Array<keyof LauncherConfig>) {
      if (updated[key] === undefined) {
        delete updated[key];
      }
    }
    this.cachedConfig = updated;
    fs.writeFileSync(this.configPath, JSON.stringify(this.cachedConfig, null, 2), "utf-8");
    return this.cachedConfig;
  }
}
