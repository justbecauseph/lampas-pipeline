import { computeBufferHashes, computeFileHashes, type FileHashes } from "./utils";
import type { ModDefinition, ResolvedArtifact, Side } from "./types";
import * as path from "node:path";
import * as fs from "node:fs";

const MODRINTH_API = "https://api.modrinth.com/v2";
const USER_AGENT = "Lampas-Pipeline/1.0 (contact@lampas.gg)";

export interface ModrinthVersionFile {
  hashes: {
    sha1: string;
    sha512: string;
    sha256?: string;
  };
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  file_type?: string;
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  files: ModrinthVersionFile[];
}

export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  description: string;
}

export class ModrinthClient {
  private static async fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          ...(init?.headers || {}),
        },
      });

      if (res.status === 404) {
        return null;
      }

      if (!res.ok) {
        throw new Error(`Modrinth API error ${res.status}: ${res.statusText} at ${url}`);
      }

      return (await res.json()) as T;
    } catch (err: any) {
      console.warn(`[Modrinth] fetch error for ${url}: ${err.message}`);
      return null;
    }
  }

  static async getVersionByHash(hash: string, algorithm: "sha1" | "sha512" = "sha512"): Promise<ModrinthVersion | null> {
    const url = `${MODRINTH_API}/version_file/${hash}?algorithm=${algorithm}`;
    return this.fetchJson<ModrinthVersion>(url);
  }

  static async getVersionsByHashes(
    hashes: string[],
    algorithm: "sha1" | "sha512" = "sha512"
  ): Promise<Record<string, ModrinthVersion>> {
    if (hashes.length === 0) return {};
    const url = `${MODRINTH_API}/version_files`;
    const res = await this.fetchJson<Record<string, ModrinthVersion>>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashes, algorithm }),
    });
    return res || {};
  }

  static async getVersion(versionId: string): Promise<ModrinthVersion | null> {
    const url = `${MODRINTH_API}/version/${versionId}`;
    return this.fetchJson<ModrinthVersion>(url);
  }

  static async getProject(projectIdOrSlug: string): Promise<ModrinthProject | null> {
    const url = `${MODRINTH_API}/project/${projectIdOrSlug}`;
    return this.fetchJson<ModrinthProject>(url);
  }
}

export class ArtifactResolver {
  static async resolveModDefinition(
    modId: string,
    def: ModDefinition,
    baseDir: string
  ): Promise<ResolvedArtifact> {
    const { provider, side, name } = def;

    if (provider.type === "modrinth") {
      const version = await ModrinthClient.getVersion(provider.version_id);
      if (!version) {
        throw new Error(`Mod '${modId}' (${name}): Modrinth version '${provider.version_id}' not found.`);
      }

      const primaryFile =
        version.files.find((f) => f.primary) || version.files[0];
      if (!primaryFile) {
        throw new Error(`Mod '${modId}' (${name}): No files found in Modrinth version '${provider.version_id}'.`);
      }

      // Compute sha256 if missing from response
      let sha256 = primaryFile.hashes.sha256;
      if (!sha256) {
        // If Modrinth didn't supply sha256, download header or calculate during resolve
        const resp = await fetch(primaryFile.url, { headers: { "User-Agent": USER_AGENT } });
        if (!resp.ok) {
          throw new Error(`Failed to download binary to calculate sha256 for ${modId}`);
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        const hashes = computeBufferHashes(buf);
        sha256 = hashes.sha256;
      }

      return {
        id: modId,
        name: def.name,
        side,
        filename: primaryFile.filename,
        size: primaryFile.size,
        sha256,
        sha512: primaryFile.hashes.sha512,
        sha1: primaryFile.hashes.sha1,
        downloadUrl: primaryFile.url,
        provider: {
          type: "modrinth",
          projectId: provider.project_id,
          versionId: provider.version_id,
        },
      };
    }

    if (provider.type === "lampas") {
      const filePath = path.resolve(baseDir, "pack", provider.file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Mod '${modId}' (${name}): Lampas file '${provider.file}' not found at ${filePath}`);
      }

      const hashes = computeFileHashes(filePath);
      const filename = path.basename(filePath);

      return {
        id: modId,
        name: def.name,
        side,
        filename,
        size: hashes.size,
        sha256: hashes.sha256,
        sha512: hashes.sha512,
        sha1: hashes.sha1,
        downloadUrl: `/api/v1/blobs/${hashes.sha256}`,
        provider: {
          type: "lampas",
          file: provider.file,
        },
      };
    }

    if (provider.type === "direct") {
      return {
        id: modId,
        name: def.name,
        side,
        filename: provider.filename || `${modId}.jar`,
        size: provider.size || 0,
        sha256: provider.sha256,
        downloadUrl: provider.url,
        provider: {
          type: "direct",
        },
      };
    }

    throw new Error(`Mod '${modId}' (${name}): Provider type '${(provider as any).type}' is not yet supported.`);
  }
}
