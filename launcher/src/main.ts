import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "node:path";
import { ConfigManager } from "./config";
import { LauncherAuth } from "./auth";
import { LauncherSync } from "./sync";
import { GameRunner } from "./game-runner";
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
    backgroundColor: "#030712",
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
      await shell.openPath(targetPath);
    }
  });

  // IPC Handlers: Config
  ipcMain.handle("config:get", () => ConfigManager.get());
  ipcMain.handle("config:set", (_, newConfig) => ConfigManager.set(newConfig));

  // IPC Handlers: Auth
  ipcMain.handle("auth:login", (_, portalUrl) => LauncherAuth.loginWithPortal(portalUrl));
  ipcMain.handle("auth:logout", () => LauncherAuth.logout());
  ipcMain.handle("auth:verify", (_, portalUrl) => LauncherAuth.verifySession(portalUrl));
  ipcMain.handle("auth:refresh", (_, portalUrl) => LauncherAuth.refreshSession(portalUrl));

  // IPC Handlers: Sync & Repair
  ipcMain.handle("sync:start", async () => {
    return LauncherSync.syncClient((progress) => {
      mainWindow?.webContents.send("sync:progress", progress);
    });
  });
  ipcMain.handle("sync:repair", async () => {
    return LauncherSync.repairInstallation(
      (progress) => mainWindow?.webContents.send("sync:progress", progress),
      (log) => mainWindow?.webContents.send("game:log", log)
    );
  });
  ipcMain.handle("sync:getModCatalog", () => LauncherSync.getModCatalog());

  // IPC Handlers: Game
  ipcMain.handle("game:launch", async (_, user: UserProfile | null) => {
    return GameRunner.launchGame(
      user,
      (log) => mainWindow?.webContents.send("game:log", log),
      (code) => mainWindow?.webContents.send("game:exit", code)
    );
  });
  ipcMain.handle("game:kill", () => GameRunner.killGame());
  ipcMain.handle("game:isRunning", () => GameRunner.isGameRunning());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
