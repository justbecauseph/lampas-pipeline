export type Side = "client" | "server" | "both";

export type FilePolicy = "MANAGED" | "PRESERVE" | "OPTIONAL" | "GENERATED";

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
  launcher?: {
    minimum_version?: string;
    protocol?: number;
  };
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
      filename?: string;
      size?: number;
    };

export interface ModDefinition {
  name: string;
  side: Side;
  provider: ProviderConfig;
  notes?: string;
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
  provider: {
    type: "modrinth" | "curseforge" | "lampas" | "direct";
    projectId?: string | number;
    versionId?: string | number;
    file?: string;
  };
}

export interface PackLock {
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
  files: ManifestFile[];
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
}

export interface InstallationState {
  pack: string;
  version: string;
  installedAt: string;
  files: Record<
    string,
    {
      sha256: string;
      size: number;
      policy: FilePolicy;
    }
  >;
}
