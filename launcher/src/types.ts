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

export interface RequiredResourcePack {
  id: string;
  filename: string;
  path: string;
  sha256: string;
  sha1?: string;
}

export interface ReleaseLaunchConfig {
  autoConnect?: boolean;
  server?: string;
  requiredResourcePacks?: RequiredResourcePack[];
}

export interface ReleaseDescriptor {
  schemaVersion: number;
  pack: string;
  version: string;
  minecraft: string;
  loader: {
    type: "fabric";
    version: string;
  };
  minimumLauncherVersion: string;
  protocol: number;
  gitCommit?: string;
  created: string;
  clientManifest: string;
  serverManifest: string;
  totalMods?: number;
  totalFiles?: number;
  launch?: ReleaseLaunchConfig;
}

export interface InstallationState {
  pack: string;
  version: string;
  installedAt: string;
  managedResourcePacks?: string[];
  files: Record<
    string,
    {
      sha256: string;
      size: number;
      policy: string;
      mtimeMs?: number;
      verifiedAt?: string;
    }
  >;
  [key: string]: unknown;
}

