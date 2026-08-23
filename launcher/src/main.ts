import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as path from "node:path";
import { ConfigManager } from "./config";
import { LauncherAuth } from "./auth";
import { LauncherSync } from "./sync";
import { GameRunner, parseJavaArgs } from "./game-runner";
import { ClientModManager } from "./client-mods";
import { LauncherLogger } from "./logger";
import type { UserProfile } from "./types";

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 680,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#0b0f0e",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "../ui/index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  LauncherLogger.init();
  LauncherLogger.info(`Lampas Launcher initialized (App: ${app.getName()} ${app.getVersion()})`);

  createWindow();

  // IPC Handlers: Window Controls
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle("window:isMaximized", () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle("window:close", () => mainWindow?.close());

  // IPC Handlers: Utils
  ipcMain.handle("utils:openPath", async (_, targetPath: string) => {
    if (targetPath) {
      if (/^https?:\/\//i.test(targetPath)) await shell.openExternal(targetPath);
      else await shell.openPath(targetPath);
    }
  });
  ipcMain.handle("utils:getLogPath", () => LauncherLogger.getLogPath());
  ipcMain.handle("utils:openLogsDir", async () => {
    const logsDir = LauncherLogger.getLogsDir();
    await shell.openPath(logsDir);
    return logsDir;
  });
  ipcMain.handle("utils:openLogFile", async () => {
    const logPath = LauncherLogger.getLogPath();
    await shell.openPath(logPath);
    return logPath;
  });

  // IPC Handlers: Config
  ipcMain.handle("config:get", () => ConfigManager.get());
  ipcMain.handle("config:set", (_, newConfig) => {
    if (typeof newConfig?.javaArgs === "string") parseJavaArgs(newConfig.javaArgs);
    return ConfigManager.set(newConfig);
  });

  // IPC Handlers: Auth
  ipcMain.handle("auth:login", (_, portalUrl) => LauncherAuth.loginWithPortal(portalUrl));
  ipcMain.handle("auth:logout", () => LauncherAuth.logout());
  ipcMain.handle("auth:verify", (_, portalUrl) => LauncherAuth.verifySession(portalUrl));
  ipcMain.handle("auth:refresh", (_, portalUrl) => LauncherAuth.refreshSession(portalUrl));

  // IPC Handlers: Sync & Repair
  ipcMain.handle("sync:start", async () => {
    LauncherLogger.info("Starting modpack synchronization...");
    return LauncherSync.syncClient((progress) => {
      if (progress.message) {
        LauncherLogger.info(`[Sync] ${progress.message}`);
      }
      mainWindow?.webContents.send("sync:progress", progress);
    });
  });
  ipcMain.handle("sync:repair", async () => {
    LauncherLogger.info("Starting full installation repair...");
    return LauncherSync.repairInstallation(
      (progress) => mainWindow?.webContents.send("sync:progress", progress),
      (log) => {
        LauncherLogger.log(log.level, log.message);
        mainWindow?.webContents.send("game:log", log);
      }
    );
  });
  ipcMain.handle("sync:getModCatalog", () => LauncherSync.getModCatalog());

  ipcMain.handle("mods:browseAndAdd", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Add local client mods",
      filters: [{ name: "Minecraft mods", extensions: ["jar"] }],
      properties: ["openFile", "multiSelections"],
    });
    return result.canceled ? ClientModManager.list() : ClientModManager.add(result.filePaths);
  });
  ipcMain.handle("mods:addPaths", (_, paths: string[]) => ClientModManager.add(paths));
  ipcMain.handle("mods:setOfficialEnabled", (_, id: string, enabled: boolean) =>
    ClientModManager.setOfficialEnabled(id, enabled));
  ipcMain.handle("mods:setCustomEnabled", (_, filename: string, enabled: boolean) =>
    ClientModManager.setEnabled(filename, enabled));
  ipcMain.handle("mods:removeCustom", (_, filename: string) => ClientModManager.remove(filename));

  // IPC Handlers: Game
  ipcMain.handle("game:launch", async (_, user: UserProfile | null, releaseOverride?: any) => {
    LauncherLogger.info(`Initiating game launch for player: ${user?.minecraftUsername || user?.name || "Unknown"}`);
    return GameRunner.launchGame(
      user,
      (log) => {
        // Stream live game output to UI console only (Minecraft Log4j logs stay in logs/latest.log)
        mainWindow?.webContents.send("game:log", log);
      },
      (code) => {
        LauncherLogger.info(`Minecraft process exited with code ${code}`);
        mainWindow?.webContents.send("game:exit", code);
      },
      releaseOverride
    );
  });
  ipcMain.handle("game:kill", () => {
    LauncherLogger.warn("Game kill request received from user.");
    GameRunner.killGame();
  });
  ipcMain.handle("game:isRunning", () => GameRunner.isGameRunning());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
