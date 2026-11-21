export type Side = "client" | "server" | "both";

export type FilePolicy = "MANAGED" | "PRESERVE" | "OPTIONAL" | "GENERATED";

export type BlacklistRule =
  | {
      scope: "mod_id";
      id: string;
      reason?: string;
    }
  | {
      scope: "project_id";
      provider: "modrinth";
      id: string;
      reason?: string;
    }
  | {
      scope: "project_id";
      provider: "curseforge";
      id: number;
      reason?: string;
    }
  | {
      scope: "version_id";
      provider: "modrinth";
      id: string;
      reason?: string;
    }
  | {
      scope: "version_id";
      provider: "curseforge";
      id: number;
      reason?: string;
    };

/** Keeps a descriptor at its current pin: check-updates never queries or updates it, even with --force. */
export interface HoldRule {
  mod_id: string;
  reason: string;
}

export interface BlacklistTarget {
  modId: string;
  provider: ProviderConfig["type"];
  projectId?: string | number;
  versionId?: string | number;
}

export type ServerDifficulty = "peaceful" | "easy" | "normal" | "hard";
export type ServerGamemode = "survival" | "creative" | "adventure" | "spectator";

export interface ManagedServerProperties {
  "allow-flight"?: boolean;
  "bug-report-link"?: string;
  "chat-spam-threshold-seconds"?: number;
  "command-spam-threshold-seconds"?: number;
  difficulty?: ServerDifficulty;
  "enable-code-of-conduct"?: boolean;
  "force-gamemode"?: boolean;
  gamemode?: ServerGamemode;
  hardcore?: boolean;
  "hide-online-players"?: boolean;
  "max-tick-time"?: number;
  "pause-when-empty-seconds"?: number;
  "player-idle-timeout"?: number;
  "spawn-protection"?: number;
}

export interface PackConfig {
  pack: {
    name: string;
    version: string;
    minecraft: string;
  };
  loader: {
    type: "fabric";
    version: string;
  };
  portal?: {
    base_url?: string;
  };
  client?: {
    /** Client-relative paths shipped as seed-only PRESERVE files (see clientStaticFilePolicy). */
    preserve?: string[];
  };
  launcher?: {
    minimum_version?: string;
    protocol?: number;
    play?: {
      auto_connect?: boolean;
      server?: string;
    };
    resourcepacks?: {
      required?: string[];
    };
  };
  server?: {
    /** Server list MOTD written to server.properties by lampasctl sync (at most two lines). */
    motd?: string;
    /** Allowlisted server.properties overrides written by lampasctl sync. */
    properties?: ManagedServerProperties;
    resourcepack?: {
      artifact?: string;
      required?: boolean;
      prompt?: string;
      id?: string;
      uuid?: string;
    };
    resource_pack?: {
      artifact?: string;
      required?: boolean;
      prompt?: string;
      id?: string;
      uuid?: string;
    };
  };
  blacklist?: BlacklistRule[];
  hold?: HoldRule[];
}

export interface ReleaseRequiredResourcePack {
  id: string;
  filename: string;
  path: string;
  sha256: string;
  sha1?: string;
}

export interface ReleaseLaunchConfig {
  autoConnect?: boolean;
  server?: string;
  requiredResourcePacks?: ReleaseRequiredResourcePack[];
}

export interface ServerResourcePackConfig {
  artifact: string;
  required: boolean;
  filename: string;
  path: string;
  size: number;
  url: string;
  sha1?: string;
  sha256: string;
  prompt?: string;
  id?: string;
  uuid?: string;
  provider?: "modrinth" | "curseforge" | "lampas" | "direct" | string;
}

export type ProviderConfig =
  | {
      type: "modrinth";
      project_id: string;
      version_id: string;
    }
  | {
      type: "curseforge";
      project_id: number;
      file_id: number;
    }
  | {
      type: "lampas";
      file: string;
    }
  | {
      type: "direct";
      url: string;
      sha256: string;
      sha1?: string;
      filename?: string;
      size?: number;
    };

export type ArtifactType = "mod" | "shader" | "resourcepack";

export interface ModDefinition {
  name: string;
  side: Side;
  provider: ProviderConfig;
  type?: ArtifactType;
  sha1?: string;
  uuid?: string;
  notes?: string;
}

export interface ModMetadata {
  description?: string;
  iconUrl?: string;
  categories?: string[];
  sourceUrl?: string;
  clientSide?: string;
  serverSide?: string;
  author?: string;
}

export interface ResolvedArtifact {
  id: string;
  name: string;
  side: Side;
  filename: string;
  size: number;
  sha256: string;
  sha512?: string;
  sha1?: string;
  downloadUrl: string;
  targetDir?: string;
  artifactType?: ArtifactType;
  provider: {
    type: "modrinth" | "curseforge" | "lampas" | "direct";
    projectId?: string | number;
    versionId?: string | number;
    fileId?: number;
    file?: string;
  };
  metadata?: ModMetadata;
}

export interface PackLock {
  $schema?: string;
  schema: number;
  packName: string;
  packVersion: string;
  minecraft: string;
  loader: {
    type: "fabric";
    version: string;
  };
  updated: string;
  artifacts: Record<string, ResolvedArtifact>;
}

export interface ManifestFile {
  path: string;
  size: number;
  hashes: {
    sha256: string;
    sha512?: string;
  };
  download: {
    url: string;
    provider: "modrinth" | "curseforge" | "lampas" | "direct";
  };
  policy: FilePolicy;
}

export interface ModCatalogEntry {
  id: string;
  name: string;
  side: Side;
  filename: string;
  size: number;
  description?: string;
  iconUrl?: string;
  categories?: string[];
  sourceUrl?: string;
}

export type ConfigPatchMode = "enforce" | "once";

export type MissingFilePolicy = "defer" | "create";

export type ConfigOperation =
  | {
      op: "set";
      path: Array<string | number>;
      value: any;
    }
  | {
      op: "remove";
      path: Array<string | number>;
    }
  | {
      op: "replaceLiteral";
      search: string;
      replacement: string;
      expectedMatches: number;
    };

export interface ConfigPatch {
  id: string;
  revision: number;
  path: string;
  adapter: string;
  mode: ConfigPatchMode;
  missingFile: MissingFilePolicy;
  operations: ConfigOperation[];
}

export interface ConfigPatchesFile {
  schemaVersion: number;
  patches: ConfigPatch[];
}

export interface PackManifest {
  schemaVersion: number;
  pack: string;
  version: string;
  target: "client" | "server";
  minecraft: string;
  loader: {
    type: "fabric";
    version: string;
  };
  protocol: number;
  resourcePack?: ServerResourcePackConfig;
  /** Server manifest only: the server.properties motd. */
  motd?: string;
  /** Server manifest only: allowlisted server.properties overrides. */
  serverProperties?: ManagedServerProperties;
  mods?: ModCatalogEntry[];
  files: ManifestFile[];
  configPatches?: ConfigPatch[];
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
  serverResourcePack?: ServerResourcePackConfig;
}

export interface ServerRuntimeState {
  minecraft: string;
  loader: {
    type: "fabric";
    version: string;
  };
  installerVersion?: string;
  launcherJar: string;
  launcherSha256: string;
  installedAt?: string;
}

export interface InstallationState {
  pack: string;
  version: string;
  installedAt: string;
  runtime?: ServerRuntimeState;
  managedResourcePacks?: string[];
  serverResourcePack?: {
    managed: boolean;
    artifact?: string;
    url?: string;
    sha1?: string;
    sha256?: string;
    id?: string;
    required?: boolean;
  };
  files: Record<
    string,
    {
      sha256: string;
      size: number;
      policy: FilePolicy;
      mtimeMs?: number;
      verifiedAt?: string;
    }
  >;
}
