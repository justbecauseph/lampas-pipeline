export interface UserProfile {
  id: string;
  name: string;
  discordId?: string;
  discordTag?: string;
  minecraftUuid?: string;
  minecraftUsername?: string;
  minecraftAccessToken?: string;
  isAdmin: boolean;
  isTech: boolean;
  roles: string[];
  allowedChannels: string[];
}

export interface LauncherConfig {
  portalUrl: string;
  selectedChannel: "stable" | "beta" | "dev";
  allocatedRamGb: number;
  gameDir: string;
  javaPath?: string;
  javaArgs?: string;
  disabledClientMods?: string[];
  customClientMods?: CustomClientMod[];
  token?: string;
  refreshToken?: string;
  minecraftAccessToken?: string;
}

export interface CustomClientMod {
  filename: string;
  enabled: boolean;
  addedAt: string;
  size: number;
}

export interface SyncProgress {
  status: "idle" | "checking" | "downloading" | "verifying" | "staging" | "repairing" | "complete" | "error";
  message: string;
  currentFile?: string;
  filesCompleted: number;
  totalFiles: number;
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
}

export interface GameLogEntry {
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR" | "CHAT";
  message: string;
}
