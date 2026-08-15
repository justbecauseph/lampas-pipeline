import { contextBridge, ipcRenderer } from "electron";
import type { LauncherConfig, SyncProgress, GameLogEntry, UserProfile } from "./types";

contextBridge.exposeInMainWorld("lampas", {
  auth: {
    login: (portalUrl?: string): Promise<{ token: string; user: UserProfile }> =>
      ipcRenderer.invoke("auth:login", portalUrl),
    logout: (): Promise<void> => ipcRenderer.invoke("auth:logout"),
    verify: (portalUrl?: string): Promise<{ valid: boolean; user?: UserProfile }> =>
      ipcRenderer.invoke("auth:verify", portalUrl),
  },
  msa: {
    login: (): Promise<any> => ipcRenderer.invoke("msa:login"),
    onPrompt: (callback: (prompt: { userCode: string; verificationUri: string }) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on("msa:prompt", handler);
      return () => ipcRenderer.removeListener("msa:prompt", handler);
    },
  },
  sync: {
    start: (): Promise<{ success: boolean; version: string; packName: string }> =>
      ipcRenderer.invoke("sync:start"),
    onProgress: (callback: (progress: SyncProgress) => void) => {
      const handler = (_: any, data: SyncProgress) => callback(data);
      ipcRenderer.on("sync:progress", handler);
      return () => ipcRenderer.removeListener("sync:progress", handler);
    },
  },
  game: {
    launch: (user: UserProfile | null): Promise<boolean> => ipcRenderer.invoke("game:launch", user),
    kill: (): Promise<void> => ipcRenderer.invoke("game:kill"),
    isRunning: (): Promise<boolean> => ipcRenderer.invoke("game:isRunning"),
    onLog: (callback: (entry: GameLogEntry) => void) => {
      const handler = (_: any, data: GameLogEntry) => callback(data);
      ipcRenderer.on("game:log", handler);
      return () => ipcRenderer.removeListener("game:log", handler);
    },
    onExit: (callback: (code: number | null) => void) => {
      const handler = (_: any, code: number | null) => callback(code);
      ipcRenderer.on("game:exit", handler);
      return () => ipcRenderer.removeListener("game:exit", handler);
    },
  },
  config: {
    get: (): Promise<LauncherConfig> => ipcRenderer.invoke("config:get"),
    set: (newConfig: Partial<LauncherConfig>): Promise<LauncherConfig> =>
      ipcRenderer.invoke("config:set", newConfig),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
  },
});
